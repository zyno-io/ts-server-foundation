package main

import (
	"strings"
	"testing"
)

// Under TSF's own http verb decorators (preferTypia), an inline object that is an array element in
// an HttpBody or Promise payload keeps its member JSDoc, as on the wrapper-decorator path. The
// structure, which validation reads, must stay exactly what it was before docs were kept; the
// golden values below are this fixture's metadata on main with the JSDoc fields removed.
func TestPreferredRouteArrayElementObjectsKeepMemberJsDoc(t *testing.T) {
	info, reg := loadJsDocProbe(t, `
type HttpBody<T> = T & { readonly __body?: T };
export class Handlers {
	body(body: HttpBody<{
		/** Suffix holder doc. */
		items: {
			/** Suffix item doc. */
			a: string;
		}[];
		/** Generic holder doc. */
		gen: Array<{
			/** Generic item doc. */
			b: string;
		}>;
	}>): Promise<{
		/** Rows holder doc. */
		rows: {
			/** Row item doc. */
			c: string;
		}[];
		/** Generic rows holder doc. */
		genericRows: Array<{
			/** Generic row item doc. */
			d: string;
		}>;
	}> { return null as never; }
	mixed(body: HttpBody<{
		/** Mixed holder doc. */
		mixed: {
			/** Mixed item doc. */
			at: Date;
			/** Mixed plain doc. */
			label: string;
		}[];
		/** Tuple doc. */
		tuple: [{
			/** Tuple item doc. */
			t: string;
		}];
	}>): void {}
}
`)
	class := reg.classes["Handlers"]
	if class == nil {
		t.Fatal("Handlers was not collected")
	}
	for i := range class.methods {
		// isHttpRouteMethod sets this for TSF's http verb decorators, which the probe cannot import.
		class.methods[i].preferTypia = true
	}
	precomputeClassMetadataExpressions(info, reg, class)
	methods := map[string]methodInfo{}
	for _, method := range class.methods {
		methods[method.name] = method
	}
	check := func(label string, got string, golden string, docs ...string) {
		t.Helper()
		if bare := withoutJsDocFields(got); bare != golden {
			t.Errorf("%s structure changed:\n got %s\nwant %s", label, bare, golden)
		}
		for _, doc := range docs {
			if !strings.Contains(got, `description: "`+doc+`"`) {
				t.Errorf("%s lost %q: %s", label, doc, got)
			}
		}
	}
	check("body param", methods["body"].params[0].metadataText, `{kind: 13, typeName: "HttpBody", types: [{kind: 18, types: [{kind: 20, name: "items", type: {kind: 14, type: {kind: 18, types: [{kind: 20, name: "a", type: {kind: 6}, optional: false}]}}, optional: false}, {kind: 20, name: "gen", type: {kind: 14, type: {kind: 18, types: [{kind: 20, name: "b", type: {kind: 6}, optional: false}]}}, optional: false}]}, {kind: 2, typeName: "HttpBody", annotations: {"httpBody": {kind: 18, types: [{kind: 20, name: "type", type: {kind: 18, types: [{kind: 20, name: "items", type: {kind: 14, type: {kind: 18, types: [{kind: 20, name: "a", type: {kind: 6}, optional: false}]}}, optional: false}, {kind: 20, name: "gen", type: {kind: 14, type: {kind: 18, types: [{kind: 20, name: "b", type: {kind: 6}, optional: false}]}}, optional: false}]}, optional: false}]}}}]}`,
		"Suffix holder doc.", "Suffix item doc.", "Generic holder doc.", "Generic item doc.")
	check("body return", methods["body"].returnMetadataText, `{kind: 22, type: {kind: 18, types: [{kind: 20, name: "rows", type: {kind: 14, type: {kind: 18, types: [{kind: 20, name: "c", type: {kind: 6}, optional: false}]}}, optional: false}, {kind: 20, name: "genericRows", type: {kind: 14, type: {kind: 18, types: [{kind: 20, name: "d", type: {kind: 6}, optional: false}]}}, optional: false}]}}`,
		"Rows holder doc.", "Row item doc.", "Generic rows holder doc.", "Generic row item doc.")
	check("mixed param", methods["mixed"].params[0].metadataText, `{kind: 13, typeName: "HttpBody", types: [{kind: 18, types: [{kind: 20, name: "mixed", type: {kind: 14, type: {kind: 18, types: [{kind: 20, name: "at", type: {kind: 16, typeName: "Date", classType: () => (typeof Date !== "undefined" ? Date : (typeof exports !== "undefined" ? exports.Date : undefined))}, optional: false}, {kind: 20, name: "label", type: {kind: 6}, optional: false}]}}, optional: false}, {kind: 20, name: "tuple", type: {kind: 15, typeName: "[{ t: string; }]", types: [{type: {kind: 18, types: [{kind: 20, name: "t", type: {kind: 6}, optional: false}]}}]}, optional: false}]}, {kind: 2, typeName: "HttpBody", annotations: {"httpBody": {kind: 18, types: [{kind: 20, name: "type", type: {kind: 18, types: [{kind: 20, name: "mixed", type: {kind: 14, type: {kind: 18, types: [{kind: 20, name: "at", type: {kind: 16, typeName: "Date", classType: () => (typeof Date !== "undefined" ? Date : (typeof exports !== "undefined" ? exports.Date : undefined))}, optional: false}, {kind: 20, name: "label", type: {kind: 6}, optional: false}]}}, optional: false}, {kind: 20, name: "tuple", type: {kind: 15, typeName: "[{ t: string; }]", types: [{type: {kind: 18, types: [{kind: 20, name: "t", type: {kind: 6}, optional: false}]}}]}, optional: false}]}, optional: false}]}}}]}`,
		"Mixed holder doc.", "Mixed item doc.", "Mixed plain doc.", "Tuple doc.", "Tuple item doc.")
}

func TestWithoutJsDocFieldsKeepsLiteralText(t *testing.T) {
	for _, test := range []struct{ expr, want string }{
		{
			`{kind: 20, name: "a", type: {kind: 10, literal: "x, description: \"y\""}, optional: false, description: "Doc \"quoted\".", deprecated: "", sunset: "2027-01-01"}`,
			`{kind: 20, name: "a", type: {kind: 10, literal: "x, description: \"y\""}, optional: false}`,
		},
		{
			// A string ending in a field-like suffix must not swallow the structure after it.
			`{kind: 20, name: "a", type: {kind: 10, literal: "x, description: "}, optional: false}, {kind: 20, name: "b", optional: true}`,
			`{kind: 20, name: "a", type: {kind: 10, literal: "x, description: "}, optional: false}, {kind: 20, name: "b", optional: true}`,
		},
	} {
		if got := withoutJsDocFields(test.expr); got != test.want {
			t.Errorf("withoutJsDocFields(%s) = %s, want %s", test.expr, got, test.want)
		}
	}
}
