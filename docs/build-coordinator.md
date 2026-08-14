# Build Coordinator — Collaborative LaTeX / RMarkdown / Quarto Builds

## Goal

When any collaborator clicks Build in a LaTeX/Rmd/Qmd editor, **all clients**
with the same file open see the build activity — spinner, disabled buttons,
live streaming output — and any of them can stop it, regardless of who
initiated it. For LaTeX this also means every client immediately receives the
"subfiles" dependency info parsed from the streamed latexmk stdout, without
having to run a local build first.

Ported from cocalc.com PR
[#8767](https://github.com/sagemathinc/cocalc/pull/8767) plus its long tail of
follow-up race/robustness fixes (through upstream commits `0a80ce55bf`,
`5b2cd64b58`, `fcaf92ce55`, `6e26e37b85`, `0af7218`, `ce2e7c77`, ...).

## Architecture

Three cooperating layers:

### 1. Ephemeral DKV — build state broadcast

One ephemeral conat DKV per project (`name: "build"`), keyed by file path.
See [conat-dkv-pubsub.md](conat-dkv-pubsub.md) for the DKV primitive itself.

```
BuildState = { buildId, status, aggregate?, force?, startedAt? }
status:  (no entry) → "running" → "stopping" → "finished"
```

`BuildCoordinator`
([build-coordinator.ts](../src/packages/frontend/frame-editors/generic/build-coordinator.ts))
owns the full join lifecycle:

- **Originator**: `setLocalBuildId()` → `publishBuildStart()` before running,
  `publishBuildFinished()` in a `finally`. Self-echoes are filtered via
  `buildId` correlation.
- **Late joiner / collaborator**: on a remote `"running"` entry (or on init if
  one already exists), calls the format-specific `join` callback with the
  originator's `buildId` and `aggregate` value, and manages `is_building` /
  redux `building` state uniformly. Every lifecycle callback carries that
  `buildId`; a completion from an older build cannot tear down or stop its
  replacement.
- **Stop**: `requestStop()` flips the entry to `"stopping"`; every client
  (including the originator) honors it if the `buildId` matches the build it
  is tracking, and kills its local process group.

#### When the coordinator connects

The coordinator is a **subscription**, and that dictates its lifetime. A
collaborator who never builds anything still has to be listening *before*
someone else starts a build, or they see nothing — which is the whole
feature. So editors construct it eagerly when the file opens, and never
lazily on the first build or first save.

Opening the DKV, on the other hand, fails whenever the project is
unreachable, and a stopped project can stay stopped for many minutes. So the
open is driven by the same signals the sync layer itself waits for — the
syncstring going ready, the project store's `started` event — via
`ensureConnected()`, which opens the DKV if it isn't open yet and does
nothing if it is. That mirrors how `wait_until_syncdoc_ready` works: wait for
the event, no polling and no deadline. A timer retry remains only as a
backstop for signals we might not observe, and a failed open is deliberately
not surfaced to the user, since a stopped project is ordinary and there is
nothing to act on. Because a late connect reads the DKV snapshot, an editor
that connects after the project recovers still joins a build already in
flight.

This is worth stating because getting it wrong is invisible: the LaTeX editor
used to create its coordinator in `init_config().then(...)`, and
`init_config` awaits the aux syncdb becoming ready with no deadline. While
the project was stopped that promise stayed *pending*, so the editor had no
coordinator at all — builds ran, no collaborator saw them, and every client
spawned its own process. Nothing failed loudly; coordination was just
silently absent. The Rmd/Qmd editors, which construct theirs synchronously,
were unaffected. Anything the coordinator needs but does not have yet
(for LaTeX, the build command that `init_config` produces) is waited for in
the `join` callback rather than by delaying the subscription.
- **Robustness**: operations issued before the DKV finished initializing are
  buffered and flushed; stranded `"running"` entries older than 20 minutes
  (originator crashed) are ignored and cleared using the shared **server
  clock** (`server_time()`, not local wall clocks); the stale-cleanup re-reads
  the entry before writing so it can never stomp a newer build. Runtime loss
  invalidates the active join generation, drops buffered operations from the
  dead runtime, and records a server-time reset boundary so delayed DKV init
  cannot join a process from the dead runtime. Starts received while another
  local lifecycle is busy are reconciled from the DKV whenever that owner or a
  stop releases the editor, so replacement builds are not dropped.

### 2. Aggregate piggybacking — one process, many callers

Joining clients call the _same_ build chain with the _same_ aggregate value
(server timestamp or saved-version hash). The backend `aggregate` wrapper
([aggregate.ts](../src/packages/util/aggregate.ts)) dedupes so only one process
runs and every caller receives the same async job identity. Its `streamCB`
fan-out remains supported for existing direct `executeCode` consumers;
`exec-stream` itself uses the job-keyed `updates` emitter below as its single
live-output source.

Manual builds ("Build"/"Force Build" buttons) and any build after a stop use a
**fresh** server-time aggregate to bypass the dedup cache (a stopped build
leaves cached partial results under the old key). Build-on-save — including
Ctrl-S, which is a save that may build, not a manual build — goes through
`auto_build()`, which keeps the save-time key so collaborator saves dedupe
into one process.

Whether a build is a no-op is a separate question from the aggregate, and is
decided on a **content revision**: a hash over `(path, hash_of_saved_version)`
for the master plus every dependency open in this client (`sourceRevision()`
in the LaTeX actions; the Rmd/Qmd actions hash their single file). Content,
not `last_save_time()`, because a save timestamp propagates asynchronously,
so a build and the check that follows it could disagree about the same
source — and because an included file changing must count even though the
master did not. An unknown revision never skips. A skipped build never
reaches the DKV, so peers don't flicker their spinners.

A build saves its own sources, and that save is what makes the syncstring
emit `save-to-disk`, so **every** build queues a follow-up build request for
the revision it is already compiling. `drainPendingBuild` therefore compares
the queued revision against the one that build attempted and drops the
duplicate. Comparing against the last *successful* build instead would
swallow a retry after a failed one.

"Force Build" additionally rewrites a latexmk command to use `-gg`
(`fullRebuildCommand`), so it discards generated files and reprocesses rather
than merely skipping our caches. A build command the user hardcoded (e.g. via
a `% !TeX cocalc =` directive) is left alone.

### 3. Backend `updates` EventEmitter — late-join streaming

[execute-code.ts](../src/packages/backend/execute-code.ts) emits
`stdout` / `stderr` / `stats` / `finished` events keyed by `job_id` on an
exported `updates` EventEmitter for **all async jobs**, independent of any
`streamCB`. [exec-stream.ts](../src/packages/backend/exec-stream.ts)
subscribes to those events as its single source, so a client that attaches to
an already-running job (via aggregate dedup) still gets live streaming from
that point on.

## Edge cases handled

- **Executable missing / process exits immediately** (ENOENT etc.): the
  callback always resolves and the async cache entry is finalized — no
  entry stuck in `"running"` forever.
- **Older blocking command consumers**: blocking `executeCode({ streamCB })`
  continues to deliver incremental stdout/stderr. The async `updates` emitter
  is additive and does not replace the project-host backup/restore/rootfs
  progress contract.
- **Stream ends without a "done" event** (connection drop, dead aggregate):
  the frontend recovers the final result via the `async_get` API
  ([client/project.ts](../src/packages/frontend/client/project.ts)); the
  LaTeX `runJob`
  ([latex-editor/util.ts](../src/packages/frontend/frame-editors/latex-editor/util.ts))
  additionally reconciles job status on `"end"` and has a watchdog at
  `TIMEOUT_LATEX_JOB_S + 60s` so its Promise can never hang, which would
  otherwise pin the DKV entry to `"running"` for every future joiner.
- **Sub-step failures** (knitr/sagetex/pythontex/latex): `markBuildLogError`
  marks the build-log entry as errored while preserving partial output;
  `cleanupStaleBuildLogs` is a post-build safety net for anything left
  `"running"`.
- **Stop → build**: stopping clears the last-built marker, cancels any
  queued follow-up build and any delayed converter run, and resets the
  rmd/qmd spacing window so the next build fires immediately with a fresh
  aggregate. Build ownership tokens also guard errors, stream callbacks,
  sub-step continuation, success bookkeeping, and final teardown, so an old
  async pipeline settling later cannot mutate its replacement.
- **Project stop/restart mid-build**: the editors listen for both `stopped`
  and `started`, invalidate the coordinator/runtime generation, terminalize
  the matching shared entry, and reset local state immediately. This is a
  reset-only path: it never sends `kill` for a PID recorded in the old runtime,
  where PID reuse could target an unrelated process after restart.

## File map

| Area                | Files                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator         | `frontend/frame-editors/generic/build-coordinator.ts` (+ `.test.ts`, mock-DKV unit tests)                                                                                                                            |
| LaTeX integration   | `frontend/frame-editors/latex-editor/actions.ts` (`buildInternal`/`auto_build`, coordinator wiring, `make_timestamp`), `latex-editor/util.ts` (`runJob`)                                                             |
| Rmd/Qmd integration | `frontend/frame-editors/rmd-editor/base-actions.ts` (shared `MarkdownConverterActions`), thin `rmd-editor/actions.ts` + `qmd-editor/actions.ts`, `rmd-editor/utils.ts`                                               |
| Backend streaming   | `backend/execute-code.ts` (`updates` emitter), `backend/exec-stream.ts`, `util/aggregate.ts` (streamCB fan-out)                                                                                                      |
| Stream recovery     | `frontend/client/project.ts` (`async_get` fallback on end-without-done)                                                                                                                                              |
| Reactive UI         | redux `building` state consumed by `frame-tree/title-bar.tsx`, `frame-tree/commands/generic-commands.tsx` (build/force-build/stop disabled states), `latex-editor/output-control-build.tsx`, rmd/qmd `build-log.tsx` |

## Design debt — why this is complicated, and the simpler V2

The edge-case density here is not incidental; it follows from three design
choices inherited from upstream:

1. **Every client runs the build; nobody owns it.** The truth about a build
   lives in N browsers plus the backend dedup cache instead of in the one
   place the process actually runs. Self-echo filtering, join races,
   stranded-entry heuristics, `sourceRevision`, and the snapshot/live
   overlap reconciliation all exist only because clients coordinate with
   each other rather than observing a project-owned job.
2. **Coordination piggybacks on `aggregate`**, a dedup mechanism, so build
   _identity_ is smuggled through timestamps/hashes (fresh-aggregate-after-
   stop, `make_timestamp` key preservation, `sourceRevision`).
3. **State is smeared across layers** — coordinator buildIds, editor flags
   (`is_building`, `_lastBuiltHash`, `_buildWasStopped`,
   `_pendingBuildRequest`, converter epoch/spacing), redux `building`, and
   the backend cache — with no single state machine owning transitions.

The simpler architecture (upstream's own declared "V2", see the comment in
`build-coordinator.ts`): the **project** runs builds as first-class jobs —
one build service, job state and output in a project-owned conat
stream/DKV, clients as thin observers with start/stop RPCs. That collapses
most of the machinery above into "subscribe to the job". Until then, this
implementation is kept intentionally close to upstream so fixes flow in
both directions.

### Planned V2 shape

The intended end state is a **project-side build service** that can run
LaTeX, Quarto and RMarkdown builds, rather than each client driving its own
copy of the build pipeline:

1. **Extract the build orchestration from the editor actions.** Today the
   pipeline (`buildInternal`/`run_build`/`run_latex`/`run_knitr`/
   `run_sagetex`/`run_pythontex` in the LaTeX actions, and the converter
   runner in `rmd-editor/base-actions.ts`) is entangled with editor
   lifecycle state — `is_building`, `_buildToken`, `_buildWasStopped`,
   `is_stopping`, `_pendingBuildRequest`, `_lastBuiltTime`. A worthwhile
   split moves **all** of that state into a build runner that owns the
   lifecycle and exposes `build` / `stop` / `force`; moving only the
   `run_*` methods would leave the state behind and make ownership worse.
   The same runner is then what the project can host.
2. **Expose it as a conat service on the project**, so a build is started,
   observed and stopped through the project that actually runs it, with the
   job's state and output stream owned there.
3. **Clients use the service when the project offers it**, and fall back to
   the V1 client-coordinated protocol described in this document when
   talking to an older project. The two must therefore coexist: V1 stays
   supported for as long as projects without the service exist, which is
   also why V1 is kept close to upstream.

Format-specific knowledge (latexmk vs quarto vs rmarkdown) belongs behind
one interface in the runner, so the project side does not grow three
parallel implementations.

## cocalc-ai adaptations vs upstream

- DKV obtained via `webapp_client.conat_client.dkv(...)` with an explicitly
  routed project client (`projectConat({ project_id, requireRouting: true })`)
  instead of upstream's direct `dkv()` import — per the multibay
  explicit-routing rule, so collaborators homed on different bays coordinate
  on the same fabric.
- No `compute_server_id` threading (no compute servers here).
- Output-file existence checks use the project `fs().exists()` API instead of
  directory listings.
- `AccountStore.waitUntilReady()` was added (upstream `e219da3509`) — gates
  auto-build decisions on account **settings** being loaded (`is_ready`).
- LaTeX keeps cocalc-ai's UX latency traces and streamed-output error
  fallback; chat-anchor code paths are cocalc-ai's own implementation and
  were not touched by this port.
