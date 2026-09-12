# CoCalc's static frontend assets

This package builds the browser entry points and assets with Rspack. The full
frontend source lives in `@cocalc/frontend`; Essential source lives in
`@cocalc/essential-frontend`. The hub serves the compiled static files.

## Development

Complete the repository dependency setup described in [src/README.md](../../README.md).
From `src/`, watch the workspace TypeScript projects:

```sh
pnpm tsc:watch
```

In another terminal, from `src/packages/static/`, build development assets and
then watch them:

```sh
pnpm build:dev
pnpm watch
```

`build:dev` runs `build0` first: it compiles translations and TypeScript and
copies required CSS, SVG, and HTML assets. `watch` runs Rspack in watch mode;
it does not replace the workspace TypeScript watch. The package's `tsc` script
is a one-shot compilation, not a watcher.

Start the appropriate local hub or Lite environment separately as described in
[src/README.md](../../README.md). Reload the browser after rebuilding when it
still has an older bundle. The current hub serves static assets from disk; the
old Webpack/Next.js middleware instructions do not describe this setup.

For a machine with limited memory, use the alternative watcher:

```sh
pnpm watch:low-mem
```

It polls the packages tree and runs a one-shot workspace TypeScript build
before each Rspack build. Neither compiler stays resident between builds. If
TypeScript fails, it does not produce a fresh Rspack bundle. This mode trades
rebuild latency for lower steady-state memory use; measure your own workload.

## Production and bundle analysis

From this package:

```sh
pnpm build
pnpm analyze
```

`build` runs `build0`, then `production-build.py`, which invokes Rspack and
creates the versioned app HTML file. `analyze` writes the production treemap to
`dist-prod-measure/bundle-report.html` and accompanying `stats.json`.

For development bundle analysis, use `pnpm analyze:dev` and inspect
`dist-measure/bundle-report.html`. The historical `webpack-measure` and
`webpack-measure-prod` names remain aliases for these Rspack analysis scripts.
Use the current `build` and `watch` commands rather than the legacy
`webpack-prod` script.

Bundle graph checks are available through `pnpm check-bundle-guards`; the
Essential-specific check is `pnpm check-ultralite-budgets`. These build and
inspect assets. They do not validate a live site's behavior or measured user
latency.

## Essential browser integration tests

With the local hub running and a designated development project, run:

```sh
pnpm essential:test:e2e
```

This is a live integration test: it creates a hidden notebook fixture, obtains
authenticated browser state, and executes through Chromium and a real project
kernel. It retains a Playwright trace and diagnostics on failure. Check the
selected environment first; `COCALC_ESSENTIAL_E2E_BASE_URL` and
`COCALC_ESSENTIAL_E2E_PROJECT_ID` override the discovered targets.

## Changes in other packages

Workspace imports often read compiled `dist` output. Rebuild a changed package
or keep the workspace TypeScript watch running before expecting its changes in
the browser. For example, run `pnpm build` in `src/packages/util/` after editing
that package.
