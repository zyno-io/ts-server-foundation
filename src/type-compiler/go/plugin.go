package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

const foundationPackageSpec = "@zyno-io/ts-server-foundation"

type registry struct {
	files         map[string]*fileInfo
	byPath        map[string]*fileInfo
	checker       *shimchecker.Checker
	typiaCache    map[typiaCacheKey]string
	typiaFailures map[*shimchecker.Type]bool
	classes       map[string]*classInfo
	external      map[string]map[string][]functionInfo
}

type typiaCacheKey struct {
	typ       *shimchecker.Type
	moduleKey string
	raw       string
	pos       int
}

type fileInfo struct {
	file       *shimast.SourceFile
	moduleKey  string
	precompute bool
	aliases    map[string]aliasInfo
	interfaces map[string][]interfaceInfo
	enums      map[string]enumInfo
	classes    []*classInfo
	functions  map[string][]functionInfo
	imports    map[string]importRef
	reexports  map[string]importRef
	exportStar []importRef
	calls      []callInfo
}

type aliasInfo struct {
	body             string
	params           []string
	defaults         []string
	typeNode         *shimast.Node
	metadataText     string
	metadataTooLarge bool
	pos              int
}

type interfaceInfo struct {
	body       string
	extends    []string
	properties []utilityProperty
	pos        int
	source     string
}

type enumInfo struct {
	name   string
	values []string
	pos    int
}

type importRef struct {
	source     string
	exportName string
	spec       string
}

type classInfo struct {
	name          string
	pos           int
	end           int
	ambient       bool
	properties    []propertyInfo
	methods       []methodInfo
	staticMethods []methodInfo
	ctor          []paramInfo
	hasCtor       bool
}

type propertyInfo struct {
	name         string
	typeText     string
	typeNode     *shimast.Node
	metadataText string
	optional     bool
}

type utilityProperty struct {
	name     string
	typeText string
	typeNode *shimast.Node
	optional bool
	owner    *fileInfo
}

type methodInfo struct {
	name               string
	description        string
	typeParams         []string
	returnType         string
	returnTypeNode     *shimast.Node
	returnMetadataText string
	preferTypia        bool
	params             []paramInfo
}

type functionInfo struct {
	name       string
	owner      string
	typeParams []string
	params     []paramInfo
	pos        int
}

type paramInfo struct {
	name         string
	typeText     string
	typeNode     *shimast.Node
	metadataText string
	optional     bool
	hasDefault   bool
}

type callInfo struct {
	name             string
	nodePos          int
	metadataArgIndex int
	typeText         string
	typeNode         *shimast.Node
	metadataText     string
	preferTypia      bool
	pos              int
}

type typeContext struct {
	seen  map[string]bool
	depth int
	pos   int
}

type hostOptions struct {
	checkers       int
	cwd            string
	emit           bool
	noEmit         bool
	outDir         string
	pluginsJSON    string
	quiet          bool
	singleThreaded bool
	tsconfig       string
	tsgoArgs       []string
	verbose        bool
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "tssf metadata host: expected command: build, check, or transform")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "build", "check":
		os.Exit(runBuild(os.Args[1], os.Args[2:]))
	case "transform":
		fmt.Fprintln(os.Stderr, "tssf metadata host: transform text output is not implemented in this POC")
		os.Exit(2)
	default:
		fmt.Fprintf(os.Stderr, "tssf metadata host: unsupported command %q\n", os.Args[1])
		os.Exit(2)
	}
}

func runBuild(command string, args []string) int {
	opts, ok := parseHostOptions(command, args)
	if !ok {
		return 2
	}
	if command == "check" {
		opts.noEmit = true
	}
	if opts.verbose {
		opts.quiet = false
	}
	prog, diags, err := driver.LoadProgram(opts.cwd, opts.tsconfig, driver.LoadProgramOptions{
		ForceEmit:      opts.emit,
		ForceNoEmit:    opts.noEmit,
		OutDir:         opts.outDir,
		SingleThreaded: opts.singleThreaded,
		Checkers:       opts.checkers,
		TsgoArgs:       opts.tsgoArgs,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "tssf metadata host: %v\n", err)
		return 2
	}
	if prog != nil {
		defer prog.Close()
	}
	if len(diags) > 0 {
		driver.WritePrettyDiagnostics(os.Stderr, diags, opts.cwd)
		return 2
	}
	if prog == nil {
		fmt.Fprintln(os.Stderr, "tssf metadata host: failed to load program")
		return 2
	}
	if diags := prog.Diagnostics(); len(diags) > 0 {
		driver.WritePrettyDiagnostics(os.Stderr, diags, opts.cwd)
		return 2
	}
	if opts.noEmit {
		return 0
	}

	if err := prog.ApplyLinkedPlugins(); err != nil {
		fmt.Fprintf(os.Stderr, "tssf metadata host: apply linked plugins: %v\n", err)
		return 2
	}
	reg := collectRegistry(prog, opts.cwd)
	plans, err := buildEmissionPlans(reg, prog)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tssf metadata host: build emission plans: %v\n", err)
		return 2
	}
	if !opts.quiet {
		fmt.Fprintf(os.Stdout, "// tssf metadata host: files=%d classes=%d\n", len(reg.files), len(reg.classes))
	}
	emitDiags, err := prog.EmitWithPluginTransformers([]driver.PluginTransform{metadataTransform(plans)}, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tssf metadata host: emit: %v\n", err)
		return 2
	}
	if len(emitDiags) > 0 {
		driver.WritePrettyDiagnostics(os.Stderr, emitDiags, opts.cwd)
	}
	if driver.CountErrors(emitDiags) > 0 {
		return 2
	}
	return 0
}

func parseHostOptions(command string, args []string) (hostOptions, bool) {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	cwd := fs.String("cwd", "", "project directory")
	emit := fs.Bool("emit", false, "force emit")
	noEmit := fs.Bool("noEmit", false, "force no emit")
	outDir := fs.String("outDir", "", "emit directory override")
	pluginsJSON := fs.String("plugins-json", "", "ttsc plugin manifest JSON")
	quiet := fs.Bool("quiet", true, "suppress summary")
	tsconfig := fs.String("tsconfig", "tsconfig.json", "project tsconfig")
	verbose := fs.Bool("verbose", false, "print summary")
	singleThreaded := fs.Bool("singleThreaded", false, "run TypeScript-Go single-threaded")
	checkers := fs.Int("checkers", 0, "type-checker pool size")
	tsgoArgsRaw := fs.String("tsgo-args", "", "JSON array of forwarded tsgo flags")
	if err := fs.Parse(args); err != nil {
		return hostOptions{}, false
	}
	var tsgoArgs []string
	if strings.TrimSpace(*tsgoArgsRaw) != "" {
		if err := json.Unmarshal([]byte(*tsgoArgsRaw), &tsgoArgs); err != nil {
			fmt.Fprintf(os.Stderr, "tssf metadata host: invalid --tsgo-args: %v\n", err)
			return hostOptions{}, false
		}
	}
	resolvedCwd := *cwd
	if resolvedCwd == "" {
		var err error
		resolvedCwd, err = os.Getwd()
		if err != nil {
			fmt.Fprintf(os.Stderr, "tssf metadata host: cwd: %v\n", err)
			return hostOptions{}, false
		}
	}
	if !filepath.IsAbs(resolvedCwd) {
		abs, err := filepath.Abs(resolvedCwd)
		if err != nil {
			fmt.Fprintf(os.Stderr, "tssf metadata host: cwd: %v\n", err)
			return hostOptions{}, false
		}
		resolvedCwd = abs
	}
	return hostOptions{
		checkers:       *checkers,
		cwd:            filepath.Clean(resolvedCwd),
		emit:           *emit,
		noEmit:         *noEmit,
		outDir:         *outDir,
		pluginsJSON:    *pluginsJSON,
		quiet:          *quiet,
		singleThreaded: *singleThreaded,
		tsconfig:       *tsconfig,
		tsgoArgs:       tsgoArgs,
		verbose:        *verbose,
	}, true
}
