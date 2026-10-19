/** @jest-environment jsdom */

// The single empty cell created for an empty notebook must never win over, or
// be saved on top of, a notebook file that has content (support ticket
// 21023: students who opened a course assignment just as it was copied got a
// one-cell notebook instead of the lab).

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { fromJS, List, Map } from "immutable";
import { JupyterActions } from "../browser-actions";

const LAB = {
  cells: [
    { cell_type: "markdown", source: ["### Lab 3"] },
    { cell_type: "code", source: ["x = 1"], outputs: [] },
  ],
};
const LAB_TEXT = JSON.stringify(LAB);
const LAB_READ = { bytes: LAB_TEXT.length, text: LAB_TEXT, ipynb: LAB };
const ALPHA = { type: "cell", id: "alpha", pos: 0, input: "" };

function createActions({
  cells = [ALPHA],
  settings = {},
}: {
  cells?: object[];
  settings?: object;
} = {}) {
  const actions: any = new JupyterActions("jupyter-placeholder-test", {
    getStore: jest.fn(() => undefined),
    removeActions: jest.fn(),
  } as any);
  actions._state = "ready";
  actions.path = "Lab 3.ipynb";
  actions.isClosed = jest.fn(() => false);
  actions.runDebug = jest.fn();
  actions.setState = jest.fn();
  actions.setToIpynb = jest.fn(async () => {});
  actions.refreshKernelStatus = jest.fn(async () => {});
  actions.store = { emit: jest.fn() };
  // Classification must work from raw records, without exporting the
  // notebook (which loads output blobs).
  actions.toIpynb = jest.fn(async () => ({ cells: [{ source: "" }] }));
  let version = "v1";
  actions.setVersion = (v: string) => (version = v);
  const cellList = List(cells.map((cell) => fromJS(cell)));
  actions.syncdb = {
    fs: {
      jupyterImportIpynb: jest.fn(async (ipynb) => ({ ipynb })),
      jupyterSaveIpynb: jest.fn(async (_path, ipynb) => ({
        bytes: 10,
        converted: false,
        ipynb,
      })),
      readFile: jest.fn(async () => Buffer.from(LAB_TEXT)),
      stat: jest.fn(async () => ({ mtimeMs: 1000 })),
    },
    get_state: () => "ready",
    get: (where) => (where?.type === "cell" ? cellList : List()),
    get_one: (where) =>
      where?.type === "settings"
        ? fromJS({ type: "settings", ...settings })
        : cellList.first(),
    has_uncommitted_changes: () => false,
    newestVersion: () => version,
    last_changed: () => 2000,
  };
  return actions;
}

describe("file events", () => {
  it("load a file that arrives while the open notebook is an unsaved placeholder", async () => {
    const actions = createActions();
    actions.hasUnsavedChanges = true;
    actions.saveIpynb = jest.fn(async () => {});

    await actions.watchLoadFromDisk({ diskRead: LAB_READ });

    expect(actions.saveIpynb).not.toHaveBeenCalled();
    expect(actions.syncdb.fs.jupyterImportIpynb).toHaveBeenCalledWith(LAB);
    expect(actions.setToIpynb).toHaveBeenCalledWith(LAB);
    expect(actions.toIpynb).not.toHaveBeenCalled();
  });

  it("still protect unsaved real edits", async () => {
    const actions = createActions({ cells: [{ ...ALPHA, input: "y = 2" }] });
    actions.hasUnsavedChanges = true;
    actions.saveIpynb = jest.fn(async () => {});

    await actions.watchLoadFromDisk({ diskRead: LAB_READ });

    expect(actions.saveIpynb).toHaveBeenCalledTimes(1);
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it.each([
    [
      "every cell was deleted (durable flag, also seen by other clients and after reconnect)",
      { settings: { has_had_content: true } },
    ],
    ["the cell has tags", { cells: [{ ...ALPHA, tags: { exercise: true } }] }],
    [
      "the cell has metadata",
      { cells: [{ ...ALPHA, metadata: { nbgrader: { grade: true } } }] },
    ],
    ["the cell has output", { cells: [{ ...ALPHA, output: { 0: "x" } }] }],
    ["it is not the generated cell", { cells: [{ ...ALPHA, id: "c1" }] }],
    ["it is a markdown cell", { cells: [{ ...ALPHA, cell_type: "markdown" }] }],
  ])("treat the empty notebook as real when %s", async (_label, opts) => {
    const actions = createActions(opts as any);
    actions.hasUnsavedChanges = true;
    actions.saveIpynb = jest.fn(async () => {});

    await actions.watchLoadFromDisk({ diskRead: LAB_READ });

    expect(actions.saveIpynb).toHaveBeenCalledTimes(1);
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it("abandon the load if the placeholder is edited while the file is read", async () => {
    const actions = createActions();
    actions.hasUnsavedChanges = true;
    actions.saveIpynb = jest.fn(async () => {});
    actions.syncdb.fs.readFile = jest.fn(async () => {
      actions.setVersion("v2"); // the user typed into the cell
      return Buffer.from(LAB_TEXT);
    });

    await actions.watchLoadFromDisk({});

    expect(actions.setToIpynb).not.toHaveBeenCalled();
    expect(actions.saveIpynb).not.toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("ask the project host not to replace content when saving the placeholder, and load the file it refused to replace", async () => {
    const actions = createActions();
    actions.hasUnsavedChanges = true;
    actions.toIpynb = jest.fn(async () => ({
      cells: [{ cell_type: "code", source: "", outputs: [] }],
    }));
    actions.syncdb.fs.jupyterSaveIpynb = jest.fn(async (_p, ipynb) => ({
      bytes: 0,
      converted: false,
      ipynb,
      skipped: "disk_has_content",
    }));

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledWith(
      "Lab 3.ipynb",
      expect.anything(),
      { onlyIfNoContent: true },
    );
    expect(actions.setToIpynb).toHaveBeenCalledWith(LAB);
  });

  it("save real content unconditionally", async () => {
    const actions = createActions({ cells: [{ ...ALPHA, input: "y = 2" }] });
    actions.hasUnsavedChanges = true;
    actions.toIpynb = jest.fn(async () => ({ cells: [{ source: "y = 2" }] }));

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledWith(
      "Lab 3.ipynb",
      expect.anything(),
    );
  });

  it("save an emptied notebook unconditionally after every cell was deleted", async () => {
    const actions = createActions({ settings: { has_had_content: true } });
    actions.hasUnsavedChanges = true;
    actions.toIpynb = jest.fn(async () => ({ cells: [{ source: "" }] }));

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledWith(
      "Lab 3.ipynb",
      expect.anything(),
    );
  });
});

describe("opening", () => {
  function prepareOpen(actions) {
    let closed = false;
    actions.isClosed = jest.fn(() => closed);
    actions.noteOpenInitPhase = jest.fn();
    actions.maybeLogFirstVisibleCell = jest.fn();
    return () => (closed = true);
  }

  it("load the file even though the placeholder is newer than it, guarded by the version seen before classifying", async () => {
    // RTC last_changed (2000) is newer than the file's mtime (1000), which
    // used to keep the placeholder.
    const actions = createActions();
    const close = prepareOpen(actions);
    actions.watchLoadFromDisk = jest.fn(async () => close());

    await actions.watchIpynb();

    expect(actions.watchLoadFromDisk).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: true,
        expectedRtcVersion: "v1",
        replacingPlaceholder: true,
      }),
    );
  });

  it("keep real live content that is newer than the file", async () => {
    const actions = createActions({ cells: [{ ...ALPHA, input: "y = 2" }] });
    const close = prepareOpen(actions);
    close();
    actions.isClosed = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    actions.watchLoadFromDisk = jest.fn(async () => {});

    await actions.watchIpynb();

    expect(actions.watchLoadFromDisk).not.toHaveBeenCalled();
  });

  it("abandon the initial load if the placeholder is edited during conversion", async () => {
    const actions = createActions();
    actions.syncdb.fs.jupyterImportIpynb = jest.fn(async (ipynb) => {
      actions.setVersion("v2");
      return { ipynb };
    });

    await actions.watchLoadFromDisk({
      initial: true,
      diskRead: LAB_READ,
      expectedRtcVersion: "v1",
      replacingPlaceholder: true,
    });

    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });
});

describe("ensureThereIsACell", () => {
  function withCells(actions, cells: object[]) {
    actions.store = {
      get: (key) =>
        key === "cells"
          ? Map(cells.map((c: any) => [c.id, fromJS(c)]))
          : undefined,
    };
  }

  it("records durably that every cell was deleted after content was seen", () => {
    const actions = createActions();
    actions._set = jest.fn();
    actions.set_trust_notebook = jest.fn();
    withCells(actions, [{ ...ALPHA, id: "c1", input: "x = 1" }]);
    actions.ensureThereIsACell();
    withCells(actions, []);
    actions.ensureThereIsACell();

    expect(actions._set).toHaveBeenCalledWith(
      { type: "settings", has_had_content: true },
      false,
    );
  });

  it("does not mark a notebook that was empty from the start", () => {
    const actions = createActions();
    actions._set = jest.fn();
    actions.set_trust_notebook = jest.fn();
    withCells(actions, []);
    actions.ensureThereIsACell();
    withCells(actions, [ALPHA]);
    actions.ensureThereIsACell();

    expect(actions._set).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "settings" }),
      expect.anything(),
    );
  });
});
