# CoCalc Plus

CoCalc Plus is the productized wrapper around the lightweight core shipped in `@cocalc/lite`. It exists so we can ship a branded, single-machine experience without duplicating the underlying hub/server/database logic.

## Role

- Builds directly on the Lite core for a single-user CoCalc experience.
- Adds only product-level defaults (branding, configuration presets, packaging), not new logic.
- Serves as the public entry point for the “CoCalcPlus” SKU while keeping shared code in [../lite](../lite/README.md).

## Change Discipline

- Keep implementation in Lite. If a feature is useful beyond Plus, add it to Lite rather than here.
- Plus should remain declarative: configuration, presets, and packaging only; no podman/btrfs/ssh plumbing.
- Avoid introducing new dependencies unless they belong in Lite. Treat Plus as a thin layer to keep the dependency graph clean.
- When Lite gains new capabilities, Prefer re-exporting or configuring them here instead of re-implementing.

## Getting Started

- Build with `pnpm --filter @cocalc/plus build`.
- At runtime this package re-uses Lite’s entry points; product-specific CLI and packaging live here.

## Base URL / Proxy Behavior

`cocalc-plus` now follows a code-server style model for URL prefixing:

- The app does **not** require compile-time `BASE_PATH` configuration.
- It works when a reverse proxy strips a fixed prefix and forwards to the Plus server.
- Redirects from non-SPA routes preserve the current prefix (using relative redirects), so deep links under a proxy continue to work.

Examples:

- Direct access: `http://localhost:30002`
- Behind strip-prefix proxy: external `https://example.com/tools/cocalc/...` forwarded to `http://127.0.0.1:30002/...`

Notes:

- This behavior is for Lite/Plus static app routing and project routes.
- `/port/...` style proxying remains a separate mechanism (primarily used for JupyterLab-style apps), and is not the target model for Plus base-URL behavior.

## Packaging & Distribution

- **Bundle**: `pnpm --filter @cocalc/plus build:bundle` (uses ncc to bundle `bin/start.js` and copies static assets).
- **Tarball**: `pnpm --filter @cocalc/plus build:tarball` (creates `packages/plus/build/bundle.tar.xz`).
- **SEA binary**: `pnpm --filter @cocalc/plus sea` (produces compressed SEA artifact under `packages/plus/build/sea`).
- **Electron**: `pnpm --filter @cocalc/plus app-electron` for desktop runs; adjust signing/notarization via `sea/Makefile` on macOS.

Packaging artifacts are intended for redistribution; keep core runtime changes in Lite so Plus remains a thin product wrapper. The CLI `cocalc-plus` delegates to `@cocalc/lite/bin/start` (no extra build required), and Electron uses `electron.js` as the main entry.
