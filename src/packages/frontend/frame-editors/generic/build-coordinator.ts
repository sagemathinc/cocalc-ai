/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Coordinate build lifecycle across all clients via an ephemeral DKV.

One DKV per project, keyed by file path. Stores the current build state
so late joiners (clients that open the file mid-build) can tune in to
the running build immediately.

State machine:
  (no entry)  → "running"   = build started
  "running"   → "stopping"  = stop requested
  any         → "finished"  = build finished

The coordinator also manages the join lifecycle: when a remote build is
detected, it calls the provided `join` callback and handles the state
transitions (is_building, building UI state) uniformly.  This eliminates
duplicated handler code in the LaTeX and RMD/QMD action classes.
*/

import type { DKV } from "@cocalc/conat/sync/dkv";
import { webapp_client } from "@cocalc/frontend/webapp-client";

import { server_time } from "./client";

interface BuildState {
  buildId: string;
  status: "running" | "stopping" | "finished";
  aggregate?: number;
  force?: boolean;
  /**
   * Server-clock ms when this state was written (`webapp_client.server_time()`).
   * Used by late joiners to detect stranded "running" entries (originator
   * crashed / stream lost its "done" event) instead of joining and hanging
   * forever. Sourced from the shared server clock so peers with skewed
   * local wall clocks don't mis-classify live builds as stale. Optional for
   * backwards compatibility with older clients.
   */
  startedAt?: number;
  /**
   * The source revision the originator actually built: the saved-version
   * hash (rmd/qmd) or last-save time (latex) captured when the build
   * started. Joiners record THIS as their "last built" revision — sampling
   * their own local state instead could mark a newer local revision as
   * already built (e.g. a joiner that is ahead of the originator).
   * Optional for backwards compatibility; when absent, joiners simply
   * don't record a last-built revision.
   */
  sourceRevision?: number;
}

/**
 * Maximum age of a "running" DKV entry we're willing to join as a late
 * joiner. The latex backend enforces a 15-minute hard timeout on the job
 * itself; anything older than that plus a generous safety margin is
 * definitely stranded (the originator's `publishBuildFinished` never ran)
 * and re-joining would just hang us the same way.
 */
const STALE_RUNNING_ENTRY_MS = 20 * 60 * 1000;

// Backstop only. Opening the DKV fails while the project is unreachable,
// which can last for many minutes if the project is simply stopped. The
// primary recovery path is ensureConnected(), which editors call on the
// lifecycle signals that mean "the project is back" (syncstring ready,
// project started) — the same event-driven approach the sync layer uses,
// rather than polling. This timer only covers signals we might not see.
const INIT_RETRY_MS = 30 * 1000;

export interface BuildCoordinatorCallbacks {
  /**
   * Format-specific build function called when joining a remote build.
   * `sourceRevision` is the revision the originator captured at build
   * start (see BuildState.sourceRevision); undefined for older clients.
   */
  join: (
    buildId: string,
    aggregate: number | undefined,
    force: boolean,
    sourceRevision?: number,
  ) => Promise<void>;
  /** Stop the current build process (kill PIDs, etc.). */
  stop: (buildId: string) => void;
  /** Query whether a build is currently running. */
  isBuilding: () => boolean;
  /** Set building state for one specific build identity. */
  setBuilding: (building: boolean, buildId: string) => void;
  /** Report an error to the user. */
  setError: (err: string) => void;
}

export class BuildCoordinator {
  private dkv?: DKV<BuildState>;
  private path: string;
  private closed = false;
  private changeHandler?: (event: {
    key: string;
    value: BuildState | undefined;
    prev: BuildState | undefined;
  }) => void;
  private callbacks: BuildCoordinatorCallbacks;

  // Build tracking state — managed here to avoid duplication in consumers.
  private _remoteBuildId?: string;
  private _localBuildId?: string;
  // The requesting client already executes its local stop path directly.
  // Ignore the DKV echo for this id so a synchronous/local echo cannot launch
  // a second concurrent kill sequence.
  private _locallyStoppingBuildId?: string;
  // True while joinBuild() is awaiting the join callback.  Prevents
  // handleBuildFinished from clearing building state prematurely when
  // the originator finishes before our local join() completes.
  private _joining = false;
  // Incremented for each join and whenever the project runtime is lost.
  // A join that settles under an older generation must not tear down or
  // otherwise mutate the lifecycle of a replacement build.
  private _joinGeneration = 0;
  // DKV init bookkeeping (see init / ensureConnected).
  private project_id: string;
  private initializing = false;
  private initTimer?: ReturnType<typeof setTimeout>;
  // Server-clock boundary for the most recent observed project-runtime loss.
  // A running entry from at or before this instant belongs to the dead
  // runtime, even if the DKV was still initializing when the reset occurred.
  private _runtimeResetAt?: number;

  // Operations buffered while DKV is still initializing.
  // Flushed in init() once the DKV is ready.  Set to undefined
  // after init completes (success or failure) so later calls
  // fall through to the dkv?.method() no-op path instead of
  // accumulating closures indefinitely.
  private pendingOps?: Array<() => void> = [];

  constructor(
    project_id: string,
    path: string,
    callbacks: BuildCoordinatorCallbacks,
  ) {
    this.path = path;
    this.project_id = project_id;
    this.callbacks = callbacks;
    void this.init();
  }

  /**
   * Open the DKV now if it isn't open yet.
   *
   * Editors call this on the signals that mean the project became reachable
   * — the syncstring going ready, the project store's "started" event. That
   * is how the rest of the sync layer works: wait for the event, no polling
   * and no deadline. Opening the DKV fails while the project is stopped,
   * and a project can be stopped for many minutes, so an editor opened in
   * that window must be able to catch up later without a page reload.
   */
  ensureConnected(): void {
    if (this.closed || this.dkv != null || this.initializing) return;
    if (this.initTimer != null) {
      clearTimeout(this.initTimer);
      this.initTimer = undefined;
    }
    void this.init();
  }

  private async init() {
    if (this.closed || this.dkv != null || this.initializing) return;
    this.initializing = true;
    try {
      // Resolve the project's conat client explicitly (multibay routing
      // rule): collaborators homed on different bays must all open this
      // DKV against the fabric that owns the project, not their own
      // home-bay fallback — otherwise they'd coordinate on different
      // stores and never see each other's builds.
      const client = await webapp_client.conat_client.projectConat({
        project_id: this.project_id,
        caller: "BuildCoordinator",
        requireRouting: true,
      });
      const store = await webapp_client.conat_client.dkv<BuildState>({
        project_id: this.project_id,
        name: "build",
        ephemeral: true,
        client,
      });
      if (this.closed) {
        store.close();
        return;
      }
      this.dkv = store;

      // Subscribe to changes BEFORE reading initial state so we cannot
      // miss a build-start that arrives between snapshot and subscribe.
      this.changeHandler = ({ key, value, prev }) => {
        if (key !== this.path) return;

        if (
          value?.status === "running" &&
          (prev?.status !== "running" || value.buildId !== prev.buildId)
        ) {
          this.handleBuildStart(value);
        } else if (value?.status === "stopping") {
          this.handleBuildStop(value.buildId);
        } else if (value?.status === "finished") {
          this.handleBuildFinished(value.buildId);
        } else if (!value && prev) {
          // Backwards compatibility: older clients used delete as the
          // terminal transition. Keep honoring that if we see it.
          this.handleBuildFinished(prev.buildId);
        }
      };
      this.dkv.on("change", this.changeHandler);

      // Late joiner: if a build is already running, join it.
      // Safe after subscribe — duplicate joins are guarded by isBuilding().
      const current = this.dkv.get(this.path);
      if (current?.status === "running") {
        this.handleBuildStart(current, true);
      }

      // Flush any operations that were buffered while DKV was initializing
      // (e.g., user clicked Build before DKV connected).
      if (this.pendingOps) {
        for (const op of this.pendingOps) {
          op();
        }
      }
      this.pendingOps = undefined;
    } catch (err) {
      if (this.closed) return;
      // Failing here is ordinary: the project is stopped or still starting.
      // Deliberately NOT surfaced to the user — "cannot coordinate builds"
      // would fire for every stopped project, and there is nothing to act
      // on. ensureConnected() retries as soon as the project is back; this
      // timer is only the backstop for a signal we might not observe.
      console.warn("BuildCoordinator: DKV not available yet", err);
      // Buffered ops predate the failure; a retry must not replay them.
      this.pendingOps = undefined;
      this.initTimer = setTimeout(() => {
        this.initTimer = undefined;
        if (this.closed) return;
        void this.init();
      }, INIT_RETRY_MS);
    } finally {
      this.initializing = false;
    }
  }

  // -- Event handlers (replace duplicated code in LaTeX/RMD/QMD actions) --

  private handleBuildStart(state: BuildState, initialSnapshot = false): void {
    const { buildId, aggregate, force, startedAt, sourceRevision } = state;
    if (this.isFromLostRuntime(state, initialSnapshot)) {
      this.terminalizeIfCurrent(state);
      return;
    }
    if (this.callbacks.isBuilding() || buildId === this._localBuildId) {
      return;
    }
    // Stranded-entry protection: if an entry claims to be "running" for
    // longer than the backend could possibly have kept the job alive,
    // the originator must have died without publishing "finished".
    // Joining would re-run the same hang. Treat the entry as terminal,
    // publish "finished" so peers clear too, and skip the join.
    const now = server_time().getTime();
    if (
      typeof startedAt === "number" &&
      now - startedAt > STALE_RUNNING_ENTRY_MS
    ) {
      console.warn(
        `BuildCoordinator: ignoring stale "running" DKV entry for ${this.path} (age=${Math.round((now - startedAt) / 1000)}s, buildId=${buildId})`,
      );
      // Re-read before writing: a newer build from another client may
      // have overwritten the entry between our change event and this
      // set(). Only publish the terminal state if the stale buildId is
      // still the current one — otherwise we'd stomp a fresh "running"
      // with "finished" and make peers skip joining the real build.
      this.terminalizeIfCurrent(state);
      return;
    }
    this._remoteBuildId = buildId;
    void this.joinBuild(buildId, aggregate, force, sourceRevision);
  }

  private isFromLostRuntime(
    state: BuildState,
    initialSnapshot = false,
  ): boolean {
    if (this._runtimeResetAt == null) return false;
    // Older clients did not publish startedAt. After an observed runtime loss
    // an initial timestamp-less entry cannot safely be joined, but later
    // timestamp-less change events must remain compatible with those clients.
    return state.startedAt == null
      ? initialSnapshot
      : state.startedAt <= this._runtimeResetAt;
  }

  private terminalizeIfCurrent(state: BuildState): void {
    const current = this.dkv?.get(this.path);
    if (current?.buildId === state.buildId && current.status === "running") {
      this.dkv?.set(this.path, { ...current, status: "finished" });
    }
  }

  private handleBuildFinished(buildId: string): void {
    if (buildId === this._locallyStoppingBuildId) {
      this._locallyStoppingBuildId = undefined;
    }
    if (buildId === this._remoteBuildId) {
      this._remoteBuildId = undefined;
      // If joinBuild() is still awaiting join(), let its finally block
      // handle setBuilding(false).  Clearing it here would allow a new
      // handleBuildStart to launch a concurrent joinBuild, causing
      // overlapping compiles and inconsistent state.
      if (!this._joining) {
        this.callbacks.setBuilding(false, buildId);
      }
    }
    // Clear _localBuildId on the delete echo so self-echoes of
    // "running" that arrive before the delete are still recognized.
    if (buildId === this._localBuildId) {
      this._localBuildId = undefined;
    }
  }

  private handleBuildStop(buildId: string): void {
    if (buildId === this._locallyStoppingBuildId) return;
    // Honor stop requests from other clients. The requesting client runs its
    // own stop path directly and its DKV echo is filtered above.
    // Only stop if this stop event matches the build we currently track.
    // This prevents stale "stopping" events from a previous build from
    // canceling a newer build that started shortly afterwards.
    const isCurrentBuild =
      buildId === this._localBuildId || buildId === this._remoteBuildId;
    if (isCurrentBuild && this.callbacks.isBuilding()) {
      this.callbacks.stop(buildId);
    }
  }

  private async joinBuild(
    buildId: string,
    aggregate: number | undefined,
    force?: boolean,
    sourceRevision?: number,
  ): Promise<void> {
    if (this.callbacks.isBuilding()) return;
    const generation = ++this._joinGeneration;
    this._joining = true;
    this.callbacks.setBuilding(true, buildId);
    try {
      await this.callbacks.join(
        buildId,
        aggregate,
        force ?? false,
        sourceRevision,
      );
    } catch (err) {
      if (generation === this._joinGeneration) {
        this.callbacks.setError(`${err}`);
      }
    } finally {
      // Runtime loss or a newer join invalidated this invocation. Its build
      // pipeline may still settle, but it no longer owns any lifecycle state.
      if (generation !== this._joinGeneration) return;
      this._joining = false;
      this.callbacks.setBuilding(false, buildId);
      // A replacement build may have been published while we were busy
      // joining this one — handleBuildStart drops starts that arrive
      // while isBuilding() is true, so without this re-check the newer
      // build would be permanently missed (no spinner, no output, no
      // stop capability). Re-read the DKV and join a still-running
      // entry with a *different* buildId. Same-id entries are skipped:
      // re-joining the build we just left could loop forever when the
      // originator is still running.
      if (!this.closed) {
        const current = this.dkv?.get(this.path);
        if (
          current?.status === "running" &&
          current.buildId !== buildId &&
          current.buildId !== this._localBuildId
        ) {
          this.handleBuildStart(current);
        }
      }
      // Note: we intentionally do NOT clean up the DKV entry here if the
      // originator crashed mid-build. Doing so risks prematurely deleting
      // a live entry when the joiner simply finishes faster. Stale entries
      // from crashed originators are handled by the ephemeral DKV's TTL.
      // V2 will coordinate via the project backend for definitive cleanup.
    }
  }

  // -- Public API for initiator builds (called from build() / stop_build()) --

  /**
   * Register a local build ID before publishing to the DKV.
   * Must be called synchronously before publishBuildStart so the
   * DKV self-echo is recognized and filtered out.
   */
  setLocalBuildId(buildId: string): void {
    // A local replacement supersedes any joined build whose async pipeline
    // is still unwinding. Invalidate it before recording the new owner so a
    // late rejection cannot report an error for, or tear down, this build.
    if (this._joining) {
      this._joinGeneration += 1;
      this._joining = false;
    }
    this._remoteBuildId = undefined;
    this._locallyStoppingBuildId = undefined;
    this._localBuildId = buildId;
  }

  /** Announce a build start to all clients via DKV. */
  publishBuildStart(
    buildId: string,
    aggregate: number | undefined,
    force?: boolean,
    sourceRevision?: number,
  ): void {
    const startedAt = server_time().getTime();
    const doPublish = () => {
      this.dkv?.set(this.path, {
        buildId,
        status: "running",
        aggregate,
        force,
        startedAt,
        sourceRevision,
      });
    };
    if (this.dkv) {
      doPublish();
    } else {
      this.pendingOps?.push(doPublish);
    }
  }

  /** Announce build completion. */
  publishBuildFinished(buildId: string): void {
    const doPublish = () => {
      // Only publish "finished" if the current entry matches our buildId —
      // prevents a finishing client from clobbering another client's newer build.
      //
      // IMPORTANT: on ephemeral DKV streams, connected clients may not observe
      // deletes. Use a visible terminal state instead of relying on delete.
      const current = this.dkv?.get(this.path);
      if (!current) {
        // Entry already gone (or was never written) — no self-echo will arrive, so
        // clear _localBuildId immediately.
        if (this._localBuildId === buildId) {
          this._localBuildId = undefined;
        }
      } else if (current.buildId === buildId) {
        this.dkv?.set(this.path, { ...current, status: "finished" });
        // _localBuildId is cleared by handleBuildFinished when the
        // self-echo of "finished" arrives.
      } else {
        // Another client's build overwrote the entry — no self-echo will
        // arrive, so clear _localBuildId now.
        if (this._localBuildId === buildId) {
          this._localBuildId = undefined;
        }
      }
    };
    if (this.dkv) {
      doPublish();
    } else if (this.pendingOps) {
      // Build finished while DKV was still initializing.  Only clear
      // the buffer if no newer build has started — a force-rebuild may
      // have already pushed its own start op that we must preserve.
      if (this._localBuildId === buildId) {
        // No newer build — the buffered start + finish pair is stale.
        this.pendingOps.length = 0;
        this._localBuildId = undefined;
      }
      // else: a newer build overwrote _localBuildId.  Leave the buffer
      // intact so the newer build's start op flushes when DKV inits.
      // The stale start(A) is harmless — start(B) will overwrite it.
    } else {
      // DKV init failed, no buffer — clear immediately.
      if (this._localBuildId === buildId) {
        this._localBuildId = undefined;
      }
    }
  }

  /**
   * Re-read the shared state after a local lifecycle releases the editor's
   * building flag. Starts received while that flag was true are deliberately
   * ignored by handleBuildStart; without this reconciliation a collaborator's
   * replacement build would be missed permanently.
   */
  reconcileRunningBuild(): void {
    if (this.closed || this.callbacks.isBuilding()) return;
    const current = this.dkv?.get(this.path);
    if (
      current?.status === "running" &&
      current.buildId !== this._localBuildId
    ) {
      this.handleBuildStart(current);
    }
  }

  /** Request all clients to stop the current build. */
  requestStop(): void {
    const idToStop = this._localBuildId ?? this._remoteBuildId;
    if (!idToStop) return;
    this._locallyStoppingBuildId = idToStop;
    // The user has released ownership of an active join. Its async pipeline
    // may still unwind after the kill, but it must no longer emit lifecycle
    // errors or completion callbacks into the editor.
    if (this._joining) {
      this._joinGeneration += 1;
      this._joining = false;
    }
    const doPublish = () => {
      const current = this.dkv?.get(this.path);
      if (current?.status === "running" && current.buildId === idToStop) {
        this.dkv?.set(this.path, { ...current, status: "stopping" });
      }
    };
    if (this.dkv) {
      doPublish();
    } else {
      this.pendingOps?.push(doPublish);
    }
  }

  /**
   * Invalidate all build/join state after the project runtime is lost.
   *
   * This is deliberately different from requestStop(): the old runtime is
   * already gone, so broadcasting "stopping" would make clients issue kills
   * against stale PIDs in the replacement runtime. Instead, conditionally
   * terminalize only the DKV entry we tracked, invalidate pending joins, and
   * discard operations buffered for the dead runtime.
   */
  resetRuntimeState(): void {
    this._runtimeResetAt = Math.max(
      this._runtimeResetAt ?? -Infinity,
      server_time().getTime(),
    );
    const trackedIds = new Set(
      [this._localBuildId, this._remoteBuildId].filter(
        (id): id is string => id != null,
      ),
    );

    this._joinGeneration += 1;
    this._joining = false;
    this._localBuildId = undefined;
    this._remoteBuildId = undefined;
    this._locallyStoppingBuildId = undefined;

    if (this.dkv) {
      const current = this.dkv.get(this.path);
      if (
        current != null &&
        (trackedIds.has(current.buildId) ||
          this.isFromLostRuntime(current, true)) &&
        current.status !== "finished"
      ) {
        // Synchronous re-read plus buildId match prevents a runtime-reset
        // callback from overwriting a replacement build published meanwhile.
        this.dkv.set(this.path, { ...current, status: "finished" });
      }
    } else if (this.pendingOps) {
      // Every buffered operation predates the runtime loss. In particular,
      // never flush a stale running state after the replacement runtime starts.
      this.pendingOps.length = 0;
    }
  }

  close(): void {
    this.closed = true;
    this._joinGeneration += 1;
    if (this.initTimer != null) {
      clearTimeout(this.initTimer);
      this.initTimer = undefined;
    }
    // Detach change listener before closing the ref-counted DKV.
    // The DKV may stay alive if other editors in the same project
    // still hold references — without this, stale listeners accumulate.
    const dkv = this.dkv;
    this.dkv = undefined;
    if (this.changeHandler && dkv) {
      dkv.off("change", this.changeHandler);
      this.changeHandler = undefined;
    }
    dkv?.close();
  }
}
