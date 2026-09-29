# TypeScript 7 Migration Plan

## Status

Investigation completed and migration deferred on 2026-07-15.

Re-probed and migration started on 2026-09-29 on branch `build/typescript-7`
(tracking issue #195). The "Revision 2026-09-29" section below supersedes the
open questions in Phases 2 and 3 and reorders the work. Progress is recorded in
the "Progress Log" at the end of this document.

## Revision 2026-09-29

### What Changed Since The Original Probe

- `typescript@latest` is still 7.0.2 and `@typescript/typescript6` is still
  6.0.2. TS7.1 exists only as nightlies (`7.1.0-dev.*`). The nightlies ship a
  new `typescript/unstable/*` API, which is not the TS6 compiler API used by
  `ts-jest`, `ts-node`, or our AST lint script. TS6 remains required for those.
- About 4,970 commits landed after the original plan. The self-import surface
  grew (files importing their own package: frontend 1,688 -> 2,252, server
  481 -> 849, conat 101 -> 140), and new packages (`ai`, `essential-frontend`,
  `static`) were added with `moduleResolution: "node"`. Waiting makes the
  migration larger.
- TS6 memory pressure grew: the static build and control-plane bundle builds
  had to raise Node heap limits again (6 GB and 8 GB).
- All supported runtimes are Node >= 22.15 (development uses Node 26), where
  `require()` of synchronous ESM works without flags. This reduces the risk of
  the CommonJS/ESM boundary diagnostics that motivated caution about `node16`.

### Re-Probe Results (TS 7.0.2 On A Throwaway Copy Of `main`)

| Configuration                                                    | Errors |
| ---------------------------------------------------------------- | -----: |
| unchanged configs                                                |    121 |
| `bundler` resolver, removed `baseUrl`/`downlevelIteration`/etc.  |    214 |
| plus frontend self `paths` and a `types` export for util message |     44 |
| same, clean tree (no `dist`)                                     |     99 |
| same, incremental rebuild of the clean tree                      |     45 |

Observations:

- `module: "commonjs"` with `moduleResolution: "bundler"` is accepted by TS7.
  This keeps CommonJS emit (no runtime module-format change) while replacing
  the removed `node10` resolver.
- 154 of the 214 errors were frontend directory-index self-imports such as
  `@cocalc/frontend/lite`, which the `./*` -> `./dist/*.js` export cannot
  express. A package-local `paths` self-mapping fixes all of them.
- `@cocalc/util/message` is a hand-written `message.d.ts` beside JS source.
  Resolution through exports found the weaker emitted `dist/message.d.ts`,
  which caused every "missing member" diagnostic in backend, server, and
  project.
- TS5055 declaration collisions disappear on a clean tree; they come from
  stale `dist` being resolved as input.
- Clean-tree failures are dominated (about 63 of 73 unresolved imports) by
  `@cocalc/conat` imports from `sync`. `conat` references `sync`, while `sync`
  imports `conat` without a project reference (it cannot add one without a
  cycle). TS6 hides this because `node10` resolution reaches conat source
  through `node_modules` as an external library file; modern resolution goes
  through exports to `dist`, which does not exist yet on a clean tree.
- The same cycle already breaks **TS6** clean builds on `main`: in a fresh
  worktree, `sync` is built before `apps/document-build`, pulls conat source
  in as an external file, and fails on conat's import of
  `@cocalc/app-document-build`. Current builds succeed only because `dist`
  output from earlier builds exists. Fixing the cycle is therefore valuable
  independent of TS7.
- A clean TS7 solution build took about 17 s wall and 5.7 GB peak RSS; an
  incremental build 7 s and 3.3 GB. TS6 numbers are in the Progress Log.

### Decisions

1. **Resolver strategy (closes Phase 2).** Use `moduleResolution: "bundler"`
   with the existing `module: "commonjs"` for every package. Emit stays
   CommonJS; no package changes `type`, extensions, or startup commands. Do not
   adopt `node16`/`nodenext` as part of this migration.
2. **Self-resolution (Phase 3).** Resolve every `@cocalc/*` import to source
   through one shared `paths` entry in `packages/tsconfig.json`:
   `"@cocalc/*": ["./node_modules/@cocalc/*"]`, where the workspace root
   declares every `@cocalc` package as a `workspace:*` dev dependency so
   `packages/node_modules/@cocalc/*` links them all. Because the mapped paths
   go through `node_modules`, TypeScript keeps treating files of
   non-referenced packages as external package files, exactly as the `node10`
   resolver did; files of referenced projects are still replaced by their
   declarations. The `@cocalc/app-*` packages, whose source lives under
   `src/`, get explicit entries. Packages that define their own `paths` add the
   same entry (relative to themselves), since `paths` does not merge. This
   replaced the originally proposed per-package self mappings and `types`
   export fixes, which were no longer needed.
3. **Cycle first.** Resolve the `sync`/`conat` build-order dependence before
   other Phase 3 work, in a TS6-compatible way.
4. **Guard.** `pnpm check-tsconfig` (part of `test:checks`) fails on new uses
   of TypeScript 7-removed options (`moduleResolution: "node"`/`node10`/
   `classic`, `baseUrl`, `downlevelIteration`) and on `@cocalc` packages the
   workspace root does not link.
5. **Compiler API.** Keep TS6 as the `typescript` package for tooling. Revisit
   when TS7.1 is released; that is not a prerequisite for using TS7 as the
   build compiler.

### Revised Order Of Work

1. Plan update and draft PR (this revision).
2. Phase 0 baseline numbers for TS6 (clean, incremental, no-op).
3. Phase 1 side-by-side toolchain with explicit `tsc:6`/`tsc:7` scripts.
4. `sync`/`conat` clean-build fix.
5. Config modernization (Phases 2-4 combined, since the strategy is decided):
   `bundler` resolver, drop removed options, self `paths`, export fixes.
6. Remaining source diagnostics (Phase 6), the removed-options guard, and a
   non-blocking TS7 CI job.
7. Qualification (Phases 7-8) and the default switch (Phase 9) only after TS7
   passes clean, incremental, and runtime checks.

This document records the results of a TypeScript 7.0.2 compatibility probe and
proposes a staged migration. The migration is substantially larger than a
dependency update because TypeScript 7 removes the legacy module resolver used
throughout this monorepo and does not yet provide the TypeScript compiler API.

The current production build remains on TypeScript 6.0.3. Its solution build is
run with a 6144 MB V8 heap, which fixes the immediate out-of-memory failure on a
16 GB container:

```text
node --max-old-space-size=6144 node_modules/typescript/bin/tsc \
  --build tsconfig.solution.json
```

That workaround is already committed separately and lets `pnpm static` finish.
There is no operational need to rush the TS7 migration merely to solve the
memory issue.

## Executive Summary

TypeScript 7 is a native Go implementation and is an attractive eventual
compiler for CoCalc. Microsoft reports major reductions in build time and
memory use, and TS7 supports project references, incremental builds, and build
mode. However, our direct probe found four migration boundaries:

1. TS7 removes `moduleResolution: "node"`/`node10`, `baseUrl`, and
   `downlevelIteration`, all of which are used by the current config graph.
2. Modern module resolution follows package `exports`. Many CoCalc packages
   import themselves through `@cocalc/<package>/*`, whose exports point to
   `dist`. During a source build this can consume stale declaration output,
   cause declaration input/output collisions, or fail on a clean checkout.
3. CoCalc still has real CommonJS/ESM boundaries. Switching to `node16` exposed
   hundreds of extension and module-format diagnostics; switching to a bundler
   resolver reduced those diagnostics but did not make Node runtime boundaries
   disappear.
4. TS7.0 does not expose the TypeScript compiler API. CoCalc tooling including
   `ts-jest`, `ts-node`, and the frontend AST lint script still needs TS6 until
   TS7.1 or later provides a compatible API.

The recommended approach is therefore:

- install TS7 and TS6 side by side
- make TS7 an opt-in CI check before changing the default compiler
- modernize config and package resolution without changing runtime module
  format accidentally
- repair declaration builds and ESM dependency boundaries package by package
- switch the default only after clean, incremental, static, test, and runtime
  validation all pass
- retain a one-command TS6 rollback until TS7 has been used in production

This should be treated as a multi-commit migration project, not a single pull
request.

## Official Toolchain Model

The TypeScript 7 announcement recommends a side-by-side setup while TS7 lacks
the compiler API:

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@^7.0.2",
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  }
}
```

See:

- <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>

This layout was tested in the CoCalc workspace and worked mechanically:

- `tsc` invoked the native 7.0.2 compiler
- `tsc6` invoked the compatibility compiler
- `require("typescript")` continued to expose the TS6 compiler API

There is a small version-alignment issue to resolve when migration starts. The
repository currently uses TS6.0.3, while the tested `@typescript/typescript6`
compatibility package was 6.0.2. Recheck available versions rather than
silently downgrading the existing compiler baseline.

TS7 dependencies must be aligned in every workspace package that currently
owns or invokes a compiler binary, especially:

- `src/packages/package.json`
- `src/packages/frontend/package.json`
- `src/packages/util/package.json`

Workspace installs and lockfile updates must be run from `src/packages`; an
install from `src` does not update this pnpm workspace.

## Current Repository Shape

The solution build is rooted at:

```text
src/packages/tsconfig.solution.json
```

It references roughly 32 package projects. Shared compiler defaults are in:

```text
src/packages/tsconfig.json
```

Important current defaults include:

```json
{
  "composite": true,
  "declaration": true,
  "downlevelIteration": true,
  "module": "commonjs",
  "moduleResolution": "node",
  "ignoreDeprecations": "6.0"
}
```

Many package configs also use `baseUrl`. Output directories and
`tsconfig.tsbuildinfo` are gitignored, so both clean-checkout and dirty-tree
builds must be tested explicitly.

The workspace also reports a dependency cycle involving `comm`, `sync`, and
`conat`. The TS7 migration must not worsen that cycle or rely on a particular
stale build order to make it compile.

### Package Self-Imports

A source scan found substantial use of package self-imports. Approximate
`@cocalc/<same-package>/*` counts from the investigation were:

| Package     | Approximate self-imports |
| ----------- | -----------------------: |
| frontend    |                     1495 |
| server      |                      338 |
| http-api    |                      164 |
| database    |                      116 |
| backend     |                       95 |
| conat       |                       93 |
| util        |                       52 |
| project     |                       39 |
| jupyter     |                       17 |
| hub         |                       14 |
| sync        |                        7 |
| comm        |                        1 |
| file-server |                        1 |

Most package manifests export subpaths from `dist`. Legacy resolution often
found source through filesystem behavior that modern resolution intentionally
does not reproduce. This is the largest structural part of the migration.

## Probe Results

The initial native compiler probe was run without adopting TS7 in the lockfile:

```bash
cd src
pnpm dlx typescript@7.0.2 \
  --build packages/tsconfig.solution.json \
  --pretty false
```

All experimental config and package changes were reverted after the probe.
TypeScript 6.0.3 then passed the full solution typecheck again.

### Removed Compiler Options

The first TS7 run reported:

- `downlevelIteration` is removed
- `moduleResolution: "node"`/`node10` is removed
- `baseUrl` is removed
- the current deprecation suppression is no longer useful (corrected
  2026-09-29: TS7 accepts `ignoreDeprecations: "6.0"`, and it is still needed
  because ts-jest forces `node10` when type-checking CommonJS tests under TS6)

`moduleResolution: "classic"` is also removed and is not an escape hatch.

TS7 suggests replacing `baseUrl` semantics with explicit `paths` entries where
they are actually needed. Those replacements must be package-specific because
`paths` entries do not merge through `extends`.

### Declaration Input/Output Collisions

TS7 reported TS5055 collisions where declarations under `dist` were both build
inputs and build outputs. Examples included:

- `sync/dist/editor/.../*.d.ts`
- `conat/dist/core/*.d.ts`
- `conat/dist/files/*.d.ts`
- `conat/dist/service/*.d.ts`

Deleting `dist` is useful as a diagnostic but is not a fix. A successful
migration must work both when output is absent and when an incremental build
already exists.

### Non-Portable Inferred Export Types

TS7 reported TS2883 for exported inferred types that depend on package-private
or non-portable names. Known examples are:

- `frontend/frame-editors/generic/search/use-search-index.ts`
  - `Results`, inferred from Orama
- `server/purchases/stripe-usage-based-subscription.ts`
  - `getUsageSubscription`
- `server/purchases/stripe/get-payment-methods.ts`
  - `getPaymentMethod`
- `server/purchases/stripe/invoices.ts`
  - `getInvoice`

These should receive explicit public return types. The full list must be
regenerated after resolver errors no longer hide downstream diagnostics.

### `node16` Resolver Experiment

Using `moduleResolution: "node16"` with `module: "node16"` was too disruptive
as a first migration step. It produced hundreds of diagnostics, including:

- TS2835 requiring explicit `.js` extensions on relative imports
- TS1479 for CommonJS files importing ESM dependencies
- TS1541/TS1542 requiring explicit type-import resolution modes
- unresolved package self-imports because exports resolve to `dist`

Notable ESM boundary surfaces included:

- `@agentclientprotocol/sdk`
- the Nebius cloud SDK
- `micro-key-producer` SSH imports in backend, project-proxy, server, and
  project-host
- Rspack CLI/core imports in the static package
- several `plus` and reflection-related type imports

This route would amount to a broad Node module-system migration. It must not be
selected merely because it is the closest textual replacement for `node10`.

### Bundler Resolver Experiment

Using `moduleResolution: "bundler"` reduced the extension diagnostics, and TS7
accepted it with the existing CommonJS module setting during the probe. It was
still not a drop-in solution:

- CommonJS/ESM boundary diagnostics remained for ACP, Nebius, SSH, Rspack, and
  related dependencies.
- Package exports still redirected self-imports to `dist`.
- Explicit source `paths` mappings fixed many self-import diagnostics but
  exposed project-reference and declaration-graph issues.
- `sync/client/conat-sync-client.ts` pulled a test file excluded from the
  production composite project.
- `conat` declaration collisions remained.
- Generated util message declaration mismatches caused missing exports in
  backend, server, and project.
- Private `node-zendesk` type subpaths did not resolve in server support code.
- Additional package-boundary failures appeared in static, hub, and lite.

Known source-level diagnostics after adding temporary self mappings included:

- `frontend/components/math/katex.tsx`
- `frontend/components/math/ssr.tsx`
- `frontend/markdown/table-of-contents.ts`
- `project/formatters/index.ts`
- `static/src/webapp-embed.ts`
- `hub/servers/database.ts`
- `lite/hub/acp/index.ts`

`module: "preserve"` with the bundler resolver may be appropriate for code that
is always transformed by Rspack, but applying it to Node packages would change
emitted runtime semantics. That needs a separate design decision and runtime
validation.

### Compiler API Consumers

TS7.0 has no compiler API. At minimum, the following must remain on TS6 during
the initial migration:

- `ts-jest`
- `ts-node`
- `src/packages/frontend/scripts/check-antd-tooltip-imports.mjs`, which imports
  `typescript` directly

There may be additional transitive API consumers. Audit all imports of
`typescript`, all test transformers, editor/language-service integrations, and
all scripts that resolve a TypeScript binary before changing dependency names.

## Migration Principles

1. Keep runtime behavior unchanged unless a phase explicitly targets a runtime
   module-format boundary.
2. Keep TS6 available until TS7 has passed production builds and smoke tests.
3. Never make compilation depend on pre-existing `dist` output.
4. Preserve project references, declarations, and incremental correctness.
5. Fix package boundaries rather than suppressing TS7 diagnostics.
6. Modernize one coherent package group at a time.
7. Keep browser-bundled and Node-runtime module strategies separate where they
   have different requirements.
8. Land small, reviewable commits with a green TS6 baseline throughout the
   preparation phases.

## Non-Goals

The initial migration must not attempt to:

- convert the entire repository from CommonJS to ESM
- remove project references or declarations to make diagnostics disappear
- mass-add `.js` extensions before selecting a Node module strategy
- disable package exports
- permanently clean `dist` before every build as a workaround
- add broad `@ts-ignore` or `skipLibCheck` changes
- migrate Jest and all compiler-API tooling to an unavailable TS7 API
- rewrite unrelated package dependency cycles without evidence they block TS7
- combine the compiler migration with runtime dependency upgrades

## Phase 0: Freeze And Measure The Baseline

Before changing dependencies:

1. Record the exact Node, pnpm, TS6, TS7, and OS versions.
2. Run the TS6 solution build from a clean checkout with no package `dist`
   output.
3. Run it again incrementally with output present.
4. Record wall time, peak resident memory, output size, and failure status.
5. Run `pnpm static` and record the same data separately for TypeScript and
   Rspack.
6. Save the complete TS7 diagnostic output as an artifact, grouped by package
   and diagnostic code.
7. Record the current workspace cycle warning and current package build order.

Suggested commands:

```bash
cd src
pnpm install --frozen-lockfile
pnpm tsc
pnpm static
```

Use `/usr/bin/time -v` or an equivalent container-aware measurement tool. Do
not compare TS7 performance until both compilers are checking the same project
graph successfully.

### Phase 0 Exit Criteria

- reproducible TS6 clean and incremental baselines
- complete TS7 diagnostic inventory
- no uncommitted generated output
- documented memory and timing numbers

## Phase 1: Add A Side-By-Side Compiler Toolchain

Adopt the official compatibility layout without changing the default build:

- native TS7 compiler under an explicit workspace dependency
- TS6 compatibility package exposed as `typescript` for compiler API users
- explicit scripts for each compiler

Suggested script model:

```json
{
  "scripts": {
    "tsc:6": "tsc6 --build tsconfig.solution.json",
    "tsc:7": "tsc --build tsconfig.solution.json",
    "tsc": "pnpm tsc:6"
  }
}
```

Keep the TS6 heap setting while TS6 remains the default. Confirm exactly which
binary pnpm exposes for aliases; do not rely on a globally installed `tsc`.

Audit and align direct TypeScript dependencies in the root workspace,
frontend, and util packages. Run `pnpm version-check` after lockfile changes.

Add a non-blocking CI job for `tsc:7` that uploads diagnostics. It should not
become required until the known error count reaches zero.

### Phase 1 Exit Criteria

- `tsc:6` is behaviorally identical to the current `pnpm tsc`
- `tsc:7` invokes the native compiler deterministically
- `require("typescript")` still provides the TS6 compiler API
- Jest, ts-node, and AST lint scripts still run
- frozen workspace install succeeds
- TS7 diagnostics are visible in CI without blocking normal development

## Phase 2: Decide The Module Resolution Architecture

This is the critical design gate. Create a short architecture decision record
after prototyping representative packages from each runtime category.

### Browser And Bundled Packages

Prototype `moduleResolution: "bundler"` for packages whose executable output is
always transformed by Rspack or another bundler, especially frontend and
static. Evaluate whether `module: "preserve"` is safe for their declaration and
build consumers.

Prove:

- Rspack still resolves all package imports
- SSR and test paths do not consume incompatible output
- declaration output remains usable by workspace consumers
- dynamic imports retain expected behavior

### Node Runtime Packages

Prototype a representative Node package using a modern Node resolver. Do not
choose `node16` or `nodenext` until package `type`, emitted extension, startup
commands, Jest behavior, and deployment artifacts are tested together.

Potential strategies are:

1. Preserve CommonJS output and add narrow adapters/dynamic imports for ESM-only
   dependencies.
2. Convert selected leaf packages to ESM with explicit boundaries.
3. Defer broad Node modernization and use a supported resolver configuration
   that preserves runtime semantics, if TS7 documents one suitable for this
   graph.

The investigation did not establish which option is best. The ADR must state
the selected strategy per package category and include a runnable prototype.

### Stop Criterion

If TS7 cannot typecheck Node packages without a repository-wide CommonJS-to-ESM
conversion, stop the compiler migration. Plan and land module modernization as
a separate project first.

### Phase 2 Exit Criteria

- documented resolver/module strategy by package category
- one browser package and one Node package compile and run under the strategy
- no incidental runtime module-format changes
- explicit treatment of ACP, Nebius, SSH, Rspack, and type-only ESM imports

## Phase 3: Make Source Resolution Independent Of `dist`

For every package that imports itself through `@cocalc/<package>`, add explicit
source resolution suitable for composite builds. Likely options include
package-local `paths` mappings or a deliberately designed source condition.

Do not add a blanket mapping mechanically. Inventory for each package:

- whether a bare `@cocalc/<package>` import exists
- whether a root `index.ts` exists
- whether wildcard subpaths are used
- existing package-local `paths` entries that must be preserved
- package exports and type declarations consumed externally
- project-reference relationships

A representative package mapping might look like:

```json
{
  "compilerOptions": {
    "paths": {
      "@cocalc/example": ["./index.ts"],
      "@cocalc/example/*": ["./*"]
    }
  }
}
```

Only include the bare mapping when the package actually has a valid root
source module. Because `paths` does not merge across extended configs, combine
existing entries explicitly rather than replacing them.

Alternatives involving package export conditions should be considered if they
work consistently in TS7, Rspack, Jest, Node, and published artifacts. Avoid a
solution that requires setting a global development condition in production.

Pay special attention to the `comm`/`sync`/`conat` cycle. If source mapping
turns a workspace package cycle into an invalid TypeScript project-reference
cycle, resolve or isolate that cycle before proceeding.

### Phase 3 Validation

For every migrated package:

1. Remove its `dist` and tsbuildinfo output.
2. Compile it through the solution build.
3. Compile again incrementally.
4. Touch a dependency source file and verify the dependent rebuilds.
5. Confirm no emitted declaration is also an input.
6. Confirm package consumers resolve declarations from the intended project.

### Phase 3 Exit Criteria

- no source build relies on existing `dist`
- no TS5055 declaration collisions
- clean and dirty builds resolve the same source graph
- project references rebuild dependents correctly
- package exports still describe runtime/published output correctly

## Phase 4: Remove Obsolete Config And Replace `baseUrl`

Once source resolution is explicit:

1. Remove `downlevelIteration` and verify the current target does not require an
   equivalent transformation.
2. Remove obsolete `ignoreDeprecations` configuration.
3. Remove `baseUrl` package by package.
4. Replace only required aliases with explicit `paths` entries.
5. Apply the resolver/module strategy selected in Phase 2.
6. Keep package-specific overrides minimal and documented.

Run config inspection for every solution project so inherited and package-local
options are visible. Add a small script if necessary to detect new uses of
removed options.

### Phase 4 Exit Criteria

- no TS7-removed compiler options remain
- every package has an intentional resolver/module configuration
- TS6 still compiles the prepared config, where possible
- no unresolved import is hidden by stale output

## Phase 5: Repair Runtime Module Boundaries

Address ESM/CommonJS issues in focused commits by subsystem rather than one
global mechanical edit.

Suggested groups:

1. ACP SDK imports and adapters.
2. Nebius cloud SDK imports.
3. SSH key generation through `micro-key-producer` in backend,
   project-proxy, server, and project-host.
4. Rspack CLI/config loading in static.
5. Type-only ESM imports and explicit resolution modes.
6. Private or undocumented subpath imports such as `node-zendesk` types.

For an ESM-only dependency consumed by CommonJS runtime code, prefer one narrow
adapter or dynamic import boundary over scattering suppressions. Test the
actual built JavaScript in the Node version used in production.

If a dependency exposes no stable public types, add a local narrow declaration
for the used API or contribute an upstream fix. Do not couple production code
to a private declaration subpath merely to satisfy TS7.

### Phase 5 Exit Criteria

- no TS1479, TS1541, or TS1542 diagnostics
- affected Node processes start from built output
- affected functionality has focused runtime tests
- no broad repository-wide module-format conversion was introduced

## Phase 6: Repair The Declaration And Source Graph

With imports resolving correctly, fix the remaining composite/declaration
issues:

- remove production imports of excluded test files, including the known sync
  client test dependency
- correct generated util message declarations and exports
- resolve conat/sync declaration graph collisions
- fix static, hub, and lite cross-package imports
- add explicit portable return types for TS2883 exports
- fix callback and generic signature differences exposed in frontend math,
  markdown table-of-contents, and project formatters

Generated declarations must be regenerated from their source generator rather
than hand-edited. Add a consistency check if generated source and declaration
surfaces can drift silently.

Run TS7 after each package group and maintain a checked diagnostic count. New
diagnostics should be classified rather than hidden.

### Phase 6 Exit Criteria

- `tsc:7 --build` succeeds from a clean tree
- a second incremental `tsc:7 --build` succeeds
- forced rebuild succeeds
- no generated declaration drift
- exported declarations do not contain non-portable inferred names

## Phase 7: Validate Tests And Compiler-API Tooling

Keep TS6 as the compiler API provider initially. Explicitly document that TS7
checks production projects while TS6 may still transpile tests.

Validate:

- all Jest projects using `ts-jest`
- all scripts using `ts-node`
- frontend AST lint and custom TypeScript scripts
- IDE/editor configuration and language server selection
- scripts that shell out to `tsc`
- package-local builds that may bypass the solution script

This dual-compiler period can expose differences between production checking
and test transpilation. CI should run both until TS7's compiler API is available
and tooling compatibility is proven.

When TS7.1 or later is available, open a separate task to evaluate removing the
TS6 compatibility dependency. Do not make that a prerequisite for adopting the
TS7 compiler.

### Phase 7 Exit Criteria

- package tests pass with the documented compiler split
- custom AST tooling still behaves identically
- no package silently invokes the wrong compiler
- editor setup is documented for contributors

## Phase 8: Full Build And Runtime Qualification

Run the following matrix from a fresh checkout and from an incremental working
tree:

### Static Checks

```bash
pnpm -C src version-check
pnpm -C src tsc:6
pnpm -C src tsc:7
pnpm -C src lint:frontend
```

### Builds

```bash
pnpm -C src build:dev
pnpm -C src static
```

Also run package-local builds for at least:

- frontend
- util
- comm
- sync
- conat
- backend
- server
- hub
- project-host
- CLI
- static

### Tests

Run focused tests throughout the migration, then the complete workspace test
suite before changing the default. Give special attention to:

- module-loading tests
- generated message APIs
- database and server startup
- Conat and sync behavior
- frontend SSR and static pages
- ACP/Codex integration
- cloud and SSH host operations

### Live Smoke Tests

Using the documented Lite and hub development environments, verify:

- Lite startup and browser load
- full hub startup and sign-in
- project open and project-host connection
- terminal, Jupyter, file editor, and Codex
- CLI startup and representative commands
- static/public page load and SSR

### Artifact Checks

- compare emitted package file lists between TS6 and TS7
- inspect representative CommonJS and ESM output
- inspect declaration package paths
- ensure source maps refer to valid sources
- ensure npm/pnpm package exports point to files that are actually emitted
- verify no source or test file is accidentally copied into runtime output

### Performance Checks

Record clean and incremental:

- wall time
- CPU time
- peak RSS
- output size
- tsbuildinfo size

Compare only equivalent successful builds. The migration should produce a
meaningful build improvement, but correctness is the release gate.

## Phase 9: Switch The Default Compiler

After all qualification gates pass:

1. Make `pnpm tsc` invoke TS7.
2. Make `pnpm static` use TS7 through that script.
3. Keep `pnpm tsc:6` available as an explicit compatibility check.
4. Make the TS7 CI job required.
5. Keep TS6 CI non-blocking or scheduled for one release cycle.
6. Document the compiler split for AST/test tooling.
7. Deploy through staging and monitor build and runtime failures.

Do not remove the TS6 fallback in the same commit that switches the default.

### Phase 9 Exit Criteria

- default local and CI builds use TS7
- static production build completes within container memory limits
- staging smoke tests pass
- no production runtime loader regressions
- rollback requires only a script/default change, not reverting source fixes

## Rollback Plan

During preparation phases, TS6 remains the default and rollback is simply
removing the optional TS7 check.

After the default switch:

1. Change `pnpm tsc` and `pnpm static` back to `tsc:6`.
2. Retain config/source fixes that are also valid in TS6.
3. Revert only TS7-exclusive config if TS6 cannot parse it.
4. Rebuild static artifacts with the 6144 MB TS6 heap.
5. File the failing package and diagnostic as a blocking migration issue.

The lockfile should retain both compilers until this rollback has been tested
once in CI.

## Suggested Commit Sequence

Keep commits independently reviewable and TS6-green where possible:

1. `build: add side-by-side TypeScript compilers`
2. `build: inventory TypeScript 7 diagnostics in CI`
3. `build: define browser and node module resolution strategy`
4. One commit per package group for source self-resolution
5. One commit per runtime dependency group for ESM boundaries
6. `build: remove TypeScript 7 obsolete compiler options`
7. One commit per package group for declaration/source diagnostics
8. `build: qualify TypeScript 7 in required CI`
9. `build: switch solution compiler to TypeScript 7`

Avoid mixing generated declaration fixes, runtime import changes, and compiler
dependency changes in one commit.

## Effort And Risk Estimate

This is likely several focused engineering days and could reach one or two
weeks depending on the selected Node module strategy and the
`comm`/`sync`/`conat` declaration cycle.

The high-risk areas are:

- changing Node runtime module semantics
- source self-imports resolving to stale output
- package-reference cycles
- generated declaration drift
- different compilers used by production checking and tests
- package-local scripts bypassing the selected compiler

The low-risk mechanical work is:

- side-by-side dependency setup
- removing obsolete scalar options
- explicit return types for known TS2883 diagnostics
- adding a diagnostic-only CI job

The project should be scheduled when there is enough time to complete and
validate the module-resolution work, not merely when TS6 build memory becomes
annoying. The existing heap increase already provides a safe interim build.

## Final Acceptance Criteria

The migration is complete only when all of the following are true:

- TS7 is the deterministic compiler used by `pnpm tsc` and `pnpm static`.
- Clean, incremental, and forced solution builds pass.
- Builds do not depend on pre-existing `dist` output.
- Package declarations and exports resolve correctly for all workspace
  consumers.
- Node runtime packages preserve intentional CommonJS/ESM behavior.
- Frontend, static, SSR, tests, and custom AST tooling pass.
- Lite and hub-backed runtime smoke tests pass.
- The full static build stays within the target container memory budget.
- TS7 build time and memory measurements are recorded.
- A tested TS6 rollback remains available for at least one release cycle.
- No diagnostics are hidden by broad suppressions or reduced declaration
  coverage.

## Progress Log

- 2026-09-29: Re-probed on current `main`, recorded the revision above, and
  opened the draft migration PR.
- 2026-09-29: Phase 0 baseline in a fresh worktree of `main` (Node 26.10,
  pnpm 11.9, TS 6.0.3, TS 7.0.2, Linux x64, 16 cores). TS6 solution build:
  clean 160 s wall / 4.8 GB peak RSS **with 5 errors** (the `sync`/`conat`
  cycle; `main` cannot build from a clean tree), second pass 48 s / 2.9 GB,
  no-op 0.4 s.
- 2026-09-29: Phase 1. TS 7.0.2 is installed as `@typescript/native` in the
  private `packages/typescript-native` package. It cannot live in the root
  package: its `tsc` binary would replace TS6's `node_modules/.bin/tsc`, which
  many package build scripts call directly. Root scripts `tsc:6` and `tsc:7`
  run the solution build; `tsc:build` still uses TS6.
- 2026-09-29: Phases 2-4. `bundler` resolver with CommonJS emit, removed
  `baseUrl`/`downlevelIteration`/local `node` resolvers, and the shared
  `@cocalc/*` source mapping (Decision 2). This removed every resolver, stale
  `dist`, TS5055, and `sync`/`conat` diagnostic and fixed the TS6 clean build.
- 2026-09-29: Phase 6. Public `node-zendesk/clients/*` import path and
  explicit return types for the Stripe and Orama TS2883 exports.
- 2026-09-29: Results. Both compilers report 0 errors on clean, incremental,
  and no-op builds.

  | Solution build    | TS6 (6144 MB heap) |           TS7 |
  | ----------------- | -----------------: | ------------: |
  | clean             |     162 s / 3.9 GB | 19 s / 6.0 GB |
  | no-op incremental |              0.4 s |         0.4 s |

  TS7 peak RSS is higher on a clean build because it checks projects in
  parallel; it is not bounded by the V8 heap setting.

- 2026-09-29: Emit comparison of clean TS6 vs TS7 builds: identical file sets
  (5,785 `.js`, 5,785 `.d.ts`). 9 `.js` files differ only by equivalent
  rewrites (destructuring export assignment instead of a temporary; static
  members referenced by class name instead of an alias). `.d.ts` differences
  are union/member ordering, method vs property signatures, and better import
  paths.
- 2026-09-29: No bundler or runtime tool reads tsconfig `paths` (only
  type-checking does), so the mapping does not change runtime resolution.
