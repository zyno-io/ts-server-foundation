module tsf-type-replacement-plugin

go 1.26

require (
	// ttsc replaces this placeholder with the installed npm package's Go sources
	// while building source plugins. The nested Go module has no semver tags.
	github.com/samchon/ttsc/packages/ttsc v0.0.0
	github.com/samchon/typia/packages/typia/native v0.0.0-20260709031533-27f105ae8e56
)
