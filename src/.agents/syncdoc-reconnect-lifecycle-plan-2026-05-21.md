# SyncDoc Reconnect Lifecycle Plan

Date: 2026-05-21

## Executive Summary

The current reconnect work is aiming at the right problem but at the wrong layer. `ReconnectCoordinator` is useful for avoiding reconnect stampedes and prioritizing visible editors, but it must not own document lifecycle. `SyncDoc` must remain the durable owner of patchflow state. A temporary network, Conat, project-host, persist, or changefeed failure should make a `SyncDoc` **disconnected**, not **closed**.

The likely bug is that a lower transport/table close is being promoted to a fatal `SyncDoc.close()`. Once that happens, editor code tries to compensate by replacing the open-file runtime. That creates the exact bad states we are seeing: editable documents switch to read-only/loading, local working state becomes inaccessible, and reopening the tab becomes the only reliable recovery path.

The fix should restore this invariant:

> An open editor keeps the same `SyncDoc` object across transient disconnects. The document stays editable, local edits remain in patchflow state, save/sync status shows disconnected/recovering, and reconnect only rebuilds the transport underneath.

## Current Architecture

Relevant code paths:

- `src/packages/frontend/conat/reconnect-coordinator.ts`
- `src/packages/frontend/conat/client.ts`
- `src/packages/frontend/frame-editors/base-editor/actions-base.ts`
- `src/packages/sync/editor/generic/sync-doc.ts`
- `src/packages/conat/sync/synctable-stream.ts`
- `src/packages/conat/sync/dstream.ts`
- `src/packages/conat/sync/core-stream.ts`
- `src/packages/sync/table/synctable.ts`

Current layering:

```text
Editor UI
  -> BaseEditorActions
    -> SyncDoc / syncstring / syncdb
      -> SyncTable wrappers
        -> DStream / DKV / CoreStream
          -> Conat / project host / persist / router
```

`ReconnectCoordinator` sits beside this stack. It should coordinate timing and concurrency of reconnect attempts, but it should not cause an editor to discard a `SyncDoc` or rebuild the open-file runtime.

## Observed Facts

`ReconnectCoordinator` is not inherently the bug.

- It registers resources with `canReconnect`, `isConnected`, `priority`, and `reconnect`.
- It throttles resource recovery and prioritizes foreground editors.
- `BaseEditorActions` registers editors as reconnect resources and calls `syncdoc.recoverNow(...)` followed by `wait_until_live_connected()`.
- That part is directionally correct if the `SyncDoc` remains open.

`SyncDoc` already has the right conceptual split.

- `SyncDoc` state is `init | ready | closed`.
- It separately tracks `liveConnected`.
- It emits `connected` and `disconnected`.
- It exposes `is_live_connected()`, `wait_until_live_connected()`, and `recoverNow(...)`.

There are suspicious fatal-close paths.

- `SyncDoc` constructor calls `this.client.once("closed", this.close)`.
- `SyncDoc.init_table_close_handlers()` currently attaches table `"close"` events to `this.close`.
- This can turn a lower-layer transient close into fatal document closure.

The Conat stream layer appears designed for recovery.

- `synctable-stream.ts` tracks `disconnected | connected | closed`.
- DStream/CoreStream have recovery states and `recoverNow(...)`.
- Core stream changefeed failures request recovery rather than automatically closing the stream.
- This suggests the durable recovery model exists below `SyncDoc`, but `SyncDoc` may be closing before it can be used.

Recent editor-side recovery is a symptom workaround.

- `BaseEditorActions.recoverAfterUnexpectedSyncdocClose()` sets `read_only: true`, `rtc_status: "loading"`, and calls `recoverOpenFileRuntimeAfterUnexpectedSyncdocClose(...)`.
- That runtime reset path removes and reboots open-file components.
- This is appropriate only for a truly fatal document identity/corruption case, not for a project-host restart.
- It makes the editor support two modes, "with syncdoc" and "without syncdoc", which is the wrong architecture for patchflow.

## Correct State Model

There are two separate state machines.

### Document Lifecycle

This is owned by `SyncDoc`.

```text
init -> ready -> closed
```

`closed` should only mean:

- user closed the editor/document,
- application/session is intentionally shutting down,
- permission or identity became unrecoverable,
- document identity/history is corrupt in a way that cannot be merged safely,
- explicit test/runtime disposal.

`closed` should not mean:

- browser went offline,
- project host restarted,
- Conat route was recreated,
- persist/changefeed disconnected,
- a socket closed but is recoverable,
- foreground/background reconnect was delayed.

### Live Transport State

This is owned below `SyncDoc`, but surfaced through `SyncDoc`.

```text
connected <-> disconnected <-> recovering
```

This state may change often. It must not discard patchflow state. The editor should remain editable while disconnected unless there is a real permission/identity failure.

## Root-Cause Hypotheses

### H1: Table Close Is Misclassified

`SyncDoc.init_table_close_handlers()` listens for table `"close"` and calls `SyncDoc.close()`. If a Conat-backed table emits `"close"` during a recoverable stream replacement, this immediately destroys the document object.

Expected fix direction:

- Recoverable tables should emit `disconnected`/`connected`, not fatal close.
- `SyncDoc` should not blindly convert every table close into document close.
- If a table close is fatal, it should carry an explicit reason/code that `SyncDoc` can classify.

### H2: Client Close Is Misclassified

`SyncDoc` calls `this.client.once("closed", this.close)`. We need to confirm what `client.closed` means in the modern frontend. If it can happen during a transient Conat/project-host reconnect, this is another path that destroys the `SyncDoc`.

Expected fix direction:

- If `client.closed` means full application shutdown, keep it.
- If it means transport reconnect, replace it with a disconnected/recovering signal.
- Rename or wrap client events so fatal shutdown and transient transport close are not ambiguous.

### H3: Editor Runtime Recovery Is Treating Symptoms as Cause

`recoverOpenFileRuntimeAfterUnexpectedSyncdocClose(...)` works by discarding/rebootstrapping runtime components. That is similar to closing and reopening the tab, which is exactly what manually recovers today. But using that as automatic recovery makes the normal path more complex and less reliable.

Expected fix direction:

- Do not runtime-reset open editors for transient sync disconnect.
- Reserve runtime reset for explicit project host identity reset or true fatal document close.
- If `SyncDoc` unexpectedly closes, treat that as a bug to instrument and fix, not as a normal recovery path.

### H4: ReconnectCoordinator Has Too Much Lifecycle Authority Indirectly

The coordinator itself does not close documents, but resource recovery can fail if the `SyncDoc` has already been closed. Then editor code may escalate to runtime replacement.

Expected fix direction:

- Coordinator only schedules `recoverNow()` and waits for `connected`.
- Coordinator should never require resource recreation for normal reconnect.
- Resource registration should be tied to editor visibility/lifetime, not transport lifetime.

## Proposed Plan

### Phase 1: Instrument Close Reasons

Add narrow diagnostics before changing behavior.

Record every `SyncDoc.close()` trigger with:

- project id,
- path,
- sync string id,
- close source,
- table states,
- table recovery states if available,
- Conat/client connection state,
- whether the close followed `disconnected`,
- whether user/editor explicitly requested close.

Useful close sources:

- `explicit_end`,
- `explicit_close`,
- `client_closed`,
- `syncstring_table_close`,
- `patches_table_close`,
- `permission_failure`,
- `identity_failure`,
- `init_failure`,
- `unknown`.

This should be temporary or gated behind existing debug logging; the goal is to identify the exact event that fires during `./ctl stop`.

### Phase 2: Stop Promoting Recoverable Table Failure to SyncDoc Close

Change `SyncDoc.init_table_close_handlers()` so recoverable Conat-backed tables do not close the whole `SyncDoc`.

Candidate rule:

- If a table has `recoverNow()` or a recovery-state API, table close/disconnect should call `refreshLiveConnectionState()` and request recovery.
- If a table is legacy/non-recoverable and truly closes, preserve the old fatal close behavior initially.
- If needed, add an explicit `fatal` close reason to table wrappers instead of overloading `"close"`.

Target invariant:

- During project-host stop, `SyncDoc.get_state()` remains `ready`.
- `SyncDoc.is_live_connected()` becomes `false`.
- Editor state may show disconnected/reconnecting, but does not become read-only and does not show a full-document loading spinner.

### Phase 3: Clarify Client `closed` Semantics

Audit `this.client.once("closed", this.close)` in `SyncDoc`.

Decision:

- Keep it only if it means full webapp/client disposal.
- Remove or replace it if it can mean transport disconnect/reconnect.
- If both meanings exist today, split the event names at the source.

Target invariant:

- Conat reconnect, project-host restart, and browser online/offline do not emit the fatal event consumed by `SyncDoc`.

### Phase 4: Remove Editor Runtime Replacement From Normal Reconnect

After Phases 1-3 identify and fix the improper close source, remove the new normal-path runtime replacement behavior.

Specifically:

- Do not set `read_only: true` just because sync is disconnected.
- Do not set editor content to a loading replacement after initial load.
- Do not call `recoverOpenFileRuntimeAfterUnexpectedSyncdocClose(...)` for transient disconnect.
- Keep an explicit fatal path for truly unrecoverable close, with a clear message and a manual reopen/reload action if needed.

This likely means replacing or deleting tests that currently assert read-only/loading/runtime rebootstrap on syncdoc close.

### Phase 5: Save UX During Disconnect

Saving while disconnected should not emit a frightening low-level toast.

Expected behavior:

- Local edits remain in memory and patchflow.
- Save button/status says changes are not currently synced/saved to disk.
- When live connection returns, normal patchflow/sync catches up.
- If the user explicitly requests save while disconnected, show a concise status like "Will save when connection returns" or "Cannot reach project host yet", not raw Conat callHub errors.

This may be a separate implementation pass, but it should be aligned with the same state model.

### Phase 6: Regression Tests

Add tests at three levels.

SyncDoc unit tests:

- A recoverable table disconnect makes `SyncDoc` emit `disconnected` but remain `ready`.
- Local edits made while disconnected remain in the doc.
- `recoverNow()` reconnects the underlying tables and emits `connected`.
- A fatal table close still closes `SyncDoc` with an explicit reason.

Editor tests:

- `handleSyncdocDisconnected()` does not set `read_only`.
- A loaded editor does not become `is_loaded: false` or replace content with loading UI after disconnect.
- Reconnect resource calls `recoverNow()` and does not rebootstrap open-file runtime.

Integration-style frontend test:

- Open a markdown file.
- Simulate lower stream/changefeed disconnect.
- Type while disconnected.
- Simulate reconnect.
- Confirm content remains visible and editable throughout.
- Confirm local edits eventually sync/save.

Manual validation:

- Open `a.md` in a project.
- `ssh host1`, stop project-host daemons.
- Confirm editor remains editable and shows a disconnected/saving status only.
- Start daemons.
- Confirm same editor reconnects without closing/reopening the tab.
- Repeat with chat file, markdown slate, and plain text editor.

## Immediate Recommendation

Do not build more "close and reopen internally" recovery logic. It is tempting because manual close/reopen works, but it makes the editor lifecycle fragile and creates two unsupported modes.

The next implementation should start with close-reason instrumentation and then fix the first observed fatal close source. Based on the code, the highest-probability first target is:

```text
SyncDoc.init_table_close_handlers()
  table "close" -> SyncDoc.close()
```

The second target is:

```text
SyncDoc constructor
  client "closed" -> SyncDoc.close()
```

## Open Questions

- During `./ctl stop`, which exact object emits the first fatal close: syncstring table, patches table, client, or project runtime?
- Does the Conat-backed table ever emit `"close"` for a recoverable stream replacement?
- Is there a true fatal table-close case that currently relies on `SyncDoc` closing immediately?
- Should recoverable table wrappers expose a typed close reason, or should `SyncDoc` identify recoverable wrappers by API shape?
- What should the editor show for disconnected-but-editable status: `rtc_status: "loading"` is semantically wrong after initial load, so do we need a distinct `rtc_status: "disconnected" | "reconnecting"`?

## Success Criteria

- Project-host restart never makes an already loaded editor read-only.
- Project-host restart never replaces loaded document content with a full loading spinner.
- Open markdown/chat/plain-text docs recover without closing and reopening the tab.
- `SyncDoc` remains `ready` across transient disconnects.
- Local edits made during disconnect are preserved and sync after reconnect.
- Fatal document close is rare, explicit, reasoned, and observable in logs.
