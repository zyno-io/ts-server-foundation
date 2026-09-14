package main

import (
	"fmt"
	"sort"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

const maxCompactMetadataPayloadBytes = 1024 * 1024

type emissionPlans map[string]*fileEmissionPlan

type fileEmissionPlan struct {
	calls                 map[int]callEmissionPlan
	classes               map[int]classEmissionPlan
	aliases               *expressionTemplate
	metadataTypes         []expressionTemplate
	metadataTypeResolver  string
	decodePureJSONAliases bool
	commonJS              bool
}

type callEmissionPlan struct {
	name             string
	metadataArgIndex int
	metadata         expressionTemplate
}

type classEmissionPlan struct {
	name     string
	metadata expressionTemplate
}

type metadataTypeInterner struct {
	names       map[string]string
	expressions []expressionTemplate
	prefix      string
	err         error
}

func newMetadataTypeInterner(sourceText string) *metadataTypeInterner {
	prefix := "__tsf_metadata_type"
	for strings.Contains(sourceText, prefix) {
		prefix = "_" + prefix
	}
	return &metadataTypeInterner{names: map[string]string{}, prefix: prefix}
}

func (interner *metadataTypeInterner) reference(expr string) string {
	template, err := parseExpressionTemplate(expr)
	if err != nil {
		if interner.err == nil {
			interner.err = err
		}
		return expr
	}
	if !isShareableMetadataType(template.parsed) {
		return expr
	}
	if name := interner.names[expr]; name != "" {
		return fmt.Sprintf("%s(%s)", interner.prefix, name)
	}
	name := fmt.Sprintf("%d", len(interner.expressions))
	interner.names[expr] = name
	interner.expressions = append(interner.expressions, template)
	return fmt.Sprintf("%s(%s)", interner.prefix, name)
}

// Shared metadata is emitted at module scope. Only JSON data and primitive
// values that cannot capture a lexical binding are safe to move there. Class
// and validator thunks must remain at their original class or call site.
func isShareableMetadataType(expression *shimast.Node) bool {
	encoding := encodeCompactMetadata(expression)
	for _, reference := range encoding.references {
		if reference == nil {
			return false
		}
		switch reference.Kind {
		case shimast.KindBigIntLiteral:
			continue
		case shimast.KindIdentifier:
			if reference.Text() == "undefined" {
				continue
			}
		}
		return false
	}
	return true
}

func buildEmissionPlans(reg *registry, program *driver.Program, emitTypeAliases bool, emitMetadataRuntimeImport bool) (emissionPlans, error) {
	plans := emissionPlans{}
	for _, info := range reg.files {
		if info == nil || info.file == nil || info.file.IsDeclarationFile {
			continue
		}
		plan := &fileEmissionPlan{
			calls:                 map[int]callEmissionPlan{},
			classes:               map[int]classEmissionPlan{},
			decodePureJSONAliases: emitMetadataRuntimeImport,
		}
		metadataTypes := newMetadataTypeInterner(info.file.Text())
		if program != nil && program.TSProgram != nil {
			plan.commonJS = program.TSProgram.GetEmitModuleFormatOfFile(info.file).String() == "CommonJS"
		}
		for _, call := range info.calls {
			if call.nodePos < 0 {
				return nil, fmt.Errorf("%s:%d: metadata call %s could not be correlated to a CallExpression", info.file.FileName(), call.pos, call.name)
			}
			expr := metadataTypes.reference(cachedTypeExpr(info, reg, call.typeText, call.typeNode, call.pos, call.metadataText))
			template, err := parseExpressionTemplate(expr)
			if err != nil {
				return nil, fmt.Errorf("%s:%d: metadata call %s: %w", info.file.FileName(), call.pos, call.name, err)
			}
			plan.calls[call.nodePos] = callEmissionPlan{
				name:             call.name,
				metadataArgIndex: call.metadataArgIndex,
				metadata:         template,
			}
		}
		classes := append([]*classInfo(nil), info.classes...)
		sort.Slice(classes, func(i, j int) bool { return classes[i].pos < classes[j].pos })
		for _, class := range classes {
			if class.ambient {
				continue
			}
			template, err := parseExpressionTemplate(classMetadata(info, reg, class, metadataTypes.reference))
			if err != nil {
				return nil, fmt.Errorf("%s:%d: class metadata for %s: %w", info.file.FileName(), class.pos, class.name, err)
			}
			plan.classes[class.pos] = classEmissionPlan{name: class.name, metadata: template}
		}
		if metadataTypes.err != nil {
			return nil, fmt.Errorf("%s: shared metadata type: %w", info.file.FileName(), metadataTypes.err)
		}
		plan.metadataTypes = metadataTypes.expressions
		if len(plan.metadataTypes) != 0 {
			plan.metadataTypeResolver = metadataTypes.prefix
		}
		if emitTypeAliases && !hasAliasMetadataSourceDeclaration(info.file) {
			if expr := aliasMetadataExpression(info, reg); expr != "" {
				template, err := parseExpressionTemplate(expr)
				if err != nil {
					return nil, fmt.Errorf("%s: alias metadata: %w", info.file.FileName(), err)
				}
				plan.aliases = &template
			}
		}
		if err := validateCompactMetadataSizes(info, plan); err != nil {
			return nil, err
		}
		if !emitMetadataRuntimeImport {
			if requirement := metadataRuntimeRequirement(plan); requirement != "" {
				return nil, fmt.Errorf(
					"%s: %s requires %s, but emitMetadataRuntimeImport is false",
					info.file.FileName(),
					requirement,
					compactMetadataRuntimeSpec,
				)
			}
		}
		if len(plan.calls) != 0 || len(plan.classes) != 0 || plan.aliases != nil {
			plans[info.file.FileName()] = plan
		}
	}
	return plans, nil
}

func validateCompactMetadataSizes(info *fileInfo, plan *fileEmissionPlan) error {
	if info == nil || info.file == nil || plan == nil {
		return nil
	}
	ec := shimprinter.NewEmitContext()
	imports := newAstImportRegistry(ec, info.file, plan.commonJS)
	runtimeReferences := newCompactMetadataRuntimeInterner(ec, info.file)
	validate := func(surface string, template expressionTemplate, preserveArrayElements bool, inlinePureJSON bool) error {
		metadata := template.materialize(ec, imports)
		encoding := compactMetadataEncodingForSizeGuard(
			metadata,
			imports,
			runtimeReferences,
			plan.metadataTypeResolver,
			preserveArrayElements,
			inlinePureJSON,
		)
		if len(encoding.serialized) > maxCompactMetadataPayloadBytes {
			return fmt.Errorf(
				"%s: compact metadata for %s is %d bytes after graph interning; limit is %d bytes",
				info.file.FileName(),
				surface,
				len(encoding.serialized),
				maxCompactMetadataPayloadBytes,
			)
		}
		return nil
	}

	classPositions := make([]int, 0, len(plan.classes))
	for position := range plan.classes {
		classPositions = append(classPositions, position)
	}
	sort.Ints(classPositions)
	for _, position := range classPositions {
		class := plan.classes[position]
		if err := validate("class "+class.name, class.metadata, false, false); err != nil {
			return err
		}
	}
	callPositions := make([]int, 0, len(plan.calls))
	for position := range plan.calls {
		callPositions = append(callPositions, position)
	}
	sort.Ints(callPositions)
	for _, position := range callPositions {
		call := plan.calls[position]
		if err := validate("call "+call.name, call.metadata, false, false); err != nil {
			return err
		}
	}
	if plan.aliases != nil {
		if err := validate("exported aliases", *plan.aliases, false, !plan.decodePureJSONAliases); err != nil {
			return err
		}
	}
	if len(plan.metadataTypes) != 0 {
		elements := make([]*shimast.Node, 0, len(plan.metadataTypes))
		for _, template := range plan.metadataTypes {
			elements = append(elements, template.materialize(ec, imports))
		}
		metadata := ec.Factory.NewArrayLiteralExpression(ec.Factory.NewNodeList(elements), false)
		encoding := compactMetadataEncodingForSizeGuard(
			metadata,
			imports,
			runtimeReferences,
			plan.metadataTypeResolver,
			true,
			false,
		)
		if len(encoding.serialized) > maxCompactMetadataPayloadBytes {
			return fmt.Errorf(
				"%s: compact metadata for shared type registry is %d bytes after graph interning; limit is %d bytes",
				info.file.FileName(),
				len(encoding.serialized),
				maxCompactMetadataPayloadBytes,
			)
		}
	}
	return nil
}

// metadataRuntimeRequirement reports the first generated construct that cannot
// be emitted without TSF's compact metadata runtime. Alias registries made only
// of JSON stay self-contained; all other current metadata surfaces use runtime
// decoding or a shared runtime registry by design.
func metadataRuntimeRequirement(plan *fileEmissionPlan) string {
	if plan == nil {
		return ""
	}
	if plan.aliases != nil && (plan.decodePureJSONAliases || !compactMetadataIsPureJSON(plan.aliases.parsed)) {
		if names := runtimeAliasMetadataNames(plan.aliases.parsed); len(names) != 0 {
			return "reflected alias metadata for " + strings.Join(names, ", ")
		}
		return "reflected alias metadata"
	}
	if len(plan.classes) != 0 {
		return "reflected class metadata"
	}
	if len(plan.calls) != 0 {
		return "reflected call metadata"
	}
	if len(plan.metadataTypes) != 0 {
		return "the reflected metadata registry"
	}
	return ""
}

func runtimeAliasMetadataNames(metadata *shimast.Node) []string {
	for metadata != nil && metadata.Kind == shimast.KindParenthesizedExpression {
		metadata = metadata.AsParenthesizedExpression().Expression
	}
	if metadata == nil || metadata.Kind != shimast.KindObjectLiteralExpression {
		return nil
	}
	names := []string{}
	for _, property := range metadata.AsObjectLiteralExpression().Properties.Nodes {
		name, ok := compactMetadataPropertyName(property)
		if !ok {
			continue
		}
		assignment := property.AsPropertyAssignment()
		if assignment == nil || compactMetadataIsPureJSON(assignment.Initializer) {
			continue
		}
		names = append(names, name)
	}
	return names
}

func compactMetadataIsPureJSON(metadata *shimast.Node) bool {
	encoding := encodeCompactMetadata(metadata)
	return len(encoding.references) == 0 && !strings.Contains(encoding.serialized, `"$tsf`)
}

func aliasMetadataExpression(info *fileInfo, reg *registry) string {
	names := exportedTypeAliasNames(info, reg, map[string]bool{})
	if len(names) == 0 {
		return ""
	}
	entries := []string{}
	for _, name := range names {
		if alias, ok := info.aliases[name]; ok {
			if len(alias.params) == 0 {
				if expr := cachedAliasTypeExpr(info, reg, alias); expr != "" && !metadataExprTooLarge(expr) {
					entries = append(entries, quote(name)+": "+withTypeName(expr, name))
				}
			}
			continue
		}
		if decl, ok := chooseInterface(info, name, 0); ok {
			if expr := interfaceObjectLiteralExpr(info, reg, name, decl, &typeContext{seen: map[string]bool{}}); !metadataExprTooLarge(expr) {
				entries = append(entries, quote(name)+": "+expr)
			}
			continue
		}
		if ref, ok := reexportedTypeMetadataReference(info, reg, name); ok {
			entries = append(entries, quote(name)+": "+externalImportedTypeExpr(ref, name))
			continue
		}
		if alias, owner, _, ok := resolveExportedAlias(info, reg, name, map[string]bool{}); ok {
			if len(alias.params) == 0 {
				if expr := cachedAliasTypeExpr(owner, reg, alias); expr != "" && !metadataExprTooLarge(expr) {
					entries = append(entries, quote(name)+": "+withTypeName(expr, name))
				}
			}
			continue
		}
		if decl, owner, _, ok := resolveExportedInterfaceDecl(info, reg, name, map[string]bool{}); ok {
			if expr := interfaceObjectLiteralExpr(owner, reg, name, decl, &typeContext{seen: map[string]bool{}}); !metadataExprTooLarge(expr) {
				entries = append(entries, quote(name)+": "+expr)
			}
		}
	}
	if len(entries) == 0 {
		return ""
	}
	return "{" + strings.Join(entries, ", ") + "}"
}

// Re-exporting a type must not copy the owner's complete structural metadata
// into every barrel. Point at the immediate owning module when this compilation
// emits that module's alias table; it may itself contain another recipe when the
// export crosses more than one barrel. Declaration-only dependencies do not
// necessarily publish runtime alias metadata, so keep their structural metadata
// at the first emitted boundary instead of producing an unresolvable recipe.
func reexportedTypeMetadataReference(info *fileInfo, reg *registry, name string) (importRef, bool) {
	if info == nil || reg == nil {
		return importRef{}, false
	}
	if ref, ok := info.reexports[name]; ok {
		if target := reg.byPath[ref.source]; canPublishTypeMetadata(target) && exportedTypeMetadataExists(target, reg, ref.exportName) {
			ref.spec = emittedMetadataOwnerSpecifier(info, target, ref.spec)
			return ref, ref.spec != "" && ref.exportName != ""
		}
	}
	for _, ref := range info.exportStar {
		target := reg.byPath[ref.source]
		if !canPublishTypeMetadata(target) || !exportedTypeMetadataExists(target, reg, name) {
			continue
		}
		ref.exportName = name
		ref.spec = emittedMetadataOwnerSpecifier(info, target, ref.spec)
		return ref, ref.spec != ""
	}
	return importRef{}, false
}

func canPublishTypeMetadata(info *fileInfo) bool {
	return info != nil && info.file != nil && !info.file.IsDeclarationFile
}

func emittedMetadataOwnerSpecifier(info *fileInfo, target *fileInfo, spec string) string {
	if info == nil || info.file == nil || target == nil || target.file == nil || !strings.HasPrefix(spec, ".") {
		return spec
	}
	// Use an explicit runtime file rather than syntactically appending `.js` to
	// the source specifier. The latter turns `./directory` into a nonexistent
	// `./directory.js` instead of the emitted `./directory/index.js`.
	return moduleSpecifierForOutput(info.file.FileName(), target.file.FileName(), true)
}

func exportedTypeMetadataExists(info *fileInfo, reg *registry, name string) bool {
	if _, _, _, ok := resolveExportedAlias(info, reg, name, map[string]bool{}); ok {
		return true
	}
	_, _, _, ok := resolveExportedInterfaceDecl(info, reg, name, map[string]bool{})
	return ok
}

func cachedAliasTypeExpr(info *fileInfo, reg *registry, alias aliasInfo) string {
	if alias.metadataTooLarge {
		return ""
	}
	if strings.TrimSpace(alias.metadataText) != "" {
		return alias.metadataText
	}
	return internalTypeExprForNode(info, reg, alias.body, alias.typeNode, alias.pos)
}

func metadataExprTooLarge(expr string) bool {
	return len(expr) > 1000000
}

func hasAliasMetadataSourceDeclaration(file *shimast.SourceFile) bool {
	if file == nil || file.Statements == nil {
		return false
	}
	for _, statement := range file.Statements.Nodes {
		if statement == nil || statement.Kind != shimast.KindVariableStatement {
			continue
		}
		if statement.ModifierFlags()&shimast.ModifierFlagsAmbient != 0 {
			continue
		}
		list := statement.AsVariableStatement().DeclarationList
		if list == nil {
			continue
		}
		for _, declaration := range list.AsVariableDeclarationList().Declarations.Nodes {
			if declaration != nil && declaration.Name() != nil && declaration.Name().Kind == shimast.KindIdentifier && declaration.Name().Text() == "__tsfTypeAliases" {
				return true
			}
		}
	}
	return false
}

func exportedTypeAliasNames(info *fileInfo, reg *registry, seen map[string]bool) []string {
	if seen[info.moduleKey] {
		return nil
	}
	seen[info.moduleKey] = true
	names := map[string]bool{}
	for name, alias := range info.aliases {
		if alias.exported && len(alias.params) == 0 {
			names[name] = true
		}
	}
	for name, declarations := range info.interfaces {
		for _, declaration := range declarations {
			if declaration.exported {
				names[name] = true
				break
			}
		}
	}
	for name := range info.reexports {
		if alias, _, _, ok := resolveExportedAlias(info, reg, name, map[string]bool{}); ok && len(alias.params) == 0 {
			names[name] = true
			continue
		}
		if _, _, _, ok := resolveExportedInterfaceDecl(info, reg, name, map[string]bool{}); ok {
			names[name] = true
		}
	}
	for _, ref := range info.exportStar {
		target := reg.byPath[ref.source]
		if target == nil {
			continue
		}
		for _, name := range exportedTypeAliasNames(target, reg, seen) {
			names[name] = true
		}
	}
	out := make([]string, 0, len(names))
	for name := range names {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
