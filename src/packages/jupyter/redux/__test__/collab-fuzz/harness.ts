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

import { EventEmitter } from "events";
import { debounce, throttle } from "lodash";
import { Session, type PatchEnvelope, type PatchStore } from "patchflow";
import { from_str } from "@cocalc/sync/editor/db/doc";
import { rebaseLocalDocument } from "@cocalc/sync/editor/generic/rebase-local-document";
import { SimpleInputMerge } from "@cocalc/sync/editor/generic/simple-input-merge";
import { AppRedux } from "../../app";
import { JupyterActions } from "../../actions";
import { JupyterStore } from "../../store";
import { SYNCDB_OPTIONS } from "../../sync";

// frontend/frame-editors/code-editor/const.ts
export const SAVE_DEBOUNCE_MS = 750;

export type Rng = () => number;

// Small deterministic PRNG so every failure is replayable from its seed.
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: Rng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)];

// The notebook codec, as SyncDoc.buildPatchflowCodec builds it for a SyncDB
// with SYNCDB_OPTIONS.
const PRIMARY_KEYS = SYNCDB_OPTIONS.primary_keys;
const STRING_COLS = SYNCDB_OPTIONS.string_cols;
export const fromStr = (s: string) => from_str(s, PRIMARY_KEYS, STRING_COLS);
export const codec = {
  fromString: fromStr,
  toString: (d: any) => d.to_str(),
  applyPatch: (d: any, p: unknown) => d.apply_patch(p),
  applyPatchBatch: (d: any, ps: unknown[]) => d.apply_patch_batch(ps),
  makePatch: (a: any, b: any) => a.make_patch(b),
};

interface InFlight {
  to: number;
  env: PatchEnvelope;
  deliverAt: number;
}

export class SimNetwork {
  private queue: InFlight[] = [];
  private receivers = new Map<number, (env: PatchEnvelope) => void>();
  public log: { from: number; env: PatchEnvelope }[] = [];

  constructor(
    private rng: Rng,
    private now: () => number,
    private maxDelayMs: number,
  ) {}

  register(id: number, onEnvelope: (env: PatchEnvelope) => void): void {
    this.receivers.set(id, onEnvelope);
  }

  send(from: number, env: PatchEnvelope): void {
    this.log.push({ from, env });
    for (const to of this.receivers.keys()) {
      if (to === from) continue;
      this.queue.push({
        to,
        env,
        deliverAt: this.now() + Math.floor(this.rng() * this.maxDelayMs),
      });
    }
  }

  pending(): number {
    return this.queue.length;
  }

  // Deliver messages that are due, in random order (patchflow must tolerate
  // reordering).
  deliverDue(all = false): number {
    const now = this.now();
    const due = this.queue.filter((m) => all || m.deliverAt <= now);
    this.queue = this.queue.filter((m) => !due.includes(m));
    for (let i = due.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [due[i], due[j]] = [due[j], due[i]];
    }
    for (const m of due) this.receivers.get(m.to)?.(m.env);
    return due.length;
  }
}

class SimPatchStore implements PatchStore {
  private listeners: ((env: PatchEnvelope) => void)[] = [];
  constructor(
    private id: number,
    private net: SimNetwork,
    private initial: PatchEnvelope[],
  ) {
    net.register(id, (env) => {
      for (const fn of this.listeners) fn(env);
    });
  }
  async loadInitial() {
    return { patches: this.initial.slice() };
  }
  append(env: PatchEnvelope): void {
    this.net.send(this.id, env);
  }
  subscribe(fn: (env: PatchEnvelope) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  }
}

export interface Commit {
  before: string;
  after: string;
  source?: string;
}

// The subset of SyncDB that JupyterActions and JupyterStore use, with the
// semantics of SyncDoc (sync/editor/generic/sync-doc.ts): set/delete edit a
// local draft and emit a debounced change; commit rebases the draft onto the
// committed document and commits it as a patch; merged remote patches rebase
// the draft and emit a change throttled by change_throttle.
export class SimSyncDB extends EventEmitter {
  public project_id = "00000000-0000-4000-8000-000000000000";
  private doc: any;
  private last: any;
  private before_change: any;
  public commits: Commit[] = [];
  public source?: string;
  private emit_change: () => void;
  private emit_change_debounced: () => void;

  constructor(public session: Session) {
    super();
    this.setMaxListeners(100);
    this.doc = session.getDocument();
    this.last = this.doc;
    this.emit_change_debounced = debounce(this.emitChangeNow, 0);
    this.emit_change = throttle(
      this.emitChangeNow,
      SYNCDB_OPTIONS.change_throttle,
    );
    session.on("change", this.handlePatchflowChange);
  }

  private emitChangeNow = (): void => {
    this.emit("change", this.doc?.changes?.(this.before_change));
    this.before_change = this.doc;
  };

  private handlePatchflowChange = (committed: any): void => {
    const previous = this.doc;
    const next =
      previous == null
        ? committed
        : rebaseLocalDocument({ base: this.last, draft: previous, committed });
    this.last = committed;
    this.doc = next;
    if (previous != null && previous.is_equal(next)) return;
    this.emit("after-change");
    this.emit_change();
  };

  private set_doc(doc: any): void {
    if (doc.is_equal(this.doc)) return;
    this.doc = doc;
    this.emit_change_debounced();
  }

  set = (x: any): void => this.set_doc(this.doc.set(x));
  delete = (x?: any): void => this.set_doc(this.doc.delete(x));
  get = (x?: any): any => this.doc.get(x);
  get_one = (x?: any): any => this.doc.get_one?.(x);
  get_doc = (): any => this.doc;
  to_str = (): string => this.doc.to_str();

  commit = (): boolean => {
    const draft = this.doc;
    const current = this.session.getDocument() as any;
    const forceMerge = this.session.getHeads().length > 1;
    const next = rebaseLocalDocument({
      base: this.last,
      draft,
      committed: current,
    });
    this.doc = next;
    if (!forceMerge && current.is_equal(next)) return false;
    this.last = next;
    const before = current.to_str();
    this.session.commit(next);
    this.commits.push({ before, after: next.to_str(), source: this.source });
    return true;
  };

  save = async (): Promise<void> => {};
  get_state = (): string => "ready";
  isReady = (): boolean => true;
  is_read_only = (): boolean => false;
  init_ipywidgets = (): void => {};
  in_undo_mode = (): boolean => false;
  undo = (): void => {};
  redo = (): void => {};
  has_uncommitted_changes = (): boolean => false;
  close = (): void => {
    this.session.close();
  };
}

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
    this.lastRemote = this.value;
    this.client.run("editor save", () =>
      this.client.actions.set_cell_input(this.id, this.value, true),
    );
    this.merge.noteSaved(this.value); // onSetCellInput
  }

  // cell-input.tsx setCellInput, then CodeMirror's value effect.
  private setCellInput(value: string): void {
    this.localValue = value;
    this.client.run("editor merge", () =>
      this.client.actions.set_cell_input(this.id, value, true),
    );
    this.merge.noteSaved(value);
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
      applyMerged: (value) => this.setCellInput(value),
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
    const patchStore = new SimPatchStore(this.id, this.net, this.initial);
    this.session = new Session({
      codec,
      patchStore,
      clock: this.clock,
      userId: this.id + 1,
      clientId: `client${this.id}`,
    });
    await this.session.init();
    this.syncdb = new SimSyncDB(this.session);
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
    // SyncDoc emits a change from nothing to the loaded document when ready.
    this.syncdb.emit("change", "all");
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
    const prev = this.syncdb.source;
    this.syncdb.source = source;
    try {
      return f();
    } finally {
      this.syncdb.source = prev;
    }
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

export const TOKEN_RE = /tk[a-z]\d+q/g;
export const tokensIn = (text: string): string[] => text.match(TOKEN_RE) ?? [];
