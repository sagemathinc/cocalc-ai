# Build and run CoCalc from source

Run the commands below from this `src/` directory. The top-level
[repository README](../README.md) explains the product and package layout.
For local site configuration and troubleshooting, use the
[development helpers guide](scripts/dev/README.md).

## Prerequisites

- Node.js must satisfy `engines.node` in [package.json](package.json), currently
  `>=22.15.0`. The main build/test workflow uses Node.js 24. The checked-in
  `.nvmrc` still names the older Hydrogen release, so do not rely on that alias
  to select a compatible version.
- The main build/test workflow pins pnpm 11.5.2. Check the current
  [workflow](../.github/workflows/make-and-test.yml) when reproducing CI.
- The Python API package requires Python 3.10 or newer and uses `uv` and `make`.
  Its [Makefile](python/cocalc-api/Makefile) installs `uv` if absent, synchronizes
  Python dependencies, installs the package, and builds its API documentation.
- Project-host runtime development requires the Linux services and storage
  prerequisites of the selected host deployment. A local Plus frontend workflow
  does not exercise those host operations.

Check the tools in the shell where you will build:

```sh
node --version
pnpm --version
python3 --version
make --version
```

## Build

```sh
pnpm build
```

This installs workspace dependencies, builds package outputs, and builds the
Python API package and its documentation. For development frontend bundles:

```sh
pnpm build:dev
```

These commands install dependencies and can use substantial disk space and
memory. The package builds are coordinated by [workspaces.py](workspaces.py).
Its successful-build marker is `.successful-build` in each package. A cached
build is not a substitute for running the checks affected by a source change.

## Start a local development site

For Lite/Plus development:

```sh
pnpm dev:lite:init
pnpm dev:lite:start
pnpm dev:lite:status
```

For a managed Hub/Launchpad development site:

```sh
pnpm dev:hub:init
pnpm dev:hub:start
pnpm dev:hub:status
```

Use the [development helpers guide](scripts/dev/README.md) for each mode's
configuration, database, authentication, logs, and browser URL. Load the matching
CLI/browser environment only for the site you intend to use:

```sh
eval "$(pnpm -s dev:lite:env)"
# Or, for the Hub development site:
eval "$(pnpm -s dev:hub:env)"
```

The Lite environment helper includes `--start`; the Hub helper includes
`--no-start`. Treat the former as a command that may start local services, not
just a display of configuration. Keep printed authentication values private.

Stop the corresponding development site with `pnpm dev:lite:stop` or
`pnpm dev:hub:stop`.

### Foreground Hub entry points

For the package-level foreground launcher, `pnpm hub` currently selects PGlite.
`pnpm hub:postgres` selects the local PostgreSQL launcher. Their separate data
directories and environment setup are defined in
[packages/hub/bin/start.sh](packages/hub/bin/start.sh). The old instructions to
run `pnpm database` in a second terminal do not describe these entry points.

## Rebuild and validate changes

From `src/`:

```sh
pnpm tsc
pnpm lint
pnpm version-check
pnpm test
```

`pnpm test` includes repository checks, dependency checks, and package tests.
For a smaller change, inspect the affected package's scripts and run its focused
checks. For example:

```sh
pnpm -C packages/docs test
pnpm -C packages/docs verify
pnpm -C packages/docs gaps
```

To watch TypeScript project references, use `pnpm tsc:watch`. The public frontend
uses Rspack; `pnpm static:watch` watches its development bundles, while
`pnpm static:watch:low-mem` selects the repository's lower-memory watch helper.
Rebuild and refresh the relevant browser page when changing frontend code.

`pnpm clean` removes generated dependency/build state according to the current
workspace scripts. It is not the routine first step for every change, and the
next build may need to reinstall dependencies.

## Validation boundary

This reference was checked against the package scripts, build helper, and CI
configuration on 2026-09-11. A fresh dependency installation and local-site
startup were not executed as part of this documentation correction. Consult the
recorded CI and the relevant runtime tests before treating a particular machine
or deployment as validated.
