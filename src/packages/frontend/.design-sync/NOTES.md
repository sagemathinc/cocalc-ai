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

## Preview authoring (wave 1)

- **Convention:** each `.design-sync/previews/<Name>.tsx` imports the component +
  `DSProvider` (+ sibling components) from `"@cocalc/frontend"` ONLY — the converter
  aliases that to `window.CoCalcPublic`. NO `antd`/`react`/`@ant-design/icons` imports
  (they don't resolve / double-bundle). For text use plain `<p>/<span>/<div>`; for
  buttons use `LinkButton`; for icons pass `IconName` strings. Each named export = one
  story cell wrapped in `<DSProvider>`. Real page copy, no foo/bar.
- **App-served image assets 404 in standalone previews.** `<img src="/public/...">`
  (e.g. team headshots) renders broken — there's no app server. Drop the image or use
  an inline/remote URL. (Hit on `PublicCard` TeamMemberCard.)
- **`cfg.overrides.<Name>.cardMode = "column"`** (full-width, one cell per row) is set
  for `CodeBlock` + `PublicGrid` (wide content). NOTE: `cardMode` arranges story CELLS,
  it does NOT widen a single component or wrap a long line — `CodeBlock` long single-line
  commands still overflow the card (no-wrap is the real behavior; we dropped the long
  install cell rather than fight it). `PublicGrid` 3/4-column variants wrap in the narrow
  review viewport — responsive behavior, not a defect.
- Render check needs playwright + a browser: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i
  playwright` in `.ds-sync/`, then run capture/validate with
  `DS_CHROMIUM_PATH=/usr/bin/google-chrome` (no 200MB chromium download).

## Slim for upload (minify + dead-stub) — 10.9MB → 4.14MB

- `.design-sync/overrides/bundle.mjs` forks `lib/bundle.mjs` (declared in `cfg.libOverrides`):
  (1) **`minify: true`** — the converter hardcodes `minify:false`; that alone is the
  10.9→5.2MB halving. The `@ds-bundle` header is prepended POST-esbuild by `stampHeader`,
  so minify can't strip it (contract-safe). (2) An `onLoad` stub for
  `/dist/(markdown/|misc/math-to-html.js)` → empty Proxy, dropping **katex (271KB) +
  markdown-it (185KB)** that `PublicPage`/`MarkdownSection` pull in but the wave-1 barrel
  never exports. Result: **4.14MB**, under the 5MB limit.
- Re-sync: re-copy the staged scripts, RE-DIFF `.design-sync/overrides/bundle.mjs` against
  upstream `lib/bundle.mjs` and merge upstream changes (the fork only adds minify + the stub
  plugin). On a fresh clone recreate the symlink: `ln -sfn ../.ds-sync/node_modules .design-sync/node_modules`.
- **KNOWN validate false-positive: CodeBlock `[RENDER] rootEmpty`.** Under minify the antd
  App-context re-render (CodeCopyButton's `App.useApp()`) lands just past the validate
  text/height measurement window → `texts:['','','']` while the SAME run's screenshot has
  content (~31KB PNG). CodeBlock renders correctly — confirmed by the per-cell capture
  (grades good) AND the whole-card screenshot. Not a real failure. Do NOT "fix" by dropping
  cells or `skip` (which would remove its previews). Bundle anchor/build are otherwise clean.
