package main

import (
	"reflect"
	"strings"
	"testing"

	schemametadata "github.com/samchon/typia/packages/typia/native/core/schemas/metadata"
)

func testTypeInfo() (*fileInfo, *registry) {
	info := &fileInfo{
		moduleKey:  "test/module",
		aliases:    map[string]aliasInfo{},
		interfaces: map[string][]interfaceInfo{},
		enums:      map[string]enumInfo{},
		classes:    []*classInfo{},
		functions:  map[string][]functionInfo{},
		imports:    map[string]importRef{},
		reexports:  map[string]importRef{},
	}
	reg := &registry{
		files:    map[string]*fileInfo{info.moduleKey: info},
		byPath:   map[string]*fileInfo{},
		classes:  map[string]*classInfo{},
		external: map[string]map[string][]functionInfo{},
	}
	return info, reg
}

func TestTypiaObjectTypeNameKeepsGenericDisplayName(t *testing.T) {
	info, reg := testTypeInfo()
	info.interfaces["GenericEnvelope"] = []interfaceInfo{{body: "{ value: T }", pos: 1}}

	name, ok := typiaObjectTypeName(info, reg, &schemametadata.MetadataObjectType{
		Name:        "GenericEnvelope",
		DisplayName: "GenericEnvelope<string, Record<string, unknown>>",
	}, 10)

	if !ok {
		t.Fatal("declared generic object display name should be stable")
	}
	if name != "GenericEnvelope<string, Record<string, unknown>>" {
		t.Fatalf("name = %q", name)
	}

	nestedName, nestedOk := typiaObjectTypeName(info, reg, &schemametadata.MetadataObjectType{
		Name:        "NestedEnvelope",
		DisplayName: "NestedEnvelope<string>",
	}, 10)

	if !nestedOk {
		t.Fatal("generic object display name should stay stable even when only the checker exposed it")
	}
	if nestedName != "NestedEnvelope<string>" {
		t.Fatalf("nestedName = %q", nestedName)
	}
}

func TestTypeExprInstantiatesGenericInterfaceProperties(t *testing.T) {
	info, reg := testTypeInfo()
	info.interfaces["GenericContainer"] = []interfaceInfo{{
		params: []string{"T"},
		properties: []utilityProperty{
			{name: "items", typeText: "T[]", optional: true},
			{name: "alternatives", typeText: "T[]", optional: true},
		},
		pos: 1,
	}}
	info.aliases["GenericVariant"] = aliasInfo{body: "{ kind: 'alpha' } | { kind: 'beta'; mode: 'first' | 'second' }"}

	got := typeExpr(info, reg, "GenericContainer<GenericVariant>")

	assertContainsAll(t, got,
		`kind: 18, typeName: "GenericContainer"`,
		`name: "items", type: {kind: 12, types: [{kind: 14, type: {kind: 12`,
		`literal: "alpha"`,
		`literal: "beta"`,
		`literal: "first"`,
		`literal: "second"`,
	)
	assertNotContains(t, got, `kind: 16, typeName: "GenericContainer"`)
}

func TestTypeExprBoundsRecursiveGenericInterfaceExpansion(t *testing.T) {
	info, reg := testTypeInfo()
	info.interfaces["RecursiveContainer"] = []interfaceInfo{{
		params: []string{"T"},
		properties: []utilityProperty{
			{name: "value", typeText: "T"},
			{name: "next", typeText: "RecursiveContainer<T[]>", optional: true},
		},
		pos: 1,
	}}

	got := typeExpr(info, reg, "RecursiveContainer<string>")

	assertContainsAll(t, got,
		`kind: 18, typeName: "RecursiveContainer"`,
		`name: "value", type: {kind: 6}`,
		`name: "next", type: {kind: 12, types: [{kind: 2, typeName: "RecursiveContainer"}`,
	)
	if len(got) > 2000 {
		t.Fatalf("recursive generic metadata should stay bounded, got %d bytes", len(got))
	}
}

func TestSplitTopIgnoresNestedSyntax(t *testing.T) {
	input := "Pick<User, 'id' | 'email'> | { value: string | number } | `x${a | b}` | Array<boolean>"
	got := splitTop(input, "|")
	want := []string{
		"Pick<User, 'id' | 'email'>",
		"{ value: string | number }",
		"`x${a | b}`",
		"Array<boolean>",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("splitTop() = %#v, want %#v", got, want)
	}
}

func TestSplitTopPreservesCommentMarkersInsideLiterals(t *testing.T) {
	input := `'https://example.com/a/*b*/' | /* actual comment */ ` + "`route//segment/${string}`" + ` | 'done'`
	got := splitTop(input, "|")
	want := []string{
		`'https://example.com/a/*b*/'`,
		"`route//segment/${string}`",
		`'done'`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("splitTop() = %#v, want %#v", got, want)
	}
}

func TestTypeExprIgnoresCommentsInsideUnions(t *testing.T) {
	file := parseTestSourceFile(t, "/project/commented-union.ts", `
		type Status =
			| 'draft'
			/* client's legacy { branch */
			| 'published'
			// closing ( branch
			| 'archived';
	`)
	alias := aliasFromNode(file, file.Statements.Nodes[0])
	info, reg := testTypeInfo()

	got := typeExpr(info, reg, alias.body)
	assertContainsAll(t, got,
		`literal: "draft"`,
		`literal: "published"`,
		`literal: "archived"`,
	)
}

func TestTypeExprForNodeUsesAstUnionMemberOrder(t *testing.T) {
	file := parseTestSourceFile(t, "/project/ordered-union.ts", `
		type Status =
			| 'draft'
			/* punctuation that would poison text splitting: client's { ( */
			| 'published'
			| 'archived';
	`)
	alias := aliasFromNode(file, file.Statements.Nodes[0])
	info, reg := testTypeInfo()
	info.file = file

	got := typeExprForNode(info, reg, "'not-from-the-node'", alias.typeNode, alias.pos)
	assertContainsAll(t, got,
		`literal: "draft"`,
		`literal: "published"`,
		`literal: "archived"`,
	)
	assertNotContains(t, got, `literal: "not-from-the-node"`)
	draft := strings.Index(got, `literal: "draft"`)
	published := strings.Index(got, `literal: "published"`)
	archived := strings.Index(got, `literal: "archived"`)
	if draft > published || published > archived {
		t.Fatalf("AST union order was not preserved: %s", got)
	}
}

func TestTypeExprForNodeUsesAstIntersectionMemberOrder(t *testing.T) {
	file := parseTestSourceFile(t, "/project/ordered-intersection.ts", `
		type Name =
			string
			& MinLength<2>
			/* punctuation that would poison text splitting: { */
			& MaxLength<20>;
	`)
	alias := aliasFromNode(file, file.Statements.Nodes[0])
	info, reg := testTypeInfo()
	info.file = file

	got := typeExprForNode(info, reg, "string", alias.typeNode, alias.pos)
	assertContainsAll(t, got,
		`typeName: "MinLength"`,
		`typeName: "MaxLength"`,
	)
	minimum := strings.Index(got, `typeName: "MinLength"`)
	maximum := strings.Index(got, `typeName: "MaxLength"`)
	if minimum > maximum {
		t.Fatalf("AST intersection order was not preserved: %s", got)
	}
}

func TestRenderUtilityPropertyUsesAstUnionMembers(t *testing.T) {
	file := parseTestSourceFile(t, "/project/utility-union.ts", `
		type Status =
			| 'draft'
			/* punctuation that would poison text splitting: { */
			| 'published';
	`)
	alias := aliasFromNode(file, file.Statements.Nodes[0])
	info, reg := testTypeInfo()
	info.file = file

	got := renderUtilityProperty(info, reg, utilityProperty{
		name:     "status",
		typeText: "'not-from-the-node'",
		typeNode: alias.typeNode,
	}, &typeContext{seen: map[string]bool{}})
	assertContainsAll(t, got,
		`literal: "draft"`,
		`literal: "published"`,
	)
	assertNotContains(t, got, `literal: "not-from-the-node"`)
}

func TestUtilityClassPropertyRetainsAstUnionMembers(t *testing.T) {
	file := parseTestSourceFile(t, "/project/class-utility-union.ts", `
		type Status =
			| 'draft'
			/* punctuation that would poison text splitting: { */
			| 'published';
	`)
	alias := aliasFromNode(file, file.Statements.Nodes[0])
	info, reg := testTypeInfo()
	info.file = file
	info.classes = []*classInfo{{
		name: "User",
		properties: []propertyInfo{{
			name:     "status",
			typeText: "'not-from-the-node'",
			typeNode: alias.typeNode,
		}},
	}}

	got := typeExpr(info, reg, "Pick<User, 'status'>")
	assertContainsAll(t, got,
		`literal: "draft"`,
		`literal: "published"`,
	)
	assertNotContains(t, got, `literal: "not-from-the-node"`)
}

func TestMetadataCallNamesIncludeValidatedDeserialize(t *testing.T) {
	for _, name := range []string{"deserialize", "validate", "validatedDeserialize", "typeOf"} {
		if !isMetadataCallName(name) {
			t.Fatalf("%s should be collected as a metadata call", name)
		}
	}
	for _, name := range []string{"cast", "assert", "is"} {
		if isMetadataCallName(name) {
			t.Fatalf("collision-prone compatibility helper %s must require explicit metadata", name)
		}
	}
}

func TestCompatibilityMetadataCallsRequireFoundationImports(t *testing.T) {
	for _, ref := range []importRef{
		{spec: foundationPackageSpec, exportName: "assert"},
		{source: "/workspace/ts-server-foundation/src/index", spec: "../src", exportName: "is"},
		{source: "/workspace/ts-server-foundation/src/reflection/conversion", spec: "./conversion", exportName: "cast"},
	} {
		if !isFoundationCompatibilityImport(ref) {
			t.Fatalf("foundation compatibility import was not recognized: %#v", ref)
		}
	}

	for _, ref := range []importRef{
		{spec: "node:assert/strict", exportName: "assert"},
		{spec: "@scope/application-helpers", exportName: "is"},
		{source: "/workspace/application/cast", spec: "./cast", exportName: "cast"},
		{source: "/workspace/application/src/index", spec: "../src", exportName: "cast"},
	} {
		if isFoundationCompatibilityImport(ref) {
			t.Fatalf("non-foundation compatibility import was recognized: %#v", ref)
		}
	}
}

func TestReceiveTypeMethodCandidatesIncludeStaticMethods(t *testing.T) {
	info, reg := testTypeInfo()
	info.classes = []*classInfo{{
		name: "FiltersHelpers",
		staticMethods: []methodInfo{{
			name:       "extractFilters",
			typeParams: []string{"T"},
			params:     []paramInfo{{name: "input", typeText: "string"}, {name: "type", typeText: "ReceiveType<T>"}},
		}},
	}}
	reg.files[info.moduleKey] = info

	if got := receiveTypeMethodCandidates(reg)["extractFilters"]; len(got) != 1 || got[0].owner != "FiltersHelpers" {
		t.Fatalf("static receive-type candidates = %#v", got)
	}
}

func TestReceiveTypeArgumentAcceptsQualifiedImports(t *testing.T) {
	for _, input := range []string{
		"ReceiveType<T>",
		"reflection.ReceiveType<T>",
		`import("@zyno-io/ts-server-foundation").ReceiveType<T>`,
	} {
		got, ok := receiveTypeArgument(input)
		if !ok || got != "T" {
			t.Fatalf("receiveTypeArgument(%q) = %q, %v", input, got, ok)
		}
	}
}

func TestPropertiesFromBodyParsesFieldsAndIgnoresMembers(t *testing.T) {
	body := `
        id: string;
        optional?: number
        tuple: [string, number]
        method(value: string): void
        [key: string]: boolean
        // comment: ignored
        nested: { count: number; label: string }
    `
	got := propertiesFromBody(body)
	want := []utilityProperty{
		{name: "id", typeText: "string"},
		{name: "optional", typeText: "number", optional: true},
		{name: "tuple", typeText: "[string, number]"},
		{name: "nested", typeText: "{ count: number; label: string }"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("propertiesFromBody() = %#v, want %#v", got, want)
	}
}

func TestTypeExprRendersObjectLiteralsAndUtilityTypes(t *testing.T) {
	info, reg := testTypeInfo()
	info.aliases["User"] = aliasInfo{body: "{ id: string; email?: string; count: number }"}

	objectExpr := typeExpr(info, reg, "{ id: string; count?: number; [key: string]: boolean }")
	for _, want := range []string{
		"kind: 18",
		"index: {kind: 8}",
		"name: \"id\", type: {kind: 6}",
		"name: \"count\", type: {kind: 12, types: [{kind: 7}, {kind: 4}]}, optional: true",
	} {
		if !strings.Contains(objectExpr, want) {
			t.Fatalf("object expression %q does not contain %q", objectExpr, want)
		}
	}

	pickExpr := typeExpr(info, reg, "Pick<User, 'id' | 'email'>")
	for _, want := range []string{
		"typeName: \"Pick\"",
		"name: \"id\", type: {kind: 6}",
		"name: \"email\", type: {kind: 12, types: [{kind: 6}, {kind: 4}]}, optional: true",
	} {
		if !strings.Contains(pickExpr, want) {
			t.Fatalf("pick expression %q does not contain %q", pickExpr, want)
		}
	}

	unionReturnExpr := typeExpr(info, reg, "Promise<{ result: 'token' } | { result: 'login'; jwt: string }>")
	assertContainsAll(t, unionReturnExpr,
		"kind: 22",
		"literal: \"token\"",
		"literal: \"login\"",
		"name: \"jwt\", type: {kind: 6}",
	)
	assertNotContains(t, unionReturnExpr, "literal: 'token'")
	assertNotContains(t, unionReturnExpr, "typeName: \"{ result:")
}

func TestTypeExprRendersUtilityTypeMatrix(t *testing.T) {
	info, reg := testTypeInfo()
	info.aliases["User"] = aliasInfo{body: "{ id: string; email?: string; count: number; active: boolean }"}
	info.aliases["Container"] = aliasInfo{body: "{ items: Array<{ id: string; count: number }>; maybe: { enabled: boolean } | null }"}

	omitExpr := typeExpr(info, reg, "Omit<User, 'email' | 'active'>")
	assertContainsAll(t, omitExpr,
		"typeName: \"Omit\"",
		"name: \"id\", type: {kind: 6}",
		"name: \"count\", type: {kind: 7}",
		"types: [{kind: 20, name: \"id\", type: {kind: 6}, optional: false}, {kind: 20, name: \"count\", type: {kind: 7}, optional: false}]",
	)

	partialExpr := typeExpr(info, reg, "Partial<Pick<User, 'id' | 'count'>>")
	assertContainsAll(t, partialExpr,
		"typeName: \"Partial\"",
		"name: \"id\", type: {kind: 12, types: [{kind: 6}, {kind: 4}]}, optional: true",
		"name: \"count\", type: {kind: 12, types: [{kind: 7}, {kind: 4}]}, optional: true",
	)

	requiredExpr := typeExpr(info, reg, "Required<Pick<User, 'email'>>")
	assertContainsAll(t, requiredExpr,
		"typeName: \"Required\"",
		"name: \"email\", type: {kind: 6}, optional: false",
	)

	recordExpr := typeExpr(info, reg, "Record<'email' | 'phone', string | null>")
	assertContainsAll(t, recordExpr,
		"typeName: \"Record\"",
		"utilityType: \"Record\"",
		"typeArguments: [{kind: 12, types: [{kind: 10, literal: \"email\"}, {kind: 10, literal: \"phone\"}]}, {kind: 12, types: [{kind: 6}, {kind: 5}]}]",
		"index: {kind: 12, types: [{kind: 6}, {kind: 5}]}",
	)

	extractExpr := typeExpr(info, reg, "Extract<{ type: 'blank' } | { type: 'webView'; url: string } | { type: 'mediaRef'; mediaId: string }, { type: 'blank' } | { type: 'webView' }>")
	assertContainsAll(t, extractExpr,
		"typeName: \"Extract\"",
		"utilityType: \"Extract\"",
		"literal: \"mediaRef\"",
		"literal: \"webView\"",
	)

	indexedExpr := typeExpr(info, reg, "Pick<Container['items'][number], 'id'>")
	assertContainsAll(t, indexedExpr,
		"typeName: \"Pick\"",
		"name: \"id\", type: {kind: 6}",
		"types: [{kind: 20, name: \"id\", type: {kind: 6}, optional: false}]",
	)

	markerIntersectionExpr := typeExpr(info, reg, "Pick<User & TypeAnnotation<'example:marker'>, 'id'>")
	assertContainsAll(t, markerIntersectionExpr,
		"typeName: \"Pick\"",
		"name: \"id\", type: {kind: 6}",
	)
}

func TestShouldUseTypiaTypeForNullableMappedAliases(t *testing.T) {
	info, reg := testTypeInfo()
	info.aliases["NullableKeys"] = aliasInfo{
		body:   "{ [K in keyof T]-?: null extends T[K] ? K : never }[keyof T]",
		params: []string{"T"},
	}
	info.aliases["NullableOptionals"] = aliasInfo{
		body:   "Omit<T, NullableKeys<T>> & Partial<Pick<T, NullableKeys<T>>>",
		params: []string{"T"},
	}

	if !shouldUseTypiaType(info, reg, "NullableOptionals<Pick<User, 'name' | 'color'>>") {
		t.Fatal("nullable mapped alias should route through Typia metadata")
	}
	if !canPreferTypiaType(info, reg, "NullableOptionals<Pick<User, 'name' | 'color'>>") {
		t.Fatal("plain nullable mapped alias should be safe for Typia metadata")
	}
	if !receiveTypeMetadataResolvable(info, reg, "NullableOptionals<Pick<User, 'name' | 'color'>>") {
		t.Fatal("nullable mapped alias should be accepted by receive-type metadata preflight")
	}
	if shouldUseTypiaType(info, reg, "Partial<Pick<User, 'name'>>") {
		t.Fatal("ordinary utility type should stay on the internal encoder")
	}
	if !canPreferTypiaType(info, reg, "Partial<Pick<User, 'name'>>") {
		t.Fatal("ordinary utility type should be safe when a preferred metadata surface requests Typia")
	}
	if canPreferTypiaType(info, reg, "HttpBody<NullableOptionals<Pick<User, 'name' | 'color'>>>") {
		t.Fatal("outer HTTP marker should be preserved by the internal encoder")
	}
	if canPreferTypiaType(info, reg, "string & DatabaseField<{ type: 'CHAR(36)' }>") {
		t.Fatal("database markers should stay on the internal encoder")
	}
	if canPreferTypiaType(info, reg, "string & TypiaFormat<'date'> & TsfDatabaseFieldTag<{ type: 'DATE' }> & TsfTypeTag<'string', 'date'>") {
		t.Fatal("database field tags should stay on the internal encoder even when combined with Typia-compatible tags")
	}
	if !canPreferTypiaType(info, reg, "string & MinLength<2>") {
		t.Fatal("Typia-compatible validation marker should be safe for Typia metadata")
	}
	if !canPreferTypiaType(info, reg, "number & GreaterThan<0>") {
		t.Fatal("Typia-compatible greater-than marker should be safe for Typia metadata")
	}

	info.aliases["UserWithDatabaseField"] = aliasInfo{body: "{ name: string; color: string | null; note: string & DatabaseField<{ type: 'TEXT' }> | null; status: 'active' | 'inactive'; createdAt: Date }"}
	if !canPreferTypiaTypeOnPreferredSurface(info, reg, "NullableOptionals<Pick<UserWithDatabaseField, 'name' | 'color' | 'note'>>") {
		t.Fatal("preferred structural metadata should allow Typia to resolve nested database tags")
	}
	info.imports["FoundationUtility"] = importRef{source: "", exportName: "FoundationUtility", spec: foundationPackageSpec}
	if !canPreferTypiaTypeOnPreferredSurface(info, reg, "FoundationUtility<Pick<UserWithDatabaseField, 'name' | 'color' | 'note' | 'status'>>") {
		t.Fatal("imported foundation utility helpers should be resolved by Typia on preferred metadata surfaces")
	}
	if !canPreferTypiaTypeOnPreferredSurface(info, reg, "Pick<UserWithDatabaseField, 'createdAt'>") {
		t.Fatal("selected Date properties should be rendered by Typia on preferred metadata surfaces")
	}
	if canPreferTypiaTypeOnPreferredSurface(info, reg, "HttpBody<NullableOptionals<Pick<UserWithDatabaseField, 'name' | 'color' | 'note'>>>") {
		t.Fatal("outer HTTP marker should still be preserved on preferred metadata surfaces")
	}
	if canPreferTypiaTypeOnPreferredSurface(info, reg, "string & DatabaseField<{ type: 'CHAR(36)' }>") {
		t.Fatal("direct database marker payload should stay on the internal encoder")
	}
	if !canPreferTypiaTypeOnPreferredSurface(info, reg, "Record<string, string>") {
		t.Fatal("Record/index metadata should be resolved by Typia on preferred structural surfaces")
	}
	info.aliases["IndexedAccessSource"] = aliasInfo{body: "{ items: Array<{ id: string; label: string }> }"}
	if !canPreferTypiaTypeOnPreferredSurface(info, reg, "IndexedAccessSource['items'][number]") {
		t.Fatal("indexed access should be resolved by Typia on preferred structural surfaces")
	}
	info.aliases["IndexedAccessLiteralSource"] = aliasInfo{body: "{ status: 'open' | 'closed' | 'voided' }"}
	if !sourceTypeNeedsInternalPropertyMetadata(info, reg, "IndexedAccessLiteralSource['status'] | null", &typeContext{seen: map[string]bool{}}, map[string]bool{}) {
		t.Fatal("indexed access to literal unions should preserve source union order at property level")
	}
	info.interfaces["IndexedAccessParams"] = []interfaceInfo{{properties: []utilityProperty{{name: "platform", typeText: "IndexedAccessLiteralSource['status']"}}, pos: 1}}
	if !sourceTypeNeedsInternalPropertyMetadata(info, reg, "IndexedAccessParams['platform']", &typeContext{seen: map[string]bool{}}, map[string]bool{}) {
		t.Fatal("indexed access chains to literal unions should preserve source union order at property level")
	}
	serviceInfo := &fileInfo{
		moduleKey:  "test/service",
		aliases:    map[string]aliasInfo{},
		interfaces: map[string][]interfaceInfo{"CreateParams": {{properties: []utilityProperty{{name: "platform", typeText: "DeviceEntity['platform']"}}, pos: 1}}},
		enums:      map[string]enumInfo{},
		classes:    []*classInfo{{name: "DeviceEntity", properties: []propertyInfo{{name: "platform", typeText: "'ios' | 'android'"}}}},
		functions:  map[string][]functionInfo{},
		imports:    map[string]importRef{},
		reexports:  map[string]importRef{},
	}
	info.imports["CreateParams"] = importRef{source: "test/service", exportName: "CreateParams", spec: "test/service"}
	reg.files[serviceInfo.moduleKey] = serviceInfo
	reg.byPath[serviceInfo.moduleKey] = serviceInfo
	if !sourceTypeNeedsInternalPropertyMetadata(info, reg, "CreateParams['platform']", &typeContext{seen: map[string]bool{}}, map[string]bool{}) {
		t.Fatal("cross-file indexed access chains to literal unions should preserve source union order at property level")
	}
	info.interfaces["RequestWithIndexedPlatform"] = []interfaceInfo{{properties: []utilityProperty{{name: "platform", typeText: "CreateParams['platform']"}}, pos: 1}}
	override, ok := typiaSourcePropertyOverrideExpr(info, reg, "RequestWithIndexedPlatform", "platform", 10)
	if !ok {
		t.Fatal("cross-file indexed access chains should trigger property-level internal metadata")
	}
	assertContainsAll(t, override, "literal: \"ios\"", "literal: \"android\"")
	objectOverride, ok := typiaNamedObjectInternalOverrideExpr(info, reg, "RequestWithIndexedPlatform", 10)
	if !ok {
		t.Fatal("named objects with indexed access properties should use internal metadata")
	}
	iosIndex := strings.Index(objectOverride, "literal: \"ios\"")
	androidIndex := strings.Index(objectOverride, "literal: \"android\"")
	if iosIndex < 0 || androidIndex < 0 || iosIndex > androidIndex {
		t.Fatalf("object override did not preserve literal order: %s", objectOverride)
	}
	preferredNamed, ok := preferredNamedInterfaceTypeExpr(info, reg, "RequestWithIndexedPlatform", 10)
	if !ok {
		t.Fatal("preferred named interface path should preserve indexed-access literal metadata")
	}
	iosIndex = strings.Index(preferredNamed, "literal: \"ios\"")
	androidIndex = strings.Index(preferredNamed, "literal: \"android\"")
	if iosIndex < 0 || androidIndex < 0 || iosIndex > androidIndex {
		t.Fatalf("preferred named interface path did not preserve literal order: %s", preferredNamed)
	}
	entityInfo := &fileInfo{
		moduleKey:  "test/entity",
		aliases:    map[string]aliasInfo{},
		interfaces: map[string][]interfaceInfo{},
		enums:      map[string]enumInfo{},
		classes:    []*classInfo{{name: "ImportedDeviceEntity", properties: []propertyInfo{{name: "platform", typeText: "'ios' | 'android'"}}}},
		functions:  map[string][]functionInfo{},
		imports:    map[string]importRef{},
		reexports:  map[string]importRef{},
	}
	importedServiceInfo := &fileInfo{
		moduleKey: "test/imported-service",
		aliases:   map[string]aliasInfo{},
		interfaces: map[string][]interfaceInfo{"ImportedCreateParams": {{
			properties: []utilityProperty{{name: "platform", typeText: "ImportedDeviceEntity['platform']"}},
			pos:        1,
		}}},
		enums:     map[string]enumInfo{},
		classes:   []*classInfo{},
		functions: map[string][]functionInfo{},
		imports:   map[string]importRef{"ImportedDeviceEntity": {source: "test/entity", exportName: "ImportedDeviceEntity", spec: "test/entity"}},
		reexports: map[string]importRef{},
	}
	info.imports["ImportedCreateParams"] = importRef{source: "test/imported-service", exportName: "ImportedCreateParams", spec: "test/imported-service"}
	reg.files[entityInfo.moduleKey] = entityInfo
	reg.byPath[entityInfo.moduleKey] = entityInfo
	reg.files[importedServiceInfo.moduleKey] = importedServiceInfo
	reg.byPath[importedServiceInfo.moduleKey] = importedServiceInfo
	info.interfaces["RequestWithImportedIndexedPlatform"] = []interfaceInfo{{properties: []utilityProperty{{name: "platform", typeText: "ImportedCreateParams['platform']"}}, pos: 1}}
	if !sourceTypeNeedsInternalPropertyMetadata(info, reg, "ImportedCreateParams['platform']", &typeContext{seen: map[string]bool{}}, map[string]bool{}) {
		t.Fatal("imported indexed access chains to imported class literal unions should preserve source order")
	}
	preferredNamed, ok = preferredNamedInterfaceTypeExpr(info, reg, "RequestWithImportedIndexedPlatform", 10)
	if !ok {
		t.Fatal("preferred named interface path should preserve imported indexed-access literal metadata")
	}
	iosIndex = strings.Index(preferredNamed, "literal: \"ios\"")
	androidIndex = strings.Index(preferredNamed, "literal: \"android\"")
	if iosIndex < 0 || androidIndex < 0 || iosIndex > androidIndex {
		t.Fatalf("preferred imported named interface path did not preserve literal order: %s", preferredNamed)
	}

	info.aliases["DateString"] = aliasInfo{body: "string & TypiaFormat<'date'> & TsfTypeTag<'string', 'date'>"}
	info.aliases["UuidString"] = aliasInfo{body: "string & TypiaFormat<'uuid'> & TsfTypeTag<'string', 'uuidString'>"}
	if canPreferTypiaType(info, reg, "DateString | UuidString") {
		t.Fatal("tagged string unions should stay on the internal encoder to preserve alternatives")
	}
	if canPreferTypiaTypeOnPreferredSurface(info, reg, "DateString | UuidString") {
		t.Fatal("tagged string unions should stay on the internal encoder on preferred metadata surfaces")
	}
	if canPreferTypiaType(info, reg, "{ startsAt: Date }") {
		t.Fatal("Date should stay on the internal encoder to preserve runtime Date deserialization")
	}
	if !canPreferTypiaTypeOnPreferredSurface(info, reg, "{ startsAt: Date }") {
		t.Fatal("Date should not force a whole object onto the internal encoder on preferred metadata surfaces")
	}
	if canPreferTypiaType(info, reg, "Date & TsfValidatorTag<'object', 'validDate'>") {
		t.Fatal("Date validator intersections should stay on the internal encoder to preserve Date semantics")
	}
	if canPreferTypiaTypeOnPreferredSurface(info, reg, "{ startsAt: Date & TsfValidatorTag<'object', 'validDate'> }") {
		t.Fatal("object-target validator tags should stay on the internal encoder because Typia does not preserve them on Date metadata")
	}
	info.interfaces["AnnotatedDto"] = []interfaceInfo{{body: "name: string & MinLength<2>; count: number"}}
	if !canPreferTypiaType(info, reg, "AnnotatedDto") {
		t.Fatal("referenced DTO with Typia-compatible validation should be safe for Typia metadata")
	}
}

func TestPreferredInterfacePreservesNamedAliasProperties(t *testing.T) {
	info, reg := testTypeInfo()
	info.aliases["NamedDetails"] = aliasInfo{
		body:         "Partial<Pick<SourceEntity, 'left' | 'right'>>",
		metadataText: "{kind: 18, typeName: \"NamedDetails\", types: [{kind: 20, name: \"left\", type: {kind: 6}, optional: true}]}",
	}
	info.interfaces["CreateRequest"] = []interfaceInfo{{
		body: "name: string; details?: NamedDetails; optionalDetails?: NamedDetails | null",
		properties: []utilityProperty{
			{name: "name", typeText: "string"},
			{name: "details", typeText: "NamedDetails", optional: true},
			{name: "optionalDetails", typeText: "NamedDetails | null", optional: true},
		},
	}}

	expr := typeExprForNodePreferred(info, reg, "CreateRequest", nil, 0, true)
	assertContainsAll(t, expr,
		"typeName: \"CreateRequest\"",
		"name: \"details\"",
		"name: \"optionalDetails\"",
		"typeName: \"NamedDetails\"",
	)
	if strings.Contains(expr, "Partial<Pick") {
		t.Fatalf("preferred interface expression leaked utility display name: %s", expr)
	}
}

func TestTypeExprRendersFoundationAnnotations(t *testing.T) {
	info, reg := testTypeInfo()

	got := typeExpr(info, reg, "string & MinLength<2> & TypeAnnotation<'tsf:type', 'custom'>")
	for _, want := range []string{
		"kind: 13",
		"typeName: \"MinLength\"",
		"validation: [{name: \"minLength\", args: [{kind: 10, literal: 2}]}]",
		"annotations: {\"tsf:type\": {kind: 10, literal: \"custom\"}}",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("annotation expression %q does not contain %q", got, want)
		}
	}

	got = typeExpr(info, reg, "Date & TsfValidatorTag<'object', 'validDate'>")
	assertContainsAll(t, got,
		"typeName: \"Date\"",
		"classType: () =>",
		"typeName: \"Validator\"",
		"validation: [{name: \"validator\", args: [{kind: 10, literal: \"validDate\"}]}]",
	)
}

func TestTypiaSourcePropertyOverridePreservesDateProperties(t *testing.T) {
	info, reg := testTypeInfo()
	info.aliases["DateString"] = aliasInfo{body: "string & TypiaFormat<'date'> & TsfTypeTag<'string', 'date'>"}
	info.aliases["NamedSchedule"] = aliasInfo{
		body:         "Pick<EntitySource, 'id' | 'createdAt'>",
		metadataText: "{kind: 18, typeName: \"NamedSchedule\", types: [{kind: 20, name: \"id\", type: {kind: 13}, optional: false}, {kind: 20, name: \"createdAt\", type: {kind: 16, typeName: \"Date\", classType: () => Date}, optional: false}]}",
	}
	info.aliases["EntityPick"] = aliasInfo{body: "Pick<EntitySource, 'id' | 'createdAt' | 'deletedAt'>"}
	info.classes = append(info.classes, &classInfo{
		name: "EntitySource",
		properties: []propertyInfo{
			{name: "id", typeText: "string"},
			{name: "createdAt", typeText: "Date"},
			{name: "deletedAt", typeText: "Date | null"},
		},
	})
	info.interfaces["BaseResponse"] = []interfaceInfo{{body: "updatedAt: Date | null; birthday: DateString"}}
	info.interfaces["Response"] = []interfaceInfo{{body: "createdAt: Date", extends: []string{"BaseResponse"}}}
	info.interfaces["ScheduleResponse"] = []interfaceInfo{{body: "schedules: NamedSchedule[]"}}
	info.interfaces["CreateResponse"] = []interfaceInfo{{body: "key: string", extends: []string{"EntityPick"}}}

	assertTypiaPropertyOverride := func(source string, property string, want ...string) {
		t.Helper()
		got, ok := typiaSourcePropertyOverrideExpr(info, reg, source, property, 0)
		if !ok {
			t.Fatalf("expected Date override for %s.%s", source, property)
		}
		assertContainsAll(t, got, want...)
	}

	assertTypiaPropertyOverride("Response", "createdAt", "typeName: \"Date\"", "classType: () =>")
	assertTypiaPropertyOverride("Response", "updatedAt", "typeName: \"Date\"", "{kind: 5}")
	assertTypiaPropertyOverride("EntityPick", "createdAt", "typeName: \"Date\"", "classType: () =>")
	assertTypiaPropertyOverride("EntityPick", "deletedAt", "typeName: \"Date\"", "{kind: 5}")
	assertTypiaPropertyOverride("Promise<Response[]>", "updatedAt", "typeName: \"Date\"", "{kind: 5}")
	assertTypiaPropertyOverride("CreateResponse", "createdAt", "typeName: \"Date\"", "classType: () =>")
	assertTypiaPropertyOverride("CreateResponse", "deletedAt", "typeName: \"Date\"", "{kind: 5}")
	if !sourceTypeIsDateRootType(info, reg, "Date | null", &typeContext{seen: map[string]bool{}}, map[string]bool{}) {
		t.Fatal("Date nullish roots should stay on the internal encoder")
	}
	if sourceTypeIsDateRootType(info, reg, "Response", &typeContext{seen: map[string]bool{}}, map[string]bool{}) {
		t.Fatal("DTOs containing Date should not force whole-object internal encoding")
	}
	if got, ok := preferredDateRootTypeExpr(info, reg, "Date | null", nil, 0); !ok {
		t.Fatal("preferred Date roots should render through the internal encoder")
	} else {
		assertContainsAll(t, got, "typeName: \"Date\"", "{kind: 5}")
	}
	assertContainsAll(t,
		typeExprForNodePreferred(info, reg, "Promise<Response[]>", nil, 0, true),
		"kind: 22",
		"kind: 14",
		"typeName: \"Response\"",
		"name: \"updatedAt\", type: {kind: 12, types: [{kind: 16, typeName: \"Date\"",
	)

	if got, ok := typiaSourcePropertyOverrideExpr(info, reg, "Response", "birthday", 0); !ok {
		t.Fatal("named scalar aliases should preserve property source metadata")
	} else {
		assertContainsAll(t, got, "typeName: \"DateString\"")
	}
	if got, ok := typiaSourcePropertyOverrideExpr(info, reg, "ScheduleResponse", "schedules", 0); !ok {
		t.Fatal("named array aliases should preserve property source metadata")
	} else {
		assertContainsAll(t, got, "kind: 14", "typeName: \"NamedSchedule\"")
	}
	info.aliases["MetadataString"] = aliasInfo{body: "string & DatabaseField<{ type: 'TEXT' }>"}
	info.interfaces["MetadataResponse"] = []interfaceInfo{{body: "note: MetadataString"}}
	if got, ok := typiaSourcePropertyOverrideExpr(info, reg, "MetadataResponse", "note", 0); !ok {
		t.Fatal("database metadata aliases should preserve property source metadata")
	} else {
		assertContainsAll(t, got, "typeName: \"MetadataString\"", "typeName: \"DatabaseField\"", "database: {\"*\": {type: \"TEXT\"}}")
	}
	info.imports["ValidDate"] = importRef{spec: foundationPackageSpec, exportName: "ValidDate"}
	if !sourceTypeContainsDateType(info, reg, "ValidDate", &typeContext{seen: map[string]bool{}}, map[string]bool{}) {
		t.Fatal("foundation ValidDate should be preserved as Date property metadata")
	}
	if got, ok := typiaSourcePropertyOverrideExpr(info, reg, "__type", "updatedAt", 0, "Promise<Response[]>"); !ok {
		t.Fatal("alternate root source should preserve Date metadata")
	} else {
		assertContainsAll(t, got, "typeName: \"Date\"", "{kind: 5}")
	}
	if got, ok := typiaSourcePropertyOverrideExpr(info, reg, "__type", "result", 0, "Promise<{ result: 'token' } | { result: 'login'; jwt: string }>"); ok {
		t.Fatalf("object-union root source should not override branch properties: %s", got)
	}
}

func TestPreferredExternalImportedAliasesUseRuntimeMetadata(t *testing.T) {
	info, reg := testTypeInfo()
	info.imports["ExternalStatus"] = importRef{spec: "@scope/shared", exportName: "ExternalStatus"}
	info.imports["FoundationAlias"] = importRef{spec: foundationPackageSpec, exportName: "FoundationAlias"}
	info.interfaces["Response"] = []interfaceInfo{{body: "status: ExternalStatus"}}
	sharedInfo := &fileInfo{
		moduleKey:  "shared/status",
		aliases:    map[string]aliasInfo{"WorkspaceStatus": {body: "'ready' | 'busy'"}},
		interfaces: map[string][]interfaceInfo{},
		enums:      map[string]enumInfo{},
		classes:    []*classInfo{},
		functions:  map[string][]functionInfo{},
		imports:    map[string]importRef{},
		reexports:  map[string]importRef{},
	}
	reg.files[sharedInfo.moduleKey] = sharedInfo
	reg.byPath["/workspace/shared/status.ts"] = sharedInfo
	info.imports["WorkspaceStatus"] = importRef{source: "/workspace/shared/status.ts", spec: "@scope/shared", exportName: "WorkspaceStatus"}
	info.imports["HasDefault"] = importRef{spec: foundationPackageSpec, exportName: "HasDefault"}
	info.imports["NullableMySQLCoordinate"] = importRef{spec: foundationPackageSpec, exportName: "NullableMySQLCoordinate"}
	decl := info.interfaces["Response"][0]

	if !interfaceNeedsPreferredSourceMetadata(info, reg, decl, map[string]bool{}) {
		t.Fatal("interfaces containing external imported aliases should preserve source metadata")
	}

	statusExpr := typeExprForNodePreferred(info, reg, "ExternalStatus", nil, 0, true)
	assertContainsAll(t, statusExpr, "__tsf_runtime_alias__(\"@scope/shared\"", "\"ExternalStatus\"")

	nullableStatusExpr := typeExprForNodePreferred(info, reg, "ExternalStatus | null", nil, 0, true)
	assertContainsAll(t, nullableStatusExpr, "__tsf_runtime_alias__(\"@scope/shared\"", "\"ExternalStatus\"", "{kind: 5}")

	statusArrayExpr := typeExprForNodePreferred(info, reg, "ExternalStatus[]", nil, 0, true)
	assertContainsAll(t, statusArrayExpr, "kind: 14", "__tsf_runtime_alias__(\"@scope/shared\"", "\"ExternalStatus\"")

	workspaceStatusExpr := typeExpr(info, reg, "WorkspaceStatus[]")
	assertContainsAll(t, workspaceStatusExpr, "kind: 14", "__tsf_runtime_alias__(\"@scope/shared\"", "\"WorkspaceStatus\"")
	assertNotContains(t, workspaceStatusExpr, "literal: \"ready\"")
	if canPreferTypiaType(info, reg, "WorkspaceStatus[] & HasDefault") {
		t.Fatal("non-preferred metadata should not route package aliases through Typia just because a TSF marker is present")
	}

	info.interfaces["CreateRequest"] = []interfaceInfo{{body: "status?: ExternalStatus | null"}}
	createExpr := typeExprForNodePreferred(info, reg, "CreateRequest", nil, 0, true)
	assertContainsAll(t, createExpr, "typeName: \"CreateRequest\"", "name: \"status\"", "__tsf_runtime_alias__(\"@scope/shared\"", "\"ExternalStatus\"")

	responseExpr := typeExprForNodePreferred(info, reg, "Response", nil, 0, true)
	assertContainsAll(t, responseExpr, "name: \"status\"", "__tsf_runtime_alias__(\"@scope/shared\"")

	if got, ok := typiaSourcePropertyOverrideExpr(info, reg, "{ status: ExternalStatus }", "status", 0); !ok {
		t.Fatal("Typia property overrides should preserve external imported aliases")
	} else {
		assertContainsAll(t, got, "__tsf_runtime_alias__(\"@scope/shared\"", "\"ExternalStatus\"")
	}
	if typeContainsExternalImportReference(info, reg, "FoundationAlias", map[string]bool{}) {
		t.Fatal("foundation aliases should not trigger external shared-package preservation")
	}
	if !sourceTypeNeedsInternalPropertyMetadata(info, reg, "NullableMySQLCoordinate", &typeContext{seen: map[string]bool{}}, map[string]bool{}) {
		t.Fatal("foundation aliases should preserve runtime alias metadata when Typia expands the source type")
	}
	if got := typeExprForNodePreferred(info, reg, "NullableMySQLCoordinate", nil, 0, true); !strings.Contains(got, runtimeAliasPlaceholderName) {
		t.Fatalf("preferred foundation aliases should use runtime alias metadata: %s", got)
	}
	info.interfaces["LocationResponse"] = []interfaceInfo{{body: "zipGeo: NullableMySQLCoordinate"}}
	if got, ok := typiaSourcePropertyOverrideExpr(info, reg, "LocationResponse", "zipGeo", 0); !ok {
		t.Fatal("Typia property overrides should preserve foundation alias metadata")
	} else {
		assertContainsAll(t, got, "__tsf_runtime_alias__(\"@zyno-io/ts-server-foundation\"", "\"NullableMySQLCoordinate\"")
	}
}

func TestTypeExprUnescapesStringLiteralTypeValues(t *testing.T) {
	info, reg := testTypeInfo()

	got := typeExpr(info, reg, `string & Pattern<'^\\d+$'>`)
	assertContainsAll(t, got, `validation: [{name: "pattern", args: [{kind: 10, literal: "^\\d+$"}]}]`)
	assertNotContains(t, got, `literal: "^\\\\d+$"`)
}

func TestPatchAliasMetadataSkipsOversizedAliases(t *testing.T) {
	info, reg := testTypeInfo()
	info.aliases["HugeAlias"] = aliasInfo{metadataText: strings.Repeat("x", 1000001), exported: true}

	got := aliasMetadataExpression(info, reg)

	assertNotContains(t, got, "HugeAlias")
	assertNotContains(t, got, "__tsfTypeAliases")
}

func TestAliasMetadataOnlyIncludesExportedDeclarations(t *testing.T) {
	info, reg := testTypeInfo()
	info.aliases["PrivateAlias"] = aliasInfo{body: "string"}
	info.aliases["PublicAlias"] = aliasInfo{body: "number", exported: true}
	info.interfaces["PrivateInterface"] = []interfaceInfo{{body: "value: string"}}
	info.interfaces["PublicInterface"] = []interfaceInfo{{body: "value: number", exported: true}}

	got := aliasMetadataExpression(info, reg)

	assertContainsAll(t, got, "PublicAlias", "PublicInterface")
	assertNotContains(t, got, "PrivateAlias")
	assertNotContains(t, got, "PrivateInterface")
}

func TestTypeAliasEmissionDefaultsOnAndCanBeDisabled(t *testing.T) {
	if !shouldEmitTypeAliases("") {
		t.Fatal("alias metadata should remain enabled when no plugin config is supplied")
	}
	if shouldEmitTypeAliases(`[{"name":"tsf-type-metadata","config":{"emitTypeAliases":false}}]`) {
		t.Fatal("emitTypeAliases=false should disable alias metadata")
	}
	if !shouldEmitTypeAliases(`[{"name":"tsf-type-metadata","config":{"emitTypeAliases":true}}]`) {
		t.Fatal("emitTypeAliases=true should enable alias metadata")
	}
}

func TestUndecoratedMethodEmissionDefaultsOnAndCanBeDisabled(t *testing.T) {
	defaultConfig := readTypeCompilerPluginConfig("")
	if defaultConfig.EmitUndecoratedMethods != nil {
		t.Fatal("undecorated method metadata should default to enabled")
	}
	disabled := readTypeCompilerPluginConfig(`[{"name":"tsf-type-metadata","config":{"emitUndecoratedMethods":false}}]`)
	if disabled.EmitUndecoratedMethods == nil || *disabled.EmitUndecoratedMethods {
		t.Fatal("emitUndecoratedMethods=false should disable undecorated method metadata")
	}
}

func TestMetadataTypeInternerDeduplicatesExpressionsAndAvoidsSourceNames(t *testing.T) {
	interner := newMetadataTypeInterner("const __tsf_metadata_type_0 = 'application value'")
	first := interner.reference("{kind: 6}")
	repeated := interner.reference("{kind: 6}")
	second := interner.reference("{kind: 7}")

	if first != repeated {
		t.Fatalf("repeated metadata expression names differ: %q != %q", first, repeated)
	}
	if first == second {
		t.Fatalf("different metadata expressions share name %q", first)
	}
	if first != "___tsf_metadata_type(0)" {
		t.Fatalf("collision-safe metadata name = %q", first)
	}
	if len(interner.expressions) != 2 {
		t.Fatalf("interned expression count = %d, want 2", len(interner.expressions))
	}
}

func TestTypeExprResolvesReexportedGenericAliases(t *testing.T) {
	consumer, reg := testTypeInfo()
	consumer.moduleKey = "test/consumer"
	consumer.imports["Length"] = importRef{source: "test/index", exportName: "Length", spec: "../src"}
	index := &fileInfo{
		moduleKey: "test/index",
		aliases:   map[string]aliasInfo{},
		imports:   map[string]importRef{},
		reexports: map[string]importRef{
			"Length": {source: "test/types", exportName: "Length", spec: "./types"},
		},
	}
	types := &fileInfo{
		moduleKey: "test/types",
		aliases: map[string]aliasInfo{
			"Length": {body: "string & MinLength<T> & MaxLength<T> & TypeAnnotation<'tsf:length', T>", params: []string{"T"}},
		},
		imports:   map[string]importRef{},
		reexports: map[string]importRef{},
	}
	reg.files = map[string]*fileInfo{consumer.moduleKey: consumer, index.moduleKey: index, types.moduleKey: types}
	reg.byPath = map[string]*fileInfo{consumer.moduleKey: consumer, index.moduleKey: index, types.moduleKey: types}

	got := typeExpr(consumer, reg, "Length<4>")
	assertContainsAll(t, got,
		"typeName: \"Length\"",
		"typeName: \"MinLength\"",
		"validation: [{name: \"minLength\", args: [{kind: 10, literal: 4}]}]",
		"typeName: \"MaxLength\"",
		"validation: [{name: \"maxLength\", args: [{kind: 10, literal: 4}]}]",
		"annotations: {\"tsf:length\": {kind: 10, literal: 4}}",
	)

	bounded := typeExpr(consumer, reg, "number & GreaterThan<0> & LessThan<100>")
	assertContainsAll(t, bounded,
		"typeName: \"GreaterThan\"",
		"validation: [{name: \"greaterThan\", args: [{kind: 10, literal: 0}]}]",
		"typeName: \"LessThan\"",
		"validation: [{name: \"lessThan\", args: [{kind: 10, literal: 100}]}]",
	)
}

func assertContainsAll(t *testing.T, got string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(got, want) {
			t.Fatalf("expression %q does not contain %q", got, want)
		}
	}
}

func assertNotContains(t *testing.T, got string, unwanted string) {
	t.Helper()
	if strings.Contains(got, unwanted) {
		t.Fatalf("expression %q unexpectedly contains %q", got, unwanted)
	}
}

func TestClassMetadataRendersPropertiesMethodsAndConstructor(t *testing.T) {
	info, reg := testTypeInfo()
	class := &classInfo{
		name: "User",
		properties: []propertyInfo{
			{name: "id", typeText: "number & PrimaryKey & AutoIncrement"},
			{name: "email", typeText: "string & Unique<{ name: 'users_email_unique' }>"},
		},
		methods: []methodInfo{
			{name: "rename", description: "Rename the user.", params: []paramInfo{{name: "email", typeText: "string"}}, returnType: "void"},
		},
		ctor:    []paramInfo{{name: "email", typeText: "string", hasDefault: true}},
		hasCtor: true,
	}

	got := classMetadata(info, reg, class, nil)
	for _, want := range []string{
		"name: \"User\"",
		"primaryKey: true",
		"autoIncrement: true",
		"unique: {name: \"users_email_unique\"}",
		"name: \"rename\", parameters: [{name: \"email\", type: {kind: 6}, optional: false, default: false}], returnType: {kind: 3}",
		"description: \"Rename the user.\"",
		"constructorParameters: [{name: \"email\", type: {kind: 6}, optional: false, default: true}]",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("class metadata %q does not contain %q", got, want)
		}
	}
}

func TestClassMetadataCanOmitUndecoratedMethods(t *testing.T) {
	info, reg := testTypeInfo()
	class := &classInfo{
		name:                 "Controller",
		decoratedMethodsOnly: true,
		methods: []methodInfo{
			{name: "index", returnType: "string", decorated: true},
			{name: "helper", returnType: "number"},
		},
	}

	got := classMetadata(info, reg, class, nil)
	assertContainsAll(t, got, "name: \"index\"")
	assertNotContains(t, got, "name: \"helper\"")
}

func TestCleanJsDocDescriptionUsesTheFirstParagraph(t *testing.T) {
	got := cleanJsDocDescription(`/**
 * List users using the documented summary.
 * Continues on the next line.
 *
 * This detail is not part of the summary.
 * @returns users
 */`)
	if got != "List users using the documented summary. Continues on the next line." {
		t.Fatalf("description = %q", got)
	}
}
