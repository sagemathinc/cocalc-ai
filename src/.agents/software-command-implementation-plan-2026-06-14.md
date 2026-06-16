# CoCalc Software Command Implementation Plan

Status: implementation plan, 2026-06-14.

Goal: add a high-level `cocalc software` lifecycle command for the common
build, publish, list, deploy, and smoke-test workflow. The command should hide
the flag-heavy lower-level `rocket`, `host`, package-local, GitHub release, and
R2 publish tools behind a small operator surface that is easy to remember.

This plan intentionally keeps `cocalc rocket deploy`, `cocalc host upgrade`,
package publish scripts, and Star release scripts as the low-level power tools.
`cocalc software` should orchestrate those tools using immutable manifests and
operator profiles.

## Requested Operator Interface

Primary commands:

```sh
cocalc software build <component> [tag]
cocalc software push <component> <tag-or-id>
cocalc software list <component>
cocalc software deploy <component> <tag-or-id> <profile-or-channel>
cocalc software history <component> <profile-or-channel> [--limit <n>]
cocalc software smoke <component> <profile-or-channel>
```

Accepted build components:

```text
static
hub
bay
project-host
project
tools
cli
launchpad
plus
star
```

Accepted deploy components:

```text
static
hub
bay
bay-conat-router
bay-conat-persist
bay-frontdoor
bay-cloudflared
bay-scaffold
host-conat-router
host-conat-persist
project-host
project
tools
cli
launchpad
plus
star
```

Important operator semantics:

- `build` is local only. It must not push.
- `push` uploads an already-built local immutable artifact and updates the
  component index.
- `deploy` requires the artifact to exist remotely. If it exists locally but not
  remotely, `deploy` may push it first. If the artifact exists nowhere, fail
  with a clear error.
- The build tag is optional. If omitted, generate a safe tag and print it in
  the build summary.
- Explicit and generated tags must be unique per component across both local
  and remote indexes.
- `deploy ... --build` can be added as the only convenience flag if desired:
  if an explicit tag is provided, fail when it already exists; if no tag is
  provided, generate a tag; otherwise build, push, then deploy.
- `star` uses the third positional argument as a channel (`stable`,
  `candidate`, or `dev`) instead of an auth profile.
- `cli`, `launchpad`, and `plus` are publish/promote style components. They do
  not deploy to a Rocket site profile. They should still have explicit
  channels so an operator can publish a candidate, test it on real machines,
  then promote the same immutable artifact to stable.
- This plan is not 100% complete until `bay`, `bay-conat-router`,
  `bay-conat-persist`, `bay-frontdoor`, `bay-cloudflared`, and `bay-scaffold`
  are fully supported or deliberately removed from the accepted component list.

## Current Repository Facts

### Existing Rocket Commands

`src/packages/cli/src/bin/commands/rocket.ts` currently implements:

- `cocalc rocket release build --kind bay-runtime`
- `cocalc rocket release build --kind bay-hub`
- `cocalc rocket release build --kind bay-static`
- `cocalc rocket release build --kind project-host-software`
- `cocalc rocket deploy --scope static|hub|bay|hosts|all ...`
- `cocalc rocket health host-routes ...`

The current Rocket release builder delegates to package `@cocalc/rocket`:

- `build:bay-bundle` -> `src/packages/rocket/bay/build-bundle.sh`
- `build:bay-hub-bundle` -> `src/packages/rocket/bay/build-hub-bundle.sh`
- `build:bay-static-bundle` -> `src/packages/rocket/bay/build-static-bundle.sh`
- `build:project-host-software-bundle` ->
  `src/packages/rocket/bay/build-project-host-software-bundle.sh`

The existing `bay-runtime` tarball includes:

- hub/control-plane bundle
- bay static assets
- bay migration helpers
- bay cloudflared helper
- bay systemd scaffold
- bay-local project-host daemon bundle

For the high-level operator interface, call the full runtime component `bay`.
The `hub` component is the smaller control-plane-only artifact intended for
normal hub/backend deploys.

The current `project-host-software` tarball includes:

- project-host bundle
- project bundle
- tools bundle
- bootstrap.py

That is useful for full Rocket deploys, but the high-level `software` command
should model `project-host`, `project`, and `tools` as distinct artifacts so
they can be tested and deployed independently.

### Existing Project Host Software Commands

`cocalc host upgrade` already supports:

- artifacts: `project-host`, `project`, `tools`, `bootstrap-environment`
- channels: `latest` and `staging`
- explicit artifact version
- hub `/software` source or explicit base URL
- all-online host upgrades
- runtime stack alignment

`cocalc host rollout` already supports host-side managed components:

- `project-host`
- `conat-router`
- `conat-persist`
- `acp-worker`

Those are project-host-local components. They are not the same as the bay
`bay-conat-router` and `bay-conat-persist` services requested for
`cocalc software deploy bay-conat-router ...` and `cocalc software deploy
bay-conat-persist ...`.

### Existing R2 Publishing Scripts

There is an existing generic uploader:

```text
src/packages/cloud/scripts/publish-r2.js
```

It uploads one file, writes `<file>.sha256`, optionally writes a `latest.json`,
and optionally maintains a versions index. It reads credentials from environment
variables such as:

```text
COCALC_R2_BUCKET
COCALC_R2_PUBLIC_BASE_URL
COCALC_R2_ACCOUNT_ID
COCALC_R2_ACCESS_KEY_ID
COCALC_R2_SECRET_ACCESS_KEY
```

Existing package-local publish scripts use it:

- `src/packages/cli/sea/publish-sea.sh`
- `src/packages/launchpad/sea/publish-sea.sh`
- `src/packages/plus/sea/publish-sea.sh`
- `src/packages/project-host/sea/publish-bundle.sh`
- `src/packages/project/sea/publish-bundle.sh`
- `src/packages/project/sea/publish-tools.sh`

Current R2 publishing is channel/latest oriented, not tag-first and
manifest-first. `cocalc software` should reuse the R2 client primitives, but
introduce a new manifest/index schema rather than overloading existing
`latest.json` files.

The operator-provided secret file currently exists at:

```text
/run/secrets/cocalc/rocket-software-env.sh
```

The new command should support that path as a config default, but it must also
allow explicit configuration so credentials do not have to be exported into the
operator shell.

### Existing Star Flow

Star is currently built and promoted using:

- `src/scripts/star/build-github-release-assets.sh`
- `src/scripts/star/build-star-release.sh`
- `src/scripts/star/promote-github-release-channel.sh`
- `src/scripts/star/smoke-star.sh`

Star currently publishes through GitHub releases and has channels:

- `cocalc-star-stable`
- `cocalc-star-candidate`
- `cocalc-star-dev`

The initial `cocalc software star` integration should wrap these scripts and
record matching local/remote manifests. It should not force Star onto R2 before
the Star installer path is intentionally changed.

## Names And Disambiguation

There are two different Conat router/persist service families:

- Hub/bay services under Rocket systemd, e.g.
  `cocalc-bay-conat-router.service` and
  `cocalc-bay-conat-persist.service`.
- Project-host-local managed components controlled by `cocalc host rollout`.

Use explicit names in the high-level `software` command:

- `bay-conat-router` means the Rocket bay/hub Conat router service.
- `bay-conat-persist` means the Rocket bay/hub Conat persist service.
- `bay-frontdoor` means the Rocket bay frontdoor/sticky-session service.
- `bay-cloudflared` means the Rocket bay Cloudflare tunnel service/helper.
- `bay-scaffold` means Rocket bay systemd units, scripts, and env templates
  without necessarily changing application runtime code.
- `host-conat-router` means the project-host-local Conat router component.
- `host-conat-persist` means the project-host-local Conat persist component.

Do not accept bare `conat-router` or `conat-persist` in `cocalc software`.
The whole point of the high-level command is to be memorable under pressure,
and bare names are ambiguous during incidents.

Project-host-local component rollouts should remain lower-level host operations
until `host-conat-router` and `host-conat-persist` are deliberately wired into
`cocalc software`:

```sh
cocalc host rollout <host> --component conat-router --wait
```

## Artifact Identity

Each build produces one immutable artifact id:

```text
<timestamp>-<git8>-<tag>[-dirty]
```

Example:

```text
20260614T235912Z-e882d124-fix-bug
20260614T235912Z-e882d124-fix-bug-dirty
```

Rules:

- Timestamp is UTC ISO-like compact format: `YYYYMMDDTHHMMSSZ`.
- `git8` is the first 8 characters of `git rev-parse HEAD`.
- `tag` is optional for `build`. If provided, it must match
  `^[A-Za-z0-9._-]+$`.
- If `tag` is omitted, generate one from the UTC build time. First try
  `YYYYMMDDTHHMMZ`, then `YYYYMMDDTHHMMSSZ`, then append `-2`, `-3`, etc. if
  needed to avoid local or remote conflicts.
- `dirty` suffix is present when the repo has unstaged or staged changes in the
  source tree at build time.
- Dirty builds are allowed, but the dirty flag must be explicit in the manifest
  and the artifact id.
- Tag uniqueness is per component. A tag cannot be reused for the same
  component locally or remotely.
- The manifest must record whether the tag was explicit or generated.

Selectors accepted by `deploy`:

- exact artifact id
- exact tag
- exact timestamp prefix, if unambiguous
- exact git hash prefix, if unambiguous

If a selector matches more than one artifact, fail and show the matching rows.
Do not guess.

## Local Artifact Store

Default local store:

```text
/tmp/cocalc-software/<component>/<artifact-id>/
  manifest.json
  files/
    ...
```

Reasons:

- Keeps large artifacts out of `/home/user`.
- Makes local build and push separate.
- Lets `deploy` discover and push a local artifact if remote is missing.
- Keeps metadata and files together for manual inspection.

The local store path should be configurable:

- `software.local_store` in config
- `COCALC_SOFTWARE_LOCAL_STORE`
- default `/tmp/cocalc-software`

Do not put the local store under `src/packages/.../build` for the high-level
workflow. Package-local build directories are intermediate scratch, not the
operator artifact store.

## Remote R2 Layout

Use a new layout under the existing software bucket.

Suggested default:

```text
software/artifacts/<component>/<artifact-id>/manifest.json
software/artifacts/<component>/<artifact-id>/files/<filename>
software/artifacts/<component>/<artifact-id>/files/<filename>.sha256
software/indexes/<component>.json
software/deployments/<profile-or-channel>/<component>/<timestamp>-<artifact-id>.json
software/deployments/<profile-or-channel>/<component>/index.json
```

Example:

```text
software/artifacts/hub/20260614T235912Z-e882d124-fix-bug/manifest.json
software/artifacts/hub/20260614T235912Z-e882d124-fix-bug/files/cocalc-bay-runtime-linux-x64.tar.xz
software/artifacts/hub/20260614T235912Z-e882d124-fix-bug/files/cocalc-bay-runtime-linux-x64.tar.xz.sha256
software/indexes/hub.json
software/deployments/staging/hub/20260615T050500Z-20260614T235912Z-e882d124-fix-bug.json
software/deployments/staging/hub/index.json
```

Index files are mutable and small. Artifact files, artifact manifests, and
individual deployment records are immutable.

Cache headers:

- artifact files: `public, max-age=31536000, immutable`
- artifact manifests: `public, max-age=31536000, immutable`
- deployment records: `public, max-age=31536000, immutable`
- component indexes: `public, max-age=60` or `public, max-age=300`
- deployment indexes: `public, max-age=60` or `public, max-age=300`

Remote index schema:

```json
{
  "schema": "cocalc-software-index-v1",
  "component": "hub",
  "generated_at": "2026-06-14T23:59:12.000Z",
  "artifacts": [
    {
      "artifact_id": "20260614T235912Z-e882d124-fix-bug",
      "tag": "fix-bug",
      "tag_generated": false,
      "timestamp": "2026-06-14T23:59:12.000Z",
      "git": {
        "commit": "e882d124c7...",
        "short": "e882d124",
        "dirty": false
      },
      "manifest_key": "software/artifacts/hub/20260614T235912Z-e882d124-fix-bug/manifest.json",
      "manifest_url": "https://software.cocalc.ai/software/artifacts/hub/20260614T235912Z-e882d124-fix-bug/manifest.json",
      "files": [
        {
          "name": "cocalc-bay-runtime-linux-x64.tar.xz",
          "size_bytes": 48123456,
          "sha256": "..."
        }
      ]
    }
  ]
}
```

Indexes should be sorted newest first.

Deployment record schema:

```json
{
  "schema": "cocalc-software-deployment-v1",
  "component": "hub",
  "profile_or_channel": "staging",
  "deployed_at": "2026-06-15T05:05:00.000Z",
  "artifact_id": "20260614T235912Z-e882d124-fix-bug",
  "tag": "fix-bug",
  "git": {
    "commit": "e882d124c7...",
    "short": "e882d124",
    "dirty": false
  },
  "deployed_by": {
    "user": "wstein",
    "host": "alpha",
    "account_id": "14a0013f-5cb5-45a0-9836-c94963076a87"
  },
  "target": {
    "kind": "rocket-bay",
    "profile": "staging",
    "api": "https://staging.cocalc.ai",
    "remote": "ubuntu@10.206.0.27",
    "bay_id": "bay-0"
  },
  "status": "succeeded",
  "duration_ms": 15417,
  "report": {
    "local_dir": "/home/user/cocalc-ai/tmp/bay-upgrade-20260615T041843Z",
    "remote_log_url": null
  }
}
```

Deployment indexes should be append-only from the operator point of view and
sorted newest first. R2 is the durable audit store because it survives bay VM
rebuilds, project-host replacement, and local `/tmp` cleanup. Site-local state
may cache the current deployment or write operational logs, but it must not be
the only deployment history source.

## Artifact Manifest Schema

Each local and remote artifact must have:

```json
{
  "schema": "cocalc-software-artifact-v1",
  "component": "hub",
  "artifact_id": "20260614T235912Z-e882d124-fix-bug",
  "tag": "fix-bug",
  "tag_generated": false,
  "created_at": "2026-06-14T23:59:12.000Z",
  "source": {
    "repo_root": "/home/user/cocalc-ai",
    "src_root": "/home/user/cocalc-ai/src",
    "branch": "lite4",
    "git_commit": "e882d124c7...",
    "git_short": "e882d124",
    "git_dirty": false,
    "git_status_porcelain": ""
  },
  "build": {
    "host": "alpha",
    "platform": "linux",
    "arch": "x64",
    "node": "v26.3.0",
    "command": "pnpm -C ...",
    "started_at": "2026-06-14T23:58:01.000Z",
    "finished_at": "2026-06-14T23:59:12.000Z",
    "duration_ms": 71000
  },
  "files": [
    {
      "name": "cocalc-bay-runtime-linux-x64.tar.xz",
      "path": "files/cocalc-bay-runtime-linux-x64.tar.xz",
      "content_type": "application/x-xz",
      "size_bytes": 48123456,
      "sha256": "..."
    }
  ],
  "embedded_manifests": [
    {
      "path": "files/bay-runtime-manifest.json",
      "kind": "cocalc-bay-runtime",
      "data": {}
    }
  ],
  "remote": {
    "store": "r2",
    "bucket": "cocalc-software",
    "base_url": "https://software.cocalc.ai",
    "prefix": "software/artifacts/hub/20260614T235912Z-e882d124-fix-bug"
  }
}
```

Manifest rules:

- All file hashes are sha256.
- File size is required.
- Store the exact command line used for the build.
- Include embedded package/Rocket/Star manifests when available.
- Never include secret environment variables.
- If a build used credentials only for upload, credentials must not appear in
  the build manifest.

## Configuration

Add a software config reader separate from, but compatible with, the current
Rocket config model.

Default lookup order:

1. `--config` if we decide to keep one global flag.
2. `COCALC_SOFTWARE_CONFIG`.
3. `~/.config/cocalc/software/config.yaml`.
4. `~/.config/cocalc/rocket/software.yaml`.
5. Built-in defaults plus `/run/secrets/cocalc/rocket-software-env.sh` if it
   exists and is readable.

Example config:

```yaml
local_store: /tmp/cocalc-software

artifact_store:
  kind: r2
  bucket: cocalc-software
  public_base_url: https://software.cocalc.ai
  env_file: /run/secrets/cocalc/rocket-software-env.sh
  prefix: software

profiles:
  staging:
    kind: rocket
    api: https://staging.cocalc.ai
    auth_profile: staging
    remote: ubuntu@10.206.0.27
  delta:
    kind: rocket
    api: https://delta.cocalc.ai
    auth_profile: delta
    remote: ubuntu@10.206.15.209
  prod:
    kind: rocket
    api: https://cocalc.ai
    auth_profile: default
    remote: ubuntu@10.206.0.38
```

Security checks:

- Secret env files must not be world-readable or world-writable.
- Parent directories must not be world-writable.
- CLI output must redact secret file values and secret environment keys.
- Do not require the operator shell to export R2 credentials.

Implementation detail:

- Parse dotenv-style `export KEY=value` and `KEY=value`.
- Merge config values into the child process environment only for R2 operations.
- Prefer explicit config values over env-file values for non-secret fields.

## Build Backend Mapping

### `static`

Build command:

```sh
cocalc rocket release build --kind bay-static --out-dir <tmp> --bundle <tmp>/files/cocalc-bay-static-linux-<arch>.tar.xz
```

Store:

- static tarball
- `bay-static-manifest.json`

### `hub`

Build command:

```sh
cocalc rocket release build --kind bay-runtime --out-dir <tmp> --bundle <tmp>/files/cocalc-bay-runtime-linux-<arch>.tar.xz
```

Store:

- bay runtime tarball
- `bay-runtime-manifest.json`

High-level `hub` currently maps to the wider Rocket bay runtime. This is
acceptable for the first implementation because deploy stays precise: `deploy
hub` should upgrade the bay runtime without project-host software upgrades.

### `project-host`

Preferred first implementation:

```sh
pnpm --filter @cocalc/project-host run build:bundle
```

Store:

- `packages/project-host/build/bundle-linux.tar.xz`
- build identity metadata if present

Push should upload into the new `software/artifacts/project-host/...` layout.
For compatibility with existing project-host bootstrap/upgrades, it may also
write the existing `software/project-host/latest-linux.json` or staging/latest
manifest only when explicitly deploying/promoting.

### `project`

Build command:

```sh
pnpm --filter @cocalc/project run build:bundle
```

Store:

- `packages/project/build/bundle-linux.tar.xz`

### `tools`

Build command:

```sh
pnpm --filter @cocalc/project run build:tools
```

Store:

- `packages/project/build/tools-linux-<arch>.tar.xz`

### `cli`

Build command:

```sh
pnpm --filter @cocalc/cli run sea
```

Store:

- SEA binary or compressed SEA artifact from `packages/cli/build/sea`
- install-site metadata if generated later

Push may initially delegate to `packages/cli/sea/publish-sea.sh`, but long-term
it should use the common manifest/index writer.

### `launchpad`

Build command:

```sh
pnpm --filter @cocalc/launchpad run sea
```

Store:

- launchpad SEA artifact from `packages/launchpad/build/sea`

### `plus`

Build command:

```sh
pnpm --filter @cocalc/plus run sea
```

Store:

- plus SEA artifact from `packages/plus/build/sea`

### `star`

Build command:

```sh
src/scripts/star/build-github-release-assets.sh <local-store-path>/files
```

Store:

- `install-cocalc-star.sh`
- `install-cocalc-star-local-lima.sh`
- `cocalc-star-runtime-linux-x64.tar.gz`
- `cocalc-star-runtime-linux-arm64.tar.gz`, when built
- Star release/channel manifests

Star push/deploy initially targets GitHub release assets, not R2, unless we
intentionally migrate Star installer distribution to R2.

## Push Semantics

`cocalc software push <component> <tag-or-id>`:

1. Load config and credentials.
2. Resolve the local artifact by exact tag or exact artifact id.
3. Fetch remote index for the component.
4. If tag already exists remotely, fail.
5. Upload each file and `.sha256`.
6. Upload immutable `manifest.json`.
7. Update `software/indexes/<component>.json` newest first.
8. Re-fetch the uploaded manifest and compare sha256/size for a read-after-write
   verification when practical.

Concurrency:

- R2 does not give us a simple compare-and-swap index update. In the first
  implementation, detect obvious tag conflicts before writing and keep the
  update operation short.
- Add an eventual follow-up to write index generations or use a small lock
  object if concurrent human operators become common.

## List Semantics

`cocalc software list <component>`:

Default output:

```text
component: hub

source  tag      artifact_id                         git       dirty  size   created
remote  fix-bug  20260614T235912Z-e882d124-fix-bug   e882d124  no     46M    2026-06-14T23:59:12Z
local   test1    20260614T232000Z-4545a130-test1     4545a130  yes    513M   2026-06-14T23:20:00Z
```

Rules:

- Merge local and remote rows.
- Sort newest first.
- Default limit: 10.
- Show at least: source, tag, artifact id, timestamp, git hash, dirty flag,
  total size, remote status.
- JSON output should include the full manifest summary.

Open question:

- Existing CLI convention supports global `--output json`. Keep using that
  instead of adding `software list --json`.

## Deploy Semantics

`cocalc software deploy <component> <tag-or-id> <profile-or-channel>`:

Common steps:

1. Resolve component.
2. Resolve artifact selector to exactly one local or remote manifest.
3. If only local, push it.
4. Verify remote manifest and file hashes.
5. Resolve target profile or Star channel.
6. Dispatch to the component-specific deploy backend.
7. Record a deploy report locally and, later, in a remote deploy log index.

### `deploy static`

Backend:

```sh
cocalc rocket deploy <profile> --scope static --bundle <downloaded-or-local-static-tarball> --yes
```

First implementation can download the remote artifact to `/tmp` and pass
`--bundle` to existing `rocket deploy`. Later, `rocket deploy` can learn to
consume an R2 URL directly.

### `deploy hub`

Backend:

```sh
cocalc rocket deploy <profile> --scope hub --bundle <downloaded-or-local-hub-tarball> --yes
```

This should not upgrade project hosts unless the operator deploys
`project-host`, `project`, or `tools`.

### `deploy bay`

Backend:

```sh
cocalc rocket deploy <profile> --scope bay --bundle <downloaded-or-local-runtime-tarball> --yes
```

This is the full bay runtime deploy escape hatch. It may update broader bay
runtime content than `hub`, but it still should not upgrade project hosts unless
the operator deploys `project-host`, `project`, `tools`, or uses a lower-level
full `rocket --scope all` workflow.

### `deploy bay-conat-router` and `deploy bay-conat-persist`

These refer to bay systemd services.

Initial backend:

- Resolve a `hub` artifact, because the bay/hub Conat router and persist code
  is shipped in the bay runtime.
- Stage/deploy the `hub` artifact to the bay if it is not already the current
  runtime.
- Restart only the requested bay shared service if the low-level Rocket script
  supports it.

Required lower-level work:

- Add a precise Rocket deploy/restart path for bay shared services that does
  not restart cloudflared and does not roll hub workers unnecessarily.
- Current `rocket deploy` has `--restart-shared-services`, which is too broad
  for a one-component deploy. Add a lower-level primitive before exposing these
  as high-level commands.

Do not use `cocalc host rollout --component conat-router` for
`bay-conat-router`; that is the project-host component.

### `deploy bay-frontdoor`, `deploy bay-cloudflared`, and `deploy bay-scaffold`

These are bay-side operational components and must not be confused with
project-host runtime rollouts.

Initial backend:

- `bay-frontdoor`: deploy the selected bay/hub runtime artifact if required,
  then restart or reload only `cocalc-bay-frontdoor.service`.
- `bay-cloudflared`: deploy the selected bay/hub runtime artifact if required,
  then restart only `cocalc-bay-cloudflared.service`.
- `bay-scaffold`: deploy systemd units/scripts/env templates and run
  `systemctl daemon-reload` without forcing a hub code rollout unless the
  artifact requires it.

Required lower-level work:

- Add precise Rocket primitives for these service/scaffold actions.
- Define artifact dependency rules for each component. For example,
  `bay-cloudflared` may depend on a full `bay` artifact rather than a `hub`
  artifact if helper scripts or unit files changed.
- Add health checks specific to each component before wiring high-level deploy.

### `deploy host-conat-router` and `deploy host-conat-persist`

These refer to project-host-local managed components.

Initial backend:

- Resolve a `project-host` artifact, because host Conat router/persist code is
  shipped in the project-host bundle.
- Ensure the selected project-host artifact is installed on the target hosts.
- Run project-host component rollout for only the requested component.

Required design decision:

- Decide whether high-level deploy should target all online hosts by default,
  or require a configured host selection policy. Emergency fleet upgrades argue
  for all-online by default in production profiles, but staging may need host
  subsets.

### `deploy project-host`

Backend:

```sh
cocalc --profile <profile> host upgrade --all-online --artifact project-host --artifact-version <version-or-artifact-id> --base-url https://software.cocalc.ai/software/artifacts/project-host/<artifact-id>/compat --wait
```

Compatibility issue:

- `host upgrade` currently expects the old software catalog shape. Either add a
  compatibility directory/manifest under the remote artifact, or extend host
  upgrade to consume `cocalc-software-artifact-v1` manifests directly.

First implementation recommendation:

- Extend `host upgrade` to accept a new `--manifest-url` internally, but keep
  the high-level `software deploy` free of flags.
- Until that exists, maintain compatibility latest/staging manifests during
  `software deploy project-host`.

### `deploy project`

Same as `project-host`, but target `project`.

### `deploy tools`

Same as `project-host`, but target `tools`.

### `deploy cli`, `deploy launchpad`, `deploy plus`

These should mean publish/promote, not deploy to a site profile.

First implementation:

- `build` creates local manifest and files.
- `push` uploads files to R2.
- `deploy` updates a public channel manifest for that product.

Third positional argument is a channel:

```sh
cocalc software deploy cli <tag-or-id> candidate
cocalc software deploy cli <tag-or-id> stable
cocalc software deploy launchpad <tag-or-id> candidate
cocalc software deploy plus <tag-or-id> candidate
```

Channel set:

- `stable`: default installer channel.
- `candidate`: public pre-release channel for real-machine testing.
- `dev`: optional fast-moving channel for internal tests.

The existing `latest-<os>-<arch>.json` files should become compatibility
aliases for the `stable` channel, not the primary model. Candidate/dev channel
manifests should be added for CLI/Launchpad/Plus even if the first
implementation still delegates uploading to the existing package-local publish
scripts.

### `deploy star`

Third positional argument is channel:

```sh
cocalc software deploy star <tag-or-id> candidate
cocalc software deploy star <tag-or-id> stable
cocalc software deploy star <tag-or-id> dev
```

Initial backend:

- Resolve local/remote Star artifact manifest.
- Ensure immutable GitHub release assets exist before mutating the channel.
- Run/wrap `promote-github-release-channel.sh --upload <release-id> <channel>`.
- Record channel promotion in durable R2 deployment history.

## Smoke Semantics

`cocalc software smoke <component> <profile-or-channel>` should initially be
best-effort and component-specific.

Suggested first smoke checks:

- `static`: fetch homepage, login/bootstrap API, and one static asset from the
  profile.
- `hub`: run `cocalc rocket health host-routes`, create a throwaway project,
  start it, open a terminal/Jupyter smoke file, then delete it.
- `project-host`: run `host get`, `host deploy status`, then start a throwaway
  project on each upgraded host or a representative sample.
- `project`: create/start a throwaway project and run a project daemon RPC.
- `tools`: create/start a throwaway project and verify tool availability such
  as Codex/ACP helper binary presence, depending on what `tools` contains.
- `cli`: download/install in a temp dir and run `cocalc --version`.
- `launchpad`: install/run in a temp temp dir or smoke the SEA with `--help`.
- `plus`: install/run `cocalc-plus --help` or existing Plus smoke when present.
- `star`: call `src/scripts/star/smoke-star.sh` for a local install, and later
  add a GCP disposable VM smoke for `candidate`.

Smoke tests should have explicit cleanup and should write reports under:

```text
/tmp/cocalc-software-smoke/<timestamp>-<component>-<profile>/
```

## Implementation Phases

### Current Implementation Status, 2026-06-15

Implemented:

- `build`, `list`, and `push` for immutable local/R2 artifacts.
- `build` for `static`, `hub`, `bay`, `project-host`, `project`, `tools`,
  `cli`, `launchpad`, `plus`, and `star`.
- `cli`, `launchpad`, and `plus` builds use the immutable software artifact id
  as the SEA version instead of treating `package.json` semver as the deploy
  identity. Star builds pass the same artifact id as `STAR_RELEASE_ID`.
- `deploy` for `static`, `hub`, and `bay` through the Rocket deploy path.
- `deploy` for `project-host`, `project`, and `tools` through
  `host upgrade --all-online --artifact-version ...`.
- `deploy` for `bay-conat-router`, `bay-conat-persist`, `bay-frontdoor`,
  `bay-cloudflared`, and `bay-scaffold` through precise Rocket bay deploy
  flags. These resolve a `bay` artifact and stage the full bay runtime, but
  restart only the requested bay service or install/daemon-reload only the
  scaffold instead of rolling hub workers.
- `deploy` for `host-conat-router` and `host-conat-persist` through the
  project-host software artifact path. These install the selected
  `project-host` artifact on online hosts, set only the requested host managed
  component desired version, and reconcile only that component.
- Compatibility publishing for `project-host`, `project`, and `tools` so
  existing host upgrade/install code can consume immutable software artifacts
  from old-shape URLs such as
  `software/project-host/<artifact-id>/bundle-linux.tar.xz`.
- `deploy`/promote for `cli`, `launchpad`, and `plus` release channels. These
  publish installer-facing channel manifests under
  `software/cocalc*/<channel>-<os>-<arch>.json`, with `stable` also updating
  legacy `latest-<os>-<arch>.json` aliases for existing installer defaults.
- CLI/Launchpad/Plus installers now prefer channel-manifest `artifact_id`
  identity over package semver and persist release metadata such as
  `published_at` and git hash for local inspection/version output.
- R2 deployment history for implemented deploy paths, with a started record
  written before the target is mutated and a sealed `succeeded` or `failed`
  record written after completion. Unsealed `started` records display as
  `unknown` in `software history`.
- First `smoke` slice for `static`, `hub`, and `bay`. Static smoke fetches the
  homepage, `/static/app.html`, `/webapp/favicon.ico`, and
  `/api/v2/auth/bootstrap`. Hub/bay smoke additionally runs
  `cocalc rocket health host-routes` using the selected auth profile.
- Representative-host `smoke` slice for `project-host`, `project`, and
  `tools`. These select a running host, validate `host deploy status` observed
  artifact/component state, and run a routed `host rootfs` RPC against that
  host.
- Release-channel `smoke` slice for `cli`, `launchpad`, and `plus`. These
  fetch the public channel manifest for the current OS/architecture, download
  the referenced artifact, verify sha256, materialize the temporary executable,
  and run `--version` with release metadata injected.
- `deploy`/promote for `star` release channels. This resolves the Star
  artifact from the software store, verifies the immutable GitHub release
  exists with `gh release view`, promotes the GitHub channel release with
  `promote-github-release-channel.sh --upload`, and records the promotion in R2
  deployment history.
- Initial `smoke` slice for `star`. This validates the requested release
  channel and runs `src/scripts/star/smoke-star.sh` with
  `COCALC_STAR_CHANNEL`/`COCALC_STAR_RELEASE_CHANNEL` set, so the current local
  Star smoke workflow is available through the common software command.
- `latest` as a reserved selector that resolves to the newest local or remote
  artifact for a component.
- Human-readable build/deploy durations and artifact sizes.
- Fast hub/static build paths that avoid rebuilding unrelated static/runtime
  content.

Still not implemented:

- Deeper throwaway project lifecycle `smoke` coverage for `project-host`,
  `project`, and `tools`, plus disposable VM install smoke coverage for `star`.
- Product/documentation updates for the new CLI channel model, including a
  dedicated `/products/cocalc-cli` page and channel notes on public installer
  pages.
- Coordinated Plus/tools-minimal channel promotion. Today `plus` channel
  promotion updates the Plus binary manifest only; the installer still resolves
  `tools-minimal` from its own channel manifest.
- Rollback wrappers.

### Phase 0: Documentation And Test Fixtures

- Add this plan.
- Add sample manifests under CLI tests.
- Add a small fake local store and fake remote index fixture.
- Define TypeScript types for component names, artifact id, manifests, and
  indexes.

### Phase 1: Local Manifest Builder And `list`

Files to add:

- `src/packages/cli/src/bin/commands/software.ts`
- `src/packages/cli/src/bin/commands/software.test.ts`
- `src/packages/cli/src/bin/core/software/artifact-id.ts`
- `src/packages/cli/src/bin/core/software/manifest.ts`
- `src/packages/cli/src/bin/core/software/local-store.ts`
- `src/packages/cli/src/bin/core/software/config.ts`

Wire into:

- `src/packages/cli/src/bin/main.ts`

Implement:

- component parsing
- tag validation
- generated tag selection
- artifact id generation
- git metadata collection
- local store scanning
- local `software list`
- remote index fetch in read-only mode if credentials/public URL are available

Validation:

- unit tests for selector resolution
- unit tests for tag conflict detection
- unit tests for list sorting and source merging

### Phase 2: Build For `static`, `hub`, `bay`, `project-host`, `project`, `tools`

Implement command wrappers that call existing build tools and copy outputs into
the local store.

Do not upload in this phase.

Validation:

- dry-run/unit tests should assert command plans.
- one manual build into `/tmp` for each component.
- manifest should show exact file sizes and sha256.

### Phase 3: R2 Store And `push`

Files to add:

- `src/packages/cli/src/bin/core/software/r2-store.ts`
- optionally extract reusable code from `src/packages/cloud/scripts/publish-r2.js`
  into a TypeScript module instead of shelling to the script.

Implement:

- config/env-file loading
- credential permission checks
- upload files and sha256 sidecars
- upload immutable manifest
- update remote component index
- remote tag conflict checks

Validation:

- unit tests with mocked R2 functions.
- manual push to a test prefix, not production prefix.
- verify public URLs resolve through `https://software.cocalc.ai`.

### Phase 4: Deploy `static` And `hub`

Implement profile resolution and dispatch to existing `rocket deploy`.

Required profile fields:

- `api`
- `remote`
- `auth_profile` or cookie-compatible auth
- optional `public_url`
- optional `bay_id`
- optional deploy report dir

Deploy flow:

- resolve artifact
- push if local-only
- download remote artifact to `/tmp/cocalc-software-deploy/...` if not already
  present locally
- call `rocket deploy --scope static|hub|bay --bundle ... --yes`
- write deploy report

Validation:

- deploy `static` to staging from an immutable artifact.
- deploy `hub` to staging from an immutable artifact.
- deploy `bay` to staging from an immutable artifact.
- confirm a second deploy to delta/prod uses the bitwise identical artifact.

### Phase 5: Deploy `project-host`, `project`, `tools`

Implement compatibility with host upgrade.

Preferred backend work:

- Extend host upgrade/control-plane software catalog to accept a manifest URL or
  artifact manifest directly.
- If that is too much for the first slice, generate an old-style compatible
  `latest/staging` manifest in a temporary channel and call `host upgrade`
  against that channel/base URL.

Deploy flow:

- resolve artifact
- push if needed
- call host upgrade for all online hosts with explicit artifact version or
  manifest URL
- wait for LRO completion
- show per-host summary

Validation:

- deploy project-host to staging.
- deploy project/tools to staging.
- check `host deploy status` before and after.

### Phase 6: Hub And Host Conat Components

Add or expose a low-level Rocket primitive that can:

- stage a hub/bay-runtime artifact if needed
- restart only bay-conat-router or bay-conat-persist
- avoid restarting cloudflared unless explicitly requested elsewhere
- avoid accidentally using project-host-local `host rollout` for hub services

Then wire:

```sh
cocalc software deploy bay-conat-router <hub-tag-or-id> <profile>
cocalc software deploy bay-conat-persist <hub-tag-or-id> <profile>
```

Also add bay-side service/scaffold component support:

```sh
cocalc software deploy bay-frontdoor <hub-or-bay-tag-or-id> <profile>
cocalc software deploy bay-cloudflared <hub-or-bay-tag-or-id> <profile>
cocalc software deploy bay-scaffold <bay-tag-or-id> <profile>
```

Add host-side component wiring separately:

```sh
cocalc software deploy host-conat-router <project-host-tag-or-id> <profile>
cocalc software deploy host-conat-persist <project-host-tag-or-id> <profile>
```

Validation:

- staging only first.
- verify Cloudflare tunnel does not restart.
- verify hub workers and static serving remain available.
- verify `rocket health host-routes` after restart.

### Phase 7: CLI, Launchpad, Plus

Wrap existing SEA build/publish scripts.

Short-term:

- use package scripts for build. Done.
- use common manifest/index for local/remote visibility. Done.
- add `stable`, `candidate`, and optional `dev` channel manifests. Done for
  CLI/Launchpad/Plus.
- keep existing `latest-<os>-<arch>.json` as stable compatibility aliases.
  Done for CLI/Launchpad/Plus.
- use existing publish script behavior only as a compatibility layer while the
  common software store is being introduced. Mostly superseded by common
  channel manifest promotion; package-local publish scripts still exist for
  manual/legacy publishing.

Long-term:

- move package-local R2 publishing to the common software store.
- make all installer docs and scripts consume channel manifests, not ad hoc
  latest files.

Validation:

- install CLI from public URL in a clean temp dir.
- run `cocalc --version`.
- smoke Launchpad/Plus SEA with `--help` or a minimal start command.

### Phase 8: Star

Wrap the GitHub release asset workflow first.

Implement:

- local Star manifest from `build-github-release-assets.sh`
- `software deploy star <tag> candidate|stable|dev`
- `software smoke star candidate`

Do not silently move Star to R2. If/when Star moves to R2, that should be a
separate deliberate installer change.

Validation:

- candidate channel update.
- local Star smoke through `software smoke star candidate`.
- GCP disposable VM smoke install.
- manual promotion from candidate to stable after testing.

### Phase 9: Deployment History And Rollback Ergonomics

Add:

- `software history <component> <profile-or-channel> [--limit <n>]`.
- immutable deployment records under
  `software/deployments/<profile-or-channel>/<component>/...`.
- mutable deployment indexes under
  `software/deployments/<profile-or-channel>/<component>/index.json`.
- rollback-by-artifact id wrappers for the components where rollback is safe.

`history` output should be similar to `software list`, but it answers a
different question: what exact artifact was deployed to this bay, host fleet, or
channel, when did it happen, who initiated it, and did it succeed?

Suggested columns:

```text
deployed_at
component
profile_or_channel
artifact_id
tag
git
dirty
deployed_by
target
status
duration
```

R2 is the authoritative history store. This differs from Kubernetes, where
cluster state naturally lives in etcd. Rocket bays and project hosts are meant
to be rebuildable, so the deployment history must live outside the bay/host
that is being changed. The bay database, `/mnt/cocalc/bays/<bay>/state`, and
local report directories can still store operational details, but they are
secondary evidence, not the durable audit log.

This is intentionally not part of the first cut, but the plan should not be
considered complete until deployment history exists for every deploy/promote
component.

## Failure Modes To Handle Explicitly

- Tag exists locally.
- Tag exists remotely.
- Selector is ambiguous.
- Selector does not exist.
- Local artifact manifest exists but files are missing.
- Remote index exists but manifest fetch fails.
- Manifest sha256 does not match uploaded file.
- Deployment record upload succeeds but deployment index update fails.
- Deployment history index exists but a referenced deployment record is missing.
- Dirty repo build.
- Build command succeeds but expected output file missing.
- R2 credentials missing or insecurely stored.
- Profile name does not exist.
- Profile auth is missing or not cookie-compatible.
- Deploy target is Star but third positional argument is not a valid channel.
- Deploy target is non-Star but third positional argument is not a configured
  profile.
- `bay-conat-router`/`bay-conat-persist` requested before the low-level precise
  bay restart primitive exists.
- `host-conat-router`/`host-conat-persist` requested without a configured host
  selection policy, if the implementation chooses not to default to all-online.

## Suggested Human Output

Build success:

```text
Built software artifact
component: hub
tag: fix-bug
tag_source: explicit
artifact_id: 20260614T235912Z-e882d124-fix-bug
git: e882d124 clean
local: /tmp/cocalc-software/hub/20260614T235912Z-e882d124-fix-bug

files:
  cocalc-bay-hub-linux-x64.tar.xz  20M  sha256:...
```

Build success with generated tag:

```text
Built software artifact
component: hub
tag: 20260614T2359Z
tag_source: generated
artifact_id: 20260614T235912Z-e882d124-20260614T2359Z
git: e882d124 clean
local: /tmp/cocalc-software/hub/20260614T235912Z-e882d124-20260614T2359Z

Next:
  cocalc software push hub 20260614T2359Z
  cocalc software deploy hub 20260614T2359Z staging
```

Push success:

```text
Pushed software artifact
component: hub
artifact_id: 20260614T235912Z-e882d124-fix-bug
remote_manifest: https://software.cocalc.ai/software/artifacts/hub/.../manifest.json
index: https://software.cocalc.ai/software/indexes/hub.json
```

Deploy success:

```text
Deployed software artifact
component: hub
profile: staging
artifact_id: 20260614T235912Z-e882d124-fix-bug
source: remote
report: /tmp/cocalc-software-deploy/...
```

## Initial Manual Acceptance Scenario

The first useful end-to-end scenario should be:

```sh
cocalc software build hub fix-bug
cocalc software push hub fix-bug
cocalc software list hub
cocalc software deploy hub fix-bug staging
cocalc software smoke hub staging
cocalc software deploy hub fix-bug prod
cocalc software smoke hub prod
```

For routine unnamed builds, the operator can omit the tag and use the generated
tag printed in the build summary for subsequent `push` and `deploy` commands.

This replaces the current manual pattern:

```sh
cocalc rocket release build --kind bay-runtime ...
cocalc rocket deploy --scope bay --remote ... --api ... --bundle ... --yes
```

The key correctness property is that `staging` and `prod` deploy the same
sha256-identical artifact.

## Open Questions

- Should `deploy` auto-push local-only artifacts, or should it fail and ask the
  operator to run `push`? Current preference: auto-push is acceptable for
  `deploy`, but `build` must not push. (ANS: auto-push for deploy).
- Should `software list` default to merged local+remote, or show remote first
  and local-only rows separately? Current preference: merged with `source`.
- Should CLI/Launchpad/Plus channel manifests be written only by
  `cocalc software deploy`, or should package-local publish scripts learn the
  same channel model directly? Current preference: put channel behavior in
  `cocalc software` first, then simplify package-local scripts later.
- Should R2 indexes have optimistic generation numbers to prevent concurrent
  updates? Current preference: not in first cut, but design schema so it can be
  added.
- Should high-level `project-host` deploy upgrade all online hosts by default,
  or require a configured host selection policy per profile? Current user goal
  suggests all online for production lifecycle, but staging may want explicit
  host subsets.

## Non-Goals For First Implementation

- Do not delete or replace `cocalc rocket deploy`.
- Do not remove package-local publish scripts.
- Do not migrate Star from GitHub releases to R2.
- Do not implement rollback in the first cut.
- Do not implement a full lock service for R2 indexes.
- Do not make every smoke test comprehensive before exposing the build/list/push
  workflow.
