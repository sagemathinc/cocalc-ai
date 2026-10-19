/** @jest-environment jsdom */

// The single empty cell shown for an empty notebook must never win over, or
// be saved on top of, a notebook file that has content (support ticket
// 21023: students who opened a course assignment just as it was copied got a
// one-cell notebook instead of the lab).

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { JupyterActions } from "../browser-actions";
import { isPlaceholderIpynb } from "../placeholder-notebook";

const PLACEHOLDER = {
  cells: [{ cell_type: "code", source: "", outputs: [], metadata: {} }],
};
const LAB = {
  cells: [
    { cell_type: "markdown", source: ["### Lab 3"] },
    { cell_type: "code", source: ["x = 1"], outputs: [] },
  ],
};
const LAB_READ = { bytes: 1000, text: "lab", ipynb: LAB };

function createActions(rtcIpynb: object) {
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
  actions.toIpynb = jest.fn(async () => rtcIpynb);
  const cells = (rtcIpynb as any).cells ?? [];
  actions.syncdb = {
    fs: {
      jupyterImportIpynb: jest.fn(async (ipynb) => ({ ipynb })),
      jupyterSaveIpynb: jest.fn(async (_path, ipynb) => ({
        bytes: 10,
        converted: false,
        ipynb,
      })),
      readFile: jest.fn(async () => Buffer.from(JSON.stringify(LAB))),
      stat: jest.fn(async () => ({ mtimeMs: 1000 })),
    },
    get_state: () => "ready",
    get_one: () => (cells.length > 0 ? { type: "cell" } : undefined),
    get: () => ({ size: cells.length }),
    has_uncommitted_changes: () => false,
    newestVersion: () => "v1",
    last_changed: () => 2000,
  };
  return actions;
}

describe("isPlaceholderIpynb", () => {
  it("recognizes an empty notebook and the single blank cell", () => {
    expect(isPlaceholderIpynb({ cells: [] })).toBe(true);
    expect(isPlaceholderIpynb(PLACEHOLDER)).toBe(true);
    expect(isPlaceholderIpynb({ cells: [{ source: ["  \n"] }] })).toBe(true);
  });

  it("treats any content as real", () => {
    expect(isPlaceholderIpynb(LAB)).toBe(false);
    expect(isPlaceholderIpynb({ cells: [{ source: "x" }] })).toBe(false);
    expect(
      isPlaceholderIpynb({ cells: [{ source: "", outputs: [{ text: "1" }] }] }),
    ).toBe(false);
    expect(isPlaceholderIpynb({ cells: [{}, {}] })).toBe(false);
    expect(isPlaceholderIpynb(undefined)).toBe(false);
  });
});

describe("Jupyter placeholder notebook never overrides content", () => {
  it("loads a file that arrives while the open notebook is an unsaved placeholder", async () => {
    const actions = createActions(PLACEHOLDER);
    actions.hasUnsavedChanges = true;
    actions.saveIpynb = jest.fn(async () => {});

    await actions.watchLoadFromDisk({ diskRead: LAB_READ });

    expect(actions.saveIpynb).not.toHaveBeenCalled();
    expect(actions.syncdb.fs.jupyterImportIpynb).toHaveBeenCalledWith(LAB);
    expect(actions.setToIpynb).toHaveBeenCalledWith(LAB);
  });

  it("still protects unsaved real edits from a file event", async () => {
    const actions = createActions({ cells: [{ source: "y = 2" }] });
    actions.hasUnsavedChanges = true;
    actions.saveIpynb = jest.fn(async () => {});

    await actions.watchLoadFromDisk({ diskRead: LAB_READ });

    expect(actions.saveIpynb).toHaveBeenCalledTimes(1);
    expect(actions.syncdb.fs.jupyterImportIpynb).not.toHaveBeenCalled();
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it("does not save the placeholder over a file with content; loads it instead", async () => {
    const actions = createActions(PLACEHOLDER);
    actions.hasUnsavedChanges = true;

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).not.toHaveBeenCalled();
    expect(actions.setToIpynb).toHaveBeenCalledWith(LAB);
  });

  it("saves an emptied notebook when this session had content (user deleted every cell)", async () => {
    const actions = createActions(PLACEHOLDER);
    actions.rtcHadContent = true;
    actions.hasUnsavedChanges = true;

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledWith(
      "Lab 3.ipynb",
      PLACEHOLDER,
    );
  });

  it("saves the placeholder of a genuinely new notebook", async () => {
    const actions = createActions(PLACEHOLDER);
    actions.syncdb.fs.readFile = jest.fn(async () => Buffer.from(""));
    actions.hasUnsavedChanges = true;

    await actions.saveIpynb();

    expect(actions.syncdb.fs.jupyterSaveIpynb).toHaveBeenCalledTimes(1);
  });

  it("loads the file on open even though the placeholder is newer than it", async () => {
    // RTC last_changed (2000) is newer than the file's mtime (1000), which
    // used to keep the placeholder.
    const actions = createActions(PLACEHOLDER);
    let closed = false;
    actions.isClosed = jest.fn(() => closed);
    actions.noteOpenInitPhase = jest.fn();
    actions.maybeLogFirstVisibleCell = jest.fn();
    actions.watchLoadFromDisk = jest.fn(async () => {
      closed = true;
    });

    await actions.watchIpynb();

    expect(actions.watchLoadFromDisk).toHaveBeenCalledWith(
      expect.objectContaining({ initial: true }),
    );
  });

  it("keeps real live content on open when it is newer than the file", async () => {
    const actions = createActions(LAB);
    actions.isClosed = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    actions.noteOpenInitPhase = jest.fn();
    actions.maybeLogFirstVisibleCell = jest.fn();
    actions.watchLoadFromDisk = jest.fn(async () => {});

    await actions.watchIpynb();

    expect(actions.watchLoadFromDisk).not.toHaveBeenCalled();
  });
});
