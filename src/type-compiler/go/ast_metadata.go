package main

import (
	"path/filepath"
	"strconv"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
)

func resolveImport(fromFile string, spec string, reg *registry) *fileInfo {
	if !strings.HasPrefix(spec, ".") {
		return nil
	}
	base := filepath.Clean(filepath.Join(filepath.Dir(fromFile), spec))
	ext := strings.ToLower(filepath.Ext(base))
	withoutExt := strings.TrimSuffix(base, filepath.Ext(base))
	candidates := []string{}
	switch ext {
	case ".mjs":
		candidates = append(candidates, moduleKey(withoutExt+".mts"))
	case ".cjs":
		candidates = append(candidates, moduleKey(withoutExt+".cts"))
	case ".js":
		candidates = append(candidates, moduleKey(withoutExt+".ts"), moduleKey(withoutExt+".tsx"))
	default:
		candidates = append(candidates,
			moduleKey(base),
			moduleKey(base+".ts"),
			moduleKey(base+".tsx"),
			moduleKey(base+".mts"),
			moduleKey(base+".cts"),
			moduleKey(filepath.Join(base, "index.ts")),
			moduleKey(filepath.Join(base, "index.mts")),
			moduleKey(filepath.Join(base, "index.cts")),
		)
	}
	for _, candidate := range candidates {
		if info := reg.byPath[candidate]; info != nil {
			return info
		}
	}
	return nil
}

func classFromNode(info *fileInfo, node *shimast.Node) *classInfo {
	file := info.file
	nameNode := node.Name()
	if nameNode == nil {
		return nil
	}
	class := &classInfo{
		name:                 nameNode.Text(),
		pos:                  node.Pos(),
		end:                  node.End(),
		ambient:              node.ModifierFlags()&shimast.ModifierFlagsAmbient != 0 || node.Flags&shimast.NodeFlagsAmbient != 0,
		decoratedMethodsOnly: info.decoratedMethodsOnly,
	}
	for _, member := range node.Members() {
		if member.ModifierFlags()&shimast.ModifierFlagsPrivate != 0 {
			continue
		}
		switch member.Kind {
		case shimast.KindPropertyDeclaration:
			if isStaticMember(file, member) {
				continue
			}
			name := memberName(file, member)
			if name == "" {
				continue
			}
			class.properties = append(class.properties, propertyInfo{
				name:     name,
				typeText: nodeText(file, member.Type()),
				typeNode: member.Type(),
				optional: member.QuestionToken() != nil,
			})
		case shimast.KindMethodDeclaration:
			name := memberName(file, member)
			if name == "" {
				continue
			}
			preferTypia := isHttpRouteMethod(info, member)
			method := methodInfo{
				name:           name,
				description:    jsDocDescription(file, member),
				typeParams:     typeParameterNames(member),
				returnType:     nodeText(file, member.Type()),
				returnTypeNode: member.Type(),
				preferTypia:    preferTypia,
				decorated:      len(member.Decorators()) != 0,
				params:         paramsFromNode(file, member),
			}
			if isStaticMember(file, member) {
				class.staticMethods = append(class.staticMethods, method)
			} else {
				class.methods = append(class.methods, method)
			}
		case shimast.KindConstructor:
			class.ctor = paramsFromNode(file, member)
			class.hasCtor = true
		}
	}
	return class
}

func functionFromNode(file *shimast.SourceFile, node *shimast.Node) functionInfo {
	nameNode := node.Name()
	if nameNode == nil {
		return functionInfo{}
	}
	return functionInfo{
		name:       nameNode.Text(),
		typeParams: typeParameterNames(node),
		params:     paramsFromNode(file, node),
		pos:        node.Pos(),
	}
}

func typeParameterNames(node *shimast.Node) []string {
	params := []string{}
	for _, param := range node.TypeParameters() {
		if param.Name() != nil {
			params = append(params, param.Name().Text())
		}
	}
	return params
}

func isHttpRouteMethod(info *fileInfo, member *shimast.Node) bool {
	for _, decorator := range member.Decorators() {
		if decorator.Kind != shimast.KindDecorator {
			continue
		}
		if isHttpRouteDecoratorExpression(info, decorator.AsDecorator().Expression.AsNode()) {
			return true
		}
	}
	return false
}

func isHttpRouteDecoratorExpression(info *fileInfo, expr *shimast.Node) bool {
	if expr == nil {
		return false
	}
	switch expr.Kind {
	case shimast.KindParenthesizedExpression:
		return isHttpRouteDecoratorExpression(info, expr.Expression())
	case shimast.KindCallExpression:
		callee := expr.Expression()
		if isHttpRouteCallee(info, callee) {
			return true
		}
		return isHttpRouteDecoratorExpression(info, callee)
	case shimast.KindPropertyAccessExpression:
		if isHttpRouteCallee(info, expr) {
			return true
		}
		return isHttpRouteDecoratorExpression(info, expr.Expression())
	default:
		return false
	}
}

func isHttpRouteCallee(info *fileInfo, callee *shimast.Node) bool {
	if callee == nil {
		return false
	}
	switch callee.Kind {
	case shimast.KindIdentifier:
		name := callee.Text()
		return isHttpVerb(name) && isDirectHttpVerbImport(info, name)
	case shimast.KindPropertyAccessExpression:
		access := callee.AsPropertyAccessExpression()
		name := access.Name()
		return name != nil && isHttpVerb(name.Text()) && isHttpNamespaceExpression(info, access.Expression.AsNode())
	default:
		return false
	}
}

func isHttpNamespaceExpression(info *fileInfo, expr *shimast.Node) bool {
	for expr != nil && expr.Kind == shimast.KindParenthesizedExpression {
		expr = expr.Expression()
	}
	if expr == nil || expr.Kind != shimast.KindIdentifier {
		return false
	}
	return isHttpNamespaceImport(info, expr.Text())
}

func isHttpNamespaceImport(info *fileInfo, name string) bool {
	if name != "http" {
		return false
	}
	ref, ok := info.imports[name]
	return ok && ref.exportName == "http" && isFoundationHttpImport(ref)
}

func isDirectHttpVerbImport(info *fileInfo, name string) bool {
	ref, ok := info.imports[name]
	return ok && ref.exportName == name && isFoundationHttpImport(ref)
}

func isFoundationHttpImport(ref importRef) bool {
	spec := filepath.ToSlash(ref.spec)
	source := filepath.ToSlash(ref.source)
	if strings.HasSuffix(source, "/src/index") ||
		strings.HasSuffix(source, "/src/http") ||
		strings.HasSuffix(source, "/src/http/index") ||
		strings.HasSuffix(source, "/src/http/decorators") {
		return true
	}
	return spec == foundationPackageSpec
}

func isHttpVerb(name string) bool {
	switch name {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD":
		return true
	default:
		return false
	}
}

func isStaticMember(file *shimast.SourceFile, member *shimast.Node) bool {
	return member.ModifierFlags()&shimast.ModifierFlagsStatic != 0
}

func memberName(file *shimast.SourceFile, member *shimast.Node) string {
	name := member.Name()
	if name == nil {
		return ""
	}
	text := strings.TrimSpace(stripTypeComments(nodeText(file, name)))
	if text == "" || strings.HasPrefix(text, "[") || strings.HasPrefix(text, "{") {
		return ""
	}
	if len(text) >= 2 {
		quote := text[0]
		if (quote == '\'' || quote == '"' || quote == '`') && text[len(text)-1] == quote {
			unquoted, err := strconv.Unquote(text)
			if err == nil {
				return unquoted
			}
			return strings.Trim(text, "'\"`")
		}
	}
	return text
}

func paramsFromNode(file *shimast.SourceFile, node *shimast.Node) []paramInfo {
	params := []paramInfo{}
	for _, param := range node.Parameters() {
		name := memberName(file, param)
		if name == "" {
			name = "arg"
		}
		params = append(params, paramInfo{
			name:       name,
			typeText:   nodeText(file, param.Type()),
			typeNode:   param.Type(),
			optional:   param.QuestionToken() != nil || param.Initializer() != nil,
			hasDefault: param.Initializer() != nil,
		})
	}
	return params
}

func nodeText(file *shimast.SourceFile, node *shimast.Node) string {
	if node == nil {
		return "unknown"
	}
	return strings.TrimSpace(stripTypeComments(file.Text()[node.Pos():node.End()]))
}

func jsDocDescription(file *shimast.SourceFile, node *shimast.Node) string {
	docs := node.JSDoc(file)
	if len(docs) == 0 {
		return ""
	}
	doc := docs[len(docs)-1]
	return cleanJsDocDescription(file.Text()[doc.Pos():doc.End()])
}

func cleanJsDocDescription(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "/**")
	raw = strings.TrimSuffix(raw, "*/")
	lines := strings.Split(raw, "\n")
	parts := []string{}
	for _, line := range lines {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "*"))
		if strings.HasPrefix(line, "@") {
			break
		}
		if line == "" {
			if len(parts) > 0 {
				break
			}
			continue
		}
		parts = append(parts, line)
	}
	return strings.Join(parts, " ")
}

func classMetadata(info *fileInfo, reg *registry, class *classInfo, typeRef func(string) string) string {
	props := []string{}
	for _, prop := range class.properties {
		items := []string{
			"name: " + quote(prop.name),
			"type: " + referMetadataType(typeRef, cachedTypeExpr(info, reg, prop.typeText, prop.typeNode, class.pos, prop.metadataText)),
			"optional: " + boolLit(prop.optional),
		}
		flags := collectFlags(info, reg, prop.typeText)
		if flags["primaryKey"] != "" {
			items = append(items, "primaryKey: true")
		}
		if flags["autoIncrement"] != "" {
			items = append(items, "autoIncrement: true")
		}
		for _, key := range []string{"reference", "index", "unique"} {
			if value := flags[key]; value != "" {
				items = append(items, key+": "+value)
			}
		}
		props = append(props, "{"+strings.Join(items, ", ")+"}")
	}
	methods := []string{}
	for _, method := range class.methods {
		if class.decoratedMethodsOnly && !method.decorated {
			continue
		}
		items := []string{
			"name: " + quote(method.name),
			"parameters: " + paramsExpr(info, reg, method.params, class.pos, typeRef),
			"returnType: " + referMetadataType(typeRef, cachedTypeExpr(info, reg, method.returnType, method.returnTypeNode, class.pos, method.returnMetadataText)),
		}
		if method.description != "" {
			items = append(items, "description: "+quote(method.description))
		}
		methods = append(methods, "{"+strings.Join(items, ", ")+"}")
	}
	return "{kind: 16, name: " + quote(class.name) +
		", typeName: " + quote(class.name) +
		", classType: () => " + class.name +
		", properties: [" + strings.Join(props, ", ") + "]" +
		", methods: [" + strings.Join(methods, ", ") + "]" +
		", hasConstructor: " + boolLit(class.hasCtor) +
		", constructorParameters: " + paramsExpr(info, reg, class.ctor, class.pos, typeRef) + "}"
}

func paramsExpr(info *fileInfo, reg *registry, params []paramInfo, pos int, typeRef func(string) string) string {
	out := []string{}
	for _, param := range params {
		typeExpr := referMetadataType(typeRef, cachedTypeExpr(info, reg, param.typeText, param.typeNode, pos, param.metadataText))
		out = append(out, "{name: "+quote(param.name)+", type: "+typeExpr+", optional: "+boolLit(param.optional)+", default: "+boolLit(param.hasDefault)+"}")
	}
	return "[" + strings.Join(out, ", ") + "]"
}

func referMetadataType(typeRef func(string) string, expr string) string {
	if typeRef == nil {
		return expr
	}
	return typeRef(expr)
}
