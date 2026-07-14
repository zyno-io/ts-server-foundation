package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	typiafactories "github.com/samchon/typia/packages/typia/native/core/factories"
	schemametadata "github.com/samchon/typia/packages/typia/native/core/schemas/metadata"
)

func typeExprForNode(info *fileInfo, reg *registry, raw string, node *shimast.Node, pos int) string {
	return typeExprForNodePreferred(info, reg, raw, node, pos, false)
}

func typeExprForNodePreferred(info *fileInfo, reg *registry, raw string, node *shimast.Node, pos int, preferTypia bool) string {
	raw = strings.TrimSpace(stripTypeComments(raw))
	if preferTypia {
		if expr, ok := preferredWrapperTypeExprForNode(info, reg, raw, node, pos); ok {
			return expr
		}
		if expr, ok := preferredCachedAliasTypeExpr(info, reg, raw, pos); ok {
			return expr
		}
		if expr, ok := preferredNullishAliasTypeExpr(info, reg, raw, pos); ok {
			return expr
		}
		if expr, ok := preferredDateRootTypeExpr(info, reg, raw, pos); ok {
			return expr
		}
		if expr, ok := preferredExternalImportedTypeExpr(info, raw); ok {
			return expr
		}
		if expr, ok := preferredExternalImportedCompositeTypeExpr(info, reg, raw, pos); ok {
			return expr
		}
		if expr, ok := preferredNamedInterfaceTypeExpr(info, reg, raw, pos); ok {
			return expr
		}
		if canPreferTypiaTypeOnPreferredSurfaceAt(info, reg, raw, pos) {
			if expr, ok := typiaTypeExprForNode(info, reg, raw, node, pos); ok {
				return typiaSourceNamedExpr(info, reg, expr, raw)
			}
		}
	}
	if shouldUseTextTypeExpr(raw) {
		return internalTypeExprAt(info, reg, raw, pos)
	}
	if shouldUseTypiaType(info, reg, raw) && canPreferTypiaType(info, reg, raw) {
		if expr, ok := typiaTypeExprForNode(info, reg, raw, node, pos); ok {
			return typiaSourceNamedExpr(info, reg, expr, raw)
		}
	}
	return internalTypeExprAt(info, reg, raw, pos)
}

func preferredCachedAliasTypeExpr(info *fileInfo, reg *registry, raw string, pos int) (string, bool) {
	raw = strings.TrimSpace(trimParens(raw))
	if !isIdentifierName(raw) {
		return "", false
	}
	alias, owner, ref, ok := resolveAliasRef(info, reg, raw)
	if !ok || len(alias.params) != 0 {
		return "", false
	}
	aliasName := raw
	if ref != nil {
		aliasName = ref.exportName
	}
	alias = ensureAliasMetadata(owner, reg, aliasName, alias)
	if strings.TrimSpace(alias.metadataText) == "" {
		return "", false
	}
	return aliasTypeExprCtx(owner, reg, alias, raw, &typeContext{seen: map[string]bool{}, pos: pos}), true
}

func preferredNullishAliasTypeExpr(info *fileInfo, reg *registry, raw string, pos int) (string, bool) {
	types := []string{}
	aliasCount, ok := collectNullishAliasTypeExprs(info, reg, raw, pos, &types)
	if !ok || aliasCount != 1 || len(types) <= 1 {
		return "", false
	}
	return "{kind: 12, types: [" + strings.Join(types, ", ") + "]}", true
}

func collectNullishAliasTypeExprs(info *fileInfo, reg *registry, raw string, pos int, types *[]string) (int, bool) {
	raw = strings.TrimSpace(trimParens(raw))
	parts := nonEmptyParts(splitTop(raw, "|"))
	if len(parts) > 1 {
		aliasCount := 0
		for _, part := range parts {
			count, ok := collectNullishAliasTypeExprs(info, reg, part, pos, types)
			if !ok {
				return 0, false
			}
			aliasCount += count
		}
		return aliasCount, true
	}
	switch raw {
	case "null":
		*types = append(*types, "{kind: 5}")
		return 0, true
	case "undefined":
		*types = append(*types, "{kind: 4}")
		return 0, true
	default:
		expr, ok := preferredCachedAliasTypeExpr(info, reg, raw, pos)
		if !ok {
			return 0, false
		}
		*types = append(*types, expr)
		return 1, true
	}
}

func preferredDateRootTypeExpr(info *fileInfo, reg *registry, raw string, pos int) (string, bool) {
	if !sourceTypeIsDateRootType(info, reg, raw, &typeContext{seen: map[string]bool{}, pos: pos}, map[string]bool{}) {
		return "", false
	}
	return internalTypeExprAt(info, reg, raw, pos), true
}

func preferredExternalImportedTypeExpr(info *fileInfo, raw string) (string, bool) {
	raw = strings.TrimSpace(trimParens(raw))
	if !isIdentifierName(raw) {
		return "", false
	}
	ref, ok := info.imports[raw]
	if !ok || !isExternalImportRef(ref) {
		return "", false
	}
	return externalImportedTypeExpr(ref, raw), true
}

func preferredExternalImportedCompositeTypeExpr(info *fileInfo, reg *registry, raw string, pos int) (string, bool) {
	raw = strings.TrimSpace(trimParens(raw))
	if raw == "" || isIdentifierName(raw) {
		return "", false
	}
	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		if typeContainsExternalImportReferenceInParts(info, reg, parts, map[string]bool{}) {
			return internalTypeExprAt(info, reg, raw, pos), true
		}
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		if typeContainsExternalImportReferenceInParts(info, reg, parts, map[string]bool{}) {
			return internalTypeExprAt(info, reg, raw, pos), true
		}
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		parts := nonEmptyParts(splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","))
		if typeContainsExternalImportReferenceInParts(info, reg, parts, map[string]bool{}) {
			return internalTypeExprAt(info, reg, raw, pos), true
		}
	}
	return "", false
}

func preferredNamedInterfaceTypeExpr(info *fileInfo, reg *registry, raw string, pos int) (string, bool) {
	raw = strings.TrimSpace(trimParens(raw))
	if !isIdentifierName(raw) {
		return "", false
	}
	decl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, raw, pos)
	if !ok {
		return "", false
	}
	if !interfaceNeedsPreferredSourceMetadata(owner, reg, decl, map[string]bool{}) {
		return "", false
	}
	return interfaceObjectLiteralExprPreferred(owner, reg, raw, decl, &typeContext{seen: map[string]bool{}, pos: pos}), true
}

func interfaceNeedsPreferredSourceMetadata(info *fileInfo, reg *registry, decl interfaceInfo, seen map[string]bool) bool {
	key := info.moduleKey + "\x00" + strconv.Itoa(decl.pos)
	if seen[key] {
		return false
	}
	seen[key] = true
	for _, prop := range interfaceFullProperties(info, reg, decl, map[string]bool{}) {
		owner := info
		if prop.owner != nil {
			owner = prop.owner
		}
		if typeContainsAliasReference(owner, reg, prop.typeText, map[string]bool{}) {
			return true
		}
		if typeContainsExternalImportReference(owner, reg, prop.typeText, map[string]bool{}) {
			return true
		}
		if sourceTypeContainsDateType(owner, reg, prop.typeText, &typeContext{seen: map[string]bool{}, pos: decl.pos}, map[string]bool{}) {
			return true
		}
		if sourceTypeNeedsInternalPropertyMetadata(owner, reg, prop.typeText, &typeContext{seen: map[string]bool{}, pos: decl.pos}, map[string]bool{}) {
			return true
		}
	}
	return false
}

func typeContainsAliasReference(info *fileInfo, reg *registry, raw string, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" {
		return false
	}
	key := info.moduleKey + "\x00alias-boundary\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true
	if isIdentifierName(raw) {
		_, _, _, ok := resolveAliasRef(info, reg, raw)
		return ok
	}
	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		return typeContainsAliasReferenceInParts(info, reg, parts, seen)
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		return typeContainsAliasReferenceInParts(info, reg, parts, seen)
	}
	if strings.HasSuffix(raw, "[]") {
		return typeContainsAliasReference(info, reg, strings.TrimSuffix(raw, "[]"), seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return typeContainsAliasReferenceInParts(info, reg, splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","), seen)
	}
	if isObjectLiteralTypeText(raw) {
		for _, prop := range propertiesFromBody(strings.TrimSpace(raw[1 : len(raw)-1])) {
			if typeContainsAliasReference(info, reg, prop.typeText, seen) {
				return true
			}
		}
		return false
	}
	if name, args, ok := generic(raw); ok {
		if _, _, _, ok := resolveAliasRef(info, reg, name); ok {
			return true
		}
		for _, arg := range args {
			if typeContainsAliasReference(info, reg, arg, seen) {
				return true
			}
		}
	}
	return false
}

func typeContainsAliasReferenceInParts(info *fileInfo, reg *registry, parts []string, seen map[string]bool) bool {
	for _, part := range parts {
		if typeContainsAliasReference(info, reg, part, seen) {
			return true
		}
	}
	return false
}

func typeContainsExternalImportReference(info *fileInfo, reg *registry, raw string, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" {
		return false
	}
	key := info.moduleKey + "\x00external-boundary\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true
	if isIdentifierName(raw) {
		if ref, ok := info.imports[raw]; ok && isExternalImportRef(ref) && !isFoundationImportRef(ref) {
			return true
		}
	}
	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		return typeContainsExternalImportReferenceInParts(info, reg, parts, seen)
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		return typeContainsExternalImportReferenceInParts(info, reg, parts, seen)
	}
	if strings.HasSuffix(raw, "[]") {
		return typeContainsExternalImportReference(info, reg, strings.TrimSuffix(raw, "[]"), seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return typeContainsExternalImportReferenceInParts(info, reg, splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","), seen)
	}
	if isObjectLiteralTypeText(raw) {
		for _, prop := range propertiesFromBody(strings.TrimSpace(raw[1 : len(raw)-1])) {
			if typeContainsExternalImportReference(info, reg, prop.typeText, seen) {
				return true
			}
		}
		return false
	}
	if name, args, ok := generic(raw); ok {
		if ref, ok := info.imports[name]; ok && isExternalImportRef(ref) && !isFoundationImportRef(ref) {
			return true
		}
		for _, arg := range args {
			if typeContainsExternalImportReference(info, reg, arg, seen) {
				return true
			}
		}
	}
	return false
}

func typeContainsExternalImportReferenceInParts(info *fileInfo, reg *registry, parts []string, seen map[string]bool) bool {
	for _, part := range parts {
		if typeContainsExternalImportReference(info, reg, part, seen) {
			return true
		}
	}
	return false
}

func shouldUseTextTypeExpr(raw string) bool {
	name, _, ok := generic(strings.TrimSpace(trimParens(raw)))
	return ok && name == "FileUpload"
}

func typiaSourceNamedExpr(info *fileInfo, reg *registry, expr string, raw string) string {
	raw = strings.TrimSpace(trimParens(raw))
	if isIdentifierName(raw) {
		if _, _, _, ok := resolveAliasRef(info, reg, raw); ok {
			return withTypeName(expr, raw)
		}
		if ref, ok := info.imports[raw]; ok && isFoundationImportRef(ref) {
			return withTypeName(expr, raw)
		}
	}
	return expr
}

func cachedTypeExpr(info *fileInfo, reg *registry, raw string, node *shimast.Node, pos int, cached string) string {
	if strings.TrimSpace(cached) != "" {
		return cached
	}
	return typeExprForNode(info, reg, raw, node, pos)
}

func preferredWrapperTypeExprForNode(info *fileInfo, reg *registry, raw string, node *shimast.Node, pos int) (string, bool) {
	raw = strings.TrimSpace(trimParens(raw))
	if strings.HasSuffix(raw, "[]") {
		element := strings.TrimSpace(strings.TrimSuffix(raw, "[]"))
		return "{kind: 14, type: " + typeExprForNodePreferred(info, reg, element, nil, pos, true) + "}", true
	}
	name, args, ok := generic(raw)
	if !ok {
		return "", false
	}
	argExpr := func(index int) string {
		return preferredTypeArgExpr(info, reg, args, node, index, pos)
	}
	argRaw := func(index int) string {
		if index < len(args) {
			return args[index]
		}
		return "unknown"
	}
	argNode := func(index int) *shimast.Node {
		typeArgs := typeNodeArgs(node)
		if index < len(typeArgs) {
			return typeArgs[index]
		}
		return nil
	}

	switch name {
	case "Array", "ReadonlyArray":
		return "{kind: 14, type: " + argExpr(0) + "}", true
	case "Promise":
		return "{kind: 22, type: " + argExpr(0) + "}", true
	case "ApiResponse":
		body := argExpr(0)
		status := literalArg("200")
		if len(args) > 1 {
			status = literalArg(args[1])
		}
		return "{kind: 22, typeName: \"ApiResponse\", type: " + body + ", typeArguments: [" + body + ", " + status + "]}", true
	case "HttpBody":
		return httpMarkerTypePreferred(info, reg, "HttpBody", "httpBody", argRaw(0), argNode(0), "{}", nil, pos), true
	case "HttpQueries":
		return httpMarkerTypePreferred(info, reg, "HttpQueries", "httpQueries", argRaw(0), argNode(0), "{}", nil, pos), true
	case "HttpQuery":
		return httpMarkerTypePreferred(info, reg, "HttpQuery", "httpQuery", argRaw(0), argNode(0), optionArg(args, 1), argNode(1), pos), true
	case "HttpPath":
		return httpMarkerTypePreferred(info, reg, "HttpPath", "httpPath", argRaw(0), argNode(0), optionArg(args, 1), argNode(1), pos), true
	case "HttpHeader":
		return httpMarkerTypePreferred(info, reg, "HttpHeader", "httpHeader", argRaw(0), argNode(0), optionArg(args, 1), argNode(1), pos), true
	case "ApiType":
		if len(args) < 2 {
			return "{kind: 2, typeName: \"ApiType\"}", true
		}
		body := argExpr(1)
		marker := typeAnnotationMarker("ApiName", "openapi:name", literalArg(args[0]))
		return "{kind: 13, typeName: \"ApiType\", types: [" + body + ", " + marker + "]}", true
	case "Record":
		key := argExpr(0)
		value := argExpr(1)
		return "{kind: 18, typeName: \"Record\", utilityType: \"Record\", typeArguments: [" + key + ", " + value + "], index: " + value + ", types: []}", true
	default:
		return "", false
	}
}

func preferredTypeArgExpr(info *fileInfo, reg *registry, args []string, node *shimast.Node, index int, pos int) string {
	raw := "unknown"
	if index < len(args) {
		raw = args[index]
	}
	typeArgs := typeNodeArgs(node)
	var argNode *shimast.Node
	if index < len(typeArgs) {
		argNode = typeArgs[index]
	}
	return typeExprForNodePreferred(info, reg, raw, argNode, pos, true)
}

func typeNodeArgs(node *shimast.Node) []*shimast.Node {
	if node == nil {
		return nil
	}
	switch node.Kind {
	case shimast.KindTypeReference,
		shimast.KindExpressionWithTypeArguments,
		shimast.KindImportType,
		shimast.KindTypeQuery:
		return node.TypeArguments()
	default:
		return nil
	}
}

func httpMarkerTypePreferred(info *fileInfo, reg *registry, typeName string, annotation string, valueRaw string, valueNode *shimast.Node, optionsRaw string, optionsNode *shimast.Node, pos int) string {
	valueType := typeExprForNodePreferred(info, reg, valueRaw, valueNode, pos, true)
	value := annotationOptionsWithTypeExpr(info, reg, optionsRaw, optionsNode, valueRaw, valueType, pos)
	marker := typeAnnotationMarker(typeName, annotation, value)
	return "{kind: 13, typeName: " + quote(typeName) + ", types: [" + valueType + ", " + marker + "]}"
}

func annotationOptionsWithTypeExpr(info *fileInfo, reg *registry, optionsRaw string, optionsNode *shimast.Node, valueRaw string, valueType string, pos int) string {
	optionsRaw = strings.TrimSpace(optionsRaw)
	props := []string{}
	if optionsRaw != "" && optionsRaw != "{}" {
		if isObjectLiteralTypeText(optionsRaw) {
			ctx := &typeContext{seen: map[string]bool{}, pos: pos}
			body := strings.TrimSpace(optionsRaw[1 : len(optionsRaw)-1])
			props = append(props, objectLiteralProperties(info, reg, body, ctx)...)
		} else {
			ctx := &typeContext{seen: map[string]bool{}, pos: pos}
			_ = optionsNode
			return annotationValueExpr(info, reg, optionsRaw+" & { type: "+valueRaw+" }", ctx)
		}
	}
	props = append(props, "{kind: 20, name: \"type\", type: "+valueType+", optional: false}")
	return "{kind: 18, types: [" + strings.Join(props, ", ") + "]}"
}

func typiaTypeExprForNode(info *fileInfo, reg *registry, raw string, node *shimast.Node, pos int) (string, bool) {
	if reg == nil || reg.checker == nil || node == nil {
		return "", false
	}
	typ := reg.checker.GetTypeFromTypeNode(node)
	return typiaTypeExprFromType(info, reg, typ, pos, raw)
}

func shouldUseTypiaType(info *fileInfo, reg *registry, raw string) bool {
	return shouldUseTypiaTypeCtx(info, reg, raw, map[string]bool{})
}

func shouldUseTypiaTypeCtx(info *fileInfo, reg *registry, raw string, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	if raw == "" || isFunctionTypeSyntax(raw) {
		return false
	}
	key := info.moduleKey + "\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true
	defer delete(seen, key)

	if hasTypiaPreferredSyntax(raw) {
		return true
	}
	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		return shouldUseTypiaTypeInParts(info, reg, parts, seen)
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		return shouldUseTypiaTypeInParts(info, reg, parts, seen)
	}
	if strings.HasSuffix(raw, "[]") {
		return shouldUseTypiaTypeCtx(info, reg, strings.TrimSuffix(raw, "[]"), seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return shouldUseTypiaTypeInParts(info, reg, splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","), seen)
	}
	if isObjectLiteralTypeText(raw) {
		body := strings.TrimSpace(raw[1 : len(raw)-1])
		for _, prop := range propertiesFromBody(body) {
			if shouldUseTypiaTypeCtx(info, reg, prop.typeText, seen) {
				return true
			}
		}
		return false
	}
	if name, args, ok := generic(raw); ok {
		if alias, owner, _, ok := resolveAliasRef(info, reg, name); ok {
			if hasTypiaPreferredSyntax(alias.body) || shouldUseTypiaTypeCtx(owner, reg, alias.body, seen) {
				return true
			}
		}
		if ref, ok := info.imports[name]; ok && isFoundationImportRef(ref) {
			return true
		}
		for _, arg := range args {
			if shouldUseTypiaTypeCtx(info, reg, arg, seen) {
				return true
			}
		}
		return false
	}
	if isIdentifierName(raw) {
		if alias, owner, _, ok := resolveAliasRef(info, reg, raw); ok {
			return hasTypiaPreferredSyntax(alias.body) || shouldUseTypiaTypeCtx(owner, reg, alias.body, seen)
		}
		if ref, ok := info.imports[raw]; ok && isFoundationImportRef(ref) {
			return true
		}
	}
	return false
}

func shouldUseTypiaTypeInParts(info *fileInfo, reg *registry, parts []string, seen map[string]bool) bool {
	for _, part := range parts {
		if shouldUseTypiaTypeCtx(info, reg, part, seen) {
			return true
		}
	}
	return false
}

func hasTypiaPreferredSyntax(raw string) bool {
	raw = strings.TrimSpace(raw)
	compact := compactTypePattern(raw)
	if strings.Contains(raw, "typia.tag") ||
		strings.Contains(raw, "TypiaTagBase") ||
		strings.Contains(raw, "TypiaFormat") ||
		strings.Contains(raw, "TsfTypia") ||
		strings.Contains(raw, "TsfTypeTag") ||
		strings.Contains(raw, "TsfValidatorTag") ||
		strings.Contains(raw, "TsfDatabase") {
		return true
	}
	if strings.Contains(compact, "inkeyof") {
		return true
	}
	return strings.Contains(raw, " extends ") && strings.Contains(raw, " ? ") && strings.Contains(raw, " : ")
}

func canPreferTypiaType(info *fileInfo, reg *registry, raw string) bool {
	if typeContainsExternalImportReference(info, reg, raw, map[string]bool{}) {
		return false
	}
	return !hasFrameworkMetadataSyntaxDeep(info, reg, raw, map[string]bool{})
}

func canPreferTypiaTypeOnPreferredSurface(info *fileInfo, reg *registry, raw string) bool {
	return canPreferTypiaTypeOnPreferredSurfaceAt(info, reg, raw, 0)
}

func canPreferTypiaTypeOnPreferredSurfaceAt(info *fileInfo, reg *registry, raw string, pos int) bool {
	return !hasPreferredTypiaBlockerSyntaxDeep(info, reg, raw, true, pos, map[string]bool{})
}

func shouldPreferTypiaAliasMetadata(info *fileInfo, reg *registry, raw string, pos int) bool {
	raw = strings.TrimSpace(trimParens(raw))
	name, _, ok := generic(raw)
	if !ok {
		return false
	}
	ref, ok := info.imports[name]
	return ok && isFoundationImportRef(ref) && !isRootInternalMetadataName(name) && canPreferTypiaTypeOnPreferredSurfaceAt(info, reg, raw, pos)
}

func hasPreferredTypiaBlockerSyntaxDeep(info *fileInfo, reg *registry, raw string, root bool, pos int, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" || raw == "unknown" {
		return false
	}
	if isFunctionTypeSyntax(raw) {
		return true
	}
	if isPreferredTypiaHardBlockerName(raw) || (root && isRootInternalMetadataName(raw)) {
		return true
	}

	key := info.moduleKey + "\x00preferred\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true
	defer delete(seen, key)

	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		nonNullish := nonNullishTypeParts(parts)
		if len(nonNullish) > 1 && (hasLiteralUnionSyntax(nonNullish) || hasTaggedMetadataSyntaxInParts(info, reg, nonNullish, seen)) {
			return true
		}
		return hasPreferredTypiaBlockerSyntaxInParts(info, reg, parts, false, pos, seen)
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		if root && hasRootInternalMetadataIntersectionPart(parts) {
			return true
		}
		return hasPreferredTypiaBlockerSyntaxInParts(info, reg, parts, false, pos, seen)
	}
	if strings.HasSuffix(raw, "[]") {
		return hasPreferredTypiaBlockerSyntaxDeep(info, reg, strings.TrimSuffix(raw, "[]"), false, pos, seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return hasPreferredTypiaBlockerSyntaxInParts(info, reg, splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","), false, pos, seen)
	}
	if isObjectLiteralTypeText(raw) {
		body := strings.TrimSpace(raw[1 : len(raw)-1])
		for _, prop := range propertiesFromBody(body) {
			if hasPreferredTypiaBlockerSyntaxDeep(info, reg, prop.typeText, false, pos, seen) {
				return true
			}
		}
		if indexType, ok := indexSignatureType(body); ok {
			return hasPreferredTypiaBlockerSyntaxDeep(info, reg, indexType, false, pos, seen)
		}
		return false
	}
	if strings.Contains(raw, "[") || strings.Contains(raw, "]") {
		return false
	}
	if name, args, ok := generic(raw); ok {
		if (name == "Pattern" || name == "Validate") && (len(args) == 0 || !isLiteralStringType(args[0])) {
			return true
		}
		if name == "TsfValidatorTag" && len(args) > 0 && literalStringValue(args[0]) == "object" {
			return true
		}
		if isPreferredTypiaHardBlockerName(name) || (root && isRootInternalMetadataName(name)) {
			return true
		}
		if ref, ok := info.imports[name]; ok && isFoundationImportRef(ref) {
			return false
		}
		if isInternalUtilityObjectTypeName(name) {
			ctx := &typeContext{seen: map[string]bool{}}
			if props, owner, ok := utilityTypeProperties(info, reg, name, args, ctx); ok {
				for _, prop := range props {
					propOwner := owner
					if prop.owner != nil {
						propOwner = prop.owner
					}
					propPos := pos
					if prop.typeNode != nil {
						propPos = prop.typeNode.Pos()
					}
					if hasPreferredTypiaBlockerSyntaxDeep(propOwner, reg, prop.typeText, false, propPos, seen) {
						return true
					}
				}
				return false
			}
		}
		if alias, owner, _, ok := resolveAliasRef(info, reg, name); ok {
			body := alias.body
			for i := range alias.params {
				body = replaceTypeParameter(body, aliasParamName(alias, i), aliasArg(alias, args, i))
			}
			if hasPreferredTypiaBlockerSyntaxDeep(owner, reg, body, root, alias.pos, seen) {
				return true
			}
		}
		for i, arg := range args {
			if (name == "Pick" || name == "Omit") && i > 0 {
				continue
			}
			if hasPreferredTypiaBlockerSyntaxDeep(info, reg, arg, false, pos, seen) {
				return true
			}
		}
		return false
	}
	if isIdentifierName(raw) {
		if alias, owner, _, ok := resolveAliasRef(info, reg, raw); ok {
			return hasPreferredTypiaBlockerSyntaxDeep(owner, reg, alias.body, root, alias.pos, seen)
		}
		if decl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, raw, pos); ok {
			body := interfaceFullBody(owner, reg, decl, map[string]bool{})
			return hasPreferredTypiaBlockerSyntaxDeep(owner, reg, "{"+body+"}", false, decl.pos, seen)
		}
		if class, owner, ok := resolveClassRefAt(info, reg, raw, pos); ok {
			for _, prop := range class.properties {
				propPos := pos
				if prop.typeNode != nil {
					propPos = prop.typeNode.Pos()
				}
				if hasPreferredTypiaBlockerSyntaxDeep(owner, reg, prop.typeText, false, propPos, seen) {
					return true
				}
			}
		}
	}
	return false
}

func isInternalUtilityObjectTypeName(name string) bool {
	switch name {
	case "Pick", "Omit", "Partial", "Required":
		return true
	default:
		return false
	}
}

func hasPreferredTypiaBlockerSyntaxInParts(info *fileInfo, reg *registry, parts []string, root bool, pos int, seen map[string]bool) bool {
	for _, part := range parts {
		if hasPreferredTypiaBlockerSyntaxDeep(info, reg, part, root, pos, seen) {
			return true
		}
	}
	return false
}

func nonNullishTypeParts(parts []string) []string {
	out := []string{}
	for _, part := range parts {
		part = strings.TrimSpace(trimParens(part))
		if part == "" || part == "null" || part == "undefined" {
			continue
		}
		out = append(out, part)
	}
	return out
}

func hasRootInternalMetadataIntersectionPart(parts []string) bool {
	for _, part := range parts {
		name := strings.TrimSpace(trimParens(part))
		if genericName, _, ok := generic(name); ok {
			name = genericName
		}
		if isRootInternalMetadataName(name) {
			return true
		}
	}
	return false
}

func isPreferredTypiaHardBlockerName(name string) bool {
	switch strings.TrimSpace(name) {
	case "FileUpload":
		return true
	default:
		return false
	}
}

func isRootInternalMetadataName(name string) bool {
	switch strings.TrimSpace(name) {
	case "TypeAnnotation",
		"ApiName",
		"ApiType",
		"HttpBody",
		"HttpQueries",
		"HttpQuery",
		"HttpPath",
		"HttpHeader",
		"HttpRequest",
		"HttpRequestStream",
		"HttpResponse",
		"ParsedJwt",
		"JWT",
		"RawResponseResult",
		"Redirect",
		"OkResponse",
		"EmptyResponse",
		"TsfDatabaseFieldTag",
		"TsfDatabaseTag",
		"DatabaseField",
		"MySQL",
		"Reference",
		"Index",
		"Unique",
		"PrimaryKey",
		"AutoIncrement":
		return true
	default:
		return false
	}
}

func hasFrameworkMetadataSyntaxDeep(info *fileInfo, reg *registry, raw string, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" || raw == "unknown" {
		return false
	}
	if isFunctionTypeSyntax(raw) {
		return true
	}
	if isFrameworkMetadataName(raw) {
		return true
	}

	key := info.moduleKey + "\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true
	defer delete(seen, key)

	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		if hasLiteralUnionSyntax(parts) {
			return true
		}
		if hasTaggedMetadataSyntaxInParts(info, reg, parts, seen) {
			return true
		}
		return hasFrameworkMetadataSyntaxInParts(info, reg, parts, seen)
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		return hasFrameworkMetadataSyntaxInParts(info, reg, parts, seen)
	}
	if name, args, ok := generic(raw); ok {
		if (name == "Pattern" || name == "Validate") && (len(args) == 0 || !isLiteralStringType(args[0])) {
			return true
		}
		if isFrameworkMetadataName(name) {
			return true
		}
	}
	if hasTypiaPreferredSyntax(raw) {
		return false
	}
	if strings.HasSuffix(raw, "[]") {
		return hasFrameworkMetadataSyntaxDeep(info, reg, strings.TrimSuffix(raw, "[]"), seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return hasFrameworkMetadataSyntaxInParts(info, reg, splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","), seen)
	}
	if strings.Contains(raw, "[") || strings.Contains(raw, "]") {
		return true
	}
	if isObjectLiteralTypeText(raw) {
		body := strings.TrimSpace(raw[1 : len(raw)-1])
		for _, prop := range propertiesFromBody(body) {
			if hasFrameworkMetadataSyntaxDeep(info, reg, prop.typeText, seen) {
				return true
			}
		}
		return false
	}
	if name, args, ok := generic(raw); ok {
		if (name == "Pattern" || name == "Validate") && (len(args) == 0 || !isLiteralStringType(args[0])) {
			return true
		}
		if isFrameworkMetadataName(name) {
			return true
		}
		if alias, owner, _, ok := resolveAliasRef(info, reg, name); ok {
			body := alias.body
			for i := range alias.params {
				body = replaceTypeParameter(body, aliasParamName(alias, i), aliasArg(alias, args, i))
			}
			if hasFrameworkMetadataSyntaxDeep(owner, reg, body, seen) {
				return true
			}
		}
		for i, arg := range args {
			if (name == "Pick" || name == "Omit") && i > 0 {
				continue
			}
			if hasFrameworkMetadataSyntaxDeep(info, reg, arg, seen) {
				return true
			}
		}
		return false
	}
	if isIdentifierName(raw) {
		if isFoundationTypeIdentifier(info, raw) {
			return true
		}
		if alias, owner, _, ok := resolveAliasRef(info, reg, raw); ok {
			return hasFrameworkMetadataSyntaxDeep(owner, reg, alias.body, seen)
		}
		if decl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, raw, 0); ok {
			body := interfaceFullBody(owner, reg, decl, map[string]bool{})
			return hasFrameworkMetadataSyntaxDeep(owner, reg, "{"+body+"}", seen)
		}
		if class, owner, ok := resolveClassRefAt(info, reg, raw, 0); ok {
			for _, prop := range class.properties {
				if hasFrameworkMetadataSyntaxDeep(owner, reg, prop.typeText, seen) {
					return true
				}
			}
		}
	}
	return false
}

func hasTaggedMetadataSyntaxInParts(info *fileInfo, reg *registry, parts []string, seen map[string]bool) bool {
	for _, part := range parts {
		part = strings.TrimSpace(trimParens(part))
		if part == "null" || part == "undefined" {
			continue
		}
		if hasTaggedMetadataSyntaxDeep(info, reg, part, seen) {
			return true
		}
	}
	return false
}

func hasTaggedMetadataSyntaxDeep(info *fileInfo, reg *registry, raw string, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" || raw == "unknown" {
		return false
	}
	if hasTypiaPreferredSyntax(raw) || isFrameworkMetadataName(raw) {
		return true
	}
	key := info.moduleKey + "\x00tagged\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true
	defer delete(seen, key)

	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		return hasTaggedMetadataSyntaxInParts(info, reg, parts, seen)
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		return hasTaggedMetadataSyntaxInParts(info, reg, parts, seen)
	}
	if strings.HasSuffix(raw, "[]") {
		return hasTaggedMetadataSyntaxDeep(info, reg, strings.TrimSuffix(raw, "[]"), seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return hasTaggedMetadataSyntaxInParts(info, reg, splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","), seen)
	}
	if isObjectLiteralTypeText(raw) {
		body := strings.TrimSpace(raw[1 : len(raw)-1])
		for _, prop := range propertiesFromBody(body) {
			if hasTaggedMetadataSyntaxDeep(info, reg, prop.typeText, seen) {
				return true
			}
		}
		return false
	}
	if name, args, ok := generic(raw); ok {
		if alias, owner, _, ok := resolveAliasRef(info, reg, name); ok {
			body := alias.body
			for i := range alias.params {
				body = replaceTypeParameter(body, aliasParamName(alias, i), aliasArg(alias, args, i))
			}
			if hasTaggedMetadataSyntaxDeep(owner, reg, body, seen) {
				return true
			}
		}
		for _, arg := range args {
			if hasTaggedMetadataSyntaxDeep(info, reg, arg, seen) {
				return true
			}
		}
		return false
	}
	if isIdentifierName(raw) {
		if alias, owner, _, ok := resolveAliasRef(info, reg, raw); ok {
			return hasTaggedMetadataSyntaxDeep(owner, reg, alias.body, seen)
		}
		if decl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, raw, 0); ok {
			body := interfaceFullBody(owner, reg, decl, map[string]bool{})
			return hasTaggedMetadataSyntaxDeep(owner, reg, "{"+body+"}", seen)
		}
		if class, owner, ok := resolveClassRefAt(info, reg, raw, 0); ok {
			for _, prop := range class.properties {
				if hasTaggedMetadataSyntaxDeep(owner, reg, prop.typeText, seen) {
					return true
				}
			}
		}
	}
	return false
}

func hasFrameworkMetadataSyntaxInParts(info *fileInfo, reg *registry, parts []string, seen map[string]bool) bool {
	for _, part := range parts {
		if hasFrameworkMetadataSyntaxDeep(info, reg, part, seen) {
			return true
		}
	}
	return false
}

func hasLiteralUnionSyntax(parts []string) bool {
	for _, part := range parts {
		part = strings.TrimSpace(trimParens(part))
		if strings.HasPrefix(part, "\"") ||
			strings.HasPrefix(part, "'") ||
			part == "true" ||
			part == "false" {
			return true
		}
		if _, err := strconv.ParseFloat(part, 64); err == nil {
			return true
		}
	}
	return false
}

func isFrameworkMetadataName(name string) bool {
	switch strings.TrimSpace(name) {
	case "TypeAnnotation",
		"ApiName",
		"ApiType",
		"HttpBody",
		"HttpQueries",
		"HttpQuery",
		"HttpPath",
		"HttpHeader",
		"HttpRequest",
		"HttpRequestStream",
		"HttpResponse",
		"ParsedJwt",
		"JWT",
		"FileUpload",
		"RawResponseResult",
		"Redirect",
		"OkResponse",
		"EmptyResponse",
		"Indexed",
		"TsfDatabaseFieldTag",
		"TsfDatabaseTag",
		"DatabaseField",
		"MySQL",
		"Reference",
		"Index",
		"Unique",
		"PrimaryKey",
		"AutoIncrement",
		"Date",
		"ValidDate":
		return true
	default:
		return false
	}
}

func typiaTypeExprFromType(info *fileInfo, reg *registry, typ *shimchecker.Type, pos int, raw string) (string, bool) {
	if typ == nil || typ.IsTypeParameter() {
		return "", false
	}
	if reg.typiaCache == nil {
		reg.typiaCache = map[typiaCacheKey]string{}
	}
	if reg.typiaFailures == nil {
		reg.typiaFailures = map[*shimchecker.Type]bool{}
	}
	cacheKey := typiaCacheKey{typ: typ, moduleKey: info.moduleKey, raw: strings.TrimSpace(raw), pos: pos}
	if expr, ok := reg.typiaCache[cacheKey]; ok {
		return expr, true
	}
	if reg.typiaFailures[typ] {
		return "", false
	}
	components := schemametadata.NewMetadataCollection()
	result := typiafactories.MetadataFactory.Analyze(typiafactories.MetadataFactory_IProps{
		Checker: reg.checker,
		Options: typiafactories.MetadataFactory_IOptions{
			Absorb:   true,
			Constant: true,
			Escape:   true,
		},
		Components: components,
		Type:       typ,
	})
	if !result.Success || result.Data == nil {
		reg.typiaFailures[typ] = true
		return "", false
	}
	expr := typiaMetadataExpr(info, reg, result.Data, true, newTypiaRenderStateForSource(pos, raw))
	reg.typiaCache[cacheKey] = expr
	return expr, true
}

type typiaRenderState struct {
	metadata  map[*schemametadata.MetadataSchema]bool
	aliases   map[*schemametadata.MetadataAliasType]bool
	arrays    map[*schemametadata.MetadataArrayType]bool
	tuples    map[*schemametadata.MetadataTupleType]bool
	objects   map[*schemametadata.MetadataObjectType]bool
	pos       int
	sourceRaw string
}

func newTypiaRenderState(pos ...int) *typiaRenderState {
	state := &typiaRenderState{
		metadata: map[*schemametadata.MetadataSchema]bool{},
		aliases:  map[*schemametadata.MetadataAliasType]bool{},
		arrays:   map[*schemametadata.MetadataArrayType]bool{},
		tuples:   map[*schemametadata.MetadataTupleType]bool{},
		objects:  map[*schemametadata.MetadataObjectType]bool{},
	}
	if len(pos) > 0 {
		state.pos = pos[0]
	}
	return state
}

func newTypiaRenderStateForSource(pos int, sourceRaw string) *typiaRenderState {
	state := newTypiaRenderState(pos)
	state.sourceRaw = sourceRaw
	return state
}

func typiaMetadataExpr(info *fileInfo, reg *registry, meta *schemametadata.MetadataSchema, includeOptional bool, state *typiaRenderState) string {
	if meta == nil {
		return "{kind: 2}"
	}
	if state == nil {
		state = newTypiaRenderState()
	}
	if state.metadata[meta] {
		return "{kind: 2, typeName: " + quote(meta.GetDisplayName()) + "}"
	}
	state.metadata[meta] = true
	defer delete(state.metadata, meta)

	types := []string{}
	if meta.Any {
		types = append(types, "{kind: 1}")
	}
	if meta.Escaped != nil && meta.Escaped.Returns != nil {
		types = append(types, typiaMetadataExpr(info, reg, meta.Escaped.Returns, includeOptional, state))
	}
	if meta.Rest != nil {
		types = append(types, "{kind: 14, type: "+typiaMetadataExpr(info, reg, meta.Rest, true, state)+"}")
	}
	for _, atomic := range meta.Atomics {
		if expr, ok := typiaAtomicExpr(atomic); ok {
			types = append(types, expr)
		}
	}
	for _, constant := range meta.Constants {
		for _, value := range constant.Values {
			if value != nil {
				types = append(types, typiaTaggedExpr("{kind: 10, literal: "+typiaLiteralExpr(value.Value)+"}", value.Tags))
			}
		}
	}
	for _, template := range meta.Templates {
		if template != nil {
			types = append(types, typiaTaggedExpr("{kind: 23, typeName: "+quote(template.GetName())+"}", template.Tags))
		}
	}
	for _, array := range meta.Arrays {
		types = append(types, typiaArrayExpr(info, reg, array, state))
	}
	for _, tuple := range meta.Tuples {
		types = append(types, typiaTupleExpr(info, reg, tuple, state))
	}
	for _, object := range meta.Objects {
		types = append(types, typiaObjectExpr(info, reg, object, state))
	}
	for _, alias := range meta.Aliases {
		types = append(types, typiaAliasExpr(info, reg, alias, state))
	}
	for _, native := range meta.Natives {
		types = append(types, typiaNativeExpr(info, reg, native))
	}
	for range meta.Functions {
		types = append(types, "{kind: 21}")
	}
	for _, set := range meta.Sets {
		if set != nil && set.Value != nil {
			types = append(types, typiaTaggedExpr("{kind: 2, typeName: \"Set\", typeArguments: ["+typiaMetadataExpr(info, reg, set.Value, true, state)+"]}", set.Tags))
		}
	}
	for _, m := range meta.Maps {
		if m != nil {
			key := "{kind: 2}"
			value := "{kind: 2}"
			if m.Key != nil {
				key = typiaMetadataExpr(info, reg, m.Key, true, state)
			}
			if m.Value != nil {
				value = typiaMetadataExpr(info, reg, m.Value, true, state)
			}
			types = append(types, typiaTaggedExpr("{kind: 2, typeName: \"Map\", typeArguments: ["+key+", "+value+"]}", m.Tags))
		}
	}
	if meta.Nullable {
		types = append(types, "{kind: 5}")
	}
	if includeOptional && !meta.IsRequired() {
		types = append(types, "{kind: 4}")
	}
	if len(types) == 0 {
		if meta.Empty() && meta.Required && !meta.Nullable && !meta.Optional {
			return "{kind: 0}"
		}
		return "{kind: 2, typeName: " + quote(meta.GetDisplayName()) + "}"
	}
	return typiaUnionExpr(types)
}

func typiaAtomicExpr(atomic *schemametadata.MetadataAtomic) (string, bool) {
	if atomic == nil {
		return "", false
	}
	switch atomic.Type {
	case "string":
		return typiaTaggedExpr("{kind: 6}", atomic.Tags), true
	case "number":
		return typiaTaggedExpr("{kind: 7}", atomic.Tags), true
	case "boolean":
		return typiaTaggedExpr("{kind: 8}", atomic.Tags), true
	case "bigint":
		return typiaTaggedExpr("{kind: 9}", atomic.Tags), true
	default:
		return typiaTaggedExpr("{kind: 2, typeName: "+quote(atomic.GetName())+"}", atomic.Tags), true
	}
}

func typiaArrayExpr(info *fileInfo, reg *registry, array *schemametadata.MetadataArray, state *typiaRenderState) string {
	if array == nil || array.Type == nil {
		return "{kind: 14, type: {kind: 2}}"
	}
	if state.arrays[array.Type] {
		return "{kind: 14, type: {kind: 2}}"
	}
	state.arrays[array.Type] = true
	defer delete(state.arrays, array.Type)

	value := "{kind: 2}"
	if array.Type.Value != nil {
		value = typiaMetadataExpr(info, reg, array.Type.Value, true, state)
	}
	return typiaTaggedExpr("{kind: 14, type: "+value+"}", array.Tags)
}

func typiaTupleExpr(info *fileInfo, reg *registry, tuple *schemametadata.MetadataTuple, state *typiaRenderState) string {
	if tuple == nil || tuple.Type == nil {
		return "{kind: 15, types: []}"
	}
	if state.tuples[tuple.Type] {
		return "{kind: 15, typeName: " + quote(tuple.Type.GetDisplayName()) + ", types: []}"
	}
	state.tuples[tuple.Type] = true
	defer delete(state.tuples, tuple.Type)

	items := []string{}
	for _, element := range tuple.Type.Elements {
		items = append(items, "{type: "+typiaMetadataExpr(info, reg, element, true, state)+"}")
	}
	return typiaTaggedExpr("{kind: 15, typeName: "+quote(tuple.Type.GetDisplayName())+", types: ["+strings.Join(items, ", ")+"]}", tuple.Tags)
}

func typiaObjectExpr(info *fileInfo, reg *registry, object *schemametadata.MetadataObject, state *typiaRenderState) string {
	if object == nil || object.Type == nil {
		return "{kind: 18, types: []}"
	}
	obj := object.Type
	name, named := typiaObjectTypeName(info, reg, obj, state.pos)
	if named {
		if expr, ok := typiaNamedObjectInternalOverrideExpr(info, reg, name, state.pos); ok {
			return typiaTaggedExpr(expr, object.Tags)
		}
	}
	if obj.IsClass && isIdentifierName(obj.Name) {
		runtimeName := obj.Name
		if obj.ValueRef != "" {
			runtimeName = obj.ValueRef
		}
		return typiaTaggedExpr("{kind: 16, typeName: "+quote(name)+", classType: () => "+runtimeValueExpr(info, reg, runtimeName)+"}", object.Tags)
	}
	if state.objects[obj] {
		if named {
			return "{kind: 18, typeName: " + quote(name) + ", types: []}"
		}
		return "{kind: 18, types: []}"
	}
	state.objects[obj] = true
	defer delete(state.objects, obj)

	properties := []string{}
	indexExpr := ""
	for _, prop := range obj.Properties {
		if prop == nil || prop.Key == nil || prop.Value == nil {
			continue
		}
		if expr, ok := typiaIndexPropertyExpr(info, reg, prop, state); ok {
			if indexExpr == "" {
				indexExpr = expr
			}
			continue
		}
		propName := typiaPropertyName(prop)
		if propName == "" {
			continue
		}
		optional := !prop.Value.IsRequired()
		valueExpr := typiaMetadataExpr(info, reg, prop.Value, true, state)
		overrideSources := []string{name}
		if display := strings.TrimSpace(obj.GetDisplayName()); display != "" && display != name {
			overrideSources = append(overrideSources, display)
		}
		overrideSources = append(overrideSources, state.sourceRaw)
		if override, ok := typiaSourcePropertyOverrideExpr(info, reg, "", propName, state.pos, overrideSources...); ok {
			valueExpr = override
		}
		properties = append(properties, "{kind: 20, name: "+quote(propName)+", type: "+valueExpr+", optional: "+boolLit(optional)+"}")
	}
	items := []string{"kind: 18"}
	if named {
		items = append(items, "typeName: "+quote(name))
	}
	if indexExpr != "" {
		items = append(items, "index: "+indexExpr)
	}
	items = append(items, "types: ["+strings.Join(properties, ", ")+"]")
	return typiaTaggedExpr("{"+strings.Join(items, ", ")+"}", object.Tags)
}

func typiaNamedObjectInternalOverrideExpr(info *fileInfo, reg *registry, name string, pos int) (string, bool) {
	name = strings.TrimSpace(name)
	if !isIdentifierName(name) {
		return "", false
	}
	internalExpr := typeExprCtx(info, reg, name, &typeContext{seen: map[string]bool{}, pos: pos})
	if decl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, name, pos); ok {
		if sourcePropertiesNeedInternalObjectMetadata(owner, reg, interfaceFullProperties(owner, reg, decl, map[string]bool{}), pos) {
			return internalExpr, true
		}
	}
	if alias, owner, _, ok := resolveAliasRef(info, reg, name); ok && len(alias.params) == 0 {
		if sourceObjectTextNeedsInternalObjectMetadata(owner, reg, alias.body, pos) {
			return internalExpr, true
		}
	}
	if isResolvedInternalNamedObjectExpr(internalExpr, name) && internalObjectExprCarriesSourceMetadata(internalExpr) {
		return internalExpr, true
	}
	return "", false
}

func isResolvedInternalNamedObjectExpr(expr string, name string) bool {
	expr = strings.TrimSpace(expr)
	return strings.Contains(expr, "kind: 18") &&
		strings.Contains(expr, "typeName: "+quote(name)) &&
		!isUnresolvedInternalTypeExpr(expr, name)
}

func internalObjectExprCarriesSourceMetadata(expr string) bool {
	return strings.Contains(expr, "literal:") ||
		strings.Contains(expr, "classType: () => Date") ||
		strings.Contains(expr, "annotations:")
}

func sourceObjectTextNeedsInternalObjectMetadata(info *fileInfo, reg *registry, raw string, pos int) bool {
	raw = strings.TrimSpace(trimParens(raw))
	if isObjectLiteralTypeText(raw) {
		return sourcePropertiesNeedInternalObjectMetadata(info, reg, propertiesFromBody(strings.TrimSpace(raw[1:len(raw)-1])), pos)
	}
	return sourceTypeContainsIndexedAccessSyntax(raw, map[string]bool{})
}

func sourcePropertiesNeedInternalObjectMetadata(info *fileInfo, reg *registry, props []utilityProperty, pos int) bool {
	for _, prop := range props {
		if sourceTypeContainsIndexedAccessSyntax(prop.typeText, map[string]bool{}) {
			return true
		}
		if sourceTypeNeedsInternalPropertyMetadata(info, reg, prop.typeText, &typeContext{seen: map[string]bool{}, pos: pos}, map[string]bool{}) {
			return true
		}
	}
	return false
}

func typiaObjectTypeName(info *fileInfo, reg *registry, obj *schemametadata.MetadataObjectType, pos int) (string, bool) {
	name := strings.TrimSpace(obj.GetDisplayName())
	if name == "" || isAnonymousTypiaObjectName(name) {
		return "", false
	}
	if obj.IsClass && isIdentifierName(obj.Name) {
		return name, true
	}
	if genericName, _, ok := generic(name); ok && isIdentifierName(genericName) {
		return name, true
	}
	if isIdentifierName(name) || typiaObjectNameIsDeclared(info, reg, name, pos) || typiaObjectNameIsUtilityDisplay(name) {
		return name, true
	}
	if obj.DisplayName != "" {
		return "", false
	}
	rawName := strings.TrimSpace(obj.Name)
	if rawName != "" && rawName != name && typiaObjectNameIsDeclared(info, reg, rawName, pos) {
		return name, true
	}
	return "", false
}

func isAnonymousTypiaObjectName(name string) bool {
	name = strings.TrimSpace(name)
	return name == "" || strings.HasPrefix(name, "{") || strings.HasPrefix(name, "__")
}

func typiaObjectNameIsDeclared(info *fileInfo, reg *registry, name string, pos int) bool {
	if !isIdentifierName(name) {
		return false
	}
	if _, _, _, ok := resolveAliasRef(info, reg, name); ok {
		return true
	}
	if _, _, _, ok := resolveInterfaceDeclRefAt(info, reg, name, pos); ok {
		return true
	}
	if _, _, ok := resolveClassRefAt(info, reg, name, pos); ok {
		return true
	}
	if ref, ok := info.imports[name]; ok {
		return isFoundationImportRef(ref)
	}
	return false
}

func typiaObjectNameIsUtilityDisplay(name string) bool {
	if genericName, _, ok := generic(name); ok {
		name = genericName
	}
	switch strings.TrimSpace(name) {
	case "Pick", "Omit", "Partial", "Required", "Readonly", "OptionalNulls", "Record":
		return true
	default:
		return false
	}
}

func typiaSourcePropertyOverrideExpr(info *fileInfo, reg *registry, sourceName string, propName string, pos int, alternateSources ...string) (string, bool) {
	sourceName = strings.TrimSpace(sourceName)
	propName = strings.TrimSpace(propName)
	if propName == "" {
		return "", false
	}
	sources := []string{sourceName}
	sources = append(sources, alternateSources...)
	for _, source := range sources {
		source = strings.TrimSpace(source)
		if source == "" {
			continue
		}
		ctx := &typeContext{seen: map[string]bool{}, pos: pos}
		propType, owner, ok := propertyTypeText(info, reg, source, propName, ctx)
		if !ok {
			continue
		}
		propType = strings.TrimSpace(propType)
		valueExpr := typeExprCtx(owner, reg, propType, &typeContext{seen: map[string]bool{}, pos: pos})
		if sourceTypeContainsIndexedAccessSyntax(propType, map[string]bool{}) && !isUnresolvedInternalTypeExpr(valueExpr, propType) {
			return valueExpr, true
		}
		if !sourceTypeNeedsInternalPropertyMetadata(owner, reg, propType, &typeContext{seen: map[string]bool{}, pos: pos}, map[string]bool{}) &&
			!typeContainsAliasReference(owner, reg, propType, map[string]bool{}) {
			continue
		}
		return valueExpr, true
	}
	return "", false
}

func isUnresolvedInternalTypeExpr(expr string, raw string) bool {
	return strings.TrimSpace(expr) == "{kind: 2, typeName: "+quote(strings.TrimSpace(raw))+"}"
}

func sourceTypeContainsIndexedAccessSyntax(raw string, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" {
		return false
	}
	key := raw
	if seen[key] {
		return false
	}
	seen[key] = true

	if _, _, ok := trailingIndexedAccess(raw); ok {
		return true
	}
	for _, sep := range []string{"|", "&"} {
		if parts := nonEmptyParts(splitTop(raw, sep)); len(parts) > 1 {
			for _, part := range parts {
				if sourceTypeContainsIndexedAccessSyntax(part, seen) {
					return true
				}
			}
			return false
		}
	}
	if strings.HasSuffix(raw, "[]") {
		return sourceTypeContainsIndexedAccessSyntax(strings.TrimSuffix(raw, "[]"), seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		for _, part := range splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ",") {
			if sourceTypeContainsIndexedAccessSyntax(part, seen) {
				return true
			}
		}
		return false
	}
	if isObjectLiteralTypeText(raw) {
		for _, prop := range propertiesFromBody(strings.TrimSpace(raw[1 : len(raw)-1])) {
			if sourceTypeContainsIndexedAccessSyntax(prop.typeText, seen) {
				return true
			}
		}
		return false
	}
	if _, args, ok := generic(raw); ok {
		for _, arg := range args {
			if sourceTypeContainsIndexedAccessSyntax(arg, seen) {
				return true
			}
		}
	}
	return false
}

func sourceTypeNeedsInternalPropertyMetadata(info *fileInfo, reg *registry, raw string, ctx *typeContext, seen map[string]bool) bool {
	return sourceTypeContainsDateType(info, reg, raw, ctx, seen) ||
		sourceTypeContainsOrderedLiteralUnion(info, reg, raw, ctx, map[string]bool{}) ||
		typeContainsExternalImportReference(info, reg, raw, map[string]bool{}) ||
		sourceTypeContainsInternalMetadata(info, reg, raw, ctx, map[string]bool{})
}

func sourceTypeContainsOrderedLiteralUnion(info *fileInfo, reg *registry, raw string, ctx *typeContext, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" {
		return false
	}
	if isIdentifierName(raw) && isFoundationTypeIdentifier(info, raw) {
		return true
	}
	if ctx == nil {
		ctx = &typeContext{seen: map[string]bool{}}
	}
	key := info.moduleKey + "\x00literal-union-source\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true

	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		nonNullish := nonNullishTypeParts(parts)
		if len(nonNullish) > 1 && hasLiteralUnionSyntax(nonNullish) {
			return true
		}
		return sourcePartsContainOrderedLiteralUnion(info, reg, parts, ctx, seen)
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		return sourcePartsContainOrderedLiteralUnion(info, reg, parts, ctx, seen)
	}
	if strings.HasSuffix(raw, "[]") {
		return sourceTypeContainsOrderedLiteralUnion(info, reg, strings.TrimSuffix(raw, "[]"), ctx, seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return sourcePartsContainOrderedLiteralUnion(info, reg, splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","), ctx, seen)
	}
	if isObjectLiteralTypeText(raw) {
		for _, prop := range propertiesFromBody(strings.TrimSpace(raw[1 : len(raw)-1])) {
			if sourceTypeContainsOrderedLiteralUnion(info, reg, prop.typeText, ctx, seen) {
				return true
			}
		}
		return false
	}
	if name, args, ok := generic(raw); ok {
		for i, arg := range args {
			if (name == "Pick" || name == "Omit") && i > 0 {
				continue
			}
			if sourceTypeContainsOrderedLiteralUnion(info, reg, arg, ctx, seen) {
				return true
			}
		}
	}
	if resolved, owner, ok := resolveTypeText(info, reg, raw, ctx); ok && strings.TrimSpace(resolved) != raw {
		return sourceTypeContainsOrderedLiteralUnion(owner, reg, resolved, ctx, seen)
	}
	return false
}

func sourcePartsContainOrderedLiteralUnion(info *fileInfo, reg *registry, parts []string, ctx *typeContext, seen map[string]bool) bool {
	for _, part := range parts {
		if sourceTypeContainsOrderedLiteralUnion(info, reg, part, ctx, seen) {
			return true
		}
	}
	return false
}

func sourceTypeContainsInternalMetadata(info *fileInfo, reg *registry, raw string, ctx *typeContext, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" {
		return false
	}
	if ctx == nil {
		ctx = &typeContext{seen: map[string]bool{}}
	}
	key := info.moduleKey + "\x00internal-metadata-source\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true

	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		return sourcePartsContainInternalMetadata(info, reg, parts, ctx, seen)
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		return sourcePartsContainInternalMetadata(info, reg, parts, ctx, seen)
	}
	if strings.HasSuffix(raw, "[]") {
		return sourceTypeContainsInternalMetadata(info, reg, strings.TrimSuffix(raw, "[]"), ctx, seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return sourcePartsContainInternalMetadata(info, reg, splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","), ctx, seen)
	}
	if isObjectLiteralTypeText(raw) {
		for _, prop := range propertiesFromBody(strings.TrimSpace(raw[1 : len(raw)-1])) {
			if sourceTypeContainsInternalMetadata(info, reg, prop.typeText, ctx, seen) {
				return true
			}
		}
		return false
	}
	if name, args, ok := generic(raw); ok {
		if isInternalPropertyMetadataName(name) || isInternalPropertyMetadataTypiaTag(name, args) {
			return true
		}
		for i, arg := range args {
			if (name == "Pick" || name == "Omit") && i > 0 {
				continue
			}
			if sourceTypeContainsInternalMetadata(info, reg, arg, ctx, seen) {
				return true
			}
		}
	}
	if resolved, owner, ok := resolveTypeText(info, reg, raw, ctx); ok && strings.TrimSpace(resolved) != raw {
		return sourceTypeContainsInternalMetadata(owner, reg, resolved, ctx, seen)
	}
	return false
}

func sourcePartsContainInternalMetadata(info *fileInfo, reg *registry, parts []string, ctx *typeContext, seen map[string]bool) bool {
	for _, part := range parts {
		if sourceTypeContainsInternalMetadata(info, reg, part, ctx, seen) {
			return true
		}
	}
	return false
}

func isInternalPropertyMetadataName(name string) bool {
	switch strings.TrimSpace(name) {
	case "TypeAnnotation",
		"ApiName",
		"ApiType",
		"TsfDatabaseFieldTag",
		"TsfDatabaseTag",
		"DatabaseField",
		"MySQL":
		return true
	default:
		return false
	}
}

func isInternalPropertyMetadataTypiaTag(name string, args []string) bool {
	name = strings.TrimSpace(name)
	if name == "Validate" {
		return true
	}
	if name == "TsfValidatorTag" && len(args) > 0 && literalStringValue(args[0]) == "object" {
		return true
	}
	return false
}

func sourceTypeContainsDateType(info *fileInfo, reg *registry, raw string, ctx *typeContext, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" {
		return false
	}
	if raw == "Date" || (raw == "ValidDate" && isFoundationTypeIdentifier(info, raw)) {
		return true
	}
	if ctx == nil {
		ctx = &typeContext{seen: map[string]bool{}}
	}
	key := info.moduleKey + "\x00date-source\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true

	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		return sourcePartsContainDateType(info, reg, parts, ctx, seen)
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		return sourcePartsContainDateType(info, reg, parts, ctx, seen)
	}
	if strings.HasSuffix(raw, "[]") {
		return sourceTypeContainsDateType(info, reg, strings.TrimSuffix(raw, "[]"), ctx, seen)
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return sourcePartsContainDateType(info, reg, splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ","), ctx, seen)
	}
	if isObjectLiteralTypeText(raw) {
		for _, prop := range propertiesFromBody(strings.TrimSpace(raw[1 : len(raw)-1])) {
			if sourceTypeContainsDateType(info, reg, prop.typeText, ctx, seen) {
				return true
			}
		}
		return false
	}
	if name, args, ok := generic(raw); ok {
		if name == "Date" {
			return true
		}
		for _, arg := range args {
			if sourceTypeContainsDateType(info, reg, arg, ctx, seen) {
				return true
			}
		}
	}
	if resolved, owner, ok := resolveTypeText(info, reg, raw, ctx); ok && strings.TrimSpace(resolved) != raw {
		return sourceTypeContainsDateType(owner, reg, resolved, ctx, seen)
	}
	return false
}

func sourceTypeIsDateRootType(info *fileInfo, reg *registry, raw string, ctx *typeContext, seen map[string]bool) bool {
	raw = strings.TrimSpace(trimParens(raw))
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" {
		return false
	}
	if raw == "Date" || (raw == "ValidDate" && isFoundationTypeIdentifier(info, raw)) {
		return true
	}
	if ctx == nil {
		ctx = &typeContext{seen: map[string]bool{}}
	}
	key := info.moduleKey + "\x00date-root\x00" + raw
	if seen[key] {
		return false
	}
	seen[key] = true

	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		nonNullish := nonNullishTypeParts(parts)
		if len(nonNullish) == 0 {
			return false
		}
		for _, part := range nonNullish {
			if !sourceTypeIsDateRootType(info, reg, part, ctx, seen) {
				return false
			}
		}
		return true
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		hasDate := false
		for _, part := range parts {
			if sourceTypeIsDateRootType(info, reg, part, ctx, seen) {
				hasDate = true
				continue
			}
			if isMetadataOnlyIntersectionPart(part) {
				continue
			}
			return false
		}
		return hasDate
	}
	if name, args, ok := generic(raw); ok {
		if name == "Date" || (name == "ValidDate" && isFoundationTypeIdentifier(info, name)) {
			return true
		}
		if name == "NonNullable" {
			return sourceTypeIsDateRootType(info, reg, firstArg(args), ctx, seen)
		}
	}
	if resolved, owner, ok := resolveTypeText(info, reg, raw, ctx); ok && strings.TrimSpace(resolved) != raw {
		return sourceTypeIsDateRootType(owner, reg, resolved, ctx, seen)
	}
	return false
}

func isFoundationTypeIdentifier(info *fileInfo, name string) bool {
	ref, ok := info.imports[name]
	return ok && isFoundationImportRef(ref)
}

func sourcePartsContainDateType(info *fileInfo, reg *registry, parts []string, ctx *typeContext, seen map[string]bool) bool {
	for _, part := range parts {
		if sourceTypeContainsDateType(info, reg, part, ctx, seen) {
			return true
		}
	}
	return false
}

func typiaIndexPropertyExpr(info *fileInfo, reg *registry, prop *schemametadata.MetadataProperty, state *typiaRenderState) (string, bool) {
	if prop == nil || prop.Key == nil || prop.Value == nil || prop.Key.GetSoleLiteral() != nil {
		return "", false
	}
	if prop.Key.Any ||
		prop.Key.Escaped != nil ||
		prop.Key.Rest != nil ||
		len(prop.Key.Templates) != 0 ||
		len(prop.Key.Constants) != 0 ||
		len(prop.Key.Arrays) != 0 ||
		len(prop.Key.Tuples) != 0 ||
		len(prop.Key.Objects) != 0 ||
		len(prop.Key.Aliases) != 0 ||
		len(prop.Key.Natives) != 0 ||
		len(prop.Key.Sets) != 0 ||
		len(prop.Key.Maps) != 0 ||
		len(prop.Key.Functions) != 0 ||
		len(prop.Key.Atomics) != 1 {
		return "", false
	}
	switch prop.Key.Atomics[0].Type {
	case "string", "number":
		return typiaMetadataExpr(info, reg, prop.Value, true, state), true
	default:
		return "", false
	}
}

func typiaAliasExpr(info *fileInfo, reg *registry, alias *schemametadata.MetadataAlias, state *typiaRenderState) string {
	if alias == nil || alias.Type == nil {
		return "{kind: 2}"
	}
	if state.aliases[alias.Type] {
		return "{kind: 2, typeName: " + quote(alias.GetDisplayName()) + "}"
	}
	state.aliases[alias.Type] = true
	defer delete(state.aliases, alias.Type)

	if alias.Type.Value == nil {
		return "{kind: 2, typeName: " + quote(alias.GetDisplayName()) + "}"
	}
	return typiaTaggedExpr(withTypeName(typiaMetadataExpr(info, reg, alias.Type.Value, true, state), alias.GetDisplayName()), alias.Tags)
}

func typiaNativeExpr(info *fileInfo, reg *registry, native *schemametadata.MetadataNative) string {
	if native == nil {
		return "{kind: 2}"
	}
	name := native.Name
	if name == "" {
		name = native.GetName()
	}
	if isIdentifierName(name) {
		return typiaTaggedExpr("{kind: 16, typeName: "+quote(native.GetName())+", classType: () => "+runtimeValueExpr(info, reg, name)+"}", native.Tags)
	}
	return typiaTaggedExpr("{kind: 2, typeName: "+quote(native.GetName())+"}", native.Tags)
}

func typiaTaggedExpr(base string, tags [][]schemametadata.IMetadataTypeTag) string {
	markers := typiaTagMarkerExprs(tags)
	if len(markers) == 0 {
		return base
	}
	types := append([]string{base}, markers...)
	return "{kind: 13, types: [" + strings.Join(types, ", ") + "]}"
}

func typiaTagMarkerExprs(tags [][]schemametadata.IMetadataTypeTag) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, row := range tags {
		for _, tag := range row {
			expr := typiaTagMarkerExpr(tag)
			if expr == "" || seen[expr] {
				continue
			}
			seen[expr] = true
			out = append(out, expr)
		}
	}
	return out
}

func typiaTagMarkerExpr(tag schemametadata.IMetadataTypeTag) string {
	switch tag.Kind {
	case "minLength":
		return validationMarker("MinLength", "minLength", typiaNumericTagValueTypeExpr(tag.Value))
	case "maxLength":
		return validationMarker("MaxLength", "maxLength", typiaNumericTagValueTypeExpr(tag.Value))
	case "minimum":
		return validationMarker("Minimum", "minimum", typiaNumericTagValueTypeExpr(tag.Value))
	case "greaterThan":
		return validationMarker("GreaterThan", "greaterThan", typiaNumericTagValueTypeExpr(tag.Value))
	case "maximum":
		return validationMarker("Maximum", "maximum", typiaNumericTagValueTypeExpr(tag.Value))
	case "lessThan":
		return validationMarker("LessThan", "lessThan", typiaNumericTagValueTypeExpr(tag.Value))
	case "pattern":
		return validationMarker("Pattern", "pattern", typiaTagValueTypeExpr(tag.Value))
	case "format":
		if pattern := typiaFormatPatternArg(fmt.Sprint(tag.Value)); pattern != "" {
			return validationMarker("Format", "pattern", pattern)
		}
		return ""
	case "database:field":
		return "{kind: 2, typeName: \"DatabaseField\", database: {\"*\": " + typiaTagPayloadPlainValueExpr(tag) + "}}"
	case "database:mysql":
		return "{kind: 2, typeName: \"MySQL\", database: {mysql: " + typiaTagPayloadPlainValueExpr(tag) + "}}"
	case "database:primaryKey":
		return "{kind: 2, typeName: \"PrimaryKey\"}"
	case "database:autoIncrement":
		return "{kind: 2, typeName: \"AutoIncrement\"}"
	case "database:reference":
		return "{kind: 2, typeName: \"Reference\"}"
	case "database:index":
		return "{kind: 2, typeName: \"Index\"}"
	case "database:unique":
		return "{kind: 2, typeName: \"Unique\"}"
	default:
		if strings.HasPrefix(tag.Kind, "tsf:") || strings.HasPrefix(tag.Kind, "openapi:") {
			if tag.Kind == "tsf:length" {
				return typeAnnotationMarker("TypeAnnotation", tag.Kind, typiaNumericTagValueTypeExpr(tag.Value))
			}
			if tag.Kind == "tsf:validator" {
				return validationMarker("Validator", "validator", typiaTagValueTypeExpr(tag.Value))
			}
			return typeAnnotationMarker("TypeAnnotation", tag.Kind, typiaTagValueTypeExpr(tag.Value))
		}
		return ""
	}
}

func typiaFormatPatternArg(format string) string {
	switch format {
	case "date":
		return "{kind: 10, literal: \"^\\\\d{4}-\\\\d{2}-\\\\d{2}$\"}"
	case "email":
		return "{kind: 10, literal: \"^[a-zA-Z0-9_+.-]+@[a-zA-Z0-9-.]+\\\\.[a-zA-Z]+$\"}"
	case "uuid":
		return "{kind: 10, literal: \"^(?:urn:uuid:)?[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$\"}"
	default:
		return ""
	}
}

func typiaTagValueTypeExpr(value any) string {
	switch v := value.(type) {
	case nil:
		return "{kind: 4}"
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		props := make([]string, 0, len(keys))
		for _, key := range keys {
			props = append(props, "{kind: 20, name: "+quote(key)+", type: "+typiaTagValueTypeExpr(v[key])+", optional: false}")
		}
		return "{kind: 18, types: [" + strings.Join(props, ", ") + "]}"
	case []any:
		items := make([]string, 0, len(v))
		for _, item := range v {
			items = append(items, "{type: "+typiaTagValueTypeExpr(item)+"}")
		}
		return "{kind: 15, types: [" + strings.Join(items, ", ") + "]}"
	default:
		return "{kind: 10, literal: " + typiaLiteralExpr(value) + "}"
	}
}

func typiaNumericTagValueTypeExpr(value any) string {
	if value != nil {
		str := fmt.Sprint(value)
		if _, err := strconv.ParseFloat(str, 64); err == nil {
			return "{kind: 10, literal: " + str + "}"
		}
	}
	return typiaTagValueTypeExpr(value)
}

func typiaTagPayloadPlainValueExpr(tag schemametadata.IMetadataTypeTag) string {
	if tag.Schema != nil {
		return typiaPlainValueExpr(tag.Schema)
	}
	return typiaPlainValueExpr(tag.Value)
}

func typiaPlainValueExpr(value any) string {
	switch v := value.(type) {
	case nil:
		return "undefined"
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		props := make([]string, 0, len(keys))
		for _, key := range keys {
			props = append(props, quote(key)+": "+typiaPlainValueExpr(v[key]))
		}
		return "{" + strings.Join(props, ", ") + "}"
	case []any:
		items := make([]string, 0, len(v))
		for _, item := range v {
			items = append(items, typiaPlainValueExpr(item))
		}
		return "[" + strings.Join(items, ", ") + "]"
	default:
		return typiaLiteralExpr(value)
	}
}

func typiaPropertyName(prop *schemametadata.MetadataProperty) string {
	if literal := prop.Key.GetSoleLiteral(); literal != nil {
		return *literal
	}
	name := strings.TrimSpace(prop.Key.GetName())
	if strings.HasPrefix(name, "\"") || strings.HasPrefix(name, "'") {
		return literalStringValue(name)
	}
	return name
}

func typiaUnionExpr(types []string) string {
	out := make([]string, 0, len(types))
	seen := map[string]bool{}
	for _, typ := range types {
		typ = strings.TrimSpace(typ)
		if typ == "" || seen[typ] {
			continue
		}
		seen[typ] = true
		out = append(out, typ)
	}
	if len(out) == 0 {
		return "{kind: 2}"
	}
	if len(out) == 1 {
		return out[0]
	}
	return "{kind: 12, types: [" + strings.Join(out, ", ") + "]}"
}

func typiaLiteralExpr(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		return quote(v)
	case bool:
		return boolLit(v)
	case int:
		return strconv.Itoa(v)
	case int8:
		return strconv.FormatInt(int64(v), 10)
	case int16:
		return strconv.FormatInt(int64(v), 10)
	case int32:
		return strconv.FormatInt(int64(v), 10)
	case int64:
		return strconv.FormatInt(v, 10)
	case uint:
		return strconv.FormatUint(uint64(v), 10)
	case uint8:
		return strconv.FormatUint(uint64(v), 10)
	case uint16:
		return strconv.FormatUint(uint64(v), 10)
	case uint32:
		return strconv.FormatUint(uint64(v), 10)
	case uint64:
		return strconv.FormatUint(v, 10)
	case float32:
		return typiaFloatLiteral(float64(v), 32)
	case float64:
		return typiaFloatLiteral(v, 64)
	default:
		return quote(fmt.Sprint(v))
	}
}

func typiaFloatLiteral(value float64, bitSize int) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return quote(strconv.FormatFloat(value, 'g', -1, bitSize))
	}
	return strconv.FormatFloat(value, 'f', -1, bitSize)
}
