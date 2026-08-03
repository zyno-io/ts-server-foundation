package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

func plainValue(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "{}"
	}
	raw = trimParens(raw)
	if isObjectLiteralTypeText(raw) {
		inner := strings.TrimSpace(raw[1 : len(raw)-1])
		fields := splitTop(inner, ";")
		if len(fields) == 1 {
			fields = splitTop(inner, ",")
		}
		props := []string{}
		for _, field := range fields {
			field = strings.TrimSpace(field)
			if field == "" {
				continue
			}
			name, value, ok := strings.Cut(field, ":")
			if !ok {
				continue
			}
			props = append(props, strings.TrimSpace(name)+": "+plainValue(value))
		}
		return "{" + strings.Join(props, ", ") + "}"
	}
	if strings.HasPrefix(raw, "\"") || strings.HasPrefix(raw, "'") {
		return normalizeStringLiteral(raw)
	}
	if raw == "true" || raw == "false" || raw == "null" || raw == "undefined" {
		return raw
	}
	if _, err := strconv.ParseFloat(raw, 64); err == nil {
		return raw
	}
	return typeExpr(&fileInfo{aliases: map[string]aliasInfo{}, imports: map[string]importRef{}}, &registry{byPath: map[string]*fileInfo{}}, raw)
}

func literalArg(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "\"") || strings.HasPrefix(raw, "'") {
		return "{kind: 10, literal: " + normalizeStringLiteral(raw) + "}"
	}
	return "{kind: 10, literal: " + raw + "}"
}

func splitTop(input string, sep string) []string {
	input = stripTypeComments(input)
	parts := []string{}
	start, depthAngle, depthBrace, depthParen, depthBracket, quote := 0, 0, 0, 0, 0, byte(0)
	for i := 0; i < len(input); i++ {
		c := input[i]
		if quote != 0 {
			if c == '\\' {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
		case '`':
			i = skipTemplateLiteral(input, i)
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
		default:
			if strings.HasPrefix(input[i:], sep) && depthAngle == 0 && depthBrace == 0 && depthParen == 0 && depthBracket == 0 {
				parts = append(parts, strings.TrimSpace(input[start:i]))
				start = i + len(sep)
				i += len(sep) - 1
			}
		}
	}
	parts = append(parts, strings.TrimSpace(input[start:]))
	return parts
}

func nonEmptyParts(parts []string) []string {
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func skipTemplateLiteral(text string, start int) int {
	for i := start + 1; i < len(text); i++ {
		c := text[i]
		next := byte(0)
		if i+1 < len(text) {
			next = text[i+1]
		}
		if c == '\\' {
			i++
			continue
		}
		if c == '`' {
			return i
		}
		if c == '$' && next == '{' {
			end := findTemplateExpressionEnd(text, i+2)
			if end < 0 {
				return len(text) - 1
			}
			i = end
		}
	}
	return len(text) - 1
}

func findTemplateExpressionEnd(text string, start int) int {
	depth := 1
	quote := byte(0)
	lineComment := false
	blockComment := false
	for i := start; i < len(text); i++ {
		c := text[i]
		next := byte(0)
		if i+1 < len(text) {
			next = text[i+1]
		}
		if lineComment {
			if c == '\n' || c == '\r' {
				lineComment = false
			}
			continue
		}
		if blockComment {
			if c == '*' && next == '/' {
				blockComment = false
				i++
			}
			continue
		}
		if quote != 0 {
			if c == '\\' {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '/' && next == '/' {
			lineComment = true
			i++
			continue
		}
		if c == '/' && next == '*' {
			blockComment = true
			i++
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if c == '`' {
			i = skipTemplateLiteral(text, i)
			continue
		}
		if c == '{' {
			depth++
		} else if c == '}' {
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

func generic(raw string) (string, []string, bool) {
	raw = strings.TrimSpace(raw)
	idx := strings.Index(raw, "<")
	if idx < 0 || !strings.HasSuffix(raw, ">") {
		return raw, nil, false
	}
	name := strings.TrimSpace(raw[:idx])
	args := splitTop(raw[idx+1:len(raw)-1], ",")
	return name, args, true
}

func splitInterfaceFields(body string) []string {
	body = stripTypeComments(body)
	body = strings.ReplaceAll(body, "\r\n", "\n")
	body = strings.ReplaceAll(body, "\r", "\n")
	parts := []string{}
	start, depthAngle, depthBrace, depthParen, depthBracket, quote := 0, 0, 0, 0, 0, rune(0)
	for i, r := range body {
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
		case ';', ',', '\n':
			if depthAngle == 0 && depthBrace == 0 && depthParen == 0 && depthBracket == 0 {
				if r == '\n' && isTypeContinuationNewline(body, start, i) {
					continue
				}
				parts = append(parts, strings.TrimSpace(body[start:i]))
				start = i + len(string(r))
			}
		}
	}
	parts = append(parts, strings.TrimSpace(body[start:]))
	return parts
}

func isTypeContinuationNewline(body string, start int, newline int) bool {
	before := strings.TrimSpace(body[start:newline])
	if before == "" {
		return false
	}
	if strings.HasSuffix(before, "&") || strings.HasSuffix(before, "|") {
		return true
	}
	after := strings.TrimLeft(body[newline+1:], " \t\n")
	return strings.HasPrefix(after, "&") || strings.HasPrefix(after, "|")
}

func stripTypeComments(body string) string {
	if !strings.Contains(body, "/") {
		return body
	}
	var out strings.Builder
	out.Grow(len(body))
	for i := 0; i < len(body); i++ {
		current := body[i]
		next := byte(0)
		if i+1 < len(body) {
			next = body[i+1]
		}
		if current == '\'' || current == '"' {
			quote := current
			out.WriteByte(current)
			for i++; i < len(body); i++ {
				out.WriteByte(body[i])
				if body[i] == '\\' && i+1 < len(body) {
					i++
					out.WriteByte(body[i])
					continue
				}
				if body[i] == quote {
					break
				}
			}
			continue
		}
		if current == '`' {
			end := skipTemplateLiteral(body, i)
			out.WriteString(body[i : end+1])
			i = end
			continue
		}
		if current == '/' && next == '/' {
			out.WriteString("  ")
			i += 2
			for ; i < len(body) && body[i] != '\n' && body[i] != '\r'; i++ {
				out.WriteByte(' ')
			}
			if i < len(body) {
				out.WriteByte(body[i])
			}
			continue
		}
		if current == '/' && next == '*' {
			out.WriteString("  ")
			i += 2
			for ; i < len(body); i++ {
				if body[i] == '*' && i+1 < len(body) && body[i+1] == '/' {
					out.WriteString("  ")
					i++
					break
				}
				if body[i] == '\n' || body[i] == '\r' {
					out.WriteByte(body[i])
				} else {
					out.WriteByte(' ')
				}
			}
			continue
		}
		out.WriteByte(current)
	}
	return out.String()
}

func parseField(field string) (string, string, bool, bool) {
	field = strings.TrimSpace(field)
	if field == "" {
		return "", "", false, false
	}
	if strings.HasPrefix(field, "[") || strings.HasPrefix(field, "new ") || strings.HasPrefix(field, "abstract new ") || strings.HasPrefix(field, "(") {
		return "", "", false, false
	}
	name, rest, ok := strings.Cut(field, ":")
	if !ok {
		return "", "", false, false
	}
	name = strings.TrimSpace(name)
	if strings.Contains(name, "(") || strings.Contains(name, ")") {
		return "", "", false, false
	}
	optional := strings.HasSuffix(name, "?")
	name = strings.TrimSuffix(name, "?")
	if (strings.HasPrefix(name, "'") && strings.HasSuffix(name, "'")) || (strings.HasPrefix(name, "\"") && strings.HasSuffix(name, "\"")) {
		name = literalStringValue(name)
	}
	return name, strings.TrimSpace(rest), optional, true
}

func indexSignatureType(body string) (string, bool) {
	for _, field := range splitInterfaceFields(body) {
		field = strings.TrimSpace(field)
		if !strings.HasPrefix(field, "[") {
			continue
		}
		close := strings.Index(field, "]")
		if close < 0 {
			continue
		}
		rest := strings.TrimSpace(field[close+1:])
		if !strings.HasPrefix(rest, ":") {
			continue
		}
		indexType := strings.TrimSpace(rest[1:])
		if indexType != "" {
			return indexType, true
		}
	}
	return "", false
}

func isFunctionTypeSyntax(raw string) bool {
	raw = strings.TrimSpace(raw)
	return strings.Contains(raw, "=>") || strings.HasPrefix(raw, "new ") || strings.HasPrefix(raw, "abstract new ")
}

func isUnsupportedTypeSyntax(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false
	}
	if len(raw) == 1 && raw[0] >= 'A' && raw[0] <= 'Z' {
		return true
	}
	if containsUnsupportedSyntaxMarker(raw) {
		return true
	}
	if strings.HasPrefix(raw, "keyof ") || strings.Contains(raw, " keyof ") || strings.Contains(raw, " in ") || strings.Contains(raw, " infer ") {
		return true
	}
	return false
}

func containsUnsupportedSyntaxMarker(raw string) bool {
	quote := byte(0)
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if quote != 0 {
			if c == '\\' {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
		case '`':
			i = skipTemplateLiteral(raw, i)
		case '[', ']', ':', '?':
			return true
		}
	}
	return false
}

func hasUnresolvedTypeParameters(raw string, params []string) bool {
	for _, param := range params {
		param = strings.TrimSpace(param)
		if param == "" {
			continue
		}
		if regexp.MustCompile(`\b` + regexp.QuoteMeta(param) + `\b`).MatchString(raw) {
			return true
		}
	}
	return false
}

func findBalanced(text string, open int, left byte, right byte) int {
	depth := 0
	quote := byte(0)
	lineComment := false
	blockComment := false
	for i := open; i < len(text); i++ {
		c := text[i]
		next := byte(0)
		if i+1 < len(text) {
			next = text[i+1]
		}
		if lineComment {
			if c == '\n' || c == '\r' {
				lineComment = false
			}
			continue
		}
		if blockComment {
			if c == '*' && next == '/' {
				blockComment = false
				i++
			}
			continue
		}
		if quote != 0 {
			if c == '\\' {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if c == '`' {
			i = skipTemplateLiteral(text, i)
			continue
		}
		if c == '/' && next == '/' {
			lineComment = true
			i++
			continue
		}
		if c == '/' && next == '*' {
			blockComment = true
			i++
			continue
		}
		if c == left {
			depth++
		} else if c == right {
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

func skipSpace(text string, pos int) int {
	for pos < len(text) && (text[pos] == ' ' || text[pos] == '\n' || text[pos] == '\r' || text[pos] == '\t') {
		pos++
	}
	return pos
}

func isIdent(c byte) bool {
	return c == '_' || c == '$' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
}

func isIdentifierName(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if !isIdent(c) || (i == 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

func trimParens(raw string) string {
	for strings.HasPrefix(raw, "(") && strings.HasSuffix(raw, ")") {
		end := findBalanced(raw, 0, '(', ')')
		if end != len(raw)-1 {
			break
		}
		raw = strings.TrimSpace(raw[1 : len(raw)-1])
	}
	return raw
}

func isObjectLiteralTypeText(raw string) bool {
	raw = strings.TrimSpace(raw)
	return strings.HasPrefix(raw, "{") &&
		strings.HasSuffix(raw, "}") &&
		findBalanced(raw, 0, '{', '}') == len(raw)-1
}

func firstArg(args []string) string {
	if len(args) == 0 {
		return "unknown"
	}
	return args[0]
}

func firstOptionArg(args []string) string {
	if len(args) == 0 {
		return ""
	}
	return args[0]
}

func optionArg(args []string, index int) string {
	if index < len(args) && strings.TrimSpace(args[index]) != "" {
		return args[index]
	}
	return "{}"
}

func aliasParamName(alias aliasInfo, index int) string {
	if index < len(alias.params) && alias.params[index] != "" {
		return alias.params[index]
	}
	return fmt.Sprintf("T%d", index)
}

func aliasArg(alias aliasInfo, args []string, index int) string {
	if index < len(args) && strings.TrimSpace(args[index]) != "" {
		return args[index]
	}
	if index < len(alias.defaults) && strings.TrimSpace(alias.defaults[index]) != "" {
		return alias.defaults[index]
	}
	return "unknown"
}

func replaceTypeParameter(input string, name string, value string) string {
	re := regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\b`)
	return re.ReplaceAllString(input, value)
}

func normalizeStringLiteral(raw string) string {
	if value, ok := tsStringLiteralValue(raw); ok {
		return strconv.Quote(value)
	}
	return strings.TrimSpace(raw)
}

func literalStringValue(raw string) string {
	if value, ok := tsStringLiteralValue(raw); ok {
		return value
	}
	raw = strings.TrimSpace(raw)
	value, err := strconv.Unquote(raw)
	if err == nil {
		return value
	}
	return raw
}

func tsStringLiteralValue(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if len(raw) < 2 {
		return "", false
	}
	quote := raw[0]
	if (quote != '\'' && quote != '"' && quote != '`') || raw[len(raw)-1] != quote {
		return "", false
	}
	return decodeTsStringEscapes(raw[1 : len(raw)-1]), true
}

func decodeTsStringEscapes(value string) string {
	var out strings.Builder
	out.Grow(len(value))
	for i := 0; i < len(value); i++ {
		ch := value[i]
		if ch != '\\' || i+1 >= len(value) {
			out.WriteByte(ch)
			continue
		}
		i++
		switch next := value[i]; next {
		case '0':
			out.WriteByte(0)
		case 'b':
			out.WriteByte('\b')
		case 'f':
			out.WriteByte('\f')
		case 'n':
			out.WriteByte('\n')
		case 'r':
			out.WriteByte('\r')
		case 't':
			out.WriteByte('\t')
		case 'v':
			out.WriteByte('\v')
		case '\n':
			continue
		case '\r':
			if i+1 < len(value) && value[i+1] == '\n' {
				i++
			}
			continue
		case 'x':
			if i+2 < len(value) {
				if parsed, err := strconv.ParseInt(value[i+1:i+3], 16, 32); err == nil {
					out.WriteRune(rune(parsed))
					i += 2
					continue
				}
			}
			out.WriteByte(next)
		case 'u':
			if i+1 < len(value) && value[i+1] == '{' {
				end := strings.IndexByte(value[i+2:], '}')
				if end >= 0 {
					digits := value[i+2 : i+2+end]
					if parsed, err := strconv.ParseInt(digits, 16, 32); err == nil {
						out.WriteRune(rune(parsed))
						i += end + 2
						continue
					}
				}
			}
			if i+4 < len(value) {
				if parsed, err := strconv.ParseInt(value[i+1:i+5], 16, 32); err == nil {
					out.WriteRune(rune(parsed))
					i += 4
					continue
				}
			}
			out.WriteByte(next)
		default:
			out.WriteByte(next)
		}
	}
	return out.String()
}

func isLiteralStringType(raw string) bool {
	raw = strings.TrimSpace(raw)
	return len(raw) >= 2 && ((raw[0] == '\'' && raw[len(raw)-1] == '\'') || (raw[0] == '"' && raw[len(raw)-1] == '"'))
}

func quote(value string) string {
	return strconv.Quote(value)
}

func boolLit(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func mapJoin(values []string, mapper func(string) string) string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, mapper(value))
	}
	return strings.Join(out, ", ")
}
