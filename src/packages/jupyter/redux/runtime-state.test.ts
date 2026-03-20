import {
  normalizeJupyterRuntimeCellState,
  type JupyterRuntimeCellState,
} from "./runtime-state";

describe("normalizeJupyterRuntimeCellState", () => {
  it("preserves cells that are already done", () => {
    const state: JupyterRuntimeCellState = {
      state: "done",
      start: 10,
      end: 20,
    };
    expect(normalizeJupyterRuntimeCellState(state)).toBe(state);
  });

  it("coerces stale busy state with an end time back to done", () => {
    expect(
      normalizeJupyterRuntimeCellState({
        state: "busy",
        start: 10,
        end: 20,
      }),
    ).toEqual({
      state: "done",
      start: 10,
      end: 20,
    });
  });
});
