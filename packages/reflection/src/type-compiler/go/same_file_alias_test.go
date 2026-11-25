package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// loadAliasFixture compiles files with collectRegistry and returns the registry.
func loadAliasFixture(t *testing.T, files map[string]string) *registry {
	t.Helper()
	root := t.TempDir()
	files["tsconfig.json"] = `{"compilerOptions": {"strict": true, "target": "ES2022", "module": "commonjs"}, "include": ["*.ts"], "reflection": true}`
	for name, source := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(source), 0o600); err != nil {
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
	return collectRegistry(program, root, true, true)
}

// assertResolvedLiveStatus checks that a property reads `Exclude<AccountStatus, 'deleted'>` as the
// resolved literal union, not as an unresolved Exclude class reference.
func assertResolvedLiveStatus(t *testing.T, label string, got string) {
	t.Helper()
	for _, item := range []string{`{kind: 10, literal: "active"}`, `{kind: 10, literal: "suspended"}`} {
		if !strings.Contains(got, item) {
			t.Errorf("%s = %s, want it to contain %s", label, got, item)
		}
	}
	if strings.Contains(got, `"deleted"`) || strings.Contains(got, "classType") {
		t.Errorf("%s is unresolved: %s", label, got)
	}
}

func classProperty(t *testing.T, reg *registry, className string, propName string) string {
	t.Helper()
	class := reg.classes[className]
	if class == nil {
		t.Fatalf("%s was not collected", className)
	}
	for _, prop := range class.properties {
		if prop.name == propName {
			return prop.metadataText
		}
	}
	t.Fatalf("%s.%s was not collected", className, propName)
	return ""
}

// An exported alias that references a same-file exported alias sorting after it (ALive -> BLive)
// must read the referenced alias's metadata, in its own file and in importers. The alias pass
// fills a file's aliases in name order, so ALive used to be computed while BLive's cache was still
// empty and got BLive's body expansion, an unresolved Exclude class reference.
func TestAliasesReferencingLaterSameFileAliasesResolve(t *testing.T) {
	reg := loadAliasFixture(t, map[string]string{
		"entity.ts": `
export type AccountStatus = 'active' | 'suspended' | 'deleted';
export type ALive = BLive | null;
export type BLive = Exclude<AccountStatus, 'deleted'>;
export type ZLive = BLive | null;
export class Account {
	a!: ALive;
	z!: ZLive;
}
`,
		"consumer.ts": `
import { ALive, ZLive } from './entity';
export class Consumer {
	a!: ALive;
	z!: ZLive;
}
`,
	})
	for _, item := range []struct{ class, prop string }{{"Account", "a"}, {"Account", "z"}, {"Consumer", "a"}, {"Consumer", "z"}} {
		got := classProperty(t, reg, item.class, item.prop)
		assertResolvedLiveStatus(t, item.class+"."+item.prop, got)
		if !strings.Contains(got, "{kind: 5}") {
			t.Errorf("%s.%s lost its null member: %s", item.class, item.prop, got)
		}
	}
}

// Aliases exported through a local export list, `export { X }` or `export type { X }`, are
// exported: they are precomputed and published like aliases with their own export keyword, so the
// owning file reads the same metadata as importers.
func TestAliasesExportedThroughExportListsArePrecomputed(t *testing.T) {
	reg := loadAliasFixture(t, map[string]string{
		"entity.ts": `
type AccountStatus = 'active' | 'suspended' | 'deleted';
type ListedLive = Exclude<AccountStatus, 'deleted'>;
type TypeListedLive = Exclude<AccountStatus, 'deleted'>;
type Internal = Exclude<AccountStatus, 'deleted'>;
export { ListedLive };
export type { TypeListedLive };
export class Account {
	listed!: ListedLive;
	typeListed!: TypeListedLive;
}
`,
		"consumer.ts": `
import { ListedLive, TypeListedLive } from './entity';
export class Consumer {
	listed!: ListedLive;
	typeListed!: TypeListedLive;
}
`,
	})
	var entity *fileInfo
	for _, info := range reg.orderedFiles() {
		if filepath.Base(info.file.FileName()) == "entity.ts" {
			entity = info
		}
	}
	if entity == nil {
		t.Fatal("entity.ts was not collected")
	}
	for name, exported := range map[string]bool{"ListedLive": true, "TypeListedLive": true, "Internal": false} {
		if got := entity.aliases[name].exported; got != exported {
			t.Errorf("%s exported = %v, want %v", name, got, exported)
		}
	}
	for _, name := range []string{"ListedLive", "TypeListedLive"} {
		if strings.TrimSpace(entity.aliases[name].metadataText) == "" {
			t.Errorf("%s was not precomputed", name)
		}
	}
	for _, item := range []struct{ class, prop string }{{"Account", "listed"}, {"Account", "typeListed"}, {"Consumer", "listed"}, {"Consumer", "typeListed"}} {
		assertResolvedLiveStatus(t, item.class+"."+item.prop, classProperty(t, reg, item.class, item.prop))
	}
}
