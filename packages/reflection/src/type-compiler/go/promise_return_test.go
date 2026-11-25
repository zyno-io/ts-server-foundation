package main

import (
	"strings"
	"testing"
)

// A method whose return type the checker resolves to a Promise must describe the awaited type, not
// the Promise object, however the type is spelled. Both encoders are covered: preferTypia is on for
// TSF's own http verb decorators and off for routes registered through a wrapper decorator.
func TestMethodReturnTypesUnwrapPromisesHoweverSpelled(t *testing.T) {
	info, reg := loadJsDocProbe(t, `
type ApiResponse<T, Status extends number = 200> = Promise<T>;
interface Dto { id: string; }
class Service {
	async asyncMethod(): Promise<Dto> { return null as never; }
	async created(): ApiResponse<Dto, 201> { return null as never; }
	async wrapped(): Promise<ApiResponse<Dto, 202>> { return null as never; }
}
type DtoPromise = Promise<Dto>;
type Async<T> = Promise<T>;
interface Api { load: Promise<Dto>; }
export class Handlers {
	returnType(): ReturnType<Service['asyncMethod']> { return null as never; }
	alias(): DtoPromise { return null as never; }
	generic(): Async<Dto> { return null as never; }
	indexed(): Api['load'] { return null as never; }
	promiseLike(): PromiseLike<Dto> { return null as never; }
	apiResponse(): ReturnType<Service['created']> { return null as never; }
	nestedApiResponse(): ReturnType<Service['wrapped']> { return null as never; }
	written(): Promise<Dto> { return null as never; }
	plain(): Dto { return null as never; }
}
`)
	class := reg.classes["Handlers"]
	if class == nil {
		t.Fatal("Handlers was not collected")
	}
	dto := `{kind: 18, typeName: "Dto", types: [{kind: 20, name: "id", type: {kind: 6}, optional: false}]}`
	want := map[string]string{
		"returnType":        `{kind: 22, type: ` + dto + `}`,
		"alias":             `{kind: 22, type: ` + dto,
		"generic":           `{kind: 22, type: ` + dto,
		"indexed":           `{kind: 22, type: ` + dto + `}`,
		"promiseLike":       `{kind: 22, type: ` + dto + `}`,
		"apiResponse":       `{kind: 22, typeName: "ApiResponse", type: ` + dto + `, typeArguments: [` + dto + `, {kind: 10, literal: 201}]}`,
		"nestedApiResponse": `{kind: 22, type: {kind: 22, typeName: "ApiResponse", type: ` + dto + `, typeArguments: [` + dto + `, {kind: 10, literal: 202}]}}`,
		"written":           `{kind: 22, type: ` + dto,
		"plain":             dto,
	}
	for _, method := range class.methods {
		expected, ok := want[method.name]
		if !ok {
			t.Fatalf("unexpected method %s", method.name)
		}
		for _, preferTypia := range []bool{true, false} {
			got := methodReturnTypeExpr(info, reg, method.returnType, method.returnTypeNode, class.pos, preferTypia)
			if !strings.HasPrefix(got, expected) {
				t.Errorf("%s (preferTypia=%v) = %s\nwant prefix %s", method.name, preferTypia, got, expected)
			}
			if strings.Contains(got, "toStringTag") || strings.Contains(got, `name: "then"`) {
				t.Errorf("%s (preferTypia=%v) describes the Promise object: %s", method.name, preferTypia, got)
			}
		}
	}

	// Precomputed class metadata, which the emitted class reflection reads, takes the same path.
	precomputeClassMetadataExpressions(info, reg, class)
	for _, method := range class.methods {
		if !strings.HasPrefix(method.returnMetadataText, want[method.name]) {
			t.Errorf("precomputed %s = %s\nwant prefix %s", method.name, method.returnMetadataText, want[method.name])
		}
	}
}

// Only an ApiResponse alias that is a Promise is unwrapped; a user type that happens to be named
// ApiResponse keeps its object structure.
func TestNonPromiseApiResponseAliasIsNotUnwrapped(t *testing.T) {
	info, reg := loadJsDocProbe(t, `
type ApiResponse<T> = { data: T; ok: boolean };
interface Dto { id: string; }
class Service {
	get(): ApiResponse<Dto> { return null as never; }
}
export class Handlers {
	get(): ReturnType<Service['get']> { return null as never; }
}
`)
	class := reg.classes["Handlers"]
	method := class.methods[0]
	for _, preferTypia := range []bool{true, false} {
		got := methodReturnTypeExpr(info, reg, method.returnType, method.returnTypeNode, class.pos, preferTypia)
		if strings.HasPrefix(got, "{kind: 22") || !strings.Contains(got, `name: "data"`) || !strings.Contains(got, `name: "ok"`) {
			t.Errorf("preferTypia=%v: %s, want the ApiResponse object", preferTypia, got)
		}
	}
}
