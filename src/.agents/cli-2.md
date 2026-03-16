# CLI Follow-Up Plan

## Goal

Make the `cocalc` CLI reliable enough to drive the full Codex/chat move-delete
smoke scenario end-to-end on fresh hosts, without needing manual UI fallback.

Target workflow:

- create two fresh hosts
- create a project on the source host
- create/configure a `.chat` thread
- configure loop and automation
- run automation / Codex turns
- move the project to the target host
- verify post-move state
- delete the moved project and verify cleanup

## Current Status

What works:

- live host admin commands via:
  - `cd src && eval "$(pnpm -s dev:env:hub)"`
  - `env -u COCALC_ACCOUNT_ID ./packages/cli/dist/bin/cocalc.js --hub-password "$COCALC_HUB_PASSWORD" ...`
- host create / get / upgrade
- project create / get / start / move / delete
- `project exec`
- `project codex exec`
- `project chat` commands with project-relative paths such as `move-smoke.chat`
- raw `.chat` row parsing/writing in:
  - [project-chat.ts](/home/wstein/build/cocalc-lite4/src/packages/cli/src/bin/core/project-chat.ts)

What is not reliable enough yet:

- fresh-host bootstrap consistency
- `project file ...` commands on fresh hosts
- `project chat ...` commands when they depend on the routed file-system subject
- full move/delete smoke driven entirely from the CLI

## Findings So Far

### 1. Admin/live env is easy to get wrong

For live host/project control-plane work, the shell must be refreshed with:

```bash
cd src
eval "$(pnpm -s dev:env:hub)"
```

Then admin-style host control should explicitly drop any stale account binding:

```bash
env -u COCALC_ACCOUNT_ID ./packages/cli/dist/bin/cocalc.js --hub-password "$COCALC_HUB_PASSWORD" ...
```

This should probably be codified better in docs and perhaps made easier in the
CLI itself.

### 2. Fresh hosts exposed a bootstrap/runtime inconsistency

On brand-new GCP hosts, project-host bundles were present on disk but the host
did not initially come online cleanly. There was also confusion around host
Node availability and PATH/runtime assumptions.

Even though the live daemon ended up running from the expected NVM-managed Node,
fresh-host bring-up needs its own audit and smoke coverage.

This is tracked separately from the chat CLI, but it directly affected these
tests.

### 3. Project-relative vs UI-style paths are easy to confuse

The CLI currently expects project-relative paths like:

- `move-smoke.chat`

not UI-style paths like:

- `root/move-smoke.chat`

This mismatch caused false negatives during testing and needs to be handled
better by the CLI.

### 4. Routed `fs.project-*` is the main fresh-host CLI weakness we hit

On the fresh hosts, UI file browsing worked, and `project exec` worked, but
CLI operations that depended on the routed file-system subject could fail or
time out, e.g.:

- `project file list`
- `project file cat`
- `project chat ...` when reading/writing `.chat` files through that path

Observed failure mode:

- `timeout - Error: operation has timed out subject:fs.project-<project_id>`

This strongly suggests the underlying project file server is not broken; the
problem is in the CLI/routed file-system path.

### 5. `project chat` is better than it was, but still not robust enough

The old SyncDB-based path was replaced with direct JSONL row reads/writes in:

- [project-chat.ts](/home/wstein/build/cocalc-lite4/src/packages/cli/src/bin/core/project-chat.ts)

That made the implementation much simpler and avoided the earlier SyncDB hang.
However, it still depends on the same routed file-system transport.

## Plan

### Phase 1: Make path handling explicit and hard to misuse

1. Accept or normalize `root/...` input for CLI chat/file commands.
2. Document clearly that project-relative paths are the CLI canonical form.
3. Add tests for the path normalization behavior.

Desired result:

- users can paste a path they copied from the UI and the CLI does the right
  thing or fails with a precise, actionable error

### Phase 2: Stop depending on the fragile routed file path for chat metadata

For `project chat thread create|status`, `loop set|clear`, and similar metadata
operations, prefer a more reliable transport than `fs.project-*`.

Most promising direction:

- read/write `.chat` files via `project exec` / project API, not routed file
  RPC

Why:

- `project exec` worked on the same fresh hosts where routed file RPC timed out
- `.chat` files are simple newline-delimited JSON, so direct read/write is
  tractable
- this isolates `project chat` from a separate CLI/file-transport bug

Constraints:

- keep writes atomic enough for normal CLI use
- preserve unknown rows
- only replace the relevant `chat-thread-config` row(s)

### Phase 3: Decide what to do about `project file`

We need a focused pass on the general file CLI because it appears to be using a
less reliable path on fresh hosts than `project exec`.

Questions to answer:

1. Is the default daemon/routed mode wrong for fresh hosts or admin control?
2. Should `project file` fall back more aggressively?
3. Is there an auth/routing bug specific to admin + routed file operations?
4. Should some file operations use project API/exec instead of routed fs?

Deliverable:

- one small issue writeup plus a minimal reproducible smoke

### Phase 4: Add automated fresh-host smoke

Add a CLI smoke that provisions fresh hosts and verifies at least:

- `project exec`
- `project codex exec`
- `project chat thread create`
- `project chat thread status`
- `project chat automation upsert`

This should run against the same kind of brand-new hosts that exposed the
problem here.

### Phase 5: Finish the full move/delete smoke in the CLI

Once phases 1-4 are solid, automate this exact scenario:

1. create source and target hosts
2. create project on source
3. create `.chat` thread
4. configure loop and schedule
5. run at least one real automation / Codex turn
6. move project to target
7. verify:
   - no project-local `~/.codex/auth.json`
   - schedule paused
   - loop not actively running
8. resume schedule
9. run again
10. run two turns
11. hard-delete project
12. verify project data is removed from the target host

## Immediate Next Step After Manual Test

Assuming the manual move/delete smoke gives useful signal, come back and do:

1. path normalization for `root/...`
2. rework `project chat` file I/O to use `project exec`/project API
3. add one fresh-host CLI smoke that proves `project chat thread create/status`
   works there

## Notes

- The main user-facing product path is in much better shape than the CLI path.
- This follow-up is mostly about making the CLI a trustworthy automation/admin
  surface for agents and smoke tests.
- The fresh-host issues found here are useful; they are exactly the sort of
  problems that a good CLI smoke suite should catch early.
