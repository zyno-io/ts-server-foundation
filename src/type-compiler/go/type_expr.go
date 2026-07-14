package main

import (
	"regexp"
	"strconv"
	"strings"
)

func typeExpr(info *fileInfo, reg *registry, raw string) string {
	return typeExprCtx(info, reg, raw, &typeContext{seen: map[string]bool{}})
}

func typeExprCtx(info *fileInfo, reg *registry, raw string, ctx *typeContext) string {
	raw = strings.TrimSpace(stripTypeComments(raw))
	raw = trimParens(raw)
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "readonly "))
	if raw == "" || raw == "unknown" {
		return "{kind: 2}"
	}
	if ctx == nil {
		ctx = &typeContext{seen: map[string]bool{}}
	}
	ctx.depth++
	defer func() { ctx.depth-- }()
	if ctx.depth > 80 {
		return "{kind: 2, typeName: " + quote(raw) + "}"
	}
	key := info.moduleKey + "\x00" + raw
	if ctx.seen[key] {
		return "{kind: 2, typeName: " + quote(raw) + "}"
	}
	ctx.seen[key] = true
	defer delete(ctx.seen, key)
	if raw == "string" {
		return "{kind: 6}"
	}
	if raw == "never" {
		return "{kind: 0}"
	}
	if raw == "number" {
		return "{kind: 7}"
	}
	if raw == "boolean" {
		return "{kind: 8}"
	}
	if raw == "bigint" {
		return "{kind: 9}"
	}
	if raw == "void" {
		return "{kind: 3}"
	}
	if raw == "undefined" {
		return "{kind: 4}"
	}
	if raw == "null" {
		return "{kind: 5}"
	}
	if raw == "any" {
		return "{kind: 1}"
	}
	if raw == "object" {
		return "{kind: 17}"
	}
	if raw == "symbol" {
		return "{kind: 2, typeName: \"symbol\"}"
	}
	if raw == "ReflectionKind" {
		return "{kind: 11, typeName: \"ReflectionKind\", values: []}"
	}
	if strings.HasPrefix(raw, "keyof ") {
		return "{kind: 2, typeName: " + quote(raw) + "}"
	}
	if isFunctionTypeSyntax(raw) {
		return "{kind: 2, typeName: " + quote(raw) + "}"
	}
	if parts := nonEmptyParts(splitTop(raw, "|")); len(parts) > 1 {
		return "{kind: 12, types: [" + mapJoin(parts, func(part string) string { return typeExprCtx(info, reg, part, ctx) }) + "]}"
	}
	if parts := nonEmptyParts(splitTop(raw, "&")); len(parts) > 1 {
		return "{kind: 13, types: [" + mapJoin(parts, func(part string) string { return typeExprCtx(info, reg, part, ctx) }) + "]}"
	}
	if strings.HasPrefix(raw, "\"") || strings.HasPrefix(raw, "'") {
		return "{kind: 10, literal: " + normalizeStringLiteral(raw) + "}"
	}
	if raw == "true" || raw == "false" {
		return "{kind: 10, literal: " + raw + "}"
	}
	if _, err := strconv.ParseFloat(raw, 64); err == nil {
		return "{kind: 10, literal: " + raw + "}"
	}
	if strings.HasSuffix(raw, "[]") {
		return "{kind: 14, type: " + typeExprCtx(info, reg, strings.TrimSuffix(raw, "[]"), ctx) + "}"
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		items := splitTop(strings.TrimSpace(raw[1:len(raw)-1]), ",")
		return "{kind: 15, types: [" + mapJoin(items, func(item string) string {
			return "{type: " + typeExprCtx(info, reg, item, ctx) + "}"
		}) + "]}"
	}
	if expr, ok := indexedAccessTypeExpr(info, reg, raw, ctx); ok {
		return expr
	}
	if isObjectLiteralTypeText(raw) {
		return objectTypeLiteralExpr(info, reg, raw, ctx)
	}
	if expr, ok := importTypeReferenceExpr(info, reg, raw, ctx); ok {
		return expr
	}
	if name, args, ok := generic(raw); ok {
		return genericTypeExpr(info, reg, name, args, ctx)
	}
	if isUnsupportedTypeSyntax(raw) {
		return "{kind: 2, typeName: " + quote(raw) + "}"
	}
	if ref, ok := info.imports[raw]; ok && isExternalImportRef(ref) && !isFoundationImportRef(ref) {
		return externalImportedTypeExpr(ref, raw)
	}
	if class, ok := chooseClass(info, raw, ctx.pos); ok {
		if iface, hasInterface := chooseInterface(info, raw, ctx.pos); !hasInterface || class.pos >= iface.pos {
			return "{kind: 16, typeName: " + quote(raw) + ", classType: () => " + runtimeValueExpr(info, reg, raw) + "}"
		}
	}
	if enum, _, ok := resolveEnum(info, reg, raw); ok {
		return enumTypeExpr(enum, raw)
	}
	if decl, owner, ref, ok := resolveInterfaceDeclRefAt(info, reg, raw, ctx.pos); ok {
		_ = ref
		return interfaceObjectLiteralExpr(owner, reg, raw, decl, ctx)
	}
	if alias, owner, ref, ok := resolveAliasRef(info, reg, raw); ok {
		if len(alias.params) > 0 {
			return "{kind: 2, typeName: " + quote(raw) + "}"
		}
		if ref != nil {
			alias = ensureAliasMetadata(owner, reg, ref.exportName, alias)
		}
		return aliasTypeExprCtx(owner, reg, alias, raw, ctx)
	}
	if ref, ok := info.imports[raw]; ok && isExternalImportRef(ref) {
		return externalImportedTypeExpr(ref, raw)
	}
	switch raw {
	case "PrimaryKey", "AutoIncrement", "Reference", "Index", "Unique":
		return "{kind: 2, typeName: " + quote(raw) + "}"
	}
	return "{kind: 16, typeName: " + quote(raw) + ", classType: () => " + runtimeValueExpr(info, reg, raw) + "}"
}

func genericTypeExpr(info *fileInfo, reg *registry, name string, args []string, ctx *typeContext) string {
	switch name {
	case "Array", "ReadonlyArray":
		return "{kind: 14, type: " + typeExprCtx(info, reg, firstArg(args), ctx) + "}"
	case "Promise":
		return "{kind: 22, type: " + typeExprCtx(info, reg, firstArg(args), ctx) + "}"
	case "NoInfer":
		return typeExprCtx(info, reg, firstArg(args), ctx)
	case "NonNullable":
		source := firstArg(args)
		if resolved, owner, ok := resolveTypeText(info, reg, source, ctx); ok {
			return typeExprCtx(owner, reg, nonNullableTypeText(resolved), ctx)
		}
		return typeExprCtx(info, reg, nonNullableTypeText(source), ctx)
	case "ApiResponse":
		bodyType := typeExprCtx(info, reg, firstArg(args), ctx)
		statusType := literalArg("200")
		if len(args) > 1 {
			statusType = literalArg(args[1])
		}
		return "{kind: 22, typeName: \"ApiResponse\", type: " + bodyType + ", typeArguments: [" + bodyType + ", " + statusType + "]}"
	case "HttpBody":
		return httpMarkerType(info, reg, "HttpBody", "httpBody", firstArg(args), "{}", ctx)
	case "HttpQueries":
		return httpMarkerType(info, reg, "HttpQueries", "httpQueries", firstArg(args), "{}", ctx)
	case "HttpQuery":
		return httpMarkerType(info, reg, "HttpQuery", "httpQuery", firstArg(args), optionArg(args, 1), ctx)
	case "HttpPath":
		return httpMarkerType(info, reg, "HttpPath", "httpPath", firstArg(args), optionArg(args, 1), ctx)
	case "HttpHeader":
		return httpMarkerType(info, reg, "HttpHeader", "httpHeader", firstArg(args), optionArg(args, 1), ctx)
	case "ApiName":
		return typeAnnotationMarker("ApiName", "openapi:name", literalArg(firstArg(args)))
	case "ApiType":
		if len(args) < 2 {
			return "{kind: 2, typeName: \"ApiType\"}"
		}
		bodyType := typeExprCtx(info, reg, args[1], ctx)
		marker := typeAnnotationMarker("ApiName", "openapi:name", literalArg(firstArg(args)))
		return "{kind: 13, typeName: \"ApiType\", types: [" + bodyType + ", " + marker + "]}"
	case "Indexed":
		if len(args) == 0 {
			return "{kind: 2, typeName: \"Indexed\"}"
		}
		return indexedTypeExpr(info, reg, firstArg(args), ctx)
	case "MinLength":
		return validationMarker("MinLength", "minLength", literalArg(firstArg(args)))
	case "MaxLength":
		return validationMarker("MaxLength", "maxLength", literalArg(firstArg(args)))
	case "Minimum":
		return validationMarker("Minimum", "minimum", literalArg(firstArg(args)))
	case "GreaterThan":
		return validationMarker("GreaterThan", "greaterThan", literalArg(firstArg(args)))
	case "Maximum":
		return validationMarker("Maximum", "maximum", literalArg(firstArg(args)))
	case "LessThan":
		return validationMarker("LessThan", "lessThan", literalArg(firstArg(args)))
	case "Pattern":
		if isLiteralStringType(firstArg(args)) {
			return validationMarker("Pattern", "pattern", literalArg(firstArg(args)))
		}
		return validationMarker("Pattern", "pattern", runtimeArg(info, reg, firstArg(args)))
	case "TypiaFormat":
		if pattern := typiaFormatPatternArg(literalStringValue(firstArg(args))); pattern != "" {
			return validationMarker("Format", "pattern", pattern)
		}
		return "{kind: 2, typeName: \"TypiaFormat\"}"
	case "Validate":
		if isLiteralStringType(firstArg(args)) {
			return validationMarker("Validator", "validator", literalArg(firstArg(args)))
		}
		return validationMarker("Validate", "validate", runtimeArg(info, reg, firstArg(args)))
	case "TsfValidatorTag":
		return validationMarker("Validator", "validator", internalTagValueExpr(info, reg, firstArg(args[1:]), ctx))
	case "TsfTypeTag":
		return typeAnnotationMarker("TypeAnnotation", "tsf:type", internalTagValueExpr(info, reg, firstArg(args[1:]), ctx))
	case "TsfTypiaTag":
		if expr, ok := internalTypiaTagMarkerExpr(info, reg, name, args, 1, 2, -1, ctx); ok {
			return expr
		}
		return "{kind: 2, typeName: \"TsfTypiaTag\"}"
	case "TsfTypiaSchemaTag":
		if expr, ok := internalTypiaTagMarkerExpr(info, reg, name, args, 1, 2, 3, ctx); ok {
			return expr
		}
		return "{kind: 2, typeName: \"TsfTypiaSchemaTag\"}"
	case "TsfDatabaseFieldTag":
		return "{kind: 2, typeName: \"DatabaseField\", database: {\"*\": " + plainValue(firstArg(args)) + "}}"
	case "TsfDatabaseTag":
		if expr, ok := internalDatabaseTagMarkerExpr(literalStringValue(firstArg(args)), plainValue(optionArg(args, 1))); ok {
			return expr
		}
		return "{kind: 2, typeName: \"TsfDatabaseTag\"}"
	case "DatabaseField":
		return "{kind: 2, typeName: \"DatabaseField\", database: {\"*\": " + plainValue(firstArg(args)) + "}}"
	case "MySQL":
		return "{kind: 2, typeName: \"MySQL\", database: {mysql: " + plainValue(firstArg(args)) + "}}"
	case "Reference", "Index", "Unique", "PrimaryKey", "AutoIncrement":
		return "{kind: 2, typeName: " + quote(name) + "}"
	case "TypeAnnotation":
		if len(args) == 0 {
			return "{kind: 2}"
		}
		annotation := literalStringValue(args[0])
		value := "{kind: 4}"
		if len(args) > 1 {
			value = annotationValueExpr(info, reg, args[1], ctx)
		}
		return typeAnnotationMarker("TypeAnnotation", annotation, value)
	case "Record":
		key := "{kind: 2}"
		if len(args) > 0 {
			key = typeExprCtx(info, reg, firstArg(args), ctx)
		}
		value := "{kind: 2}"
		if len(args) > 1 {
			value = typeExprCtx(info, reg, args[1], ctx)
		}
		return "{kind: 18, typeName: \"Record\", utilityType: \"Record\", typeArguments: [" + key + ", " + value + "], index: " + value + ", types: []}"
	case "EntityFields", "EntityOptionals", "NewEntityFields":
		if props, owner, ok := utilitySourceProperties(info, reg, firstArg(args), ctx); ok {
			sourceExpr := typeExprCtx(info, reg, firstArg(args), ctx)
			return "{kind: 18, typeName: " + quote(name) + ", typeArguments: [" + sourceExpr + "], types: [" + renderUtilityProperties(owner, reg, props, ctx) + "]}"
		}
		return "{kind: 18, typeName: " + quote(name) + ", types: []}"
	case "Pick", "Omit", "Partial", "Required":
		if expr, ok := utilityTypeExpr(info, reg, name, args, ctx); ok {
			return expr
		}
		if expr, ok := runtimeUtilityTypeExpr(info, reg, name, args, ctx); ok {
			return expr
		}
		return "{kind: 18, typeName: " + quote(name) + ", types: []}"
	case "Extract":
		sourceExpr := typeExprCtx(info, reg, firstArg(args), ctx)
		targetExpr := typeExprCtx(info, reg, firstArg(args[1:]), ctx)
		return "{kind: 12, typeName: \"Extract\", utilityType: \"Extract\", typeArguments: [" + sourceExpr + ", " + targetExpr + "], types: []}"
	default:
		if alias, owner, ref, ok := resolveAliasRef(info, reg, name); ok {
			_ = ref
			out := alias.body
			for i := range alias.params {
				out = replaceTypeParameter(out, aliasParamName(alias, i), aliasArg(alias, args, i))
			}
			if hasUnresolvedTypeParameters(out, alias.params) || isUnsupportedTypeSyntax(out) {
				return "{kind: 2, typeName: " + quote(name) + ", typeArguments: [" + mapJoin(args, func(arg string) string { return typeExprCtx(info, reg, arg, ctx) }) + "]}"
			}
			return withTypeName(typeExprCtx(owner, reg, out, ctx), name)
		}
		if decl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, name, ctx.pos); ok {
			return interfaceObjectLiteralExpr(owner, reg, name, instantiateInterfaceDecl(decl, args), ctx)
		}
		if ref, ok := info.imports[name]; ok && isExternalImportRef(ref) {
			return withTypeArguments(externalImportedTypeExpr(ref, name), info, reg, args, ctx)
		}
		return "{kind: 16, typeName: " + quote(name) + ", classType: () => " + runtimeValueExpr(info, reg, name) + typeArgumentsProperty(info, reg, args, ctx) + "}"
	}
}

func typeArgumentsProperty(info *fileInfo, reg *registry, args []string, ctx *typeContext) string {
	if len(args) == 0 {
		return ""
	}
	return ", typeArguments: [" + mapJoin(args, func(arg string) string { return typeExprCtx(info, reg, arg, ctx) }) + "]"
}

func withTypeArguments(expr string, info *fileInfo, reg *registry, args []string, ctx *typeContext) string {
	if len(args) == 0 {
		return expr
	}
	return "Object.assign(" + expr + ", {typeArguments: [" + mapJoin(args, func(arg string) string { return typeExprCtx(info, reg, arg, ctx) }) + "]})"
}

func httpMarkerType(info *fileInfo, reg *registry, typeName string, annotation string, valueType string, options string, ctx *typeContext) string {
	value := annotationValueExpr(info, reg, options+" & { type: "+valueType+" }", ctx)
	marker := typeAnnotationMarker(typeName, annotation, value)
	return "{kind: 13, typeName: " + quote(typeName) + ", types: [" + typeExprCtx(info, reg, valueType, ctx) + ", " + marker + "]}"
}

func objectLiteralExpr(info *fileInfo, reg *registry, typeName string, body string, ctx *typeContext) string {
	props := propertiesFromBody(body)
	return "{kind: 18, typeName: " + quote(typeName) + objectIndexExpr(info, reg, body, ctx) + ", types: [" + renderUtilityProperties(info, reg, props, ctx) + "]}"
}

func interfaceObjectLiteralExpr(info *fileInfo, reg *registry, typeName string, decl interfaceInfo, ctx *typeContext) string {
	if ctx == nil {
		ctx = &typeContext{seen: map[string]bool{}}
	}
	if ctx.interfaces == nil {
		ctx.interfaces = map[string]bool{}
	}
	key := info.moduleKey + "\x00" + strconv.Itoa(decl.pos)
	if ctx.interfaces[key] {
		return "{kind: 2, typeName: " + quote(typeName) + "}"
	}
	ctx.interfaces[key] = true
	defer delete(ctx.interfaces, key)

	props := interfaceFullProperties(info, reg, decl, map[string]bool{})
	body := interfaceFullBody(info, reg, decl, map[string]bool{})
	items := []string{
		"kind: 18",
		"typeName: " + quote(typeName),
		"types: [" + renderUtilityProperties(info, reg, props, ctx) + "]",
	}
	if index := objectIndexExpr(info, reg, body, ctx); index != "" {
		items = append(items, strings.TrimPrefix(index, ", "))
	}
	if implements := interfaceImplementsExpr(info, reg, decl, ctx); implements != "" {
		items = append(items, "implements: ["+implements+"]")
	}
	return "{" + strings.Join(items, ", ") + "}"
}

func interfaceObjectLiteralExprPreferred(info *fileInfo, reg *registry, typeName string, decl interfaceInfo, ctx *typeContext) string {
	props := interfaceFullProperties(info, reg, decl, map[string]bool{})
	body := interfaceFullBody(info, reg, decl, map[string]bool{})
	items := []string{
		"kind: 18",
		"typeName: " + quote(typeName),
		"types: [" + renderPreferredUtilityProperties(info, reg, props, ctx) + "]",
	}
	if index := objectIndexExpr(info, reg, body, ctx); index != "" {
		items = append(items, strings.TrimPrefix(index, ", "))
	}
	if implements := interfaceImplementsExpr(info, reg, decl, ctx); implements != "" {
		items = append(items, "implements: ["+implements+"]")
	}
	return "{" + strings.Join(items, ", ") + "}"
}

func objectTypeLiteralExpr(info *fileInfo, reg *registry, raw string, ctx *typeContext) string {
	body := strings.TrimSpace(raw[1 : len(raw)-1])
	props := propertiesFromBody(body)
	return "{kind: 18" + objectIndexExpr(info, reg, body, ctx) + ", types: [" + renderUtilityProperties(info, reg, props, ctx) + "]}"
}

func objectIndexExpr(info *fileInfo, reg *registry, body string, ctx *typeContext) string {
	if indexType, ok := indexSignatureType(body); ok {
		return ", index: " + typeExprCtx(info, reg, indexType, ctx)
	}
	return ""
}

func objectLiteralProperties(info *fileInfo, reg *registry, body string, ctx *typeContext) []string {
	props := []string{}
	for _, prop := range propertiesFromBody(body) {
		props = append(props, renderUtilityProperty(info, reg, prop, ctx))
	}
	return props
}

func propertiesFromBody(body string) []utilityProperty {
	props := []utilityProperty{}
	for _, field := range splitInterfaceFields(body) {
		name, typeText, optional, ok := parseField(field)
		if !ok {
			continue
		}
		props = append(props, utilityProperty{name: name, typeText: typeText, optional: optional})
	}
	return props
}

func renderUtilityProperties(info *fileInfo, reg *registry, props []utilityProperty, ctx *typeContext) string {
	return strings.Join(mapUtilityProperties(props, func(prop utilityProperty) string {
		return renderUtilityProperty(info, reg, prop, ctx)
	}), ", ")
}

func renderPreferredUtilityProperties(info *fileInfo, reg *registry, props []utilityProperty, ctx *typeContext) string {
	return strings.Join(mapUtilityProperties(props, func(prop utilityProperty) string {
		return renderPreferredUtilityProperty(info, reg, prop, ctx)
	}), ", ")
}

func renderUtilityProperty(info *fileInfo, reg *registry, prop utilityProperty, ctx *typeContext) string {
	owner := info
	if prop.owner != nil {
		owner = prop.owner
	}
	t := internalTypeExprForNodeCtx(owner, reg, prop.typeText, prop.typeNode, ctx)
	if prop.optional {
		t = "{kind: 12, types: [" + t + ", {kind: 4}]}"
	}
	return "{kind: 20, name: " + quote(prop.name) + ", type: " + t + ", optional: " + boolLit(prop.optional) + "}"
}

func renderPreferredUtilityProperty(info *fileInfo, reg *registry, prop utilityProperty, ctx *typeContext) string {
	owner := info
	if prop.owner != nil {
		owner = prop.owner
	}
	pos := 0
	if ctx != nil {
		pos = ctx.pos
	}
	if prop.typeNode != nil {
		pos = prop.typeNode.Pos()
	}
	var t string
	if sourceTypeNeedsInternalPropertyMetadata(owner, reg, prop.typeText, &typeContext{seen: map[string]bool{}, pos: pos}, map[string]bool{}) {
		t = internalTypeExprForNode(owner, reg, prop.typeText, prop.typeNode, pos)
	} else {
		t = typeExprForNodePreferred(owner, reg, prop.typeText, prop.typeNode, pos, true)
	}
	if prop.optional {
		t = "{kind: 12, types: [" + t + ", {kind: 4}]}"
	}
	return "{kind: 20, name: " + quote(prop.name) + ", type: " + t + ", optional: " + boolLit(prop.optional) + "}"
}

func mapUtilityProperties(values []utilityProperty, mapper func(utilityProperty) string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, mapper(value))
	}
	return out
}

func utilityTypeExpr(info *fileInfo, reg *registry, name string, args []string, ctx *typeContext) (string, bool) {
	props, owner, ok := utilityTypeProperties(info, reg, name, args, ctx)
	if !ok {
		return "", false
	}

	sourceExpr := typeExprCtx(info, reg, firstArg(args), ctx)
	return "{kind: 18, typeName: " + quote(name) + ", typeArguments: [" + sourceExpr + "], types: [" + renderUtilityProperties(owner, reg, props, ctx) + "]}", true
}

func runtimeUtilityTypeExpr(info *fileInfo, reg *registry, name string, args []string, ctx *typeContext) (string, bool) {
	if len(args) == 0 {
		return "", false
	}

	sourceExpr := typeExprCtx(info, reg, firstArg(args), ctx)
	keysExpr := "[]"
	if name == "Pick" || name == "Omit" {
		keysExpr = utilityKeysExpr(firstArg(args[1:]))
	}
	return "{kind: 18, typeName: " + quote(name) + ", utilityType: " + quote(name) + ", typeArguments: [" + sourceExpr + "], utilityKeys: " + keysExpr + ", types: []}", true
}

func isIdentityMappedAlias(info *fileInfo, reg *registry, name string) bool {
	alias, _, _, ok := resolveAliasRef(info, reg, name)
	if !ok {
		return false
	}
	_, ok = identityMappedAliasParam(alias)
	return ok
}

func identityMappedAliasParam(alias aliasInfo) (string, bool) {
	body := compactTypePattern(alias.body)
	re := regexp.MustCompile(`^\{\[([A-Za-z_$][\w$]*)inkeyof([A-Za-z_$][\w$]*)\]:([A-Za-z_$][\w$]*)\[([A-Za-z_$][\w$]*)\];?\}$`)
	match := re.FindStringSubmatch(body)
	if match == nil || match[1] != match[4] || match[2] != match[3] {
		return "", false
	}
	if !aliasHasParam(alias, match[2]) {
		return "", false
	}
	return match[2], true
}

func aliasHasParam(alias aliasInfo, name string) bool {
	for _, param := range alias.params {
		if param == name {
			return true
		}
	}
	return false
}

func sameTypeText(left string, right string) bool {
	return compactTypePattern(left) == compactTypePattern(right)
}

func compactTypePattern(raw string) string {
	var out strings.Builder
	for _, char := range raw {
		if char == ' ' || char == '\t' || char == '\n' || char == '\r' {
			continue
		}
		out.WriteRune(char)
	}
	return out.String()
}

func indexedTypeExpr(info *fileInfo, reg *registry, raw string, ctx *typeContext) string {
	raw = strings.TrimSpace(trimParens(raw))
	if resolved, owner, ok := resolveTypeText(info, reg, raw, ctx); ok && strings.TrimSpace(resolved) != raw {
		return indexedTypeExpr(owner, reg, resolved, ctx)
	}
	parts := nonEmptyParts(splitTop(raw, "|"))
	if len(parts) > 1 {
		nullish := []string{}
		nonNullish := []string{}
		for _, part := range parts {
			part = strings.TrimSpace(trimParens(part))
			if part == "null" || part == "undefined" {
				nullish = append(nullish, part)
			} else {
				nonNullish = append(nonNullish, part)
			}
		}
		if len(nullish) > 0 {
			types := []string{}
			if len(nonNullish) > 0 {
				types = append(types, indexedNonNullTypeExpr(info, reg, strings.Join(nonNullish, " | "), ctx))
			}
			for _, part := range nullish {
				types = append(types, typeExprCtx(info, reg, part, ctx))
			}
			return "{kind: 12, types: [" + strings.Join(types, ", ") + "]}"
		}
	}
	return indexedNonNullTypeExpr(info, reg, raw, ctx)
}

func indexedNonNullTypeExpr(info *fileInfo, reg *registry, raw string, ctx *typeContext) string {
	bodyType := typeExprCtx(info, reg, raw, ctx)
	return "{kind: 13, typeName: \"Indexed\", types: [" + bodyType + ", {kind: 2, typeName: \"Index\"}]}"
}

func utilityTypeProperties(info *fileInfo, reg *registry, name string, args []string, ctx *typeContext) ([]utilityProperty, *fileInfo, bool) {
	source := firstArg(args)
	props, owner, ok := utilitySourceProperties(info, reg, source, ctx)
	if !ok {
		return nil, nil, false
	}

	switch name {
	case "Pick":
		keys := utilityKeys(firstArg(args[1:]))
		props = filterUtilityProperties(props, func(prop utilityProperty) bool { return keys[prop.name] })
	case "Omit":
		keys := utilityKeys(firstArg(args[1:]))
		props = filterUtilityProperties(props, func(prop utilityProperty) bool { return !keys[prop.name] })
	case "Partial":
		for i := range props {
			props[i].optional = true
		}
	case "Required":
		for i := range props {
			props[i].optional = false
		}
	}

	return props, owner, true
}

func utilitySourceProperties(info *fileInfo, reg *registry, source string, ctx *typeContext) ([]utilityProperty, *fileInfo, bool) {
	source = strings.TrimSpace(source)
	if parts := splitTop(source, "&"); len(parts) > 1 {
		props := []utilityProperty{}
		owner := info
		failed := false
		for _, part := range parts {
			partProps, partOwner, ok := utilitySourceProperties(info, reg, part, ctx)
			if !ok {
				if isMetadataOnlyIntersectionPart(part) {
					continue
				}
				failed = true
				continue
			}
			props = append(props, partProps...)
			owner = partOwner
		}
		if failed {
			return nil, nil, false
		}
		if len(props) > 0 {
			return props, owner, true
		}
	}
	if resolved, owner, ok := resolveTypeText(info, reg, source, ctx); ok && strings.TrimSpace(resolved) != source {
		return utilitySourceProperties(owner, reg, resolved, ctx)
	}
	if name, args, ok := generic(source); ok {
		switch name {
		case "Pick", "Omit", "Partial", "Required":
			return utilityTypeProperties(info, reg, name, args, ctx)
		case "ApiType":
			if len(args) > 1 {
				return utilitySourceProperties(info, reg, args[1], ctx)
			}
		case "Indexed":
			return utilitySourceProperties(info, reg, firstArg(args), ctx)
		case "EntityFields", "EntityOptionals", "NewEntityFields":
			return utilitySourceProperties(info, reg, firstArg(args), ctx)
		}
	}
	if isObjectLiteralTypeText(source) {
		return withUtilityPropertyOwner(propertiesFromBody(strings.TrimSpace(source[1:len(source)-1])), info), info, true
	}
	if class, owner, ok := resolveClassRefAt(info, reg, source, ctx.pos); ok {
		props := make([]utilityProperty, 0, len(class.properties))
		for _, prop := range class.properties {
			props = append(props, utilityProperty{name: prop.name, typeText: prop.typeText, typeNode: prop.typeNode, optional: prop.optional, owner: owner})
		}
		return props, owner, true
	}
	if decl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, source, ctx.pos); ok {
		return interfaceFullProperties(owner, reg, decl, map[string]bool{}), owner, true
	}
	if alias, owner, _, ok := resolveAliasRef(info, reg, source); ok {
		if isObjectLiteralTypeText(alias.body) {
			body := strings.TrimSpace(alias.body)
			return withUtilityPropertyOwner(propertiesFromBody(strings.TrimSpace(body[1:len(body)-1])), owner), owner, true
		}
		if props, propOwner, ok := utilitySourceProperties(owner, reg, alias.body, ctx); ok {
			return props, propOwner, true
		}
	}
	return nil, nil, false
}

func isMetadataOnlyIntersectionPart(raw string) bool {
	raw = strings.TrimSpace(trimParens(raw))
	name, _, ok := generic(raw)
	if !ok {
		name = raw
	}
	switch name {
	case "ApiName", "TypeAnnotation", "MinLength", "MaxLength", "Minimum", "GreaterThan", "Maximum", "LessThan", "Pattern", "Validate",
		"DatabaseField", "MySQL", "Reference", "Index", "Unique", "PrimaryKey", "AutoIncrement",
		"HttpBody", "HttpQueries", "HttpQuery", "HttpPath", "HttpHeader":
		return true
	default:
		return false
	}
}

func indexedAccessTypeExpr(info *fileInfo, reg *registry, raw string, ctx *typeContext) (string, bool) {
	source, index, ok := trailingIndexedAccess(raw)
	if !ok {
		return "", false
	}
	if propertyName, ok := indexedAccessPropertyName(index); ok {
		if propertyType, owner, ok := propertyTypeText(info, reg, source, propertyName, ctx); ok {
			return typeExprCtx(owner, reg, propertyType, ctx), true
		}
		return "{kind: 2, typeName: " + quote(raw) + "}", true
	}
	if strings.TrimSpace(index) == "number" {
		if elementType, owner, ok := arrayElementTypeText(info, reg, source, ctx); ok {
			return typeExprCtx(owner, reg, elementType, ctx), true
		}
		return "{kind: 2, typeName: " + quote(raw) + "}", true
	}
	return "{kind: 2, typeName: " + quote(raw) + "}", true
}

func resolveTypeText(info *fileInfo, reg *registry, raw string, ctx *typeContext) (string, *fileInfo, bool) {
	raw = strings.TrimSpace(trimParens(raw))
	if raw == "" {
		return "", nil, false
	}
	if source, index, ok := trailingIndexedAccess(raw); ok {
		if propertyName, ok := indexedAccessPropertyName(index); ok {
			return propertyTypeText(info, reg, source, propertyName, ctx)
		}
		if strings.TrimSpace(index) == "number" {
			return arrayElementTypeText(info, reg, source, ctx)
		}
		return "", nil, false
	}
	if name, args, ok := generic(raw); ok {
		if name == "NonNullable" {
			source := firstArg(args)
			if resolved, owner, ok := resolveTypeText(info, reg, source, ctx); ok {
				return nonNullableTypeText(resolved), owner, true
			}
			return nonNullableTypeText(source), info, true
		}
	}
	if alias, owner, _, ok := resolveAliasRef(info, reg, raw); ok && len(alias.params) == 0 {
		return alias.body, owner, true
	}
	return "", nil, false
}

func propertyTypeText(info *fileInfo, reg *registry, source string, propertyName string, ctx *typeContext) (string, *fileInfo, bool) {
	source = strings.TrimSpace(trimParens(source))
	if resolved, owner, ok := resolveTypeText(info, reg, source, ctx); ok && strings.TrimSpace(resolved) != source {
		return propertyTypeText(owner, reg, resolved, propertyName, ctx)
	}
	if strings.HasSuffix(source, "[]") {
		return propertyTypeText(info, reg, strings.TrimSpace(strings.TrimSuffix(source, "[]")), propertyName, ctx)
	}
	if parts := splitTop(source, "&"); len(parts) > 1 {
		propertyType := ""
		propertyOwner := info
		found := false
		for _, part := range parts {
			partType, partOwner, ok := propertyTypeText(info, reg, part, propertyName, ctx)
			if !ok {
				continue
			}
			propertyType = partType
			propertyOwner = partOwner
			found = true
		}
		if found {
			return propertyType, propertyOwner, true
		}
	}
	if isObjectLiteralTypeText(source) {
		if prop, ok := findUtilityProperty(propertiesFromBody(strings.TrimSpace(source[1:len(source)-1])), propertyName); ok {
			return prop.typeText, info, true
		}
	}
	if name, args, ok := generic(source); ok {
		switch name {
		case "Promise", "Array", "ReadonlyArray":
			return propertyTypeText(info, reg, firstArg(args), propertyName, ctx)
		case "Pick", "Omit", "Partial", "Required":
			if props, owner, ok := utilityTypeProperties(info, reg, name, args, ctx); ok {
				if prop, ok := findUtilityProperty(props, propertyName); ok {
					if prop.owner != nil {
						owner = prop.owner
					}
					return prop.typeText, owner, true
				}
			}
		case "EntityFields", "EntityOptionals", "NewEntityFields":
			if props, owner, ok := utilitySourceProperties(info, reg, firstArg(args), ctx); ok {
				if prop, ok := findUtilityProperty(props, propertyName); ok {
					if prop.owner != nil {
						owner = prop.owner
					}
					return prop.typeText, owner, true
				}
			}
		}
	}
	if class, owner, ok := resolveClassRefAt(info, reg, source, ctx.pos); ok {
		for _, prop := range class.properties {
			if prop.name == propertyName {
				return prop.typeText, owner, true
			}
		}
	}
	if decl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, source, ctx.pos); ok {
		if prop, ok := findUtilityProperty(interfaceFullProperties(owner, reg, decl, map[string]bool{}), propertyName); ok {
			if prop.owner != nil {
				owner = prop.owner
			}
			return prop.typeText, owner, true
		}
	}
	if alias, owner, _, ok := resolveAliasRef(info, reg, source); ok && len(alias.params) == 0 {
		return propertyTypeText(owner, reg, alias.body, propertyName, ctx)
	}
	return "", nil, false
}

func withUtilityPropertyOwner(props []utilityProperty, owner *fileInfo) []utilityProperty {
	for i := range props {
		if props[i].owner == nil {
			props[i].owner = owner
		}
	}
	return props
}

func arrayElementTypeText(info *fileInfo, reg *registry, source string, ctx *typeContext) (string, *fileInfo, bool) {
	source = strings.TrimSpace(trimParens(source))
	if resolved, owner, ok := resolveTypeText(info, reg, source, ctx); ok && strings.TrimSpace(resolved) != source {
		source = strings.TrimSpace(resolved)
		info = owner
	}
	if strings.HasSuffix(source, "[]") {
		return strings.TrimSpace(strings.TrimSuffix(source, "[]")), info, true
	}
	if name, args, ok := generic(source); ok {
		if name == "Array" || name == "ReadonlyArray" {
			return firstArg(args), info, true
		}
	}
	if strings.HasPrefix(source, "[") && strings.HasSuffix(source, "]") {
		items := nonEmptyParts(splitTop(strings.TrimSpace(source[1:len(source)-1]), ","))
		if len(items) == 1 {
			return items[0], info, true
		}
		if len(items) > 1 {
			return strings.Join(items, " | "), info, true
		}
	}
	return "", nil, false
}

func trailingIndexedAccess(raw string) (string, string, bool) {
	raw = strings.TrimSpace(raw)
	if !strings.HasSuffix(raw, "]") {
		return "", "", false
	}
	start := -1
	depthAngle, depthBrace, depthParen, depthBracket := 0, 0, 0, 0
	quote := byte(0)
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if quote != 0 {
			if c == quote && (i == 0 || raw[i-1] != '\\') {
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"', '`':
			quote = c
		case '<':
			depthAngle++
		case '>':
			if depthAngle > 0 {
				depthAngle--
			}
		case '{':
			depthBrace++
		case '}':
			if depthBrace > 0 {
				depthBrace--
			}
		case '(':
			depthParen++
		case ')':
			if depthParen > 0 {
				depthParen--
			}
		case '[':
			if depthAngle == 0 && depthBrace == 0 && depthParen == 0 && depthBracket == 0 {
				start = i
			}
			depthBracket++
		case ']':
			if depthBracket > 0 {
				depthBracket--
			}
			if i == len(raw)-1 && depthAngle == 0 && depthBrace == 0 && depthParen == 0 && depthBracket == 0 && start > 0 {
				return strings.TrimSpace(raw[:start]), strings.TrimSpace(raw[start+1 : i]), true
			}
		}
	}
	return "", "", false
}

func indexedAccessPropertyName(index string) (string, bool) {
	index = strings.TrimSpace(index)
	if index == "" || index == "number" {
		return "", false
	}
	if strings.HasPrefix(index, "'") || strings.HasPrefix(index, "\"") {
		return literalStringValue(index), true
	}
	if isIdentifierName(index) {
		return index, true
	}
	return "", false
}

func findUtilityProperty(props []utilityProperty, name string) (utilityProperty, bool) {
	for _, prop := range props {
		if prop.name == name {
			return prop, true
		}
	}
	return utilityProperty{}, false
}

func nonNullableTypeText(raw string) string {
	parts := nonEmptyParts(splitTop(raw, "|"))
	if len(parts) <= 1 {
		return strings.TrimSpace(raw)
	}
	nonNull := []string{}
	for _, part := range parts {
		if part == "null" || part == "undefined" {
			continue
		}
		nonNull = append(nonNull, part)
	}
	if len(nonNull) == 0 {
		return "never"
	}
	return strings.Join(nonNull, " | ")
}

func utilityKeys(raw string) map[string]bool {
	keys := map[string]bool{}
	for _, part := range splitTop(raw, "|") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		keys[literalStringValue(part)] = true
	}
	return keys
}

func utilityKeysExpr(raw string) string {
	values := []string{}
	for _, part := range splitTop(raw, "|") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		values = append(values, quote(literalStringValue(part)))
	}
	return "[" + strings.Join(values, ", ") + "]"
}

func enumValuesFromBody(body string) []string {
	body = stripTypeComments(body)
	values := []string{}
	nextNumber := 0
	for _, field := range splitTop(body, ",") {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		name, initializer, hasInitializer := strings.Cut(field, "=")
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if !hasInitializer {
			values = append(values, strconv.Itoa(nextNumber))
			nextNumber++
			continue
		}
		initializer = strings.TrimSpace(initializer)
		if strings.HasPrefix(initializer, "\"") || strings.HasPrefix(initializer, "'") || strings.HasPrefix(initializer, "`") {
			values = append(values, normalizeStringLiteral(initializer))
			continue
		}
		if _, err := strconv.ParseFloat(initializer, 64); err == nil {
			values = append(values, initializer)
			if parsed, err := strconv.Atoi(initializer); err == nil {
				nextNumber = parsed + 1
			}
			continue
		}
		values = append(values, quote(strings.Trim(name, "\"'`")))
	}
	return values
}

func enumTypeExpr(enum enumInfo, name string) string {
	return "{kind: 11, typeName: " + quote(name) + ", values: [" + strings.Join(enum.values, ", ") + "]}"
}

func filterUtilityProperties(props []utilityProperty, keep func(utilityProperty) bool) []utilityProperty {
	out := []utilityProperty{}
	for _, prop := range props {
		if keep(prop) {
			out = append(out, prop)
		}
	}
	return out
}

func annotationValueExpr(info *fileInfo, reg *registry, raw string, ctx *typeContext) string {
	parts := splitTop(strings.TrimSpace(raw), "&")
	if len(parts) <= 1 {
		return typeExprCtx(info, reg, raw, ctx)
	}
	props := []string{}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "{}" {
			continue
		}
		if !isObjectLiteralTypeText(part) {
			return typeExprCtx(info, reg, raw, ctx)
		}
		body := strings.TrimSpace(part[1 : len(part)-1])
		props = append(props, objectLiteralProperties(info, reg, body, ctx)...)
	}
	return "{kind: 18, types: [" + strings.Join(props, ", ") + "]}"
}

func internalTypiaTagMarkerExpr(info *fileInfo, reg *registry, typeName string, args []string, kindIndex int, valueIndex int, schemaIndex int, ctx *typeContext) (string, bool) {
	if len(args) <= kindIndex {
		return "", false
	}
	kind := literalStringValue(args[kindIndex])
	value := "{kind: 4}"
	if len(args) > valueIndex {
		value = internalTagValueExpr(info, reg, args[valueIndex], ctx)
	}
	if strings.HasPrefix(kind, "database:") {
		payload := "undefined"
		if schemaIndex >= 0 && len(args) > schemaIndex {
			payload = plainValue(args[schemaIndex])
		} else if len(args) > valueIndex {
			payload = plainValue(args[valueIndex])
		}
		if expr, ok := internalDatabaseTagMarkerExpr(kind, payload); ok {
			return expr, true
		}
	}
	if kind == "tsf:validator" {
		return validationMarker("Validator", "validator", value), true
	}
	if strings.HasPrefix(kind, "tsf:") || strings.HasPrefix(kind, "openapi:") {
		return typeAnnotationMarker("TypeAnnotation", kind, value), true
	}
	return "{kind: 2, typeName: " + quote(typeName) + "}", true
}

func internalDatabaseTagMarkerExpr(kind string, payload string) (string, bool) {
	switch kind {
	case "database:field":
		return "{kind: 2, typeName: \"DatabaseField\", database: {\"*\": " + payload + "}}", true
	case "database:mysql":
		return "{kind: 2, typeName: \"MySQL\", database: {mysql: " + payload + "}}", true
	case "database:primaryKey":
		return "{kind: 2, typeName: \"PrimaryKey\"}", true
	case "database:autoIncrement":
		return "{kind: 2, typeName: \"AutoIncrement\"}", true
	case "database:reference":
		return "{kind: 2, typeName: \"Reference\"}", true
	case "database:index":
		return "{kind: 2, typeName: \"Index\"}", true
	case "database:unique":
		return "{kind: 2, typeName: \"Unique\"}", true
	default:
		return "", false
	}
}

func internalTagValueExpr(info *fileInfo, reg *registry, raw string, ctx *typeContext) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "undefined" {
		return "{kind: 4}"
	}
	if isLiteralStringType(raw) || raw == "true" || raw == "false" || raw == "null" {
		return literalArg(raw)
	}
	if _, err := strconv.ParseFloat(raw, 64); err == nil {
		return literalArg(raw)
	}
	return annotationValueExpr(info, reg, raw, ctx)
}

func validationMarker(typeName string, name string, arg string) string {
	return "{kind: 2, typeName: " + quote(typeName) + ", validation: [{name: " + quote(name) + ", args: [" + arg + "]}]}"
}

func typeAnnotationMarker(typeName string, annotation string, value string) string {
	return "{kind: 2, typeName: " + quote(typeName) + ", annotations: {" + quote(annotation) + ": " + value + "}}"
}

func importedAliasExpr(reg *registry, ref importRef) string {
	return "{kind: 2, typeName: " + quote(ref.exportName) + "}"
}

func aliasTypeExprCtx(owner *fileInfo, reg *registry, alias aliasInfo, name string, ctx *typeContext) string {
	if strings.TrimSpace(alias.metadataText) != "" {
		return withTypeName(alias.metadataText, name)
	}
	return withTypeName(internalTypeExprForNodeCtx(owner, reg, alias.body, alias.typeNode, ctx), name)
}

func ensureAliasMetadata(owner *fileInfo, reg *registry, name string, alias aliasInfo) aliasInfo {
	if owner == nil || len(alias.params) != 0 || strings.TrimSpace(alias.metadataText) != "" {
		return alias
	}
	if current, ok := owner.aliases[name]; ok {
		if strings.TrimSpace(current.metadataText) != "" {
			return current
		}
		precomputeAliasMetadata(owner, reg, name, current)
		if updated, ok := owner.aliases[name]; ok {
			return updated
		}
	}
	return alias
}

func importTypeReferenceExpr(info *fileInfo, reg *registry, raw string, ctx *typeContext) (string, bool) {
	spec, exportName, ok := parseImportTypeReference(raw)
	if !ok {
		return "", false
	}
	if target := resolveImport(info.file.FileName(), spec, reg); target != nil {
		if enum, _, _, ok := resolveExportedEnum(target, reg, exportName, map[string]bool{}); ok {
			return enumTypeExpr(enum, exportName), true
		}
		if decl, owner, _, ok := resolveExportedInterfaceDecl(target, reg, exportName, map[string]bool{}); ok {
			return interfaceObjectLiteralExpr(owner, reg, exportName, decl, ctx), true
		}
		if alias, owner, ownerName, ok := resolveExportedAlias(target, reg, exportName, map[string]bool{}); ok {
			if len(alias.params) > 0 {
				return "{kind: 2, typeName: " + quote(exportName) + "}", true
			}
			alias = ensureAliasMetadata(owner, reg, ownerName, alias)
			return aliasTypeExprCtx(owner, reg, alias, exportName, ctx), true
		}
		if _, ok := chooseClass(target, exportName, 0); ok {
			return importedClassTypeExpr(info, reg, exportName, spec, exportName, target), true
		}
	}
	return importedClassTypeExpr(info, reg, exportName, spec, exportName, nil), true
}

func parseImportTypeReference(raw string) (string, string, bool) {
	re := regexp.MustCompile(`^import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*([A-Za-z_$][\w$]*)$`)
	match := re.FindStringSubmatch(strings.TrimSpace(raw))
	if match == nil {
		return "", "", false
	}
	return match[1], match[2], true
}

func importedClassTypeExpr(info *fileInfo, reg *registry, typeName string, spec string, exportName string, target *fileInfo) string {
	return "{kind: 16, typeName: " + quote(typeName) + ", classType: () => " + importedRuntimeValueExpr(info, reg, spec, exportName, target) + "}"
}

func externalImportedTypeExpr(ref importRef, typeName string) string {
	if ref.spec == "" || ref.exportName == "" {
		return "{kind: 2, typeName: " + quote(typeName) + "}"
	}
	return runtimeAliasPlaceholderName + "(" + quote(ref.spec) + ", " + quote(ref.exportName) + ", " + quote(typeName) + ")"
}

func runtimeNamespacePlaceholder(spec string, target *fileInfo) string {
	targetFile := ""
	if target != nil && target.file != nil {
		targetFile = target.file.FileName()
	}
	return "__tsf_runtime_namespace__(" + quote(spec) + ", " + quote(targetFile) + ")"
}

func runtimeImportPlaceholder(spec string, exportName string, target *fileInfo) string {
	targetFile := ""
	if target != nil && target.file != nil {
		targetFile = target.file.FileName()
	}
	return "__tsf_runtime_import__(" + quote(spec) + ", " + quote(exportName) + ", " + quote(targetFile) + ")"
}

func isExternalImportRef(ref importRef) bool {
	return ref.spec != "" && !strings.HasPrefix(ref.spec, ".")
}

func isFoundationImportRef(ref importRef) bool {
	return isExternalImportRef(ref) && ref.spec == foundationPackageSpec
}

func runtimeArg(info *fileInfo, reg *registry, raw string) string {
	return "{kind: 10, runtime: () => " + runtimeValueExpr(info, reg, raw) + "}"
}

func runtimeValueExpr(info *fileInfo, reg *registry, raw string) string {
	raw = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "typeof "))
	if isIdentifierName(raw) {
		if ref, ok := info.imports[raw]; ok {
			var target *fileInfo
			if ref.source != "" {
				target = reg.byPath[ref.source]
			}
			return importedRuntimeValueExpr(info, reg, ref.spec, ref.exportName, target)
		}
		return runtimeIdentifierExpr(raw)
	}
	return raw
}

func importedRuntimeValueExpr(info *fileInfo, reg *registry, spec string, exportName string, target *fileInfo) string {
	_ = info
	_ = reg
	if spec == "" || exportName == "" {
		return "undefined"
	}
	return runtimeImportPlaceholder(spec, exportName, target)
}

func runtimeIdentifierExpr(name string) string {
	return "(typeof " + name + " !== \"undefined\" ? " + name + " : (typeof exports !== \"undefined\" ? exports." + name + " : undefined))"
}

func withTypeName(expr string, name string) string {
	expr = strings.TrimSpace(expr)
	if !strings.HasPrefix(expr, "{") || !strings.HasSuffix(expr, "}") {
		return expr
	}
	return strings.TrimSuffix(expr, "}") + ", typeName: " + quote(name) + "}"
}
