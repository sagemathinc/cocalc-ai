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

import { delay } from "awaiting";

import * as CodeMirror from "codemirror";
import { fromJS, List, Map as IMap } from "immutable";
import { debounce } from "lodash";
import { normalize as path_normalize } from "path";

import {
  buildLatexCommand,
  getLatexEngine,
  sanitizeLatexCommandArray,
  sanitizeLatexCommandString,
  type DocumentBuildSnapshot,
  type LatexEngine,
} from "@cocalc/app-document-build";
import { Store, TypedMap } from "@cocalc/frontend/app-framework";
import type {
  DocumentBuildApi,
  DocumentBuildWatcher,
} from "@cocalc/frontend/client/document-build-watcher";
import { formatDocumentBuildError } from "@cocalc/frontend/client/document-build-watcher";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";
import {
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
import { project_api } from "@cocalc/frontend/frame-editors/generic/client";
import {
  change_filename_extension,
  hash_string,
  is_bad_latex_filename,
  path_split,
  separate_file_extension,
  sha1,
  splitlines,
  startswith,
} from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import * as tree_ops from "../frame-tree/tree-ops";
import type {
  BookmarkMarker,
  ChatMarker,
  InvalidChatMarker,
} from "./chat-markers";

// Side-effect import: registers the Insert-menu chat marker/bookmark commands.
import "./chat-marker-command";
import { ChatMarkerManager } from "./chat-marker-manager";

import {
  afterNextPaint,
  UxLatencyTrace,
} from "@cocalc/frontend/monitoring/ux-latency-trace";
import { clean } from "./clean";
import { KNITR_EXTS } from "./constants";
import { count_words } from "./count_words";
import { update_gutters } from "./gutters";
import { IProcessedLatexLog } from "./latex-log-parser";
import { PDFWatcher } from "./pdf-watcher";
import * as synctex from "./synctex";
import {
  interleaveSubfileTocEntries,
  parseTableOfContents,
  type SubfileTocGroup,
} from "./table-of-contents";
import {
  BuildLog,
  BuildLogs,
  ScrollIntoViewMap,
  ScrollIntoViewRecord,
} from "./types";
import { pdf_path } from "./util";
import {
  isDocumentBuildTerminal,
  snapshotBuildLogs,
  snapshotParsedLog,
} from "./document-build";

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
  // Chat anchor markers / bookmarks found in the master + open sub-files,
  // keyed by file path.
  chat_markers?: IMap<string, List<TypedMap<ChatMarker>>>;
  invalid_chat_markers?: IMap<string, List<TypedMap<InvalidChatMarker>>>;
  chat_bookmarks?: IMap<string, List<TypedMap<BookmarkMarker>>>;
}

export class Actions extends BaseActions<LatexEditorState> {
  public project_id: string;
  public store: Store<LatexEditorState>;
  private _last_syncstring_hash: number | undefined;
  private persisted_source_check_pending = false;
  private persisted_source_check_running = false;
  private is_building: boolean = false;
  public word_count: (
    time: number,
    force: boolean,
    skipFramePopup?: boolean,
  ) => Promise<void>;
  private ext: string = "tex";
  private knitr: boolean = false; // true, if we deal with a knitr file
  private filename_knitr: string; // .rnw or .rtex
  private bad_filename: boolean; // true, if the <filename.tex> can't be processed -- see #3230
  // optional engine configuration string -- https://github.com/sagemathinc/cocalc/issues/2839
  private engine_config: LatexEngine | undefined = undefined;

  // The output_directory that will be used if we are building
  // and using an output directory.  NOTE: this is a /tmp
  // directory, which we do not explicitly clean up.  However,
  // it gets cleaned up when the project stops (on managed project hosts it
  // is a ramdisk), or by whatever tmp cleaner should probably
  // be installed (say for docker...).  At least the size
  // should be relatively small.
  public output_directory: string | undefined;

  private relative_paths: { [path: string]: string } = {};
  // public: the chat-marker manager resolves sub-file paths through this.
  public canonical_paths: { [path: string]: string } = {};
  private parsed_output_log?: IProcessedLatexLog;

  // Chat markers and bookmarks live in their own delegate; see
  // chat-marker-manager.ts.  Public because the shared chat UI and the
  // editor's tests reach into it.
  public readonly chat: ChatMarkerManager = new ChatMarkerManager(this);

  private _last_sync_time = 0;

  // PDF file watcher - watches directory for PDF file changes
  private pdf_watcher?: PDFWatcher;
  private document_build_watcher?: DocumentBuildWatcher;
  private active_build_id?: string;
  private build_snapshot_seq = new Map<string, number>();
  private refreshed_build_ids = new Set<string>();
  private terminal_build_snapshots = new Map<string, DocumentBuildSnapshot>();
  private build_waiters = new Map<
    string,
    {
      resolve: (snapshot: DocumentBuildSnapshot) => void;
      reject: (error: Error) => void;
    }
  >();
  private build_command_save: Promise<void> = Promise.resolve();
  private build_command_save_error?: unknown;

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

  // public: the chat-marker manager skips decorating read-only previews.
  public is_read_only_preview(): boolean {
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
    this.init_build_on_save();
    // This breaks browser spellcheck.
    // this._init_spellcheck();
    this.init_config();
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
    this._init_pdf_directory_watcher();
    this._init_document_build_watcher();
    this.word_count = reuseInFlight(this._word_count.bind(this));
    this.chat.init();
  }

  // Watch the directory containing the PDF file for changes
  private async _init_pdf_directory_watcher(): Promise<void> {
    if (this.is_read_only_preview()) return;
    const pdfPath = pdf_path(this.path);
    this.pdf_watcher = new PDFWatcher(
      this.project_id,
      pdfPath,
      // We ignore the PDFs timestamp (mtime) and use last_save_time for consistency with build-triggered updates
      (_mtime: number, force: boolean) => {
        this.update_pdf(this.last_save_time(), force);
      },
    );
    await this.pdf_watcher.init();
  }

  private _init_document_build_watcher(): void {
    const watcher = webapp_client.project_client.watchDocumentBuild({
      path: this.document_build_path(),
      project_id: this.project_id,
    });
    watcher.on("snapshot", (snapshot: DocumentBuildSnapshot) => {
      this.apply_document_build_snapshot(snapshot);
    });
    watcher.on(
      "active-change",
      (snapshot: DocumentBuildSnapshot | undefined) => {
        this.active_build_id = snapshot?.build_id;
        this.is_building = snapshot != null;
        if (snapshot == null) this.set_status("");
      },
    );
    watcher.on("watch-error", (err: unknown) => {
      if (this._state !== "closed") {
        this.set_error(formatDocumentBuildError(err));
      }
    });
    this.document_build_watcher = watcher;
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
    // note: if there are additional reasons why a filename is bad, add it to the
    // alert msg in run_build.
    this.bad_filename = is_bad_latex_filename(this.path);
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

  private init_build_on_save(): void {
    if (this.is_read_only_preview()) return;
    const handlePersistedSourceChange = () => this.queuePersistedSourceChange();
    this._syncstring.on("save-to-disk", handlePersistedSourceChange);
    this._syncstring.on("filesystem-change", handlePersistedSourceChange);
  }

  private queuePersistedSourceChange(): void {
    void this.handlePersistedSourceChange().catch((err) => {
      if (this._state !== "closed") this.set_error(`${err}`);
    });
  }

  private async handlePersistedSourceChange(): Promise<void> {
    this.persisted_source_check_pending = true;
    if (this.persisted_source_check_running) return;
    this.persisted_source_check_running = true;
    try {
      while (this.persisted_source_check_pending) {
        this.persisted_source_check_pending = false;
        await this.maybeBuildAfterPersistedSourceChange();
      }
    } finally {
      this.persisted_source_check_running = false;
      if (this.persisted_source_check_pending) {
        this.queuePersistedSourceChange();
      }
    }
  }

  private async maybeBuildAfterPersistedSourceChange(): Promise<void> {
    if (this.is_read_only_preview()) return;
    if (this.not_ready()) return;
    const account: any = this.redux.getStore("account");
    if (!account?.getIn(["editor_settings", "build_on_save"])) {
      return;
    }
    const value = this._syncstring.to_str();
    if (value == null) return;
    const hash = hash_string(value);
    if (this._last_syncstring_hash === hash) {
      return;
    }
    this._last_syncstring_hash = hash;
    const generation = `save:${this.document_build_path()}:${hash}`;
    // there are two cases: the parent "master" file triggers the build (usual case)
    // or an included dependency – i.e. where parent_file is set
    if (this.parent_file != null && this.parent_file != this.path) {
      const parent_actions = this.redux.getEditorActions(
        this.project_id,
        this.parent_file,
      ) as Actions;
      // we're careful, maybe getEditorActions returns something else ...
      await parent_actions?.build?.("", false, generation);
    } else if (this.parent_file == null && this.is_likely_master()) {
      // also check is_likely_master, b/c there must be a \\document* command.
      await this.build("", false, generation);
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
      // getLatexEngine picks an engine we know of via lower-case match.
      this.engine_config = getLatexEngine(program);
      if (this.engine_config != null) {
        // Now set the build command to what is configured.
        this.set_build_command(
          buildLatexCommand(
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

    // Wait for the syncdb to be loaded and ready.
    if (this._syncdb == null) {
      throw Error("syncdb must be defined");
    }
    if (!(await this.wait_until_syncdoc_ready(this._syncdb))) return;

    // If the build command is NOT already
    // set in syncdb, we wait for file to load,
    // looks for "% !TeX program =", and if so
    // sets up the build command based on that:
    if (this._syncdb == null) {
      throw Error("syncdb must be defined");
    }
    if (this._syncdb.get_one({ key: "build_command" }) == null) {
      await this.init_build_directive();
      if (this._state == "closed") return;
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
    this._syncdb.on("change", set_cmd);

    if (this.is_likely_master() && !this.is_read_only_preview()) {
      // We now definitely have the build command set and the document loaded,
      // and it is likely a master latex file, so let's kick off our initial build.
      this.force_build();
    }
  }

  private set_default_build_command(): string[] {
    const default_cmd = buildLatexCommand(
      this.engine_config || "PDFLaTeX",
      path_split(this.path).tail,
      this.knitr,
      this.output_directory,
    );
    this.setState({ build_command: fromJS(default_cmd) });
    return default_cmd;
  }

  public sanitize_build_cmd_str(cmd: string): string {
    return sanitizeLatexCommandString(
      cmd,
      path_split(this.path).tail,
      this.output_directory,
    );
  }

  private sanitize_build_cmd(cmd: List<string>): List<string> {
    return List(
      sanitizeLatexCommandArray(
        cmd.toJS(),
        path_split(this.path).tail,
        this.output_directory,
      ),
    );
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
      this.set_error(err);
    }
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
    this._forget_pdf_document();
    if (this.pdf_watcher != null) {
      this.pdf_watcher.close();
      this.pdf_watcher = undefined;
    }
    this.document_build_watcher?.close();
    this.document_build_watcher = undefined;
    for (const { reject } of this.build_waiters.values()) {
      reject(new Error("LaTeX editor closed while waiting for document build"));
    }
    this.build_waiters.clear();
    this.chat.close();
    super.close();
  }

  // supports the "Force Rebuild" button.
  async force_build(id?: string): Promise<void> {
    if (this.is_read_only_preview()) return;
    await this.build(id, true);
  }

  // public: the chat-marker manager scans every open sub-file editor.
  public all_actions(): BaseActions<CodeEditorState>[] {
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
    await this.build();
  }

  // used by generic framework – this is bound to the instance, otherwise "this" is undefined, hence
  // make sure to use an arrow function!
  build = async (
    id?: string,
    force: boolean = false,
    generation?: string,
  ): Promise<void> => await this.build_document(id, force, generation);

  private async build_document(
    id?: string,
    force: boolean = false,
    generation?: string,
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
    if (this.bad_filename) {
      this.set_error(
        `ERROR: It is not possible to compile this LaTeX file with the name '${this.path}'.\n` +
          "Please modify the filename so it does not contain two or more consecutive spaces or a single quote (').",
      );
      return;
    }
    // initiating a build. if one is running & forced, we stop the build
    if (this.is_building && generation == null) {
      if (force) {
        await this.stop_build();
      } else {
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
    this.is_building = true;
    let wordCount: Promise<void> | undefined;
    try {
      await this.save_all(false);
      await this.wait_for_build_command_save();
      buildTrace.mark("sources_saved");
      this.setState({ build_logs: IMap() });
      if (this._has_frame_of_type("word_count")) {
        wordCount = this.word_count(this.last_save_time(), force);
      }
      const snapshot = await this.document_build_api().start({
        path: this.document_build_path(),
        ...(generation == null ? undefined : { generation }),
        expected_source_hash: hash_string(this.store.get("value") ?? ""),
        force,
        output_directory: this.get_output_directory() ?? null,
      });
      if (this.document_build_watcher != null) {
        this.document_build_watcher.track(snapshot);
      } else {
        this.apply_document_build_snapshot(snapshot);
      }
      const completeBuild = async () => {
        await this.wait_for_document_build(snapshot.build_id);
        await wordCount;
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
      };
      if (generation != null) {
        void completeBuild().catch((err) => {
          buildTrace.record("latex_build_failed_v2", {
            path_ext: "tex",
            editor: "latex",
            segment: "build_on_save",
            surface_visible: true,
            details: {
              error_name: err instanceof Error ? err.name : "unknown",
            },
          });
        });
        return;
      }
      await completeBuild();
    } catch (err) {
      buildTrace.record("latex_build_failed_v2", {
        path_ext: "tex",
        editor: "latex",
        segment: force ? "forced" : "normal",
        surface_visible: true,
        details: {
          error_name: err instanceof Error ? err.name : "unknown",
        },
      });
      this.set_error(formatDocumentBuildError(err));
      // if there is an error, we issue a stop, but keep the build logs
      await this.stop_build();
    } finally {
      if (this.active_build_id == null) this.is_building = false;
    }
  }

  private document_build_path(): string {
    return this.knitr ? this.filename_knitr : this.path;
  }

  private document_build_api(): DocumentBuildApi {
    return webapp_client.project_client.conatApi(this.project_id).documentBuild;
  }

  private async wait_for_document_build(
    build_id: string,
  ): Promise<DocumentBuildSnapshot> {
    const terminal = this.terminal_build_snapshots.get(build_id);
    if (terminal != null) return terminal;
    return await new Promise<DocumentBuildSnapshot>((resolve, reject) => {
      this.build_waiters.set(build_id, { resolve, reject });
    });
  }

  private apply_document_build_snapshot(snapshot: DocumentBuildSnapshot): void {
    const previousSeq = this.build_snapshot_seq.get(snapshot.build_id) ?? -1;
    if (snapshot.seq <= previousSeq) return;
    this.build_snapshot_seq.set(snapshot.build_id, snapshot.seq);

    const selectedActive =
      this.document_build_watcher?.latestActiveBuildSnapshot();
    const shouldProject =
      selectedActive == null || selectedActive.build_id === snapshot.build_id;

    if (shouldProject) {
      this.setState({
        build_logs: fromJS(snapshotBuildLogs(snapshot)) as unknown as BuildLogs,
      });
      this.parsed_output_log = snapshotParsedLog(snapshot);
      this.setState({
        knitr_error: snapshot.diagnostics.some(
          ({ level, source }) => level === "error" && source === "knitr",
        ),
      });
      if (!this.knitr && snapshot.dependencies.length > 0) {
        void this.set_switch_to_files(snapshot.dependencies);
      }
      this.update_gutters();
      void this.update_gutters_soon();
      this.check_for_fatal_error();
    }

    if (!isDocumentBuildTerminal(snapshot)) {
      const active = selectedActive ?? snapshot;
      this.active_build_id = active.build_id;
      this.is_building = true;
      const running = active.stages
        .slice()
        .reverse()
        .find(({ state }) => state === "running");
      this.set_status(
        running == null
          ? "Document build queued..."
          : `Running ${running.name}...`,
      );
      return;
    }

    this.terminal_build_snapshots.set(snapshot.build_id, snapshot);
    const waiter = this.build_waiters.get(snapshot.build_id);
    if (waiter != null) {
      this.build_waiters.delete(snapshot.build_id);
      waiter.resolve(snapshot);
    }

    const remainingActive =
      this.document_build_watcher?.latestActiveBuildSnapshot();
    this.active_build_id = remainingActive?.build_id;
    this.is_building = remainingActive != null;
    if (remainingActive == null) {
      this.set_status("");
    } else {
      const running = remainingActive.stages
        .slice()
        .reverse()
        .find(({ state }) => state === "running");
      this.set_status(
        running == null
          ? "Document build queued..."
          : `Running ${running.name}...`,
      );
    }
    if (
      remainingActive == null &&
      (snapshot.state === "failed" || snapshot.state === "timed_out")
    ) {
      const message =
        snapshot.error ??
        snapshot.diagnostics.find(({ level }) => level === "error")?.message;
      if (message) this.set_error(message);
    }
    if (
      !this.refreshed_build_ids.has(snapshot.build_id) &&
      snapshot.artifacts.some(({ type }) => type === "pdf")
    ) {
      this.refreshed_build_ids.add(snapshot.build_id);
      this.update_pdf(snapshot.ended_at ?? Date.now(), true);
    }
  }

  async clean(): Promise<void> {
    if (this.is_read_only_preview()) return;
    await this.build_action("clean");
  }

  // Cancel the authoritative project-side build. The service kills whichever
  // stage is active and publishes the terminal snapshot to every client.
  async stop_build(_id?: string) {
    try {
      if (this.active_build_id != null) {
        const snapshot = await this.document_build_api().cancel(
          this.active_build_id,
        );
        this.apply_document_build_snapshot(snapshot);
      }
    } finally {
      this.active_build_id = this.document_build_watcher?.latestActiveBuildId();
      this.is_building = this.active_build_id != null;
      this.set_status(this.is_building ? "Document build running..." : "");
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
    this.chat.scheduleDiskScans(true);
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

  private async build_action(action: string): Promise<void> {
    if (this.is_read_only_preview()) return;
    switch (action) {
      case "clean":
        await this.run_clean();
        return;
      default:
        this.set_error(`unknown build action '${action}'`);
    }
  }

  // time 0 implies to take the last_save_time,
  make_timestamp(time: number, force: boolean): number {
    return force ? Date.now() : time || this.last_save_time();
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

  set_build_command(command: string | string[]): Promise<void> {
    if (this.is_read_only_preview()) {
      this.setState({ build_command: fromJS(command) });
      return Promise.resolve();
    }
    if (this._syncdb == null) throw Error("syncdb must be defined");
    // I deleted the insane time:now in this syncdb set, since that
    // would seem to generate an insane amount of traffic (and I'm
    // surprised it wouldn't generate a feedback loop)!
    this._syncdb.set({ key: "build_command", value: command });
    this._syncdb.commit();
    this.build_command_save_error = undefined;
    this.build_command_save = (this.build_command_save ?? Promise.resolve())
      .then(() => this.save_build_command_config_to_disk())
      .catch((err) => {
        this.build_command_save_error = err;
        if (this._state !== "closed") {
          this.set_error(
            `Error saving LaTeX build command for '${this.path}' -- ${err}`,
          );
        }
      });
    this.setState({ build_command: fromJS(command) });
    return this.build_command_save;
  }

  private async wait_for_build_command_save(): Promise<void> {
    await this.build_command_save;
    if (this.build_command_save_error != null) {
      throw this.build_command_save_error;
    }
  }

  private async save_build_command_config_to_disk(): Promise<void> {
    const syncdb = this._syncdb;
    if (syncdb == null) return;
    await saveToDiskWithFileServerRetry({
      save: () => syncdb.save_to_disk(),
      shouldRetry: () => this._state !== "closed" && !this.isClosed(),
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
    const anchoredPaths = this.chat.getAnchoredSubfilePaths();
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
      subHeadings ??= this.chat.diskSubfileHeadings?.get(path);
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

  public async scrollToHeading(entry: TableOfContentsEntry): Promise<void> {
    const extra = (entry as any)?.extra;
    // Chat markers jump via the anchor adapter (handles sub-files and
    // markers that moved since the TOC was computed).
    if (extra?.kind === "chat" && typeof extra.hash === "string") {
      await this.chat.jumpToAnchor(extra.hash);
      return;
    }
    // Entries from included files (file header, headings, bookmarks)
    // carry their own path + line.
    if (extra?.kind === "line" && typeof extra.path === "string") {
      const frameId = await this.chat.switchFocusedSourceTo(extra.path);
      if (frameId == null) return;
      await this.chat.gotoSourceLine(
        extra.path,
        (extra.line ?? 0) + 1,
        frameId,
      );
      return;
    }
    // Plain entries come from the master document.  The last-focused
    // source pane may currently show an included file, so retarget that
    // pane before applying the master line number.
    const frameId = await this.chat.switchFocusedSourceTo(this.path);
    if (frameId == null) return;
    await this.chat.gotoSourceLine(this.path, parseInt(entry.id), frameId);
  }

  public set_parent_file(path: string): void {
    super.set_parent_file(path);
    if (path !== this.path) {
      // The parent editor scans and decorates all included files using the
      // master's side chat. Stop this file's standalone scanner first so two
      // owners cannot alternate between `.master.sage-chat` and an empty
      // `.subfile.sage-chat` as their async rescans finish.
      this.chat.yieldToParent();
    }
  }

  // The chat-marker manager owns the parent-file logic but cannot read the
  // base class's protected field.
  public getParentFile(): string | undefined {
    return this.parent_file;
  }

  // ===== Anchor API =========================================================
  //
  // The shared chat UI duck-types these on the editor actions (see
  // AnchorEditorActions in @cocalc/frontend/chat/anchors), and
  // chat-marker-command.tsx does the same for the two insert commands, so
  // they stay on Actions and forward into the manager.

  public getAnchorState = (
    hash: string,
    recordedPath?: string,
  ): "available" | "missing" | "unloaded" =>
    this.chat.getAnchorState(hash, recordedPath);

  public getAnchorLabel = (hash: string): string | undefined =>
    this.chat.getAnchorLabel(hash);

  public getAnchorJumpLabel = (
    hash: string,
    recordedPath?: string,
  ): string | undefined => this.chat.getAnchorJumpLabel(hash, recordedPath);

  public canJumpToAnchor = (hash: string, recordedPath?: string): boolean =>
    this.chat.canJumpToAnchor(hash, recordedPath);

  public getMissingAnchorMessage = (hash: string): string =>
    this.chat.getMissingAnchorMessage(hash);

  public jumpToAnchor = async (
    hash: string,
    recordedPath?: string,
  ): Promise<void> => await this.chat.jumpToAnchor(hash, recordedPath);

  public async resolveChatMarker(
    hash: string,
    expectsThread = true,
  ): Promise<void> {
    await this.chat.resolveChatMarker(hash, expectsThread);
  }

  public insertChatMarker = async (opts?: {
    mode?: "inline" | "block";
    path?: string;
    cm?: CodeMirror.Editor;
  }): Promise<void> => {
    await this.chat.insertChatMarker(opts);
  };

  public insertBookmark = async (opts?: {
    path?: string;
    cm?: CodeMirror.Editor;
  }): Promise<void> => {
    await this.chat.insertBookmark(opts);
  };

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
