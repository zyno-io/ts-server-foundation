package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// The router and OpenAPI choose 204 for EmptyResponse and 302 for RedirectResponse, and handle
// OkResponse and AnyResponse, by the return type's typeName. A Promise alias unwrapped through the
// checker must keep that name, both when it is reached through ReturnType (case A) and when it is
// imported through a local barrel that re-exports it from TSF (case B).
func TestUnwrappedResponseAliasesKeepTheirNames(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"tsconfig.json": `{"compilerOptions": {"strict": true, "target": "ES2022", "module": "nodenext", "moduleResolution": "nodenext", "experimentalDecorators": true}, "include": ["*.ts"], "reflection": true}`,
		"node_modules/@zyno-io/ts-server-foundation/package.json": `{"name": "@zyno-io/ts-server-foundation", "version": "1.0.0", "types": "index.d.ts"}`,
		"node_modules/@zyno-io/ts-server-foundation/index.d.ts": `
export type OkResponse = Promise<{ ok: true }>;
export type RedirectResponse = Promise<void>;
export type EmptyResponse = Promise<void>;
export type AnyResponse = Promise<any>;
`,
		"responses.ts": `export type { EmptyResponse, RedirectResponse } from '@zyno-io/ts-server-foundation';`,
		"controller.ts": `
import type { AnyResponse, EmptyResponse as DirectEmpty, OkResponse, RedirectResponse as DirectRedirect } from '@zyno-io/ts-server-foundation';
import type { EmptyResponse, RedirectResponse } from './responses';
declare function Route(method: string): MethodDecorator;
class Service {
	async empty(): DirectEmpty {}
	async redirect(): DirectRedirect {}
	async ok(): OkResponse { return { ok: true }; }
	async any(): AnyResponse { return null; }
}
export class Handlers {
	@Route('DELETE')
	emptyReturnType(): ReturnType<Service['empty']> { return null as never; }
	@Route('GET')
	redirectReturnType(): ReturnType<Service['redirect']> { return null as never; }
	@Route('POST')
	okReturnType(): ReturnType<Service['ok']> { return null as never; }
	@Route('GET')
	anyReturnType(): ReturnType<Service['any']> { return null as never; }
	@Route('DELETE')
	emptyBarrel(): EmptyResponse { return null as never; }
	@Route('GET')
	redirectBarrel(): RedirectResponse { return null as never; }
}
`,
	}
	for name, source := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	program, diagnostics, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{SingleThreaded: true})
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("load: %v %v", err, diagnostics)
	}
	t.Cleanup(func() { _ = program.Close() })
	if diagnostics := program.Diagnostics(); len(diagnostics) != 0 {
		t.Fatalf("diagnostics: %v", diagnostics)
	}
	reg := collectRegistry(program, root, true, true)
	var info *fileInfo
	for _, candidate := range reg.orderedFiles() {
		if filepath.Base(candidate.file.FileName()) == "controller.ts" {
			info = candidate
		}
	}
	class := reg.classes["Handlers"]
	if info == nil || class == nil {
		t.Fatal("Handlers was not collected")
	}
	want := map[string]string{
		"emptyReturnType":    "EmptyResponse",
		"redirectReturnType": "RedirectResponse",
		"okReturnType":       "OkResponse",
		"anyReturnType":      "AnyResponse",
		"emptyBarrel":        "EmptyResponse",
		"redirectBarrel":     "RedirectResponse",
	}
	for _, method := range class.methods {
		name := want[method.name]
		for _, preferTypia := range []bool{false, true} {
			got := methodReturnTypeExpr(info, reg, method.returnType, method.returnTypeNode, class.pos, preferTypia)
			if !strings.Contains(got, `typeName: "`+name+`"`) {
				t.Errorf("%s (preferTypia=%v) = %s, want typeName %q", method.name, preferTypia, got, name)
			}
			if strings.Contains(got, "toStringTag") {
				t.Errorf("%s (preferTypia=%v) describes the Promise object: %s", method.name, preferTypia, got)
			}
		}
	}
}
