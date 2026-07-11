package main

func precomputeMetadataExpressions(reg *registry) {
	if reg == nil {
		return
	}
	// TypeScript-Go emits files in parallel, and checker-backed Typia reads are not
	// safe from WriteFile callbacks. Cache metadata for emitted source files first.
	for _, info := range reg.files {
		if !info.precompute {
			continue
		}
		for name, alias := range info.aliases {
			if len(alias.params) == 0 {
				precomputeAliasMetadata(info, reg, name, alias)
			}
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
		precomputeExportedAliasMetadata(info, reg)
	}
}

func precomputeExportedAliasMetadata(info *fileInfo, reg *registry) {
	for _, name := range exportedTypeAliasNames(info, reg, map[string]bool{}) {
		if alias, ok := info.aliases[name]; ok {
			precomputeAliasMetadata(info, reg, name, alias)
			continue
		}
		if alias, owner, ownerName, ok := resolveExportedAlias(info, reg, name, map[string]bool{}); ok {
			precomputeAliasMetadata(owner, reg, ownerName, alias)
		}
	}
}

func precomputeAliasMetadata(info *fileInfo, reg *registry, name string, alias aliasInfo) {
	if info == nil || len(alias.params) != 0 || alias.metadataText != "" || alias.metadataTooLarge {
		return
	}
	metadata := typeExprForNodePreferred(info, reg, alias.body, alias.typeNode, alias.pos, shouldPreferTypiaAliasMetadata(info, reg, alias.body, alias.pos))
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
		prop.metadataText = typeExprForNode(info, reg, prop.typeText, prop.typeNode, class.pos)
	}
	for i := range class.methods {
		method := &class.methods[i]
		method.returnMetadataText = typeExprForNodePreferred(info, reg, method.returnType, method.returnTypeNode, class.pos, method.preferTypia)
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
