# TS Server Foundation

TypeScript server foundation with dependency injection, reflected HTTP routing and validation, OpenAPI generation, database helpers, workers, SRPC, telemetry, and development tooling.

TS Server Foundation is built and maintained primarily for Zyno Consulting's own production systems. We publish it openly in the hope that it is useful to others, while its roadmap and maintenance priorities remain guided by the needs of those systems rather than a promise of general-purpose framework support.

## Quick Start

```bash
npx @zyno-io/ts-server-foundation create-app @myorg/my-api
cd my-api
corepack yarn install
corepack yarn dev
```

The generated app uses the metadata compiler and starts its compiled package entrypoint with the explicit `server:start` command.

## Documentation

- [Documentation site](https://zyno-io.github.io/ts-server-foundation/)
- [Feature overview](./docs/content/overview.md)
- [Getting started](./docs/content/getting-started.md)
- [Complete documentation index](./docs/content/README.md)

Repository development commands and contribution conventions are documented in [CONTRIBUTING](./docs/content/CONTRIBUTING.md).

## Acknowledgements

TS Server Foundation owes a great deal to the open-source projects that made its architecture possible. [Deepkit](https://github.com/marcj/deepkit) inspired many of the design ideas behind its runtime type reflection, dependency injection, and metadata-driven server APIs. We are especially grateful to Deepkit's maintainer, [Marc J. Schmidt](https://github.com/marcj), for showing how powerful a cohesive, type-aware TypeScript framework can be.

[Typia](https://typia.io/) and [ttsc](https://github.com/samchon/ttsc) provided the essential compiler groundwork for bringing those ideas to TypeScript 7. TSF builds on their type-analysis and transform infrastructure to generate the runtime metadata at the heart of the framework. Our sincere thanks to Jeongho Nam and every contributor to these projects for making that work available to the TypeScript community.
