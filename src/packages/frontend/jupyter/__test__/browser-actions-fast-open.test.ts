/** @jest-environment jsdom */

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { EventEmitter } from "events";
import {
  type SaveStatus,
  saveStatus,
} from "@cocalc/frontend/frame-editors/frame-tree/save-button";
import { NotebookFrameActions } from "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/actions";
import { JupyterActions } from "../browser-actions";

// The optimistic fast-open preview shows the .ipynb file on disk read-only
// until the notebook's syncdb is ready. The status chip must say Loading (not
// Read-only) during that time, and editing must stay locked until the syncdb
// is ready, because _set silently drops every write before then.

const IPYNB = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: ["1 + 1"],
    },
  ],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolve0) => {
    resolve = resolve0;
  });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

// The same state machine as SyncDoc: "init" until ready, then "ready". Like
// SyncDoc.set_state, it emits "connected" only when all of its tables are
// connected.
class FakeSyncdb extends EventEmitter {
  state: "init" | "ready" | "closed" = "init";
  readOnly = false;
  ipywidgets_state: object | undefined = {};
  set = jest.fn();
  commit = jest.fn();
  save = jest.fn();
  isReady = () => this.state === "ready";
  get_state = () => this.state;
  is_read_only = () => this.readOnly;
  has_uncommitted_changes = () => false;
  get_one = () => undefined;

  becomeReady({ connected = true } = {}) {
    this.state = "ready";
    if (connected) {
      this.emit("connected");
    }
    this.emit("ready");
  }
}

type EditorState = Record<string, any>;

// The status chip props, derived from the editor store the way
// frame-tree/title-bar.tsx does (useRedux read_only and rtc_status).
function chipProps(state: EditorState) {
  return {
    read_only: state.read_only,
    is_loading: state.rtc_status === "loading",
    is_connecting: state.rtc_status === "reconnecting",
    is_sync_error: state.rtc_status === "error",
  };
}

function createNotebook(
  opts: {
    readFile?: () => Promise<unknown>;
    syncdb?: FakeSyncdb;
  } = {},
) {
  const syncdb = opts.syncdb ?? new FakeSyncdb();
  const readFile = jest.fn(opts.readFile ?? (async () => IPYNB));
  const projectActions = {
    fs: () => ({ readFile }),
    log_opened_time: jest.fn(),
  };
  const actions: any = new JupyterActions("jupyter-fast-open-test", {
    getStore: jest.fn(() => undefined),
    getProjectActions: jest.fn(() => projectActions),
    removeActions: jest.fn(),
  } as any);

  // The JupyterEditorActions store, which the title bar reads.
  const editor = {
    state: {} as EditorState,
    calls: [] as EditorState[],
    // Chip status after every change the user could see: the frame tree,
    // title bar included, only renders once is_loaded is set.
    visibleChips: [] as SaveStatus[],
    setState(obj: EditorState) {
      editor.calls.push({ ...obj });
      Object.assign(editor.state, obj);
      if (editor.state.is_loaded) {
        editor.visibleChips.push(saveStatus(chipProps(editor.state)));
      }
    },
  };

  const notebook: Record<string, any> = {};
  const cmReadOnly: unknown[] = [];
  const store: any = new EventEmitter();
  store.get = (key: string) => notebook[key];
  store.get_cell_ids_list = () => undefined;
  store.get_kernel_info = () => undefined;
  store.is_cell_editable = () => true;
  store.getIn = ([key, ...rest]: string[]) => notebook[key]?.getIn?.(rest);
  store.get_cell_type = (id: string) =>
    notebook.cells?.getIn?.([id, "cell_type"]);

  actions._state = "init";
  actions.path = "notebook.ipynb";
  actions.project_id = "project-fast-open";
  actions.store = store;
  actions.syncdb = syncdb;
  actions.jupyterEditorActions = editor;
  actions.setState = jest.fn((obj: Record<string, any>) => {
    Object.assign(notebook, obj);
    // jupyter-editor/actions.ts copies read_only into the editor store.
    if (notebook.read_only != editor.state.read_only) {
      editor.setState({ read_only: notebook.read_only });
    }
  });
  // Records the read_only state the cell editors were configured with.
  actions.set_cm_options = jest.fn(() => cmReadOnly.push(notebook.read_only));
  for (const name of [
    "noteOpenInitPhase",
    "initReconnectResource",
    "initProjectRuntimeWatcher",
    "initUsageInfo",
    "fetch_jupyter_kernels",
    "set_jupyter_kernels",
    "initAccountSettingsWatcher",
    "initOpenLog",
    "maybeLogFirstVisibleCell",
    "getRtcLastChangedMs",
    "watchIpynb",
    "ensureLiveRunSubscription",
    "set_runtime_user_state",
    "refreshKernelStatus",
    "runDebug",
  ]) {
    actions[name] = jest.fn();
  }

  // What JupyterActions._init does after creating the syncdb.
  const open = async () => {
    actions.init2();
    await flush();
  };

  return {
    actions,
    cmReadOnly,
    editor,
    notebook,
    open,
    readFile,
    syncdb,
  };
}

// Asks a notebook frame to enter edit mode on a cell the two ways the UI
// does: set_mode (for example the Enter key) and activate_cell (for example a
// click). Runs the real NotebookFrameActions gates against the notebook store
// and returns every mode the frame switched to.
function requestEditMode(actions: any, id: string): string[] {
  const modes: string[] = [];
  const frame = {
    jupyter_actions: actions,
    store: {
      get: (key: string, dflt?: unknown) => (key === "cur_id" ? id : dflt),
    },
    input_editors: {},
    frame_id: "frame-fast-open",
    frame_tree_actions: { _get_active_id: () => "another-frame" },
    is_closed: () => false,
    validate: () => {},
    enable_key_handler: () => {},
    setState: (obj: { mode?: string }) => {
      if (obj.mode != null) {
        modes.push(obj.mode);
      }
    },
  };
  NotebookFrameActions.prototype.set_mode.call(frame, "edit");
  NotebookFrameActions.prototype.activate_cell.call(frame, id, {
    mode: "edit",
  });
  return modes;
}

describe("Jupyter optimistic fast open", () => {
  it("shows Loading, not Read-only, while the preview is shown", async () => {
    const { cmReadOnly, editor, notebook, open, readFile } = createNotebook();

    await open();

    expect(readFile).toHaveBeenCalledWith("notebook.ipynb", "utf8");
    expect(notebook.cell_list?.size).toBe(1);
    expect(notebook.read_only).toBe(true);
    expect(cmReadOnly).toEqual([true]);
    // is_loaded and rtc_status arrive together, so the first render of the
    // title bar already says Loading.
    expect(editor.calls.filter((call) => "is_loaded" in call)).toEqual([
      { is_loaded: true, rtc_status: "loading" },
    ]);
    expect(editor.visibleChips).toEqual(["loading"]);
  });

  it("keeps the preview locked when the syncdb emits metadata-change while loading", async () => {
    const { actions, editor, notebook, open, syncdb } = createNotebook();
    await open();

    // SyncDoc emits "metadata-change" while it is still initializing. This
    // goes through the listener that init2 registers.
    syncdb.emit("metadata-change");
    syncdb.emit("metadata-change");

    const id = notebook.cell_list.get(0);
    expect(notebook.read_only).toBe(true);
    expect(saveStatus(chipProps(editor.state))).toBe("loading");
    // Edit mode (cell-notebook/actions.ts set_mode and activate_cell) and
    // running cells are refused only because read_only is still true.
    expect(requestEditMode(actions, id)).toEqual([]);
    await actions.runCells([id]);
    expect(actions.runDebug).toHaveBeenCalledWith(
      "runCells.skip.read_only",
      expect.anything(),
    );

    // Once the syncdb is ready the same edit-mode requests succeed, so the
    // check above is not vacuous.
    syncdb.becomeReady();
    expect(notebook.read_only).toBe(false);
    expect(requestEditMode(actions, id)).toEqual(["edit", "edit"]);
  });

  it.each([true, false])(
    "hands over to live editing without ever showing Read-only (connected=%s)",
    async (connected) => {
      const { cmReadOnly, editor, notebook, open, syncdb } = createNotebook();
      await open();

      syncdb.becomeReady({ connected });

      expect(notebook.read_only).toBe(false);
      expect(cmReadOnly).toEqual([true, false]);
      expect(editor.state.rtc_status).toBeUndefined();
      // Unlock first, then clear Loading; "live" would start edit-ready
      // telemetry that notebooks do not record.
      expect(editor.calls.slice(-2)).toEqual([
        { read_only: false },
        { rtc_status: undefined },
      ]);
      expect(editor.calls.some((call) => call.rtc_status === "live")).toBe(
        false,
      );
      expect(editor.visibleChips).toEqual(["loading", "loading", "saved"]);
    },
  );

  it("still shows Read-only after loading when the notebook really is read-only", async () => {
    const syncdb = new FakeSyncdb();
    syncdb.readOnly = true;
    const { editor, notebook, open } = createNotebook({ syncdb });
    await open();

    syncdb.becomeReady();

    expect(notebook.read_only).toBe(true);
    expect(editor.state.rtc_status).toBeUndefined();
    expect(saveStatus(chipProps(editor.state))).toBe("read-only");
  });

  it("stays Loading and locked when the syncdb never becomes ready", async () => {
    // SyncDoc can keep retrying init without emitting an error. The preview
    // must at least not claim the file is read-only or unlock it.
    const { editor, notebook, open, syncdb } = createNotebook();
    await open();

    for (let attempt = 0; attempt < 5; attempt++) {
      syncdb.emit("metadata-change");
    }

    expect(notebook.read_only).toBe(true);
    expect(editor.state.rtc_status).toBe("loading");
    expect(editor.visibleChips).toEqual(["loading"]);
  });

  it("clears Loading even when the rest of the ready handler throws", async () => {
    // Defensive: in real code _init's init_ipywidgets() always sets
    // ipywidgets_state. This only pins that the chip does not stay on
    // Loading if the ready handler throws after unlocking.
    const syncdb = new FakeSyncdb();
    syncdb.ipywidgets_state = undefined;
    const { editor, notebook, open } = createNotebook({ syncdb });
    await open();
    expect(editor.state.rtc_status).toBe("loading");

    expect(() => syncdb.becomeReady()).toThrow(
      "ipywidgets_state must be defined",
    );

    expect(notebook.read_only).toBe(false);
    expect(editor.state.rtc_status).toBeUndefined();
  });

  it("clears Loading even when open telemetry throws at ready", async () => {
    // Defensive, like the test above: the chip must not stay on Loading, and
    // the next "connected" or "metadata-change" still unlocks editing.
    const { actions, editor, notebook, open, syncdb } = createNotebook();
    await open();
    actions.noteOpenInitPhase = jest.fn((phase: string) => {
      if (phase === "sync_ready") {
        throw Error("telemetry failed");
      }
    });

    expect(() => syncdb.becomeReady({ connected: false })).toThrow(
      "telemetry failed",
    );

    expect(editor.state.rtc_status).toBeUndefined();
    expect(notebook.read_only).toBe(true);
    syncdb.emit("connected");
    expect(notebook.read_only).toBe(false);
  });

  it("shows no Loading when the preview cannot be read", async () => {
    const { editor, notebook, open, syncdb } = createNotebook({
      readFile: async () => {
        throw Error("ENOENT");
      },
    });

    await open();

    expect(notebook.read_only).toBeUndefined();
    expect(notebook.cells).toBeUndefined();
    // No is_loaded, so the frame tree keeps its generic loading spinner.
    expect(editor.calls).toEqual([]);

    syncdb.becomeReady();

    expect(notebook.read_only).toBe(false);
    expect(editor.state.rtc_status).toBeUndefined();
    expect(editor.calls.some((call) => call.rtc_status === "loading")).toBe(
      false,
    );
  });

  it("shows no preview when the syncdb is ready before the read finishes", async () => {
    const read = deferred<string>();
    const { editor, notebook, open, syncdb } = createNotebook({
      readFile: () => read.promise,
    });
    await open();

    syncdb.becomeReady();
    read.resolve(IPYNB);
    await flush();

    expect(notebook.cells).toBeUndefined();
    expect(notebook.read_only).toBe(false);
    expect(editor.calls.some((call) => "is_loaded" in call)).toBe(false);
    expect(editor.calls.some((call) => call.rtc_status === "loading")).toBe(
      false,
    );
  });
});
