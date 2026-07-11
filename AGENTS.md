# Repository Guidelines

## Project Structure & Module Organization

Source code lives in `src/`, organized by feature area: `http/`, `database/`, `reflection/`, `type-compiler/`, `services/`, `srpc/`, `telemetry/`, and shared helpers under `helpers/`. Tests live in `tests/` as `*.spec.ts`; the small integration app is in `test-app/`. Documentation is in `docs/content/`, generated/static resources are in `resources/`, and the DevConsole frontend is under `devconsole/`.

## Build, Test, and Development Commands

- `yarn build`: clean build, compile TypeScript with `ttsc`, copy/build the type compiler, build DevConsole, and mark CLI outputs executable.
- `yarn build:dirty`: rebuild without deleting `dist/`; useful during compiler/debug loops.
- `yarn test`: full build, then run Node's test runner against `dist/tests/**/*.spec.js`.
- `yarn test:dirty`: dirty build plus full test run.
- `yarn test:type-compiler-go`: run the Go type-compiler tests.
- `yarn docs:dev`: start the VitePress docs server.
- `yarn format`: run `oxfmt` and `oxlint src --fix`.

## Coding Style & Naming Conventions

Use TypeScript with 4-space indentation, single quotes, and semicolons, matching existing files. Prefer root package exports from `src/index.ts`; public subpaths should remain limited and intentional. Keep domain modules cohesive and avoid hardcoding application model names, consumer package paths, or workspace-specific assumptions in shared compiler/runtime code.

## Testing Guidelines

Tests use Node's built-in test runner and `node:assert`. Add tests beside existing coverage in `tests/` using the `*.spec.ts` pattern. For type compiler changes, include focused coverage in `tests/reflection-*.spec.ts`, `tests/openapi.spec.ts`, or `src/type-compiler/go/plugin_test.go` as appropriate. Build before running generated JS tests.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `upload guards`, `fixes`, or `typia part 2`. Keep commits focused and describe the behavior change. PRs should include a concise summary, relevant issue/context links, test results, and OpenAPI/schema impact when reflection, validation, HTTP, or database metadata changes.

## Architecture Notes

Reflection policy is documented in `docs/content/type-reflection-architecture.md`. Validation and OpenAPI should read the same reflected metadata; database extraction is the main storage-specific consumer.
