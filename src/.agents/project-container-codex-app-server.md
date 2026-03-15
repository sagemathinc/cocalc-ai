# Project-Container Codex App-Server Plan

Goal: make `codex app-server` the shared execution primitive for both Lite and
Launchpad, while keeping CoCalc chat threads as the product UX/source of truth
and ACP workers as the durable supervisors.

Related follow-up plan:

- [Rootfs Bootstrap Plan](/home/wstein/build/cocalc-lite4/src/.agents/rootfs-bootstrap.md)

This means:

- Lite uses app-server directly on the local workspace/runtime.
- Launchpad uses app-server inside the actual project container.

The Codex agent must live in the same runtime as the user's app, files,
processes, ports, and logs. The current helper-container model is too far from
the real project environment and makes development workflows awkward or
misleading.

## Blockers

These are the highest-priority unresolved issues that must be explicitly
tracked during the migration.

### 1. Stored Context Space / Resume Memory

- App-server is not sqlite-only today.
- Upstream still persists full rollout JSONL files under
  `~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl`, while sqlite stores
  metadata/state/indexes.
- Therefore the old `codex exec` failure mode where a long history can make
  future turns expensive to resume is not architecturally eliminated just by
  switching to app-server.
- CoCalc must keep its own context-maintenance strategy:
  - explicit reset
  - explicit fork
  - explicit/manual compaction
  - optional automatic trimming/compaction policy if we continue to need it
- Before release, measure this with a synthetic long-thread benchmark:
  - startup RSS for resume
  - on-disk growth of `.codex/sessions`
  - effect of compaction/trimming

### 2. API-Key Usage Accounting

- The app-server path streams token-usage data, so the raw information appears
  to be available.
- However, the current app-server integration does not yet appear to feed that
  usage into CoCalc's site-key metering/governor path the same way the older
  `codex exec` integration did.
- This must be wired before treating site-provided API-key auth as production
  ready.

### 3. Trusted Codex Binary Path

- Launchpad must execute app-server through the exact trusted Codex binary we
  install into the runtime image, not through `PATH` or any user-controlled
  fallback.
- The current approach of using `/opt/cocalc/bin2/codex` in the project
  runtime is the right security model, assuming:
  - `/opt/cocalc/bin2` is read-only to project users
  - security-drift monitoring would catch this no longer being true
- Keep documenting this as a critical security assumption.
- The current host-side override is useful for debugging, but it should remain
  clearly dangerous/admin-only. Renaming it to include `DANGEROUS` would be
  reasonable.

### 4. Managed API-Key Auth Leakage in Collaborative Projects

- This is the most important current security blocker.
- Upstream external ChatGPT token login uses ephemeral in-process auth storage,
  so it does not persist those tokens to project-local disk.
- Upstream API-key login is different: it persists according to
  `cli_auth_credentials_store_mode`.
- In a project container, that means managed API keys can be written into the
  project's `CODEX_HOME` unless we force ephemeral storage or otherwise avoid
  that code path.
- For collaborative Launchpad, this is not safe enough for:
  - site-provided API keys
  - account-managed API keys
  - project-managed API keys that should not be exposed to collaborators
- Required follow-up:
  - force ephemeral credential storage for app-server when auth is injected by
    CoCalc
  - add regression tests proving managed API-key auth is not persisted into the
    project filesystem
  - document the remaining trust model clearly

## Product Decision

Keep this split:

- CoCalc thread:
  - delivery surface
  - UI/source of truth
  - scheduling / automations
  - thread metadata
  - permissions / product semantics
- Codex app-server thread:
  - execution backing thread
  - upstream context/history/compaction/fork state
  - upstream tool execution state

This matches what CoCalc already does conceptually today with `codex exec`,
just with upstream app-server primitives instead of hand-rolled state machine
logic.

Also lock in this invariant:

- at most one active Codex turn per CoCalc thread

This is already the current CoCalc model and should remain true. It keeps the
mapping to one shared upstream thread well-defined.

## Acceptance Scenarios

### Real Development Workflow

1. User opens a Launchpad project running a server in the project container.
2. User asks Codex to inspect logs, restart the app, and test a local URL.
3. Codex runs in the project container and sees the same processes, ports,
   files, and shell environment as the user.
4. The resulting CoCalc chat turn streams normally and can be interrupted.

### Lite Workflow

1. User opens a Lite chat thread attached to a local workspace.
2. User asks Codex to inspect files, run commands, and make edits.
3. Codex runs through app-server directly on the Lite machine/workspace.
4. The same CoCalc chat-to-app-server bridge code is used as in Launchpad,
   except for the runtime adapter.

### Concurrent Turns

1. Two CoCalc chat threads in the same project start Codex turns at once.
2. Both turns run concurrently without blocking each other.
3. Stopping one turn does not stop the other.
4. Both stream back to the correct CoCalc thread.

### Shared Thread, Different Auth

1. Human A and human B use the same CoCalc thread in one collaborative project.
2. Human A sends a Codex turn that establishes some context.
3. Human B sends the next Codex turn using different auth.
4. Codex still sees the same shared upstream thread context.
5. Auth is per-turn, but thread context is shared.

### Move / Clone / Restart

1. A project moves to another host.
2. Its upstream Codex backing state moves with the project.
3. Auth does not have to move with the project.
4. New turns resume from the moved state as appropriate.

### Context Maintenance

1. User asks CoCalc to fork a thread.
2. User later compacts or resets context.
3. These operations map cleanly to upstream app-server primitives.
4. CoCalc remains free to expose product-specific UX such as "reset session".

## Why App-Server

Upstream app-server already has first-class support for things we previously
implemented ourselves around `codex exec`:

- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/read`
- `thread/list`
- `thread/compact/start`
- `thread/rollback`
- `turn/start`
- `turn/interrupt`
- per-thread and per-turn config overrides
- external ChatGPT token mode with refresh callback

Relevant upstream references:

- `/home/wstein/upstream/codex/codex-rs/app-server/README.md`
- `/home/wstein/upstream/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`
- `/home/wstein/upstream/codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- `/home/wstein/upstream/codex/codex-rs/core/src/auth.rs`

Using these upstream primitives should simplify CoCalc's Codex integration and
reduce brittleness.

## Core Architecture

### Invariant

The actual Codex process must run inside the real workspace runtime.

That means:

- Lite launches something like:

```bash
/path/to/codex app-server --listen stdio
```

- Launchpad launches something like:

```bash
podman exec project-<project_id> /opt/cocalc/bin2/codex app-server --listen stdio
```

In both cases, the ACP worker speaks JSON-RPC to app-server over stdio.

### Control Plane

- detached ACP worker:
  - durable queue / scheduler
  - turn ownership
  - stream bridge between CoCalc chat and app-server notifications
  - auth broker
  - lifecycle manager for app-server processes

### Execution Plane

- Codex app-server in the real runtime:
  - owns upstream thread/turn/item semantics
  - executes commands/tools against the actual workspace runtime
  - persists Codex thread state under workspace-backed storage

### Shared Core, Two Adapters

Design this as:

- one shared CoCalc app-server bridge layer
- two runtime adapters:
  - Lite local-runtime adapter
  - Launchpad project-container adapter

The shared bridge layer should own:

- CoCalc thread <-> Codex thread mapping
- JSON-RPC request/response handling
- turn streaming into CoCalc chat rows
- interrupt/fork/reset/compact semantics
- durable ACP integration

The runtime adapter should own only:

- how app-server is launched
- how shell/env/cwd are prepared
- how auth is provided

## Where App-Server State Lives

Recommended split:

- Codex thread/history/state:
  - workspace-backed path
  - should move with the project
- auth:
  - not workspace-backed in the long-term design
  - injected dynamically by the ACP worker

Concretely:

- use a workspace path for `CODEX_HOME`, e.g. under `/root/.codex` in
  Launchpad or the normal workspace home in Lite
- use `CODEX_SQLITE_HOME` explicitly if we need tighter control of where the
  sqlite DB lives

This ensures:

- project move/clone can carry conversation backing state
- auth does not have to be stored there later

## Thread Mapping Model

Add a durable mapping between CoCalc chat threads and upstream Codex threads.

Suggested mapping key:

- `project_id`
- `chat_thread_id`

Mapped value:

- `codex_thread_id`
- current upstream thread metadata
- last-used config summary

Important rule:

- one CoCalc thread maps to one shared upstream Codex thread

Why:

- this matches collaborative expectations
- if human A says `a = 5` and human B asks `what is a?`, Codex should know the
  answer from shared context
- auth may vary per turn without changing the shared thread history

Auth is therefore not part of thread identity. It is part of turn execution.

## App-Server Process Model

There are two possible designs:

### Option A: One App-Server Process Per Active CoCalc Turn

Pros:

- simplest
- naturally supports concurrent turns
- naturally supports multiple auth principals
- no multiplexing logic
- no shared-process race across rolling workers
- works the same way in Lite and Launchpad

Cons:

- startup overhead per turn
- repeats initialize/auth handshake

### Option B: Reusable App-Server Processes

Suggested reuse key:

- `worker_id`
- `project_id`
- `auth_principal_id`

Pros:

- lower startup overhead
- auth handshake amortized
- multiple turns for same auth/project can share one server

Cons:

- more lifecycle complexity
- must handle idle timeout
- must not accidentally share auth across principals
- rolling-worker interaction is trickier

### Recommendation

Implement Option A first.

It is the safest switch-over path. Once the app-server integration is proven,
Option B can be added as an optimization with idle TTL.

This handles:

- multiple turns in the same project
- multiple auth principals in the same project
- rolling-worker ownership

with the least complexity.

## Auth Model

There are three relevant upstream auth modes:

### 1. API Key

Public/supported upstream mode.

- `account/login/start` with `type: "apiKey"`
- or raw env-based CLI auth for non-app-server flows

This is easy, but secrets would be visible to collaborators if stored or
injected into the workspace in the obvious ways.

### 2. Managed ChatGPT Auth

Public/supported upstream mode.

- `account/login/start` with `type: "chatgpt"`
- app-server owns the login flow and persisted refresh tokens

This is not acceptable for collaborative workspace storage if we do not want
auth persisted in the project.

### 3. External ChatGPT Tokens

This is the important mode for CoCalc.

Upstream supports:

- `account/login/start` with `type: "chatgptAuthTokens"`
- server-initiated `account/chatgptAuthTokens/refresh`

The parent integration can:

- supply access token + account/workspace id
- keep refresh logic outside the project
- refresh on demand when app-server gets a 401

This is currently marked unstable/internal upstream, but it is exactly the
shape we want for CoCalc.

### Auth Recommendation

Phase 1:

- manual `auth.json` in the workspace for fast validation

Phase 2:

- switch to external ChatGPT token mode
- auth broker lives in ACP worker / host integration
- no durable auth file in the workspace

## Turn Lifecycle

For one CoCalc Codex turn:

1. ACP worker dequeues the turn.
2. Ensure the runtime is available:
   - Lite: workspace process/runtime
   - Launchpad: project container
3. Start app-server over stdio in that runtime.
4. Send `initialize`.
5. Perform auth setup:
   - Phase 1: rely on manual `auth.json`
   - Later: call `account/login/start` with `chatgptAuthTokens`
6. Resolve backing thread:
   - no mapping => `thread/start`
   - existing mapping => `thread/resume`
   - CoCalc fork => `thread/fork`
7. Send `turn/start` with the CoCalc user input and per-turn overrides.
8. Stream `item/*` and `turn/*` notifications back into CoCalc chat state.
9. On interrupt, call `turn/interrupt`.
10. On completion:
    - persist mapping updates
    - persist useful metadata
    - shut down the app-server process

For a later reusable-process optimization, the last step becomes "return the
app-server process to the per-auth idle pool".

## Config / Override Strategy

Do not treat app-server as "edit config.toml for every turn".

Use:

- thread-level overrides on `thread/start`, `thread/resume`, `thread/fork`
- turn-level overrides on `turn/start`

This covers:

- model
- cwd
- effort / summary
- sandbox
- approval policy
- personality
- developer instructions / collaboration mode

Use `config/read`, `config/value/write`, and `config/batchWrite` only when the
user is explicitly changing persistent Codex defaults.

## Mapping CoCalc Features to Upstream Primitives

- new CoCalc thread:
  - `thread/start`
- normal follow-up turn:
  - `thread/resume` + `turn/start`
- CoCalc thread fork:
  - `thread/fork`
- "reset session":
  - clear mapping and call `thread/start` next time
- context compaction:
  - `thread/compact/start`
- rollback / prune:
  - `thread/rollback`
- stop:
  - `turn/interrupt`
- model / reasoning / cwd changes:
  - thread-level and turn-level app-server overrides

This keeps CoCalc UX while delegating agent-state semantics upstream.

## Rolling Workers Interaction

The ACP rolling-worker design still applies.

Important rule:

- app-server processes belong to the owning ACP worker generation

That means:

- a draining worker keeps its in-flight app-server processes alive until its
  turns complete
- a new active worker starts its own app-server processes for new turns

This avoids cross-worker sharing of one live app-server process.

Option A fits rolling workers naturally.

## Multi-User / Multi-Auth Policy

Recommended policy:

- CoCalc collaborative thread is shared UI
- upstream Codex thread is shared per CoCalc thread
- auth is selected per turn

That means:

- collaborators share context/history in the same thread
- collaborators do not share secrets
- model availability may differ from one turn to the next depending on whose
  auth is used

If a user lacks access to the previously used model, the turn must either:

- downgrade to an allowed model
- ask explicitly
- or fail clearly

But the shared thread context should remain shared.

## Project Move / Clone / Delete

### Move

- workspace-backed Codex state moves with the project
- host-side auth broker state does not need to move
- next turn on destination host re-authenticates and resumes the mapped Codex
  thread if appropriate

### Clone / Fork Project

Recommended initial policy:

- clone workspace-backed Codex thread/history/state
- clear auth state
- keep the CoCalc thread-to-Codex mapping only if the clone explicitly wants
  to inherit that history model; otherwise reset mapping on first use

We should prefer preserving the useful agent history while never silently
continuing old auth.

### Delete

- delete workspace-backed Codex state with the project
- clear any durable mapping rows

## Implementation Phases

### Phase 0: Investigation / Spike

- manually run `codex app-server --listen stdio` inside:
  - a Lite workspace/runtime
  - a Launchpad project container
- confirm:
  - initialize
  - thread/start
  - turn/start
  - thread/resume
  - thread/fork
  - turn/interrupt
  - thread/compact/start
- do this first with manual `auth.json`

Deliverable:

- reproducible smoke scripts for Lite and Launchpad

### Phase 1: Shared App-Server Bridge In Lite

Goal:

- prove the shared bridge layer in the simpler runtime first

Work:

- implement a shared CoCalc app-server JSON-RPC bridge
- add a Lite local-runtime adapter
- use manual/local auth
- map CoCalc thread to upstream thread
- validate:
  - new turn
  - resume
  - fork
  - interrupt
  - reset session
  - compact

Why start here:

- easier runtime
- no container indirection
- fastest way to validate the shared bridge design

### Phase 2: Launchpad Adapter

Goal:

- run the same shared bridge against app-server inside the project container

Work:

- add Launchpad project-container adapter
- ensure project container runtime/env is correct
- keep manual `auth.json` initially
- validate the same scenarios on Launchpad

### Phase 3: Minimal Shared Switch Complete

Goal:

- app-server is the real execution path for both Lite and Launchpad
- old `codex exec` orchestration path is no longer primary

Work:

- feature flag / migration path
- keep rollback option during transition

### Phase 4: External Auth

Goal:

- no durable auth file in the workspace for ChatGPT-backed usage

Backend work:

- implement app-server `chatgptAuthTokens` login path
- implement `account/chatgptAuthTokens/refresh` callback bridge
- integrate with existing CoCalc subscription/auth management

Validation:

- turn works with no `auth.json` in the project
- token refresh works after forced expiry
- collaborators with different auth keep shared context but isolated secrets

### Phase 5: Optimization / Reuse

Goal:

- reduce startup overhead if needed

Possible work:

- reusable app-server pool keyed by:
  - `worker_id`
  - `project_id`
  - `auth_principal_id`
- idle TTL before shutdown
- process health checks
- structured admin visibility

Only do this if startup overhead is proven material.

### Phase 6: Cleanup / Deletion of Old Exec Path

- remove helper-container Codex execution path
- simplify old `codex exec`-specific glue that app-server supersedes
- keep optional isolated execution mode only if there is a compelling product
  reason

## Files Likely To Change

Shared bridge / ACP:

- `src/packages/lite/hub/acp/index.ts`
- `src/packages/lite/hub/sqlite/*`
- `src/packages/conat/ai/acp/*`
- `src/packages/chat/src/index.ts`

Lite adapter:

- `src/packages/lite/*`

Launchpad adapter:

- `src/packages/project-host/codex/*`
- `src/packages/project-host/hub/acp/*`

Potential frontend changes:

- mostly mapping and state handling around reset/fork/compact controls

## Main Risks

### 1. Upstream External Auth Is Marked Unstable

Mitigation:

- phase the migration
- prove app-server execution first with manual auth
- wrap external auth integration narrowly

### 2. State Duplication Between CoCalc and App-Server

Mitigation:

- keep CoCalc as product/UI source of truth
- keep app-server as execution/context backing state
- store only the necessary mapping and metadata

### 3. Multi-Auth Semantics In Shared Threads

Mitigation:

- keep one shared upstream thread per CoCalc thread
- treat auth as per-turn execution choice
- explicitly handle model availability mismatches

### 4. Startup Overhead

Mitigation:

- start with one app-server per turn
- optimize only if real measurements justify it

## Recommended Next Step

Start with a narrow spike that proves the core architectural claim:

- shared bridge talks to app-server successfully
- Lite adapter works
- Launchpad adapter works inside the project container
- CoCalc thread maps to one shared upstream thread
- a normal turn, follow-up turn, fork, reset, and interrupt all work with
  manual `auth.json`

If that works cleanly, the direction is settled and the remaining major work is
auth brokering and migration, not execution architecture.
