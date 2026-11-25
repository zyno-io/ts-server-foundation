package main

import (
	"regexp"
	"sort"
)

func precomputeMetadataExpressions(reg *registry, emitTypeAliases bool) {
	if reg == nil {
		return
	}
	// Exported alias metadata comes first, for every file. A reference to an exported
	// alias reads its cached metadata when it is filled and expands the alias body
	// otherwise, and the body expansion cannot resolve checker algebra such as
	// Exclude<...> or (typeof X)[number]. Importers fill the cache on demand, but a
	// class in the alias's own file was precomputed before the file's aliases, so
	// whether it saw the cache depended on whether an importer had been visited
	// first. Filling every exported alias before any class, call or emission plan
	// gives each reference the published metadata. This runs whether or not alias
	// registries are emitted, since importers compute the same metadata anyway.
	for _, info := range reg.orderedFiles() {
		if info.precompute {
			precomputeExportedAliasMetadata(info, reg)
		}
	}
	// TypeScript-Go emits files in parallel, and checker-backed Typia reads are not
	// safe from WriteFile callbacks. Cache metadata for emitted source files first.
	for _, info := range reg.orderedFiles() {
		if !info.precompute {
			continue
		}
		for _, class := range info.classes {
			if class.ambient {
				continue
			}
			precomputeClassMetadataExpressions(info, reg, class)
		}
		for i := range info.calls {
			info.calls[i].metadataText = typeExprForNodePreferred(info, reg, info.calls[i].typeText, info.calls[i].typeNode, info.calls[i].pos, info.calls[i].preferTypia)
		}
	}
}

func precomputeExportedAliasMetadata(info *fileInfo, reg *registry) {
	names := exportedTypeAliasNames(info, reg, map[string]bool{})
	for _, name := range sameFileAliasDependencyOrder(info, names) {
		precomputeAliasMetadata(info, reg, name, info.aliases[name])
	}
	for _, name := range names {
		if _, ok := info.aliases[name]; ok {
			continue
		}
		if alias, owner, ownerName, ok := resolveExportedAlias(info, reg, name, map[string]bool{}); ok {
			precomputeAliasMetadata(owner, reg, ownerName, alias)
		}
	}
}

var aliasReferencePattern = regexp.MustCompile(`[A-Za-z_$][\w$]*`)

// sameFileAliasDependencyOrder orders the file's exported, non-generic aliases among names so that
// an alias comes after the same-file aliases its body references. A same-file reference reads the
// referenced alias's cached metadata when it is filled and expands the alias body otherwise, and
// the body expansion cannot resolve checker algebra: with name order,
// `ALive = BLive | null` was filled before `BLive = Exclude<...>` and got an unresolved Exclude
// class reference. Aliases that reference each other keep name order among themselves, which keeps
// a cycle's references on the body expansion and its shared recursion guards. Resolving them from
// each other's metadata would unroll the cycle once per member.
//
// References are found by name in the alias text. A name that is not an alias reference only adds
// an ordering constraint.
func sameFileAliasDependencyOrder(info *fileInfo, names []string) []string {
	local := []string{}
	isLocal := map[string]bool{}
	for _, name := range names {
		if alias, ok := info.aliases[name]; ok && len(alias.params) == 0 {
			local = append(local, name)
			isLocal[name] = true
		}
	}
	edges := map[string][]string{}
	for _, name := range local {
		seen := map[string]bool{}
		for _, reference := range aliasReferencePattern.FindAllString(stripTypeComments(info.aliases[name].body), -1) {
			if isLocal[reference] && !seen[reference] {
				seen[reference] = true
				edges[name] = append(edges[name], reference)
			}
		}
		sort.Strings(edges[name])
	}
	// Tarjan's algorithm emits strongly connected components dependencies first.
	order := []string{}
	index := 0
	indexes := map[string]int{}
	lowlinks := map[string]int{}
	onStack := map[string]bool{}
	stack := []string{}
	var visit func(string)
	visit = func(name string) {
		indexes[name] = index
		lowlinks[name] = index
		index++
		stack = append(stack, name)
		onStack[name] = true
		for _, next := range edges[name] {
			if _, ok := indexes[next]; !ok {
				visit(next)
				lowlinks[name] = min(lowlinks[name], lowlinks[next])
			} else if onStack[next] {
				lowlinks[name] = min(lowlinks[name], indexes[next])
			}
		}
		if lowlinks[name] != indexes[name] {
			return
		}
		component := []string{}
		for {
			last := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			onStack[last] = false
			component = append(component, last)
			if last == name {
				break
			}
		}
		sort.Strings(component)
		order = append(order, component...)
	}
	for _, name := range local {
		if _, ok := indexes[name]; !ok {
			visit(name)
		}
	}
	return order
}

func precomputeAliasMetadata(info *fileInfo, reg *registry, name string, alias aliasInfo) {
	if info == nil || len(alias.params) != 0 || alias.metadataText != "" || alias.metadataTooLarge {
		return
	}
	// Each alias is computed once. A cycle reaches an alias that is still being computed;
	// that reference keeps the alias body expansion, with its recursion guards.
	if reg != nil {
		key := info.moduleKey + "\x00" + name
		if reg.aliasMetadataInProgress == nil {
			reg.aliasMetadataInProgress = map[string]bool{}
		}
		if reg.aliasMetadataInProgress[key] {
			return
		}
		reg.aliasMetadataInProgress[key] = true
		defer delete(reg.aliasMetadataInProgress, key)
	}
	metadata := typeExprForNodePreferred(info, reg, alias.body, alias.typeNode, alias.pos, shouldPreferTypiaAliasMetadata(info, reg, alias.body, alias.typeNode, alias.pos))
	if metadataExprTooLarge(metadata) {
		alias.metadataTooLarge = true
		info.aliases[name] = alias
		return
	}
	alias.metadataText = metadata
	info.aliases[name] = alias
}

func precomputeClassMetadataExpressions(info *fileInfo, reg *registry, class *classInfo) {
	if class == nil {
		return
	}
	for i := range class.properties {
		prop := &class.properties[i]
		if prop.typeNode == nil && prop.declaration != nil && reg.checker != nil {
			inferredType := reg.checker.GetTypeAtLocation(prop.declaration)
			if metadata, ok := typiaTypeExprFromType(info, reg, inferredType, class.pos, ""); ok {
				prop.metadataText = metadata
				continue
			}
		}
		prop.metadataText = typeExprForNode(info, reg, prop.typeText, prop.typeNode, class.pos)
	}
	for i := range class.methods {
		method := &class.methods[i]
		if class.decoratedMethodsOnly && !method.decorated {
			continue
		}
		method.returnMetadataText = methodReturnTypeExpr(info, reg, method.returnType, method.returnTypeNode, class.pos, method.preferTypia)
		precomputeParamMetadataExpressions(info, reg, method.params, class.pos, method.preferTypia)
	}
	precomputeParamMetadataExpressions(info, reg, class.ctor, class.pos, false)
}

func precomputeParamMetadataExpressions(info *fileInfo, reg *registry, params []paramInfo, pos int, preferTypia bool) {
	for i := range params {
		param := &params[i]
		if preferTypia {
			if expr, ok := preferredWrapperTypeExprForNode(info, reg, param.typeText, param.typeNode, pos); ok {
				param.metadataText = expr
				continue
			}
			param.metadataText = typeExprForNode(info, reg, param.typeText, param.typeNode, pos)
			continue
		}
		param.metadataText = typeExprForNodePreferred(info, reg, param.typeText, param.typeNode, pos, preferTypia)
	}
}
