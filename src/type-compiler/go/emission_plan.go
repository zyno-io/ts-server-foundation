package main

import (
	"fmt"
	"sort"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

type emissionPlans map[string]*fileEmissionPlan

type fileEmissionPlan struct {
	calls                map[int]callEmissionPlan
	classes              map[int]classEmissionPlan
	aliases              *expressionTemplate
	metadataTypes        []expressionTemplate
	metadataTypeResolver string
	commonJS             bool
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
	if name := interner.names[expr]; name != "" {
		return fmt.Sprintf("%s(%s)", interner.prefix, name)
	}
	name := fmt.Sprintf("%d", len(interner.expressions))
	template, err := parseExpressionTemplate(expr)
	if err != nil {
		if interner.err == nil {
			interner.err = err
		}
		return expr
	}
	interner.names[expr] = name
	interner.expressions = append(interner.expressions, template)
	return fmt.Sprintf("%s(%s)", interner.prefix, name)
}

func buildEmissionPlans(reg *registry, program *driver.Program, emitTypeAliases bool) (emissionPlans, error) {
	plans := emissionPlans{}
	for _, info := range reg.files {
		if info == nil || info.file == nil || info.file.IsDeclarationFile {
			continue
		}
		plan := &fileEmissionPlan{
			calls:   map[int]callEmissionPlan{},
			classes: map[int]classEmissionPlan{},
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
		if len(plan.calls) != 0 || len(plan.classes) != 0 || plan.aliases != nil {
			plans[info.file.FileName()] = plan
		}
	}
	return plans, nil
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

func cachedAliasTypeExpr(info *fileInfo, reg *registry, alias aliasInfo) string {
	if alias.metadataTooLarge {
		return ""
	}
	if strings.TrimSpace(alias.metadataText) != "" {
		return alias.metadataText
	}
	return internalTypeExprAt(info, reg, alias.body, alias.pos)
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
