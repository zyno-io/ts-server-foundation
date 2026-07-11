# Documentation Site Development

This package uses VitePress for the documentation site.

## Layout

```text
docs/
├── .vitepress/
│   └── config.mts
├── content/
│   ├── index.md
│   ├── getting-started.md
│   ├── public/
│   │   └── images/
│   └── ...
└── scripts/
```

VitePress is configured with `srcDir: 'content'`, so editable pages live in `docs/content/`. Static files live in `docs/content/public/`.

## Commands

Run commands from the repository root:

```bash
corepack yarn install
corepack yarn docs:dev
corepack yarn docs:build
corepack yarn docs:preview
```

`docs:dev` starts the VitePress dev server. Because the site has `base: '/ts-server-foundation/'`, the local site is served under that base path.

`docs:build` writes generated output to `docs/.vitepress/dist/`. That directory is ignored and should not be edited by hand.

## Adding Pages

1. Create or edit Markdown files in `docs/content/`.
2. Add new pages to `docs/.vitepress/config.mts` so they appear in the sidebar.
3. Run `corepack yarn docs:build` before publishing docs changes.

## Images

Place images in `docs/content/public/images/` and reference them from Markdown with `/images/...`:

```md
![Alt text](/images/example.png)
```

## Deployment

GitHub Pages deployment is defined in `.github/workflows/deploy-docs.yml`. A push to `main` that changes docs, the workflow, or the root dependency metadata installs the immutable Yarn dependencies, runs `yarn docs:build`, uploads `docs/.vitepress/dist/`, and deploys it through the `github-pages` environment.

The workflow can also be started manually from the GitHub Actions tab. The repository's Pages source must remain set to **GitHub Actions**. The published site is <https://zyno-io.github.io/ts-server-foundation/>.

## Notes

Prefer examples that compile against `@zyno-io/ts-server-foundation`. Document reflected type metadata where it affects user-facing behavior, and otherwise keep pages focused on the TSF APIs that applications import.
