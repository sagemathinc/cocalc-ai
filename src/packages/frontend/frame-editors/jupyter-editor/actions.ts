import type { GotoUserActions } from "@cocalc/frontend/frame-editors/base-editor/actions-base";
/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Jupyter Frame Editor Actions
*/

import { delay } from "awaiting";
import { alert_message } from "@cocalc/frontend/alerts";
import {
  hasNbgraderMetadata,
  NBGRADER_CLASSIC_REASON,
} from "./nbgrader-layout";
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";
import { isJupyterNotebookFrameType } from "./util";
import { markdown_to_slate } from "@cocalc/frontend/editors/slate/markdown-to-slate";
import { JupyterActions } from "@cocalc/frontend/jupyter/browser-actions";
import { toFragmentId } from "@cocalc/frontend/jupyter/heading-tag";
import type { FragmentId } from "@cocalc/frontend/misc/fragment-id";
import {
  BaseEditorActions as BaseActions,
  CodeEditorState,
} from "../base-editor/actions-base";
import { FrameTree } from "../frame-tree/types";
import { NotebookFrameActions } from "./cell-notebook/actions";
import {
  close_jupyter_actions,
  create_jupyter_actions,
} from "./jupyter-actions";
import { revealjs_slideshow_html } from "./slideshow-revealjs/nbconvert";

export interface JupyterEditorState extends CodeEditorState {
  has_nbgrader?: boolean;
  slideshow?: {
    state?: "built" | "building" | "";
    url?: string;
  };
}

// Frame types that no longer exist in EDITOR_SPEC, mapped to their
// replacement. A saved frame tree still holding one of these throws while
// rendering, and the generic recovery then resets the *whole* tree to the
// default -- so the user loses their splits, terminals, and table-of-contents
// panes, not just the stale frame. Migrating on load avoids that.
const REMOVED_FRAME_TYPES: { readonly [type: string]: string } = {
  "jupyter-singledoc": "jupyter_cell_notebook",
  jupyter_slate_single_doc_notebook: "jupyter_cell_notebook",
  // "Jupyter Minimal" was renamed to "Jupyter Studio" in August 2026.
  jupyter_minimal: "jupyter_studio",
} as const;

export class JupyterEditorActions
  extends BaseActions<JupyterEditorState>
  implements GotoUserActions
{
  protected doctype: string = "none"; // actual document is managed elsewhere
  public jupyter_actions: JupyterActions;
  private frame_actions: { [id: string]: NotebookFrameActions } = {};
  private syncConsoleTimer?: ReturnType<typeof setTimeout>;
  private syncConsoleInFlight = false;

  _raw_default_frame_tree(): FrameTree {
    return { type: "jupyter_cell_notebook" };
  }

  protected _init_syncstring(): void {
    this.create_jupyter_actions();
    this._syncstring = this.jupyter_actions.syncdb;
    super._init_syncstring();
  }

  _init2(): void {
    this.normalizeRemovedFrameTypes();
    this.init_new_frame();
    this.init_changes_state();

    this.store.on("close-frame", async ({ id, type: oldType, closingFile }) => {
      // Capture the specific instance so that a rapid frame-type toggle
      // (which emits close-frame twice in quick succession) can't end up
      // closing a freshly-created replacement instance after the delay.
      const actions = this.frame_actions[id];
      if (actions == null) return;
      const closeFrameActions = () => {
        actions.close();
        if (this.frame_actions[id] === actions) {
          delete this.frame_actions[id];
        }
      };
      if (closingFile) {
        closeFrameActions();
        return;
      }
      await delay(1);
      // Toggling between jupyter_cell_notebook and jupyter_studio uses
      // the same CellNotebook component and the same NotebookFrameActions
      // works for both types.  Closing and recreating on toggle just wipes
      // this.jupyter_actions/this.store on the instance that still-mounted
      // cell components hold via useNotebookFrameActions refs, so the next
      // cell click crashes with "Cannot read properties of undefined
      // (reading 'store')".  Keep the existing instance in that case.
      const newType = this._get_frame_type(id);
      if (
        isJupyterNotebookFrameType(oldType) &&
        isJupyterNotebookFrameType(newType)
      ) {
        return;
      }
      closeFrameActions();
    });
  }

  private normalizeRemovedFrameTypes(): void {
    for (const id in this._get_leaf_ids()) {
      const node = this._get_frame_node(id);
      const type = `${node?.get("type") ?? ""}`;
      const replacement = REMOVED_FRAME_TYPES[type];
      if (replacement == null) continue;
      if (type === "jupyter_minimal") {
        // Carry the view's own persisted settings across the rename, so a
        // saved frame keeps its width and reading state.
        const layout = node?.get("data-minimalLayout");
        const readingMode = node?.get("data-zenMode");
        if (layout != null || readingMode != null) {
          this.set_frame_data({
            id,
            ...(layout != null ? { studioLayout: layout } : {}),
            ...(readingMode != null ? { readingMode } : {}),
          });
        }
      }
      this.set_frame_type(id, replacement);
    }
  }

  public close(): void {
    if (this.syncConsoleTimer != null) {
      clearTimeout(this.syncConsoleTimer);
      this.syncConsoleTimer = undefined;
    }
    super.close();
    this.close_jupyter_actions();
  }

  private init_new_frame(): void {
    this.store.on("new-frame", ({ id, type }) => {
      if (!isJupyterNotebookFrameType(type)) {
        return;
      }
      // important to do this *before* the frame is rendered,
      // since it can cause changes during creation.
      this.get_frame_actions(id);
    });

    for (const id in this._get_leaf_ids()) {
      const node = this._get_frame_node(id);
      if (node == null) return;
      const type = node.get("type");
      if (isJupyterNotebookFrameType(type)) {
        this.get_frame_actions(id);
      }
    }
  }

  private init_changes_state(): void {
    const syncdb = this.jupyter_actions.syncdb;
    syncdb.on("has-uncommitted-changes", (has_uncommitted_changes) =>
      this.setState({ has_uncommitted_changes }),
    );
    this.jupyter_actions.store.on(
      "has-unsaved-changes",
      (has_unsaved_changes) => {
        this.setState({ has_unsaved_changes });
      },
    );

    this.watchFrameEditorStore();
    this.watchJupyterStore();
  }

  private watchFrameEditorStore = (): void => {
    const store = this.store;
    let introspect = store.get("introspect");
    store.on("change", () => {
      const i = store.get("introspect");
      if (i != introspect) {
        if (i != null) {
          this.show_introspect();
        } else {
          this.close_introspect();
        }
        introspect = i;
      }
    });
  };

  private watchJupyterStore = (): void => {
    const store = this.jupyter_actions.store;
    let cells = store.get("cells");
    this.enforceNbgraderLayout();
    store.on("change", () => {
      if (cells !== store.get("cells")) {
        cells = store.get("cells");
        this.enforceNbgraderLayout();
      }
      // sync read only state -- source of true is jupyter_actions.store.get('read_only')
      const read_only = store.get("read_only");
      if (read_only != this.store.get("read_only")) {
        this.setState({ read_only });
      }
    });
    let backend_state = store.get("backend_state");
    let kernel_state = store.get("kernel_state");
    store.on("change", () => {
      const backend = store.get("backend_state");
      const kernel = store.get("kernel_state");
      const backendChanged = backend !== backend_state;
      const kernelChanged = kernel !== kernel_state;
      if (
        (backendChanged && backend === "running") ||
        (backend === "running" &&
          kernelChanged &&
          (kernel === "idle" || kernel === "busy"))
      ) {
        this.scheduleSyncJupyterConsoleTerminals();
      }
      backend_state = backend;
      kernel_state = kernel;
    });
  };

  public studioUnavailableReason(): string | undefined {
    const cells = this.jupyter_actions?.store?.get("cells");
    if (cells == null) return "Notebook metadata is still loading.";
    return hasNbgraderMetadata(cells) ? NBGRADER_CLASSIC_REASON : undefined;
  }

  set_frame_type(id: string, type: string): void {
    if (type === "jupyter_studio" && this.studioUnavailableReason()) {
      type = "jupyter_cell_notebook";
    }
    super.set_frame_type(id, type);
  }

  public new_frame(...args: Parameters<BaseActions["new_frame"]>): string {
    if (args[0] === "jupyter_studio" && this.studioUnavailableReason()) {
      args[0] = "jupyter_cell_notebook";
    }
    return super.new_frame(...args);
  }

  private enforceNbgraderLayout(): void {
    const has_nbgrader = hasNbgraderMetadata(
      this.jupyter_actions.store.get("cells"),
    );
    if (this.store.get("has_nbgrader") !== has_nbgrader)
      this.setState({ has_nbgrader });
    if (!has_nbgrader) return;
    let changed = false;
    for (const id in this._get_leaf_ids()) {
      if (this._get_frame_type(id) !== "jupyter_studio") continue;
      this.set_frame_type(id, "jupyter_cell_notebook");
      changed = true;
    }
    if (changed)
      alert_message({
        type: "info",
        message:
          "Switched to Classic to display assignment grading information.",
      });
  }

  private normalizeTerminalArgs = (args: any): string[] => {
    if (args == null) {
      return [];
    }
    const raw =
      typeof args?.toJS === "function"
        ? args.toJS()
        : Array.isArray(args)
          ? args
          : [];
    return raw.map((x) => `${x}`);
  };

  private isJupyterConsoleTerminalNode = (node: any): boolean => {
    if (node == null) {
      return false;
    }
    const type = node.get("type");
    if (typeof type !== "string" || type.slice(0, 8) !== "terminal") {
      return false;
    }
    const command = node.get("command");
    if (command !== "jupyter") {
      return false;
    }
    const args = this.normalizeTerminalArgs(node.get("args"));
    return args[0] === "console" && args[1] === "--existing";
  };

  private getJupyterConsoleTerminalIds = (): string[] => {
    const ids: string[] = [];
    for (const id in this._get_leaf_ids()) {
      if (this.isJupyterConsoleTerminalNode(this._get_frame_node(id))) {
        ids.push(id);
      }
    }
    return ids;
  };

  private sameArgs = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  };

  private scheduleSyncJupyterConsoleTerminals = (): void => {
    if (this.syncConsoleTimer != null) {
      clearTimeout(this.syncConsoleTimer);
    }
    this.syncConsoleTimer = setTimeout(() => {
      this.syncConsoleTimer = undefined;
      void this.syncJupyterConsoleTerminals();
    }, 1000);
  };

  private syncJupyterConsoleTerminals = async (): Promise<void> => {
    if (this.syncConsoleInFlight || this.isClosed()) {
      return;
    }
    const ids = this.getJupyterConsoleTerminalIds();
    if (ids.length == 0) {
      return;
    }
    this.syncConsoleInFlight = true;
    try {
      const connectionFile = await this.jupyter_actions.getConnectionFile();
      const command = "jupyter";
      const args = ["console", "--existing", connectionFile];
      for (const id of ids) {
        if (this.isClosed()) {
          return;
        }
        const node = this._get_frame_node(id);
        if (node == null) {
          continue;
        }
        if (!this.isJupyterConsoleTerminalNode(node)) {
          continue;
        }
        const currentArgs = this.normalizeTerminalArgs(node.get("args"));
        const currentCommand = node.get("command");
        if (currentCommand === command && this.sameArgs(currentArgs, args)) {
          continue;
        }
        // Keep the same terminal frame but retarget it to the new kernel
        // session file, then force a restart of the backend process.
        this.terminals.set_command(id, command, args);
        this.set_frame_tree({ id, command, args });
        this.terminals.kill(id);
      }
    } catch {
      // Kernel may be between states; next lifecycle transition retries.
    } finally {
      this.syncConsoleInFlight = false;
    }
  };

  public focus(id?: string): void {
    const actions = this.get_frame_actions(id);
    if (actions != null) {
      actions.focus();
    } else {
      super.focus(id);
    }
  }

  public blur(id?: string): void {
    const actions = this.get_frame_actions(id);
    if (actions != null) {
      actions.blur?.();
    }
  }

  public refresh(id: string): void {
    const actions = this.get_frame_actions(id);
    if (actions != null) {
      actions.refresh();
    } else {
      super.refresh(id);
    }
  }

  private create_jupyter_actions(): void {
    this.jupyter_actions = create_jupyter_actions(
      this.redux,
      this.name,
      this.path,
      this.project_id,
    );
    this.jupyter_actions.jupyterEditorActions = this;
  }

  private close_jupyter_actions(): void {
    close_jupyter_actions(this.redux, this.name);
  }

  public get_frame_actions(id?: string): NotebookFrameActions | undefined {
    if (id === undefined) {
      id = this._get_active_id();
      if (id == null) throw Error("no active frame");
    }
    if (this.frame_actions[id] != null) {
      if (this.frame_actions[id].is_closed()) {
        return undefined;
      }
      return this.frame_actions[id];
    }
    const node = this._get_frame_node(id);
    if (node == null) {
      throw Error(`no frame ${id}`);
    }
    const type = node.get("type");
    if (isJupyterNotebookFrameType(type)) {
      return (this.frame_actions[id] = new NotebookFrameActions(this, id));
    } else {
      return;
    }
  }

  // per-session sync-aware undo
  undo(id: string): void {
    const actions = this.get_frame_actions(id);
    if (actions != null) {
      // this properly moves the selection, so prefer if available
      actions.undo();
    } else {
      this.jupyter_actions.undo();
    }
  }

  // per-session sync-aware redo
  redo(id: string): void {
    const actions = this.get_frame_actions(id);
    if (actions != null) {
      actions.redo();
    } else {
      this.jupyter_actions.redo();
    }
  }

  cut(id: string): void {
    const actions = this.get_frame_actions(id);
    actions != null ? actions.cut() : super.cut(id);
  }

  copy(id: string): void {
    const actions = this.get_frame_actions(id);
    actions != null ? actions.copy() : super.copy(id);
  }

  paste(id: string, value?: string | true): void {
    const actions = this.get_frame_actions(id);
    actions != null ? actions.paste(value) : super.paste(id, value);
  }

  print(_id): void {
    this.jupyter_actions.show_nbconvert_dialog("cocalc-html");
  }

  async format(id: string): Promise<void> {
    const actions = this.get_frame_actions(id);
    if (actions != null) {
      try {
        await actions.format();
      } catch (err) {
        this.setFormatError(`${err}`);
      }
    } else {
      await super.format(id);
    }
  }

  halt_jupyter(): void {
    this.jupyter_actions.confirm_close_and_halt();
  }

  async save(explicit: boolean = true): Promise<void> {
    if (this._state == "closed") return;
    explicit = explicit; // not used yet -- might be used for "strip trailing whitespace"

    // Copy state from live codemirror editor into syncdb
    // since otherwise it won't be saved to disk.
    const id = this._active_id();
    const a = this.get_frame_actions(id);
    if (a != null && a.save_input_editor != null) {
      a.save_input_editor();
    }

    if (!this.jupyter_actions.hasPendingIpynbChanges()) {
      return;
    }

    // Do the save itself, using try/finally to ensure proper
    // setting of is_saving.
    try {
      this.setState({ is_saving: true });
      await this.jupyter_actions.save();
      if (this._state == "closed") {
        return;
      }
    } catch (err) {
      console.warn("save_to_disk", this.path, "ERROR", err);
      if (this._state == "closed") {
        return;
      }
      this.set_error(`error saving file to disk -- ${err}`);
    } finally {
      this.setState({ is_saving: false });
    }
  }

  protected async get_shell_spec(
    _id: string,
  ): Promise<{ command: string; args: string[] }> {
    const connectionFile = await this.jupyter_actions.getConnectionFile();
    return {
      command: "jupyter",
      args: ["console", "--existing", connectionFile],
    };
  }

  // Not an action, but works to make code clean
  has_format_support(id: string, available_features?): false | string {
    id = id;
    const syntax = this.jupyter_actions.store.get_kernel_syntax();
    const markdown_only = "Format selected markdown cells using prettier.";
    if (syntax == null) return markdown_only;
    if (available_features == null) return markdown_only;
    const tool = this.format_support_for_syntax(available_features, syntax);
    if (!tool) return markdown_only;
    return `Format selected code cells using "${tool}", stopping on first error; formats markdown using prettier.`;
  }

  // Uses nbconvert to create an html slideshow version of this notebook.
  // - If this is foo.ipynb, the resulting slideshow is in the file
  //   .foo.slides.html, so can reference local images, etc.
  // - Returned string is a **raw url** link to the HTML slideshow file.
  public async build_revealjs_slideshow(): Promise<void> {
    const slideshow = (this.store as any).get("slideshow");
    if (slideshow != null && slideshow.get("state") == "building") {
      return;
    }
    try {
      this.setState({ slideshow: { state: "building" } });
      this.set_status("Building slideshow: saving...", 10000);
      await this.save();
      if (this._state == "closed") return;
      this.set_status("Building slideshow: running nbconvert...", 15000);
      const url = await revealjs_slideshow_html(this.project_id, this.path);
      if (this._state == "closed") return;
      this.set_status(""); // really bad design... I need to make this like for courses...
      this.setState({ slideshow: { state: "built", url } });
    } catch (err) {
      if (this._state == "closed") return;
      this.set_error(`Error building slideshow -- ${err}`);
    }
  }

  public async build(id: string): Promise<void> {
    switch (this._get_frame_type(id)) {
      case "jupyter_slideshow_revealjs":
        this.build_revealjs_slideshow();
        break;
    }
  }

  public show_revealjs_slideshow(): void {
    this.show_focused_frame_of_type("jupyter_slideshow_revealjs");
    this.build_revealjs_slideshow();
  }

  public async jump_to_cell(
    cell_id: string,
    align: "center" | "top" = "center",
  ): Promise<void> {
    // Open or focus a notebook viewer and scroll to the given cell.
    // Prefer an existing studio frame over creating a new standard one.
    if (this._state === "closed") return;
    const existingStudio =
      this._get_most_recent_active_frame_id_of_type("jupyter_studio");
    const frameType = existingStudio
      ? "jupyter_studio"
      : "jupyter_cell_notebook";
    const id = this.show_focused_frame_of_type(frameType);
    const actions = this.get_frame_actions(id);
    if (actions == null) return;
    actions.set_cur_id(cell_id);
    actions.scroll(align == "top" ? "cell top" : "cell visible");
    await delay(5);
    if (this._state === "closed") return;
    actions.focus();
  }

  public async show_table_of_contents(
    _id: string | undefined = undefined,
  ): Promise<void> {
    const id = this.show_focused_frame_of_type(
      "jupyter_table_of_contents",
      "col",
      true,
      1 / 3,
    );
    // the click to select TOC focuses the active id back on the notebook
    await delay(0);
    if (this._state === "closed") return;
    this.set_active_id(id, true);
  }

  // Either show the most recently focused introspect frame, or ceate one.
  public async show_introspect(): Promise<void> {
    this.show_recently_focused_frame_of_type("introspect", "col", false, 2 / 3);
  }

  // Close the most recently focused introspect frame, if there is one.
  public async close_introspect(): Promise<void> {
    this.close_recently_focused_frame_of_type("introspect");
  }

  // Focus a notebook frame (preferring an existing one) and scroll to the
  // given cell.  Returns the frame id used, or undefined if none is ready.
  private async focusNotebookFrame(): Promise<string | undefined> {
    // Prefer an existing notebook frame (studio or default) rather than
    // always creating a jupyter_cell_notebook which overrides the saved layout.
    const existingStudio =
      this._get_most_recent_active_frame_id_of_type("jupyter_studio");
    const frameType = existingStudio
      ? "jupyter_studio"
      : "jupyter_cell_notebook";
    const frameId = await this.waitUntilFrameReady({
      type: frameType,
      syncdoc: this.jupyter_actions.syncdb,
    });
    return frameId ? frameId : undefined;
  }

  // 1-based human label for a cell, e.g. "Cell 3"; undefined if the cell
  // no longer exists.
  public getCellLabel(cellId: string): string | undefined {
    const cellList = this.jupyter_actions.store.get("cell_list");
    if (cellList == null) return undefined;
    const index = cellList.indexOf(cellId);
    if (index === -1) return undefined;
    return `Cell ${index + 1}`;
  }

  // Anchored side-chat thread adapter (shared chat UI duck-types on
  // these; the anchor id for Jupyter is the cell's UUID).
  public jumpToAnchor = (anchorId: string): void => {
    this.jump_to_cell(anchorId, "top");
  };

  public canJumpToAnchor = (anchorId: string): boolean => {
    const cellList = this.jupyter_actions.store.get("cell_list");
    return cellList?.includes(anchorId) === true;
  };

  public getMissingAnchorMessage = (_anchorId: string): string => {
    return "This cell was deleted";
  };

  public getAnchorLabel = (anchorId: string): string | undefined => {
    return this.getCellLabel(anchorId);
  };

  async gotoFragment(fragmentId: FragmentId) {
    if (fragmentId.chat) {
      // deal with side chat in base class
      await super.gotoFragment(fragmentId);
    }
    const frameId = await this.focusNotebookFrame();
    if (!frameId) return;
    const { id, anchor } = fragmentId;

    const goto = (cellId: string) => {
      const actions = this.get_frame_actions(frameId);
      if (actions == null) return;
      actions.set_cur_id(cellId);
      actions.scroll("cell top");
    };

    if (id) {
      goto(id);
      return;
    }

    if (anchor) {
      // In html, the anchor refers to the unique element in the global document with
      // id equal to that.
      // There may be an actual element in markdown of some cell with the id equal to
      // anchor, which would have to be some HTML, since markdown doesn't have a notion
      // of id.
      // Most likely there is a markdown section heading that programatically gets
      // an id (see src/packages/frontend/jupyter/heading-tag.tsx).  Of course, our
      // notebook cells need not be in the DOM at all due to virtualization, so we
      // parrse and search the actual cell data directly.
      const cells = this.jupyter_actions.store.get("cells");
      for (const cellId of this.jupyter_actions.store.get("cell_list")) {
        const cell = cells.get(cellId);
        if (cell?.get("cell_type") == "markdown") {
          const input = cell.get("input");
          const slate = markdown_to_slate(input);
          for (const block of slate) {
            if (block["type"] == "heading") {
              if (toFragmentId(block["children"] ?? []) == anchor) {
                // found it!
                goto(cellId);
                return;
              }
            }
          }
          // We didn't find it as a heading, so now check for id's of inline or
          // block level html.  Here we're just going to do something that
          // isn't always right, but is easy and may result in false positive
          // (or negative).  Also, note that if the markdown block is really
          // large the actual tag with the given id might not be visible.
          // Another significant issue related to all this is that we sanitize
          // away any ids from the html anyways, so there aren't ids in the DOM
          // from html blocks or inline html!
          if (
            input.includes(`id=${anchor}`) ||
            input.includes(`id="${anchor}"`) ||
            input.includes(`id='${anchor}'`)
          ) {
            goto(cellId);
            return;
          }
        }
      }
      return;
    }
  }

  languageModelGetText(
    frameId: string,
    scope: "selection" | "cell" | "all" = "all",
  ): string {
    const actions = this.frame_actions[frameId];
    if (!actions) return ""; // no frames (?)
    if (scope == "selection") {
      const selected_cells = actions.store.get_selected_cell_ids_list();
      if (selected_cells != null && selected_cells.length > 1) {
        // get all content of all selected cells.
        let s = "";
        for (const id of selected_cells) {
          if (this.jupyter_actions.store.get_cell_type(id) == "code") {
            s += "\n" + actions.get_cell_input(id);
          }
        }
        return s;
      }
    }
    if (scope == "all") {
      let s = "";
      for (const id of this.jupyter_actions.store.get("cell_list") ?? []) {
        if (this.jupyter_actions.store.get_cell_type(id) == "code") {
          s += "\n" + actions.get_cell_input(id);
        }
      }
      return s;
    }

    // current cell or selection in it:
    const cur_id = actions.store.get("cur_id");
    if (scope == "selection") {
      return actions.getCellSelection(cur_id);
    }
    if (scope == "cell") {
      const cur = actions.get_cell_input(cur_id)?.trim();
      if (cur) {
        return cur;
      }
      // previous code -- TODO: one problem is that this will get truncated at the
      // bottom instead of top, which is bad if it is really big.
      let s = "";
      for (const id of this.jupyter_actions.store.get("cell_list") ?? []) {
        if (id == cur_id) {
          // done!
          return s;
        }
        if (this.jupyter_actions.store.get_cell_type(id) == "code") {
          s += "\n" + actions.get_cell_input(id);
        }
      }
      return s;
    }
    return "";
  }

  languageModelGetLanguage(): string {
    return (
      this.jupyter_actions?.store?.getIn(["kernel_info", "language"]) ?? "py"
    );
  }

  // used to add extra context like ", which is a Jupyter notebook using the Python 3 kernel"
  languageModelExtraFileInfo(): string {
    const kernel =
      this.jupyter_actions?.store?.getIn(["kernel_info", "display_name"]) ?? "";
    return `Jupyter notebook using the ${kernel} kernel`;
  }

  help(): void {
    openProjectDocs({
      projectId: this.project_id,
      slug: "jupyter/use-jupyter",
    });
  }

  about = () => {
    this.jupyter_actions.show_about();
  };

  codexCodeDescription(): string {
    const kernel =
      this.jupyter_actions?.store?.getIn(["kernel_info", "display_name"]) ?? "";
    return `Jupyter notebook using the ${kernel} kernel`;
  }

  languageModelGetScopes() {
    return new Set<"selection" | "cell">(["selection", "cell"]);
  }

  gotoUser(account_id: string, frameId?: string) {
    const cursors = this.jupyter_actions.syncdb
      .get_cursors({ maxAge: 0, excludeSelf: "never" })
      ?.toJS();
    const locs = cursors?.[account_id]?.locs;
    if (locs == null) {
      return; // no info
    }
    for (const loc of locs) {
      if (loc.id != null) {
        const frameActions = this.get_frame_actions(frameId);
        if (frameActions != null) {
          frameActions.set_cur_id(loc.id);
          frameActions.scroll("cell visible");
          return;
        }
      }
    }
  }

  getSearchIndexData = () => {
    const cells = this.jupyter_actions.store.get("cells");
    if (cells == null) {
      return {};
    }
    const data: { [id: string]: string } = {};
    for (const [id, cell] of cells) {
      let content = cell.get("input")?.trim();
      if (!content) {
        continue;
      }
      data[id] = content;
    }
    return { data, fragmentKey: "id", reduxName: this.jupyter_actions.name };
  };
}

export { JupyterEditorActions as Actions };
