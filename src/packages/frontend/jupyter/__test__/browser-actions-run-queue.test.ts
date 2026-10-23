/** @jest-environment jsdom */

import { fromJS, Set as iSet } from "immutable";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

jest.mock("@cocalc/frontend/monitoring/product-activity", () => ({
  recordProductActivity: jest.fn(),
}));

jest.mock("@cocalc/frontend/monitoring/ux-latency-trace", () => ({
  afterNextPaint: (callback: () => void) => callback(),
  UxLatencyTrace: class UxLatencyTrace {
    mark() {}
    record() {}
  },
}));

jest.mock("../widgets/frame/relay", () => ({
  WidgetRelay: class WidgetRelay {},
}));

import { JupyterActions } from "../browser-actions";

describe("JupyterActions run queue cleanup", () => {
  it("finishes an empty cell after it is queued behind another run", async () => {
    const actions: any = new JupyterActions("jupyter-run-queue-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    let state = fromJS({
      cells: {
        completed: { id: "completed", cell_type: "code", state: "done" },
        empty: { id: "empty", cell_type: "code", input: "", state: "done" },
      },
    }).set("pendingCells", iSet());
    actions.store = {
      get: (key: string) => state.get(key),
      setState: (patch: object) => {
        state = state.merge(patch);
      },
    };
    actions.runDebug = jest.fn();
    actions.set_local_runtime_cell_state = jest.fn(
      (id: string, patch: object) => {
        state = state.mergeIn(["cells", id], patch);
      },
    );
    actions._state = "ready";
    actions.project_id = "project-1";
    actions.path = "notebook.ipynb";
    actions.isClosed = jest.fn(() => false);
    actions.getProjectRuntimeState = jest.fn(() => "running");
    actions.waitUntilProjectIsRunning = jest.fn(async () => {});
    actions.ensureKernelForRun = jest.fn(async () => "python3");
    actions.clearMoreOutput = jest.fn();
    actions._set = jest.fn();
    actions.syncdb = { save: jest.fn() };

    actions.runningNow = true;
    await actions.runCells(["empty"]);

    expect(state.get("pendingCells").has("empty")).toBe(true);
    expect(state.getIn(["cells", "empty", "state"])).toBe("run");

    actions.runningNow = false;
    const [ids, opts] = actions.runQueue.shift();
    await actions.runCells(ids, opts);

    expect(state.get("pendingCells").has("empty")).toBe(false);
    expect(state.getIn(["cells", "empty", "state"])).toBe("done");
    expect(state.getIn(["cells", "completed", "state"])).toBe("done");
    expect(actions.set_local_runtime_cell_state).toHaveBeenCalledWith(
      "empty",
      expect.objectContaining({ state: "done" }),
    );
    expect(actions.set_local_runtime_cell_state).toHaveBeenCalledTimes(2);

    state = state
      .set("pendingCells", iSet(["empty"]))
      .setIn(["cells", "empty", "state"], "run");
    actions.runQueue.push([["empty"], {}]);
    actions.finishPendingCells(["empty"]);

    expect(state.get("pendingCells").has("empty")).toBe(true);
    expect(state.getIn(["cells", "empty", "state"])).toBe("run");
    expect(actions.set_local_runtime_cell_state).toHaveBeenCalledTimes(2);
  });
});
