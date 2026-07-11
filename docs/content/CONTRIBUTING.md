# Contributing To Documentation

## Quick Start

```bash
corepack yarn install
corepack yarn docs:dev
```

Edit Markdown files under `docs/content/`. The dev server reloads as files change.

Before handing off docs changes, run:

```bash
corepack yarn docs:build
```

## Adding A New Page

1. Create a Markdown file in `docs/content/`.
2. Add frontmatter only when the page needs custom title/description metadata.
3. Add the page to `docs/.vitepress/config.mts`.
4. Link related pages together with relative Markdown links, for example `[HTTP](./http.md)`.

## Markdown

Use fenced code blocks with language names:

```ts
const app = createApp({
    config: AppConfig
});
```

VitePress custom containers are available when they add real signal:

```md
::: warning
This API is not available in production mode.
:::
```

## Style

- Prefer current `@zyno-io/ts-server-foundation` examples.
- Use `tsf` command names.
- Keep HTTP parameter examples explicit: `HttpBody`, `HttpQueries`, `HttpQuery`, `HttpPath`, `HttpHeader`, `FileUpload`, and `HttpRequest`.
- Keep database docs focused on `BaseDatabase`, sessions, active-record helpers, migrations, and SQL fragments.
- Run `corepack yarn docs:build` after sidebar or link changes.

## Deployment

Documentation merged to `main` is built and deployed to GitHub Pages by `.github/workflows/deploy-docs.yml`. Changes mirrored from GitLab to GitHub trigger the same push workflow. Use `workflow_dispatch` in GitHub Actions when a deployment must be retried without another content change.
