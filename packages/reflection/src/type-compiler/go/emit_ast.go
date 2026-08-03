package main

import (
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

type astImportAsset struct {
	moduleSpecifier *shimast.Node
}

type astOptionalModuleLoader struct {
	name       string
	expression *shimast.Node
}

type astImportRegistry struct {
	ec           *shimprinter.EmitContext
	sourceFile   *shimast.SourceFile
	commonJS     bool
	assets       map[string]*astImportAsset
	order        []string
	loaders      map[string]*astOptionalModuleLoader
	loaderOrder  []string
	loaderPrefix string
}

func newAstImportRegistry(ec *shimprinter.EmitContext, sourceFile *shimast.SourceFile, commonJS bool) *astImportRegistry {
	loaderPrefix := "__tsf_metadata_module_"
	if sourceFile != nil {
		for strings.Contains(sourceFile.Text(), loaderPrefix) {
			loaderPrefix = "_" + loaderPrefix
		}
	}
	return &astImportRegistry{
		ec:           ec,
		sourceFile:   sourceFile,
		commonJS:     commonJS,
		assets:       map[string]*astImportAsset{},
		loaders:      map[string]*astOptionalModuleLoader{},
		loaderPrefix: loaderPrefix,
	}
}

func (registry *astImportRegistry) resolvedSpecifier(spec string, targetFile string) string {
	if targetFile != "" && registry.sourceFile != nil {
		return moduleSpecifierForOutput(registry.sourceFile.FileName(), targetFile, !registry.commonJS)
	}
	if strings.HasPrefix(spec, ".") {
		ext := strings.ToLower(filepath.Ext(spec))
		switch ext {
		case ".js", ".mjs", ".cjs", ".json", ".node":
			return spec
		case ".ts", ".tsx", ".mts", ".cts":
			return strings.TrimSuffix(spec, filepath.Ext(spec)) + outputImportExtension(spec, true)
		case "":
			return spec + ".js"
		}
	}
	return spec
}

func (registry *astImportRegistry) asset(spec string, targetFile string) *astImportAsset {
	resolved := registry.resolvedSpecifier(spec, targetFile)
	if asset := registry.assets[resolved]; asset != nil {
		return asset
	}
	asset := &astImportAsset{
		moduleSpecifier: registry.ec.Factory.NewStringLiteral(resolved, shimast.TokenFlagsNone),
	}
	registry.assets[resolved] = asset
	registry.order = append(registry.order, resolved)
	return asset
}

func (registry *astImportRegistry) namespace(spec string, targetFile string) *shimast.Node {
	if registry.commonJS {
		return registry.safeRequire(registry.resolvedSpecifier(spec, targetFile))
	}
	asset := registry.asset(spec, targetFile)
	return registry.ec.Factory.NewGeneratedNameForNode(asset.moduleSpecifier)
}

func (registry *astImportRegistry) member(spec string, exportName string, targetFile string) *shimast.Node {
	if registry.commonJS {
		return registry.lazyRequireMember(registry.resolvedSpecifier(spec, targetFile), exportName)
	}
	return registry.ec.Factory.NewPropertyAccessExpression(
		registry.namespace(spec, targetFile),
		nil,
		registry.ec.Factory.NewIdentifier(exportName),
		shimast.NodeFlagsNone,
	)
}

// staticMember returns a normal namespace-import reference for a required
// runtime dependency. Unlike reflected application imports, the compact
// metadata decoder is always present and should be loaded once per file in both
// CommonJS and ESM output instead of expanded as a defensive lazy require at
// every metadata expression.
func (registry *astImportRegistry) staticMember(spec string, exportName string) *shimast.Node {
	asset := registry.asset(spec, "")
	return registry.ec.Factory.NewPropertyAccessExpression(
		registry.ec.Factory.NewGeneratedNameForNode(asset.moduleSpecifier),
		nil,
		registry.ec.Factory.NewIdentifier(exportName),
		shimast.NodeFlagsNone,
	)
}

func (registry *astImportRegistry) optionalModuleLoader(spec string, targetFile string) *shimast.Node {
	resolved := registry.resolvedSpecifier(spec, targetFile)
	if loader := registry.loaders[resolved]; loader != nil {
		return registry.ec.Factory.NewIdentifier(loader.name)
	}
	name := registry.loaderPrefix + strconv.Itoa(len(registry.loaderOrder))
	var expression *shimast.Node
	if registry.commonJS {
		expression = registry.safeRequire(resolved)
	} else {
		expression = registry.namespace(spec, targetFile)
	}
	registry.loaders[resolved] = &astOptionalModuleLoader{name: name, expression: expression}
	registry.loaderOrder = append(registry.loaderOrder, resolved)
	return registry.ec.Factory.NewIdentifier(name)
}

func (registry *astImportRegistry) isOptionalModuleLoader(node *shimast.Node) bool {
	if node == nil || node.Kind != shimast.KindIdentifier {
		return false
	}
	for _, loader := range registry.loaders {
		if loader.name == node.Text() {
			return true
		}
	}
	return false
}

func (registry *astImportRegistry) requireCall(spec string) *shimast.Node {
	return registry.ec.Factory.NewCallExpression(
		registry.ec.Factory.NewIdentifier("require"),
		nil,
		nil,
		registry.ec.Factory.NewNodeList([]*shimast.Node{registry.ec.Factory.NewStringLiteral(spec, shimast.TokenFlagsNone)}),
		shimast.NodeFlagsNone,
	)
}

func (registry *astImportRegistry) requireAvailable() *shimast.Node {
	return registry.ec.Factory.NewBinaryExpression(
		nil,
		registry.ec.Factory.NewTypeOfExpression(registry.ec.Factory.NewIdentifier("require")),
		nil,
		registry.ec.Factory.NewToken(shimast.KindExclamationEqualsEqualsToken),
		registry.ec.Factory.NewStringLiteral("undefined", shimast.TokenFlagsNone),
	)
}

func (registry *astImportRegistry) lazyRequireMember(spec string, exportName string) *shimast.Node {
	member := registry.ec.Factory.NewPropertyAccessExpression(
		registry.requireCall(spec),
		nil,
		registry.ec.Factory.NewIdentifier(exportName),
		shimast.NodeFlagsNone,
	)
	return registry.ec.Factory.NewParenthesizedExpression(registry.ec.Factory.NewConditionalExpression(
		registry.requireAvailable(),
		registry.ec.Factory.NewToken(shimast.KindQuestionToken),
		member,
		registry.ec.Factory.NewToken(shimast.KindColonToken),
		registry.ec.Factory.NewIdentifier("undefined"),
	))
}

func (registry *astImportRegistry) safeRequire(spec string) *shimast.Node {
	value := registry.ec.Factory.NewConditionalExpression(
		registry.requireAvailable(),
		registry.ec.Factory.NewToken(shimast.KindQuestionToken),
		registry.requireCall(spec),
		registry.ec.Factory.NewToken(shimast.KindColonToken),
		registry.ec.Factory.NewIdentifier("undefined"),
	)
	tryBlock := registry.ec.Factory.NewBlock(
		registry.ec.Factory.NewNodeList([]*shimast.Node{registry.ec.Factory.NewReturnStatement(value)}),
		true,
	)
	catchBlock := registry.ec.Factory.NewBlock(
		registry.ec.Factory.NewNodeList([]*shimast.Node{registry.ec.Factory.NewReturnStatement(registry.ec.Factory.NewIdentifier("undefined"))}),
		true,
	)
	body := registry.ec.Factory.NewBlock(
		registry.ec.Factory.NewNodeList([]*shimast.Node{registry.ec.Factory.NewTryStatement(
			tryBlock,
			registry.ec.Factory.NewCatchClause(nil, catchBlock),
			nil,
		)}),
		true,
	)
	arrow := registry.ec.Factory.NewArrowFunction(
		nil,
		nil,
		registry.ec.Factory.NewNodeList(nil),
		nil,
		nil,
		registry.ec.Factory.NewToken(shimast.KindEqualsGreaterThanToken),
		body,
	)
	return registry.ec.Factory.NewCallExpression(
		registry.ec.Factory.NewParenthesizedExpression(arrow),
		nil,
		nil,
		registry.ec.Factory.NewNodeList(nil),
		shimast.NodeFlagsNone,
	)
}

func (registry *astImportRegistry) statements() []*shimast.Node {
	statements := make([]*shimast.Node, 0, len(registry.order)+len(registry.loaderOrder))
	for _, spec := range registry.order {
		asset := registry.assets[spec]
		statements = append(statements, registry.ec.Factory.NewImportDeclaration(
			nil,
			registry.ec.Factory.NewImportClause(
				0,
				nil,
				registry.ec.Factory.NewNamespaceImport(registry.ec.Factory.NewGeneratedNameForNode(asset.moduleSpecifier)),
			),
			asset.moduleSpecifier,
			nil,
		))
	}
	for _, spec := range registry.loaderOrder {
		loader := registry.loaders[spec]
		statements = append(statements, expressionFactoryDeclaration(registry.ec, loader.name, loader.expression))
	}
	return statements
}

func metadataTransform(plans emissionPlans) driver.PluginTransform {
	return func(ec *shimprinter.EmitContext, sourceFile *shimast.SourceFile) *shimast.SourceFile {
		if sourceFile == nil || sourceFile.IsDeclarationFile {
			return sourceFile
		}
		plan := plans[sourceFile.FileName()]
		if plan == nil {
			return sourceFile
		}
		imports := newAstImportRegistry(ec, sourceFile, plan.commonJS)
		runtimeReferences := newCompactMetadataRuntimeInterner(ec, sourceFile)
		var metadataTypes *shimast.Node
		if len(plan.metadataTypes) != 0 {
			expression := materializeCompactMetadataRegistry(
				ec,
				imports,
				runtimeReferences,
				plan.metadataTypes,
				plan.metadataTypeResolver,
			)
			metadataTypes = metadataTypeDeclaration(ec, plan.metadataTypeResolver, expression)
		}
		var visitor *shimast.NodeVisitor
		visitor = ec.NewNodeVisitor(func(node *shimast.Node) *shimast.Node {
			if node == nil {
				return nil
			}
			original := ec.MostOriginal(node)
			originalPos := node.Pos()
			if original != nil {
				originalPos = original.Pos()
			}
			if node.Kind == shimast.KindCallExpression {
				visited := visitor.VisitEachChild(node)
				callPlan, ok := plan.calls[originalPos]
				if !ok || visited == nil || visited.Kind != shimast.KindCallExpression {
					return visited
				}
				return updateMetadataCall(ec, visited.AsCallExpression(), callPlan, imports, runtimeReferences, plan.metadataTypeResolver)
			}
			if node.Kind == shimast.KindClassDeclaration {
				visited := visitor.VisitEachChild(node)
				classPlan, ok := plan.classes[originalPos]
				if !ok || visited == nil || visited.Kind != shimast.KindClassDeclaration {
					return visited
				}
				metadata := materializeCompactMetadataExpression(
					ec,
					imports,
					runtimeReferences,
					classPlan.metadata,
					plan.metadataTypeResolver,
				)
				metadataReference := ec.Factory.NewUniqueName("_" + classPlan.name + "Metadata")
				declaration := classMetadataDeclaration(ec, metadataReference, original)
				withMetadata := classWithStaticMetadata(ec, visited.AsClassDeclaration(), metadataReference, metadata)
				classTypeAssignment := classMetadataClassTypeAssignment(ec, withMetadata, original, classPlan.name, metadataReference)
				assignment := classMetadataAssignment(ec, withMetadata, original, classPlan.name, metadataReference)
				return ec.Factory.NewSyntaxList([]*shimast.Node{declaration, withMetadata, classTypeAssignment, assignment})
			}
			return visitor.VisitEachChild(node)
		})
		output := visitor.VisitNode(sourceFile.AsNode())
		if output == nil {
			return sourceFile
		}
		result := output.AsSourceFile()
		if plan.aliases != nil {
			result = appendAliasMetadata(ec, result, materializeCompactAliasMetadataExpression(
				ec,
				imports,
				runtimeReferences,
				*plan.aliases,
				plan.metadataTypeResolver,
			))
		}
		declarations := []*shimast.Node{}
		if metadataTypes != nil {
			declarations = append(declarations, metadataTypes)
		}
		if len(declarations) != 0 {
			result = injectMetadataTypeDeclarations(ec, result, declarations)
		}
		if statements := imports.statements(); len(statements) != 0 {
			result = injectAstImports(ec, result, statements)
		}
		return result
	}
}

func metadataTypeDeclaration(ec *shimprinter.EmitContext, name string, metadata *shimast.Node) *shimast.Node {
	return ec.Factory.NewVariableStatement(
		nil,
		ec.Factory.NewVariableDeclarationList(
			ec.Factory.NewNodeList([]*shimast.Node{ec.Factory.NewVariableDeclaration(
				ec.Factory.NewIdentifier(name),
				nil,
				nil,
				metadata,
			)}),
			shimast.NodeFlagsConst,
		),
	)
}

func injectMetadataTypeDeclarations(ec *shimprinter.EmitContext, sourceFile *shimast.SourceFile, declarations []*shimast.Node) *shimast.SourceFile {
	index := 0
	for index < len(sourceFile.Statements.Nodes) {
		statement := sourceFile.Statements.Nodes[index]
		if statement == nil {
			break
		}
		if statement.Kind == shimast.KindImportDeclaration || statement.Kind == shimast.KindImportEqualsDeclaration {
			index++
			continue
		}
		if statement.Kind == shimast.KindExpressionStatement {
			expression := statement.AsExpressionStatement().Expression
			if expression != nil && expression.Kind == shimast.KindStringLiteral {
				index++
				continue
			}
		}
		break
	}
	statements := make([]*shimast.Node, 0, len(sourceFile.Statements.Nodes)+len(declarations))
	statements = append(statements, sourceFile.Statements.Nodes[:index]...)
	statements = append(statements, declarations...)
	statements = append(statements, sourceFile.Statements.Nodes[index:]...)
	return ec.Factory.UpdateSourceFile(sourceFile, ec.Factory.NewNodeList(statements), sourceFile.EndOfFileToken).AsSourceFile()
}

// classWithStaticMetadata initializes reflection metadata as part of the class
// itself. TypeScript's decorator transform therefore evaluates it before class
// decorators run, preserving the ordering of the previous inline-class emit.
// The companion post-class assignment reuses the same metadata object so a
// decorator that mutates metadata or replaces the constructor preserves it.
func classWithStaticMetadata(ec *shimprinter.EmitContext, class *shimast.ClassDeclaration, metadataReference *shimast.Node, metadata *shimast.Node) *shimast.Node {
	members := append([]*shimast.Node{}, class.Members.Nodes...)
	initializer := ec.Factory.NewBinaryExpression(
		nil,
		metadataReference,
		nil,
		ec.Factory.NewToken(shimast.KindEqualsToken),
		metadata,
	)
	members = append(members, ec.Factory.NewPropertyDeclaration(
		ec.Factory.NewModifierList([]*shimast.Node{ec.Factory.NewModifier(shimast.KindStaticKeyword)}),
		ec.Factory.NewIdentifier("__tsfType"),
		nil,
		nil,
		initializer,
	))
	return ec.Factory.UpdateClassDeclaration(
		class,
		class.Modifiers(),
		class.Name(),
		class.TypeParameters,
		class.HeritageClauses,
		ec.Factory.NewNodeList(members),
	)
}

func classMetadataDeclaration(ec *shimprinter.EmitContext, name *shimast.Node, original *shimast.Node) *shimast.Node {
	declaration := ec.Factory.NewVariableDeclaration(name, nil, nil, nil)
	statement := ec.Factory.NewVariableStatement(
		nil,
		ec.Factory.NewVariableDeclarationList(
			ec.Factory.NewNodeList([]*shimast.Node{declaration}),
			shimast.NodeFlagsLet,
		),
	)
	if original != nil {
		ec.SetOriginal(statement, original)
	}
	return statement
}

func updateMetadataCall(
	ec *shimprinter.EmitContext,
	call *shimast.CallExpression,
	plan callEmissionPlan,
	imports *astImportRegistry,
	runtimeReferences *compactMetadataRuntimeInterner,
	metadataTypeResolver string,
) *shimast.Node {
	arguments := []*shimast.Node{}
	if call.Arguments != nil {
		arguments = append(arguments, call.Arguments.Nodes...)
	}
	if len(arguments) > plan.metadataArgIndex {
		return call.AsNode()
	}
	for len(arguments) < plan.metadataArgIndex {
		arguments = append(arguments, ec.Factory.NewIdentifier("undefined"))
	}
	arguments = append(arguments, materializeCompactMetadataExpression(
		ec,
		imports,
		runtimeReferences,
		plan.metadata,
		metadataTypeResolver,
	))
	return ec.Factory.UpdateCallExpression(
		call,
		call.Expression,
		call.QuestionDotToken,
		call.TypeArguments,
		ec.Factory.NewNodeList(arguments),
		call.Flags,
	)
}

func classMetadataAssignment(ec *shimprinter.EmitContext, visited *shimast.Node, original *shimast.Node, className string, metadataReference *shimast.Node) *shimast.Node {
	left := ec.Factory.NewPropertyAccessExpression(
		classNameReference(ec, visited, original, className),
		nil,
		ec.Factory.NewIdentifier("__tsfType"),
		shimast.NodeFlagsNone,
	)
	assignment := ec.Factory.NewBinaryExpression(
		nil,
		left,
		nil,
		ec.Factory.NewToken(shimast.KindEqualsToken),
		metadataReference,
	)
	statement := ec.Factory.NewExpressionStatement(assignment)
	if original != nil {
		ec.SetOriginal(statement, original)
	}
	return statement
}

func classMetadataClassTypeAssignment(ec *shimprinter.EmitContext, visited *shimast.Node, original *shimast.Node, className string, metadataReference *shimast.Node) *shimast.Node {
	left := ec.Factory.NewPropertyAccessExpression(
		metadataReference,
		nil,
		ec.Factory.NewIdentifier("classType"),
		shimast.NodeFlagsNone,
	)
	assignment := ec.Factory.NewBinaryExpression(
		nil,
		left,
		nil,
		ec.Factory.NewToken(shimast.KindEqualsToken),
		classNameReference(ec, visited, original, className),
	)
	statement := ec.Factory.NewExpressionStatement(assignment)
	if original != nil {
		ec.SetOriginal(statement, original)
	}
	return statement
}

func classNameReference(ec *shimprinter.EmitContext, visited *shimast.Node, original *shimast.Node, className string) *shimast.Node {
	name := ec.Factory.NewIdentifier(className)
	if original != nil && original.Name() != nil {
		ec.SetOriginal(name, original.Name())
	} else if visited.Name() != nil {
		ec.SetOriginal(name, visited.Name())
	}
	return name
}

func appendAliasMetadata(ec *shimprinter.EmitContext, sourceFile *shimast.SourceFile, metadata *shimast.Node) *shimast.SourceFile {
	declaration := ec.Factory.NewVariableDeclaration(
		ec.Factory.NewIdentifier("__tsfTypeAliases"),
		nil,
		nil,
		metadata,
	)
	statement := ec.Factory.NewVariableStatement(
		ec.Factory.NewModifierList([]*shimast.Node{ec.Factory.NewModifier(shimast.KindExportKeyword)}),
		ec.Factory.NewVariableDeclarationList(
			ec.Factory.NewNodeList([]*shimast.Node{declaration}),
			shimast.NodeFlagsConst,
		),
	)
	statements := append([]*shimast.Node{}, sourceFile.Statements.Nodes...)
	statements = append(statements, statement)
	return ec.Factory.UpdateSourceFile(sourceFile, ec.Factory.NewNodeList(statements), sourceFile.EndOfFileToken).AsSourceFile()
}

func injectAstImports(ec *shimprinter.EmitContext, sourceFile *shimast.SourceFile, imports []*shimast.Node) *shimast.SourceFile {
	index := 0
	for index < len(sourceFile.Statements.Nodes) {
		statement := sourceFile.Statements.Nodes[index]
		if statement == nil || statement.Kind != shimast.KindExpressionStatement {
			break
		}
		expression := statement.AsExpressionStatement().Expression
		if expression == nil || expression.Kind != shimast.KindStringLiteral {
			break
		}
		index++
	}
	statements := make([]*shimast.Node, 0, len(sourceFile.Statements.Nodes)+len(imports))
	statements = append(statements, sourceFile.Statements.Nodes[:index]...)
	statements = append(statements, imports...)
	statements = append(statements, sourceFile.Statements.Nodes[index:]...)
	return ec.Factory.UpdateSourceFile(sourceFile, ec.Factory.NewNodeList(statements), sourceFile.EndOfFileToken).AsSourceFile()
}

func sortedEmissionPlanFiles(plans emissionPlans) []string {
	files := make([]string, 0, len(plans))
	for file := range plans {
		files = append(files, file)
	}
	sort.Strings(files)
	return files
}
