package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/samchon/ttsc/packages/ttsc/driver"
	schemametadata "github.com/samchon/typia/packages/typia/native/core/schemas/metadata"
)

func TestParseJsDocSummaryIsTheFirstParagraph(t *testing.T) {
	doc := parseJsDoc(`/**
 * List users using the documented summary.
 * Continues on the next line.
 *
 * This detail is not part of the summary.
 * @returns users
 */`)
	if doc.summary != "List users using the documented summary. Continues on the next line." {
		t.Fatalf("summary = %q", doc.summary)
	}
	if doc.body != "This detail is not part of the summary." {
		t.Fatalf("body = %q", doc.body)
	}
	if !doc.hasReturns || doc.returns != "users" {
		t.Fatalf("returns = %q (%v)", doc.returns, doc.hasReturns)
	}
}

func TestParseJsDocBodyPreservesMarkdownStructure(t *testing.T) {
	doc := parseJsDoc("/**\n * Summary.\n *\n * Options:\n * - one\n *   - nested\n * - two\n *\n * ```ts\n * const a = 1;\n *\n * // @param not a tag\n * ```\n * @deprecated Use x.\n */")
	want := "Options:\n- one\n  - nested\n- two\n\n```ts\nconst a = 1;\n\n// @param not a tag\n```"
	if doc.body != want {
		t.Fatalf("body = %q, want %q", doc.body, want)
	}
	if doc.summary != "Summary." {
		t.Fatalf("summary = %q", doc.summary)
	}
	if !doc.hasDeprecated || doc.deprecated != "Use x." {
		t.Fatalf("deprecated = %q", doc.deprecated)
	}
	if len(doc.params) != 0 {
		t.Fatalf("params = %v", doc.params)
	}
}

func TestParseJsDocTags(t *testing.T) {
	doc := parseJsDoc(`/**
 * Does it.
 * @param id - The user id.
 * @param {string} name The display name,
 *   spanning lines.
 * @param [limit] Optional limit.
 * @return The result.
 * @unknown ignored
 * @deprecated
 * @sunset 2027-03-01 trailing words
 */`)
	wantParams := map[string]string{
		"id":    "The user id.",
		"name":  "The display name, spanning lines.",
		"limit": "Optional limit.",
	}
	if !reflect.DeepEqual(doc.params, wantParams) {
		t.Fatalf("params = %v", doc.params)
	}
	if doc.returns != "The result." {
		t.Fatalf("returns = %q", doc.returns)
	}
	if !doc.hasDeprecated || doc.deprecated != "" {
		t.Fatalf("deprecated = %q (%v)", doc.deprecated, doc.hasDeprecated)
	}
	if doc.sunset != "2027-03-01" {
		t.Fatalf("sunset = %q", doc.sunset)
	}
	if got := parseJsDoc("/** @sunset soon */").sunset; got != "" {
		t.Fatalf("invalid sunset kept: %q", got)
	}
}

func TestParseJsDocSingleLineAndEmpty(t *testing.T) {
	if got := parseJsDoc("/** Short text. */"); got.summary != "Short text." || got.body != "" {
		t.Fatalf("single-line doc = %+v", got)
	}
	if got := parseJsDoc("/** @deprecated Use other. */"); got.summary != "" || got.deprecated != "Use other." {
		t.Fatalf("deprecated-only doc = %+v", got)
	}
	if !parseJsDoc("/** */").empty() {
		t.Fatal("empty doc should be empty")
	}
}

func TestJsDocEmission(t *testing.T) {
	doc := parseJsDoc("/**\n * Summary.\n *\n * More.\n * @param a - A.\n * @returns R\n * @deprecated Old.\n * @sunset 2027-01-01\n */")
	if got := doc.docsExpr(); got != `{body: "More.", params: {"a": "A."}, returns: "R", deprecated: "Old.", sunset: "2027-01-01"}` {
		t.Fatalf("docs = %s", got)
	}
	if got := strings.Join(doc.fieldItems(), "|"); got != `description: "Summary.\n\nMore."|deprecated: "Old."|sunset: "2027-01-01"` {
		t.Fatalf("fieldItems = %s", got)
	}
	if got := parseJsDoc("/** Only summary. */").docsExpr(); got != "" {
		t.Fatalf("docs should be omitted, got %s", got)
	}
}

func TestSourceJsDocReachesMetadata(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "tsconfig.json"), []byte(`{
		"compilerOptions": {"strict": true, "target": "ESNext", "experimentalDecorators": true},
		"include": ["*.ts"],
		"reflection": true
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs.ts"), []byte(`
/**
 * A thing.
 *
 * Longer text.
 */
export class Thing {
	/**
	 * The id.
	 * @deprecated use uid
	 */
	id!: number;
	/**
	 * Display name.
	 * @sunset 2027-02-03
	 */
	name?: string;

	/**
	 * Rename.
	 *
	 * Details.
	 * @param value - The new name.
	 * @returns nothing
	 */
	rename(/** The value. */ value: string, /** @deprecated stop */ legacy?: string): void {}
}

/** Shape doc. */
export interface Shape {
	/**
	 * Width in px.
	 * @deprecated use w
	 */
	width: number;
	height: number;
}

/**
 * Alias doc.
 */
export type Alias = { a: string };
`), 0o600); err != nil {
		t.Fatal(err)
	}

	program, diagnostics, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{SingleThreaded: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %v", diagnostics)
	}
	defer func() { _ = program.Close() }()

	reg := collectRegistry(program, root, true, true)
	var info *fileInfo
	for _, candidate := range reg.files {
		if candidate != nil && candidate.file != nil && filepath.Base(candidate.file.FileName()) == "docs.ts" {
			info = candidate
		}
	}
	if info == nil {
		t.Fatal("docs.ts was not collected")
	}

	class := reg.classes["Thing"]
	if class == nil {
		t.Fatal("Thing was not collected")
	}
	got := classMetadata(info, reg, class, nil)
	assertContainsAll(t, got,
		`typeName: "Thing", description: "A thing.\n\nLonger text."`,
		`name: "id", type: {kind: 7}, optional: false, description: "The id.", deprecated: "use uid"`,
		`name: "name", type: {kind: 6}, optional: true, description: "Display name.", sunset: "2027-02-03"`,
		`description: "Rename.", docs: {body: "Details.", params: {"value": "The new name."}, returns: "nothing"}`,
		`{name: "value", type: {kind: 6}, optional: false, default: false, description: "The value."}`,
		`{name: "legacy", type: {kind: 6}, optional: true, default: false, deprecated: "stop"}`,
	)

	shape := interfaceExprForTest(info, reg, "Shape")
	assertContainsAll(t, shape,
		`description: "Shape doc."`,
		`{kind: 20, name: "width", type: {kind: 7}, optional: false, description: "Width in px.", deprecated: "use w"}`,
		`{kind: 20, name: "height", type: {kind: 7}, optional: false}`,
	)

	alias := info.aliases["Alias"]
	if expr := withTypeDocs(withTypeName(cachedAliasTypeExpr(info, reg, alias), "Alias"), alias.doc); !strings.Contains(expr, `description: "Alias doc."`) {
		t.Fatalf("alias metadata = %s", expr)
	}
}

func interfaceExprForTest(info *fileInfo, reg *registry, name string) string {
	decl, _ := chooseInterface(info, name, 0)
	return interfaceObjectLiteralExpr(info, reg, name, decl, &typeContext{seen: map[string]bool{}})
}

func TestTypiaJsDocMatchesAstParser(t *testing.T) {
	description := "Old name.\n\nMore detail."
	doc := typiaJsDoc(&description, []schemametadata.IJsDocTagInfo{
		{Name: "deprecated", Text: []schemametadata.IJsDocTagInfo_IText{{Text: "Use ", Kind: "text"}, {Text: "title", Kind: "text"}}},
		{Name: "sunset", Text: []schemametadata.IJsDocTagInfo_IText{{Text: "2027-06-30", Kind: "text"}}},
		{Name: "see", Text: []schemametadata.IJsDocTagInfo_IText{{Text: "ignored", Kind: "text"}}},
	})
	got := strings.Join(doc.fieldItems(), "|")
	want := `description: "Old name.\n\nMore detail."|deprecated: "Use title"|sunset: "2027-06-30"`
	if got != want {
		t.Fatalf("typia docs = %s, want %s", got, want)
	}
	if items := typiaJsDoc(nil, nil).fieldItems(); len(items) != 0 {
		t.Fatalf("empty typia docs emitted %v", items)
	}
}

func TestParseJsDocCrlfAndTypeBraces(t *testing.T) {
	doc := parseJsDoc("/**\r\n * Summary line\r\n * continues.\r\n *\r\n * Body.\r\n * @param {{a: string}} opts The options.\r\n * @param {Promise<User>} user - The user.\r\n * @returns {Promise<User>} the user\r\n */")
	if doc.summary != "Summary line continues." || doc.body != "Body." {
		t.Fatalf("summary/body = %q / %q", doc.summary, doc.body)
	}
	if doc.params["opts"] != "The options." || doc.params["user"] != "The user." || len(doc.params) != 2 {
		t.Fatalf("params = %v", doc.params)
	}
	if doc.returns != "the user" {
		t.Fatalf("returns = %q", doc.returns)
	}
	if strings.Contains(doc.summary+doc.body, "\r") {
		t.Fatal("carriage return leaked")
	}
}

func TestParseJsDocFences(t *testing.T) {
	fence := "```"
	doc := parseJsDoc("/**\n * Summary.\n *\n * ~~~\n * " + fence + "\n * @param fake nope\n * ~~~\n * @deprecated real\n */")
	if len(doc.params) != 0 {
		t.Fatalf("fenced @param parsed as a tag: %v", doc.params)
	}
	if doc.deprecated != "real" {
		t.Fatalf("deprecated = %q", doc.deprecated)
	}
	if doc.body != "~~~\n"+fence+"\n@param fake nope\n~~~" {
		t.Fatalf("body = %q", doc.body)
	}

	doc = parseJsDoc("/**\n * Summary.\n *\n * " + fence + "ts\n * @deprecated in code\n * " + fence + "\n * @param a - A.\n */")
	if doc.hasDeprecated {
		t.Fatal("@deprecated inside a fence was parsed")
	}
	if doc.params["a"] != "A." {
		t.Fatalf("params = %v", doc.params)
	}
	// Fence state carries through tag text.
	doc = parseJsDoc("/**\n * @param a - Example:\n * " + fence + "\n * @deprecated inside\n * " + fence + "\n */")
	if doc.hasDeprecated {
		t.Fatal("@deprecated inside a fence in tag text was parsed")
	}
}

func TestParseJsDocSummaryStopsAtFence(t *testing.T) {
	fence := "```"
	doc := parseJsDoc("/**\n * Summary text\n * " + fence + "ts\n * code();\n * " + fence + "\n */")
	if doc.summary != "Summary text" || doc.body != fence+"ts\ncode();\n"+fence {
		t.Fatalf("summary/body = %q / %q", doc.summary, doc.body)
	}
}

func TestJsDocEmissionEscapesStrings(t *testing.T) {
	doc := parseJsDoc("/**\n * Say \"hi\" \\ there.\n *\n * Line two.\n * @deprecated use \"y\"\n */")
	items := strings.Join(doc.fieldItems(), "|")
	for _, want := range []string{`\"hi\"`, `\\ there`, `\n\n`, `deprecated: "use \"y\""`} {
		if !strings.Contains(items, want) {
			t.Fatalf("emission %s missing %s", items, want)
		}
	}
	if strings.ContainsAny(items, "\n\r") {
		t.Fatalf("emission contains a raw newline: %q", items)
	}
}

func TestInternalObjectMetadataCheckIgnoresDocumentationStrings(t *testing.T) {
	if internalObjectExprCarriesSourceMetadata(`{kind: 18, description: "uses literal: and annotations: words", types: []}`) {
		t.Fatal("documentation text counted as source metadata")
	}
	if !internalObjectExprCarriesSourceMetadata(`{kind: 18, types: [{kind: 10, literal: "a"}]}`) {
		t.Fatal("real literal metadata missed")
	}
}

func TestLastOfMultipleJsDocBlocksWins(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "tsconfig.json"), []byte(`{"compilerOptions": {"strict": true, "target": "ESNext"}, "include": ["*.ts"], "reflection": true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "multi.ts"), []byte("export class Multi {\n\t/** First block. */\n\t/** Second block. */\n\tvalue!: string;\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	program, diagnostics, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{SingleThreaded: true})
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("load: %v %v", err, diagnostics)
	}
	defer func() { _ = program.Close() }()
	reg := collectRegistry(program, root, true, true)
	class := reg.classes["Multi"]
	if class == nil || len(class.properties) != 1 {
		t.Fatal("Multi was not collected")
	}
	if got := class.properties[0].doc.summary; got != "Second block." {
		t.Fatalf("summary = %q", got)
	}
}
