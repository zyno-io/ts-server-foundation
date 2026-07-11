package main

import (
	"path/filepath"
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
	if got := len(collectAstNodes(transformed.AsNode(), shimast.KindObjectLiteralExpression)); got != 1 {
		t.Fatalf("metadata object literals = %d, want 1", got)
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

	precomputeMetadataExpressions(reg)

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
