package main

import (
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	shimcore "github.com/microsoft/typescript-go/shim/core"
	shimparser "github.com/microsoft/typescript-go/shim/parser"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

func TestExpressionTemplateParsesStructuredMetadata(t *testing.T) {
	template, err := parseExpressionTemplate(`{
		kind: 16,
		classType: () => Date,
		value: (() => ({nested: [true, 1, "two"]}))()
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if template.parsed == nil || template.parsed.Kind != shimast.KindParenthesizedExpression {
		t.Fatalf("parsed expression kind = %v", template.parsed)
	}
}

func TestExpressionTemplateRejectsMalformedSourceAndPlaceholders(t *testing.T) {
	for _, source := range []string{
		`{kind:`,
		`__tsf_runtime_import__("pkg", "Value")`,
		`__tsf_runtime_namespace__("pkg", 1)`,
	} {
		if _, err := parseExpressionTemplate(source); err == nil {
			t.Fatalf("parseExpressionTemplate(%q) unexpectedly succeeded", source)
		}
	}
}

func TestRuntimePlaceholderMaterializationPreservesModuleSemantics(t *testing.T) {
	template, err := parseExpressionTemplate(`{
		member: __tsf_runtime_import__("./dependency", "Value", "/project/dependency.ts"),
		namespace: __tsf_runtime_namespace__("@scope/shared", "")
	}`)
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name        string
		commonJS    bool
		wantImports int
		wantRequire bool
	}{
		{name: "esm", wantImports: 2},
		{name: "commonjs", commonJS: true, wantRequire: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ec := shimprinter.NewEmitContext()
			file := parseTestSourceFile(t, "/project/consumer.ts", `export const value = 1;`)
			imports := newAstImportRegistry(ec, file, test.commonJS)
			materialized := template.materialize(ec, imports)
			if containsRuntimePlaceholder(materialized) {
				t.Fatal("compiler placeholder survived materialization")
			}
			if got := len(imports.statements()); got != test.wantImports {
				t.Fatalf("generated imports = %d, want %d", got, test.wantImports)
			}
			if got := astContainsIdentifier(materialized, "require"); got != test.wantRequire {
				t.Fatalf("contains require = %v, want %v", got, test.wantRequire)
			}
		})
	}
}

func TestUpdateMetadataCallUsesAbsoluteArgumentSlot(t *testing.T) {
	ec := shimprinter.NewEmitContext()
	imports := newAstImportRegistry(ec, nil, true)
	template, err := parseExpressionTemplate(`{kind: 7}`)
	if err != nil {
		t.Fatal(err)
	}
	call := ec.Factory.NewCallExpression(
		ec.Factory.NewIdentifier("cast"),
		nil,
		nil,
		ec.Factory.NewNodeList([]*shimast.Node{ec.Factory.NewIdentifier("input")}),
		shimast.NodeFlagsNone,
	).AsCallExpression()
	updated := updateMetadataCall(ec, call, callEmissionPlan{metadataArgIndex: 4, metadata: template}, imports).AsCallExpression()
	if got := len(updated.Arguments.Nodes); got != 5 {
		t.Fatalf("arguments = %d, want 5", got)
	}
	for index := 1; index < 4; index++ {
		if updated.Arguments.Nodes[index].Kind != shimast.KindIdentifier || updated.Arguments.Nodes[index].Text() != "undefined" {
			t.Fatalf("argument %d was not an undefined filler", index)
		}
	}
}

func TestMetadataTransformMatchesExactCallPosition(t *testing.T) {
	file := parseTestSourceFile(t, "/project/calls.ts", `
		function same<T>(): void {}
		same<number>();
		same<string>();
	`)
	calls := collectAstNodes(file.AsNode(), shimast.KindCallExpression)
	if len(calls) != 2 {
		t.Fatalf("call expressions = %d, want 2", len(calls))
	}
	template, err := parseExpressionTemplate(`{kind: 7}`)
	if err != nil {
		t.Fatal(err)
	}
	plans := emissionPlans{file.FileName(): {
		calls: map[int]callEmissionPlan{
			calls[1].Pos(): {metadataArgIndex: 0, metadata: template},
		},
		classes:  map[int]classEmissionPlan{},
		commonJS: true,
	}}
	transformed := metadataTransform(plans)(shimprinter.NewEmitContext(), file)
	transformedCalls := collectAstNodes(transformed.AsNode(), shimast.KindCallExpression)
	if len(transformedCalls) != 2 {
		t.Fatalf("transformed calls = %d, want 2", len(transformedCalls))
	}
	if len(transformedCalls[0].AsCallExpression().Arguments.Nodes) != 0 {
		t.Fatal("unplanned same-named call was transformed")
	}
	if len(transformedCalls[1].AsCallExpression().Arguments.Nodes) != 1 {
		t.Fatal("planned call was not transformed")
	}
}

func TestClassMetadataTransformMaterializesOneSharedObject(t *testing.T) {
	file := parseTestSourceFile(t, "/project/model.ts", `class Model { value: string }`)
	classes := collectAstNodes(file.AsNode(), shimast.KindClassDeclaration)
	if len(classes) != 1 {
		t.Fatalf("class declarations = %d, want 1", len(classes))
	}
	template, err := parseExpressionTemplate(`{kind: 16, properties: []}`)
	if err != nil {
		t.Fatal(err)
	}
	plans := emissionPlans{file.FileName(): {
		calls: map[int]callEmissionPlan{},
		classes: map[int]classEmissionPlan{
			classes[0].Pos(): {name: "Model", metadata: template},
		},
		commonJS: true,
	}}
	transformed := metadataTransform(plans)(shimprinter.NewEmitContext(), file)
	if got := len(collectAstNodes(transformed.AsNode(), shimast.KindObjectLiteralExpression)); got != 0 {
		t.Fatalf("class metadata left %d object literals in the emitted AST", got)
	}
	if !astContainsIdentifier(transformed.AsNode(), compactMetadataDecoderName) {
		t.Fatal("class metadata was not decoded from compact data")
	}
}

func TestCompactMetadataHidesGeneratedObjectFromBuiltinTransforms(t *testing.T) {
	file := parseTestSourceFile(t, "/project/model.ts", `class Model {}`)
	template, err := parseExpressionTemplate(`{kind: 16, classType: () => Model}`)
	if err != nil {
		t.Fatal(err)
	}
	plans := emissionPlans{file.FileName(): {
		calls:                map[int]callEmissionPlan{},
		classes:              map[int]classEmissionPlan{},
		metadataTypes:        []expressionTemplate{template},
		metadataTypeResolver: "__tsf_metadata_type",
		commonJS:             true,
	}}

	transformed := metadataTransform(plans)(shimprinter.NewEmitContext(), file)
	if got := len(collectAstNodes(transformed.AsNode(), shimast.KindObjectLiteralExpression)); got != 0 {
		t.Fatalf("compact metadata left %d object literals in the emitted AST", got)
	}
	if astContainsIdentifier(transformed.AsNode(), "eval") {
		t.Fatal("compact metadata emitted direct eval")
	}
	if !astContainsIdentifier(transformed.AsNode(), compactMetadataRegistryName) {
		t.Fatal("compact metadata did not create a lazy runtime registry")
	}
	if got := len(collectAstNodes(transformed.AsNode(), shimast.KindImportDeclaration)); got != 1 {
		t.Fatalf("generated imports = %d, want one decoder import", got)
	}
}

func TestCompactMetadataEncoderExtractsRuntimeExpressions(t *testing.T) {
	template, err := parseExpressionTemplate(`{
		kind: 16,
		classType: () => Model,
		missing: undefined,
		big: 12n,
		nested: [true, -2, "two"]
	}`)
	if err != nil {
		t.Fatal(err)
	}
	encoding := encodeCompactMetadata(template.parsed)
	if got := len(encoding.references); got != 3 {
		t.Fatalf("runtime references = %d, want 3", got)
	}
	for _, want := range []string{
		`[1,{"kind":16`,
		`"classType":{"$tsf":0}`,
		`"missing":{"$tsf":1}`,
		`"big":{"$tsf":2}`,
		`"nested":[true,-2,"two"]`,
	} {
		if !strings.Contains(encoding.serialized, want) {
			t.Fatalf("compact payload is missing %q: %s", want, encoding.serialized)
		}
	}
}

func TestCompactMetadataEncoderEscapesReferenceMarkerCollision(t *testing.T) {
	for _, source := range []string{
		`{"$tsf": 7}`,
		`{"$tsfImport": [0, "Model"]}`,
		`{"$tsfAlias": [0, "Alias", "Alias"]}`,
		`{"$tsfType": 0}`,
	} {
		template, err := parseExpressionTemplate(source)
		if err != nil {
			t.Fatal(err)
		}
		encoding := encodeCompactMetadata(template.parsed)
		if encoding.serialized != `[1,{"$tsf":0}]` {
			t.Fatalf("compact payload for %s = %s", source, encoding.serialized)
		}
		if len(encoding.references) != 1 || encoding.references[0].Kind != shimast.KindObjectLiteralExpression {
			t.Fatalf("marker-shaped application data %s was not escaped through a runtime slot", source)
		}
	}
}

func TestCompactMetadataEncodesCommonJSImportsAndAliasesAsRecipes(t *testing.T) {
	file := parseTestSourceFile(t, "/project/consumer.ts", `export const value = 1`)
	template, err := parseExpressionTemplate(`{
		classType: () => __tsf_runtime_import__("./model", "Model", "/project/model.ts"),
		alias: __tsf_runtime_alias__("@scope/types", "Alias", "RenamedAlias")
	}`)
	if err != nil {
		t.Fatal(err)
	}
	ec := shimprinter.NewEmitContext()
	imports := newAstImportRegistry(ec, file, true)
	interner := newCompactMetadataRuntimeInterner(ec, file)
	materialized := template.materialize(ec, imports)
	encoding := encodeCompactMetadataWithRuntimeRecipes(
		materialized,
		interner.deduplicationKey,
		func(encoder *compactMetadataEncoder, expression *shimast.Node) bool {
			return writeCompactMetadataRuntimeRecipe(encoder, expression, imports, "")
		},
	)
	if !strings.Contains(encoding.serialized, `"classType":{"$tsfImport":[0,"./model","Model"]}`) {
		t.Fatalf("class import was not encoded as a recipe: %s", encoding.serialized)
	}
	if !strings.Contains(encoding.serialized, `"alias":{"$tsfAlias":[0,"@scope/types","Alias","RenamedAlias"]}`) {
		t.Fatalf("alias was not encoded as a recipe: %s", encoding.serialized)
	}
	if len(encoding.references) != 1 {
		t.Fatalf("module loader references = %d, want 1", len(encoding.references))
	}
	for _, reference := range encoding.references {
		if !isCompactMetadataCommonJSRequire(reference, imports) {
			t.Fatal("recipe emitted a per-type runtime expression instead of the file's require function")
		}
	}
}

func TestCompactMetadataEncoderDeduplicatesGeneratedRuntimeThunks(t *testing.T) {
	file := parseTestSourceFile(t, "/project/model.ts", `class Model {}`)
	template, err := parseExpressionTemplate(`{first: () => Model, second: () => Model}`)
	if err != nil {
		t.Fatal(err)
	}
	ec := shimprinter.NewEmitContext()
	interner := newCompactMetadataRuntimeInterner(ec, file)
	metadata := template.materialize(ec, newAstImportRegistry(ec, file, true))
	encoding := encodeCompactMetadataWithReferenceKeys(metadata, interner.deduplicationKey)
	if len(encoding.references) != 1 {
		t.Fatalf("runtime references = %d, want 1", len(encoding.references))
	}
	if strings.Count(encoding.serialized, `{"$tsf":0}`) != 2 {
		t.Fatalf("repeated thunk did not reuse one reference index: %s", encoding.serialized)
	}
}

func TestCompactMetadataEncoderRollsBackUnsupportedNestedValues(t *testing.T) {
	file := parseTestSourceFile(t, "/project/model.ts", `class Model {}`)
	template, err := parseExpressionTemplate(`{
		escaped: {value: () => Model, ...extra},
		again: () => Model
	}`)
	if err != nil {
		t.Fatal(err)
	}
	interner := newCompactMetadataRuntimeInterner(shimprinter.NewEmitContext(), file)
	encoding := encodeCompactMetadataWithReferenceKeys(template.parsed, interner.deduplicationKey)
	if encoding.serialized != `[1,{"escaped":{"$tsf":0},"again":{"$tsf":1}}]` {
		t.Fatalf("compact payload retained a stale nested reference: %s", encoding.serialized)
	}
	if len(encoding.references) != 2 {
		t.Fatalf("runtime references = %d, want 2", len(encoding.references))
	}
}

func TestClassFromNodeRecognizesAmbientContext(t *testing.T) {
	file := parseTestSourceFile(t, "/project/ambient.ts", `
		declare namespace AmbientScope {
			class Nested { value: string }
		}
	`)
	classes := collectAstNodes(file.AsNode(), shimast.KindClassDeclaration)
	if len(classes) != 1 {
		t.Fatalf("class declarations = %d, want 1", len(classes))
	}
	info := &fileInfo{file: file}
	class := classFromNode(info, classes[0])
	if class == nil || !class.ambient {
		t.Fatal("class nested in an ambient namespace was not marked ambient")
	}
}

func TestPrecomputeSkipsAmbientClasses(t *testing.T) {
	file := parseTestSourceFile(t, "/project/precompute.ts", ``)
	ambient := &classInfo{ambient: true, properties: []propertyInfo{{typeText: "string"}}}
	runtimeClass := &classInfo{properties: []propertyInfo{{typeText: "string"}}}
	info := &fileInfo{
		file:       file,
		moduleKey:  moduleKey(file.FileName()),
		precompute: true,
		aliases:    map[string]aliasInfo{},
		interfaces: map[string][]interfaceInfo{},
		enums:      map[string]enumInfo{},
		classes:    []*classInfo{ambient, runtimeClass},
		imports:    map[string]importRef{},
		reexports:  map[string]importRef{},
	}
	reg := &registry{
		files:         map[string]*fileInfo{file.FileName(): info},
		byPath:        map[string]*fileInfo{info.moduleKey: info},
		typiaCache:    map[typiaCacheKey]string{},
		typiaFailures: map[*shimchecker.Type]bool{},
		classes:       map[string]*classInfo{},
		external:      map[string]map[string][]functionInfo{},
	}

	precomputeMetadataExpressions(reg, true)

	if ambient.properties[0].metadataText != "" {
		t.Fatal("ambient class metadata was precomputed")
	}
	if runtimeClass.properties[0].metadataText == "" {
		t.Fatal("runtime class metadata was not precomputed")
	}
}

func parseTestSourceFile(t *testing.T, fileName string, source string) *shimast.SourceFile {
	t.Helper()
	file := shimparser.ParseSourceFile(
		shimast.SourceFileParseOptions{FileName: filepath.ToSlash(fileName)},
		source,
		shimcore.ScriptKindTS,
	)
	if file == nil || len(file.Diagnostics()) != 0 {
		t.Fatalf("failed to parse test source %s", fileName)
	}
	return file
}

func collectAstNodes(root *shimast.Node, kind shimast.Kind) []*shimast.Node {
	out := []*shimast.Node{}
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		if node.Kind == kind {
			out = append(out, node)
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(root)
	return out
}

func astContainsIdentifier(root *shimast.Node, name string) bool {
	for _, node := range collectAstNodes(root, shimast.KindIdentifier) {
		if node.Text() == name {
			return true
		}
	}
	return false
}
