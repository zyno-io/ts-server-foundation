package main

import "testing"

func TestUploadAliasesWithTupleOptionsKeepInternalMetadata(t *testing.T) {
	info, reg := testTypeInfo()
	info.aliases["ImageUpload"] = aliasInfo{body: "FileUpload<{ maxSize: '128B'; allowedTypes: ['image/png'] }>"}
	info.aliases["ChainedUpload"] = aliasInfo{body: "ImageUpload"}
	for _, raw := range []string{
		"FileUpload<{ allowedTypes: ['image/png'] }>",
		"ImageUpload", "ChainedUpload", "ImageUpload[]",
		"{ attachments?: ImageUpload[] }",
		"HttpBody<{ attachments?: ImageUpload[] }>",
	} {
		if canPreferTypiaTypeOnPreferredSurface(info, reg, raw) {
			t.Errorf("upload constructor/options must not be erased on preferred surface: %s", raw)
		}
	}
	if !canPreferTypiaTypeOnPreferredSurface(info, reg, "Source['items'][number]") {
		t.Fatal("indexed access must remain checker-resolved")
	}
}
func TestGenericUploadAliasKeepsInstantiatedPolicy(t *testing.T) {
	info, reg := testTypeInfo()
	info.aliases["GenericUpload"] = aliasInfo{
		params: []string{"Types"},
		body:   "FileUpload<{ maxSize: '128B'; allowedTypes: Types }>",
	}
	expr := typeExpr(info, reg, "GenericUpload<['image/png']>")
	assertContainsAll(t, expr, "kind: 16", "classType:", "FileUpload", "typeArguments:", "name: \"allowedTypes\"", "literal: \"image/png\"")
	if canPreferTypiaTypeOnPreferredSurface(info, reg, "GenericUpload<['image/png']>") {
		t.Fatal("generic upload aliases must retain runtime metadata")
	}
}
