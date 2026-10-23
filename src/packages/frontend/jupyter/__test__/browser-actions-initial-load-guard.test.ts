/** @jest-environment jsdom */

// A customer report: while a notebook's initial load from
// its .ipynb was still pending, an autosave wrote the empty live notebook over
// the file (a 99-byte save), and the editable preview let a user's typing
// become the notebook's only cell.  Neither may happen before the initial
// source has settled.

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { JupyterActions } from "../browser-actions";

function createActions() {
  const actions: any = new JupyterActions("jupyter-initial-load-guard-test", {
    getStore: jest.fn(() => undefined),
    removeActions: jest.fn(),
  } as any);
  actions._state = "ready";
  actions.path = "lab.ipynb";
  actions.isClosed = jest.fn(() => actions._state === "closed");
  actions.runDebug = jest.fn();
  actions.setToIpynb = jest.fn(async () => {});
  actions.refreshKernelStatus = jest.fn(async () => {});
  const state: Record<string, any> = {};
  actions.store = {
    emit: jest.fn(),
    get: jest.fn((key: string) => state[key]),
  };
  actions.setState = jest.fn((obj: Record<string, any>) => {
    Object.assign(state, obj);
  });
  actions.set_cm_options = jest.fn();
  return actions;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("Jupyter browser actions before the initial load settles", () => {
  it("does not save the live notebook to disk until the initial source settled", async () => {
    const actions = createActions();
    const jupyterSaveIpynb = jest.fn(async () => ({
      bytes: 99,
      converted: false,
      ipynb: { cells: [] },
    }));
    actions.syncdb = {
      fs: { jupyterSaveIpynb },
      get_state: () => "ready",
      has_uncommitted_changes: () => false,
      newestVersion: () => "v1",
    };
    actions.toIpynb = jest.fn(async () => ({ cells: [] }));
    // A metadata patch (e.g. a presence heartbeat) marked the notebook dirty.
    actions.hasUnsavedChanges = true;

    const saving = actions.saveIpynb();
    await flush();
    expect(jupyterSaveIpynb).not.toHaveBeenCalled();

    // Once the file has been loaded, the save writes what was loaded.
    actions.settleInitialSource();
    await saving;
    expect(jupyterSaveIpynb).toHaveBeenCalledTimes(1);
  });

  it("keeps the notebook read-only until the initial source settled", () => {
    const actions = createActions();
    actions.syncdb = { is_read_only: () => false };

    actions.sync_read_only();
    expect(actions.store.get("read_only")).toBe(true);

    actions.settleInitialSource();
    expect(actions.store.get("read_only")).toBe(false);
  });

  it("stays read-only after settling when the document itself is read-only", () => {
    const actions = createActions();
    actions.syncdb = { is_read_only: () => true };
    actions.settleInitialSource();
    expect(actions.store.get("read_only")).toBe(true);
  });

  describe("initial loads into an empty notebook (a doubled notebook, a customer report)", () => {
    function hydrationActions({
      peerCellsAfterImport,
    }: {
      peerCellsAfterImport: boolean;
    }) {
      const actions = createActions();
      actions.settleInitialSource = jest.fn();
      let liveCell: any = null;
      const jupyterImportIpynb = jest.fn(async (ipynb) => {
        // While this client's import RPC is in flight, another client loads
        // the same file into the live notebook.
        if (peerCellsAfterImport) liveCell = { type: "cell", id: "peer" };
        return { ipynb };
      });
      actions.syncdb = {
        fs: { jupyterImportIpynb },
        get_one: jest.fn(() => liveCell),
        has_uncommitted_changes: () => false,
        newestVersion: () => "v1",
      };
      actions.diskIsIpynbSave = jest.fn(async () => false);
      actions.markIpynbSaved = jest.fn();
      return actions;
    }
    const diskRead = {
      bytes: 100,
      text: "{}",
      ipynb: { cells: [{ cell_type: "code", source: "1" }] },
    };

    it("does not replace another client's load, or edits made since, with an older read", async () => {
      // A and B both found the notebook empty.  While B's import runs, A
      // loads the file and the user edits it there; B must keep that.
      const actions = hydrationActions({ peerCellsAfterImport: true });
      await actions.watchLoadFromDisk({
        diskRead,
        initial: true,
        intoEmptyRtc: true,
      });
      expect(actions.setToIpynb).not.toHaveBeenCalled();
    });

    it("clears the deleted flag when another client's load completes the initial load", async () => {
      const actions = hydrationActions({ peerCellsAfterImport: false });
      actions.isIpynbDeleted = true; // a previous attempt failed
      actions.syncdb.get_one = jest.fn(() => ({ type: "cell", id: "peer" }));
      await actions.watchLoadFromDisk({
        diskRead,
        initial: true,
        intoEmptyRtc: true,
      });
      expect(actions.setToIpynb).not.toHaveBeenCalled();
      expect(actions.isIpynbDeleted).toBe(false);
    });

    it("imports when nobody else loaded the notebook", async () => {
      const actions = hydrationActions({ peerCellsAfterImport: false });
      await actions.watchLoadFromDisk({
        diskRead,
        initial: true,
        intoEmptyRtc: true,
      });
      expect(actions.setToIpynb).toHaveBeenCalledTimes(1);
    });

    it("loads an empty notebook with the same cell ids in every client", async () => {
      const actions = hydrationActions({ peerCellsAfterImport: false });
      await actions.watchLoadFromDisk({
        diskRead,
        initial: true,
        intoEmptyRtc: true,
      });
      const [ipynb] = actions.setToIpynb.mock.calls[0];
      expect(typeof ipynb.cells[0].id).toBe("string");
      expect(ipynb.cells[0].id.length).toBeGreaterThan(0);
    });

    it("still imports a file newer than a live notebook that has cells", async () => {
      const actions = hydrationActions({ peerCellsAfterImport: true });
      await actions.watchLoadFromDisk({ diskRead, initial: true });
      expect(actions.setToIpynb).toHaveBeenCalledTimes(1);
    });
  });

  describe("the raw JSON editor before the initial load settles", () => {
    it("ignores a raw edit, so it cannot pass for another client's load", async () => {
      const actions = createActions();
      actions.settleInitialSource = jest.fn();
      let liveCell: any = null;
      // A raw edit would replace the cells through setToIpynb.
      actions.setToIpynb = jest.fn(async () => {
        liveCell = { type: "cell", id: "raw-edit" };
      });
      const jupyterImportIpynb = jest.fn(async (ipynb) => {
        // While the slow initial import runs, the user edits the raw JSON.
        if (jupyterImportIpynb.mock.calls.length === 1) {
          await actions.setIpynbFromRawEditor({ cells: [{ source: "typed" }] });
        }
        return { ipynb };
      });
      actions.syncdb = {
        fs: { jupyterImportIpynb },
        get_one: jest.fn(() => liveCell),
        has_uncommitted_changes: () => false,
        newestVersion: () => "v1",
      };
      actions.diskIsIpynbSave = jest.fn(async () => false);
      actions.markIpynbSaved = jest.fn();

      await actions.watchLoadFromDisk({
        diskRead: {
          bytes: 100,
          text: "{}",
          ipynb: { cells: [{ cell_type: "code", source: "from disk" }] },
        },
        initial: true,
        intoEmptyRtc: true,
      });

      // Only the load from disk replaced the cells; the raw edit did not.
      expect(actions.setToIpynb).toHaveBeenCalledTimes(1);
      const [ipynb] = actions.setToIpynb.mock.calls[0];
      expect(ipynb.cells[0].source).toBe("from disk");
    });

    it("applies raw edits once settled, unless read-only", async () => {
      const actions = createActions();
      const jupyterImportIpynb = jest.fn(async (ipynb) => ({ ipynb }));
      actions.syncdb = {
        fs: { jupyterImportIpynb },
        is_read_only: () => false,
      };
      actions.settleInitialSource();
      await actions.setIpynbFromRawEditor({ cells: [] });
      expect(actions.setToIpynb).toHaveBeenCalledTimes(1);

      actions.setState({ read_only: true });
      await actions.setIpynbFromRawEditor({ cells: [] });
      expect(actions.setToIpynb).toHaveBeenCalledTimes(1);
    });
  });

  it("does not undo or redo before the initial source settled", () => {
    const actions = createActions();
    const undo = jest.fn();
    const redo = jest.fn();
    actions.syncdb = {
      isReady: () => true,
      is_read_only: () => false,
      undo,
      redo,
    };
    actions.sync_read_only();
    expect(actions.undo()).toBe(false);
    expect(actions.redo()).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();

    actions.settleInitialSource();
    expect(actions.undo()).toBe(true);
    expect(actions.redo()).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("does not change a cell id while read-only", () => {
    const actions = createActions();
    const del = jest.fn();
    const set = jest.fn();
    actions.syncdb = { delete: del, set, is_read_only: () => false };
    actions.store.getIn = jest.fn(() => ({
      toJS: () => ({ id: "a", type: "cell" }),
    }));
    actions.sync_read_only();
    actions.setCellId("a", "b");
    expect(del).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
