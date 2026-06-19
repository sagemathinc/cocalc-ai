# design-sync NOTES — @cocalc/frontend public-site design system

Repo-specific gotchas for `/design-sync` (package shape, synced wave-by-wave).

## Build / converter gotchas

- **`dist/package.json` MUST be removed during the converter run.** It's a
  gitignored build artifact whose presence makes the converter treat `dist/` as
  the package root → `publishConfig.types: "dist/public/index.d.ts"` resolves to
  the non-existent `dist/dist/public` and discovery falls back to `dist/lib`
  (`[ZERO_MATCH]`). Removing it lets the converter walk up to the real source
  package (correct `publishConfig.types` → `dist/public`, 76 `.d.ts`) AND makes
  `@cocalc/*` self-imports in `dist/` resolve via the source `exports` map (no
  `dist/dist/...` errors). Recipe:
  `mv dist/package.json /tmp/bak && node .ds-sync/package-build.mjs … && mv /tmp/bak dist/package.json`.
- **Build command:** `pnpm exec tsc --build` (incremental) recompiles the barrel +
  changed sources into `dist/public/`. The full `pnpm build` (`rm -rf dist`) is
  not needed unless dist is wiped.
- **`--node-modules`** = `node_modules` (react resolves in `packages/frontend/node_modules`).
- **`--entry`** = `./dist/public/index.js` (the compiled barrel).

## Known issues to resolve before UPLOAD

- **`[FILE_OVER_5MB]`: `_ds_bundle.js` is ~10.9 MB > the 5 MB upload limit.** Bulk
  is the `@cocalc/frontend/components/icon` registry (pulls the whole
  `@ant-design/icons`) + antd. Must slim before upload (externalize / lazy-load
  icons, or trim the registry to used glyphs). Local `.review.html` renders fine
  regardless — the limit only blocks the claude.ai/design upload.
- Previews are floor cards until authored (`.design-sync/previews/<Name>.tsx`).

## Provider

- `cfg.provider.component = "DSProvider"` — `public/_ds-provider.tsx`: replicates
  `PublicPage`'s antd `ConfigProvider`(PUBLIC_COLORS theme) + `App` + injected
  `PUBLIC_PAGE_CSS`, WITHOUT nav/footer. In the bundle; excluded from the card
  list via `cfg.componentSrcMap: {DSProvider: null}`.

## Re-sync risks

- The `dist/package.json` removal is manual — fold it into the re-sync recipe.
- Wave 1 = redux-free, config-free, appBasePath-free primitives. Wave 2 (shell/
  nav/footer) needs a stub `PublicConfig` + `appBasePath="/"` and will re-confront
  the dist self-import resolution — switch the converter's esbuild to
  source-aliasing (`@cocalc/frontend` → `packages/frontend` source) when adding shell.
- `publishConfig.types` was added to `packages/frontend/package.json` for this —
  it scopes converter discovery to `dist/public` and does not affect dev type
  resolution.
