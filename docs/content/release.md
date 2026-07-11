# Release Checklist

This page captures the package-level checks that should pass before publishing or handing off a release candidate.

## Package Manager

Use Yarn Berry through Corepack.

```bash
corepack yarn --version
corepack yarn install --immutable
```

The repository uses Yarn 4 and `nodeLinker: node-modules`.

## Build

```bash
corepack yarn build
```

The build performs a clean TypeScript compile, builds the DevConsole assets, and makes compiled CLI files executable.

For local iteration:

```bash
corepack yarn build:dirty
```

## Tests

```bash
corepack yarn test
corepack yarn test-app
```

`test` builds the package and runs compiled `node:test` specs. `test-app` builds and runs the integration-style sample app under `test-app/`.

Database tests require local database services according to the testing config. See [Testing](./testing.md).

## Docs

```bash
corepack yarn docs:build
```

The generated VitePress output is written to `docs/.vitepress/dist/` and should not be committed as source.

## OpenAPI

For apps that generate clients from the schema, regenerate OpenAPI from the compiled app.

```bash
corepack yarn tsf-dev openapi:generate
```

This builds the app and invokes the package `main` with the built-in `openapi:generate` app command.

The runtime can also serve `/openapi.json` and `/openapi.yaml` when `ENABLE_OPENAPI_ROUTE=true`.

## Package Contents

The package publishes:

- `dist/src/`
- `dist/devconsole/`
- `docs/content/`
- `docs/.vitepress/config.mts`
- `docs/openapi.md`
- `resources/`
- `template-app/`
- `types.d.ts`
- `package.json`

The supported import paths are the root export and the `/otel` OpenTelemetry bootstrap export. Although `package.json` is included in the tarball, it is not exposed through the package `exports` map. See [Public API](./public-api.md).

## Local Pack Inspection

Use a dry run to inspect the tarball list.

```bash
npm pack --dry-run
```

Confirm generated build outputs are present and local-only artifacts such as `docs/.vitepress/dist/` are absent unless intentionally published.

## Versioning Notes

CI derives release versions from the commit timestamp in UTC using `YY.MDD.HHmm`-style calendar versioning (for example, `26.711.1430` for July 11, 2026 at 14:30 UTC). Non-`main` builds append `-canary.<short-sha>`. Consumers that require reproducible behavior should pin an exact version rather than assuming semantic-version compatibility between calendar releases.

Treat these as breaking changes:

- removing or renaming a root export
- changing package export paths
- changing HTTP parameter resolution semantics
- changing database migration output for existing annotations
- changing OpenAPI operation IDs or schema shapes
- changing CLI command names or required flags

Update docs in the same change as API behavior changes.
