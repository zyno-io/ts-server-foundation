package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
)

type sourceCallInfo struct {
	name     string
	receiver string
	typeArgs []string
	args     []string
	pos      int
}

func resolvedReceiveTypeCall(info *fileInfo, reg *registry, node *shimast.Node) (callInfo, bool) {
	if info == nil || info.file == nil || reg == nil || reg.checker == nil || node == nil || node.Kind != shimast.KindCallExpression {
		return callInfo{}, false
	}
	call := node.AsCallExpression()
	signature := reg.checker.GetResolvedSignature(node)
	if signature == nil {
		return callInfo{}, false
	}
	declaration := signature.Declaration()
	if declaration == nil {
		return callInfo{}, false
	}
	declarationFile := shimast.GetSourceFileOfNode(declaration)
	if declarationFile == nil {
		return callInfo{}, false
	}
	name := "ReceiveType"
	if declaration.Name() != nil {
		name = declaration.Name().Text()
	}
	fn := functionInfo{
		name:       name,
		typeParams: typeParameterNames(declaration),
		params:     paramsFromNode(declarationFile, declaration),
		pos:        declaration.Pos(),
	}
	receiveTypeText := ""
	if _, text, ok := receiveTypeParameter(fn); ok {
		receiveTypeText = unwrapReceiveTypeHelperType(text)
	} else {
		return callInfo{}, false
	}
	sourceCall := sourceCallInfo{name: name, pos: node.Pos()}
	for _, typeArg := range node.TypeArguments() {
		sourceCall.typeArgs = append(sourceCall.typeArgs, nodeText(info.file, typeArg))
	}
	if call.Arguments != nil {
		for _, arg := range call.Arguments.Nodes {
			sourceCall.args = append(sourceCall.args, nodeText(info.file, arg))
		}
	}
	typeText, metadataArgIndex, ok := receiveTypeForCall(info, reg, fn, sourceCall)
	if !ok {
		return callInfo{}, false
	}
	var typeNode *shimast.Node
	for index, typeParam := range fn.typeParams {
		if receiveTypeText == typeParam && index < len(node.TypeArguments()) {
			typeNode = node.TypeArguments()[index]
			break
		}
	}
	return callInfo{
		name:             name,
		nodePos:          node.Pos(),
		metadataArgIndex: metadataArgIndex,
		typeText:         typeText,
		typeNode:         typeNode,
		preferTypia:      typeNode != nil,
		pos:              node.Pos(),
	}, true
}

func collectReceiveTypeCalls(info *fileInfo, reg *registry) []callInfo {
	text := info.file.Text()
	out := []callInfo{}
	seen := map[int]bool{}
	for name, fns := range receiveTypeFunctionCandidates(info, reg) {
		if len(fns) == 0 {
			continue
		}
		for _, call := range sourceCalls(text, name) {
			if seen[call.pos] {
				continue
			}
			for _, fn := range fns {
				typeText, metadataArgIndex, ok := receiveTypeForCall(info, reg, fn, call)
				if !ok {
					continue
				}
				out = append(out, callInfo{name: name, nodePos: -1, metadataArgIndex: metadataArgIndex, typeText: typeText, pos: call.pos})
				seen[call.pos] = true
				break
			}
		}
	}
	for name, fns := range receiveTypeMethodCandidates(reg) {
		if len(fns) == 0 {
			continue
		}
		for _, call := range sourceMethodCalls(text, name) {
			if seen[call.pos] {
				continue
			}
			typeText, metadataArgIndex, ok := receiveTypeMethodForCall(info, reg, fns, call)
			if ok {
				out = append(out, callInfo{name: name, nodePos: -1, metadataArgIndex: metadataArgIndex, typeText: typeText, pos: call.pos})
				seen[call.pos] = true
			}
		}
	}
	return out
}

func receiveTypeFunctionCandidates(info *fileInfo, reg *registry) map[string][]functionInfo {
	out := map[string][]functionInfo{}
	for name, fns := range info.functions {
		if receive := receiveTypeFunctionInfos(fns); len(receive) > 0 {
			out[name] = append(out[name], receive...)
		}
	}
	for localName, ref := range info.imports {
		target := reg.byPath[ref.source]
		if target != nil {
			fns := target.functions[ref.exportName]
			if receive := receiveTypeFunctionInfos(fns); len(receive) > 0 {
				out[localName] = append(out[localName], receive...)
			}
			continue
		}
		if receive := externalReceiveTypeFunctionInfos(info.file.FileName(), ref.spec, ref.exportName, reg); len(receive) > 0 {
			out[localName] = append(out[localName], receive...)
		}
	}
	return out
}

func receiveTypeFunctionInfos(fns []functionInfo) []functionInfo {
	out := []functionInfo{}
	for _, fn := range fns {
		if _, _, ok := receiveTypeParameter(fn); ok {
			out = append(out, fn)
		}
	}
	return out
}

func externalReceiveTypeFunctionInfos(fromFile string, spec string, exportName string, reg *registry) []functionInfo {
	functions := externalFunctionInfos(fromFile, spec, reg)
	if len(functions) == 0 {
		return nil
	}
	return receiveTypeFunctionInfos(functions[exportName])
}

func externalFunctionInfos(fromFile string, spec string, reg *registry) map[string][]functionInfo {
	root := externalPackageRoot(fromFile, spec)
	if root == "" {
		return nil
	}
	if cached, ok := reg.external[root]; ok {
		return cached
	}
	functions := map[string][]functionInfo{}
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := entry.Name()
		if entry.IsDir() {
			switch name {
			case ".git", ".yarn", "node_modules", "coverage":
				return filepath.SkipDir
			}
			return nil
		}
		slash := filepath.ToSlash(path)
		if !(strings.HasSuffix(slash, ".ts") || strings.HasSuffix(slash, ".d.ts")) || strings.HasSuffix(slash, ".js") {
			return nil
		}
		textBytes, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		for _, fn := range exportedFunctionsFromText(string(textBytes)) {
			functions[fn.name] = append(functions[fn.name], fn)
		}
		return nil
	})
	reg.external[root] = functions
	return functions
}

func externalPackageRoot(fromFile string, spec string) string {
	if strings.HasPrefix(spec, ".") || strings.HasPrefix(spec, "/") {
		return ""
	}
	pkg := packageNameFromSpec(spec)
	if pkg == "" {
		return ""
	}
	dir := filepath.Dir(fromFile)
	for {
		candidate := filepath.Join(dir, "node_modules", filepath.FromSlash(pkg))
		if stat, err := os.Stat(candidate); err == nil && stat.IsDir() {
			if real, err := filepath.EvalSymlinks(candidate); err == nil {
				return filepath.Clean(real)
			}
			return filepath.Clean(candidate)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func packageNameFromSpec(spec string) string {
	parts := strings.Split(filepath.ToSlash(spec), "/")
	if len(parts) == 0 || parts[0] == "" {
		return ""
	}
	if strings.HasPrefix(parts[0], "@") {
		if len(parts) < 2 || parts[1] == "" {
			return ""
		}
		return parts[0] + "/" + parts[1]
	}
	return parts[0]
}

func exportedFunctionsFromText(text string) []functionInfo {
	out := []functionInfo{}
	search := 0
	for search < len(text) {
		idx := strings.Index(text[search:], "function")
		if idx < 0 {
			break
		}
		start := search + idx
		after := start + len("function")
		if start > 0 && isIdent(text[start-1]) || after < len(text) && isIdent(text[after]) {
			search = after
			continue
		}
		if !isExportedFunctionPosition(text, start) {
			search = after
			continue
		}
		pos := skipSpace(text, after)
		nameStart, ok := scanIdentifierRight(text, pos)
		if !ok {
			search = after
			continue
		}
		name := text[pos:nameStart]
		pos = skipSpace(text, nameStart)
		typeParams := []string{}
		if pos < len(text) && text[pos] == '<' {
			end := findBalanced(text, pos, '<', '>')
			if end < 0 {
				search = pos + 1
				continue
			}
			typeParams = typeParameterNamesFromText(text[pos+1 : end])
			pos = skipSpace(text, end+1)
		}
		if pos >= len(text) || text[pos] != '(' {
			search = nameStart
			continue
		}
		close := findBalanced(text, pos, '(', ')')
		if close < 0 {
			search = pos + 1
			continue
		}
		out = append(out, functionInfo{name: name, typeParams: typeParams, params: paramsFromText(text[pos+1 : close]), pos: start})
		search = close + 1
	}
	return out
}

func isExportedFunctionPosition(text string, start int) bool {
	lineStart := strings.LastIndexAny(text[:start], "\r\n")
	if lineStart < 0 {
		lineStart = 0
	} else {
		lineStart++
	}
	prefix := strings.TrimSpace(text[lineStart:start])
	return regexp.MustCompile(`(?:^|\b)export(?:\s+declare)?\s*$`).MatchString(prefix)
}

func scanIdentifierRight(text string, pos int) (int, bool) {
	if pos >= len(text) || !isIdent(text[pos]) || text[pos] >= '0' && text[pos] <= '9' {
		return 0, false
	}
	for pos < len(text) && isIdent(text[pos]) {
		pos++
	}
	return pos, true
}

func typeParameterNamesFromText(raw string) []string {
	params := []string{}
	for _, part := range splitTop(raw, ",") {
		part = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(part), "const "))
		if part == "" {
			continue
		}
		name := part
		for _, marker := range []string{" extends ", " = ", " "} {
			if idx := strings.Index(name, marker); idx >= 0 {
				name = strings.TrimSpace(name[:idx])
			}
		}
		if isIdentifierName(name) {
			params = append(params, name)
		}
	}
	return params
}

func paramsFromText(raw string) []paramInfo {
	params := []paramInfo{}
	for _, part := range splitTop(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		colon := topLevelColon(part)
		if colon < 0 {
			continue
		}
		name := strings.TrimSpace(strings.TrimPrefix(part[:colon], "..."))
		optional := strings.HasSuffix(name, "?")
		name = strings.TrimSuffix(name, "?")
		typeText := strings.TrimSpace(part[colon+1:])
		hasDefault := false
		if eq := topLevelEquals(typeText); eq >= 0 {
			typeText = strings.TrimSpace(typeText[:eq])
			hasDefault = true
		}
		params = append(params, paramInfo{name: name, typeText: typeText, optional: optional || hasDefault, hasDefault: hasDefault})
	}
	return params
}

func receiveTypeMethodCandidates(reg *registry) map[string][]functionInfo {
	out := map[string][]functionInfo{}
	for _, info := range reg.files {
		for _, class := range info.classes {
			methods := append(append([]methodInfo(nil), class.methods...), class.staticMethods...)
			for _, method := range methods {
				fn := functionInfo{name: method.name, owner: class.name, typeParams: method.typeParams, params: method.params, pos: class.pos}
				if _, _, ok := receiveTypeParameter(fn); ok {
					out[method.name] = append(out[method.name], fn)
				}
			}
		}
	}
	return out
}

func receiveTypeParameter(fn functionInfo) (int, string, bool) {
	if len(fn.params) == 0 {
		return 0, "", false
	}
	index := len(fn.params) - 1
	typeText, ok := receiveTypeArgument(fn.params[index].typeText)
	return index, typeText, ok
}

func receiveTypeArgument(raw string) (string, bool) {
	raw = strings.TrimSpace(trimParens(raw))
	name, args, ok := generic(raw)
	if !ok || name != "ReceiveType" && !strings.HasSuffix(name, ".ReceiveType") || len(args) == 0 {
		return "", false
	}
	return firstArg(args), true
}

func receiveTypeForCall(info *fileInfo, reg *registry, fn functionInfo, call sourceCallInfo) (string, int, bool) {
	paramIndex, typeText, ok := receiveTypeParameter(fn)
	if !ok || len(call.args) >= paramIndex+1 {
		return "", 0, false
	}
	substitutions := map[string]string{}
	for i, name := range fn.typeParams {
		if i < len(call.typeArgs) {
			substitutions[name] = call.typeArgs[i]
		}
	}
	for i := 0; i < paramIndex && i < len(call.args); i++ {
		for _, typeParam := range fn.typeParams {
			if substitutions[typeParam] != "" || !typeTextContainsTypeParameter(fn.params[i].typeText, typeParam) {
				continue
			}
			if inferred, ok := inferTypeParameterFromArgument(fn.params[i].typeText, typeParam, call.args[i]); ok {
				substitutions[typeParam] = inferred
			}
		}
	}
	for _, typeParam := range fn.typeParams {
		if replacement := substitutions[typeParam]; replacement != "" {
			typeText = replaceTypeParameter(typeText, typeParam, replacement)
		}
	}
	typeText = unwrapReceiveTypeHelperType(typeText)
	if hasUnresolvedTypeParameters(typeText, fn.typeParams) {
		availableArgs := min(len(call.args), paramIndex)
		if inferred, ok := uniqueTypedFunctionArgumentParameter(info, call.args[:availableArgs], call.pos); ok {
			return inferred, paramIndex, true
		}
		return "", 0, false
	}
	if !receiveTypeMetadataResolvable(info, reg, typeText) {
		availableArgs := min(len(call.args), paramIndex)
		if inferred, ok := uniqueTypedFunctionArgumentParameter(info, call.args[:availableArgs], call.pos); ok {
			return inferred, paramIndex, true
		}
	}
	return typeText, paramIndex, true
}

func receiveTypeMethodForCall(info *fileInfo, reg *registry, fns []functionInfo, call sourceCallInfo) (string, int, bool) {
	if owner, ok := receiverClassName(info, reg, call); ok {
		fns = methodCandidatesForOwner(fns, owner)
		if len(fns) == 0 {
			return "", 0, false
		}
	}
	type match struct {
		typeText         string
		metadataArgIndex int
	}
	matches := []match{}
	for _, fn := range fns {
		typeText, metadataArgIndex, ok := receiveTypeForCall(info, reg, fn, call)
		if ok {
			matches = append(matches, match{typeText: typeText, metadataArgIndex: metadataArgIndex})
		}
	}
	if len(matches) == 1 {
		return matches[0].typeText, matches[0].metadataArgIndex, true
	}
	if len(matches) == 0 {
		return "", 0, false
	}
	first := matches[0]
	for _, next := range matches[1:] {
		if next.typeText != first.typeText || next.metadataArgIndex != first.metadataArgIndex {
			return "", 0, false
		}
	}
	return first.typeText, first.metadataArgIndex, true
}

func methodCandidatesForOwner(fns []functionInfo, owner string) []functionInfo {
	out := []functionInfo{}
	for _, fn := range fns {
		if fn.owner == owner {
			out = append(out, fn)
		}
	}
	return out
}

func typeTextContainsTypeParameter(raw string, typeParam string) bool {
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(typeParam) + `\b`).MatchString(raw)
}

func inferTypeParameterFromArgument(paramType string, typeParam string, arg string) (string, bool) {
	if strings.TrimSpace(trimParens(paramType)) == typeParam {
		return argumentTypeText(arg)
	}
	if !typeTextContainsTypeParameter(paramType, typeParam) {
		return "", false
	}
	return firstFunctionParameterType(arg)
}

func argumentTypeText(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "true" || raw == "false" || raw == "null" || raw == "undefined" {
		return raw, true
	}
	if strings.HasPrefix(raw, "'") || strings.HasPrefix(raw, "\"") || strings.HasPrefix(raw, "`") {
		return raw, true
	}
	if _, err := strconv.ParseFloat(raw, 64); err == nil {
		return raw, true
	}
	return firstFunctionParameterType(raw)
}

func unwrapReceiveTypeHelperType(raw string) string {
	for {
		raw = strings.TrimSpace(trimParens(raw))
		name, args, ok := generic(raw)
		if !ok || len(args) == 0 {
			return raw
		}
		if name != "NoInfer" {
			return raw
		}
		raw = firstArg(args)
	}
}

func receiveTypeMetadataResolvable(info *fileInfo, reg *registry, raw string) bool {
	raw = unwrapReceiveTypeHelperType(raw)
	name, args, ok := generic(raw)
	if !ok {
		return !isUnsupportedTypeSyntax(raw)
	}
	if alias, owner, _, ok := resolveAliasRef(info, reg, name); ok && len(alias.params) > 0 {
		body := alias.body
		for i := range alias.params {
			body = replaceTypeParameter(body, aliasParamName(alias, i), aliasArg(alias, args, i))
		}
		if shouldUseTypiaTypeCtx(owner, reg, body, map[string]bool{}) {
			return true
		}
		return !isUnsupportedTypeSyntax(body)
	}
	switch name {
	case "Array", "ReadonlyArray", "Promise", "NoInfer", "NonNullable", "ApiResponse",
		"HttpBody", "HttpQueries", "HttpQuery", "HttpPath", "HttpHeader",
		"ApiName", "ApiType", "MinLength", "MaxLength", "Minimum", "GreaterThan", "Maximum", "LessThan", "Pattern",
		"Validate", "DatabaseField", "MySQL", "Reference", "Index", "Indexed", "Unique", "PrimaryKey",
		"AutoIncrement", "TypeAnnotation", "Record", "EntityFields", "EntityOptionals",
		"NewEntityFields", "Pick", "Omit", "Partial", "Required", "Extract":
		return true
	default:
		if ref, ok := info.imports[name]; ok && isExternalImportRef(ref) {
			return true
		}
		return false
	}
}

func uniqueTypedFunctionArgumentParameter(info *fileInfo, args []string, pos int) (string, bool) {
	found := ""
	for _, arg := range args {
		typeText, ok := functionArgumentParameterType(info, arg, pos)
		if !ok {
			continue
		}
		if found != "" {
			return "", false
		}
		found = typeText
	}
	return found, found != ""
}

func functionArgumentParameterType(info *fileInfo, raw string, pos int) (string, bool) {
	if typeText, ok := firstFunctionParameterType(raw); ok {
		return typeText, true
	}
	raw = strings.TrimSpace(raw)
	if !isIdentifierName(raw) {
		return "", false
	}
	for _, fn := range localFunctionsBefore(info.functions[raw], pos) {
		if len(fn.params) > 0 {
			return fn.params[0].typeText, fn.params[0].typeText != ""
		}
	}
	return localFunctionVariableParameterType(info.file.Text(), raw, pos)
}

func localFunctionsBefore(fns []functionInfo, pos int) []functionInfo {
	out := []functionInfo{}
	for _, fn := range fns {
		if fn.pos <= pos {
			out = append(out, fn)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].pos > out[j].pos })
	return out
}

func localFunctionVariableParameterType(text string, name string, pos int) (string, bool) {
	if pos > len(text) {
		pos = len(text)
	}
	prefix := text[:pos]
	ident := regexp.QuoteMeta(name)
	for _, pattern := range []string{
		`(?:^|[^A-Za-z0-9_$])(?:const|let|var)\s+` + ident + `\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>`,
		`(?:^|[^A-Za-z0-9_$])(?:const|let|var)\s+` + ident + `\s*:\s*\(([^)]*)\)\s*=>`,
	} {
		if params, ok := lastCapture(prefix, pattern); ok {
			return firstParameterType(params)
		}
	}
	return "", false
}

func sourceCalls(text string, name string) []sourceCallInfo {
	out := []sourceCallInfo{}
	search := 0
	for search < len(text) {
		idx := strings.Index(text[search:], name)
		if idx < 0 {
			break
		}
		start := search + idx
		after := start + len(name)
		if start > 0 && isIdent(text[start-1]) {
			search = after
			continue
		}
		if after < len(text) && isIdent(text[after]) {
			search = after
			continue
		}
		if !isCodePosition(text, start) || isFunctionDeclarationName(text, start) {
			search = after
			continue
		}
		typeArgs := []string{}
		pos := skipSpace(text, after)
		if pos < len(text) && text[pos] == '<' {
			typeEnd := findBalanced(text, pos, '<', '>')
			if typeEnd < 0 {
				search = pos + 1
				continue
			}
			typeArgs = nonEmptyParts(splitTop(text[pos+1:typeEnd], ","))
			pos = skipSpace(text, typeEnd+1)
		}
		if pos >= len(text) || text[pos] != '(' {
			search = after
			continue
		}
		close := findBalanced(text, pos, '(', ')')
		if close < 0 {
			search = pos + 1
			continue
		}
		if isDeclarationCallShape(text, close) {
			search = close + 1
			continue
		}
		out = append(out, sourceCallInfo{name: name, typeArgs: typeArgs, args: nonEmptyParts(splitTop(text[pos+1:close], ",")), pos: start})
		search = close + 1
	}
	return out
}

func sourceMethodCalls(text string, name string) []sourceCallInfo {
	out := []sourceCallInfo{}
	for _, call := range sourceCalls(text, name) {
		before := call.pos - 1
		for before >= 0 && (text[before] == ' ' || text[before] == '\t' || text[before] == '\r' || text[before] == '\n') {
			before--
		}
		if before >= 0 && text[before] == '.' {
			call.receiver = methodReceiverExpression(text, before)
			out = append(out, call)
		}
	}
	return out
}

func methodReceiverExpression(text string, dot int) string {
	end := dot
	pos := dot - 1
	for pos >= 0 && (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\r' || text[pos] == '\n') {
		pos--
	}
	if pos >= 0 && text[pos] == '?' {
		pos--
		for pos >= 0 && (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\r' || text[pos] == '\n') {
			pos--
		}
	}
	start, ok := scanIdentifierLeft(text, pos)
	if !ok {
		return ""
	}
	for {
		prev := start - 1
		for prev >= 0 && (text[prev] == ' ' || text[prev] == '\t' || text[prev] == '\r' || text[prev] == '\n') {
			prev--
		}
		if prev < 0 || text[prev] != '.' {
			break
		}
		leftEnd := prev - 1
		for leftEnd >= 0 && (text[leftEnd] == ' ' || text[leftEnd] == '\t' || text[leftEnd] == '\r' || text[leftEnd] == '\n') {
			leftEnd--
		}
		if leftEnd >= 0 && text[leftEnd] == '?' {
			leftEnd--
			for leftEnd >= 0 && (text[leftEnd] == ' ' || text[leftEnd] == '\t' || text[leftEnd] == '\r' || text[leftEnd] == '\n') {
				leftEnd--
			}
		}
		leftStart, ok := scanIdentifierLeft(text, leftEnd)
		if !ok {
			return ""
		}
		start = leftStart
	}
	return strings.TrimSpace(text[start:end])
}

func scanIdentifierLeft(text string, pos int) (int, bool) {
	if pos < 0 || pos >= len(text) || !isIdent(text[pos]) {
		return 0, false
	}
	end := pos
	for pos >= 0 && isIdent(text[pos]) {
		pos--
	}
	start := pos + 1
	if start <= end && text[start] >= '0' && text[start] <= '9' {
		return 0, false
	}
	return start, true
}

func receiverClassName(info *fileInfo, reg *registry, call sourceCallInfo) (string, bool) {
	receiver := strings.TrimSpace(call.receiver)
	if receiver == "" {
		return "", false
	}
	if receiver == "this" {
		if class := containingClass(info, call.pos); class != nil {
			return class.name, true
		}
		return "", false
	}
	if strings.HasPrefix(receiver, "this.") {
		class := containingClass(info, call.pos)
		if class == nil {
			return "", false
		}
		member := strings.TrimSpace(strings.TrimPrefix(receiver, "this."))
		if strings.Contains(member, ".") {
			return "", false
		}
		if typeText, ok := classMemberType(class, member); ok {
			return classNameFromType(info, reg, typeText, call.pos)
		}
		return "", false
	}
	if !isIdentifierName(receiver) {
		return "", false
	}
	if typeText, ok := localReceiverType(info.file.Text(), receiver, call.pos); ok {
		return classNameFromType(info, reg, typeText, call.pos)
	}
	return "", false
}

func containingClass(info *fileInfo, pos int) *classInfo {
	var found *classInfo
	for _, class := range info.classes {
		if class.pos <= pos && pos <= class.end && (found == nil || class.pos > found.pos) {
			found = class
		}
	}
	return found
}

func classMemberType(class *classInfo, name string) (string, bool) {
	for _, prop := range class.properties {
		if prop.name == name {
			return prop.typeText, true
		}
	}
	for _, param := range class.ctor {
		if param.name == name {
			return param.typeText, true
		}
	}
	return "", false
}

func localReceiverType(text string, name string, pos int) (string, bool) {
	if pos > len(text) {
		pos = len(text)
	}
	prefix := text[:pos]
	ident := regexp.QuoteMeta(name)
	if typeText, ok := lastCapture(prefix, `(?:^|[^A-Za-z0-9_$])(?:const|let|var)\s+`+ident+`\s*=\s*new\s+([A-Za-z_$][A-Za-z0-9_$]*)\b`); ok {
		return typeText, true
	}
	if typeText, ok := lastCapture(prefix, `(?:^|[^A-Za-z0-9_$])(?:const|let|var)\s+`+ident+`\s*:\s*([^=;\n]+)`); ok {
		return typeText, true
	}
	if typeText, ok := lastCapture(prefix, `(?:^|[^A-Za-z0-9_$])`+ident+`\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^=;,\)\n]+>)?)`); ok {
		return typeText, true
	}
	return "", false
}

func lastCapture(text string, pattern string) (string, bool) {
	re := regexp.MustCompile(pattern)
	matches := re.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 || len(matches[len(matches)-1]) < 2 {
		return "", false
	}
	value := strings.TrimSpace(matches[len(matches)-1][1])
	return value, value != ""
}

func classNameFromType(info *fileInfo, reg *registry, typeText string, pos int) (string, bool) {
	name := interfaceRefName(typeText)
	if class, _, ok := resolveClassRefAt(info, reg, name, pos); ok {
		return class.name, true
	}
	if _, ok := reg.classes[name]; ok {
		return name, true
	}
	return "", false
}

func isDeclarationCallShape(text string, close int) bool {
	next := skipSpace(text, close+1)
	if next >= len(text) {
		return false
	}
	return text[next] == ':' || text[next] == '{'
}

func isFunctionDeclarationName(text string, start int) bool {
	lineStart := strings.LastIndexAny(text[:start], "\r\n")
	if lineStart < 0 {
		lineStart = 0
	} else {
		lineStart++
	}
	prefix := strings.TrimSpace(text[lineStart:start])
	return regexp.MustCompile(`(?:^|\b)(?:export\s+)?(?:async\s+)?function\s*$`).MatchString(prefix)
}

func firstFunctionParameterType(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "async ")
	if strings.HasPrefix(raw, "function") {
		open := strings.IndexByte(raw, '(')
		if open < 0 {
			return "", false
		}
		close := findBalanced(raw, open, '(', ')')
		if close < 0 {
			return "", false
		}
		return firstParameterType(raw[open+1 : close])
	}
	if strings.HasPrefix(raw, "(") {
		close := findBalanced(raw, 0, '(', ')')
		if close < 0 {
			return "", false
		}
		after := skipSpace(raw, close+1)
		if after >= len(raw) || !strings.HasPrefix(raw[after:], "=>") {
			return "", false
		}
		return firstParameterType(raw[1:close])
	}
	arrow := strings.Index(raw, "=>")
	if arrow < 0 {
		return "", false
	}
	return firstParameterType(raw[:arrow])
}

func firstParameterType(params string) (string, bool) {
	first := firstArg(splitTop(params, ","))
	if strings.TrimSpace(first) == "" {
		return "", false
	}
	colon := topLevelColon(first)
	if colon < 0 {
		return "", false
	}
	typeText := strings.TrimSpace(first[colon+1:])
	if eq := topLevelEquals(typeText); eq >= 0 {
		typeText = strings.TrimSpace(typeText[:eq])
	}
	return typeText, typeText != ""
}
