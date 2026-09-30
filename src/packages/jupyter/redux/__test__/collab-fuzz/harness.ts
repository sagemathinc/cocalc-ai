/*
Headless multi-client harness for collaborative notebook editing. See
src/.agents/harden-jupyter-collaborative-editing-plan-2026-09-30.md (J2).

Each simulated client runs the real notebook code: real JupyterActions and
JupyterStore on its own headless redux, over SimSyncDB, which reproduces
SyncDoc's semantics (local draft, commit, rebasing the draft onto merged
remote patches, throttled change events) on a real patchflow Session with
CoCalc's db codec. Clients exchange patches over a seeded simulated network
with delays and reordering. A client can focus a cell, whose editor is
modelled on frontend/jupyter/cell-input.tsx and codemirror-editor.tsx: a live
buffer, a debounced save, SimpleInputMerge for remote changes, and a save
when the editor unmounts.
*/

import { debounce } from "lodash";
import { type PatchEnvelope, type Session } from "patchflow";
import {
  dbCodec,
  SimSyncDB,
  simSession,
  type SimNetwork,
} from "@cocalc/sync/editor/sim";
import { SimpleInputMerge } from "@cocalc/sync/editor/generic/simple-input-merge";
import { AppRedux } from "../../app";
import { JupyterActions } from "../../actions";
import { JupyterStore } from "../../store";
import { SYNCDB_OPTIONS } from "../../sync";

export {
  makeRng,
  pick,
  SimNetwork,
  tokensIn,
  TOKEN_RE,
  type Commit,
  type Rng,
} from "@cocalc/sync/editor/sim";

// frontend/frame-editors/code-editor/const.ts
export const SAVE_DEBOUNCE_MS = 750;

// The notebook codec, as SyncDoc.buildPatchflowCodec builds it for a SyncDB
// with SYNCDB_OPTIONS (with its exact merge).
export const codec = dbCodec({
  primaryKeys: SYNCDB_OPTIONS.primary_keys,
  stringCols: SYNCDB_OPTIONS.string_cols,
});
export const fromStr = codec.fromString;

// A cell's input editor, modelled on frontend/jupyter/cell-input.tsx (live
// value, SimpleInputMerge for remote changes) and codemirror-editor.tsx
// (debounced save of the editor contents, replacing the contents when the
// merged value changes, and a save on unmount).
export class CellEditor {
  public value: string; // what CodeMirror shows
  private lastRemote: string; // codemirror-editor's cm_last_remote
  private localValue: string; // cell-input's localValue state
  private merge: SimpleInputMerge;
  private seenInput: string;
  public closed = false;
  private scheduleSave: ReturnType<typeof debounce>;

  constructor(
    private client: NotebookClient,
    public id: string,
  ) {
    const input = client.cellInput(id) ?? "";
    this.value = input;
    this.lastRemote = input;
    this.localValue = input;
    this.seenInput = input;
    this.merge = new SimpleInputMerge(input);
    this.scheduleSave = debounce(() => this.cmSave(), SAVE_DEBOUNCE_MS);
  }

  // The user edits the editor contents.
  edit(f: (value: string) => string): void {
    this.value = f(this.value);
    this.scheduleSave();
  }

  // codemirror-editor.tsx cm_save
  cmSave(): void {
    if (this.value === this.lastRemote) return;
    const base = this.lastRemote;
    const written = this.client.run("editor save", () =>
      this.client.actions.set_cell_input(this.id, this.value, true, base),
    );
    const saved = written ?? this.value;
    this.lastRemote = saved;
    // cell-input.tsx onSetCellInput: note it, and show it if it differs.
    this.noteSaved(saved, written != null);
    if (saved !== this.value) {
      this.localValue = saved;
      this.renderValue();
    }
  }

  // cell-input.tsx noteSaved: a stored value is the new baseline at once.
  private noteSaved(value: string, stored: boolean): void {
    if (stored) this.merge.noteLocalEcho(value);
    else this.merge.noteSaved(value);
  }

  // cell-input.tsx setCellInput, then CodeMirror's value effect.
  private setCellInput(value: string, base?: string): void {
    const written = this.client.run("editor merge", () =>
      this.client.actions.set_cell_input(this.id, value, true, base),
    );
    const saved = written ?? value;
    this.localValue = saved;
    this.noteSaved(saved, written != null);
    this.renderValue();
  }

  private renderValue(): void {
    if (this.value !== this.localValue) {
      this.value = this.localValue;
      this.lastRemote = this.localValue;
    }
  }

  // cell-input.tsx: effect on props.cell.get("input").
  storeChanged(): void {
    if (this.closed) return;
    const input = this.client.cellInput(this.id);
    if (input == null || input === this.seenInput) return;
    this.seenInput = input;
    this.merge.handleRemote({
      remote: input,
      getLocal: () => this.value,
      applyMerged: (value) => this.setCellInput(value, input),
    });
  }

  // Unmount (blur to another cell, or the cell was deleted): cm_save.
  close(): void {
    if (this.closed) return;
    this.scheduleSave.cancel();
    this.cmSave();
    this.closed = true;
  }
}

export class NotebookClient {
  public session!: Session;
  public syncdb!: SimSyncDB;
  public actions!: any;
  public store!: any;
  public editor?: CellEditor;

  constructor(
    public id: number,
    private net: SimNetwork,
    private clock: () => number,
    private initial: PatchEnvelope[],
  ) {}

  async start(): Promise<void> {
    this.session = await simSession({
      id: this.id,
      net: this.net,
      clock: this.clock,
      initial: this.initial,
      codec,
    });
    this.syncdb = new SimSyncDB(this.session, {
      changeThrottle: SYNCDB_OPTIONS.change_throttle,
    });
    const redux = new AppRedux();
    const name = `jupyter-fuzz-${this.id}`;
    this.store = redux.createStore(name, JupyterStore);
    this.actions = redux.createActions(name, JupyterActions);
    const client = {
      dbg: () => () => {},
      is_project: () => false,
      is_browser: () => true,
      // The blob store and runtime state that use it are mocked in tests.
      conat: () => ({}),
    };
    this.actions._init(
      this.syncdb.project_id,
      "fuzz.ipynb",
      this.syncdb,
      this.store,
      client,
    );
    this.syncdb.emitInitialChange();
    this.actions._state = "ready";
    // React re-renders after a store change: a cell that disappeared
    // unmounts its editor, and a mounted editor sees its new input.
    this.store.on("change", () => {
      setTimeout(() => {
        this.unmountDeletedEditor();
        this.editor?.storeChanged();
      }, 0);
    });
  }

  // Run an operation, labelling the commits it makes.
  run<T>(source: string, f: () => T): T {
    return this.syncdb.run(source, f);
  }

  cellList(): string[] {
    return this.store.get("cell_list")?.toJS() ?? [];
  }

  cellInput(id: string): string | undefined {
    return this.store.getIn(["cells", id, "input"]);
  }

  focus(id: string | undefined): void {
    if (this.editor?.id === id && !this.editor?.closed) return;
    this.editor?.close();
    this.editor = id == null ? undefined : new CellEditor(this, id);
  }

  // The notebook frame's commands that split, merge, copy or delete cells
  // first save every open input editor (cell-notebook/actions.ts
  // save_all_input_editors).
  frameCommand<T>(source: string, f: () => T): T {
    if (this.editor != null && !this.editor.closed) this.editor.cmSave();
    return this.run(source, f);
  }

  // The cell editor unmounts when its cell disappears from the notebook.
  unmountDeletedEditor(): void {
    if (this.editor != null && !this.editor.closed) {
      if (this.store.getIn(["cells", this.editor.id]) == null) {
        this.editor.close();
        this.editor = undefined;
      }
    }
  }

  // The notebook as synced (records, one JSON per line).
  doc(): string {
    return this.syncdb.to_str();
  }

  stop(): void {
    this.editor?.close();
    this.session.close();
  }
}
