# RootFS Recipe Image Workflow

How we author, build, test, and release managed RootFS images from recipes in
this repo. TeX Live is used throughout as the running example because it covers
both interesting cases: a from-scratch build, and a periodic in-place update
that produces a new dated release.

This is the operational companion to [docs/project-rootfs.md](../../docs/project-rootfs.md),
which describes how a published image is then selected and started on a
project host.

## Where Things Live

Recipes are plain data in this repo:

```
src/packages/rootfs-recipes/
  cocalc/<module>/
    recipe.json     # id, typed inputs with defaults, contributed catalog metadata
    install.sh      # the work, or a wrapper that fetches it
    verify.sh       # post-install assertions
  examples/
    <image>.yaml    # image spec: steps + verify + publish
```

Two distinct concepts:

- a **module** (`cocalc/texlive`) is a reusable building block with typed
  inputs, invoked as `uses: cocalc/texlive` with `with:` values,
- an **image spec** (`examples/texlive.yaml`) is what actually produces a
  published catalog entry: a list of steps, top-level `verify`, and a `publish`
  block.

`packages/cli/scripts/generate-rootfs-recipes.js` walks that directory at CLI
build time and emits `rootfs-recipes-builtin.generated.ts`, so released CLIs
ship the recipes with no filesystem dependency.

### Small Payloads Inline, Large Ones In Their Own Repository

For a module whose work is a few dozen lines of shell, keeping `install.sh` in
this repository is right: one place to look, nothing to pin.

Past that it stops paying. A large installer pulls hundreds of lines of shell
into the monorepo, and anything it needs at runtime — configuration templates,
package lists, test documents — has to be embedded in heredocs, because module
scripts are inlined into the generated build script and sibling files are never
shipped (see "One module, one script" below).

The alternative is a small dedicated repository holding the scripts and their
data files, with the module reduced to a wrapper that shallow-clones it and
execs one script. `cocalc/texlive` works this way, against
[texlive-installer](https://github.com/sagemathinc/texlive-installer):

- the installer, its `install-tl` profile template, its APT package list and its
  test documents are ordinary files, editable and runnable outside CoCalc,
- there are no heredocs,
- the monorepo carries one wrapper plus one `recipe.json`.

The costs are real and worth stating: builds now depend on a second repository
being reachable, the fetched ref must be pinned for a build to be reproducible,
and the two repositories can drift. Use this only when the payload is genuinely
large; prefer inline for anything smaller.

Whichever side of that line a module falls on, the interface is the same: typed
inputs in `recipe.json`, arriving as environment variables.

## Key Mechanic: Recipes Resolve Locally

The CLI reads the YAML and any referenced module scripts **from local disk**,
expands them into a single shell script, and sends that script to the hub as
the durable build payload (`startProjectRootfsBuild` in
`packages/cli/src/bin/commands/rootfs.ts`).

Consequences that matter in practice:

- a recipe file on your laptop works against any site, including production;
  nothing has to exist server-side first,
- you do not need to rebuild or publish the CLI to iterate on a recipe,
- `--module-dir <path>` points module resolution at a working tree, so edits
  take effect on the next run,
- only `cocalc rootfs recipe ls` (the bundled listing) requires a CLI rebuild.

## Authoring

### Never Inline Real Work In YAML

Inline `run:` steps take literal strings only; there is no include mechanism.
Any script of real length becomes an unreadable heredoc inside YAML. Real work
belongs in a module `install.sh`, so it stays a shell file that can be linted,
run, and diffed.

### One Module, One Script

A module has exactly one `run` script and one `verify` script, and their
**contents are inlined** into the generated build script. Sibling files in the
module directory are not uploaded and do not exist at build time, so an
`install.sh` that calls `./helper.sh`, or reads a fixture next to it, fails.

That constraint is what drives the two shapes:

- **inline** — everything the script needs is either computed or written from a
  heredoc,
- **external repository** — the script is a wrapper that fetches a repository
  where helpers and data files are ordinary files.

### Mode Inputs, Not Auto-Detection

When one piece of software needs both a from-scratch build and a periodic
update, give it an explicit `mode` input rather than detecting an existing
installation. Recipes also run into live projects via `recipe run --here`, and a
script that silently switches behaviour based on what it finds is surprising in
that context.

### Selecting A Script Per Step

A module can also take the script name as an input, so one module serves several
steps:

```yaml
- uses: cocalc/texlive
  with: { script: install.sh, mode: update }
- uses: cocalc/texlive
  with: { script: tests/run.sh }
```

If you do this, keep `contributes.content.actions` empty. Module contributions
are merged once per step, and action lists concatenate rather than replace, so a
module used four times would contribute its actions four times.

### Keep Site-Specific Values In Inputs

Mirrors, repository URLs, internal paths: all belong in recipe **inputs** with
sensible public defaults, never hardcoded. These files are committed and ship
inside the CLI for every user.

### Pin The Fetched Ref

A module that fetches an external repository is only reproducible if the ref is
pinned. Default to a branch for convenience during development, but pin a tag or
a commit for anything published, and record which ref produced a given release.
Fetch by explicit ref rather than `git clone --branch`, so that a branch, tag or
full commit sha all work:

```bash
git -C "$dir" init -q
git -C "$dir" remote add origin "$repo_url"
git -C "$dir" fetch -q --depth 1 origin "$repo_ref"
git -C "$dir" checkout -q FETCH_HEAD
```

The wrapper must also ensure `git` itself is installed, since that cannot come
from the repository it is about to fetch.

## Flow A: Full Build From Scratch

Used when creating a new image family, or rebasing onto a new upstream base.

```bash
cocalc rootfs build ./src/packages/rootfs-recipes/examples/texlive.yaml \
  --module-dir src/packages/rootfs-recipes
```

With no `--project`, the CLI creates a **clean builder project**, runs the
steps there, and follows the logs. This is the reproducible form: the resulting
image is a function of the recipe alone. Prefer it for anything intended as a
release.

The spec may declare a starting point:

```yaml
base:
  image_id: <previous catalog image id> # or base.image for a Docker/OCI ref
```

`base` is applied only when the CLI creates the builder project. It has no
effect when building into an existing project, which already has its own image.

Pin `base` late, not early. An image built on another catalog entry inherits
things the recipe never installs — the TeX Live images sit on the Jupyter image,
which is where JupyterLab and the app launcher come from — so a from-scratch
rebuild without `base` silently lacks them while the catalog entry still
advertises them. But the parent moves on its own schedule, so an id committed
between rebuilds is stale by the time anyone needs it. Record the dependency as
a note and resolve the id when the rebuild actually happens.

`builder.run_quota` on the spec sizes that builder project — worth setting for
large builds:

```yaml
builder:
  run_quota:
    disk_quota: 50000
```

## Flow B: Incremental Update In The Same Project

This is the monthly TeX Live case: take the project already running last
month's image, run only the update step, publish the result as a new dated
version.

Because the project already runs the previous image, `base:` is unnecessary —
the existing rootfs _is_ the base.

```bash
cocalc rootfs build ./src/packages/rootfs-recipes/examples/texlive-update.yaml \
  --module-dir src/packages/rootfs-recipes \
  --project <texlive-build-project>
```

Only system-level changes land in the image. Files under `/home/user` in the
build project are not part of the rootfs, so working files there do not leak
into the release.

Trade-off to be aware of: repeated in-place updates accumulate state that is
not described by any single recipe. The image is reproducible only as a chain
of update runs. That is acceptable for TeX Live, where a full rebuild is
expensive and `tlmgr`-style updates are the upstream-supported path. Do a
periodic Flow A rebuild anyway, so the chain has a known-clean origin.

### Preview Before Committing Build Time

```bash
cocalc rootfs recipe run <spec> --module-dir src/packages/rootfs-recipes --dry-run
```

Prints the fully expanded script — modules resolved, inputs substituted —
without touching a project. Cheap insurance before a multi-hour build.

### Long Builds

The non-`--here` form registers a durable build, which is what makes
`build-status`, `build-logs`, `build-attach`, `build-events`, and
`build-cancel` available. Use `--detach` to start and walk away, then
`build-attach` later.

`--here` runs local subprocesses inside the current project instead. It is
convenient from a terminal in the project, but it is not a durable build:
`--publish` is rejected with `--here`, and the follow-up is
`cocalc rootfs publish` rather than `cocalc rootfs build-publish`.

## Release: Private First, Then Promote

Never publish straight to public. The sequence is deliberate.

### 1. Publish privately

```bash
cocalc rootfs build-publish \
  --visibility private \
  --label "TeX Live" \
  --family texlive \
  --image-version 2026.08 \
  --channel stable \
  --supersedes-image-id <previous texlive image id> \
  --wait
```

Note the catalog fields:

- `family`, `channel`, GPU mode, and official status define the compatible
  scope in which releases may be linked,
- community releases must also have the same owner; official releases may
  cross owners because every official entry is admin-vouched,
- `version` and `channel` are the user-facing labels,
- `supersedes_image_id` is what actually wires the lineage and drives the bulk
  upgrade flow. Without it a new release is just an unrelated image sitting
  next to the old one.

`cocalc rootfs list --json` gives the resulting `image_id`.

### Carrying theme and app actions across releases

A catalog entry's visual identity is often an uploaded image (`theme.image_blob`,
a server-side UUID) rather than a named `icon`, and its landing page may declare
`content.actions` such as a JupyterLab launcher. Neither belongs in a recipe:
the blob id is site-specific, and committing it would ship one deployment's
identifier to every user of the CLI.

Instead, export the previous release's config from the UI and pass it at
publish, letting command-line flags override the fields that change:

```bash
cocalc rootfs build-publish \
  --config-file ./texlive-2026-07.rootfs-config.json \
  --image-version 2026.08 \
  --slug texlive-2026-08 \
  --supersedes-image-id <previous image id> \
  --visibility private --wait
```

`rootfsCatalogConfigPayload` prefers explicit options over the config file, so
theme and content ride along untouched while version, slug and lineage advance.

Two traps here:

- **Do not put `content.actions` in a spec's `publish:` block.**
  `rootfsRecipeConfigForLoadedRecipe` merges the spec config, then each module's
  contribution, then the spec config again; because action lists concatenate
  rather than replace, anything declared in the spec appears twice. Module
  `contributes.content.actions` is merged once and is the safe place.
- **Theme merges key by key.** A module that contributes `icon` or `color`
  keeps those keys even when a later config supplies `image_blob`, so a stray
  placeholder icon survives into the published entry. Leave theme keys unset
  unless the module genuinely owns them.

### 2. Smoke test on a separate project

Point an existing project that has real content — actual `.tex` files,
realistic build setups — at the private image, rather than testing in the
builder project. This is the step that catches side effects: the builder
project's state can mask a missing dependency that a fresh project would hit.

Overlay upperdirs are keyed per image, so switching gives that project a clean
overlay for the new image, and the previous overlay stays intact if you switch
back.

This is a UI action: Project Settings → Root filesystem image → select the
private catalog entry. The project restarts onto the new image. There is no
CLI equivalent for switching an existing project (see "Notes" below), but the
manual switch is a fine part of the loop — it is a one-time step per release,
and doing it by hand is a natural place to eyeball the catalog entry.

For a genuinely clean check instead of an existing project:

```bash
cocalc project create <name> --rootfs-image-id <image_id> --start
```

### 3. Promote to public

Only after the smoke test passes. Promotion updates the existing entry in place
rather than creating a second one.

**`rootfs save` replaces the entry; it does not merge into it.** The
`ON CONFLICT DO UPDATE` clause in `saveRootfsImage` splits the columns two ways:

- preserved when omitted, via `COALESCE`: `family`, `version`, `channel`,
  `supersedes_image_id`, `slug`, `release_id`,
- overwritten when omitted, straight from `EXCLUDED`: `label`, `description`,
  `visibility`, `official`, `prepull`, `hidden`, `arch`, `gpu`, `size_gb`,
  `tags`, `theme`.

So a minimal `save --image-id X --visibility public` silently blanks the
description, drops the tags, wipes the theme including any uploaded
`image_blob`, and clears the `official` flag. Only `content` is guarded, by an
explicit "was content supplied" check.

Either promote from the settings UI, whose manage form pre-fills the current
values, or re-supply the metadata on the command line:

```bash
cocalc rootfs save --image-id <image_id> --image <runtime_image> \
  --config-file <previous release config>.json \
  --label "<label>" --tags "<tags>" --visibility public --official
```

If something turns out broken after going public, `cocalc rootfs block <id>`
stops new use and `cocalc rootfs hide <id>` removes it from normal views. Both
are cheaper and more reversible than delete plus GC.

### 4. Commit the recipe

Commit on the working branch once the release is out. After promotion, the spec
in git is the build recipe for a specific published `image_id`, so the next
cycle is that same spec against the new image, and the chain stays auditable.

## Running Against A Live Site

Publishing is a control-plane mutation and requires browser-approved fresh
auth. API keys, bearer tokens, and hub-password auth do not satisfy it.

```bash
cd src && node packages/cli/dist/bin/cocalc.js \
  --profile prod --api https://cocalc.ai auth bootstrap --email <operator email>
```

Then pass `--profile prod` to the `rootfs` commands. For local dev hub work,
load the env first (`eval "$(pnpm -s dev:hub:env)"`) and use
`cocalc auth elevate --dev`.

## Notes And Rough Edges

Current as of August 2026. Worth re-checking before assuming they still hold.

- **Switching an existing project's image is UI-only.** The hub API exists
  (`system.setProjectRootfsImage`) and the UI uses it via `switchProjectRootfs`
  in `packages/frontend/project/settings/root-filesystem-image.tsx`, but the CLI
  only exposes `project create --rootfs-image-id` and `--switch-project` on
  publish, which targets the build project. Not a blocker — the smoke-test
  switch is manual by design. A thin `cocalc project rootfs set` wrapping the
  existing hub call would be needed only to script the loop end to end.
- **`supersedes_image_id` in a spec's `publish:` block is supported, but keep
  deployment-specific ids off the spec.** `emptyRecipeConfig` now carries the
  field through, so a spec can declare it. A catalog image id identifies one
  deployment's entry, however, and the recipes ship inside the CLI for every
  user, so for images published to a real site the id still belongs on the
  command line via `--supersedes-image-id`. Declare it in the spec only for
  recipes that are never published beyond a single installation.
- **`base:` is wired but unexercised.** No bundled example uses it. Smoke test
  it on a throwaway build before depending on it for a real release.
- **No dedicated update hook in the module format.** A module has `run` and
  `verify` only; the `mode` input pattern above is the convention, not a
  framework feature.

## Command Reference

Authoring and inspection:

- `cocalc rootfs recipe ls` — bundled examples and local modules
- `cocalc rootfs recipe explain <recipe>` — resolved steps and inputs
- `cocalc rootfs recipe run <recipe> --dry-run` — expanded script, no side effects
- `cocalc rootfs recipe run <recipe> --here` — run steps into the current project

Building:

- `cocalc rootfs build <recipe>` — clean builder project
- `cocalc rootfs build <recipe> --project <p>` — build into an existing project
- `cocalc rootfs build-status | build-logs | build-attach | build-events | build-cancel`
- `cocalc rootfs build-binder <provider> <owner> <repo> <ref>` — Binder-derived recipe

Releasing:

- `cocalc rootfs build-publish` — publish a successful durable build
- `cocalc rootfs publish --project <p>` — publish a project's current rootfs state
- `cocalc rootfs save --image-id <id> ...` — update an existing catalog entry
- `cocalc rootfs list | admin-list` — catalog entries
- `cocalc rootfs block | unblock | hide | unhide | delete | gc`
- `cocalc rootfs scan | scan-report | scan-audit` — vulnerability scanning
