package main

import (
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

func collectRegistry(prog *driver.Program, cwd string, emitTypeAliases bool, emitUndecoratedMethods bool) *registry {
	reg := &registry{
		files:         map[string]*fileInfo{},
		byPath:        map[string]*fileInfo{},
		checker:       prog.Checker,
		typiaCache:    map[typiaCacheKey]string{},
		typiaFailures: map[*shimchecker.Type]bool{},
		classes:       map[string]*classInfo{},
		external:      map[string]map[string][]functionInfo{},
	}
	for _, file := range prog.TSProgram.SourceFiles() {
		if shouldSkipFile(file.FileName(), cwd) {
			continue
		}
		info := &fileInfo{
			file:                 file,
			moduleKey:            moduleKey(file.FileName()),
			precompute:           shouldPrecomputeFile(file.FileName()),
			decoratedMethodsOnly: !emitUndecoratedMethods,
			aliases:              map[string]aliasInfo{},
			interfaces:           map[string][]interfaceInfo{},
			enums:                map[string]enumInfo{},
			classes:              []*classInfo{},
			functions:            map[string][]functionInfo{},
			imports:              map[string]importRef{},
			reexports:            map[string]importRef{},
		}
		reg.files[file.FileName()] = info
		reg.byPath[info.moduleKey] = info
		collectTextDeclarations(info)
	}
	for _, info := range reg.files {
		collectImports(info, reg)
		collectReexports(info, reg)
	}
	for _, info := range reg.files {
		collectAstDeclarations(info, reg)
	}
	for _, info := range reg.files {
		collectGenericCalls(info, reg)
	}
	precomputeMetadataExpressions(reg, emitTypeAliases)
	return reg
}

func shouldSkipFile(fileName string, cwd string) bool {
	slash := filepath.ToSlash(fileName)
	return isTypeScriptLibDeclaration(slash) ||
		isAmbientTypesPackageDeclaration(slash) ||
		isProjectBuildOutputFile(fileName, cwd) ||
		strings.HasSuffix(slash, "/src/reflection.ts")
}

func shouldPrecomputeFile(fileName string) bool {
	slash := filepath.ToSlash(fileName)
	return !strings.HasSuffix(slash, ".d.ts") && !strings.Contains(slash, "/node_modules/")
}

func isTypeScriptLibDeclaration(slash string) bool {
	base := filepath.Base(slash)
	return strings.HasPrefix(base, "lib.") && strings.HasSuffix(base, ".d.ts")
}

func isAmbientTypesPackageDeclaration(slash string) bool {
	return strings.Contains(slash, "/node_modules/@types/") && strings.HasSuffix(slash, ".d.ts")
}

func isProjectBuildOutputFile(fileName string, cwd string) bool {
	if cwd == "" {
		return false
	}
	rel, err := filepath.Rel(cwd, fileName)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return false
	}
	rel = filepath.ToSlash(rel)
	first, _, _ := strings.Cut(rel, "/")
	return first == "dist" || strings.HasPrefix(first, "dist-")
}

func moduleKey(fileName string) string {
	slash := filepath.ToSlash(fileName)
	ext := strings.ToLower(filepath.Ext(slash))
	if ext == ".mts" || ext == ".cts" {
		return filepath.Clean(slash)
	}
	return filepath.Clean(strings.TrimSuffix(slash, filepath.Ext(slash)))
}

func moduleSpecifier(fromFile string, toFile string) string {
	return moduleSpecifierForOutput(fromFile, toFile, false)
}

func moduleSpecifierForOutput(fromFile string, toFile string, esm bool) string {
	fromDir := filepath.Dir(fromFile)
	target := strings.TrimSuffix(toFile, filepath.Ext(toFile)) + outputImportExtension(toFile, esm)
	spec, err := filepath.Rel(fromDir, target)
	if err != nil {
		spec = target
	}
	spec = filepath.ToSlash(spec)
	if !strings.HasPrefix(spec, ".") {
		spec = "./" + spec
	}
	return spec
}

func outputImportExtension(sourceFile string, esm bool) string {
	switch strings.ToLower(filepath.Ext(sourceFile)) {
	case ".mts":
		return ".mjs"
	case ".cts":
		return ".cjs"
	case ".ts", ".tsx":
		if esm {
			return ".js"
		}
		return ""
	default:
		return ""
	}
}

func collectTextDeclarations(info *fileInfo) {
	text := info.file.Text()
	re := regexp.MustCompile(`(?m)^\s*(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)\b`)
	search := 0
	for {
		loc := re.FindStringSubmatchIndex(text[search:])
		if loc == nil {
			break
		}
		start := search + loc[0]
		name := text[search+loc[4] : search+loc[5]]
		exported := loc[2] >= 0
		afterName := search + loc[1]
		openRel := strings.IndexByte(text[afterName:], '{')
		if openRel < 0 {
			break
		}
		open := afterName + openRel
		close := findBalanced(text, open, '{', '}')
		if close < 0 {
			search = open + 1
			continue
		}
		body := strings.TrimSpace(text[open+1 : close])
		info.interfaces[name] = append(info.interfaces[name], interfaceInfo{body: body, extends: interfaceExtendsFromHeader(text[afterName:open]), exported: exported, pos: start, source: "text"})
		search = close + 1
	}

	enumRe := regexp.MustCompile(`(?m)^\s*(?:export\s+)?(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)\b`)
	search = 0
	for {
		loc := enumRe.FindStringSubmatchIndex(text[search:])
		if loc == nil {
			break
		}
		start := search + loc[0]
		name := text[search+loc[2] : search+loc[3]]
		afterName := search + loc[1]
		openRel := strings.IndexByte(text[afterName:], '{')
		if openRel < 0 {
			break
		}
		open := afterName + openRel
		close := findBalanced(text, open, '{', '}')
		if close < 0 {
			search = open + 1
			continue
		}
		body := strings.TrimSpace(text[open+1 : close])
		info.enums[name] = enumInfo{name: name, values: enumValuesFromBody(body), pos: start}
		search = close + 1
	}
}

func collectAstDeclarations(info *fileInfo, reg *registry) {
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		if node.Kind == shimast.KindClassDeclaration {
			if class := classFromNode(info, node); class != nil {
				info.classes = append(info.classes, class)
				reg.classes[class.name] = class
			}
		} else if node.Kind == shimast.KindFunctionDeclaration {
			if fn := functionFromNode(info.file, node); fn.name != "" {
				info.functions[fn.name] = append(info.functions[fn.name], fn)
			}
		} else if node.Kind == shimast.KindTypeAliasDeclaration {
			if alias := aliasFromNode(info.file, node); alias.body != "" && node.Name() != nil {
				info.aliases[node.Name().Text()] = alias
			}
		} else if node.Kind == shimast.KindInterfaceDeclaration {
			if node.Name() != nil {
				name := node.Name().Text()
				decl := interfaceFromNode(info.file, node)
				if index := textInterfaceDeclarationNearIndex(info.interfaces[name], node.Pos()); index >= 0 {
					info.interfaces[name][index] = decl
				} else {
					info.interfaces[name] = append(info.interfaces[name], decl)
				}
			}
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(info.file.AsNode())
}

func hasTextInterfaceDeclarationNear(decls []interfaceInfo, pos int) bool {
	return textInterfaceDeclarationNearIndex(decls, pos) >= 0
}

func textInterfaceDeclarationNearIndex(decls []interfaceInfo, pos int) int {
	for i, decl := range decls {
		if decl.source == "text" && intAbs(decl.pos-pos) <= 64 {
			return i
		}
	}
	return -1
}

func intAbs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func aliasFromNode(file *shimast.SourceFile, node *shimast.Node) aliasInfo {
	params := []string{}
	defaults := []string{}
	for _, param := range node.TypeParameters() {
		if param.Name() != nil {
			params = append(params, param.Name().Text())
			defaultText := ""
			if defaultType := param.AsTypeParameterDeclaration().DefaultType; defaultType != nil {
				defaultText = nodeText(file, defaultType)
			}
			defaults = append(defaults, defaultText)
		}
	}
	return aliasInfo{
		body:     nodeText(file, node.Type()),
		params:   params,
		defaults: defaults,
		typeNode: node.Type(),
		exported: node.ModifierFlags()&shimast.ModifierFlagsExport != 0,
		pos:      node.Pos(),
	}
}

func interfaceFromNode(file *shimast.SourceFile, node *shimast.Node) interfaceInfo {
	return interfaceInfo{
		body:       interfaceBodyFromNode(file, node),
		extends:    interfaceExtendsFromNode(file, node),
		properties: interfacePropertiesFromNode(file, node),
		exported:   node.ModifierFlags()&shimast.ModifierFlagsExport != 0,
		pos:        node.Pos(),
		source:     "ast",
	}
}

func interfacePropertiesFromNode(file *shimast.SourceFile, node *shimast.Node) []utilityProperty {
	props := []utilityProperty{}
	for _, member := range node.Members() {
		if member.Kind != shimast.KindPropertySignature {
			continue
		}
		name := memberName(file, member)
		if name == "" || member.Type() == nil {
			continue
		}
		props = append(props, utilityProperty{
			name:     name,
			typeText: nodeText(file, member.Type()),
			typeNode: member.Type(),
			optional: member.QuestionToken() != nil,
		})
	}
	return props
}

func interfaceBodyFromNode(file *shimast.SourceFile, node *shimast.Node) string {
	if name := node.Name(); name != nil {
		text := file.Text()
		start := name.End()
		end := node.End()
		if start >= 0 && start < len(text) && end > start && end <= len(text) {
			openRel := strings.IndexByte(text[start:end], '{')
			if openRel >= 0 {
				open := start + openRel
				close := findBalanced(text, open, '{', '}')
				if close >= 0 && close <= end {
					return strings.TrimSpace(text[open+1 : close])
				}
			}
		}
	}

	members := []string{}
	for _, member := range node.Members() {
		members = append(members, nodeText(file, member))
	}
	return strings.Join(members, ";")
}

func interfaceExtendsFromNode(file *shimast.SourceFile, node *shimast.Node) []string {
	name := node.Name()
	if name == nil {
		return nil
	}
	text := file.Text()
	start := name.End()
	end := node.End()
	if start < 0 || start >= len(text) || end <= start || end > len(text) {
		return nil
	}
	openRel := strings.IndexByte(text[start:end], '{')
	if openRel < 0 {
		return nil
	}
	return interfaceExtendsFromHeader(text[start : start+openRel])
}

func interfaceExtendsFromHeader(header string) []string {
	header = strings.TrimSpace(stripTypeComments(header))
	if strings.HasPrefix(header, "<") {
		if end := findBalanced(header, 0, '<', '>'); end >= 0 {
			header = strings.TrimSpace(header[end+1:])
		}
	}
	idx := topLevelKeywordIndex(header, "extends")
	if idx < 0 {
		return nil
	}
	refs := []string{}
	for _, part := range splitTop(header[idx+len("extends"):], ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			refs = append(refs, part)
		}
	}
	return refs
}

func topLevelKeywordIndex(input string, keyword string) int {
	depthAngle, depthBrace, depthParen, depthBracket, quote := 0, 0, 0, 0, rune(0)
	for i, r := range input {
		if quote != 0 {
			if r == quote {
				quote = 0
			}
			continue
		}
		switch r {
		case '\'', '"', '`':
			quote = r
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
			depthBracket++
		case ']':
			if depthBracket > 0 {
				depthBracket--
			}
		}
		if depthAngle == 0 && depthBrace == 0 && depthParen == 0 && depthBracket == 0 && strings.HasPrefix(input[i:], keyword) {
			beforeOK := i == 0 || !isIdent(input[i-1])
			after := i + len(keyword)
			afterOK := after >= len(input) || !isIdent(input[after])
			if beforeOK && afterOK {
				return i
			}
		}
	}
	return -1
}

func topLevelColon(input string) int {
	return topLevelByteIndex(input, ':')
}

func topLevelEquals(input string) int {
	return topLevelByteIndex(input, '=')
}

func topLevelByteIndex(input string, target byte) int {
	depthAngle, depthBrace, depthParen, depthBracket, quote := 0, 0, 0, 0, rune(0)
	for i, r := range input {
		if quote != 0 {
			if r == quote {
				quote = 0
			}
			continue
		}
		switch r {
		case '\'', '"', '`':
			quote = r
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
			depthBracket++
		case ']':
			if depthBracket > 0 {
				depthBracket--
			}
		}
		if depthAngle == 0 && depthBrace == 0 && depthParen == 0 && depthBracket == 0 && input[i] == target {
			return i
		}
	}
	return -1
}

func interfaceFullBody(info *fileInfo, reg *registry, decl interfaceInfo, seen map[string]bool) string {
	if seen == nil {
		seen = map[string]bool{}
	}
	key := info.moduleKey + "\x00" + strconv.Itoa(decl.pos)
	if seen[key] {
		return decl.body
	}
	seen[key] = true
	parts := []string{}
	for _, base := range decl.extends {
		baseDecl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, base, decl.pos)
		if !ok {
			continue
		}
		if body := strings.TrimSpace(interfaceFullBody(owner, reg, baseDecl, seen)); body != "" {
			parts = append(parts, body)
		}
	}
	if body := strings.TrimSpace(decl.body); body != "" {
		parts = append(parts, body)
	}
	return strings.Join(parts, ";\n")
}

func interfaceFullProperties(info *fileInfo, reg *registry, decl interfaceInfo, seen map[string]bool) []utilityProperty {
	if seen == nil {
		seen = map[string]bool{}
	}
	key := info.moduleKey + "\x00" + strconv.Itoa(decl.pos)
	if seen[key] {
		return interfaceOwnProperties(info, decl)
	}
	seen[key] = true
	props := []utilityProperty{}
	for _, base := range decl.extends {
		baseDecl, owner, _, ok := resolveInterfaceDeclRefAt(info, reg, base, decl.pos)
		if ok {
			props = append(props, interfaceFullProperties(owner, reg, baseDecl, seen)...)
			continue
		}
		if baseProps, _, ok := utilitySourceProperties(info, reg, base, &typeContext{seen: map[string]bool{}, pos: decl.pos}); ok {
			props = append(props, baseProps...)
		}
	}
	props = append(props, interfaceOwnProperties(info, decl)...)
	return props
}

func interfaceOwnProperties(info *fileInfo, decl interfaceInfo) []utilityProperty {
	if len(decl.properties) != 0 {
		return withUtilityPropertyOwner(decl.properties, info)
	}
	return withUtilityPropertyOwner(propertiesFromBody(decl.body), info)
}

func interfaceImplementsExpr(info *fileInfo, reg *registry, decl interfaceInfo, ctx *typeContext) string {
	items := []string{}
	for _, base := range decl.extends {
		if _, _, _, ok := resolveInterfaceDeclRefAt(info, reg, base, decl.pos); ok {
			continue
		}
		items = append(items, typeExprCtx(info, reg, base, ctx))
	}
	return strings.Join(items, ", ")
}

func interfaceRefName(raw string) string {
	raw = strings.TrimSpace(trimParens(raw))
	if name, _, ok := generic(raw); ok {
		raw = name
	}
	return strings.TrimSpace(raw)
}

func collectImports(info *fileInfo, reg *registry) {
	text := info.file.Text()
	re := regexp.MustCompile(`(?m)import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]`)
	for _, match := range re.FindAllStringSubmatch(text, -1) {
		target := resolveImport(info.file.FileName(), match[2], reg)
		source := ""
		if target != nil {
			source = target.moduleKey
		}
		for _, item := range strings.Split(match[1], ",") {
			item = strings.TrimSpace(item)
			if item == "" {
				continue
			}
			item = strings.TrimSpace(strings.TrimPrefix(item, "type "))
			parts := regexp.MustCompile(`\s+as\s+`).Split(item, 2)
			exportName := strings.TrimSpace(parts[0])
			localName := exportName
			if len(parts) == 2 {
				localName = strings.TrimSpace(parts[1])
			}
			info.imports[localName] = importRef{source: source, exportName: exportName, spec: match[2]}
		}
	}
}

func collectReexports(info *fileInfo, reg *registry) {
	text := info.file.Text()
	starRe := regexp.MustCompile(`(?m)export\s+\*\s+from\s+['"]([^'"]+)['"]`)
	for _, match := range starRe.FindAllStringSubmatch(text, -1) {
		target := resolveImport(info.file.FileName(), match[1], reg)
		if target == nil {
			continue
		}
		info.exportStar = append(info.exportStar, importRef{source: target.moduleKey, exportName: "*", spec: match[1]})
	}

	namedRe := regexp.MustCompile(`(?m)export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]`)
	for _, match := range namedRe.FindAllStringSubmatch(text, -1) {
		target := resolveImport(info.file.FileName(), match[2], reg)
		if target == nil {
			continue
		}
		for _, item := range strings.Split(match[1], ",") {
			item = strings.TrimSpace(item)
			if item == "" {
				continue
			}
			item = strings.TrimSpace(strings.TrimPrefix(item, "type "))
			parts := regexp.MustCompile(`\s+as\s+`).Split(item, 2)
			exportName := strings.TrimSpace(parts[0])
			localName := exportName
			if len(parts) == 2 {
				localName = strings.TrimSpace(parts[1])
			}
			info.reexports[localName] = importRef{source: target.moduleKey, exportName: exportName, spec: match[2]}
		}
	}

	localNamedRe := regexp.MustCompile(`(?m)export\s+(?:type\s+)?\{([^}]+)\}\s*(?:;|$)`)
	for _, match := range localNamedRe.FindAllStringSubmatch(text, -1) {
		for _, item := range strings.Split(match[1], ",") {
			localName, exportName, ok := parseExportItem(item)
			if !ok {
				continue
			}
			if ref, ok := info.imports[localName]; ok {
				info.reexports[exportName] = ref
				continue
			}
			if exportName != localName {
				info.reexports[exportName] = importRef{source: info.moduleKey, exportName: localName}
			}
		}
	}
}

func parseExportItem(item string) (string, string, bool) {
	item = strings.TrimSpace(item)
	if item == "" {
		return "", "", false
	}
	item = strings.TrimSpace(strings.TrimPrefix(item, "type "))
	parts := regexp.MustCompile(`\s+as\s+`).Split(item, 2)
	localName := strings.TrimSpace(parts[0])
	exportName := localName
	if len(parts) == 2 {
		exportName = strings.TrimSpace(parts[1])
	}
	if localName == "" || exportName == "" {
		return "", "", false
	}
	return localName, exportName, true
}

func collectGenericCalls(info *fileInfo, reg *registry) {
	calls := []callInfo{}
	seen := map[int]bool{}
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		if node.Kind == shimast.KindCallExpression {
			call := node.AsCallExpression()
			if received, ok := resolvedReceiveTypeCall(info, reg, node); ok {
				calls = append(calls, received)
				seen[node.Pos()] = true
			}
			typeArgs := node.TypeArguments()
			if len(typeArgs) > 0 && !seen[node.Pos()] {
				name, metadataArgIndex, recognized := metadataCallDetails(reg, call)
				if recognized {
					argumentCount := 0
					if call.Arguments != nil {
						argumentCount = len(call.Arguments.Nodes)
					}
					if argumentCount <= metadataArgIndex {
						calls = append(calls, callInfo{
							name:             name,
							nodePos:          node.Pos(),
							metadataArgIndex: metadataArgIndex,
							typeText:         nodeText(info.file, typeArgs[0]),
							typeNode:         typeArgs[0],
							preferTypia:      true,
							pos:              node.Pos(),
						})
					}
				}
			}
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(info.file.AsNode())
	fallbackCalls := collectReceiveTypeCalls(info, reg)
	matchCallNodePositions(info.file, fallbackCalls)
	for _, call := range fallbackCalls {
		if call.nodePos >= 0 && seen[call.nodePos] {
			continue
		}
		calls = append(calls, call)
		if call.nodePos >= 0 {
			seen[call.nodePos] = true
		}
	}
	sort.Slice(calls, func(i, j int) bool { return calls[i].pos < calls[j].pos })
	matchCallNodePositions(info.file, calls)
	info.calls = calls
}

func isMetadataCallName(name string) bool {
	switch name {
	case "deserialize", "validate", "validatedDeserialize", "typeOf":
		return true
	default:
		return false
	}
}

func metadataCallDetails(reg *registry, call *shimast.CallExpression) (string, int, bool) {
	if reg == nil || reg.checker == nil || call == nil {
		return "", 0, false
	}
	signature := reg.checker.GetResolvedSignature(call.AsNode())
	if signature == nil {
		return "", 0, false
	}
	declaration := signature.Declaration()
	if declaration == nil {
		return "", 0, false
	}
	source := shimast.GetSourceFileOfNode(declaration)
	if source == nil || !isFoundationMetadataDeclarationFile(source.FileName()) {
		return "", 0, false
	}
	name := ""
	if declaration.Name() != nil {
		name = declaration.Name().Text()
	}
	if name == "" {
		if typ := reg.checker.GetTypeAtLocation(declaration); typ != nil && typ.Symbol() != nil {
			name = typ.Symbol().Name
		}
	}
	switch name {
	case "typeOf":
		return name, 0, true
	case "deserialize", "validate":
		return name, 1, true
	case "assert", "is":
		return name, 2, true
	case "cast", "validatedDeserialize":
		return name, 4, true
	default:
		return "", 0, false
	}
}

func isFoundationMetadataDeclarationFile(fileName string) bool {
	slash := filepath.ToSlash(fileName)
	if !strings.Contains(slash, "/ts-server-foundation/") {
		return false
	}
	for _, suffix := range []string{
		"/src/reflection/conversion.ts",
		"/src/reflection/conversion.d.ts",
		"/dist/src/reflection/conversion.d.ts",
		"/src/reflection/reflection-class.ts",
		"/src/reflection/reflection-class.d.ts",
		"/dist/src/reflection/reflection-class.d.ts",
	} {
		if strings.HasSuffix(slash, suffix) {
			return true
		}
	}
	return false
}

func matchCallNodePositions(file *shimast.SourceFile, calls []callInfo) {
	if file == nil || len(calls) == 0 {
		return
	}
	type candidate struct {
		pos   int
		end   int
		start int
	}
	candidates := []candidate{}
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		if node.Kind == shimast.KindCallExpression {
			call := node.AsCallExpression()
			start := node.Pos()
			end := node.End()
			if call != nil && call.Expression != nil {
				start = call.Expression.Pos()
				end = call.Expression.End()
			}
			candidates = append(candidates, candidate{pos: node.Pos(), start: start, end: end})
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(file.AsNode())
	for index := range calls {
		if calls[index].nodePos >= 0 {
			continue
		}
		bestSpan := 0
		for _, item := range candidates {
			if item.start <= calls[index].pos && calls[index].pos < item.end {
				span := item.end - item.start
				if bestSpan == 0 || span < bestSpan {
					calls[index].nodePos = item.pos
					bestSpan = span
				}
			}
		}
	}
}

func isFoundationCompatibilityImport(ref importRef) bool {
	if ref.spec == foundationPackageSpec {
		return true
	}
	source := filepath.ToSlash(ref.source)
	if !strings.Contains(source, "/ts-server-foundation/src/") {
		return false
	}
	return strings.HasSuffix(source, "/src/index") ||
		strings.HasSuffix(source, "/src/types/index") ||
		strings.HasSuffix(source, "/src/reflection/index") ||
		strings.HasSuffix(source, "/src/reflection/conversion")
}
