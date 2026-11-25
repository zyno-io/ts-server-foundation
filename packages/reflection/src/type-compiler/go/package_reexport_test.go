package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// An interface that a local barrel re-exports from a package, through
// `export type { IPreview } from '@scope/shared-api'`, must resolve on the text path to the
// package's published alias metadata, exactly like a direct import from the package. The barrel's re-export has no
// declaration in the registry, so it used to fall through to an unresolved class reference that
// OpenAPI rendered as an empty object schema.
func TestImportsOfPackageReexportsResolveToThePackage(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"tsconfig.json": `{"compilerOptions": {"strict": true, "target": "ES2022", "module": "nodenext", "moduleResolution": "nodenext", "experimentalDecorators": true}, "include": ["*.ts"], "reflection": true}`,
		"node_modules/@scope/shared-api/package.json":          `{"name": "@scope/shared-api", "version": "1.0.0", "types": "dist/index.d.ts"}`,
		"node_modules/@scope/shared-api/dist/index.d.ts":       `export * from './types';`,
		"node_modules/@scope/shared-api/dist/types/index.d.ts": `export * from './sales-export';`,
		"node_modules/@scope/shared-api/dist/types/sales-export.d.ts": `
export interface IRequest { timezone: string; }
export interface IPreview {
    rowCount: number;
    canExport: boolean;
    maximumRows: number;
    warnings: string[];
}
export type AsyncPreview = Promise<IPreview>;
`,
		"exports.types.ts": `
import type { IRequest as SharedRequest } from '@scope/shared-api';

export interface IRequest extends SharedRequest {
	preset?: string;
}

export type {
	IPreview
} from '@scope/shared-api';
`,
		"controller.ts": `
import type { IPreview, IRequest } from './exports.types';
import type { AsyncPreview } from '@scope/shared-api';
declare function Route(method: string): MethodDecorator;
export class ExportController {
	@Route('POST')
	async preview(body: IRequest): Promise<IPreview> { return null as never; }
	@Route('GET')
	load(): AsyncPreview { return null as never; }
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
	if info == nil {
		t.Fatal("controller.ts was not collected")
	}
	if ref, ok := packageReexportImport(info, reg, "IPreview"); !ok || ref.spec != "@scope/shared-api" || ref.exportName != "IPreview" {
		t.Fatalf("IPreview resolves to %#v, %v; want the package export", ref, ok)
	}
	// The barrel's own interface is not a package re-export.
	if ref, ok := packageReexportImport(info, reg, "IRequest"); ok {
		t.Fatalf("IRequest resolves to %#v, want the local barrel", ref)
	}

	class := reg.classes["ExportController"]
	if class == nil || len(class.methods) != 2 {
		t.Fatal("ExportController was not collected")
	}
	if class.methods[0].preferTypia {
		t.Fatal("the wrapper-decorated route must not be treated as a TSF http route")
	}
	want := `{kind: 22, type: ` + runtimeAliasPlaceholderName + `("@scope/shared-api", "IPreview", "IPreview")}`
	if got := class.methods[0].returnMetadataText; got != want {
		t.Fatalf("wrapper route return = %s\nwant %s", got, want)
	}
	// TSF verb routes keep the barrel's import identity, so Typia reads the interface's structure
	// from the checker as before.
	method := class.methods[0]
	got := methodReturnTypeExpr(info, reg, method.returnType, method.returnTypeNode, class.pos, true)
	for _, member := range []string{`typeName: "IPreview"`, `name: "rowCount"`, `name: "canExport"`, `name: "maximumRows"`, `name: "warnings"`} {
		if !strings.Contains(got, member) {
			t.Fatalf("TSF verb route return = %s\nwant it to contain %s", got, member)
		}
	}

	// A package alias of a Promise keeps its package boundary on both encoders: its metadata is
	// loaded from the package, not unwrapped through the checker.
	load := class.methods[1]
	wantAlias := runtimeAliasPlaceholderName + `("@scope/shared-api", "AsyncPreview", "AsyncPreview")`
	for _, preferTypia := range []bool{false, true} {
		if got := methodReturnTypeExpr(info, reg, load.returnType, load.returnTypeNode, class.pos, preferTypia); got != wantAlias {
			t.Fatalf("package Promise alias (preferTypia=%v) = %s\nwant %s", preferTypia, got, wantAlias)
		}
	}
}
