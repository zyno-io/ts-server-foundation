package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimcore "github.com/microsoft/typescript-go/shim/core"
	shimparser "github.com/microsoft/typescript-go/shim/parser"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

const (
	runtimeImportPlaceholderName    = "__tsf_runtime_import__"
	runtimeNamespacePlaceholderName = "__tsf_runtime_namespace__"
)

type expressionTemplate struct {
	parsed *shimast.Node
}

func parseExpressionTemplate(source string) (expressionTemplate, error) {
	source = strings.TrimSpace(source)
	if source == "" {
		return expressionTemplate{}, fmt.Errorf("generated expression is empty")
	}
	fileName := filepath.ToSlash(filepath.Join(os.TempDir(), "tsf-generated-metadata-expression.ts"))
	file := shimparser.ParseSourceFile(
		shimast.SourceFileParseOptions{FileName: fileName},
		"("+source+");",
		shimcore.ScriptKindTS,
	)
	if file == nil {
		return expressionTemplate{}, fmt.Errorf("generated expression did not parse")
	}
	if diagnostics := file.Diagnostics(); len(diagnostics) != 0 {
		return expressionTemplate{}, fmt.Errorf("generated expression has %d parse diagnostic(s)", len(diagnostics))
	}
	if file.Statements == nil || len(file.Statements.Nodes) != 1 {
		return expressionTemplate{}, fmt.Errorf("generated expression did not parse as one statement")
	}
	statement := file.Statements.Nodes[0]
	if statement == nil || statement.Kind != shimast.KindExpressionStatement || statement.AsExpressionStatement().Expression == nil {
		return expressionTemplate{}, fmt.Errorf("generated expression did not parse as an expression statement")
	}
	parsed := statement.AsExpressionStatement().Expression.AsNode()
	if err := validateRuntimePlaceholders(parsed); err != nil {
		return expressionTemplate{}, err
	}
	return expressionTemplate{parsed: parsed}, nil
}

func validateRuntimePlaceholders(node *shimast.Node) error {
	var validationErr error
	var walk func(*shimast.Node)
	walk = func(current *shimast.Node) {
		if current == nil || validationErr != nil {
			return
		}
		if current.Kind == shimast.KindCallExpression {
			call := current.AsCallExpression()
			if call != nil && call.Expression != nil && call.Expression.Kind == shimast.KindIdentifier {
				name := call.Expression.Text()
				expected := -1
				switch name {
				case runtimeImportPlaceholderName:
					expected = 3
				case runtimeNamespacePlaceholderName:
					expected = 2
				}
				if expected >= 0 {
					if call.Arguments == nil || len(call.Arguments.Nodes) != expected {
						validationErr = fmt.Errorf("%s requires %d string arguments", name, expected)
						return
					}
					for _, argument := range call.Arguments.Nodes {
						if argument == nil || !shimast.IsStringLiteral(argument) {
							validationErr = fmt.Errorf("%s arguments must be string literals", name)
							return
						}
					}
				}
			}
		}
		current.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return validationErr != nil
		})
	}
	walk(node)
	return validationErr
}

func (template expressionTemplate) materialize(ec *shimprinter.EmitContext, imports *astImportRegistry) *shimast.Node {
	if template.parsed == nil {
		panic("tsf metadata compiler: nil expression template")
	}
	cloned := ec.Factory.DeepCloneNode(template.parsed)
	var visitor *shimast.NodeVisitor
	visitor = ec.NewNodeVisitor(func(node *shimast.Node) *shimast.Node {
		if node == nil {
			return nil
		}
		if replacement := materializeRuntimePlaceholder(node, imports); replacement != nil {
			return replacement
		}
		return visitor.VisitEachChild(node)
	})
	result := visitor.VisitNode(cloned)
	if containsRuntimePlaceholder(result) {
		panic("tsf metadata compiler: runtime placeholder survived AST materialization")
	}
	return result
}

func materializeRuntimePlaceholder(node *shimast.Node, imports *astImportRegistry) *shimast.Node {
	if node.Kind != shimast.KindCallExpression {
		return nil
	}
	call := node.AsCallExpression()
	if call == nil || call.Expression == nil || call.Expression.Kind != shimast.KindIdentifier || call.Arguments == nil {
		return nil
	}
	args := call.Arguments.Nodes
	switch call.Expression.Text() {
	case runtimeNamespacePlaceholderName:
		if len(args) == 2 && shimast.IsStringLiteral(args[0]) && shimast.IsStringLiteral(args[1]) {
			return imports.namespace(args[0].Text(), args[1].Text())
		}
	case runtimeImportPlaceholderName:
		if len(args) == 3 && shimast.IsStringLiteral(args[0]) && shimast.IsStringLiteral(args[1]) && shimast.IsStringLiteral(args[2]) {
			return imports.member(args[0].Text(), args[1].Text(), args[2].Text())
		}
	}
	return nil
}

func containsRuntimePlaceholder(node *shimast.Node) bool {
	found := false
	var walk func(*shimast.Node)
	walk = func(current *shimast.Node) {
		if current == nil || found {
			return
		}
		if current.Kind == shimast.KindIdentifier {
			name := current.Text()
			if name == runtimeImportPlaceholderName || name == runtimeNamespacePlaceholderName {
				found = true
				return
			}
		}
		current.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return found
		})
	}
	walk(node)
	return found
}
