package main

import (
	"regexp"
	"sort"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	schemametadata "github.com/samchon/typia/packages/typia/native/core/schemas/metadata"
)

// jsDocInfo is the parsed form of a JSDoc comment.
//
// summary is the first paragraph with its lines joined by spaces. body holds the remaining
// description paragraphs with line and paragraph breaks preserved so Markdown lists and code
// fences survive. Only the documented tags (@param, @returns/@return, @deprecated, @sunset)
// are retained; unknown tags are ignored.
type jsDocInfo struct {
	summary       string
	body          string
	params        map[string]string
	returns       string
	hasReturns    bool
	deprecated    string
	hasDeprecated bool
	sunset        string
}

var jsDocSunsetPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// parseJsDoc parses the raw text of a `/** ... */` comment.
func parseJsDoc(raw string) jsDocInfo {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "/**")
	raw = strings.TrimSuffix(raw, "*/")
	rawLines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")

	lines := make([]string, 0, len(rawLines))
	for index, line := range rawLines {
		lines = append(lines, stripJsDocLinePrefix(line, index == 0))
	}

	var doc jsDocInfo
	descriptionLines := []string{}
	type tagState struct {
		name  string
		lines []string
	}
	var tags []tagState
	fence := ""
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		inFence := fence != ""
		fence = updateJsDocFence(fence, trimmed)
		if len(tags) == 0 {
			if !inFence && fence == "" && strings.HasPrefix(trimmed, "@") {
				name, rest := splitJsDocTag(trimmed)
				tags = append(tags, tagState{name: name, lines: []string{rest}})
				continue
			}
			descriptionLines = append(descriptionLines, strings.TrimRight(line, " \t"))
			continue
		}
		if !inFence && fence == "" && strings.HasPrefix(trimmed, "@") {
			name, rest := splitJsDocTag(trimmed)
			tags = append(tags, tagState{name: name, lines: []string{rest}})
			continue
		}
		tags[len(tags)-1].lines = append(tags[len(tags)-1].lines, trimmed)
	}

	doc.summary, doc.body = splitJsDocDescription(descriptionLines)

	for _, tag := range tags {
		text := joinJsDocTagLines(tag.lines)
		switch tag.name {
		case "param":
			name, description := parseJsDocParam(text)
			if name == "" {
				continue
			}
			if doc.params == nil {
				doc.params = map[string]string{}
			}
			doc.params[name] = description
		case "returns", "return":
			doc.returns = stripJsDocType(text)
			doc.hasReturns = true
		case "deprecated":
			doc.deprecated = text
			doc.hasDeprecated = true
		case "sunset":
			value := strings.Fields(text)
			if len(value) > 0 && jsDocSunsetPattern.MatchString(value[0]) {
				doc.sunset = value[0]
			}
		}
	}
	return doc
}

// stripJsDocLinePrefix removes the leading whitespace, the `*` gutter and one following space.
// Any further indentation is kept so nested lists and code blocks retain their shape.
func stripJsDocLinePrefix(line string, first bool) string {
	line = strings.TrimRight(line, "\r")
	trimmed := strings.TrimLeft(line, " \t")
	if !first || strings.HasPrefix(trimmed, "*") {
		if strings.HasPrefix(trimmed, "*") {
			trimmed = trimmed[1:]
			return strings.TrimPrefix(trimmed, " ")
		}
		return trimmed
	}
	return strings.TrimPrefix(trimmed, " ")
}

func splitJsDocTag(line string) (string, string) {
	line = strings.TrimPrefix(line, "@")
	end := strings.IndexAny(line, " \t")
	if end < 0 {
		return line, ""
	}
	return line[:end], strings.TrimSpace(line[end:])
}

func joinJsDocTagLines(lines []string) string {
	var out strings.Builder
	pendingBreak := false
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			pendingBreak = out.Len() > 0
			continue
		}
		if out.Len() > 0 {
			if pendingBreak {
				out.WriteString("\n\n")
			} else {
				out.WriteString(" ")
			}
		}
		pendingBreak = false
		out.WriteString(line)
	}
	return out.String()
}

var jsDocParamPattern = regexp.MustCompile(`^(\[[^\]\s]+\]|\S+)\s*(?:-\s*)?(?s:(.*))$`)

// stripJsDocType removes one leading balanced `{...}` type expression.
func stripJsDocType(text string) string {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "{") {
		return text
	}
	depth := 0
	for index, char := range text {
		switch char {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return strings.TrimSpace(text[index+1:])
			}
		}
	}
	return text
}

// jsDocFenceOpener returns the fence marker (a run of three or more backticks or tildes) that
// starts the line, or "".
func jsDocFenceOpener(trimmed string) string {
	if trimmed == "" || (trimmed[0] != '`' && trimmed[0] != '~') {
		return ""
	}
	run := 0
	for run < len(trimmed) && trimmed[run] == trimmed[0] {
		run++
	}
	if run < 3 {
		return ""
	}
	return trimmed[:run]
}

// updateJsDocFence tracks fenced code blocks. A fence closes only on a bare line of the same
// character that opened it, at least as long as the opener.
func updateJsDocFence(fence string, trimmed string) string {
	if fence == "" {
		return jsDocFenceOpener(trimmed)
	}
	closer := jsDocFenceOpener(trimmed)
	if closer != "" && closer[0] == fence[0] && len(closer) >= len(fence) && strings.TrimSpace(trimmed[len(closer):]) == "" {
		return ""
	}
	return fence
}

func parseJsDocParam(text string) (string, string) {
	match := jsDocParamPattern.FindStringSubmatch(stripJsDocType(text))
	if match == nil {
		return "", ""
	}
	name := match[1]
	if strings.HasPrefix(name, "[") && strings.HasSuffix(name, "]") {
		name = name[1 : len(name)-1]
		if eq := strings.Index(name, "="); eq >= 0 {
			name = name[:eq]
		}
	}
	return name, strings.TrimSpace(match[2])
}

// splitJsDocDescription splits description lines into the first paragraph (summary, joined by
// spaces) and the remaining paragraphs (body, line breaks preserved). Blank lines inside a
// fenced code block do not end a paragraph.
func splitJsDocDescription(lines []string) (string, string) {
	paragraphs := [][]string{}
	current := []string{}
	fence := ""
	flush := func() {
		if len(current) > 0 {
			paragraphs = append(paragraphs, current)
			current = []string{}
		}
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		wasInFence := fence != ""
		fence = updateJsDocFence(fence, trimmed)
		if !wasInFence && fence != "" && len(paragraphs) == 0 {
			// The summary stops where a fenced block begins.
			flush()
		}
		if trimmed == "" && fence == "" {
			flush()
			continue
		}
		if trimmed == "" && len(current) == 0 {
			continue
		}
		current = append(current, line)
	}
	flush()
	if len(paragraphs) == 0 {
		return "", ""
	}
	summaryParts := []string{}
	for _, line := range paragraphs[0] {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			summaryParts = append(summaryParts, trimmed)
		}
	}
	bodyParts := []string{}
	for _, paragraph := range paragraphs[1:] {
		bodyParts = append(bodyParts, strings.TrimRight(strings.Join(paragraph, "\n"), "\n \t"))
	}
	return strings.Join(summaryParts, " "), strings.Join(bodyParts, "\n\n")
}

// description is the summary and body joined with a blank line.
func (doc jsDocInfo) description() string {
	if doc.summary != "" && doc.body != "" {
		return doc.summary + "\n\n" + doc.body
	}
	if doc.summary != "" {
		return doc.summary
	}
	return doc.body
}

// docsExpr renders the method-level `docs` metadata object, or "" when there is nothing to emit.
func (doc jsDocInfo) docsExpr() string {
	items := []string{}
	if doc.body != "" {
		items = append(items, "body: "+quote(doc.body))
	}
	if len(doc.params) != 0 {
		names := make([]string, 0, len(doc.params))
		for name := range doc.params {
			names = append(names, name)
		}
		sort.Strings(names)
		entries := make([]string, 0, len(names))
		for _, name := range names {
			entries = append(entries, quote(name)+": "+quote(doc.params[name]))
		}
		items = append(items, "params: {"+strings.Join(entries, ", ")+"}")
	}
	if doc.hasReturns {
		items = append(items, "returns: "+quote(doc.returns))
	}
	if doc.hasDeprecated {
		items = append(items, "deprecated: "+quote(doc.deprecated))
	}
	if doc.sunset != "" {
		items = append(items, "sunset: "+quote(doc.sunset))
	}
	if len(items) == 0 {
		return ""
	}
	return "{" + strings.Join(items, ", ") + "}"
}

// fieldItems renders `description`, `deprecated` and `sunset` entries for properties, parameters
// and declarations.
func (doc jsDocInfo) fieldItems() []string {
	items := []string{}
	if description := doc.description(); description != "" {
		items = append(items, "description: "+quote(description))
	}
	if doc.hasDeprecated {
		items = append(items, "deprecated: "+quote(doc.deprecated))
	}
	if doc.sunset != "" {
		items = append(items, "sunset: "+quote(doc.sunset))
	}
	return items
}

func (doc jsDocInfo) empty() bool {
	return doc.summary == "" && doc.body == "" && len(doc.params) == 0 && !doc.hasReturns && !doc.hasDeprecated && doc.sunset == ""
}

func jsDocForNode(file *shimast.SourceFile, node *shimast.Node) jsDocInfo {
	if node == nil {
		return jsDocInfo{}
	}
	docs := node.JSDoc(file)
	if len(docs) == 0 {
		return jsDocInfo{}
	}
	doc := docs[len(docs)-1]
	text := file.Text()[doc.Pos():doc.End()]
	// The node's JSDoc range can begin at a trailing or preceding comment; start at the `/**`.
	if start := strings.LastIndex(text, "/**"); start > 0 {
		text = text[start:]
	}
	return parseJsDoc(text)
}

// typiaJsDoc converts the documentation typia collected for a checker-resolved property or type
// into the same shape the AST parser produces. Only description, @deprecated and @sunset are kept.
func typiaJsDoc(description *string, tags []schemametadata.IJsDocTagInfo) jsDocInfo {
	var doc jsDocInfo
	if description != nil {
		doc.summary, doc.body = splitJsDocDescription(strings.Split(strings.ReplaceAll(*description, "\r\n", "\n"), "\n"))
	}
	for _, tag := range tags {
		var text strings.Builder
		for _, piece := range tag.Text {
			text.WriteString(piece.Text)
		}
		value := joinJsDocTagLines(strings.Split(text.String(), "\n"))
		switch tag.Name {
		case "deprecated":
			doc.deprecated = value
			doc.hasDeprecated = true
		case "sunset":
			if fields := strings.Fields(value); len(fields) > 0 && jsDocSunsetPattern.MatchString(fields[0]) {
				doc.sunset = fields[0]
			}
		}
	}
	return doc
}
