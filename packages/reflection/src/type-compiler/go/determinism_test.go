package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// The compiler queries the checker and fills its alias, Typia and failure caches on first use, so
// metadata depends on the order in which files are visited. Compiling the same fixture repeatedly
// must produce byte-identical JavaScript, and that JavaScript must be correct. The fixture spreads
// cross-file alias, interface and receive-type references over several files so that a pass which
// ranges over a Go map, whose iteration order changes on every run, reorders those first uses and
// changes the output. entity.ts uses its own exported checker-algebra aliases: their metadata must
// be the resolved union whether or not an importing file filled the alias cache first.
func TestCompilerOutputIsDeterministic(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"tsconfig.json": `{"compilerOptions": {"strict": true, "target": "ES2022", "module": "commonjs", "experimentalDecorators": true}, "include": ["*.ts"], "reflection": true}`,
		"shared.ts": `
export type Status = 'zeta' | 'alpha' | 'mid';
export type Kept = Exclude<Status, 'mid'>;
export type Picked = Pick<Row, 'status' | 'kept'>;
export interface Row {
	status: Status;
	kept: Kept;
	label: string;
}
export type ReceiveType<T> = { readonly __type?: T };
export function described<T>(value: unknown, type?: ReceiveType<T>): T {
	return value as T;
}
export class SharedModel {
	status!: Status;
	kept!: Kept;
	picked!: Picked;
}
`,
		"entity.ts": `
export type AccountStatus = 'active' | 'suspended' | 'deleted';
export type LiveStatus = Exclude<AccountStatus, 'deleted'>;
export const KINDS = ['monitor', 'probe'] as const;
export type Kind = (typeof KINDS)[number];
export class Account {
	status!: LiveStatus;
	kind!: Kind;
}
`,
	}
	for index := 0; index < 6; index++ {
		files[fmt.Sprintf("consumer%d.ts", index)] = fmt.Sprintf(`
import { described, Kept, Picked, Row, Status } from './shared';
import { Kind, LiveStatus } from './entity';
export type Local%[1]d = Kept | 'local%[1]d';
export class Consumer%[1]d {
	row!: Row;
	kept!: Kept;
	picked!: Picked;
	local!: Local%[1]d;
	live!: LiveStatus;
	kind!: Kind;
	method(status: Status, row: Partial<Row>): Kept {
		return described<Kept>(status);
	}
}
`, index)
	}
	for name, source := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(source), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	const runs = 12
	var first map[string]string
	for run := 0; run < runs; run++ {
		output, account := compileFixture(t, root, filepath.Join(root, fmt.Sprintf("out%d", run)))
		assertAccountMetadata(t, run, account)
		if len(output) == 0 {
			t.Fatal("the fixture emitted no JavaScript")
		}
		if first == nil {
			first = output
			if !strings.Contains(strings.Join(mapValues(output), "\n"), "createCompactMetadataRegistry") &&
				!strings.Contains(strings.Join(mapValues(output), "\n"), "__tsfTypeAliases") {
				t.Fatal("the fixture emitted no reflection metadata")
			}
			continue
		}
		for name, text := range first {
			if output[name] != text {
				t.Fatalf("run %d emitted different %s:\n--- run 0\n%s\n--- run %d\n%s", run, name, firstDifference(text, output[name]), run, firstDifference(output[name], text))
			}
		}
		if len(output) != len(first) {
			t.Fatalf("run %d emitted %d files, run 0 emitted %d", run, len(output), len(first))
		}
	}
}

// assertAccountMetadata checks that entity.ts's own class reads its exported aliases as the
// resolved literal unions, not as an unresolved Exclude class reference or an unknown.
func assertAccountMetadata(t *testing.T, run int, account *classInfo) {
	t.Helper()
	if account == nil || len(account.properties) != 2 {
		t.Fatalf("run %d: Account was not collected", run)
	}
	for _, prop := range account.properties {
		got := prop.metadataText
		var want []string
		switch prop.name {
		case "status":
			want = []string{`{kind: 10, literal: "active"}`, `{kind: 10, literal: "suspended"}`, `typeName: "LiveStatus"`}
		case "kind":
			want = []string{`{kind: 10, literal: "monitor"}`, `{kind: 10, literal: "probe"}`, `typeName: "Kind"`}
		}
		for _, item := range want {
			if !strings.Contains(got, item) {
				t.Fatalf("run %d: Account.%s = %s, want it to contain %s", run, prop.name, got, item)
			}
		}
		if strings.Contains(got, `"deleted"`) || strings.Contains(got, "classType") || strings.HasPrefix(got, "{kind: 2") {
			t.Fatalf("run %d: Account.%s is unresolved: %s", run, prop.name, got)
		}
	}
}

func compileFixture(t *testing.T, root string, outDir string) (map[string]string, *classInfo) {
	t.Helper()
	program, diagnostics, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{SingleThreaded: true, ForceEmit: true, OutDir: outDir})
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("load: %v %v", err, diagnostics)
	}
	defer func() { _ = program.Close() }()
	if diagnostics := program.Diagnostics(); len(diagnostics) != 0 {
		t.Fatalf("diagnostics: %v", diagnostics)
	}
	reg := collectRegistry(program, root, true, true)
	account := reg.classes["Account"]
	plans, err := buildEmissionPlans(reg, program, true, true)
	if err != nil {
		t.Fatal(err)
	}
	emitDiagnostics, err := program.EmitWithPluginTransformers([]driver.PluginTransform{metadataTransform(plans)}, nil)
	if err != nil || driver.CountErrors(emitDiagnostics) != 0 {
		t.Fatalf("emit: %v %v", err, emitDiagnostics)
	}
	output := map[string]string{}
	err = filepath.Walk(outDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".js") {
			return err
		}
		text, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(outDir, path)
		output[rel] = string(text)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return output, account
}

// firstDifference returns the text around the first byte where text differs from other.
func firstDifference(text string, other string) string {
	index := 0
	for index < len(text) && index < len(other) && text[index] == other[index] {
		index++
	}
	start := max(0, index-160)
	end := min(len(text), index+240)
	return "..." + text[start:end] + "..."
}

func mapValues(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, values[key])
	}
	return out
}
