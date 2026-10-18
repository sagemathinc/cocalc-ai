/** @jest-environment jsdom */

/*
A run this tab waits on can vanish from the ephemeral live-run store, e.g.,
when a host restart wipes it while the run's connection is lost.  It then never
reports its end, and its cells kept showing as running forever.
*/

import { Map } from "immutable";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      registerReconnectResource: jest.fn(() => ({
        requestReconnect: jest.fn(),
        close: jest.fn(),
      })),
      projectConat: jest.fn(),
    },
  },
}));

jest.mock("@cocalc/conat/project/jupyter/run-code", () => ({
  jupyterClient: jest.fn(),
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { JupyterActions } from "../browser-actions";

function makeActions({
  snapshots = {},
  backendState = "off",
  kernelState = "idle",
}: {
  snapshots?: Record<string, any>;
  backendState?: string;
  kernelState?: string;
} = {}) {
  let state = Map<string, any>({
    runCellOverlays: Map({
      c1: Map({ state: "busy", start: 1 }),
      c2: Map({ state: "busy", start: 1 }),
    }),
    // the run's output handlers also wrote its state into the cells
    cells: Map({
      c1: Map({ id: "c1", state: "busy", start: 1 }),
      c2: Map({ id: "c2", state: "busy", start: 1 }),
    }),
  });
  const actions: any = new JupyterActions("jupyter-test", {
    getStore: jest.fn(() => undefined),
    removeActions: jest.fn(),
  } as any);
  actions._state = "ready";
  actions.liveRunPath = "notebook.ipynb";
  actions.runDebug = jest.fn();
  actions.store = {
    get: (key: string) => state.get(key),
    getIn: (path: string[]) => state.getIn(path),
    setState: (obj: any) => {
      state = state.merge(obj);
    },
  };
  actions.liveRunStore = {
    getAll: () => snapshots,
    delete: jest.fn(),
  };
  actions.refreshKernelStatus = jest.fn(async () => {});
  actions.clearStaleActiveRuntimeCellState = jest.fn();
  actions.set_local_runtime_cell_state = (id: string, patch: any) => {
    state = state.setIn(
      ["cells", id],
      state.getIn(["cells", id]).merge(Map(patch)),
    );
  };
  actions.get_runtime_setting = (key: string) =>
    key === "backend_state" ? backendState : kernelState;
  const overlays = () => state.get("runCellOverlays");
  const cellState = (id: string) => state.getIn(["cells", id, "state"]);
  return { actions, overlays, cellState };
}

describe("runs whose live-run snapshot is gone", () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stop showing as running once the kernel is not running anything", async () => {
    const { actions, overlays, cellState } = makeActions();
    // a local run that lost its connection
    actions.requireLiveRunCompletionReplay("run-1", ["c1"]);
    // a run started in another tab
    actions.liveRunContexts.set("run-2", {
      cellIds: new Set(["c2"]),
      handlers: new globalThis.Map(),
      finalizeHandler: jest.fn(),
    });

    await actions.replaySharedLiveRuns();
    // just noticed missing: keep them for a grace period
    expect(overlays().has("c1")).toBe(true);
    expect(overlays().has("c2")).toBe(true);

    now += 3_000;
    await actions.replaySharedLiveRuns();
    expect(overlays().has("c1")).toBe(false);
    expect(overlays().has("c2")).toBe(false);
    expect(actions.liveRunContexts.has("run-2")).toBe(false);
    expect(cellState("c1")).toBe("done");
    expect(cellState("c2")).toBe("done");
    expect(actions.clearStaleActiveRuntimeCellState).toHaveBeenCalled();
  });

  it("keep a run whose snapshot shows up while the kernel check is pending", async () => {
    const snapshots: Record<string, any> = {};
    const { actions, overlays, cellState } = makeActions({ snapshots });
    actions.requireLiveRunCompletionReplay("run-1", ["c1"]);
    await actions.replaySharedLiveRuns();
    now += 3_000;
    let finishRefresh!: () => void;
    actions.refreshKernelStatus = jest.fn(
      () => new Promise<void>((resolve) => (finishRefresh = resolve)),
    );
    const older = actions.replaySharedLiveRuns();
    await Promise.resolve();
    expect(actions.refreshKernelStatus).toHaveBeenCalled();
    // the run's snapshot shows up meanwhile
    snapshots["notebook.ipynb\nrun-1"] = {
      path: "notebook.ipynb",
      run_id: "run-1",
      batches: [],
      updated_at_ms: now,
    };
    finishRefresh();
    await older;
    expect(overlays().has("c1")).toBe(true);
    expect(cellState("c1")).toBe("busy");
    expect(actions.hasCompletedLiveRunId("run-1")).toBe(false);
  });

  it("keep showing as running while the kernel is busy", async () => {
    const { actions, overlays } = makeActions({
      backendState: "running",
      kernelState: "busy",
    });
    actions.requireLiveRunCompletionReplay("run-1", ["c1"]);
    await actions.replaySharedLiveRuns();
    now += 10_000;
    await actions.replaySharedLiveRuns();
    expect(overlays().has("c1")).toBe(true);
    expect(actions.refreshKernelStatus).toHaveBeenCalled();
  });

  it("keep showing as running while the snapshot is still there", async () => {
    const { actions, overlays } = makeActions({
      snapshots: {
        "notebook.ipynb\nrun-1": {
          path: "notebook.ipynb",
          run_id: "run-1",
          batches: [],
          updated_at_ms: now,
        },
      },
    });
    actions.requireLiveRunCompletionReplay("run-1", ["c1"]);
    await actions.replaySharedLiveRuns();
    now += 10_000;
    // fresh enough not to be deleted as stale
    actions.liveRunStore.getAll()["notebook.ipynb\nrun-1"].updated_at_ms = now;
    await actions.replaySharedLiveRuns();
    expect(overlays().has("c1")).toBe(true);
  });
});
