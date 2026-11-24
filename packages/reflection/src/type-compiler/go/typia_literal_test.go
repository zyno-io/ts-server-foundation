package main

import "testing"

// Stand-ins for tsgo's internal jsnum.Number and jsnum.PseudoBigInt.
type fakeJSNumber float64

type fakePseudoBigInt struct {
	Negative    bool
	Base10Value string
}

func TestTypiaLiteralExprEmitsNumbersAsLiterals(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  string
	}{
		{"named float64", fakeJSNumber(1), "1"},
		{"named float64 fraction", fakeJSNumber(-2.5), "-2.5"},
		{"float32", float32(3), "3"},
		// Bigint literals stay quoted: nothing at runtime converts JSON/query input to a bigint.
		{"bigint stays quoted", fakePseudoBigInt{Base10Value: "12"}, `"{false 12}"`},
		{"string", "a", `"a"`},
		{"unknown struct", struct{ A int }{1}, `"{1}"`},
	}
	for _, tc := range cases {
		if got := typiaLiteralExpr(tc.value); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestTypiaTagValueTypeExprKeepsNumberLiterals(t *testing.T) {
	if got, want := typiaTagValueTypeExpr(fakeJSNumber(5)), "{kind: 10, literal: 5}"; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
	if got, want := typiaPlainValueExpr(map[string]any{"a": fakeJSNumber(5)}), `{"a": 5}`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}
