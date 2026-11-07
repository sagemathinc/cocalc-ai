/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, Map } from "immutable";

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

describe("JupyterActions run cell lifecycle overlay", () => {
  it("keeps lifecycle state until authoritative completion catches up", () => {
    const actions: any = new JupyterActions("run-overlay-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    let state = fromJS({
      cells: {
        c1: { id: "c1", cell_type: "code", input: "sleep(15)" },
      },
      runCellOverlays: {},
    });
    const updateState = (patch: object) => {
      state = state.merge(patch);
    };
    actions._state = "ready";
    actions.store = {
      emit: jest.fn(),
      get: (key: string) => state.get(key),
      getIn: (path: string[]) => state.getIn(path),
      setState: updateState,
    };
    actions.setState = updateState;

    const handler = actions.getOutputHandler({
      id: "c1",
      cell_type: "code",
      input: "sleep(15)",
    });
    handler.process({ msg_type: "cell_start" });

    const running = state.getIn(["runCellOverlays", "c1"]);
    expect(running.get("state")).toBe("busy");
    expect(running.get("start")).toEqual(expect.any(Number));
    expect(running.get("end")).toBeNull();

    // A sync-document write without runtime fields must not clear the active
    // overlay while the project runtime update is still propagating.
    actions.reconcileRunCellOverlay(
      "c1",
      Map({ id: "c1", exec_count: 1, output: null }),
    );
    expect(state.getIn(["runCellOverlays", "c1", "state"])).toBe("busy");

    handler.process({ msg_type: "cell_done" });
    const completed = state.getIn(["runCellOverlays", "c1"]);
    expect(completed.get("state")).toBe("done");

    actions.reconcileRunCellOverlay(
      "c1",
      Map({
        id: "c1",
        state: "done",
        start: completed.get("start") + 1,
        end: completed.get("end") + 1,
        exec_count: 1,
        output: null,
      }),
    );
    expect(state.getIn(["runCellOverlays", "c1"])).toBeUndefined();
  });
});
