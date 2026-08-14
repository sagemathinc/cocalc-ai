/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Abstract base class shared by R Markdown and Quarto editor actions.
*/

import { delay } from "awaiting";
import { Set } from "immutable";

import { randomId } from "@cocalc/conat/names";
import { type AccountStore } from "@cocalc/frontend/account";
import { ExecuteCodeOutputAsync } from "@cocalc/util/types/execute-code";
import {
  Actions as BaseActions,
  CodeEditorState,
} from "../base-editor/actions-text";
import { FrameTree } from "../frame-tree/types";
import { exec, ExecOutput, server_time } from "../generic/client";
import { BuildCoordinator } from "../generic/build-coordinator";
import { Actions as MarkdownActions } from "../markdown-editor/actions";
import { checkProducedFiles } from "./utils";

// Minimum spacing between converter runs. Successive builds are serialized
// by `is_building` / the pending-build flag; this only prevents immediate
// back-to-back re-runs (e.g. a drained follow-up right after a completed
// build). Unlike the previous leading-edge lodash debounce, a delayed call
// WAITS and then actually runs — the debounce silently swallowed the run
// and made the caller observe the previous run's result.
const CONVERTER_MIN_SPACING_MS = 5 * 1000;

export abstract class MarkdownConverterActions extends MarkdownActions {
  protected _last_hash: number | undefined = undefined;
  protected is_building: boolean = false;
  protected run_converter!: (
    hash?: number,
    buildToken?: string,
  ) => Promise<void>;
  private _lastConverterRun = 0;
  // Bumped by stop_build(); a spacing-runner wait that started under an
  // older epoch returns without running the converter, so Stop actually
  // cancels a delayed run instead of letting it start seconds later.
  private _converterEpoch = 0;
  protected buildCoordinator?: BuildCoordinator;
  private _lastBuiltHash?: number;
  private _buildWasStopped = false;
  // Saved-version hash captured when a joined build started; used instead of
  // the completion-time hash so edits saved *during* the build are not
  // marked as already built.
  private _joinStartedHash?: number;
  // Set when build() is requested while another build is running; the
  // finishing build then triggers one follow-up build so the newer
  // revision is not silently skipped.
  private _pendingBuildRequest = false;
  // Ownership token of the build (local or joined) that currently owns the
  // building state. A build() invocation whose token no longer matches —
  // e.g. it was stopped while parked in the spacing runner and a
  // replacement build started meanwhile — must neither record success nor
  // tear down the replacement's building state in its finally block.
  private _buildToken?: string;
  private _project_started_listener?: () => void;
  private _project_stopped_listener?: () => void;
  private _projectStopObserved = false;

  // Subclasses provide the format-specific build logic and empty-file template.
  protected abstract _run_converter(
    hash?: number,
    buildToken?: string,
  ): Promise<void>;
  protected abstract get minimal_template(): string;

  // Same semantics as the LaTeX editor: in read-only(-preview) contexts we
  // must not initialize converters, create the shared build DKV, or run
  // any builds.
  protected is_read_only_preview(): boolean {
    return this.store?.get("read_only") === true;
  }

  protected do_build_on_save(): boolean {
    const account: AccountStore = this.redux.getStore("account");
    // Default to false until account settings are fully loaded to avoid
    // triggering builds before we know the user's preference.  The store
    // is initialized with schema defaults (build_on_save: true) before
    // is_ready fires, so checking editor_settings != null is not enough.
    if (!account?.get("is_ready")) return false;
    const settings = account.get("editor_settings");
    if (settings == null) return false;
    return settings.get("build_on_save") ?? true;
  }

  protected _init_converter(): void {
    // Serialized min-spacing runner: waits out the remainder of the spacing
    // window and then actually runs the converter. Callers are already
    // serialized through build()'s is_building gate, so at most one of
    // these is in flight.
    this.run_converter = async (hash?, buildToken?) => {
      const epoch = this._converterEpoch;
      if (!this.isBuildOwner(buildToken)) return;
      const wait =
        this._lastConverterRun + CONVERTER_MIN_SPACING_MS - Date.now();
      if (wait > 0) {
        await delay(wait);
        if (this._state === "closed") return;
        // stop_build() bumped the epoch while we were waiting — the user
        // canceled; do not start the converter after the fact.
        if (epoch !== this._converterEpoch) return;
        if (!this.isBuildOwner(buildToken)) return;
      }
      this._lastConverterRun = Date.now();
      await this._run_converter(hash, buildToken);
    };

    // NOTE: deliberately NOT reuseInFlight — the body awaits the entire
    // build, so a wrapped handler would swallow save events that arrive
    // during a build (they'd reuse the running promise and never reach
    // build(), which is what records the pending-build request). The body
    // is synchronous up to the build() call, so concurrent entry is safe:
    // a second event with the same hash returns at the _last_hash check.
    const do_build = async () => {
      // do_build_on_save() returns false when editor_settings is null
      // (account not loaded yet), so early events are safely no-ops.
      // Once settings load, it returns the user's actual preference.
      if (!this.do_build_on_save()) return;
      if (this._syncstring == null) return;
      const hash = this._syncstring.hash_of_saved_version();
      if (this._last_hash != hash) {
        this._last_hash = hash;
        await this.build();
      }
    };

    // Register listeners for build-on-save. These fire on ALL clients
    // (including collaborators), which is intentional — builds are
    // collaborative and all clients should see build output.
    this._syncstring.on("save-to-disk", do_build);
    this._syncstring.on("after-change", do_build);

    // Wait for account settings, seed _last_hash, then optionally auto-build.
    void (async () => {
      const account: AccountStore = this.redux.getStore("account");
      if (!account) return;
      const ready = await account.waitUntilReady();
      if (this._state === "closed") return;
      if (this._syncstring == null) return;

      // Seed _last_hash so the next after-change doesn't treat the
      // already-open file as "changed" on the first keystroke.
      this._last_hash = this._syncstring.hash_of_saved_version();
      if (!ready) return; // timed out — settings not loaded, skip auto-build

      // Initial build: only if build_on_save enabled and no output exists yet.
      if (!this.do_build_on_save()) return;
      const outputs = await this._check_produced_files();
      if (this._state === "closed") return;
      if (this._syncstring == null) return; // closed between awaits
      // Re-seed in case time passed during _check_produced_files.
      this._last_hash = this._syncstring.hash_of_saved_version();
      if (outputs === null) return; // listing unavailable => skip
      if (outputs.size > 0) return; // output already exists => skip
      await this.build();
    })();

    // A project stop or (re)start means any build process that was running
    // is dead. If we still think we are building, the exec stream is
    // orphaned and would keep the UI stuck on "building" until it times
    // out. Reset the build state right away instead. This is reset-ONLY:
    // it must not go through stop_build(), which would kill the recorded
    // PIDs — after a restart those belong to the old runtime and could hit
    // an unrelated process via PID reuse.
    this._project_started_listener = () => {
      // The project is reachable again: an editor opened while it was
      // stopped could not open its coordination DKV back then.
      this.buildCoordinator?.ensureConnected();
      // A normal stop→start transition was already reset by the stopped
      // handler. Do not reset again: a collaborator may have started a valid
      // build in the replacement runtime before this client sees "started".
      if (this._projectStopObserved) {
        this._projectStopObserved = false;
      } else if (this.is_building) {
        // Fallback for clients that missed the stopped edge.
        this.buildCoordinator?.resetRuntimeState();
        this.resetBuildRuntimeState();
      }
    };
    this._project_stopped_listener = () => {
      this._projectStopObserved = true;
      this.buildCoordinator?.resetRuntimeState();
      if (this.is_building) {
        this.resetBuildRuntimeState();
      }
    };
    const projectStore = this.redux.getProjectStore(this.project_id);
    projectStore.on("started", this._project_started_listener);
    projectStore.on("stopped", this._project_stopped_listener);

    this._init_build_coordinator();
  }

  // Reset-only recovery after the project runtime was lost (stop/restart):
  // invalidate build ownership and clear the building UI state WITHOUT
  // issuing any kill into the (new) runtime.
  private resetBuildRuntimeState(): void {
    this._buildToken = undefined;
    this._pendingBuildRequest = false;
    this._buildWasStopped = true;
    this._lastBuiltHash = undefined;
    this._converterEpoch += 1;
    this._lastConverterRun = 0;
    this._joinStartedHash = undefined;
    this.is_building = false;
    this.setState({ building: false });
    this.set_status("");
    // Mark a stale running job as terminated in the UI (no kill — the
    // process died with the old runtime).
    const job_info = this.store.get("job_info")?.toJS() as
      | ExecuteCodeOutputAsync
      | undefined;
    if (job_info?.type === "async" && job_info.status === "running") {
      this.setState({ job_info: { ...job_info, status: "killed" } });
    }
  }

  private _init_build_coordinator(): void {
    this.buildCoordinator = new BuildCoordinator(this.project_id, this.path, {
      join: async (buildId, aggregate, _force, sourceRevision) => {
        // Record the revision the ORIGINATOR captured at build start — not
        // our own local state, which may already be ahead of the originator
        // and would then be wrongly marked as built. Undefined (older
        // client) simply means no last-built revision gets recorded.
        this._joinStartedHash = sourceRevision;
        this._lastConverterRun = Date.now();
        await this._run_converter(aggregate, buildId);
      },
      stop: (buildId) => {
        void this.stop_build("", buildId);
      },
      isBuilding: () => this.is_building,
      setBuilding: (v, buildId) => {
        if (v) {
          // The joined build now owns the building state; a stale local
          // build() invocation returning late must not tear it down.
          this._buildToken = buildId;
          this._buildWasStopped = false;
        } else if (this._buildToken !== buildId) {
          return;
        }
        this.is_building = v;
        this.setState({ building: v });
        if (!v) {
          this._buildToken = undefined;
          if (!this._buildWasStopped && this.buildSucceeded()) {
            // A joined build just completed — track the hash so subsequent
            // no-op builds are skipped (same as originator's build path).
            this._lastBuiltHash = this._joinStartedHash;
          }
          this._joinStartedHash = undefined;
          // A build requested while we were joining must run now — the
          // originator-path finally block never runs for joined builds.
          this.drainPendingBuild();
        }
      },
      setError: (err) => this.set_error(err),
    });
    if (this._projectStopObserved) {
      this.buildCoordinator.resetRuntimeState();
    }
  }

  protected isBuildOwner(buildToken?: string): boolean {
    return buildToken == null || this._buildToken === buildToken;
  }

  // Run the follow-up build recorded while another build (local or joined)
  // was in progress. If the source didn't actually change, the no-op check
  // in build() makes this cheap.
  //
  // Deferred on purpose: when invoked from the coordinator's
  // setBuilding(false) inside joinBuild's finally, the coordinator still
  // has to re-read the DKV for a replacement build. Starting the local
  // build synchronously would mark us busy and make that re-check skip the
  // replacement (the missed-build bug all over again). Deferring lets the
  // replacement join win; if it does, build() re-records the pending flag
  // and this build queues behind the join.
  private drainPendingBuild(): void {
    if (!this._pendingBuildRequest) return;
    setTimeout(() => {
      if (!this._pendingBuildRequest) return; // e.g. cleared by stop_build
      if (this._state === "closed") return;
      this._pendingBuildRequest = false;
      void this.build();
    }, 0);
  }

  async build(id?: string, force: boolean = false): Promise<void> {
    if (this.is_read_only_preview()) return;
    if (id) {
      const cm = this._get_cm(id);
      if (cm) {
        cm.focus();
      }
    }
    // initiating a build. if one is running & forced, we stop the build
    if (this.is_building) {
      if (force) {
        await this.stop_build("");
      } else {
        // Remember that a build was requested — the running build's
        // finally block triggers one follow-up build, so a revision
        // saved during the build is not silently skipped.
        this._pendingBuildRequest = true;
        return;
      }
    }
    const actions = this.redux.getEditorActions(this.project_id, this.path);
    if (actions == null) {
      // opening/close a newly created file can trigger build when actions aren't
      // ready yet.  https://github.com/sagemathinc/cocalc/issues/7249
      return;
    }
    const buildId = randomId();
    // Capture before reset: if previous build was stopped, we need a fresh
    // aggregate to bypass backend dedup (cached partial results).
    const wasStopped = this._buildWasStopped;
    this.is_building = true;
    this._buildWasStopped = false;
    this._buildToken = buildId;
    this.buildCoordinator?.setLocalBuildId(buildId);
    this.setState({ building: true });
    try {
      await (actions as BaseActions<CodeEditorState>).save(false);
      // Stop/runtime reset may have released this build while save was in
      // flight. Never let the stale continuation publish over a replacement.
      if (!this.isBuildOwner(buildId)) return;
      // Capture the revision we are about to build. This — not the
      // completion-time hash — is what gets recorded as "last built":
      // reading the hash again after the build would wrongly mark edits
      // that were saved while the build was running as already built.
      const startedHash = this._syncstring?.hash_of_saved_version() ?? 0;
      const aggregate =
        force || wasStopped ? server_time().valueOf() : startedHash;
      // Skip if hash hasn't changed since last completed build — avoids DKV
      // chatter that causes other clients to flicker their build spinner.
      // Must be AFTER save so hash_of_saved_version() reflects pending edits.
      if (
        !force &&
        this._lastBuiltHash != null &&
        startedHash === this._lastBuiltHash
      ) {
        return; // finally block cleans up is_building / building state
      }
      this.buildCoordinator?.publishBuildStart(
        buildId,
        aggregate,
        force,
        startedHash,
      );
      // For force builds, bypass the spacing runner for immediate execution
      if (force) {
        this._lastConverterRun = Date.now();
        await this._run_converter(aggregate, buildId);
      } else {
        await this.run_converter(aggregate, buildId);
      }
      // Converter failures are reported via state (set_error/build_exit)
      // without throwing, so gate on confirmed success — otherwise a
      // failed build would suppress the next attempt as a "no-op".
      // The ownership check keeps a stale invocation (stopped while parked
      // in the spacing runner, replacement build running now) from
      // recording ITS revision based on the replacement's exit code.
      if (
        this._buildToken === buildId &&
        !this._buildWasStopped &&
        this.buildSucceeded()
      ) {
        this._lastBuiltHash = startedHash;
      }
    } finally {
      // Safe unconditionally: publishBuildFinished is buildId-guarded in
      // the coordinator, so a stale invocation cannot clobber the DKV
      // entry of a replacement build.
      this.buildCoordinator?.publishBuildFinished(buildId);
      // Only the owner of the building state may tear it down — a stale
      // invocation returning late must not flip `building` off (or drain
      // pending work) while a replacement build is running.
      if (this._buildToken === buildId) {
        this._buildToken = undefined;
        this.is_building = false;
        this.setState({ building: false });
        this.buildCoordinator?.reconcileRunningBuild();
        // A build requested while we were busy runs now.
        this.drainPendingBuild();
      }
    }
  }

  // A build is considered successful when the converter reported exit
  // code 0. Converter errors generally do NOT throw — they are recorded
  // in the store — so callers must not assume a non-throwing build worked.
  private buildSucceeded(): boolean {
    return this.store.get("build_exit") === 0;
  }

  // supports the "Force Rebuild" button.
  async force_build(id: string): Promise<void> {
    await this.build(id, true);
  }

  // Stops the current build process and resets state.
  async stop_build(_id: string, expectedBuildToken?: string): Promise<void> {
    // Delayed coordinator events for an older build must not stop the build
    // that currently owns the editor state.
    if (expectedBuildToken != null && this._buildToken !== expectedBuildToken) {
      return;
    }
    this.buildCoordinator?.requestStop();
    // A stopped build didn't complete — clear the "last built" hash so
    // the next build isn't skipped as a no-op.
    this._lastBuiltHash = undefined;
    this._buildWasStopped = true;
    // Stop means stop: also cancel any build queued while the stopped one
    // was running — otherwise the drain would immediately restart it.
    this._pendingBuildRequest = false;
    // Release build ownership: the stopped invocation's finally block must
    // not clean up state that a subsequent build re-claims.
    this._buildToken = undefined;
    // Cancel a spacing-runner wait that is currently in progress …
    this._converterEpoch += 1;
    // … and reset the spacing window so the next build fires immediately.
    this._lastConverterRun = 0;
    const job_info = this.store.get("job_info")?.toJS() as
      | ExecuteCodeOutputAsync
      | undefined;

    if (
      job_info &&
      job_info.type === "async" &&
      job_info.status === "running" &&
      typeof job_info.pid === "number"
    ) {
      try {
        // Kill the process using the same approach as LaTeX editor
        await exec(
          {
            project_id: this.project_id,
            // negative PID, to kill the entire process group
            command: `kill -9 -${job_info.pid}`,
            // bash:true is necessary. kill + array does not work.
            bash: true,
            err_on_exit: false,
          },
          this.path,
        );
      } catch (err) {
        // likely "No such process", we just ignore it
      } finally {
        // Update the job status to killed
        const updated_job_info: ExecuteCodeOutputAsync = {
          ...job_info,
          status: "killed",
        };
        this.setState({ job_info: updated_job_info });
      }
    }
    this.set_status("");
    this.is_building = false;
    this.setState({ building: false });
    this.buildCoordinator?.reconcileRunningBuild();
  }

  async _check_produced_files(): Promise<Set<string> | null> {
    const result = await checkProducedFiles(this);
    if (result != null) {
      this.setState({ derived_file_types: result as any });
    }
    return result;
  }

  protected set_log(output?: ExecOutput | undefined): void {
    this.setState({
      build_err: output?.stderr?.trim(),
      build_log: output?.stdout?.trim(),
      build_exit: output?.exit_code,
      job_info: output?.type === "async" ? output : undefined,
    });
  }

  protected set_job_info(job_info: ExecuteCodeOutputAsync): void {
    if (!job_info) return;
    this.setState({
      build_log: (job_info.stdout ?? "").toString().trim(),
      build_err: (job_info.stderr ?? "").toString().trim(),
      build_exit: job_info.exit_code,
      job_info,
    });
  }

  _raw_default_frame_tree(): FrameTree {
    return {
      direction: "col",
      type: "node",
      first: {
        type: "cm",
      },
      second: {
        type: "node",
        direction: "row",
        first: { type: "iframe" },
        second: { type: "build" },
        pos: 0.8,
      },
    };
  }

  reload(_id?: string, hash?: number) {
    // what is id supposed to be used for?
    // the html editor, which also has an iframe, calls somehow super.reload
    hash = hash || Date.now();
    ["iframe", "pdfjs_canvas", "markdown"].forEach((viewer) =>
      this.set_reload(viewer, hash),
    );
  }

  close(): void {
    this.buildCoordinator?.close();
    const projectStore = this.redux.getProjectStore(this.project_id);
    if (this._project_started_listener != null) {
      projectStore.removeListener("started", this._project_started_listener);
      this._project_started_listener = undefined;
    }
    if (this._project_stopped_listener != null) {
      projectStore.removeListener("stopped", this._project_stopped_listener);
      this._project_stopped_listener = undefined;
    }
    super.close();
  }

  // Never delete trailing whitespace for markdown files.
  delete_trailing_whitespace(): void {}

  protected ensureNonempty() {
    if (this.is_read_only_preview()) return;
    if (this.store && !this.store.get("value")?.trim()) {
      this.set_value(this.minimal_template);
      this.build();
    }
  }
}
