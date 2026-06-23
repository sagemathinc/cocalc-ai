# RootFS Build LRO Plan

Date: 2026-06-22

Status: design plan

## Summary

Re-architect `cocalc rootfs build <recipe>` as a durable long-running
operation instead of a CLI-held stream.

The current rootfs recipe/build workflow is valuable, but it is too fragile for
long builds such as SageMath, Overleaf, RStudio, and scientific stacks. A
client connection should not be the thing keeping a build observable or alive.
The build should run as a managed project-host operation, with durable logs and
structured state stored in the builder project, and with an LRO summary exposed
through the hub/control plane.

This is similar to Docker BuildKit and GitHub Actions in spirit, but it is not
the same product:

- the build environment is a normal live CoCalc project,
- users and agents can open that project while the build is running,
- snapshots and restores are available while iterating,
- the build output is a RootFS image/catalog entry rather than a container
  layer graph,
- debugging can happen directly in the mutable builder project.

That live-project property is the main advantage. The LRO should make it
reliable instead of hiding it behind one fragile terminal stream.

## Goals

- Make `cocalc rootfs build <recipe>` survive CLI disconnects, browser refresh,
  agent restarts, SSH disconnects, and transient hub restarts.
- Persist enough build state that a human or coding agent can understand,
  resume, debug, or publish after the fact.
- Store logs in the builder project and stream them through LRO events while
  attached.
- Keep the project-host as the data-plane executor. The hub should authorize,
  route, summarize, and coordinate, not proxy long-running build IO.
- Make builder projects useful debugging environments:
  - terminals,
  - file browser,
  - snapshots,
  - Codex,
  - direct inspection of generated scripts and logs.
- Preserve recipe transparency:
  - store the resolved recipe,
  - store the generated runnable shell script,
  - store resolved inputs and contribution metadata.
- Support later automation around snapshots, verification, publish, and
  official-image promotion.

## Non-Goals

- Do not build a full CI/CD product in the first pass.
- Do not require all recipe execution to go through this LRO path.
  `cocalc rootfs recipe run <recipe> --here` should remain a direct local
  mutation command.
- Do not make files in the builder project the source of truth for published
  catalog metadata. Files are portable artifacts and debugging aids; publish
  still writes authoritative catalog state through the existing RootFS publish
  APIs.
- Do not route build stdout/stderr continuously through the hub as the durable
  storage path.
- Do not make recipe execution depend on a browser tab or terminal staying
  open.

## Command UX

### Start And Attach

```sh
cocalc rootfs build cocalc/sagemath
```

Default behavior:

- create or reuse a clean builder project,
- resolve the recipe and inputs,
- create a build record and LRO,
- start the project-host build worker,
- print identifying information immediately,
- attach to log streaming while the CLI remains open.

Example initial output:

```text
[rootfs build] build_id=rb_01K...
[rootfs build] project_id=...
[rootfs build] op_id=...
[rootfs build] log=.cocalc/rootfs-builds/rb_01K.../build.log
[rootfs build] script=.cocalc/rootfs-builds/rb_01K.../run.sh
[rootfs build] open: cocalc project open ...
```

The CLI should keep streaming logs, but the build must continue if the CLI
exits.

### Detach

```sh
cocalc rootfs build cocalc/sagemath --detach
```

Starts the build and prints the identifiers without following logs.

### Reattach

```sh
cocalc rootfs build attach <build-id>
cocalc rootfs build logs <build-id> --follow
```

These commands should:

- print the current summary,
- replay recent log tail by default,
- follow new logs if requested,
- continue working after the original CLI process is gone.

### Status

```sh
cocalc rootfs build status <build-id>
cocalc rootfs build list
```

Status should include:

- build id,
- LRO id,
- account id,
- project id,
- project host id,
- host disk type if known,
- recipe id/path,
- current phase,
- current step,
- status,
- elapsed time,
- last output time,
- log path,
- generated script path,
- contribution metadata path,
- verification status,
- publish status if publish was requested.

### Cancel

```sh
cocalc rootfs build cancel <build-id>
```

Cancellation should:

- signal the managed process group on the project host,
- mark status as canceling/canceled,
- flush final log/status files,
- leave the builder project intact for inspection.

### Publish

Two modes should be supported.

```sh
cocalc rootfs build cocalc/sagemath --publish
cocalc rootfs build publish <build-id>
```

The first starts publish automatically after verification. The second publishes
an already-built project. In both cases, RootFS publish remains its own LRO
internally; the build LRO should either chain to it or record the child
`publish_op_id`.

## Relationship To Existing Commands

### `rootfs recipe run --here`

This should stay a direct local subprocess mode.

Use case:

- mutate the current project in place,
- lightweight experimentation,
- agent installs something quickly,
- no remote project creation.

It may later gain `--lro`, but the default should remain simple and direct.

### `rootfs recipe run` Without `--here`

This is currently close to `rootfs build` but not durable enough. We should
either:

- make it a thin compatibility alias for `rootfs build`, or
- reserve it for lower-level recipe execution and teach users to use
  `rootfs build` for durable builder workflows.

The product-facing command should be `rootfs build`.

## Control-Plane Shape

The build is owned by the project owning bay. Launchpad is the one-bay special
case.

High-level routing:

1. CLI/browser calls the home bay.
2. Home bay resolves account/project ownership.
3. Owning bay creates or selects a builder project.
4. Owning bay starts the build LRO and routes to the assigned project host.
5. Project host runs the build and appends project-local logs/artifacts.
6. Project host emits structured progress back to the owning bay.
7. Owning bay stores durable LRO summary/progress.
8. Browser/CLI follows LRO events and/or reads project-local logs.

The hub should not carry the steady-state build log as the only durable stream.
The project-host should write local project files first, then publish compact
events and status summaries.

## Data Model

Use the existing LRO model for user-visible operation status, but add a
RootFS-build-specific record if the current LRO tables are not enough for
listing, restart recovery, or build history.

Suggested `rootfs_builds` fields:

- `build_id`
- `op_id`
- `account_id`
- `project_id`
- `owning_bay_id`
- `host_id`
- `recipe_ref`
- `recipe_hash`
- `status`
- `phase`
- `current_step`
- `current_step_index`
- `current_step_count`
- `created_at`
- `started_at`
- `last_output_at`
- `finished_at`
- `exit_code`
- `error`
- `log_path`
- `status_path`
- `events_path`
- `script_path`
- `recipe_path`
- `metadata_path`
- `verify_path`
- `publish_op_id`
- `publish_image_id`

The build record is control-plane metadata. The detailed logs and generated
files live in the builder project.

## Project Artifact Layout

Every durable build should create a self-contained directory:

```text
.cocalc/rootfs-builds/<build-id>/
  build.log
  events.ndjson
  status.json
  recipe.json | recipe.yaml
  resolved-recipe.json
  run.sh
  env.json
  metadata.json
  verify.log
  publish.json
  snapshots.json
```

Important files:

- `build.log`: stdout/stderr with step prefixes and timestamps.
- `events.ndjson`: structured events for agents/tools.
- `status.json`: latest compact status, overwritten atomically.
- `run.sh`: fully runnable dry-run/resolved shell script.
- `metadata.json`: RootFS catalog contribution metadata from recipe modules.
- `verify.log`: verification command output.
- `publish.json`: publish result or child publish LRO summary.

The files should be ordinary project files so users and agents can inspect,
copy, diff, and edit them.

## Project-Host Build Runner

The project-host needs a managed build runner distinct from one-shot `execCode`.

Required behavior:

- starts a subprocess/process group in the project environment,
- survives the client disconnecting,
- appends stdout/stderr to `build.log`,
- writes structured events to `events.ndjson`,
- updates `status.json` atomically,
- reports compact progress to the hub LRO stream,
- tracks PID/process group for cancellation,
- enforces optional timeouts but has no default short timeout for long builds,
- emits heartbeats even when the subprocess is quiet,
- records last output time separately from elapsed time,
- handles project stop/restart gracefully,
- can report "build process missing" after host crash or project restart.

Avoid using `execCode` as the durable execution primitive. It is fine for short
commands, but a Sage build should not depend on a single RPC call staying open.

## Recipe Resolution Strategy

There are two viable implementation stages.

### Stage 1: CLI Resolves, Host Executes

The CLI resolves:

- recipe source,
- built-in module files,
- inputs,
- generated shell script,
- contribution metadata.

Then it uploads these artifacts into the builder project and asks the host to
execute `run.sh` as a managed build.

Advantages:

- fastest path from current implementation,
- reuses existing CLI recipe resolver,
- makes the generated script visible immediately.

Limitations:

- browser-only build start is awkward,
- different CLI versions can resolve recipes differently.

### Stage 2: Shared Resolver Package

Move recipe resolution into shared code usable by CLI, hub, and project-host.

Advantages:

- browser UI can start builds without a local CLI,
- server-side policy can validate recipe provenance and inputs,
- one resolver path for SEA/tools/hub.

This should be the target architecture, but Stage 1 is acceptable if we store
the generated script and recipe hash so builds remain auditable.

## Logging And Events

Do both:

- append full logs to project files,
- publish compact LRO events for live clients.

Event examples:

```json
{"type":"started","time":"...","build_id":"...","project_id":"..."}
{"type":"step_started","time":"...","index":1,"name":"cocalc/sagemath"}
{"type":"output","time":"...","stream":"stdout","bytes":8192}
{"type":"heartbeat","time":"...","elapsed_s":3600,"last_output_s":120}
{"type":"step_finished","time":"...","index":1,"exit_code":0}
{"type":"verify_started","time":"..."}
{"type":"publish_started","time":"...","publish_op_id":"..."}
{"type":"finished","time":"...","status":"succeeded"}
```

The LRO stream should not attempt to store every log line forever. It should
store enough recent detail for UI and CLI attachment, while the project log file
is the durable full log.

## Snapshots

Snapshots are a natural foundation for this workflow.

Possible options:

```sh
cocalc rootfs build cocalc/sagemath --snapshot-before
cocalc rootfs build cocalc/sagemath --snapshot-after-step
cocalc rootfs build cocalc/sagemath --snapshot-on-failure
```

Initial defaults:

- snapshot before build if project is not newly created,
- snapshot after successful verify,
- snapshot on failure for long builds if disk budget allows.

The build status should record snapshot ids in `snapshots.json`.

This makes iterative recipe development much less risky. A user can restore the
builder project rootfs to a pre-build or pre-step state and rerun only the
broken portion manually.

## Publish Integration

RootFS publish already runs as an LRO. Build should not duplicate that logic.

Instead:

- build LRO verifies the project,
- build LRO records contribution metadata,
- `--publish` starts the existing publish LRO,
- build status records `publish_op_id`,
- final build summary embeds the publish summary.

Publish summary should include the operational details that helped diagnose the
slow Overleaf publish:

- project id,
- host id,
- host disk type,
- source tree size if known,
- uploaded bytes,
- elapsed publish time,
- approximate throughput,
- rustic snapshot id,
- RootFS image id/slug.

## Security And Permissions

Recipe builds run arbitrary shell in a project. That is already true for a user
with terminal access, but the orchestration adds product surface area.

Rules:

- building in a user-owned builder project should not require fresh auth,
- publishing public/official images should keep current fresh-auth/admin rules,
- recipes should record provenance and hash,
- generated scripts should be stored before execution,
- environment variables should be captured with secret redaction,
- logs should avoid echoing known secret values,
- cancellation should kill the process group, not merely the parent shell,
- project-host build service should require project-scoped authorization.

Do not run build output/log streaming through the hub as project data-plane
traffic. Store logs in the project and expose them through project-host/file
access.

## Scheduling, Quotas, And Concurrency

RootFS builds can be huge and expensive.

Build start should validate:

- project disk quota,
- host free space,
- requested disk quota,
- recipe recommended quota,
- host disk type,
- host CPU/memory,
- per-account concurrent build limit,
- per-host concurrent build limit.

Status should make resource choices visible:

- builder host,
- disk type,
- quota,
- current disk usage if cheaply available.

For long source builds, prefer hosts with balanced/SSD disks. Avoid scheduling
official/public recipe builds on slow HDD project hosts.

## UI Opportunities

Once the LRO backend exists, several UI surfaces become straightforward:

- RootFS build history in the builder project.
- "Open build log" from CLI output or RootFS UI.
- "Import metadata from project file" for `metadata.json`.
- "Publish this build" button after verify succeeds.
- "Restore to pre-build snapshot" button on failed builds.
- Official recipe build dashboard for admins.
- Recipe catalog smoke-test dashboard.

The UI should treat the builder project as the debugging environment, not hide
it.

## Agent Workflow

This is especially useful for coding agents.

An agent should be able to:

1. run `cocalc rootfs build cocalc/r --detach`,
2. inspect `.cocalc/rootfs-builds/<id>/run.sh`,
3. tail logs after reconnecting,
4. open the live builder project,
5. patch and rerun a failed command manually,
6. update the recipe,
7. rerun from a clean snapshot,
8. publish after verification.

The saved `run.sh`, `events.ndjson`, and `status.json` make the build
explainable without scraping terminal history.

## Implementation Phases

### Phase 0: Stabilize Recipes

- Continue hardening recipes against real base images, not empty Ubuntu.
- Add recipe dry-run script generation coverage.
- Add composability tests for `/usr/local/bin/python` symlink baselines.
- Ensure built-in recipes are regenerated during CLI/SEA/tools builds.

### Phase 1: Durable Project-Local Build Runner

- Add project-host build runner service.
- Accept a build directory and generated `run.sh`.
- Run script as a managed process group.
- Persist logs/status/events under `.cocalc/rootfs-builds/<build-id>/`.
- Add cancel/status/log-tail host APIs.
- Implement CLI `rootfs build --project <id> --from-script <path>` style
  internal path for early testing.

### Phase 2: Build LRO

- Add hub API to start a RootFS build LRO.
- Route start/status/cancel to the owning bay and assigned project host.
- Store build summary in LRO and optional `rootfs_builds` table.
- CLI starts build, attaches to log stream, and can reattach later.

### Phase 3: Recipe-Oriented Build Command

- Wire `cocalc rootfs build <recipe>` to:
  - resolve recipe,
  - create/reuse builder project,
  - upload artifacts,
  - start project-host build runner,
  - follow LRO/logs.
- Add `build status`, `build logs`, `build attach`, `build cancel`,
  `build list`.

### Phase 4: Verification And Publish

- Run top-level verify commands as build phases.
- Store `verify.log`.
- Add `build publish <build-id>`.
- Support `--publish` chaining to existing RootFS publish LRO.
- Capture publish throughput and host details in summary.

### Phase 5: Snapshots And Recovery

- Add snapshot-before and snapshot-on-failure options.
- Record snapshot ids.
- Add CLI/UI restore hints.
- Add "rerun from snapshot" flow.

### Phase 6: UI And Admin Workflows

- Build history panel.
- Metadata import from project file.
- Official recipe build dashboard.
- Scheduled smoke builds for core recipes.
- Promotion workflow for official RootFS images.

## Testing Plan

Unit tests:

- command parsing,
- recipe resolution artifact generation,
- status file atomic writes,
- event log append,
- cancellation process group behavior,
- LRO summary serialization,
- reconnect/reattach behavior.

Integration tests:

- start build, disconnect CLI, confirm process continues,
- reattach logs,
- cancel build,
- project-host restart detection,
- project stop during build,
- failed build preserves logs/status,
- successful verify records metadata.

Live smoke recipes:

- `cocalc/uv-python`,
- `cocalc/r`,
- `cocalc/quarto`,
- `cocalc/lean`,
- `cocalc/overleaf`,
- `cocalc/sagemath`.

Special regression cases:

- base image where `/usr/local/bin/python` is a symlink,
- no-output build phase lasting more than 30 minutes,
- host with slow disk,
- disk quota nearly full,
- CLI disconnect/reconnect,
- browser refresh while watching build.

## Acceptance Criteria

The first production-worthy version should satisfy:

- A SageMath source build can run for hours after the CLI disconnects.
- A user can reattach and see current status plus recent logs.
- Full logs and generated script are visible in the builder project.
- Failed builds preserve enough state for an agent to diagnose the failure.
- Successful builds write metadata and verify output.
- Publish can be started from the build result.
- Publish summaries include host id, disk type, elapsed time, and throughput.
- No build requires a browser tab or terminal stream to remain open.

## Open Questions

- Should `rootfs recipe run` without `--here` become an alias for
  `rootfs build`, or remain a lower-level command? (ANS: stay lower level)
- How much build history should remain in the control-plane database versus
  only in project files? (ANS: not too much, because we don't want to waste space/overload the database.)
- What is the default builder project retention policy?  (ANS: not sure -- you mean until the project is deleted or ?)
- Should official recipe builds always use dedicated high-performance hosts?  (ANS: no; this is a great use for spare capacity.)
- Should build projects have a special project type or tag?  (ANS: definitely yes.  We don't have any notion of that yet, but already I really wish they were not shown in my normal listing. The only similar thing we have right now is "hidden" projects that are used mainly for courses. We need a general notion of project tags though, and hidden would then just be a special case. That shouldn't be part of this proposal -- it's out of scope.)
- Should snapshots be on by default for all non-new builder projects? (ANS: probably not; snapshots will be useful for some purposes - e.g., debugging - but often they won't be at all.)
- How should `last_changed`/filesystem generation metadata feed build exposure
  and backup decisions without polluting user-facing `last_edited`?   (ANS: not sure; somewhat orthogonal to this particular project.)
- How do we make browser-started builds use the same recipe resolver as CLI
  without duplicating code? (ANS: is browser started using "--here"?  maybe refactor the code into src/packages/util and include it in both the cli and project-host?)

