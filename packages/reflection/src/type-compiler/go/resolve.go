package main

import (
	"sort"
	"strings"
)

func collectFlags(info *fileInfo, reg *registry, raw string) map[string]string {
	flags := map[string]string{}
	for _, part := range splitTop(raw, "&") {
		part = strings.TrimSpace(part)
		name, args, isGeneric := generic(part)
		if !isGeneric {
			name = part
		}
		switch name {
		case "PrimaryKey":
			flags["primaryKey"] = "true"
		case "AutoIncrement":
			flags["autoIncrement"] = "true"
		case "Reference":
			flags["reference"] = plainValue(firstOptionArg(args))
		case "Index":
			flags["index"] = plainValue(firstOptionArg(args))
		case "Indexed":
			flags["index"] = plainValue(optionArg(args, 1))
		case "Unique":
			flags["unique"] = plainValue(firstOptionArg(args))
		default:
			if alias, owner, ok := resolveAlias(info, reg, name); ok && alias.body != raw {
				for key, value := range collectFlags(owner, reg, alias.body) {
					flags[key] = value
				}
			}
		}
	}
	return flags
}

func resolveAlias(info *fileInfo, reg *registry, name string) (aliasInfo, *fileInfo, bool) {
	alias, owner, _, ok := resolveAliasRef(info, reg, name)
	return alias, owner, ok
}

func resolveAliasRef(info *fileInfo, reg *registry, name string) (aliasInfo, *fileInfo, *importRef, bool) {
	if alias, ok := info.aliases[name]; ok {
		return alias, info, nil, true
	}
	if ref, ok := info.imports[name]; ok {
		if target := reg.byPath[ref.source]; target != nil {
			alias, owner, ownerName, ok := resolveExportedAlias(target, reg, ref.exportName, map[string]bool{})
			if ok {
				ownerRef := importRef{
					source:     owner.moduleKey,
					exportName: ownerName,
					spec:       moduleSpecifierForFiles(info, owner),
				}
				return alias, owner, &ownerRef, true
			}
		}
	}
	return aliasInfo{}, nil, nil, false
}

func resolveInterface(info *fileInfo, reg *registry, name string) (string, *fileInfo, bool) {
	body, owner, _, ok := resolveInterfaceRefAt(info, reg, name, 0)
	return body, owner, ok
}

func resolveInterfaceRef(info *fileInfo, reg *registry, name string) (string, *fileInfo, *importRef, bool) {
	return resolveInterfaceRefAt(info, reg, name, 0)
}

func resolveInterfaceRefAt(info *fileInfo, reg *registry, name string, pos int) (string, *fileInfo, *importRef, bool) {
	decl, owner, ref, ok := resolveInterfaceDeclRefAt(info, reg, name, pos)
	if !ok {
		return "", nil, nil, false
	}
	return interfaceFullBody(owner, reg, decl, map[string]bool{}), owner, ref, true
}

func resolveInterfaceDeclRefAt(info *fileInfo, reg *registry, name string, pos int) (interfaceInfo, *fileInfo, *importRef, bool) {
	name = interfaceRefName(name)
	if decl, ok := chooseInterface(info, name, pos); ok {
		return decl, info, nil, true
	}
	if ref, ok := info.imports[name]; ok {
		if target := reg.byPath[ref.source]; target != nil {
			decl, owner, ownerName, ok := resolveExportedInterfaceDecl(target, reg, ref.exportName, map[string]bool{})
			if ok {
				ownerRef := importRef{
					source:     owner.moduleKey,
					exportName: ownerName,
					spec:       moduleSpecifierForFiles(info, owner),
				}
				return decl, owner, &ownerRef, true
			}
		}
	}
	return interfaceInfo{}, nil, nil, false
}

func resolveEnum(info *fileInfo, reg *registry, name string) (enumInfo, *fileInfo, bool) {
	if enum, ok := info.enums[name]; ok {
		return enum, info, true
	}
	if ref, ok := info.imports[name]; ok {
		if target := reg.byPath[ref.source]; target != nil {
			enum, owner, _, ok := resolveExportedEnum(target, reg, ref.exportName, map[string]bool{})
			if ok {
				return enum, owner, true
			}
		}
	}
	return enumInfo{}, nil, false
}

func chooseInterface(info *fileInfo, name string, pos int) (interfaceInfo, bool) {
	decls := info.interfaces[name]
	if len(decls) == 0 {
		return interfaceInfo{}, false
	}
	sort.SliceStable(decls, func(i, j int) bool { return decls[i].pos < decls[j].pos })
	if pos > 0 {
		for i := len(decls) - 1; i >= 0; i-- {
			if decls[i].pos <= pos {
				return decls[i], true
			}
		}
	}
	return decls[len(decls)-1], true
}

func chooseClass(info *fileInfo, name string, pos int) (*classInfo, bool) {
	decls := []*classInfo{}
	for _, class := range info.classes {
		if class.name == name {
			decls = append(decls, class)
		}
	}
	if len(decls) == 0 {
		return nil, false
	}
	sort.SliceStable(decls, func(i, j int) bool { return decls[i].pos < decls[j].pos })
	if pos > 0 {
		for i := len(decls) - 1; i >= 0; i-- {
			if decls[i].pos <= pos {
				return decls[i], true
			}
		}
		return nil, false
	}
	return decls[len(decls)-1], true
}

func resolveClassRefAt(info *fileInfo, reg *registry, name string, pos int) (*classInfo, *fileInfo, bool) {
	name = interfaceRefName(name)
	if class, ok := chooseClass(info, name, pos); ok {
		return class, info, true
	}
	if ref, ok := info.imports[name]; ok {
		if target := reg.byPath[ref.source]; target != nil {
			if class, ok := chooseClass(target, ref.exportName, 0); ok {
				return class, target, true
			}
		}
	}
	return nil, nil, false
}

func resolveExportedAlias(info *fileInfo, reg *registry, name string, seen map[string]bool) (aliasInfo, *fileInfo, string, bool) {
	key := info.moduleKey + "\x00" + name
	if seen[key] {
		return aliasInfo{}, nil, "", false
	}
	seen[key] = true
	if alias, ok := info.aliases[name]; ok {
		return alias, info, name, true
	}
	if ref, ok := info.reexports[name]; ok {
		if target := reg.byPath[ref.source]; target != nil {
			if alias, owner, ownerName, ok := resolveExportedAlias(target, reg, ref.exportName, seen); ok {
				return alias, owner, ownerName, true
			}
		}
	}
	for _, ref := range info.exportStar {
		if target := reg.byPath[ref.source]; target != nil {
			if alias, owner, ownerName, ok := resolveExportedAlias(target, reg, name, seen); ok {
				return alias, owner, ownerName, true
			}
		}
	}
	return aliasInfo{}, nil, "", false
}

func resolveExportedInterface(info *fileInfo, reg *registry, name string, seen map[string]bool) (string, *fileInfo, string, bool) {
	decl, owner, ownerName, ok := resolveExportedInterfaceDecl(info, reg, name, seen)
	if !ok {
		return "", nil, "", false
	}
	return interfaceFullBody(owner, reg, decl, map[string]bool{}), owner, ownerName, true
}

func moduleSpecifierForFiles(from *fileInfo, to *fileInfo) string {
	if from != nil && from.file != nil && to != nil && to.file != nil {
		return moduleSpecifier(from.file.FileName(), to.file.FileName())
	}
	if to != nil {
		return to.moduleKey
	}
	return ""
}

func resolveExportedInterfaceDecl(info *fileInfo, reg *registry, name string, seen map[string]bool) (interfaceInfo, *fileInfo, string, bool) {
	key := info.moduleKey + "\x00" + name
	if seen[key] {
		return interfaceInfo{}, nil, "", false
	}
	seen[key] = true
	if decl, ok := chooseInterface(info, name, 0); ok {
		return decl, info, name, true
	}
	if ref, ok := info.reexports[name]; ok {
		if target := reg.byPath[ref.source]; target != nil {
			if decl, owner, ownerName, ok := resolveExportedInterfaceDecl(target, reg, ref.exportName, seen); ok {
				return decl, owner, ownerName, true
			}
		}
	}
	for _, ref := range info.exportStar {
		if target := reg.byPath[ref.source]; target != nil {
			if decl, owner, ownerName, ok := resolveExportedInterfaceDecl(target, reg, name, seen); ok {
				return decl, owner, ownerName, true
			}
		}
	}
	return interfaceInfo{}, nil, "", false
}

func resolveExportedEnum(info *fileInfo, reg *registry, name string, seen map[string]bool) (enumInfo, *fileInfo, string, bool) {
	key := info.moduleKey + "\x00" + name
	if seen[key] {
		return enumInfo{}, nil, "", false
	}
	seen[key] = true
	if enum, ok := info.enums[name]; ok {
		return enum, info, name, true
	}
	if ref, ok := info.reexports[name]; ok {
		if target := reg.byPath[ref.source]; target != nil {
			if enum, owner, ownerName, ok := resolveExportedEnum(target, reg, ref.exportName, seen); ok {
				return enum, owner, ownerName, true
			}
		}
	}
	for _, ref := range info.exportStar {
		if target := reg.byPath[ref.source]; target != nil {
			if enum, owner, ownerName, ok := resolveExportedEnum(target, reg, name, seen); ok {
				return enum, owner, ownerName, true
			}
		}
	}
	return enumInfo{}, nil, "", false
}
