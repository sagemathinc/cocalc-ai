/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
LaTeX Editor Actions.
*/

// cSpell:ignore rtex cmdl ramdisk maketitle documentclass outdirflag latexer rescan

const MINIMAL = `\\documentclass{article}
\\title{Title}
\\author{Author}
\\begin{document}
\\maketitle
\\end{document}
`;

const HELP_SLUG = "latex/build-papers";

// NOTE: These names are the keys in EDITOR_SPEC in editor.ts, not the type field
const VIEWERS = ["pdfjs_canvas", "pdf_embed", "build", "output"] as const;

// CodeMirror gutter id for chat markers and bookmarks; must be listed in
// the cm frame's `gutters` in editor.ts and styled in styles/editor.css.
export const CHAT_GUTTER_ID = "CodeMirror-latex-chat";

import { delay } from "awaiting";
import { message as antdMessage } from "antd";
import * as CodeMirror from "codemirror";
import { fromJS, List, Map as IMap } from "immutable";
import { debounce, union } from "lodash";
import { normalize as path_normalize } from "path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import { randomId } from "@cocalc/conat/names";
import { type AccountStore } from "@cocalc/frontend/account";
import { Store, TypedMap } from "@cocalc/frontend/app-framework";
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";
import {
  Icon,
  TableOfContentsEntry,
  TableOfContentsEntryList,
} from "@cocalc/frontend/components";
import { saveToDiskWithFileServerRetry } from "@cocalc/frontend/frame-editors/base-editor/actions-base";
import {
  Actions as BaseActions,
  CodeEditorState,
} from "@cocalc/frontend/frame-editors/base-editor/actions-text";
import { print_html } from "@cocalc/frontend/frame-editors/frame-tree/print";
import { FrameTree } from "@cocalc/frontend/frame-editors/frame-tree/types";
import { raw_url } from "@cocalc/frontend/frame-editors/frame-tree/util";
import {
  exec,
  project_api,
  server_time,
} from "@cocalc/frontend/frame-editors/generic/client";
import { BuildCoordinator } from "@cocalc/frontend/frame-editors/generic/build-coordinator";
import { ExecOutput } from "@cocalc/util/db-schema/projects";
import {
  change_filename_extension,
  hash_string,
  path_split,
  separate_file_extension,
  sha1,
  splitlines,
  startswith,
} from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import * as tree_ops from "../frame-tree/tree-ops";
import { bibtex } from "./bibtex";
import type {
  BookmarkMarker,
  ChatMarker,
  InvalidChatMarker,
} from "./chat-markers";
import {
  buildBookmarkLine,
  buildInlineInsertion,
  buildMarkerLine,
  generateBookmarkText,
  generateMarkerHash,
  lineHasTexContent,
  removeMarkersForHash,
  replacementMarkerHash,
  scanBookmarks,
  scanInvalidMarkers,
  scanMarkers,
} from "./chat-markers";
import {
  BookmarkGutter,
  ChatMarkerGutter,
  ChatMarkerInlineTail,
  InvalidChatMarkerTail,
} from "./chat-marker-gutter";
// Side-effect import: registers the Insert-menu chat marker/bookmark commands.
import "./chat-marker-command";
import {
  parseThreadAnchor,
  parseThreadResolved,
} from "@cocalc/frontend/chat/anchors";
import {
  ensureSideChatActions,
  getExistingSideChatActions,
} from "@cocalc/frontend/chat/unread";
import { syncdocDiagnosticLog } from "@cocalc/frontend/syncdoc-diagnostics";
import {
  afterNextPaint,
  UxLatencyTrace,
} from "@cocalc/frontend/monitoring/ux-latency-trace";
import { clean } from "./clean";
import { KNITR_EXTS } from "./constants";
import { count_words } from "./count_words";
import { update_gutters } from "./gutters";
import { knitr, knitr_errors, patch_synctex } from "./knitr";
import { IProcessedLatexLog, LatexParser } from "./latex-log-parser";
import {
  build_command,
  Engine,
  fullRebuildCommand,
  get_engine_from_config,
  latexmk,
} from "./latexmk";
import { PDFWatcher } from "./pdf-watcher";
import { pythontex, pythontex_errors } from "./pythontex";
import { sagetex, sagetex_errors, sagetex_hash } from "./sagetex";
import * as synctex from "./synctex";
import {
  interleaveSubfileTocEntries,
  parseTableOfContents,
  type SubfileTocGroup,
} from "./table-of-contents";
import {
  BuildLog,
  BuildLogs,
  BuildSpecName,
  IBuildSpecs,
  ScrollIntoViewMap,
  ScrollIntoViewRecord,
} from "./types";
import { ensureTargetPathIsCorrect, pdf_path } from "./util";

interface LatexEditorState extends CodeEditorState {
  build_logs: BuildLogs;
  sync: string;
  scroll_pdf_into_view: ScrollIntoViewMap;
  word_count: string;
  zoom_page_width: string;
  zoom_page_height: string;
  build_command: string | List<string>;
  knitr: boolean;
  knitr_error: boolean; // true, if there is a knitr problem
  // pythontex_error: boolean;  // true, if pythontex processing had an issue
  includeError?: string;
  build_command_hardcoded?: boolean; // if true, an % !TeX cocalc = ... directive sets the command via the document itself
  contents?: TableOfContentsEntryList; // table of contents data.
  switch_output_to_pdf_tab?: boolean; // used for SyncTeX to switch output panel to PDF tab
  output_panel_id_for_sync?: string; // stores the output panel ID for SyncTeX operations
  // job_infos: JobInfos;
  autoSyncInProgress?: boolean; // unified flag to prevent sync loops - true when any auto sync operation is in progress
  building?: boolean; // true while a build is actively running (mirrors is_building for redux consumers)
  // Chat anchor markers / bookmarks found in the master + open sub-files,
  // keyed by file path.
  chat_markers?: IMap<string, List<TypedMap<ChatMarker>>>;
  invalid_chat_markers?: IMap<string, List<TypedMap<InvalidChatMarker>>>;
  chat_bookmarks?: IMap<string, List<TypedMap<BookmarkMarker>>>;
}

export class Actions extends BaseActions<LatexEditorState> {
  public project_id: string;
  public store: Store<LatexEditorState>;
  private _last_sagetex_hash: string;
  private _last_syncstring_hash: number | undefined;
  private is_building: boolean = false;
  public word_count: (
    time: number,
    force: boolean,
    skipFramePopup?: boolean,
  ) => Promise<void>;
  private is_stopping: boolean = false; // if true, do not continue running any compile jobs
  private buildCoordinator?: BuildCoordinator;
  // Source revision (see sourceRevision) of the last build that COMPLETED
  // successfully; an auto build for the same revision is a no-op.
  private _lastBuiltRevision?: number;
  // Source revision the currently running/most recent build started from,
  // recorded whether or not it succeeded. Only used to decide whether a
  // build requested during that build still has anything new to compile.
  private _lastAttemptedRevision?: number;
  private _buildWasStopped = false;
  // Source revision captured when a joined build started; recording the
  // originator's revision (not our own current one) prevents edits saved
  // during the build from being marked as already built.
  private _joinStartedRevision?: number;
  // Set when a build is requested while another one is running, together
  // with the revision at that moment; the finishing build then triggers one
  // follow-up auto_build, but only if that revision is not what it just
  // compiled.
  private _pendingBuildRequest = false;
  private _pendingBuildRevision?: number;
  // Ownership token of the build (local or joined) that currently owns the
  // building state. A buildInternal invocation whose token no longer
  // matches — e.g. it was stopped and a replacement build started before
  // its run_build settled — must neither record success nor tear down the
  // replacement's building state in its finally block.
  private _buildToken?: string;
  private _project_stopped_listener?: () => void;
  private _projectStopObserved = false;
  // configureBuildCommand bookkeeping: register the syncdb listener once,
  // and never run two resolutions concurrently.
  private _setCmdRegistered = false;
  private _configuringBuild = false;
  private ext: string = "tex";
  private knitr: boolean = false; // true, if we deal with a knitr file
  private filename_knitr: string; // .rnw or .rtex
  private bad_filename: boolean; // true, if the <filename.tex> can't be processed -- see #3230
  // optional engine configuration string -- https://github.com/sagemathinc/cocalc/issues/2839
  private engine_config: Engine | null | undefined = undefined;

  // The output_directory that will be used if we are building
  // and using an output directory.  NOTE: this is a /tmp
  // directory, which we do not explicitly clean up.  However,
  // it gets cleaned up when the project stops (on managed project hosts it
  // is a ramdisk), or by whatever tmp cleaner should probably
  // be installed (say for docker...).  At least the size
  // should be relatively small.
  public output_directory: string | undefined;

  private relative_paths: { [path: string]: string } = {};
  private canonical_paths: { [path: string]: string } = {};
  private parsed_output_log?: IProcessedLatexLog;

  private _last_sync_time = 0;
  private _pdf_watcher_init_token = 0;
  private _project_started_listener?: () => void;

  // PDF file watcher - watches directory for PDF file changes
  private pdf_watcher?: PDFWatcher;

  // Debounced version - initialized in _init2()
  update_pdf: (time: number, force: boolean) => void;

  // Auto-sync function for cursor position changes (forward sync: source → PDF)
  private async handle_cursor_sync_to_pdf(
    line: number,
    column: number,
    filename: string,
  ): Promise<void> {
    if (this.is_auto_sync_in_progress()) {
      return; // Prevent sync loops
    }

    this.set_auto_sync_in_progress(true);
    try {
      await this.synctex_tex_to_pdf(line, column, filename);

      // Fallback: Clear flag after timeout if viewport change doesn't happen
      setTimeout(() => {
        if (this.is_auto_sync_in_progress()) {
          this.set_auto_sync_in_progress(false);
        }
      }, 2000);

      // Note: The autoSyncInProgress flag will be cleared when PDF viewport actually changes
    } catch (error) {
      console.warn("Auto-sync forward search failed:", error);
      // Clear flag on error since viewport won't change
      this.set_auto_sync_in_progress(false);
    }
  }

  private output_directory_path(): string {
    return `/tmp/${sha1(this.path)}`;
  }

  private is_read_only_preview(): boolean {
    return this.store?.get("read_only") === true;
  }

  _init2(): void {
    this.set_gutter = this.set_gutter.bind(this);
    // Debounce update_pdf with 500ms delay, trailing only, has to work when PDF watcher fires during the build
    this.update_pdf = debounce(this._update_pdf.bind(this), 500, {
      leading: false,
      trailing: true,
    });
    this.init_bad_filename();
    this.init_ext_filename(); // safe to set before syncstring init
    this._init_syncstring_value();
    this.init_ext_path(); // must come after syncstring init
    if (this.is_read_only_preview()) {
      this.word_count = async () => {};
      this._syncstring.on(
        "change",
        debounce(this.updateTableOfContents.bind(this), 1500),
      );
      return;
    }
    this.init_latexmk();
    // This breaks browser spellcheck.
    // this._init_spellcheck();
    // init_config is async — it must complete (setting build_command)
    // before the BuildCoordinator is created, otherwise a late-join
    // attempt may fire with an empty build_command and silently bail.
    // Create the coordinator eagerly, like the Rmd/Qmd editors do. It used
    // to be created in init_config().then(...), but init_config awaits the
    // syncdb becoming ready with no deadline: while the project is stopped
    // that promise simply stays pending, so this editor had no coordinator
    // at all — builds ran, no collaborator saw them, and every client
    // spawned its own process. Joining before the build command is known is
    // handled where the problem is, in the join callback.
    this._init_build_coordinator();
    this.init_config().catch((err) => {
      console.warn("LaTeX: init_config failed", err);
    });
    if (!this.knitr) {
      this.output_directory = this.output_directory_path();
    }
    this._syncstring.on(
      "change",
      debounce(this.updateTableOfContents.bind(this), 1500),
    );
    this._syncstring.on(
      "change",
      debounce(this.ensureNonempty.bind(this), 1500),
    );
    // The syncstring going ready means the project became reachable, which
    // is exactly when opening the coordination DKV can succeed.
    this._syncstring.on("ready", () => {
      this.buildCoordinator?.ensureConnected();
      void this.ensureBuildConfig();
    });
    this._project_started_listener = () => {
      void this._handle_project_started();
    };
    // On project stop, any running build process is gone — reset-only
    // (no kill of stale PIDs, see resetBuildRuntimeState).
    this._project_stopped_listener = () => {
      this._projectStopObserved = true;
      this.buildCoordinator?.resetRuntimeState();
      if (this.is_building) {
        this.resetBuildRuntimeState();
      }
    };
    {
      const projectStore = this.redux.getProjectStore(this.project_id);
      projectStore.on("started", this._project_started_listener);
      projectStore.on("stopped", this._project_stopped_listener);
    }
    void this._init_pdf_directory_watcher();
    this.word_count = reuseInFlight(this._word_count.bind(this));
    this._initChatMarkers();
  }

  private async _handle_project_started(): Promise<void> {
    // The project is reachable again: if this editor opened while it was
    // stopped, neither its coordination DKV nor its build command could be
    // resolved back then.
    this.buildCoordinator?.ensureConnected();
    void this.ensureBuildConfig();
    // A project (re)start means any build process that was running is dead.
    // If we still think we are building, the exec stream is orphaned and
    // would keep the UI stuck on "building" until the runJob watchdog
    // fires (~16 min). Reset the build state right away instead.
    if (this._projectStopObserved) {
      // The stopped edge already invalidated the dead runtime. Do not reset
      // twice: a collaborator may have started a valid build in the new
      // runtime before this client processes the started edge.
      this._projectStopObserved = false;
    } else if (this.is_building) {
      // Fallback for clients that missed the stopped edge.
      this.buildCoordinator?.resetRuntimeState();
      this.resetBuildRuntimeState();
    }
    // The PDF preview may have tried to load while the project was still stopped
    // or starting. Once the project is actually running, re-arm the watcher and
    // force a fresh reload so the preview recovers without a full page refresh.
    await this._init_pdf_directory_watcher();
    this.update_pdf(server_time().valueOf(), true);
  }

  // Reset-only recovery after the project runtime was lost (stop/restart):
  // invalidate build ownership and clear the building UI state WITHOUT
  // issuing any kill into the (new) runtime — the recorded PIDs belong to
  // the old runtime and could hit an unrelated process via PID reuse.
  private resetBuildRuntimeState(): void {
    this._buildToken = undefined;
    this._pendingBuildRequest = false;
    this._pendingBuildRevision = undefined;
    this._buildWasStopped = true;
    this._lastBuiltRevision = undefined;
    this._lastAttemptedRevision = undefined;
    this._joinStartedRevision = undefined;
    this.is_building = false;
    this.setState({ building: false });
    this.set_status("");
    // Mark stale running build_logs entries as errored in the UI (no kill —
    // the processes died with the old runtime).
    this.cleanupStaleBuildLogs();
  }

  private _init_build_coordinator(): void {
    if (this.is_read_only_preview()) return;
    this.buildCoordinator = new BuildCoordinator(this.project_id, this.path, {
      join: async (buildId, aggregate, force, sourceRevision) => {
        // Record the revision the ORIGINATOR captured at build start — not
        // our own local state, which may already be ahead of the originator
        // and would then be wrongly marked as built. Undefined (older
        // client) simply means no last-built revision gets recorded.
        this._joinStartedRevision = sourceRevision;
        // A joined build compiles the originator's revision, so a request
        // queued while we join must be judged against that revision too.
        this._lastAttemptedRevision = sourceRevision;
        // The coordinator now exists from the moment the editor opens, so a
        // join can arrive before init_config has produced a build command.
        // run_latex would silently do nothing in that case; wait for it
        // instead, which is what the old "create the coordinator later"
        // ordering was really trying to achieve.
        if (!(await this.waitForBuildCommand())) return;
        await this.run_build(aggregate ?? 0, force, buildId);
      },
      stop: (buildId) => {
        void this.stop_build(undefined, buildId);
      },
      isBuilding: () => this.is_building,
      setBuilding: (v, buildId) => {
        if (v) {
          // The joined build now owns the building state; a stale local
          // buildInternal invocation settling late must not tear it down.
          this._buildToken = buildId;
          this._buildWasStopped = false;
        } else if (this._buildToken !== buildId) {
          return;
        }
        this.is_building = v;
        this.setState({ building: v });
        if (!v) {
          this._buildToken = undefined;
          // When build finishes, clean up any stale running entries in build_logs.
          // This is especially important for joinBuild paths where the exec stream
          // may error without properly finalizing the build_logs entry.
          this.cleanupStaleBuildLogs();
          if (!this._buildWasStopped && !this.store.get("error")) {
            this._lastBuiltRevision = this._joinStartedRevision;
          }
          this._joinStartedRevision = undefined;
          // A build requested while we were joining must run now — the
          // originator-path finally block never runs for joined builds.
          this.drainPendingBuild();
        }
      },
      setError: (err) => this.set_error(err),
    });
    // init_config may settle after the project already stopped. Fence the
    // coordinator before its asynchronous DKV init can join an old entry.
    if (this._projectStopObserved) {
      this.buildCoordinator.resetRuntimeState();
    }
  }

  private isBuildOwner(buildToken?: string): boolean {
    return buildToken == null || this._buildToken === buildToken;
  }

  // init_config sets build_command once the aux syncdb is ready. Bounded
  // because a joined build is only worth running while the originator's
  // process is plausibly still alive.
  private async waitForBuildCommand(
    timeoutMs = 60_000,
  ): Promise<string | List<string> | undefined> {
    const current = this.store.get("build_command");
    if (current) return current;
    try {
      return await this.store.async_wait({
        until: (store) => store.get("build_command"),
        timeout: timeoutMs / 1000,
      });
    } catch {
      return undefined; // timed out or the editor closed
    }
  }

  /**
   * Content revision of everything that goes into a build: the master file
   * plus every dependency (latexmk -deps, via switch_to_files) that is open
   * in this client.
   *
   * Content-based on purpose. The obvious alternative, last_save_time(), is
   * a clock value that propagates asynchronously, so a build and the check
   * that follows it can disagree about the same source. Hashing the saved
   * content of each file cannot drift, and covers the multi-file case: a
   * sub-file edit changes the revision even though the master is untouched.
   *
   * Returns undefined when no hash is available yet (syncstring not ready).
   * Callers must treat that as "unknown" and build rather than skip.
   */
  private sourceRevision(): number | undefined {
    const parts: string[] = [];
    const add = (path: string, actions: any) => {
      const hash = actions?._syncstring?.hash_of_saved_version?.();
      if (hash != null) {
        parts.push(`${path}:${hash}`);
      }
    };
    add(this.path, this);
    const files = this.store.get("switch_to_files");
    if (files != null) {
      for (const path of files) {
        if (path === this.path) continue;
        // Only open files have actions; a dependency nobody opened cannot
        // change under us without its own client triggering a build.
        add(path, this.redux.getEditorActions(this.project_id, path));
      }
    }
    if (parts.length === 0) return undefined;
    parts.sort();
    return hash_string(parts.join("\n"));
  }

  // Run the follow-up build recorded while another build (local or joined)
  // was in progress.
  //
  // Gated on the revision captured when the request was queued: a build
  // saves its own sources, and that save is what makes the syncstring emit
  // "save-to-disk", so every build queues a request for the very revision it
  // is already compiling. Comparing against _lastAttemptedRevision (not
  // _lastBuiltRevision, which is only recorded on success) drops those
  // without also swallowing a retry after a failed build.
  //
  // Deferred on purpose: when invoked from the coordinator's
  // setBuilding(false) inside joinBuild's finally, the coordinator still
  // has to re-read the DKV for a replacement build. Starting the local
  // build synchronously would mark us busy and make that re-check skip the
  // replacement (the missed-build bug all over again). Deferring lets the
  // replacement join win; if it does, buildInternal re-records the pending
  // flag and this build queues behind the join.
  private drainPendingBuild(): void {
    if (!this._pendingBuildRequest) return;
    setTimeout(() => {
      if (!this._pendingBuildRequest) return; // e.g. cleared by stop_build
      if (this._state === "closed") return;
      const revision = this._pendingBuildRevision;
      this._pendingBuildRequest = false;
      this._pendingBuildRevision = undefined;
      if (
        revision != null &&
        this._lastAttemptedRevision != null &&
        revision === this._lastAttemptedRevision
      ) {
        // The build that just ran already compiled this revision.
        return;
      }
      void this.auto_build();
    }, 0);
  }

  // Watch the directory containing the PDF file for changes
  private async _init_pdf_directory_watcher(): Promise<void> {
    if (this.is_read_only_preview()) return;
    const pdfPath = pdf_path(this.path);
    const token = ++this._pdf_watcher_init_token;
    const pdf_watcher = new PDFWatcher(
      this.project_id,
      pdfPath,
      // We ignore the PDFs timestamp (mtime) and use last_save_time for consistency with build-triggered updates
      (_mtime: number, force: boolean) => {
        this.update_pdf(this.last_save_time(), force);
      },
    );
    await pdf_watcher.init();
    // If another watcher init started while we were awaiting, drop this one so
    // we don't keep multiple directory subscriptions alive for the same editor.
    if (token !== this._pdf_watcher_init_token) {
      pdf_watcher.close();
      return;
    }
    this.pdf_watcher?.close();
    this.pdf_watcher = pdf_watcher;
  }

  // similar to jupyter, where an empty document is really
  // confusing, with latex we at least do something to
  // prevent having a truly empty document.
  private ensureNonempty() {
    if (this.is_read_only_preview()) return;
    if (this.store && !this.store.get("value")?.trim()) {
      this.set_value(MINIMAL);
      this.build();
    }
  }

  private init_bad_filename(): void {
    // #3230 two or more spaces
    // note: if there are additional reasons why a filename is bad, add it to the
    // alert msg in run_build.
    this.bad_filename = /\s\s+/.test(this.path);
  }

  private init_ext_filename(): void {
    /* number one reason to check is to detect .rnw/.rtex files */
    const ext = separate_file_extension(this.path).ext;
    if (ext) {
      this.ext = ext.toLowerCase();
      if (KNITR_EXTS.includes(this.ext)) {
        this.knitr = true;
        this.filename_knitr = this.path;
      }
    }
  }

  // conditionally overwrites parent Action class method
  get_spellcheck_path(): string {
    if (this.knitr) {
      return this.filename_knitr;
    } else {
      return super.get_spellcheck_path();
    }
  }

  private init_ext_path(): void {
    if (this.knitr) {
      // changing the path to the (to be generated) tex file makes everything else
      // here compatible with the latex commands
      this.path = change_filename_extension(this.path, "tex");
      this.setState({ knitr: this.knitr, knitr_error: false });
    }
  }

  private is_likely_master(): boolean {
    if (this.not_ready()) return false;
    const s = this._syncstring.to_str();
    return s != null && s.indexOf("\\document") != -1;
  }

  private init_latexmk(): void {
    if (this.is_read_only_preview()) return;
    // NOTE: deliberately NOT reuseInFlight — the handler awaits the entire
    // build, so a wrapped handler would swallow save events that arrive
    // during a build (they'd reuse the running promise and never reach
    // buildInternal, which is what records the pending-build request). The
    // body is synchronous up to the build call, so concurrent entry is
    // safe: a second event with the same content returns at the
    // _last_syncstring_hash check.
    const handlePersistedSourceChange = () => {
      void this.maybeBuildAfterPersistedSourceChange();
    };
    this._syncstring.on("save-to-disk", handlePersistedSourceChange);
    this._syncstring.on("filesystem-change", handlePersistedSourceChange);
  }

  private async maybeBuildAfterPersistedSourceChange(): Promise<void> {
    if (this.is_read_only_preview()) return;
    if (this.not_ready()) return;
    const account: AccountStore = this.redux.getStore("account");
    if (
      !account?.get("is_ready") ||
      !account.getIn(["editor_settings", "build_on_save"])
    ) {
      return;
    }
    const value = this._syncstring.to_str();
    if (value == null) return;
    const hash = hash_string(value);
    if (this._last_syncstring_hash === hash) {
      return;
    }
    this._last_syncstring_hash = hash;
    // there are two cases: the parent "master" file triggers the build (usual case)
    // or an included dependency – i.e. where parent_file is set
    if (this.parent_file != null && this.parent_file != this.path) {
      const parent_actions = this.redux.getEditorActions(
        this.project_id,
        this.parent_file,
      ) as Actions;
      // we're careful, maybe getEditorActions returns something else ...
      await parent_actions?.auto_build?.("");
    } else if (this.parent_file == null && this.is_likely_master()) {
      // also check is_likely_master, b/c there must be a \\document* command.
      await this.auto_build("");
    }
  }

  public async rescan_latex_directive(): Promise<void> {
    // make this false since this is only called when user explicitly requests it, so it
    // should scan for all options.
    await this.init_build_directive(false);
  }

  /**
   * we check the first ~1000 lines for
   * % !TeX program = xelatex | pdflatex | ...
   * % !TeX cocalc = the exact command line
   */
  public async init_build_directive(cocalcOnly = false): Promise<void> {
    if (this.is_read_only_preview()) return;
    // check if there is an engine configured
    // https://github.com/sagemathinc/cocalc/issues/2839
    if (this.engine_config !== undefined) return;

    // Wait until the syncstring is loaded from disk. During fast-open and
    // reconnects it can be non-ready without being in the old "init" state.
    if (!(await this.wait_until_syncdoc_ready(this._syncstring))) {
      return;
    }

    let program = ""; // later, might contain the !TeX program build directive
    let cocalc_cmd = ""; // later, might contain the cocalc command

    const s = this._syncstring.to_str();
    let line: string;
    let lineNo = 0;
    for (line of splitlines(s)) {
      lineNo += 1;
      if (lineNo > 1000) break;
      if (!startswith(line, "%")) continue;
      const i = line.indexOf("=");
      if (i == -1) continue;
      // we match on lower case and normalize all spaces
      const directive = line
        .slice(0, i)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      if (
        !cocalcOnly &&
        (startswith(directive, "% !tex program") ||
          startswith(directive, "% !tex ts-program"))
      ) {
        program = line.slice(i + 1).trim();
      } else if (startswith(directive, "% !tex cocalc")) {
        cocalc_cmd = line.slice(i + 1).trim();
      }
      if (cocalc_cmd || (cocalc_cmd && program)) break;
    }

    // cocalc command takes precedence!
    if (cocalc_cmd) {
      // once set, it will be sanitized upon the next syncdb change event
      this.set_build_command(cocalc_cmd);
      this.setState({ build_command_hardcoded: true });
    } else if (program) {
      // get_engine_from_config picks an "Engine" we know of via lower-case match
      this.engine_config = get_engine_from_config(program);
      if (this.engine_config != null) {
        // Now set the build command to what is configured.
        this.set_build_command(
          build_command(
            this.engine_config,
            path_split(this.path).tail,
            this.knitr,
            this.output_directory,
          ),
        );
      }
      this.setState({ build_command_hardcoded: false });
    } else {
      this.setState({ build_command_hardcoded: false });
    }
  }

  private async init_config(): Promise<void> {
    this.setState({ build_command: "" }); // empty means not yet initialized

    // .rnw/.rtex files: we aux-syncdb them, not the autogenerated .tex file
    const path: string = this.knitr ? this.filename_knitr : this.path;
    this._init_syncdb(["key"], undefined, path);

    if (!(await this.configureBuildCommand())) return;
    await this.initialBuildOnOpen();
  }

  /**
   * Resolve the build command: honor a `% !TeX ...` directive, then track
   * the aux syncdb.
   *
   * Separate from init_config, and re-runnable, because it depends on the
   * project: the syncdb only becomes ready once the project is reachable.
   * An editor opened while the project was stopped used to give up here for
   * good, leaving build_command empty forever — such a client can neither
   * build nor join a collaborator's build, silently. ensureBuildConfig()
   * runs it again when the project comes back.
   *
   * Returns false if it bailed out (not ready, or the editor closed).
   */
  private async configureBuildCommand(): Promise<boolean> {
    if (this._syncdb == null) return false;
    // Waits without a deadline: resolves when the project is reachable.
    if (!(await this.wait_until_syncdoc_ready(this._syncdb))) return false;
    if (this._state == "closed" || this._syncdb == null) return false;

    // If the build command is NOT already set in syncdb, look for
    // "% !TeX program =" and set the build command from that.
    if (this._syncdb.get_one({ key: "build_command" }) == null) {
      await this.init_build_directive();
      if (this._state == "closed") return false;
    } else {
      // this scans for the "cocalc" directive, which hardcodes the build command
      await this.init_build_directive(true);
    }

    // Also, whenever the syncdb changes or loads, we load the build
    // command from there, if it is explicitly set there.  This takes
    // precedence over the "% !TeX program =".
    const set_cmd = (): void => {
      if (this._syncdb == null) throw Error("syncdb must be defined");
      const x = this._syncdb.get_one({ key: "build_command" });

      if (x !== undefined && x.get("value") !== undefined) {
        const cmd: List<string> | string = x.get("value");
        if (typeof cmd === "string") {
          // #3159
          if (cmd.length > 0) {
            const build_command = this.sanitize_build_cmd_str(cmd);
            this.setState({ build_command });
            this.set_build_command(build_command);
            return;
          }
          // https://github.com/sagemathinc/cocalc/issues/6397
        } else if (List.isList(cmd) && cmd.size > 0) {
          // It's an array so the output-directory option should be
          // set; however, it's possible it isn't in case this is
          // an old document that had the build_command set before
          // we implemented output directory support.
          const build_command: List<string> = this.sanitize_build_cmd(cmd);
          this.setState({ build_command });
          this.set_build_command(build_command.toJS());
          return;
        }
      }

      // fallback
      this.set_default_build_command();
    };

    set_cmd();
    if (!this._setCmdRegistered) {
      this._syncdb.on("change", set_cmd);
      this._setCmdRegistered = true;
    }
    return true;
  }

  // Re-resolve the build command if we still do not have one. Called on the
  // signals that mean the project became reachable.
  private async ensureBuildConfig(): Promise<void> {
    if (this._state === "closed") return;
    if (this.store.get("build_command")) return;
    if (this._configuringBuild) return;
    this._configuringBuild = true;
    try {
      await this.configureBuildCommand();
    } catch (err) {
      console.warn("LaTeX: configureBuildCommand failed", err);
    } finally {
      this._configuringBuild = false;
    }
  }

  private async initialBuildOnOpen(): Promise<void> {
    if (this.is_likely_master() && !this.is_read_only_preview()) {
      // Only build on open if:
      // - account settings are confirmed loaded (is_ready)
      // - build_on_save is enabled
      // - output PDF does not yet exist (null = unknown => skip)
      const account: AccountStore = this.redux.getStore("account");
      if (!account) return;
      const ready = await account.waitUntilReady();
      if (this._state === "closed") return;
      if (!ready) return; // timed out — settings not loaded, skip auto-build
      const buildOnSave =
        account.getIn(["editor_settings", "build_on_save"]) ?? true;
      if (!buildOnSave) return;
      const pdfExists = await this.outputFileExists(pdf_path(this.path));
      if (this._state === "closed") return;
      if (pdfExists !== false) return; // exists or unknown => don't build
      this.force_build();
    }
  }

  // Tri-state: true = file exists, false = confirmed absent, null = unknown/error (skip auto-build)
  private async outputFileExists(filePath: string): Promise<boolean | null> {
    try {
      return await this.fs().exists(filePath);
    } catch {
      return null;
    }
  }

  private set_default_build_command(): string[] {
    const default_cmd = build_command(
      this.engine_config || "PDFLaTeX",
      path_split(this.path).tail,
      this.knitr,
      this.output_directory,
    );
    this.setState({ build_command: fromJS(default_cmd) });
    return default_cmd;
  }

  private output_directory_cmd_flag(output_dir?: string): string {
    // maybe at some point we want to wrap this in ''
    const dir = output_dir != null ? output_dir : this.output_directory;
    return `-output-directory=${dir}`;
  }

  public sanitize_build_cmd_str(cmd: string): string {
    if (cmd.indexOf(";") != -1) {
      // if there is a semicolon we allow anything...
      return cmd;
    }
    // This is when users manually set the command or possibly slightly edited it.
    // It's very important NOT to ignore the output directory part!!! See #5183,
    // where we see ignoring this leads to massive problems.

    // Make sure the output directory matches what we are actually using (the sha1 hash).
    const i = cmd.indexOf("-output-directory=");
    if (i != -1) {
      let j = cmd.indexOf(" ", i);
      if (j == -1) {
        // at the end
        j = cmd.length;
      }
      if (this.output_directory) {
        // ensure it is set properly
        if (
          cmd.slice(i + "-output-directory=".length, j) != this.output_directory
        ) {
          cmd =
            cmd.slice(0, i) +
            `-output-directory=${this.output_directory} ` +
            cmd.slice(j);
        }
      } else {
        // ensure it is NOT set since it will definitely break things
        cmd = cmd.slice(0, i) + cmd.slice(j);
      }
    }

    //console.log("before", { cmd });
    cmd = ensureTargetPathIsCorrect(cmd, path_split(this.path).tail);
    //console.log("after", { cmd });

    // We also focus on setting -deps for latexmk
    if (!cmd.trim().startsWith("latexmk")) return cmd;
    // -dependents- or -deps- ← don't shows the dependency list, we remove these
    // surrounded with spaces, to reduce changes of wrong matches
    for (const bad of [" -dependents- ", " -deps- "]) {
      if (cmd.indexOf(bad) !== -1) {
        cmd = cmd.replace(bad, " ");
      }
    }
    if (cmd.indexOf(" -deps ") !== -1) return cmd;
    const cmdl = cmd.split(" ");
    // assume latexmk -pdf [insert here] ...
    cmdl.splice(2, 0, "-deps");
    return cmdl.join(" ");
  }

  private sanitize_build_cmd(cmd: List<string>): List<string> {
    // special case "false", to disable processing
    if (cmd.get(0)?.startsWith("false")) {
      return cmd;
    }

    // Next, we ensure the output directory is correct.
    let outdir: string | undefined = undefined;
    let i: number = -1;
    for (const x of cmd) {
      i += 1;
      if (startswith(x, "-output-directory=")) {
        outdir = x;
        break;
      }
    }
    // only bother tweaking/adding the output directory, if it exists in the first place
    if (outdir != null) {
      if (this.output_directory != null) {
        // make sure it is right
        const should_be = this.output_directory_cmd_flag();
        if (outdir != should_be) {
          cmd = cmd.set(i, should_be);
        }
      } else {
        // remove it, if there is none set
        cmd = cmd.delete(i);
      }
    }

    // -dependents- or -deps- ← don't shows the dependency list, we remove these
    for (const bad of ["-dependents-", "-deps-"]) {
      const idx = cmd.indexOf(bad);
      if (idx !== -1) {
        cmd = cmd.delete(idx);
      }
    }
    // and then we make sure -deps or -dependents exists
    if (!cmd.some((x) => x === "-deps" || x === "-dependents")) {
      cmd = cmd.splice(3, 0, "-deps");
    }

    // Finally make sure the filename is right.
    const filename = path_split(this.path).tail;
    if (filename != cmd.get(cmd.size - 1)) {
      cmd = cmd.set(cmd.size - 1, filename);
    }

    return cmd;
  }

  // disable the output directory for pythontex and sagetex.
  // the main reason is that it is likely to process files, load py modules or generated images.
  // compiling tex in a tmp dir breaks all the paths. -- https://github.com/sagemathinc/cocalc/issues/4394
  // returns true, if it really made a change.
  private ensure_output_directory_disabled(): boolean {
    this.output_directory = undefined;

    // at this point we know that this.init_config already ran and set a build command
    if (this._syncdb == null) throw Error("syncdb must be defined");
    const x = this._syncdb.get_one({ key: "build_command" });
    if (x == null) return false; // should not happen

    const old_cmd: List<string> | string = x.get("value");
    let new_cmd: string[] | string =
      typeof old_cmd === "string" ? old_cmd : old_cmd.toJS();

    // fortunately, we know exactly what we have to remove
    const outdirflag = this.output_directory_cmd_flag(
      this.output_directory_path(),
    );

    let change = false;
    if (typeof old_cmd === "string") {
      const i = old_cmd.indexOf(outdirflag);
      if (i >= 0) {
        change = true;
        const before = old_cmd.slice(0, i);
        const after = old_cmd.slice(i + outdirflag.length);
        new_cmd = `${before}${after}`;
      }
    } else {
      const tmp = old_cmd.filter((x) => x != outdirflag);
      change = !tmp.equals(old_cmd);
      new_cmd = tmp.toJS();
    }

    //console.log("ensure_output_directory_disabled new_cmd", new_cmd, change);
    // don't wrap this in if-change, weird corner cases
    this.set_build_command(new_cmd);
    return change;
  }

  // Source on the left, the unified output panel on the right.
  _raw_default_frame_tree(): FrameTree {
    return {
      type: "node",
      direction: "col",
      first: { type: "cm" },
      second: { type: "output" },
      pos: 0.5,
    };
  }

  // Frame types (EDITOR_SPEC keys) that already display build errors.
  // https://github.com/sagemathinc/cocalc/issues/8659
  private static ERROR_DISPLAY_FRAMES = ["output", "build", "error"] as const;

  private hasErrorDisplayFrame(): boolean {
    try {
      const tree = this._get_tree();
      for (const id in this._get_leaf_ids()) {
        const node = tree_ops.get_node(tree, id);
        if (
          node != null &&
          (Actions.ERROR_DISPLAY_FRAMES as readonly string[]).includes(
            node.get("type"),
          )
        ) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  check_for_fatal_error(): void {
    const build_logs: BuildLogs = this.store.get("build_logs");
    if (!build_logs) return;
    const errors = build_logs.getIn(["latex", "parse", "errors"]) as any;
    if (errors === undefined || errors.size < 1) return;
    const last_error = errors.get(errors.size - 1);
    let s = last_error.get("message") + last_error.get("content");
    if (s.indexOf("no output PDF") != -1) {
      // parse out the most relevant part of message...
      let i = s.indexOf("Fatal error");
      if (i !== -1) {
        s = s.slice(i);
      }
      i = s.indexOf("!");
      if (i != -1) {
        s = s.slice(0, i + 1);
      }
      const err =
        "WARNING: It is not possible to generate a useful PDF file.\n" +
        s.trim();
      console.warn(err);
      // Only show toast if no error-displaying frame is visible —
      // if one is, the user can already see the problem there.
      if (!this.hasErrorDisplayFrame()) {
        this.set_error(err);
      }
    }
  }

  private get_streamed_latex_output(): BuildLog | undefined {
    const log = this.store.getIn(["build_logs", "latex"]) as any;
    const output = typeof log?.toJS === "function" ? log.toJS() : log;
    if (output == null || typeof output !== "object") return;
    if (!`${output.stdout ?? ""}`.trim() && !`${output.stderr ?? ""}`.trim()) {
      return;
    }
    return {
      ...output,
      time: typeof output.time === "number" ? output.time : Date.now(),
    } as BuildLog;
  }

  private is_generic_latex_transport_error(err: unknown): boolean {
    let message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : `${(err as any)?.message ?? err ?? ""}`;
    message = message
      .replace(/^unable to run the compilation\.?\s*/i, "")
      .replace(/^error\s*:?\s*/i, "")
      .replace(/\.+$/, "")
      .trim()
      .toLowerCase();
    return (
      !message ||
      message === "an error occurred" ||
      message === "error occurred"
    );
  }

  _forget_pdf_document(): void {
    void import("./pdfjs-doc-cache").then(({ forgetDocument, url_to_pdf }) => {
      forgetDocument(
        url_to_pdf(
          this.project_id,
          this.path,
          this.store.unsafe_getIn(["reload", VIEWERS[0]]),
        ),
      );
    });
  }

  close(): void {
    this._pdf_watcher_init_token += 1;
    this._forget_pdf_document();
    this.buildCoordinator?.close();
    {
      const projectStore = this.redux.getProjectStore(this.project_id);
      if (this._project_started_listener != null) {
        projectStore.removeListener("started", this._project_started_listener);
        this._project_started_listener = undefined;
      }
      if (this._project_stopped_listener != null) {
        projectStore.removeListener("stopped", this._project_stopped_listener);
        this._project_stopped_listener = undefined;
      }
    }
    if (this.pdf_watcher != null) {
      this.pdf_watcher.close();
      this.pdf_watcher = undefined;
    }
    for (const handle of Object.values(this._chatMarkerScanners)) {
      handle.dispose();
    }
    this._chatMarkerScanners = {};
    this._disposeChatGutterUI();
    this._chatMarkerStoreDispose?.();
    this._chatMarkerStoreDispose = undefined;
    this._chatStoreDispose?.();
    this._chatStoreDispose = undefined;
    this._diskChatScanRefresh?.cancel();
    this._diskChatScanRefresh = undefined;
    this._diskSubfileHeadings.clear();
    super.close();
  }

  private _disposeChatGutterUI(): void {
    for (const cache of [this._chatGutterHosts, this._bookmarkGutterHosts]) {
      for (const perCm of Object.values(cache)) {
        for (const [cm, entries] of perCm) {
          for (const entry of entries) {
            try {
              cm.setGutterMarker(entry.line, CHAT_GUTTER_ID, null);
              entry.root.unmount();
            } catch {
              // The CodeMirror pane may already be gone.
            }
          }
        }
      }
    }
    for (const perCm of Object.values(this._cursorInsertHosts)) {
      for (const [cm, entry] of perCm) {
        try {
          if (entry.currentHandle != null) {
            cm.setGutterMarker(entry.currentHandle, CHAT_GUTTER_ID, null);
          }
          entry.chatRoot.unmount();
          entry.bookmarkRoot.unmount();
        } catch {
          // The CodeMirror pane may already be gone.
        }
      }
    }
    this._chatGutterHosts = {};
    this._bookmarkGutterHosts = {};
    this._cursorInsertHosts = {};
    this._bookmarkLines = {};
    for (const perCm of Object.values(this._chatTextMarkers)) {
      for (const markers of perCm.values()) {
        for (const marker of markers) {
          marker.clear();
        }
      }
    }
    this._chatTextMarkers = {};
    for (const perCm of Object.values(this._chatTailHosts)) {
      for (const tails of perCm.values()) {
        for (const tail of tails) {
          tail.bookmark.clear();
          tail.root.unmount();
        }
      }
    }
    this._chatTailHosts = {};
  }

  // supports the "Force Rebuild" button.
  async force_build(id?: string): Promise<void> {
    if (this.is_read_only_preview()) return;
    await this.build(id, true);
  }

  private all_actions(): BaseActions<CodeEditorState>[] {
    const files = this.store.get("switch_to_files");
    if (files == null || files.size <= 1) {
      return [this as BaseActions<CodeEditorState>];
    }
    const v: BaseActions<CodeEditorState>[] = [];
    for (const path of files) {
      const actions = this.redux.getEditorActions(
        this.project_id,
        path,
      ) as BaseActions<CodeEditorState>;
      if (actions == null) continue;
      // the parent (master) file is in the switch_to_files list!
      if (this.path != path) {
        actions.set_parent_file(this.path);
      }
      v.push(actions);
    }
    return v;
  }

  // Ensure that all files that are open on this client
  // and needed for building the main file are saved to disk.
  // TODO: this could get moved up to the base class, when
  // switch_to_files is moved.
  private async save_all(explicit: boolean): Promise<void> {
    if (this.is_read_only_preview()) return;
    for (const actions of this.all_actions()) {
      await actions.save(explicit);
    }
  }

  public async explicit_save() {
    if (this.is_read_only_preview()) return;
    const account = this.redux.getStore("account");
    if (
      !account?.getIn(["editor_settings", "build_on_save"]) ||
      !this.is_likely_master()
    ) {
      // kicks off a save of all relevant files
      // Obviously, do not make this save_all(true), because
      // that would end up calling this very function again
      // crashing the browser in an INFINITE RECURSION
      // (this was a bug for a while!).
      // Also, the save of the related files is NOT
      // explicit -- the user is only explicitly saving this
      // file.  Explicit save is mainly about deleting trailing
      // whitespace and launching builds.
      await this.save_all(false);
      return;
    }
    // auto_build, NOT build: Ctrl-S is "save, then build if the source
    // actually changed". build() takes a fresh aggregate, which bypasses
    // both the no-op check and the cross-client dedup, so routing Ctrl-S
    // through it made every save start a private latexmk run — and the
    // save this build performs itself then queued a second one.
    await this.auto_build();
  }

  private async buildInternal(
    id: string | undefined,
    force: boolean,
    useFreshAggregate: boolean,
  ): Promise<void> {
    if (this.is_read_only_preview()) return;
    this.set_error("");
    this.set_status("");
    if (id) {
      const cm = this._get_cm(id);
      if (cm) {
        cm.focus();
      }
    }
    // initiating a build. if one is running & forced, we stop the build
    if (this.is_building) {
      if (force) {
        await this.stop_build();
      } else {
        // Remember that a build was requested — the running build's
        // finally block triggers one follow-up auto_build, so a revision
        // saved during the build is not silently skipped. drainPendingBuild
        // compares this revision against what that build compiled.
        this._pendingBuildRequest = true;
        this._pendingBuildRevision = this.sourceRevision();
        return;
      }
    }
    const buildTrace = new UxLatencyTrace({
      event_type: "latex_build",
      project_id: this.project_id,
      source: force ? "force_build" : "build",
      surface_visible: true,
      stale_after_ms: 10 * 60_000,
      sample_successes: true,
    });
    const buildId = randomId();
    // Capture before reset: if previous build was stopped, we need a fresh
    // timestamp to bypass backend aggregate dedup (cached partial results).
    const wasStopped = this._buildWasStopped;
    this.is_building = true;
    this._buildWasStopped = false;
    this._buildToken = buildId;
    this.setState({ building: true });
    this.buildCoordinator?.setLocalBuildId(buildId);
    try {
      await this.save_all(false);
      // Stop/runtime reset may have released this build while save_all was in
      // flight. Never let the stale continuation publish over a replacement.
      if (!this.isBuildOwner(buildId)) return;
      buildTrace.mark("sources_saved");
      // Capture the revision we are about to build. This — not the
      // completion-time value — is what gets recorded as "last built":
      // reading it again after the build would wrongly mark edits saved
      // while the build was running as already built. Must be AFTER save,
      // so it hashes what actually landed on disk.
      const revision = this.sourceRevision();
      // The aggregate stays a timestamp: it is what makes two clients share
      // one latexmk process, and last_save_time() is the same value on both.
      const time =
        force || wasStopped || useFreshAggregate
          ? server_time().valueOf()
          : this.last_save_time();
      // Skip if nothing changed since last build — avoids DKV chatter that
      // causes other clients to flicker their build spinner for a no-op.
      // An unknown revision (undefined) never skips.
      if (
        !force &&
        !useFreshAggregate &&
        revision != null &&
        revision === this._lastBuiltRevision
      ) {
        return; // finally block cleans up is_building / building state
      }
      this._lastAttemptedRevision = revision;
      this.buildCoordinator?.publishBuildStart(buildId, time, force, revision);
      await this.run_build(time, force, buildId);
      // run_build failures are often reported via set_error without
      // throwing; buildInternal cleared the error at the start, so a
      // non-empty error here means THIS build failed — don't record it
      // as built or the next attempt would be skipped as a no-op.
      // The ownership check keeps a stale invocation (stopped, replacement
      // build running now) from recording ITS revision as built.
      if (
        this._buildToken === buildId &&
        !this._buildWasStopped &&
        !this.store.get("error")
      ) {
        this._lastBuiltRevision = revision;
      }
      buildTrace.mark("build_pipeline_done");
      afterNextPaint(() => {
        buildTrace.record("latex_build_complete_v2", {
          path_ext: "tex",
          editor: "latex",
          segment: force ? "forced" : "normal",
          surface_visible: true,
          details: {
            preview_refresh_requested: true,
          },
        });
      });
    } catch (err) {
      // A stopped invocation may reject after its replacement has started.
      // It no longer owns the error surface and must never stop the owner.
      if (!this.isBuildOwner(buildId)) return;
      buildTrace.record("latex_build_failed_v2", {
        path_ext: "tex",
        editor: "latex",
        segment: force ? "forced" : "normal",
        surface_visible: true,
        details: {
          error_name: err instanceof Error ? err.name : "unknown",
        },
      });
      this.set_error(`${err}`);
      // if there is an error, we issue a stop, but keep the build logs
      await this.stop_build();
    } finally {
      // Safe unconditionally: publishBuildFinished is buildId-guarded in
      // the coordinator, so a stale invocation cannot clobber the DKV
      // entry of a replacement build.
      this.buildCoordinator?.publishBuildFinished(buildId);
      // Only the owner of the building state may tear it down — a stale
      // invocation settling late must not flip `building` off (or drain
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

  // used by generic framework – this is bound to the instance, otherwise "this" is undefined, hence
  // make sure to use an arrow function!
  build = async (id?: string, force: boolean = false): Promise<void> => {
    await this.buildInternal(id, force, true);
  };

  private async auto_build(id?: string): Promise<void> {
    await this.buildInternal(id, false, false);
  }

  async clean(): Promise<void> {
    if (this.is_read_only_preview()) return;
    await this.build_action("clean");
  }

  private async kill(job: ExecOutput): Promise<ExecOutput> {
    if (job.type !== "async") return job;
    const { pid, status } = job;
    if (status === "running" && typeof pid === "number") {
      try {
        await exec(
          {
            project_id: this.project_id,
            // negative PID, to kill the entire process group
            command: `kill -9 -${pid}`,
            // bash:true is necessary. kill + array does not work. IDK why.
            bash: true,
            err_on_exit: false,
          },
          this.path,
        );
      } catch (err) {
        // likely "No such process", we just ignore it
      } finally {
        // set this build log to be no longer running
        job.status = "killed";
      }
    }
    return job;
  }

  // This stops all known jobs with a status "running" and resets the state.
  async stop_build(_id?: string, expectedBuildToken?: string) {
    if (expectedBuildToken != null && this._buildToken !== expectedBuildToken) {
      return;
    }
    this.buildCoordinator?.requestStop();
    // A stopped build didn't complete — clear the "last built" revision so
    // the next build isn't skipped as a no-op.
    this._lastBuiltRevision = undefined;
    this._lastAttemptedRevision = undefined;
    this._buildWasStopped = true;
    // Stop means stop: also cancel any build queued while the stopped one
    // was running — otherwise the drain would immediately restart it.
    this._pendingBuildRequest = false;
    this._pendingBuildRevision = undefined;
    // Release build ownership: the stopped invocation's finally block must
    // not clean up state that a subsequent build re-claims.
    this._buildToken = undefined;
    const build_logs = this.store.get("build_logs");
    try {
      this.is_stopping = true;
      if (build_logs) {
        for (const [name, job] of build_logs) {
          // this.kill returns the job with a modified status, it's not the kill exec itself
          this.set_build_logs({ [name]: await this.kill(job.toJS()) });
        }
      }
    } finally {
      this.set_status("");
      this.is_building = false;
      this.setState({ building: false });
      this.is_stopping = false;
      this.buildCoordinator?.reconcileRunningBuild();
    }
  }

  private async run_build(
    time: number,
    force: boolean,
    buildToken?: string,
  ): Promise<void> {
    if (this.is_stopping || !this.isBuildOwner(buildToken)) return;
    // reset state of build_logs, since it is a fresh start
    this.setState({ build_logs: IMap() });

    if (this.bad_filename) {
      const err = `ERROR: It is not possible to compile this LaTeX file with the name '${this.path}'.
        Please modify the filename, such that it does **not** contain two or more consecutive spaces.`;
      this.set_error(err);
      return;
    }

    // for knitr related documents, we have to first build the derived tex file ...
    if (this.knitr) {
      await this.run_knitr(time, force, buildToken);
      if (!this.isBuildOwner(buildToken)) return;
      if (this.store.get("knitr_error")) return;
    }
    // update word count asynchronously
    let run_word_count: any = null;
    if (this._has_frame_of_type("word_count")) {
      run_word_count = this.word_count(time, force);
    }
    // update_pdf=false, because it is deferred until the end
    await this.run_latex(time, force, false, buildToken);
    if (!this.isBuildOwner(buildToken)) return;
    // ... and then patch the synctex file to align the source line numberings
    if (this.knitr) {
      await this.run_patch_synctex(time, force, buildToken);
      if (!this.isBuildOwner(buildToken)) return;
    }

    const s = this.store.unsafe_getIn(["build_logs", "latex", "stdout"]);
    let update_pdf = true;
    if (typeof s == "string") {
      const is_sagetex = s.indexOf("sagetex.sty") != -1;
      const is_pythontex =
        s.indexOf("pythontex.sty") != -1 || s.indexOf("PythonTeX") != -1;
      if (is_sagetex || is_pythontex) {
        if (this.ensure_output_directory_disabled()) {
          // rebuild if build command changed
          await this.run_latex(time, true, false, buildToken);
          if (!this.isBuildOwner(buildToken)) return;
        }
        update_pdf = false;
        if (is_sagetex) {
          await this.run_sagetex(time, force, buildToken);
          if (!this.isBuildOwner(buildToken)) return;
        }
        // don't make this an else-if: audacious latexer might want to run both o_O
        if (is_pythontex) {
          await this.run_pythontex(time, force, buildToken);
          if (!this.isBuildOwner(buildToken)) return;
        }
      }
    }

    // we suppress a cycle of loading the PDF if sagetex or pythontex runs above
    // because these two trigger a rebuild and update_pdf on their own at the end
    if (update_pdf && this.isBuildOwner(buildToken)) {
      this.update_pdf(time, force);
    }

    if (run_word_count != null) {
      // and finally, wait for word count to finish -- to make clear the whole operation is done
      await run_word_count;
      if (!this.isBuildOwner(buildToken)) return;
    }

    // Safety net: clean up any build_logs entries stuck in "running" status.
    // This catches edge cases where a sub-step errored without finalizing its entry.
    this.cleanupStaleBuildLogs();
  }

  private async run_knitr(
    time: number,
    force: boolean,
    buildToken?: string,
  ): Promise<void> {
    if (this.is_stopping || !this.isBuildOwner(buildToken)) return;
    let output: BuildLog;
    const status = (s) => {
      if (this.isBuildOwner(buildToken)) {
        this.set_status(`Running Knitr... ${s}`);
      }
    };
    const set_job_info = (job) => {
      if (this.isBuildOwner(buildToken)) {
        this.set_build_logs({ knitr: job });
      }
    };
    status("");

    try {
      output = await knitr(
        this.project_id,
        this.filename_knitr,
        this.make_timestamp(time, force),
        status,
        set_job_info,
      );
      if (!this.isBuildOwner(buildToken)) return;
    } catch (err) {
      if (!this.isBuildOwner(buildToken)) return;
      this.set_error(err);
      this.setState({ knitr_error: true });
      // Mark as errored so the spinner stops, but keep partial output visible
      this.markBuildLogError("knitr");
      return;
    } finally {
      if (this.isBuildOwner(buildToken)) this.set_status("");
    }
    output.parse = knitr_errors(output).toJS();
    this.merge_parsed_output_log(output.parse);
    this.set_build_logs({ knitr: output });
    this.update_gutters();
    this.setState({ knitr_error: output.parse?.errors?.length > 0 });
  }

  async run_patch_synctex(
    time: number,
    force: boolean,
    buildToken?: string,
  ): Promise<void> {
    if (!this.isBuildOwner(buildToken)) return;
    // quotes around ${s} are just so codemirror doesn't syntax highlight the rest of this file:
    const status = (s) => {
      if (this.isBuildOwner(buildToken)) {
        this.set_status(`Running Knitr/Synctex... "${s}"`);
      }
    };
    status("");
    try {
      await patch_synctex(
        this.project_id,
        this.path,
        this.make_timestamp(time, force),
        status,
      );
      if (!this.isBuildOwner(buildToken)) return;
    } catch (err) {
      if (!this.isBuildOwner(buildToken)) return;
      this.set_error(err);
      return;
    } finally {
      if (this.isBuildOwner(buildToken)) this.set_status("");
    }
  }

  // Return the output directory that should actually be used
  // for latexmk, synctex, etc., commands.  This depends on
  // the configured build line.  This is NOT always just
  // this.output_directory.
  private get_output_directory(): string | undefined {
    if (this.knitr) return;
    const s: string | List<string> | undefined =
      this.store.get("build_command");
    if (!s) {
      return;
    }
    if (typeof s == "string") {
      if (s.indexOf("-output-directory") == -1) {
        // we aren't going to go so far as to
        // parse a changed output-directory option...
        // At least if there is no option, we just
        // assume no output directory.
        return;
      } else {
        return this.output_directory;
      }
    } else {
      // s is a List<string>
      for (const x of s.toJS()) {
        if (x.startsWith("-output-directory")) {
          return this.output_directory;
        }
      }
      return;
    }
  }

  private async run_latex(
    time: number,
    force: boolean,
    update_pdf: boolean = true,
    buildToken?: string,
  ): Promise<void> {
    if (this.is_stopping || !this.isBuildOwner(buildToken)) return;
    let output: BuildLog;
    let build_command: string | string[];
    const timestamp = this.make_timestamp(time, force);
    const s: string | List<string> | undefined =
      this.store.get("build_command");
    if (!s) {
      return;
    }
    this.set_error("");
    this.set_build_logs({ latex: undefined });
    // this.set_job_infos({ latex: undefined });
    if (typeof s == "string") {
      build_command = s;
    } else {
      build_command = s.toJS();
    }
    if (force && !this.store.get("build_command_hardcoded")) {
      // Force Build means "redo everything", not just "ignore our caches".
      build_command = fullRebuildCommand(build_command);
    }
    const status = (s) => {
      if (this.isBuildOwner(buildToken)) {
        this.set_status(`Running Latex... ${s}`);
      }
    };
    const set_job_info = (job) => {
      if (this.isBuildOwner(buildToken)) {
        this.set_build_logs({ latex: job });
      }
    };

    status("");
    try {
      output = await latexmk(
        this.project_id,
        this.path,
        build_command,
        timestamp,
        status,
        this.get_output_directory(),
        set_job_info,
      );
      if (!this.isBuildOwner(buildToken)) return;
      // console.log(output);
    } catch (err) {
      if (!this.isBuildOwner(buildToken)) return;
      const streamedOutput = this.get_streamed_latex_output();
      if (
        streamedOutput != null &&
        this.is_generic_latex_transport_error(err)
      ) {
        output = streamedOutput;
      } else {
        //console.info("LaTeX Editor/actions/run_latex error=", err);
        this.set_error(err);
        // Mark the build_logs entry as errored so the build tab spinner stops,
        // but preserve any partial output for the user to diagnose the failure.
        this.markBuildLogError("latex");
        return;
      }
    } finally {
      // In all cases, we want the status info to clear
      if (this.isBuildOwner(buildToken)) this.set_status("");
    }
    if (!this.isBuildOwner(buildToken)) return;
    // resetting parsed_output_log is ok, even if we do two passes.
    // the reason is that in pythontex or sagetex there is a merge *after* this step.
    // therefore, resetting this here will get rid of then stale errors related to
    // missing tokens, because pythontex or sagetex just computed them.
    this.parsed_output_log = output.parse = new LatexParser(output.stdout, {
      ignoreDuplicates: true,
    }).parse();
    this.set_build_logs({ latex: output });
    // TODO: knitr complicates multi-file a lot, so we do
    // not support it yet.
    if (!this.knitr && this.parsed_output_log.deps != null) {
      this.set_switch_to_files(this.parsed_output_log.deps);
    }
    this.check_for_fatal_error();
    this.update_gutters();
    this.update_gutters_soon();
    // Explicit PDF reload after latex compilation
    if (update_pdf) {
      this.update_pdf(time, force);
    }
  }

  // this *merges* errors from log into an eventually already existing this.parsed_output_log
  // the whole point is to keep latex errors while we add additional errors from
  // pythontex, sagetex, etc.
  private merge_parsed_output_log(log: IProcessedLatexLog) {
    // easy case, never supposed to happen
    if (this.parsed_output_log == null) {
      this.parsed_output_log = log;
      return;
    }
    for (const key of ["errors", "warnings", "typesetting", "all"]) {
      const existing = this.parsed_output_log[key];
      log[key].forEach((error) => existing.push(error));
    }
    for (const key of ["files", "deps"]) {
      this.parsed_output_log[key] = union(
        this.parsed_output_log[key],
        log[key],
      );
    }
  }

  private async update_gutters_soon(): Promise<void> {
    await delay(500);
    if (this._state == "closed") return;
    this.update_gutters();
  }

  private update_gutters(): void {
    // Defer gutter updates to avoid React rendering conflicts
    setTimeout(() => {
      // if we pass in a parsed log, we don't clean the gutters
      // it is meant to add to what we already have, e.g. for PythonTeX
      if (this.parsed_output_log == null) return;
      this.clear_gutters();
      update_gutters({
        log: this.parsed_output_log,
        set_gutter: this.set_gutter,
        actions: this,
      });
    }, 0);
  }

  private clear_gutters(): void {
    for (const actions of this.all_actions()) {
      actions.clear_gutter("Codemirror-latex-errors");
    }
  }

  private set_gutter(path: string, line: number, component: any): void {
    const canon_path = this.get_canonical_path(path);
    if (canon_path != null) {
      path = canon_path;
    }
    const actions = this.redux.getEditorActions(
      this.project_id,
      path_normalize(path),
    );
    if (actions == null) {
      return; // file not open
    }

    (actions as BaseActions<LatexEditorState>).set_gutter_marker({
      line,
      component,
      gutter_id: "Codemirror-latex-errors",
    });
  }

  // transform a relative path like file.tex or ./x/name.tex
  // to the canonical path
  private get_canonical_path(path: string): string {
    const norm = path_normalize(path);
    return this.canonical_paths[norm];
  }

  private async set_switch_to_files(files: string[]): Promise<void> {
    let switch_to_files: string[];
    const cur = this.store.get("switch_to_files");
    if (cur != null) {
      // If there's anything already there during this session
      // we keep it...
      switch_to_files = cur.toJS();
    } else {
      switch_to_files = [];
    }

    // if we're not in the home directory, prefix it to all relative paths
    let files1: string[];
    const dir = path_split(this.path).head;
    if (dir == "") {
      files1 = files;
    } else {
      files1 = [];
      for (let i = 0; i < files.length; i++) {
        if (!files[i].startsWith("/")) {
          files1.push(dir + "/" + files[i]);
        } else {
          files1.push(files[i]);
        }
      }
    }

    // Resolve dependency paths to absolute paths (prefer realpath for existing
    // files, lexical absolute fallback otherwise).
    const api = await project_api(this.project_id);
    const home = normalizeAbsolutePath(await api.getHomeDirectory());
    const baseDir = normalizeAbsolutePath(
      path_split(this.path).head || home,
      home,
    );
    let files2: string[];
    try {
      files2 = await Promise.all(
        files1.map(async (path) => {
          const absolute = normalizeAbsolutePath(path, baseDir);
          try {
            return await api.realpath(absolute);
          } catch {
            return absolute;
          }
        }),
      );
      this.setState({ includeError: "" });
    } catch (err) {
      // Safely convert error to string, handling undefined/null cases
      const errorMessage = err
        ? String(err)
        : "Unknown error checking included files";
      this.setState({ includeError: errorMessage });
      return;
    }

    // Record mappings from relative dependency names from build output logs to
    // resolved absolute paths.
    for (let i = 0; i < files2.length; i++) {
      const canon_path = files2[i];
      switch_to_files.push(canon_path);
      const norm_path = path_normalize(files[i]);
      this.relative_paths[canon_path] = norm_path;
      this.canonical_paths[norm_path] = canon_path;
    }
    // sort and make unique.
    this.setState({
      switch_to_files: Array.from(new Set(switch_to_files)).sort(),
    });
    this._scheduleDiskChatScans(true);
    // Dependency path resolution is asynchronous, so the build's other TOC
    // refreshes can run before switch_to_files contains the discovered
    // subfiles. Refresh again once the canonical file list is published.
    this.updateTableOfContents(true);
  }

  private _update_pdf(time: number, force: boolean): void {
    const timestamp = this.make_timestamp(time, force);
    // forget currently cached pdf
    this._forget_pdf_document();
    // ... before setting a new one for all the viewers,
    // which causes them to reload.
    for (const x of VIEWERS) {
      this.set_reload(x, timestamp);
    }
  }

  async run_bibtex(time: number, force: boolean): Promise<void> {
    this.set_status("Running BibTeX...");
    try {
      const output: BuildLog = await bibtex(
        this.project_id,
        this.path,
        this.make_timestamp(time, force),
        this.get_output_directory(),
      );
      this.set_build_logs({ bibtex: output });
    } catch (err) {
      this.set_error(err);
    }
    this.set_status("");
  }

  async run_sagetex(
    time: number,
    force: boolean,
    buildToken?: string,
  ): Promise<void> {
    if (this.is_stopping || !this.isBuildOwner(buildToken)) return;
    const status = (s) => {
      if (this.isBuildOwner(buildToken)) {
        this.set_status(`Running SageTeX... ${s}`);
      }
    };
    const set_job_info = (job) => {
      if (this.isBuildOwner(buildToken)) {
        this.set_build_logs({ sagetex: job });
      }
    };
    status("");
    // First compute hash of sagetex file.
    let hash: string = "";
    if (!force) {
      try {
        hash = await sagetex_hash(
          this.project_id,
          this.path,
          time,
          status,
          this.get_output_directory(),
        );
        if (!this.isBuildOwner(buildToken)) return;
        if (hash === this._last_sagetex_hash) {
          // no change - nothing to do except updating the pdf preview
          this.update_pdf(time, force);
          return;
        }
      } catch (err) {
        if (!this.isBuildOwner(buildToken)) return;
        this.set_error(err);
        this.update_pdf(time, force);
        return;
      } finally {
        if (this.isBuildOwner(buildToken)) this.set_status("");
      }
    }

    let output: BuildLog | undefined;
    try {
      // Next run Sage.
      output = await sagetex(
        this.project_id,
        this.path,
        hash,
        status,
        this.get_output_directory(),
        set_job_info,
      );
      if (!this.isBuildOwner(buildToken)) return;
      if (!output) throw new Error("Unable to run SageTeX.");
      if (output.stderr.indexOf("sagetex.VersionError") != -1) {
        // See https://github.com/sagemathinc/cocalc/issues/4432
        throw Error(
          "SageTex in CoCalc currently only works with the default version of Sage.  Delete ~/bin/sage and try again.",
        );
      }
      // Now Run LaTeX, since we had to run sagetex, which changes the sage output.
      // This +1 forces re-running latex... but still deduplicates it in case of multiple users.
      await this.run_latex(time + 1, force, true, buildToken);
      if (!this.isBuildOwner(buildToken)) return;
    } catch (err) {
      if (!this.isBuildOwner(buildToken)) return;
      this.set_error(err);
      // Mark as errored so the spinner stops, but keep partial output visible
      this.markBuildLogError("sagetex");
      this.update_pdf(time, force);
    } finally {
      if (this.isBuildOwner(buildToken)) {
        this._last_sagetex_hash = hash;
        this.set_status("");
      }
    }

    if (output != null) {
      // process any errors
      output.parse = sagetex_errors(path_split(this.path).tail, output).toJS();
      this.merge_parsed_output_log(output.parse);
      this.set_build_logs({ sagetex: output });
      // there is no line information in the sagetex errors (and no concordance info either),
      // hence we can't update the gutters.
    }
  }

  async run_pythontex(
    time: number,
    force: boolean,
    buildToken?: string,
  ): Promise<void> {
    if (this.is_stopping || !this.isBuildOwner(buildToken)) return;
    let output: BuildLog;
    const status = (s) => {
      if (this.isBuildOwner(buildToken)) {
        this.set_status(`Running PythonTeX... ${s}`);
      }
    };
    const set_job_info = (job) => {
      if (this.isBuildOwner(buildToken)) {
        this.set_build_logs({ pythontex: job });
      }
    };
    status("");

    try {
      // Run PythonTeX
      output = await pythontex(
        this.project_id,
        this.path,
        time,
        force,
        status,
        this.get_output_directory(),
        set_job_info,
      );
      if (!this.isBuildOwner(buildToken)) return;
      // Now run latex again, since we had to run pythontex, which changes the inserted snippets.
      // This +2 forces re-running latex... but still deduplicates it in case of multiple users. (+1 is for sagetex)
      await this.run_latex(time + 2, force, true, buildToken);
      if (!this.isBuildOwner(buildToken)) return;
    } catch (err) {
      if (!this.isBuildOwner(buildToken)) return;
      this.set_error(err);
      // this.setState({ pythontex_error: true });
      // Mark as errored so the spinner stops, but keep partial output visible
      this.markBuildLogError("pythontex");
      this.update_pdf(time, force);
      return;
    } finally {
      if (this.isBuildOwner(buildToken)) this.set_status("");
    }
    // this is similar to how knitr errors are processed
    output.parse = pythontex_errors(path_split(this.path).tail, output).toJS();
    this.merge_parsed_output_log(output.parse);
    this.set_build_logs({ pythontex: output });
    this.update_gutters();
  }

  async synctex_pdf_to_tex(
    page: number,
    x: number,
    y: number,
    manual: boolean = false,
  ): Promise<void> {
    // Only check auto sync flag for automatic sync, not manual double-clicks
    if (!manual && this.is_auto_sync_in_progress()) {
      return; // Prevent sync loops
    }

    if (!manual) {
      this.set_auto_sync_in_progress(true);
    }
    this.set_status("Running SyncTex...");
    try {
      const info = await synctex.pdf_to_tex({
        x,
        y,
        page,
        pdf_path: pdf_path(this.path),
        project_id: this.project_id,
        output_directory: this.get_output_directory(),
        src: this.path,
      });
      const line = info.Line;
      if (typeof line != "number") {
        // TODO: would be nicer to handle this at the source...
        throw Error("invalid synctex output (Line must be a number).");
      }
      if (typeof info.Input != "string") {
        throw Error("unable to determine source file");
      }
      await this.goto_line_in_file(line, info.Input);
    } catch (err) {
      if (err.message.indexOf("ENOENT") != -1) {
        console.log("synctex_pdf_to_tex err:", err);
        // err is just a string exception, and I'm nervous trying
        // to JSON.parse it, so we'll do something less robust,
        // which should have a sufficiently vague message that
        // it is OK.  When you try to run synctex and the synctex
        // file is missing, you get an error with ENOENT in it...
        this.set_error(
          'Synctex failed to run.  Try "Force Rebuild" your project (use the Build frame) or retry once the build is complete.',
        );
        // Clear flag since sync failed (only for automatic sync)
        if (!manual) {
          this.set_auto_sync_in_progress(false);
        }
        return;
      }
      console.warn("ERROR ", err);
      this.set_error(err);
      // Clear flag since sync failed (only for automatic sync)
      if (!manual) {
        this.set_auto_sync_in_progress(false);
      }
    } finally {
      this.set_status("");
    }
  }

  public async goto_line_in_file(line: number, path: string): Promise<void> {
    if (path.indexOf("/.") != -1 || path.indexOf("./") != -1) {
      const api = await project_api(this.project_id);
      const baseDir = path_split(this.path).head || "/";
      const normalized = normalizeAbsolutePath(path, baseDir);
      try {
        path = await api.realpath(normalized);
      } catch {
        path = normalized;
      }
    }
    if (this.knitr) {
      // #v0 will not support multi-file knitr.
      this.programmatically_goto_line(line, true, true);
      this.clear_auto_sync_after_cursor_move();
      return;
    }
    // Focus a cm frame so that we split a code editor below.
    //this.show_focused_frame_of_type("cm");
    // focus/show/open the proper file, then go to the line.
    const id = await this.switch_to_file(path);
    // TODO: go to appropriate line in this editor.
    const actions = this.redux.getEditorActions(this.project_id, path);
    if (actions == null) {
      throw Error(`actions for "${path}" must be defined`);
    }
    (actions as BaseActions).programmatically_goto_line(line, true, true, id);

    this.clear_auto_sync_after_cursor_move();
  }

  // Clear auto sync flag after cursor has moved (backward sync completion)
  private clear_auto_sync_after_cursor_move(): void {
    // Only for automatic sync - manual sync doesn't set the flag
    if (this.is_auto_sync_in_progress()) {
      setTimeout(() => {
        this.set_auto_sync_in_progress(false);
      }, 200); // Give time for cursor to actually move
    }
  }

  // Check if forward auto-sync (CM → PDF) is enabled for any output panel
  private is_auto_sync_forward_enabled(): boolean {
    const local_view_state = this.store.get("local_view_state");
    if (!local_view_state) return false;

    // Check all output panels for forward auto-sync enabled
    for (const [key, value] of local_view_state.entrySeq()) {
      // Only check output panels
      if (this._is_output_panel(key) && value) {
        const autoSyncForward =
          typeof value.get === "function"
            ? value.get("autoSyncForward")
            : value.autoSyncForward;
        if (autoSyncForward) {
          return true;
        }
      }
    }
    return false;
  }

  // Set auto sync in progress flag in state
  private set_auto_sync_in_progress(inProgress: boolean): void {
    this.setState({ autoSyncInProgress: inProgress });
  }

  // Check if auto sync is currently in progress
  private is_auto_sync_in_progress(): boolean {
    return this.store.get("autoSyncInProgress") ?? false;
  }

  // Handle cursor movement - called by BaseActions.set_cursor_locs
  public handle_cursor_move(locs: any[]): void {
    if (!this.is_auto_sync_forward_enabled() || locs.length === 0) return;

    // Prevent duplicate sync operations
    if (this.is_auto_sync_in_progress()) return;

    // Throttle sync operations to prevent excessive calls (max once every 500ms)
    const now = Date.now();
    if (now - this._last_sync_time < 500) return;
    this._last_sync_time = now;

    // Get the primary cursor position (first in the array)
    const cursor = locs[0];
    if (typeof cursor?.y === "number" && typeof cursor?.x === "number") {
      // Trigger forward sync (source → PDF)
      this.handle_cursor_sync_to_pdf(cursor.y + 1, cursor.x, this.path); // y is 0-based, synctex expects 1-based
    }
  }

  _get_most_recent_pdfjs(): string | undefined {
    return this._get_most_recent_active_frame_id(
      (node) => node.get("type").indexOf("pdfjs") != -1,
    );
  }

  _get_most_recent_output_panel(): string | undefined {
    let result = this._get_most_recent_active_frame_id_of_type("output");
    // console.log(
    //   "LaTeX: _get_most_recent_output_panel() via active history returning",
    //   result,
    // );

    // If no recently active output panel found, look for any output panel
    if (!result) {
      result = this._get_any_frame_id_of_type("output");
      //console.log("LaTeX: _get_any_frame_id_of_type() returning", result);
    }

    return result;
  }

  // Helper method to find any frame of the given type, regardless of activity history
  _get_any_frame_id_of_type(type: string): string | undefined {
    const tree = this._get_tree();
    const leaf_ids = tree_ops.get_leaf_ids(tree);

    for (const id in leaf_ids) {
      const node = tree_ops.get_node(tree, id);
      if (node && node.get("type") === type) {
        return id;
      }
    }
    return undefined;
  }

  // Switch output panel to PDF tab for SyncTeX
  _switch_output_panel_to_pdf(output_panel_id: string): void {
    // This will be handled by the output panel component
    // We set a state that the output panel can react to
    this.setState({
      switch_output_to_pdf_tab: true,
      output_panel_id_for_sync: output_panel_id,
    });
  }

  async synctex_tex_to_pdf(
    line: number,
    column: number,
    filename: string,
  ): Promise<void> {
    // First figure out where to jump to in the PDF.
    this.set_status("Running SyncTex from tex to pdf...");
    let info;
    const source_dir: string = path_split(this.path).head;
    let dir: string | undefined = this.get_output_directory();
    if (dir === undefined) {
      dir = source_dir;
    }
    try {
      info = await synctex.tex_to_pdf({
        line,
        column,
        dir,
        tex_path: filename,
        pdf_path: pdf_path(this.path),
        project_id: this.project_id,
        knitr: this.knitr,
        source_dir,
      });
    } catch (err) {
      console.warn("ERROR ", err);
      this.set_error(err);
      return;
    } finally {
      this.set_status("");
    }
    // Next get a PDF to jump to.
    // First check if there's an output panel, which contains a PDF viewer
    let output_panel_id: string | undefined =
      this._get_most_recent_output_panel();
    let pdfjs_id: string | undefined;

    // console.log("LaTeX forward sync: output_panel_id =", output_panel_id);

    if (output_panel_id) {
      // There's an output panel - switch it to PDF tab and use it
      // console.log("LaTeX forward sync: Using output panel", output_panel_id);
      this._switch_output_panel_to_pdf(output_panel_id);
      pdfjs_id = output_panel_id;
    } else {
      // No output panel, look for standalone PDF viewer
      // console.log(
      //   "LaTeX forward sync: No output panel found, looking for standalone PDFJS",
      // );
      pdfjs_id = this._get_most_recent_pdfjs();
      if (!pdfjs_id) {
        // no pdfjs preview, so make one
        // console.log("LaTeX forward sync: Creating new PDFJS panel");
        this.split_frame("col", this._get_active_id(), "pdfjs_canvas");
        pdfjs_id = this._get_most_recent_pdfjs();
        if (!pdfjs_id) {
          throw Error("BUG -- there must be a pdfjs frame.");
        }
      }
    }
    const full_id: string | undefined = this.store.getIn([
      "local_view_state",
      "full_id",
    ]);
    if (full_id && full_id != pdfjs_id) {
      this.unset_frame_full();
    }
    // Now show the preview in the right place.
    this.scroll_pdf_into_view(info.Page as number, info.y as number, pdfjs_id);
  }

  // Scroll the pdf preview frame with given id into view.
  scroll_pdf_into_view(page: number, y: number, id: string): void {
    this.setState({
      scroll_pdf_into_view: new ScrollIntoViewRecord({ page, y, id }),
    });
  }

  // Check if the given ID is an output panel
  _is_output_panel(id: string): boolean {
    const frame = this._get_frame_node(id);
    const frameType = frame?.get("type");
    return frameType === "output";
  }

  // Public method to save local view state (delegates to parent's debounced method)
  save_local_view_state(): void {
    (this as any)._save_local_view_state();
  }

  // Mark a build_logs entry as "error" while preserving any partial output
  // (stdout/stderr) so the user can still see what happened before the failure.
  private markBuildLogError(stage: BuildSpecName): void {
    const build_logs: BuildLogs | undefined = this.store.get("build_logs");
    if (!build_logs) return;
    const entry = build_logs.get(stage);
    if (!entry) return;
    const js: BuildLog = entry.toJS();
    if (js.type === "async" && js.status === "running") {
      js.status = "error";
      this.set_build_logs({ [stage]: js });
    }
  }

  // Safety net: after a build completes, clean up any build_logs entries
  // that are still stuck in "running" status.  This can happen when an exec
  // stream errors out after the "job" event set status to "running" but
  // before the "done" event could finalize it.
  // Preserves partial output so the user can diagnose the failure.
  private cleanupStaleBuildLogs(): void {
    const build_logs: BuildLogs | undefined = this.store.get("build_logs");
    if (!build_logs) return;
    build_logs.forEach((entry, key) => {
      const js: BuildLog = entry?.toJS();
      if (js?.type === "async" && js?.status === "running") {
        js.status = "error";
        this.set_build_logs({ [key]: js });
      }
    });
  }

  private set_build_logs(obj: { [K in keyof IBuildSpecs]?: BuildLog }): void {
    let build_logs: BuildLogs = this.store.get("build_logs") ?? IMap();
    let k: BuildSpecName;
    for (k in obj) {
      const v: BuildLog | undefined = obj[k];
      if (v) {
        build_logs = build_logs.set(k, fromJS(v) as any as TypedMap<BuildLog>);
      } else {
        build_logs = build_logs.delete(k);
      }
    }
    this.setState({ build_logs });
  }

  async run_clean(): Promise<void> {
    let log: string = "";
    this.setState({ build_logs: IMap() });

    const logger = (s: string): void => {
      log += s + "\n";
      const build_logs: BuildLogs = this.store.get("build_logs");
      this.setState({
        build_logs: build_logs.set(
          "clean",
          fromJS({ output: log }) as any as TypedMap<BuildLog>,
        ),
      });
    };

    this.set_status("Cleaning up auxiliary files...");
    try {
      await clean(
        this.project_id,
        this.path,
        this.knitr,
        logger,
        this.get_output_directory(),
      );
    } catch (err) {
      this.set_error(`Error cleaning auxiliary files -- ${err}`);
    }
    this.set_status("");
  }

  // TODO: is this used in any way besides build_action("clean") ?
  private async build_action(action: string, force?: boolean): Promise<void> {
    if (this.is_read_only_preview()) return;
    if (force === undefined) {
      force = false;
    }
    const now: number = server_time().valueOf();
    switch (action) {
      case "build":
        await this.run_build(now, false);
        return;
      case "latex":
        await this.run_latex(now, false);
        return;
      case "bibtex":
        await this.run_bibtex(now, false);
        return;
      case "sagetex":
        await this.run_sagetex(now, false);
        return;
      case "pythontex":
        await this.run_pythontex(now, false);
        return;
      case "clean":
        await this.run_clean();
        return;
      default:
        this.set_error(`unknown build action '${action}'`);
    }
  }

  // If time is provided (non-zero), use it as the aggregate key base.
  // Note: sagetex/pythontex use time+1/time+2 to force distinct aggregate
  // keys for their re-run of latex. Only generate a fresh timestamp when
  // time=0 and force=true.
  make_timestamp(time: number, force: boolean): number {
    if (time) return time;
    return force ? server_time().valueOf() : this.last_save_time();
  }

  private async _word_count(
    time: number,
    force: boolean,
    skipFramePopup: boolean = false,
  ): Promise<void> {
    // only run word count if at least one such panel exists or skipFramePopup is true
    if (!skipFramePopup) {
      this.show_recently_focused_frame_of_type("word_count");
    }

    try {
      const timestamp = this.make_timestamp(time, force);
      const output = await count_words(this.project_id, this.path, timestamp);
      if (output.stderr) {
        const err = `Error:\n${output.stderr}`;
        this.setState({ word_count: err });
      } else {
        this.setState({ word_count: output.stdout });
      }
    } catch (err) {
      this.setState({
        word_count: `Error running word count:\n${err instanceof Error ? err.message : `${err}`}`,
      });
    }
  }

  help(): void {
    openProjectDocs({ projectId: this.project_id, slug: HELP_SLUG });
  }

  zoom_page_width(id: string): void {
    this.setState({ zoom_page_width: id });
  }

  zoom_page_height(id: string): void {
    this.setState({ zoom_page_height: id });
  }

  sync(id: string, editor_actions: Actions): void {
    const cm = editor_actions._cm[id];
    if (cm != null) {
      // Clicked the sync button from within an editor
      this.forward_search(cm, editor_actions.path);
    } else {
      // Clicked button associated to a preview pane;
      // let the preview pane do the work.
      this.setState({ sync: id });
    }
  }

  private forward_search(cm: CodeMirror.Editor, path: string): void {
    const { line, ch } = cm.getDoc().getCursor();
    if (this.relative_paths[path] != null) {
      path = this.relative_paths[path];
    }
    this.synctex_tex_to_pdf(line, ch, path);
  }

  time_travel(opts: { path?: string; frame?: boolean }): void {
    // knitr case: point to editor file, not the generated tex
    // https://github.com/sagemathinc/cocalc/issues/3336
    if (this.knitr) {
      super.time_travel({ path: this.filename_knitr, frame: opts.frame });
    } else {
      super.time_travel(opts);
    }
  }

  download_pdf(): void {
    const path: string = pdf_path(this.path);

    // we use auto false and true, since the pdf may not exist, and we don't want
    // a **silent failure**.  With auto:false, the pdf appears in a new tab
    // and user has to click again to actually get it on their computer, but
    // auto:true makes it so it downloads automatically to avoid that click.
    // If there is an error, that is clear too.
    this.redux
      .getProjectActions(this.project_id)
      .download_file({ path, log: true, auto: false });
    this.redux
      .getProjectActions(this.project_id)
      .download_file({ path, log: false, auto: true });
  }

  print(id: string): void {
    const node = this._get_frame_node(id);
    if (node == null) {
      throw Error(`BUG -- no node with id ${id}`);
    }
    const type: string = node.get("type");

    if (type == "cm") {
      super.print(id);
      return;
    }
    if (type.indexOf("pdf") != -1 || type === "output") {
      this.print_pdf();
      return;
    }
    throw Error(`BUG -- printing not implement for node of type ${type}`);
  }

  print_pdf(): void {
    print_html({ src: raw_url(this.project_id, pdf_path(this.path)) });
  }

  set_build_command(command: string | string[]): void {
    if (this.is_read_only_preview()) {
      this.setState({ build_command: fromJS(command) });
      return;
    }
    if (this._syncdb == null) throw Error("syncdb must be defined");
    // I deleted the insane time:now in this syncdb set, since that
    // would seem to generate an insane amount of traffic (and I'm
    // surprised it wouldn't generate a feedback loop)!
    this._syncdb.set({ key: "build_command", value: command });
    this._syncdb.commit();
    this.save_build_command_config_to_disk();
    this.setState({ build_command: fromJS(command) });
  }

  private save_build_command_config_to_disk(): void {
    const syncdb = this._syncdb;
    if (syncdb == null) return;
    void saveToDiskWithFileServerRetry({
      save: () => syncdb.save_to_disk(),
      shouldRetry: () => this._state !== "closed" && !this.isClosed(),
    }).catch((err) => {
      if (this._state !== "closed") {
        this.set_error(
          `Error saving LaTeX build command for '${this.path}' -- ${err}`,
        );
      }
    });
  }

  // if id is given, switch that frame to edit the given path;
  // if not given, switch an existing cm editor (or find one if there
  // is already one pointed at this path.)
  public async switch_to_file(path: string, id?: string): Promise<string> {
    id = await super.switch_to_file(path, id);
    this.update_gutters_soon();
    return id;
  }

  public async show_table_of_contents(
    _id: string | undefined = undefined,
  ): Promise<void> {
    const id = this.show_focused_frame_of_type(
      "latex_table_of_contents",
      "col",
      true,
      1 / 3,
    );
    // the click to select TOC focuses the active id back on the notebook
    await delay(0);
    if (this._state === "closed") return;
    this.set_active_id(id, true);
  }

  public updateTableOfContents(force: boolean = false): void {
    if (
      this._state == "closed" ||
      this._syncstring == null ||
      this._syncstring.get_state?.() != "ready"
    ) {
      // no need since not initialized yet or already closed.
      return;
    }
    if (
      !force &&
      !this.get_matching_frame({ type: "latex_table_of_contents" }) &&
      !this.get_matching_frame({ type: "output" })
    ) {
      // There is no table of contents frame or output frame so don't update that info.
      return;
    }
    let value = "";
    try {
      value = this._syncstring.to_str() ?? "";
    } catch {
      // sync doc can race during startup/refresh.
      return;
    }
    const entries = parseTableOfContents(value, {
      includeBookmarks: true,
      includeChatMarkers: true,
    });
    this._appendSubfileTocEntries(entries, value);
    const contents = fromJS(entries) as any;
    this.setState({ contents });
  }

  // Add TOC content from included files: their section headings, chat
  // markers, and bookmarks (the master's are already overlaid by
  // parseTableOfContents). A known \include/\input position determines where
  // the file group is inserted; unmatched build-known/open subfiles remain
  // visible at the end. Markers/bookmarks are deduped against the master.
  private _appendSubfileTocEntries(
    entries: TableOfContentsEntry[],
    masterLatex: string,
  ): void {
    const chatMarkers = this.store.get("chat_markers");
    const chatBookmarks = this.store.get("chat_bookmarks");
    const switchToFiles = this.store.get("switch_to_files");
    if (chatMarkers == null && chatBookmarks == null && switchToFiles == null) {
      return;
    }
    const seenHashes = new Set<string>();
    for (const e of entries) {
      const extra = (e as any)?.extra;
      if (extra?.kind === "chat" && typeof extra.hash === "string") {
        seenHashes.add(extra.hash);
      }
    }
    const seenBookmarks = new Set<string>(
      ((chatBookmarks?.get(this.path)?.toJS() ?? []) as any[]).map(
        (b) => b.text,
      ),
    );
    // Thread configs discover paths that may not yet be in the build output.
    // Their hashes are never rendered directly: config rows intentionally
    // survive deleted source markers, so only source scans are authoritative.
    const anchoredPaths = this._getAnchoredSubfilePaths();
    const subPaths = new Set<string>([
      ...((switchToFiles?.toJS() ?? []) as string[]).filter((path) =>
        path.toLowerCase().endsWith(".tex"),
      ),
      ...((chatMarkers?.keySeq().toJS() ?? []) as string[]),
      ...((chatBookmarks?.keySeq().toJS() ?? []) as string[]),
      ...anchoredPaths,
    ]);
    subPaths.delete(this.path);
    const groups: SubfileTocGroup[] = [];
    for (const path of [...subPaths].sort()) {
      const tail = path_split(path).tail;
      const group: TableOfContentsEntry[] = [];

      // Section headings from the sub-file's live syncstring, falling back to
      // the same disk read that discovers markers/bookmarks for unopened
      // build-known files. A mounted editor always wins over the disk cache.
      const subActions: any = this.redux.getEditorActions(
        this.project_id,
        path,
      );
      let subHeadings: TableOfContentsEntry[] | undefined;
      try {
        const subText = subActions?._syncstring?.to_str();
        if (subText != null) {
          subHeadings = parseTableOfContents(subText);
        }
      } catch {
        // not ready yet; headings will appear on a later rescan
      }
      subHeadings ??= this._diskSubfileHeadings?.get(path);
      for (const h of subHeadings ?? []) {
        group.push({
          id: `sub:${path}:${h.id}-heading`,
          value: h.value,
          level: h.level,
          extra: { kind: "line", path, line: parseInt(h.id) - 1 },
        });
      }

      const markers = (chatMarkers?.get(path)?.toJS() ??
        []) as unknown as ChatMarker[];
      for (const m of markers) {
        if (seenHashes.has(m.hash)) continue;
        seenHashes.add(m.hash);
        group.push({
          id: `sub:${path}:${m.line + 1}-chat-${m.hash}`,
          value: `Chat ${m.hash} (line ${m.line + 1})`,
          level: 6,
          icon: "comment",
          // line is only used for in-group ordering; jumping goes via
          // the hash (jumpToAnchor) so it survives marker moves.
          extra: { kind: "chat", hash: m.hash, path, line: m.line },
        });
      }
      const bookmarks = (chatBookmarks?.get(path)?.toJS() ??
        []) as unknown as BookmarkMarker[];
      for (const b of bookmarks) {
        if (seenBookmarks.has(b.text)) continue;
        seenBookmarks.add(b.text);
        group.push({
          id: `sub:${path}:${b.line + 1}-bookmark-${b.text}`,
          value: b.text,
          level: 6,
          icon: "tag-outlined",
          extra: { kind: "line", path, line: b.line },
        });
      }

      // Keep each file's entries in document order.
      group.sort(
        (a, b) =>
          (((a as any).extra?.line ?? 0) as number) -
          (((b as any).extra?.line ?? 0) as number),
      );
      groups.push({
        path,
        entries: [
          {
            id: `sub:${path}:0-file`,
            value: `**${tail}**`,
            icon: "tex-file",
            extra: { kind: "line", path, line: 0 },
          },
          ...group,
        ],
      });
    }
    const ordered = interleaveSubfileTocEntries({
      masterEntries: entries,
      masterLatex,
      masterPath: this.path,
      groups,
      canonicalPaths: this.canonical_paths,
    });
    entries.splice(0, entries.length, ...ordered);
  }

  private _getAnchoredThreadRows(): any[] {
    try {
      return (
        getExistingSideChatActions(
          this.project_id,
          this.path,
        )?.listThreadConfigRows() ?? []
      );
    } catch {
      // Side chat can be between syncdb instances during reconnect. Its next
      // store/cache event will recompute the TOC.
      return [];
    }
  }

  private _getActiveAnchorsByPath(): Map<string, Set<string>> {
    const byPath = new Map<string, Set<string>>();
    for (const row of this._getAnchoredThreadRows()) {
      const archived =
        row?.archived === true ||
        row?.archived === "true" ||
        row?.archived === 1 ||
        row?.archived === "1";
      if (archived || parseThreadResolved(row?.resolved) != null) continue;
      const anchor = parseThreadAnchor(row?.anchor);
      if (anchor?.path == null) continue;
      const path =
        this.canonical_paths[path_normalize(anchor.path)] ?? anchor.path;
      if (path === this.path) continue;
      let ids = byPath.get(path);
      if (ids == null) {
        ids = new Set();
        byPath.set(path, ids);
      }
      ids.add(anchor.id);
    }
    return byPath;
  }

  private _getAnchoredSubfilePaths(): Set<string> {
    return new Set(this._getActiveAnchorsByPath().keys());
  }

  public async scrollToHeading(entry: TableOfContentsEntry): Promise<void> {
    const extra = (entry as any)?.extra;
    // Chat markers jump via the anchor adapter (handles sub-files and
    // markers that moved since the TOC was computed).
    if (extra?.kind === "chat" && typeof extra.hash === "string") {
      await this.jumpToAnchor(extra.hash);
      return;
    }
    // Entries from included files (file header, headings, bookmarks)
    // carry their own path + line.
    if (extra?.kind === "line" && typeof extra.path === "string") {
      const frameId = await this._switchFocusedSourceTo(extra.path);
      if (frameId == null) return;
      await this._gotoSourceLine(extra.path, (extra.line ?? 0) + 1, frameId);
      return;
    }
    // Plain entries come from the master document.  The last-focused
    // source pane may currently show an included file, so retarget that
    // pane before applying the master line number.
    const frameId = await this._switchFocusedSourceTo(this.path);
    if (frameId == null) return;
    await this._gotoSourceLine(this.path, parseInt(entry.id), frameId);
  }

  // ===== Chat anchors =======================================================
  //
  // A `% chat: <hash>` comment in the tex source anchors a thread in the
  // side chat.  We scan the master file (and each open sub-file) for
  // markers on every syncstring change, then render a gutter icon + badge
  // on each marker line.  The per-anchor threads live in the master
  // `.sage-chat`; their thread-config rows carry `anchor.id = <hash>` and
  // optionally `anchor.path = <sub-file>`.  See chat-markers.ts for the
  // marker format and @cocalc/frontend/chat/anchors for the thread side.

  private _chatMarkerScanners: {
    [path: string]: { dispose: () => void; rescan: () => void };
  } = {};

  // CodeMirror owns gutter DOM, so keep one persistent React root per
  // CodeMirror pane.  Going through the editor's Redux gutter state makes
  // split panes compete for the same host and causes visible flicker.
  private _chatGutterHosts: {
    [path: string]: Map<
      CodeMirror.Editor,
      Array<{ host: HTMLElement; root: Root; line: number }>
    >;
  } = {};

  private _bookmarkGutterHosts: {
    [path: string]: Map<
      CodeMirror.Editor,
      Array<{ host: HTMLElement; root: Root; line: number }>
    >;
  } = {};

  private _bookmarkLines: { [path: string]: Set<number> } = {};

  private _cursorInsertHosts: {
    [path: string]: Map<
      CodeMirror.Editor,
      {
        host: HTMLElement;
        chatRoot: Root;
        bookmarkRoot: Root;
        currentHandle: CodeMirror.LineHandle | null;
      }
    >;
  } = {};

  private _cursorInsertBound = new WeakSet<CodeMirror.Editor>();
  private _chatClickHandlerInstalled = new WeakSet<CodeMirror.Editor>();
  private _chatKeybindingInstalled = new WeakSet<CodeMirror.Editor>();
  private _chatTailTrackingInstalled = new WeakSet<CodeMirror.Editor>();

  private _chatTextMarkers: {
    [path: string]: Map<CodeMirror.Editor, CodeMirror.TextMarker[]>;
  } = {};

  private _chatTailHosts: {
    [path: string]: Map<
      CodeMirror.Editor,
      Array<{
        bookmark: CodeMirror.TextMarker;
        host: HTMLElement;
        root: Root;
      }>
    >;
  } = {};

  private _chatStoreDispose?: () => void;
  private _chatMarkerStoreDispose?: () => void;
  private _chatMarkersOwnedByParent = false;
  private _diskScannedPaths = new Set<string>();
  private _diskChatContentHashes = new Map<string, number>();
  private _diskChatAnchorSignatures = new Map<string, string>();
  private _diskSubfileHeadings = new Map<string, TableOfContentsEntry[]>();
  private _diskChatRead?: (path: string) => Promise<void>;
  private _diskChatScanRefresh?: ReturnType<typeof debounce>;
  private _diskChatScanForce = false;

  private _initChatMarkers(): void {
    if (this.parent_file != null && this.parent_file !== this.path) {
      this._chatMarkersOwnedByParent = true;
      return;
    }
    this._attachChatMarkerScanner(this, this.path);
    this._initChatAnchorLockListener();
    this._scheduleDiskChatScans();
    // Sub-files get picked up whenever the build discovers dependencies
    // (set_switch_to_files) or the store otherwise changes.
    const refreshScanners = debounce(
      () => {
        if (this._state === ("closed" as any)) return;
        this._refreshChatMarkerScanners();
      },
      1000,
      { leading: false, trailing: true },
    );
    this.store.on("change", refreshScanners);
    this._chatMarkerStoreDispose = () => {
      this.store.removeListener("change", refreshScanners);
      refreshScanners.cancel();
    };
  }

  /**
   * A subfile opened on its own briefly owns `<subfile>.sage-chat`. Threads
   * anchored there before the master claimed the file stay in that file and
   * are not reachable from the master's side chat afterwards. We deliberately
   * do not migrate them, so surface the case in diagnostics instead of
   * dropping it silently.
   */
  private _logAbandonedStandaloneChat(): void {
    try {
      const actions = getExistingSideChatActions(this.project_id, this.path);
      if (actions == null) return;
      const anchored = actions
        .listThreadConfigRows()
        .filter(
          (row) => parseThreadAnchor((row as any)?.anchor) != null,
        ).length;
      if (anchored === 0) return;
      syncdocDiagnosticLog("latex subfile yielded anchored chat threads", {
        path: this.path,
        parent_file: this.parent_file,
        anchoredThreads: anchored,
      });
    } catch {
      // diagnostics only -- never block yielding ownership.
    }
  }

  private _yieldChatMarkersToParent(): void {
    if (this._chatMarkersOwnedByParent) return;
    this._chatMarkersOwnedByParent = true;
    this._diskChatScanRefresh?.cancel();
    this._diskChatScanRefresh = undefined;
    this._diskSubfileHeadings.clear();
    this._logAbandonedStandaloneChat();
    for (const handle of Object.values(this._chatMarkerScanners)) {
      handle.dispose();
    }
    this._chatMarkerScanners = {};
    this._disposeChatGutterUI();
    this._chatMarkerStoreDispose?.();
    this._chatMarkerStoreDispose = undefined;
    this._chatStoreDispose?.();
    this._chatStoreDispose = undefined;
  }

  public set_parent_file(path: string): void {
    super.set_parent_file(path);
    if (path !== this.path) {
      // The parent editor scans and decorates all included files using the
      // master's side chat. Stop this file's standalone scanner first so two
      // owners cannot alternate between `.master.sage-chat` and an empty
      // `.subfile.sage-chat` as their async rescans finish.
      this._yieldChatMarkersToParent();
    }
  }

  private _refreshChatMarkerScanners(): void {
    const wanted = new Set<string>();
    for (const actions of this.all_actions()) {
      const path = (actions as any).path;
      if (typeof path !== "string" || !path) continue;
      wanted.add(path);
      this._attachChatMarkerScanner(actions, path);
      this._ensureChatGutterUI(path);
    }
    for (const path of Object.keys(this._chatMarkerScanners)) {
      if (wanted.has(path)) continue;
      this._chatMarkerScanners[path].dispose();
      delete this._chatMarkerScanners[path];
      this._disposeChatStateForPath(path);
      const chatMarkers = this.store.get("chat_markers");
      const invalidChatMarkers = this.store.get("invalid_chat_markers");
      const chatBookmarks = this.store.get("chat_bookmarks");
      this.setState({
        chat_markers: chatMarkers?.delete(path),
        invalid_chat_markers: invalidChatMarkers?.delete(path),
        chat_bookmarks: chatBookmarks?.delete(path),
      });
    }
    this._scheduleDiskChatScans();
  }

  private _getDiskChatCandidates(): Map<string, Set<string>> {
    const candidates = this._getActiveAnchorsByPath();
    const switchToFiles = this.store.get("switch_to_files");
    for (const path of (switchToFiles?.toJS() ?? []) as string[]) {
      if (
        path !== this.path &&
        path.toLowerCase().endsWith(".tex") &&
        !candidates.has(path)
      ) {
        candidates.set(path, new Set());
      }
    }
    for (const path of [...candidates.keys()]) {
      if (this._chatMarkerScanners?.[path] != null) {
        candidates.delete(path);
      }
    }
    return candidates;
  }

  private _scheduleDiskChatScans(force: boolean = false): void {
    if (this._state === ("closed" as any) || this._chatMarkersOwnedByParent) {
      return;
    }
    this._diskChatScanForce ||= force;
    this._diskChatScanRefresh ??= debounce(
      () => {
        const scanForce = this._diskChatScanForce;
        this._diskChatScanForce = false;
        void this._scanDiskChatSubfiles(scanForce);
      },
      500,
      { leading: false, trailing: true },
    );
    this._diskChatScanRefresh();
  }

  private async _scanDiskChatSubfiles(force: boolean = false): Promise<void> {
    if (this._state === ("closed" as any) || this._chatMarkersOwnedByParent) {
      return;
    }
    const candidates = this._getDiskChatCandidates();
    this._cleanupDiskChatScans(candidates);
    const signatures = (this._diskChatAnchorSignatures ??= new Map());
    const read =
      this._diskChatRead ??
      (this._diskChatRead = reuseInFlight(
        this._readDiskChatSubfile.bind(this),
      ));
    const reads: Promise<void>[] = [];
    for (const [path, anchorIds] of candidates) {
      const signature = [...anchorIds].sort().join("\0");
      if (!force && signatures.get(path) === signature) continue;
      // Record attempts as well as successful scans. A missing/unreadable file
      // should not be hammered on every chat message; a build refresh forces a
      // retry, and a changed anchor signature retries automatically.
      signatures.set(path, signature);
      reads.push(read(path));
    }
    await Promise.all(reads);
  }

  private async _readDiskChatSubfile(path: string): Promise<void> {
    try {
      const fs = this._get_project_actions()?.fs?.();
      if (typeof fs?.readFile !== "function") return;
      const raw = await fs.readFile(path, "utf8");
      if (
        this._state === ("closed" as any) ||
        this._chatMarkersOwnedByParent ||
        this._chatMarkerScanners?.[path] != null ||
        !this._getDiskChatCandidates().has(path)
      ) {
        // A live editor may have attached while the disk read was in flight.
        // Its syncstring scan is authoritative, so discard this result.
        return;
      }
      const text =
        typeof raw === "string"
          ? raw
          : ((raw as any)?.toString?.("utf8") ?? `${raw ?? ""}`);
      const contentHash = hash_string(text);
      const hashes = (this._diskChatContentHashes ??= new Map());
      const diskPaths = (this._diskScannedPaths ??= new Set());
      const headings = (this._diskSubfileHeadings ??= new Map());
      if (diskPaths.has(path) && hashes.get(path) === contentHash) return;

      const chatMarkers = this.store.get("chat_markers") ?? (fromJS({}) as any);
      const chatBookmarks =
        this.store.get("chat_bookmarks") ?? (fromJS({}) as any);
      hashes.set(path, contentHash);
      diskPaths.add(path);
      headings.set(path, parseTableOfContents(text));
      this.setState({
        chat_markers: chatMarkers.set(path, fromJS(scanMarkers(text))),
        chat_bookmarks: chatBookmarks.set(path, fromJS(scanBookmarks(text))),
      });
      this.updateTableOfContents();
    } catch {
      // Keep a build-known file's header, but never fall back to config-only
      // marker guesses when its source cannot be read.
    }
  }

  private _cleanupDiskChatScans(candidates: Map<string, Set<string>>): void {
    const diskPaths = (this._diskScannedPaths ??= new Set());
    const hashes = (this._diskChatContentHashes ??= new Map());
    const signatures = (this._diskChatAnchorSignatures ??= new Map());
    const headings = (this._diskSubfileHeadings ??= new Map());
    let chatMarkers = this.store.get("chat_markers");
    let chatBookmarks = this.store.get("chat_bookmarks");
    let changed = false;
    for (const path of [...diskPaths]) {
      if (candidates.has(path) && this._chatMarkerScanners?.[path] == null) {
        continue;
      }
      diskPaths.delete(path);
      hashes.delete(path);
      signatures.delete(path);
      headings.delete(path);
      chatMarkers = chatMarkers?.delete(path);
      chatBookmarks = chatBookmarks?.delete(path);
      changed = true;
    }
    for (const path of [...signatures.keys()]) {
      if (!candidates.has(path)) signatures.delete(path);
    }
    if (changed) {
      this.setState({
        chat_markers: chatMarkers,
        chat_bookmarks: chatBookmarks,
      });
      this.updateTableOfContents();
    }
  }

  private _disposeChatStateForPath(path: string): void {
    for (const cache of [this._chatGutterHosts, this._bookmarkGutterHosts]) {
      const perCm = cache[path];
      if (perCm == null) continue;
      for (const [cm, entries] of perCm) {
        for (const entry of entries) {
          try {
            cm.setGutterMarker(entry.line, CHAT_GUTTER_ID, null);
            entry.root.unmount();
          } catch {
            // The CodeMirror pane may already be gone.
          }
        }
      }
      delete cache[path];
    }
    const cursorHosts = this._cursorInsertHosts[path];
    if (cursorHosts != null) {
      for (const [cm, entry] of cursorHosts) {
        try {
          if (entry.currentHandle != null) {
            cm.setGutterMarker(entry.currentHandle, CHAT_GUTTER_ID, null);
          }
          entry.chatRoot.unmount();
          entry.bookmarkRoot.unmount();
        } catch {
          // The CodeMirror pane may already be gone.
        }
      }
      delete this._cursorInsertHosts[path];
    }
    delete this._bookmarkLines[path];
    this._clearChatTextDecorations(path);
  }

  private _attachChatMarkerScanner(actions: any, path: string): void {
    if (this._chatMarkerScanners[path] != null) return;
    const syncstring = (actions as any)._syncstring;
    if (syncstring == null) return;
    // A mounted syncstring is authoritative over an optimistic disk read.
    this._diskScannedPaths?.delete(path);
    this._diskChatContentHashes?.delete(path);
    this._diskChatAnchorSignatures?.delete(path);
    this._diskSubfileHeadings?.delete(path);
    const scan = (publishNewInvalidMarkers: boolean) => {
      if (this._state === ("closed" as any)) return;
      if (syncstring.get_state?.() !== "ready") return;
      let text: string;
      try {
        // A local CodeMirror edit can move its gutter line handles before the
        // corresponding syncstring snapshot catches up. Rescanning that stale
        // snapshot briefly moves an already-correct icon back to its old line.
        // Prefer the mounted editor buffer so decorations always match the
        // source currently visible to the user.
        const liveCm = Object.values(
          ((actions as any)._cm ?? {}) as Record<string, CodeMirror.Editor>,
        ).find((candidate) => {
          const wrapper = candidate.getWrapperElement?.();
          return wrapper == null || wrapper.isConnected;
        });
        text = liveCm?.getValue() ?? syncstring.to_str() ?? "";
      } catch {
        // syncstring not ready yet -- a later change event will rescan.
        return;
      }
      const markers = scanMarkers(text);
      const scannedInvalidMarkers = scanInvalidMarkers(text);
      const previousInvalidMarkers = (this.store
        .get("invalid_chat_markers")
        ?.get(path)
        ?.toJS() ?? []) as unknown as InvalidChatMarker[];
      // Invalid diagnostics are deliberately slower than valid marker
      // discovery. While the user is typing `% chat: subfile-123`, every
      // short prefix is temporarily invalid; rendering a widget at that
      // point interferes with the cursor. Existing diagnostics still clear
      // promptly once their exact source text is fixed or deleted.
      const invalidMarkers = publishNewInvalidMarkers
        ? scannedInvalidMarkers
        : scannedInvalidMarkers.filter((candidate) =>
            previousInvalidMarkers.some(
              (previous) =>
                previous.line === candidate.line &&
                previous.col === candidate.col &&
                previous.text === candidate.text,
            ),
          );
      const bookmarks = scanBookmarks(text);
      const previousMarkers = (this.store
        .get("chat_markers")
        ?.get(path)
        ?.toJS() ?? []) as unknown as ChatMarker[];
      // Move a config-only thread to an edited marker id before publishing
      // the new source snapshot. Otherwise the chat header can observe the
      // old anchor against the new markers and classify it as deleted.
      this._reconcileEmptyAnchorThread(path, previousMarkers, markers);
      this.setState({
        chat_markers: (
          this.store.get("chat_markers") ?? (fromJS({}) as any)
        ).set(path, fromJS(markers)),
        invalid_chat_markers: (
          this.store.get("invalid_chat_markers") ?? (fromJS({}) as any)
        ).set(path, fromJS(invalidMarkers)),
        chat_bookmarks: (
          this.store.get("chat_bookmarks") ?? (fromJS({}) as any)
        ).set(path, fromJS(bookmarks)),
      });
      this._updateChatGutters(path, markers, bookmarks);
      this._refreshChatMarkerText(path);
      this._refreshCursorInsert(path);
      if (path !== this.path) {
        // master changes already refresh the TOC via their own listener
        this.updateTableOfContents();
      }
    };
    const debounced = debounce(() => scan(false), 300, {
      leading: false,
      trailing: true,
    });
    const debouncedInvalid = debounce(() => scan(true), 1200, {
      leading: false,
      trailing: true,
    });
    const onChange = () => {
      debounced();
      debouncedInvalid();
    };
    syncstring.on("change", onChange);
    const onReady = () => scan(true);
    syncstring.once("ready", onReady);
    this._chatMarkerScanners[path] = {
      dispose: () => {
        debounced.cancel();
        debouncedInvalid.cancel();
        syncstring.removeListener("change", onChange);
        syncstring.removeListener("ready", onReady);
      },
      rescan: () => scan(true),
    };
    scan(true);
    this._ensureChatGutterUI(path);
  }

  /**
   * cocalc-ai represents a not-yet-messaged anchor as a config-only thread,
   * whereas cocalc.com keeps a separate pending anchor.  Follow a direct
   * source edit of that marker id so the first eventual message is attached
   * to the id the document actually contains.
   */
  private _reconcileEmptyAnchorThread(
    path: string,
    previous: ChatMarker[],
    next: ChatMarker[],
  ): void {
    const chatActions = this._getChatActionsForMarkerReconciliation();
    if (chatActions == null) return;
    const selectedKey = `${
      chatActions.frameTreeActions?._get_frame_data?.(
        chatActions.frameId,
        "selectedThreadKey",
      ) ??
      chatActions.store?.get("selectedThreadKey") ??
      ""
    }`;
    if (!selectedKey || selectedKey === "0") return;
    const row = chatActions
      .listThreadConfigRows()
      .find((candidate) => candidate?.thread_id === selectedKey);
    if (row == null || parseThreadResolved(row.resolved) != null) return;
    const anchor = parseThreadAnchor(row.anchor);
    if (anchor == null || (anchor.path ?? this.path) !== path) return;
    if (
      (chatActions.getThreadIndex().get(selectedKey)?.messageCount ?? 0) !== 0
    ) {
      return;
    }
    const replacement = replacementMarkerHash(previous, next, anchor.id);
    if (replacement == null) return;
    if (
      !chatActions.setThreadAnchor(selectedKey, {
        id: replacement,
        ...(anchor.path ? { path: anchor.path } : undefined),
      })
    ) {
      return;
    }
    const location = next.find((marker) => marker.hash === replacement);
    const label =
      location == null
        ? (this.getAnchorLabel(replacement) ?? replacement)
        : `${replacement} (${path_split(path).tail}:${location.line + 1})`;
    chatActions.renameThread(selectedKey, label);
  }

  private _getChatActionsForMarkerReconciliation():
    | ReturnType<typeof ensureSideChatActions>
    | undefined {
    try {
      return ensureSideChatActions(this.project_id, this.path);
    } catch {
      return undefined;
    }
  }

  private _updateChatGutters(
    path: string,
    markers: ChatMarker[],
    bookmarks: BookmarkMarker[],
  ): void {
    const actions = this._actionsForChatPath(path);
    if (actions == null) return;
    const cms = Object.values(
      ((actions as any)._cm ?? {}) as Record<string, CodeMirror.Editor>,
    );
    if (cms.length === 0) return;

    const openAnchorChat = (hash: string, markerPath: string) => {
      void this.openAnchorChat(
        hash,
        markerPath === this.path ? undefined : markerPath,
      );
    };
    const openAnchorChatThread = (threadKey: string) => {
      void this.openAnchorChatThread(threadKey);
    };
    const removeStaleMarker = (hash: string, markerPath: string) => {
      void this._removeChatMarkersForHash(markerPath, hash);
    };

    const chatTargets: Array<{ line: number; hash: string }> = [];
    const seenChatLines = new Set<number>();
    for (const marker of markers) {
      if (seenChatLines.has(marker.line)) continue;
      seenChatLines.add(marker.line);
      chatTargets.push({ line: marker.line, hash: marker.hash });
    }
    const seenBookmarkLines = new Set<number>();
    const bookmarkTargets: Array<{ line: number; text: string }> = [];
    for (const bookmark of bookmarks) {
      if (seenBookmarkLines.has(bookmark.line)) continue;
      seenBookmarkLines.add(bookmark.line);
      bookmarkTargets.push({ line: bookmark.line, text: bookmark.text });
    }
    const occupiedGutterLines = new Set([
      ...seenChatLines,
      ...seenBookmarkLines,
    ]);
    this._bookmarkLines[path] = seenBookmarkLines;
    this._updateNativeGutterHosts({
      path,
      cms,
      targets: chatTargets,
      cache: this._chatGutterHosts,
      protectedLines: occupiedGutterLines,
      render: (root, target) => {
        root.render(
          React.createElement(ChatMarkerGutter, {
            hash: target.hash,
            path,
            masterPath: this.path,
            project_id: this.project_id,
            openAnchorChat,
            openAnchorChatThread,
            removeStaleMarker,
          }),
        );
      },
    });
    this._updateNativeGutterHosts({
      path,
      cms,
      targets: bookmarkTargets,
      cache: this._bookmarkGutterHosts,
      protectedLines: occupiedGutterLines,
      render: (root, target) => {
        root.render(React.createElement(BookmarkGutter, { text: target.text }));
      },
    });
  }

  private _actionsForChatPath(
    path: string,
  ): BaseActions<CodeEditorState> | undefined {
    const actions =
      path === this.path
        ? this
        : this.redux.getEditorActions(this.project_id, path_normalize(path));
    if (actions == null || (actions as any)._state === "closed") {
      return undefined;
    }
    return actions as BaseActions<CodeEditorState>;
  }

  private _updateNativeGutterHosts<T extends { line: number }>({
    path,
    cms,
    targets,
    cache,
    protectedLines,
    render,
  }: {
    path: string;
    cms: CodeMirror.Editor[];
    targets: T[];
    cache: {
      [path: string]: Map<
        CodeMirror.Editor,
        Array<{ host: HTMLElement; root: Root; line: number }>
      >;
    };
    protectedLines: ReadonlySet<number>;
    render: (root: Root, target: T) => void;
  }): void {
    const perCm = cache[path] ?? (cache[path] = new globalThis.Map());
    const liveCms = new Set(cms);
    for (const staleCm of [...perCm.keys()]) {
      if (liveCms.has(staleCm)) continue;
      for (const entry of perCm.get(staleCm) ?? []) {
        entry.root.unmount();
      }
      perCm.delete(staleCm);
    }
    for (const cm of cms) {
      const existing = perCm.get(cm) ?? [];
      const fresh: Array<{ host: HTMLElement; root: Root; line: number }> = [];
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const reused = existing[i];
        const host = reused?.host ?? document.createElement("span");
        const root = reused?.root ?? createRoot(host);
        render(root, target);
        if (
          reused != null &&
          reused.line !== target.line &&
          !protectedLines.has(reused.line)
        ) {
          cm.setGutterMarker(reused.line, CHAT_GUTTER_ID, null);
        }
        cm.setGutterMarker(target.line, CHAT_GUTTER_ID, host);
        fresh.push({ host, root, line: target.line });
      }
      for (let i = targets.length; i < existing.length; i++) {
        const entry = existing[i];
        if (!protectedLines.has(entry.line)) {
          cm.setGutterMarker(entry.line, CHAT_GUTTER_ID, null);
        }
        entry.root.unmount();
      }
      perCm.set(cm, fresh);
    }
  }

  private _ensureChatGutterUI(path: string, retries = 8): void {
    if (this._state === ("closed" as any)) return;
    const actions = this._actionsForChatPath(path);
    const cms = Object.values(
      ((actions as any)?._cm ?? {}) as Record<string, CodeMirror.Editor>,
    );
    if (cms.length === 0) {
      if (retries > 0) {
        setTimeout(() => this._ensureChatGutterUI(path, retries - 1), 250);
      }
      return;
    }
    const perCm =
      this._cursorInsertHosts[path] ??
      (this._cursorInsertHosts[path] = new globalThis.Map());
    const liveCms = new Set(cms);
    for (const staleCm of [...perCm.keys()]) {
      if (liveCms.has(staleCm)) continue;
      const stale = perCm.get(staleCm);
      stale?.chatRoot.unmount();
      stale?.bookmarkRoot.unmount();
      perCm.delete(staleCm);
    }
    for (const cm of cms) {
      this._ensureChatMarkerClickHandler(cm, path);
      this._ensureChatKeybindings(cm, path);
      this._ensureChatTailTracking(cm, path);
      if (!perCm.has(cm)) {
        const host = document.createElement("span");
        host.className = "cc-chat-cursor-insert";
        host.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        const makeIcon = (
          title: string,
          icon: "comment" | "tag-outlined",
          onClick: (line: number) => void,
        ): Root => {
          const child = document.createElement("span");
          child.title = title;
          child.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const entry = this._cursorInsertHosts[path]?.get(cm);
            if (entry?.currentHandle == null) return;
            const line = cm.getLineNumber(entry.currentHandle);
            if (line != null) onClick(line);
          });
          host.appendChild(child);
          const root = createRoot(child);
          root.render(React.createElement(Icon, { name: icon }));
          return root;
        };
        const chatRoot = makeIcon(
          "Insert chat anchor before this line",
          "comment",
          (line) => void this._insertChatMarkerBeforeLine(path, line, cm),
        );
        const bookmarkRoot = makeIcon(
          "Insert bookmark before this line",
          "tag-outlined",
          (line) => this._insertBookmarkBeforeLine(path, line, cm),
        );
        perCm.set(cm, {
          host,
          chatRoot,
          bookmarkRoot,
          currentHandle: null,
        });
      }
      if (!this._cursorInsertBound.has(cm)) {
        this._cursorInsertBound.add(cm);
        cm.on("cursorActivity", () => this._refreshCursorInsert(path, cm));
      }
    }

    const markers = (this.store.get("chat_markers")?.get(path)?.toJS() ??
      []) as unknown as ChatMarker[];
    const bookmarks = (this.store.get("chat_bookmarks")?.get(path)?.toJS() ??
      []) as unknown as BookmarkMarker[];
    this._updateChatGutters(path, markers, bookmarks);
    this._refreshChatMarkerText(path);
    this._refreshCursorInsert(path);
  }

  private _ensureChatMarkerClickHandler(
    cm: CodeMirror.Editor,
    path: string,
  ): void {
    if (this._chatClickHandlerInstalled.has(cm)) return;
    this._chatClickHandlerInstalled.add(cm);
    cm.on("mousedown", (_editor, event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const pos = cm.coordsChar(
        { left: event.clientX, top: event.clientY },
        "window",
      );
      for (const marker of cm.findMarksAt(pos)) {
        const hash = (marker as any).chatHash as string | undefined;
        if (typeof hash !== "string") continue;
        event.preventDefault();
        void this.openAnchorChat(hash, path === this.path ? undefined : path);
        return;
      }
    });
  }

  private _ensureChatKeybindings(cm: CodeMirror.Editor, path: string): void {
    if (this._chatKeybindingInstalled.has(cm)) return;
    this._chatKeybindingInstalled.add(cm);
    cm.addKeyMap({
      "Shift-Ctrl-M": () => void this.insertChatMarker({ path, cm }),
      "Shift-Cmd-M": () => void this.insertChatMarker({ path, cm }),
      "Shift-Ctrl-B": () => void this.insertBookmark({ path, cm }),
      "Shift-Cmd-B": () => void this.insertBookmark({ path, cm }),
    });
  }

  /**
   * CodeMirror normally tracks bookmark widgets through local edits, but a
   * rapid sequence of line splits can briefly leave an inline widget painted
   * at its previous visual line until the debounced source scan rebuilds it.
   * The marker TextMarker itself moves synchronously. Use the post-operation
   * `changes` event, after CodeMirror has finalized every marker position, to
   * realign the pill without a transient jump from the old visual line.
   */
  private _ensureChatTailTracking(cm: CodeMirror.Editor, path: string): void {
    if (this._chatTailTrackingInstalled.has(cm)) return;
    this._chatTailTrackingInstalled.add(cm);
    cm.on("changes", (_editor, changes) => {
      let forceFromLine: number | undefined;
      for (const change of changes) {
        const insertedLineCount = change.text.length - 1;
        const removedLineCount = change.to.line - change.from.line;
        if (insertedLineCount === removedLineCount) continue;
        forceFromLine =
          forceFromLine == null
            ? change.from.line
            : Math.min(forceFromLine, change.from.line);
      }
      this._syncChatTailPositions(path, cm, forceFromLine);
    });
  }

  private _syncChatTailPositions(
    path: string,
    cm: CodeMirror.Editor,
    forceFromLine?: number,
  ): void {
    const markers = this._chatTextMarkers[path]?.get(cm);
    const tails = this._chatTailHosts[path]?.get(cm);
    if (markers == null || tails == null) return;
    const count = Math.min(markers.length, tails.length);
    for (let i = 0; i < count; i++) {
      const range = markers[i].find() as
        | { from: CodeMirror.Position; to: CodeMirror.Position }
        | undefined;
      if (range == null || !("to" in range)) continue;
      const current = tails[i].bookmark.find() as
        | CodeMirror.Position
        | undefined;
      const force = forceFromLine != null && range.to.line >= forceFromLine;
      if (
        !force &&
        current != null &&
        current.line === range.to.line &&
        current.ch === range.to.ch
      ) {
        continue;
      }
      const { host } = tails[i];
      tails[i].bookmark.clear();
      host.parentNode?.removeChild(host);
      tails[i].bookmark = cm.setBookmark(range.to, {
        widget: host,
        insertLeft: false,
        handleMouseEvents: true,
      });
    }
  }

  private _refreshCursorInsert(path: string, onlyCm?: CodeMirror.Editor): void {
    const perCm = this._cursorInsertHosts[path];
    if (perCm == null) return;
    const markerLines = new Set<number>(
      ((this.store.get("chat_markers")?.get(path)?.toJS() ?? []) as any[]).map(
        (marker) => marker.line,
      ),
    );
    const invalidMarkerLines = new Set<number>(
      (
        (this.store.get("invalid_chat_markers")?.get(path)?.toJS() ??
          []) as any[]
      ).map((marker) => marker.line),
    );
    const occupied = new Set([
      ...markerLines,
      ...invalidMarkerLines,
      ...(this._bookmarkLines[path] ?? []),
    ]);
    for (const [cm, entry] of perCm) {
      if (onlyCm != null && cm !== onlyCm) continue;
      const line = cm.getCursor().line;
      const nextHandle = occupied.has(line) ? null : cm.getLineHandle(line);
      if (entry.currentHandle === nextHandle) continue;
      if (entry.currentHandle != null) {
        const oldLine = cm.getLineNumber(entry.currentHandle);
        if (oldLine != null && !occupied.has(oldLine)) {
          cm.setGutterMarker(entry.currentHandle, CHAT_GUTTER_ID, null);
        }
      }
      if (nextHandle != null) {
        cm.setGutterMarker(nextHandle, CHAT_GUTTER_ID, entry.host);
      }
      entry.currentHandle = nextHandle;
    }
  }

  private _anchorHasMessages(hash: string): boolean {
    try {
      const actions = ensureSideChatActions(this.project_id, this.path);
      const threadIndex = actions.getThreadIndex();
      return actions
        .listAnchoredThreadKeys(hash)
        .some(
          (threadKey) => (threadIndex.get(threadKey)?.messageCount ?? 0) > 0,
        );
    } catch {
      return false;
    }
  }

  private _createChatTextMarker({
    cm,
    hash,
    path,
    from,
    to,
    locked,
  }: {
    cm: CodeMirror.Editor;
    hash: string;
    path: string;
    from: CodeMirror.Position;
    to: CodeMirror.Position;
    locked: boolean;
  }): CodeMirror.TextMarker {
    const marker = cm.markText(from, to, {
      className: locked
        ? "cc-chat-marker cc-chat-marker-locked"
        : "cc-chat-marker",
      clearOnEnter: false,
      // Keep the left edge outside the atom so the cursor can rest immediately
      // before `%` and insert text there. Protect the right edge: otherwise
      // Backspace from the next line can remove the newline and typing at the
      // old right edge can silently extend the hash outside the read-only
      // range, turning it into a new editable anchor.
      inclusiveLeft: false,
      inclusiveRight: locked,
      handleMouseEvents: false,
      readOnly: locked,
      atomic: locked,
      attributes: {
        title: locked
          ? "Open chat thread (locked — remove the marker to edit)"
          : "Open chat thread",
      },
    });
    (marker as any).chatHash = hash;
    (marker as any).chatPath = path;
    (marker as any).chatLocked = locked;
    return marker;
  }

  private _createInvalidChatTextMarker({
    cm,
    text,
    from,
    to,
  }: {
    cm: CodeMirror.Editor;
    text: string;
    from: CodeMirror.Position;
    to: CodeMirror.Position;
  }): CodeMirror.TextMarker {
    const marker = cm.markText(from, to, {
      className: "cc-chat-marker-invalid",
      clearOnEnter: false,
      inclusiveLeft: false,
      inclusiveRight: false,
      attributes: {
        title: "Invalid chat ID — edit this comment to fix it",
      },
    });
    (marker as any).invalidChatMarker = true;
    (marker as any).invalidChatText = text;
    return marker;
  }

  private _canReuseChatTextDecorations({
    existing,
    markers,
    invalidMarkers,
    path,
  }: {
    existing: CodeMirror.TextMarker[];
    markers: ChatMarker[];
    invalidMarkers: InvalidChatMarker[];
    path: string;
  }): boolean {
    if (existing.length !== markers.length + invalidMarkers.length) {
      return false;
    }
    for (let i = 0; i < markers.length; i++) {
      const decoration: any = existing[i];
      const range = decoration.find?.();
      if (
        range == null ||
        !("from" in range) ||
        (range.from.line === range.to.line && range.from.ch === range.to.ch) ||
        decoration.chatHash !== markers[i].hash ||
        decoration.chatPath !== path ||
        decoration.chatLocked !== this._anchorHasMessages(markers[i].hash)
      ) {
        return false;
      }
    }
    for (let i = 0; i < invalidMarkers.length; i++) {
      const decoration: any = existing[markers.length + i];
      const range = decoration.find?.();
      if (
        range == null ||
        !("from" in range) ||
        (range.from.line === range.to.line && range.from.ch === range.to.ch) ||
        decoration.invalidChatMarker !== true ||
        decoration.invalidChatText !== invalidMarkers[i].text
      ) {
        return false;
      }
    }
    return true;
  }

  private _sweepStaleChatTailHosts(
    cm: CodeMirror.Editor,
    liveTails: Array<{ host: HTMLElement }>,
  ): void {
    const wrapper = cm.getWrapperElement?.();
    if (wrapper == null) return;
    const liveHosts = new Set(liveTails.map(({ host }) => host));
    wrapper
      .querySelectorAll<HTMLElement>(".cc-chat-marker-tail-host")
      .forEach((host) => {
        if (!liveHosts.has(host)) {
          host.parentNode?.removeChild(host);
        }
      });
  }

  private _refreshChatMarkerText(path: string): void {
    const actions = this._actionsForChatPath(path);
    if (actions == null) return;
    const cms = Object.values(
      ((actions as any)._cm ?? {}) as Record<string, CodeMirror.Editor>,
    );
    if (cms.length === 0) return;
    const perCm =
      this._chatTextMarkers[path] ??
      (this._chatTextMarkers[path] = new globalThis.Map());
    const tailsPerCm =
      this._chatTailHosts[path] ??
      (this._chatTailHosts[path] = new globalThis.Map());
    const liveCms = new Set(cms);
    for (const staleCm of [...perCm.keys()]) {
      if (liveCms.has(staleCm)) continue;
      for (const marker of perCm.get(staleCm) ?? []) {
        marker.clear();
      }
      perCm.delete(staleCm);
    }
    for (const staleCm of [...tailsPerCm.keys()]) {
      if (liveCms.has(staleCm)) continue;
      for (const tail of tailsPerCm.get(staleCm) ?? []) {
        tail.bookmark.clear();
        tail.root.unmount();
      }
      tailsPerCm.delete(staleCm);
    }
    const markers = (this.store.get("chat_markers")?.get(path)?.toJS() ??
      []) as unknown as ChatMarker[];
    const invalidMarkers = (this.store
      .get("invalid_chat_markers")
      ?.get(path)
      ?.toJS() ?? []) as unknown as InvalidChatMarker[];
    for (const cm of cms) {
      const existing = perCm.get(cm) ?? [];
      const oldTails = tailsPerCm.get(cm) ?? [];
      if (
        oldTails.length === markers.length + invalidMarkers.length &&
        this._canReuseChatTextDecorations({
          existing,
          markers,
          invalidMarkers,
          path,
        })
      ) {
        // CodeMirror has already moved both TextMarkers and bookmarks with
        // the edit. Preserve their React roots and unread state rather than
        // detaching every inline control on each debounced source rescan.
        this._syncChatTailPositions(path, cm);
        this._sweepStaleChatTailHosts(cm, oldTails);
        continue;
      }
      for (const marker of existing) {
        marker.clear();
      }
      const fresh: CodeMirror.TextMarker[] = [];
      const freshTails: Array<{
        bookmark: CodeMirror.TextMarker;
        host: HTMLElement;
        root: Root;
      }> = [];
      for (const marker of markers) {
        const lineText = cm.getLine(marker.line) ?? "";
        fresh.push(
          this._createChatTextMarker({
            cm,
            hash: marker.hash,
            path,
            from: { line: marker.line, ch: marker.col },
            to: { line: marker.line, ch: lineText.length },
            locked: this._anchorHasMessages(marker.hash),
          }),
        );
        const reused = oldTails[freshTails.length];
        const host = reused?.host ?? document.createElement("span");
        host.className = "cc-chat-marker-tail-host";
        const root = reused?.root ?? createRoot(host);
        root.render(
          React.createElement(ChatMarkerInlineTail, {
            hash: marker.hash,
            masterPath: this.path,
            project_id: this.project_id,
            onOpen: () => {
              void this.openAnchorChat(
                marker.hash,
                path === this.path ? undefined : path,
              );
            },
            onConfirmResolve: (expectsThread) =>
              this.resolveChatMarker(marker.hash, expectsThread),
            onConfirmRemoveStale: () =>
              void this._removeChatMarkersForHash(path, marker.hash),
          }),
        );
        reused?.bookmark.clear();
        host.parentNode?.removeChild(host);
        const bookmark = cm.setBookmark(
          { line: marker.line, ch: lineText.length },
          { widget: host, insertLeft: false, handleMouseEvents: true },
        );
        freshTails.push({ bookmark, host, root });
      }
      for (const marker of invalidMarkers) {
        const lineText = cm.getLine(marker.line) ?? "";
        fresh.push(
          this._createInvalidChatTextMarker({
            cm,
            text: marker.text,
            from: { line: marker.line, ch: marker.col },
            to: { line: marker.line, ch: lineText.length },
          }),
        );
        const reused = oldTails[freshTails.length];
        const host = reused?.host ?? document.createElement("span");
        host.className = "cc-chat-marker-tail-host";
        const root = reused?.root ?? createRoot(host);
        root.render(
          React.createElement(InvalidChatMarkerTail, { text: marker.text }),
        );
        reused?.bookmark.clear();
        host.parentNode?.removeChild(host);
        const bookmark = cm.setBookmark(
          { line: marker.line, ch: lineText.length },
          { widget: host, insertLeft: false, handleMouseEvents: true },
        );
        freshTails.push({ bookmark, host, root });
      }
      for (let i = freshTails.length; i < oldTails.length; i++) {
        oldTails[i].bookmark.clear();
        oldTails[i].root.unmount();
      }
      perCm.set(cm, fresh);
      tailsPerCm.set(cm, freshTails);

      // CodeMirror may leave a detached bookmark wrapper behind when a
      // marker changes identity during a rescan. Remove any tail host in
      // this pane that is not one of the hosts we just placed.
      this._sweepStaleChatTailHosts(cm, freshTails);
    }
  }

  private _refreshChatMarkerLocks(): void {
    for (const [path, perCm] of Object.entries(this._chatTextMarkers)) {
      for (const [cm, existing] of perCm) {
        const fresh: CodeMirror.TextMarker[] = [];
        const tails = this._chatTailHosts[path]?.get(cm) ?? [];
        const freshTails: typeof tails = [];
        for (let i = 0; i < existing.length; i++) {
          const marker = existing[i];
          const tail = tails[i];
          const range = marker.find() as
            | { from: CodeMirror.Position; to: CodeMirror.Position }
            | undefined;
          if (range == null || !("from" in range)) {
            marker.clear();
            tail?.bookmark.clear();
            tail?.root.unmount();
            continue;
          }
          if ((marker as any).invalidChatMarker === true) {
            fresh.push(marker);
            if (tail != null) freshTails.push(tail);
            continue;
          }
          const hash = (marker as any).chatHash as string | undefined;
          if (hash == null) {
            marker.clear();
            tail?.bookmark.clear();
            tail?.root.unmount();
            continue;
          }
          const locked = this._anchorHasMessages(hash);
          if ((marker as any).chatLocked === locked) {
            fresh.push(marker);
            if (tail != null) freshTails.push(tail);
            continue;
          }
          marker.clear();
          fresh.push(
            this._createChatTextMarker({
              cm,
              hash,
              path,
              from: range.from,
              to: range.to,
              locked,
            }),
          );
          if (tail != null) freshTails.push(tail);
        }
        perCm.set(cm, fresh);
        this._chatTailHosts[path]?.set(cm, freshTails);
      }
    }
  }

  private _initChatAnchorLockListener(retries = 40): void {
    if (this._state === ("closed" as any) || this._chatMarkersOwnedByParent) {
      return;
    }
    let chatActions;
    try {
      chatActions = ensureSideChatActions(this.project_id, this.path);
    } catch {
      if (retries > 0) {
        setTimeout(() => this._initChatAnchorLockListener(retries - 1), 250);
      }
      return;
    }
    const store = chatActions.store;
    if (store == null) {
      if (retries > 0) {
        setTimeout(() => this._initChatAnchorLockListener(retries - 1), 250);
      }
      return;
    }
    const refresh = debounce(
      () => {
        if (this._state === ("closed" as any)) return;
        this._refreshChatMarkerLocks();
        // A remote thread config can identify a marker in an unopened
        // subfile. Verify unopened candidates from disk before updating their
        // TOC rows; thread metadata alone includes deleted historical anchors.
        this._scheduleDiskChatScans();
        this.updateTableOfContents();
      },
      150,
      { leading: true, trailing: true },
    );
    let subscribedMessageCache = chatActions.messageCache;
    const bindCurrentMessageCache = () => {
      const next = chatActions.messageCache;
      if (next === subscribedMessageCache) return;
      subscribedMessageCache?.removeListener?.("version", refresh);
      subscribedMessageCache = next;
      subscribedMessageCache?.on?.("version", refresh);
    };
    const onStoreChange = () => {
      bindCurrentMessageCache();
      refresh();
    };
    store.on("change", onStoreChange);
    // Remote messages update the shared message cache without necessarily
    // changing the Redux chat store.  Lock marker text as soon as that cache
    // publishes its new thread count.
    subscribedMessageCache?.on?.("version", refresh);
    const reconnect = () => {
      this._chatStoreDispose?.();
      this._chatStoreDispose = undefined;
      this._initChatAnchorLockListener();
    };
    chatActions.syncdb?.once?.("close", reconnect);
    this._chatStoreDispose = () => {
      store.removeListener("change", onStoreChange);
      subscribedMessageCache?.removeListener?.("version", refresh);
      chatActions.syncdb?.removeListener?.("close", reconnect);
      refresh.cancel();
    };
    refresh();
  }

  // All locations of a marker hash across the scanned files, in
  // (path, line) order with the master file first.
  public getAnchorLocations(hash: string): { path: string; line: number }[] {
    const chatMarkers = this.store.get("chat_markers");
    if (chatMarkers == null) return [];
    const locations: { path: string; line: number }[] = [];
    const paths = chatMarkers.keySeq().toJS() as string[];
    paths.sort((a, b) =>
      a === this.path ? -1 : b === this.path ? 1 : a.localeCompare(b),
    );
    for (const path of paths) {
      const markers = (chatMarkers.get(path)?.toJS() ??
        []) as unknown as ChatMarker[];
      for (const m of markers) {
        if (m.hash === hash) {
          locations.push({ path, line: m.line });
        }
      }
    }
    return locations;
  }

  public getAnchorJumpLabel = (
    hash: string,
    recordedPath?: string,
  ): string | undefined => {
    const locations = this.getAnchorLocations(hash);
    if (locations.length === 0) {
      const path = this._getUnloadedAnchorPath(hash, recordedPath);
      return path == null ? undefined : path_split(path).tail;
    }
    if (locations.length > 1) {
      return `${locations.length} locations`;
    }
    const { path, line } = locations[0];
    return `${path_split(path).tail}:${line + 1}`;
  };

  public getAnchorLabel = (hash: string): string | undefined => {
    const jumpLabel = this.getAnchorJumpLabel(hash);
    if (jumpLabel == null) return hash;
    return `${hash} (${jumpLabel})`;
  };

  public canJumpToAnchor = (hash: string, recordedPath?: string): boolean => {
    return this.getAnchorState(hash, recordedPath) !== "missing";
  };

  public getMissingAnchorMessage = (_hash: string): string => {
    return "This chat marker was removed";
  };

  public getAnchorState = (
    hash: string,
    recordedPath?: string,
  ): "available" | "missing" | "unloaded" => {
    if (this.getAnchorLocations(hash).length > 0) {
      return "available";
    }
    return this._getUnloadedAnchorPath(hash, recordedPath) == null
      ? "missing"
      : "unloaded";
  };

  private _getUnloadedAnchorPath(
    hash: string,
    recordedPath?: string,
  ): string | undefined {
    if (
      recordedPath != null &&
      recordedPath !== this.path &&
      !this.store.get("chat_markers")?.has(recordedPath)
    ) {
      return recordedPath;
    }
    let chatActions;
    try {
      chatActions = ensureSideChatActions(this.project_id, this.path);
    } catch {
      return;
    }
    for (const row of chatActions.listThreadConfigRows()) {
      if (parseThreadResolved(row?.resolved) != null) continue;
      const anchor = parseThreadAnchor(row?.anchor);
      if (
        anchor?.id === hash &&
        anchor.path != null &&
        anchor.path !== this.path &&
        !this.store.get("chat_markers")?.has(anchor.path)
      ) {
        return anchor.path;
      }
    }
  }

  public jumpToAnchor = async (
    hash: string,
    recordedPath?: string,
  ): Promise<void> => {
    const locations = this.getAnchorLocations(hash);
    if (locations.length === 0) {
      const path = this._getUnloadedAnchorPath(hash, recordedPath);
      if (path == null) return;
      const frameId = await this._switchFocusedSourceTo(path);
      if (frameId == null) return;
      for (let retries = 0; retries < 40; retries += 1) {
        this._refreshChatMarkerScanners();
        this._chatMarkerScanners[path]?.rescan();
        const loaded = this.getAnchorLocations(hash).find(
          (location) => location.path === path,
        );
        if (loaded != null) {
          await this._gotoSourceLine(path, loaded.line + 1, frameId);
          return;
        }
        await delay(100);
      }
      return;
    }
    const { path, line } = locations[0];
    const frameId = await this._switchFocusedSourceTo(path);
    if (frameId == null) return;
    await this._gotoSourceLine(path, line + 1, frameId);
  };

  private async _switchFocusedSourceTo(
    path: string,
  ): Promise<string | undefined> {
    const frameId =
      this._get_most_recent_active_frame_id_of_type("cm") ??
      this.show_focused_frame_of_type("cm");
    if (frameId == null) return;
    const currentPath = this._get_frame_node(frameId)?.get("path") ?? this.path;
    if (currentPath === path) {
      await this._waitForSourcePane(path, frameId);
      return frameId;
    }
    const switchedFrameId = await this.switch_to_file(path, frameId);
    await this._waitForSourcePane(path, switchedFrameId);
    return switchedFrameId;
  }

  private async _waitForSourcePane(
    path: string,
    frameId: string,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start <= 15000) {
      if (this.isClosed()) return;
      const actions: any = this._actionsForChatPath(path);
      const cm: CodeMirror.Editor | undefined = actions?._cm?.[frameId];
      const wrapper = cm?.getWrapperElement?.();
      // CodeMirror keeps detached instances cached by frame id.  Wait for
      // React to register the newly mounted, connected instance after a
      // file switch instead of jumping in the stale document.
      if (cm != null && (wrapper == null || wrapper.isConnected)) {
        return;
      }
      await delay(50);
    }
  }

  private async _gotoSourceLine(
    path: string,
    line: number,
    frameId: string,
  ): Promise<void> {
    const actions = this._actionsForChatPath(path);
    if (actions == null) return;
    this.set_active_id(frameId, true);
    await actions.programmatically_goto_line(line, true, true, frameId);
  }

  // Resolve the most recently focused source pane in this frame tree:
  // the file path it shows (master or an included file), the owning
  // editor actions, and the live CM instance.  Frames showing included
  // files are cm frames with a path override; their CM is registered on
  // the included file's own editor actions.
  private _activeSourceTarget(requested?: {
    path: string;
    cm: CodeMirror.Editor;
  }):
    | { path: string; actions: any; cm: CodeMirror.Editor; frameId?: string }
    | undefined {
    if (requested != null) {
      const actions: any = this._actionsForChatPath(requested.path);
      if (actions == null) return undefined;
      const frameId = Object.entries(
        (actions._cm ?? {}) as Record<string, CodeMirror.Editor>,
      ).find(([, candidate]) => candidate === requested.cm)?.[0];
      return {
        path: requested.path,
        actions,
        cm: requested.cm,
        frameId,
      };
    }
    const frameId = this._get_most_recent_active_frame_id_of_type("cm");
    if (frameId == null) return undefined;
    const node = this._get_frame_node(frameId);
    const path = node?.get("path") ?? this.path;
    const actions: any =
      path === this.path
        ? this
        : this.redux.getEditorActions(this.project_id, path);
    if (actions == null) return undefined;
    let cm: CodeMirror.Editor | undefined = actions._cm?.[frameId];
    let cmFrameId: string | undefined = frameId;
    if (cm == null) {
      cm = actions._get_cm?.(undefined, true);
      cmFrameId = undefined;
    }
    if (cm == null) return undefined;
    return { path, actions, cm, frameId: cmFrameId };
  }

  // Insert a `% chat: <hash>` marker at the cursor of the most recently
  // active source pane (master or included file) and open a fresh
  // side-chat thread for it.
  public insertChatMarker = async (
    opts: {
      mode?: "inline" | "block";
      path?: string;
      cm?: CodeMirror.Editor;
    } = {},
  ): Promise<void> => {
    if (this.is_read_only_preview()) return;
    const hash = generateMarkerHash();
    const target = this._insertMarkerText(
      buildMarkerLine(hash),
      buildInlineInsertion(hash),
      opts.path != null && opts.cm != null
        ? { path: opts.path, cm: opts.cm }
        : undefined,
    );
    if (target == null) {
      return;
    }
    this._chatMarkerScanners[target.path]?.rescan();
    await this.openAnchorChatNewThread(
      hash,
      target.path === this.path ? undefined : target.path,
    );
  };

  // Insert a `% bookmark: <text>` comment at the cursor.  Bookmarks are
  // source-only: they show up in the table of contents but have no
  // chat thread.
  public insertBookmark = async (
    opts: { path?: string; cm?: CodeMirror.Editor } = {},
  ): Promise<void> => {
    if (this.is_read_only_preview()) return;
    const text = generateBookmarkText(new Date());
    const target = this._insertMarkerText(
      buildBookmarkLine(text),
      undefined,
      opts.path != null && opts.cm != null
        ? { path: opts.path, cm: opts.cm }
        : undefined,
    );
    if (target == null) {
      return;
    }
    this._chatMarkerScanners[target.path]?.rescan();
    this.updateTableOfContents(true);
  };

  // Insert a standalone comment line (or an inline tail when the cursor
  // line has tex content and `inline` is provided) at the cursor of the
  // focused source pane.  Returns the pane's file path, or undefined
  // when no editor is available.
  private _insertMarkerText(
    blockLine: string,
    inline?: string,
    requested?: { path: string; cm: CodeMirror.Editor },
  ): { path: string } | undefined {
    const target = this._activeSourceTarget(requested);
    if (target == null) return undefined;
    const { cm, actions, path, frameId } = target;
    const before = cm.getValue();
    const cur = cm.getCursor();
    const lineText = cm.getLine(cur.line) ?? "";
    if (inline != null && lineHasTexContent(lineText)) {
      cm.replaceRange(inline, { line: cur.line, ch: lineText.length });
    } else if (lineText.trim() === "") {
      cm.replaceRange(
        blockLine,
        { line: cur.line, ch: 0 },
        { line: cur.line, ch: lineText.length },
      );
    } else {
      // comment-only (or otherwise occupied) line: add a new line below.
      cm.replaceRange(`\n${blockLine}`, {
        line: cur.line,
        ch: lineText.length,
      });
    }
    // CodeMirror silently cancels edits that touch an atomic/read-only
    // marker. Do not create a config-only chat thread (or report a bookmark
    // insertion) unless the source buffer actually changed.
    if (cm.getValue() === before) {
      return undefined;
    }
    actions.set_syncstring_to_codemirror(frameId);
    actions.syncstring_commit();
    return { path };
  }

  private _commitChatGutterEdit(
    actions: BaseActions<CodeEditorState>,
    cm: CodeMirror.Editor,
  ): void {
    const frameId = Object.entries(
      ((actions as any)._cm ?? {}) as Record<string, CodeMirror.Editor>,
    ).find(([, candidate]) => candidate === cm)?.[0];
    actions.set_syncstring_to_codemirror(frameId);
    actions.syncstring_commit();
  }

  private async _insertChatMarkerBeforeLine(
    path: string,
    line: number,
    cm: CodeMirror.Editor,
  ): Promise<void> {
    const actions = this._actionsForChatPath(path);
    if (actions == null) return;
    const hash = generateMarkerHash();
    cm.replaceRange(`${buildMarkerLine(hash)}\n\n`, { line, ch: 0 });
    this._commitChatGutterEdit(actions, cm);
    this._chatMarkerScanners[path]?.rescan();
    await this.openAnchorChatNewThread(
      hash,
      path === this.path ? undefined : path,
    );
  }

  private _insertBookmarkBeforeLine(
    path: string,
    line: number,
    cm: CodeMirror.Editor,
  ): void {
    const actions = this._actionsForChatPath(path);
    if (actions == null) return;
    const text = generateBookmarkText(new Date());
    const markerLine = buildBookmarkLine(text);
    cm.replaceRange(`${markerLine}\n\n`, { line, ch: 0 });
    this._commitChatGutterEdit(actions, cm);
    this._chatMarkerScanners[path]?.rescan();
    this.updateTableOfContents(true);
    const textStart = markerLine.length - text.length;
    cm.setSelection({ line, ch: textStart }, { line, ch: markerLine.length });
    cm.focus();
  }

  // Resolve every thread anchored to `hash` (collaborative-TODO flow)
  // and remove the marker comment(s) from all scanned files.  The
  // threads remain in the side chat as a read-only record.
  public async resolveChatMarker(
    hash: string,
    expectsThread = true,
  ): Promise<void> {
    const chatActions = await this._waitForReadyChatActions();
    if (chatActions == null) {
      console.warn("resolveChatMarker: side chat did not become ready", {
        project_id: this.project_id,
        path: this.path,
        hash,
      });
      antdMessage.warning(
        "Chat is still loading; the marker was not removed. Please try again.",
      );
      return;
    }
    const label = this.getAnchorLabel(hash);
    let threadKeys: string[] = [];
    if (expectsThread) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        threadKeys = chatActions.listAnchoredThreadKeys(hash);
        if (threadKeys.length > 0) break;
        await delay(100);
      }
    }
    // Never turn a known discussion into a marker-only deletion just because
    // this client has not received its thread-config row yet.
    if (expectsThread && threadKeys.length === 0) {
      console.warn("resolveChatMarker: anchored thread is still syncing", {
        project_id: this.project_id,
        path: this.path,
        hash,
      });
      antdMessage.warning(
        "Chat is still syncing; the marker was not removed. Please try again.",
      );
      return;
    }
    const chatMarkers = this.store.get("chat_markers");
    if (chatMarkers == null) return;
    const markerPaths = (chatMarkers.keySeq().toJS() as string[]).filter(
      (path) =>
        chatMarkers
          .get(path)
          ?.some(
            (marker: any) => (marker?.get?.("hash") ?? marker?.hash) === hash,
          ) === true,
    );
    if (markerPaths.length === 0) return;
    for (const path of markerPaths) {
      if (!(await this._removeChatMarkersForHash(path, hash))) {
        console.warn("resolveChatMarker: failed to update marker source", {
          project_id: this.project_id,
          path,
          hash,
        });
        antdMessage.warning(
          "The source file could not be updated; the chat was not resolved.",
        );
        return;
      }
    }
    if (!expectsThread) return;

    for (const threadKey of threadKeys) {
      if (!chatActions.resolveAnchoredThread(threadKey, { label })) {
        console.warn("resolveChatMarker: failed to resolve anchored thread", {
          project_id: this.project_id,
          path: this.path,
          hash,
          threadKey,
        });
        antdMessage.warning(
          "The marker was removed, but the chat could not be resolved. Please try again.",
        );
        return;
      }
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const remaining = chatActions.listAnchoredThreadKeys(hash);
      const hasResolved = chatActions
        .listThreadConfigRows()
        .some((row) => parseThreadResolved(row?.resolved)?.anchorId === hash);
      if (remaining.length === 0 && hasResolved) return;
      await delay(100);
    }
    console.warn("resolveChatMarker: resolved state is still syncing", {
      project_id: this.project_id,
      path: this.path,
      hash,
    });
    antdMessage.warning(
      "The marker was removed and the chat is still finishing resolution.",
    );
  }

  private async _waitForReadyChatActions(): Promise<
    ReturnType<typeof ensureSideChatActions> | undefined
  > {
    for (const wait of [0, 25, 50, 100, 250, 500, 1000, 2000]) {
      if (wait > 0) await delay(wait);
      if (this._state === ("closed" as any)) return;
      try {
        const actions = ensureSideChatActions(this.project_id, this.path);
        if (actions.syncdb?.get_state?.() === "ready") {
          return actions;
        }
      } catch {
        // Side chat is still mounting; retry within the bounded window.
      }
    }
  }

  // Remove all `% chat: <hash>` markers for one hash from one file.
  private _clearChatTextDecorations(path: string): void {
    const markers = this._chatTextMarkers[path];
    if (markers != null) {
      for (const list of markers.values()) {
        for (const marker of list) marker.clear();
      }
      delete this._chatTextMarkers[path];
    }
    const tails = this._chatTailHosts[path];
    if (tails != null) {
      for (const list of tails.values()) {
        for (const tail of list) {
          tail.bookmark.clear();
          tail.root.unmount();
        }
      }
      delete this._chatTailHosts[path];
    }
  }

  private async _removeChatMarkersForHash(
    path: string,
    hash: string,
  ): Promise<boolean> {
    const actions: any =
      path === this.path
        ? this
        : this.redux.getEditorActions(this.project_id, path);
    const syncstring = actions?._syncstring;
    if (actions != null && syncstring != null) {
      let text: string;
      const isConnected = (candidate: CodeMirror.Editor | undefined) => {
        const wrapper = candidate?.getWrapperElement?.();
        return candidate != null && (wrapper == null || wrapper.isConnected);
      };
      const recentCm: CodeMirror.Editor | undefined = actions._get_cm?.(
        undefined,
        true,
      );
      const liveCm = isConnected(recentCm)
        ? recentCm
        : Object.values(
            (actions._cm ?? {}) as Record<string, CodeMirror.Editor>,
          ).find(isConnected);
      try {
        // CodeMirror can be ahead of the syncstring for a short interval after
        // a local edit. Transform the visible buffer so resolving a marker
        // cannot replace and discard those pending keystrokes.
        text = liveCm?.getValue() ?? syncstring.to_str() ?? "";
      } catch {
        return false;
      }
      const newText = removeMarkersForHash(text, hash);
      if (newText === text) return true;
      // CodeMirror read-only ranges intentionally reject overlapping edits.
      // Remove our transient UI markers before applying the source transform;
      // the scanner recreates any remaining markers immediately afterward.
      this._clearChatTextDecorations(path);
      liveCm?.setValueNoJump(newText);
      actions.set_value(newText);
      actions.syncstring_commit();
      this._chatMarkerScanners[path]?.rescan();
      try {
        const verifiedSyncText = syncstring.to_str() ?? "";
        const verifiedLiveText = liveCm?.getValue() ?? verifiedSyncText;
        return (
          removeMarkersForHash(verifiedSyncText, hash) === verifiedSyncText &&
          removeMarkersForHash(verifiedLiveText, hash) === verifiedLiveText
        );
      } catch {
        return false;
      }
    }

    // Disk-scanned subfiles do not have editor actions or a syncstring. Update
    // them through the project filesystem and verify the marker is gone before
    // allowing the associated thread to become resolved/archived.
    try {
      const fs = this._get_project_actions()?.fs?.();
      if (
        typeof fs?.readFile !== "function" ||
        typeof fs?.writeFileDelta !== "function"
      ) {
        return false;
      }
      const raw = await fs.readFile(path, "utf8");
      const text =
        typeof raw === "string"
          ? raw
          : ((raw as any)?.toString?.("utf8") ?? `${raw ?? ""}`);
      const newText = removeMarkersForHash(text, hash);
      if (newText !== text) {
        await fs.writeFileDelta(path, newText, {
          baseContents: text,
          minLength: 0,
        });
      }
      const verifiedRaw = await fs.readFile(path, "utf8");
      const verifiedText =
        typeof verifiedRaw === "string"
          ? verifiedRaw
          : ((verifiedRaw as any)?.toString?.("utf8") ??
            `${verifiedRaw ?? ""}`);
      if (removeMarkersForHash(verifiedText, hash) !== verifiedText) {
        return false;
      }

      const chatMarkers = this.store.get("chat_markers") ?? (fromJS({}) as any);
      const chatBookmarks =
        this.store.get("chat_bookmarks") ?? (fromJS({}) as any);
      (this._diskChatContentHashes ??= new Map()).set(
        path,
        hash_string(verifiedText),
      );
      (this._diskScannedPaths ??= new Set()).add(path);
      (this._diskSubfileHeadings ??= new Map()).set(
        path,
        parseTableOfContents(verifiedText),
      );
      this.setState({
        chat_markers: chatMarkers.set(path, fromJS(scanMarkers(verifiedText))),
        chat_bookmarks: chatBookmarks.set(
          path,
          fromJS(scanBookmarks(verifiedText)),
        ),
      });
      this.updateTableOfContents();
      return true;
    } catch {
      return false;
    }
  }

  languageModelExtraFileInfo() {
    return "LaTeX";
  }

  codexCodeDescription(): string {
    return "Put any LaTeX you generate in the answer in a fenced code block with info string 'tex'.";
  }

  set_font_size(id: string, font_size: number): void {
    if (this._is_output_panel(id)) {
      // This is for the output panel UI, not a regular frame.
      // We store its font size in the local_view_state.
      const local_view_state = this.store.get("local_view_state");
      this.setState({
        local_view_state: local_view_state.setIn([id, "font_size"], font_size),
      });
      // Save the state change
      this.save_local_view_state();
    } else {
      super.set_font_size(id, font_size);
      this.update_gutters_soon();
    }
  }

  increase_font_size(id: string): void {
    if (this._is_output_panel(id)) {
      const font_size = this.store.getIn(
        ["local_view_state", id, "font_size"],
        14,
      );
      this.set_font_size(id, font_size + 1);
    } else {
      super.increase_font_size(id);
    }
  }

  decrease_font_size(id: string): void {
    if (this._is_output_panel(id)) {
      const font_size = this.store.getIn(
        ["local_view_state", id, "font_size"],
        14,
      );
      this.set_font_size(id, Math.max(2, font_size - 1));
    } else {
      super.decrease_font_size(id);
    }
  }
}
