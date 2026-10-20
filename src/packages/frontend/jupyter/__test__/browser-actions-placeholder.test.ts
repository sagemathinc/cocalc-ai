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
import { export_to_ipynb } from "@cocalc/jupyter/ipynb/export-to-ipynb";
import { JupyterActions } from "../browser-actions";

// What toIpynb produces for these cell records: the real exporter, which
// adds its own defaults (e.g. metadata.collapsed) that a hand-written mock
// would miss.
function exportRecords(cellList: List<any>) {
  const cells = cellList.toJS() as any[];
  return export_to_ipynb({
    cell_list: cells.map((cell) => cell.id),
    cells: Object.fromEntries(cells.map((cell) => [cell.id, cell])),
    kernelspec: { name: "python3", display_name: "Python 3" },
  } as any);
}

const LAB = {
  cells: [
    { cell_type: "markdown", source: ["### Lab 3"] },
    { cell_type: "code", source: ["x = 1"], outputs: [] },
  ],
};
const LAB_TEXT = JSON.stringify(LAB);
const LAB_READ = { bytes: LAB_TEXT.length, text: LAB_TEXT, ipynb: LAB };
const ALPHA = { type: "cell", id: "alpha", pos: 0, input: "" };

// An empty-looking notebook whose only work is state the exporter writes
// (and isPlaceholderIpynb treats as content). It must not yield to the file.
const METADATA_ONLY_WORK: [string, object][] = [
  ["the cell is collapsed", { cells: [{ ...ALPHA, collapsed: true }] }],
  ["the cell is scrolled", { cells: [{ ...ALPHA, scrolled: true }] }],
  ["the cell was run", { cells: [{ ...ALPHA, exec_count: 1, last: 5 }] }],
  [
    "the notebook has custom metadata",
    { settings: { metadata: { nbgrader: { assignment: "lab3" } } } },
  ],
];

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
  let cellList = List(cells.map((cell) => fromJS(cell)));
  // Classification must work from raw records, without exporting the
  // notebook (which loads output blobs); saving exports for real.
  actions.toIpynb = jest.fn(async () => exportRecords(cellList));
  let version = "v1";
  actions.setVersion = (v: string) => (version = v);
  let uncommitted = false;
  actions.setUncommitted = (v: boolean) => (uncommitted = v);
  let settingsRecord: object = settings;
  actions.setCells = (next: object[]) =>
    (cellList = List(next.map((cell) => fromJS(cell))));
  actions.setSettings = (next: object) => (settingsRecord = next);
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
        ? fromJS({ type: "settings", ...settingsRecord })
        : cellList.first(),
    has_uncommitted_changes: () => uncommitted,
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
    expect(actions.setToIpynb).toHaveBeenCalledWith(
      LAB,
      false,
      expect.any(Object),
    );
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
    ...METADATA_ONLY_WORK,
  ])("treat the empty notebook as real when %s", async (_label, opts) => {
    const actions = createActions(opts as any);
    actions.hasUnsavedChanges = true;
    actions.saveIpynb = jest.fn(async () => {});

    await actions.watchLoadFromDisk({ diskRead: LAB_READ });

    expect(actions.saveIpynb).toHaveBeenCalledTimes(1);
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it("abandon the load on an uncommitted edit made while the file is read", async () => {
    const actions = createActions();
    actions.hasUnsavedChanges = true;
    actions.saveIpynb = jest.fn(async () => {});
    actions.syncdb.fs.readFile = jest.fn(async () => {
      actions.setCells([{ ...ALPHA, input: "y = 2" }]);
      actions.setUncommitted(true);
      return Buffer.from(LAB_TEXT);
    });

    await actions.watchLoadFromDisk({});

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
  it("never write the placeholder; load the file when it has content", async () => {
    const actions = createActions();
    actions.hasUnsavedChanges = true;

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).not.toHaveBeenCalled();
    expect(actions.setToIpynb).toHaveBeenCalledWith(
      LAB,
      false,
      expect.any(Object),
    );
  });

  it("never write the placeholder; nothing to save when the file is empty", async () => {
    const actions = createActions();
    actions.hasUnsavedChanges = true;
    actions.syncdb.fs.readFile = jest.fn(async () => Buffer.from(""));

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).not.toHaveBeenCalled();
    expect(actions.setToIpynb).not.toHaveBeenCalled();
    expect(actions.hasUnsavedChanges).toBe(false);
  });

  it("never write the placeholder over a partially written file", async () => {
    const actions = createActions();
    actions.hasUnsavedChanges = true;
    actions.syncdb.fs.readFile = jest.fn(async () =>
      Buffer.from(LAB_TEXT.slice(0, 30)),
    );

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).not.toHaveBeenCalled();
  });

  it("save real content", async () => {
    const actions = createActions({ cells: [{ ...ALPHA, input: "y = 2" }] });
    actions.hasUnsavedChanges = true;

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledWith(
      "Lab 3.ipynb",
      expect.anything(),
    );
  });

  it("save an edit made while the placeholder save reads an empty file", async () => {
    const actions = createActions();
    actions.hasUnsavedChanges = true;
    actions.syncdb.fs.readFile = jest.fn(async () => {
      actions.setCells([{ ...ALPHA, input: "y = 2" }]); // typed meanwhile
      actions.setVersion("v2");
      return Buffer.from("");
    });

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledTimes(1);
    expect(
      actions.syncdb.fs.jupyterSaveIpynb.mock.calls[0][1].cells[0].source,
    ).toEqual(["y = 2"]);
  });

  it("save an edit made while the placeholder save reads a file with content", async () => {
    const actions = createActions();
    actions.hasUnsavedChanges = true;
    actions.syncdb.fs.readFile = jest.fn(async () => {
      actions.setCells([{ ...ALPHA, input: "y = 2" }]); // typed meanwhile
      actions.setVersion("v2");
      return Buffer.from(LAB_TEXT);
    });

    await actions.saveIpynb();

    expect(actions.setToIpynb).not.toHaveBeenCalled();
    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledTimes(1);
    expect(
      actions.syncdb.fs.jupyterSaveIpynb.mock.calls[0][1].cells[0].source,
    ).toEqual(["y = 2"]);
  });

  it("keep an uncommitted edit made while the placeholder save reads the file", async () => {
    // The edit is in the live records but not committed, so the version is
    // unchanged.
    const actions = createActions();
    actions.hasUnsavedChanges = true;
    actions.syncdb.fs.readFile = jest.fn(async () => {
      actions.setCells([{ ...ALPHA, input: "y = 2" }]);
      actions.setUncommitted(true);
      return Buffer.from(LAB_TEXT);
    });

    await actions.saveIpynb();

    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it("save an edit made while a converted save is applied", async () => {
    const actions = createActions({ cells: [{ ...ALPHA, input: "x = 1" }] });
    actions.hasUnsavedChanges = true;
    actions.syncdb.fs.jupyterSaveIpynb = jest
      .fn()
      .mockImplementationOnce(async (_path, ipynb) => ({
        bytes: 10,
        converted: true,
        ipynb,
      }))
      .mockImplementation(async (_path, ipynb) => ({
        bytes: 10,
        converted: false,
        ipynb,
      }));
    let finish: () => void = () => {};
    actions.setToIpynb = jest.fn(() => {
      actions.setVersion("imported");
      actions.noteImportCommit();
      return new Promise<void>((resolve) => (finish = resolve));
    });

    const saving = actions.saveIpynb();
    while (actions.setToIpynb.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    actions.setVersion("v2"); // the user edits while the conversion applies
    finish();
    await saving;

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledTimes(2);
  });

  it("save a notebook whose custom notebook metadata was just removed", async () => {
    const actions = createActions({
      settings: { metadata: { nbgrader: { assignment: "lab3" } } },
    });
    actions.noteNotebookContent(); // seeded at open
    actions.setSettings({}); // the user removes the notebook metadata
    actions.hasUnsavedChanges = true;

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledTimes(1);
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it("save a clear made just before saving, before the change event records it", async () => {
    // The user cleared the only cell's input and saved at once: the debounced
    // change event that writes has_had_content has not run yet.
    const actions = createActions({ cells: [{ ...ALPHA, input: "x = 1" }] });
    actions.noteNotebookContent();
    actions.setCells([ALPHA]);
    actions.hasUnsavedChanges = true;

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledTimes(1);
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it("save an emptied notebook after every cell was deleted", async () => {
    const actions = createActions({ settings: { has_had_content: true } });
    actions.hasUnsavedChanges = true;

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

  it.each(METADATA_ONLY_WORK)(
    "keep the live notebook newer than the file when %s",
    async (_label, opts) => {
      const actions = createActions(opts as any);
      const close = prepareOpen(actions);
      close();
      actions.isClosed = jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      actions.watchLoadFromDisk = jest.fn(async () => {});

      await actions.watchIpynb();

      expect(actions.runDebug).toHaveBeenCalledWith(
        "watch.initial_load.decision",
        expect.objectContaining({ hasRtcCells: true, loadFromDisk: false }),
      );
      expect(actions.watchLoadFromDisk).not.toHaveBeenCalled();
    },
  );

  it("decide to load the file over the untouched placeholder (control)", async () => {
    const actions = createActions();
    const close = prepareOpen(actions);
    close();
    actions.isClosed = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    await actions.watchIpynb();

    expect(actions.runDebug).toHaveBeenCalledWith(
      "watch.initial_load.decision",
      expect.objectContaining({ hasRtcCells: false, loadFromDisk: true }),
    );
  });

  it("abandon the initial load on an uncommitted edit made during conversion", async () => {
    const actions = createActions();
    actions.syncdb.fs.jupyterImportIpynb = jest.fn(async (ipynb) => {
      actions.setCells([{ ...ALPHA, input: "y = 2" }]);
      actions.setUncommitted(true);
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
  function storeCells(actions, cells: object[]) {
    actions.store = {
      get: (key) =>
        key === "cells"
          ? Map(cells.map((c: any) => [c.id, fromJS(c)]))
          : undefined,
    };
  }

  it("records durably when the first change after loading deletes the only real cell", async () => {
    // Loaded with one real cell; change handling has not run yet.
    const actions = createActions({
      cells: [{ ...ALPHA, id: "c1", input: "x" }],
    });
    actions._set = jest.fn();
    actions.set_trust_notebook = jest.fn();
    actions.isClosed = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    actions.noteOpenInitPhase = jest.fn();
    actions.maybeLogFirstVisibleCell = jest.fn();
    await actions.watchIpynb(); // seeds from the loaded notebook, then exits
    storeCells(actions, []);
    actions.ensureThereIsACell();

    expect(actions._set).toHaveBeenCalledWith(
      { type: "settings", has_had_content: true },
      false,
    );
  });

  it("uses the same test as the placeholder classifier (a tagged empty cell is content)", () => {
    const actions = createActions({ cells: [{ ...ALPHA, tags: { x: true } }] });
    actions._set = jest.fn();
    actions.set_trust_notebook = jest.fn();
    actions.noteNotebookContent();
    storeCells(actions, []);
    actions.ensureThereIsACell();

    expect(actions._set).toHaveBeenCalledWith(
      { type: "settings", has_had_content: true },
      false,
    );
  });

  it("does not mark a notebook that was empty from the start", () => {
    const actions = createActions({ cells: [] });
    actions._set = jest.fn();
    actions.set_trust_notebook = jest.fn();
    actions.noteNotebookContent();
    storeCells(actions, []);
    actions.ensureThereIsACell();
    storeCells(actions, [ALPHA]);
    actions.ensureThereIsACell();

    expect(actions._set).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "settings" }),
      expect.anything(),
    );
  });

  it("records durably when the generated cell is cleared back to empty after having content", () => {
    const actions = createActions({ cells: [{ ...ALPHA, input: "x = 1" }] });
    // Use the real _set, so the write must reach syncdb and be committed.
    const order: string[] = [];
    actions.syncdb.set = jest.fn((obj) => order.push(`set:${obj.type}`));
    actions.syncdb.commit = jest.fn(() => order.push("commit"));
    actions._syncdb_change = jest.fn();
    actions.noteNotebookContent();
    actions.setCells([ALPHA]);
    storeCells(actions, [ALPHA]);
    actions.ensureThereIsACell();

    expect(actions.syncdb.set).toHaveBeenCalledWith({
      type: "settings",
      has_had_content: true,
    });
    expect(order).toEqual(["set:settings", "commit"]);
  });

  it("does not rewrite the flag once it is set", () => {
    const actions = createActions({ cells: [{ ...ALPHA, input: "x = 1" }] });
    actions._set = jest.fn();
    actions.noteNotebookContent();
    actions.setCells([ALPHA]);
    actions.setSettings({ has_had_content: true });
    storeCells(actions, [ALPHA]);
    actions.ensureThereIsACell();

    expect(actions._set).not.toHaveBeenCalled();
  });

  it("records durably when a file loaded on a file event is then emptied", async () => {
    const actions = createActions(); // the placeholder
    actions._set = jest.fn();
    actions.set_trust_notebook = jest.fn();
    actions.setToIpynb = jest.fn(async () => {
      actions.setCells([
        { type: "cell", id: "m1", input: "### Lab 3", cell_type: "markdown" },
      ]);
    });
    await actions.watchLoadFromDisk({ diskRead: LAB_READ });
    expect(actions.setToIpynb).toHaveBeenCalled();

    actions.setCells([]);
    storeCells(actions, []);
    actions.ensureThereIsACell();

    expect(actions._set).toHaveBeenCalledWith(
      { type: "settings", has_had_content: true },
      false,
    );
  });
});

describe("watcher hand-off", () => {
  it("rechecks the file once the watcher exists, so content written after the initial read is not missed", async () => {
    const actions = createActions();
    let closed = false;
    actions.isClosed = jest.fn(() => closed);
    actions.noteOpenInitPhase = jest.fn();
    actions.maybeLogFirstVisibleCell = jest.fn();
    actions.maybeLogOpenInitSummary = jest.fn();
    actions.initKernel = jest.fn();
    actions.signalIfFileDeleted = jest.fn(async () => {});
    actions.syncdb.on = jest.fn();
    // The initial read sees an empty file ...
    actions.syncdb.fs.readFile = jest.fn(async () => Buffer.from(""));
    actions.syncdb.fs.stat = jest.fn(async () => ({ mtimeMs: 3000 }));
    // ... and the copy finishes as the watcher is being established, which
    // produces no event for it.
    actions.syncdb.fs.watch = jest.fn(async () => {
      actions.syncdb.fs.readFile = jest.fn(async () => Buffer.from(LAB_TEXT));
      return {
        close: jest.fn(),
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              closed = true;
              return { done: false, value: { event: "change" } };
            },
          };
        },
      };
    });

    await actions.watchIpynb();

    expect(actions.setToIpynb).toHaveBeenCalledWith(
      LAB,
      false,
      expect.any(Object),
    );
  });
});

describe("applying a loaded file", () => {
  // setToIpynb commits the file, then awaits the RTC save; edits are allowed
  // meanwhile and are not in the file.
  function deferredSetToIpynb(actions) {
    let finish: () => void = () => {};
    actions.setToIpynb = jest.fn(() => {
      actions.setVersion("imported");
      actions.noteImportCommit();
      return new Promise<void>((resolve) => (finish = resolve));
    });
    return () => finish();
  }

  it("keep an edit made while the file is applied unsaved, and save it", async () => {
    const actions = createActions();
    actions.saveIpynb = jest.fn(async () => {});
    const finish = deferredSetToIpynb(actions);

    const loading = actions.loadFromDisk({
      diskRead: LAB_READ,
      expectedRtcVersion: "v1",
      replacingPlaceholder: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions.setToIpynb).toHaveBeenCalledWith(
      LAB,
      false,
      expect.any(Object),
    );
    actions.setVersion("v2"); // the user edits the loaded lab
    actions.hasUnsavedChanges = true;
    finish();
    await loading;

    expect(actions.hasUnsavedChanges).toBe(true);
    expect(actions.saveIpynb).toHaveBeenCalledTimes(1);
  });

  it("save a clear made while the loaded file is applied", async () => {
    const actions = createActions();
    actions.saveIpynb = jest.fn(async () => {});
    let finish: () => void = () => {};
    actions.setToIpynb = jest.fn(() => {
      actions.setCells([{ ...ALPHA, input: "### Lab 3" }]); // the import commits
      actions.setVersion("imported");
      actions.noteImportCommit();
      return new Promise<void>((resolve) => (finish = resolve));
    });

    const loading = actions.loadFromDisk({
      diskRead: LAB_READ,
      expectedRtcVersion: "v1",
      replacingPlaceholder: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    actions.setCells([ALPHA]); // a collaborator clears the lab meanwhile
    actions.setVersion("v2");
    finish();
    await loading;

    expect(actions.saveIpynb).toHaveBeenCalledTimes(1);
    // The clear is real work, not the generated placeholder.
    expect(actions.rtcIsGeneratedPlaceholder()).toBe(false);
  });

  it("mark the notebook saved when nothing changed while applying", async () => {
    const actions = createActions();
    actions.saveIpynb = jest.fn(async () => {});
    const finish = deferredSetToIpynb(actions);

    const loading = actions.loadFromDisk({
      diskRead: LAB_READ,
      expectedRtcVersion: "v1",
      replacingPlaceholder: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    actions.hasUnsavedChanges = true; // the import's own change event
    finish();
    await loading;

    expect(actions.hasUnsavedChanges).toBe(false);
    expect(actions.saveIpynb).not.toHaveBeenCalled();
  });
});
