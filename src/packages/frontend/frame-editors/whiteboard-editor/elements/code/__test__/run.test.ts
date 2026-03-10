import { EventEmitter } from "events";
import { fromJS, List, Map as ImmutableMap } from "immutable";

const getJupyterActions = jest.fn();

jest.mock("../actions", () => ({
  getJupyterActions: (...args) => getJupyterActions(...args),
}));

import run from "../run";

class FakeStore extends EventEmitter {
  private cells = ImmutableMap<string, any>();

  constructor(cells: Record<string, unknown>) {
    super();
    this.cells = fromJS(cells);
  }

  get(key: string) {
    if (key === "cells") {
      return this.cells;
    }
  }

  getIn(path: string[]) {
    if (path[0] === "cells") {
      return this.cells.get(path[1]);
    }
  }

  get_cell_list() {
    return List(this.cells.keySeq().toArray());
  }

  updateCell(id: string, patch: Record<string, unknown>) {
    const current = this.cells.get(id) ?? ImmutableMap();
    this.cells = this.cells.set(id, current.merge(fromJS(patch)));
  }
}

describe("whiteboard code run bridge", () => {
  beforeEach(() => {
    getJupyterActions.mockReset();
  });

  it("captures immediate run completion from the aux notebook", async () => {
    const store = new FakeStore({
      cell1: {
        id: "cell1",
        pos: 0,
        state: "idle",
        exec_count: 0,
        kernel: "python3",
      },
    });
    const save = jest.fn();
    const set = jest.fn();
    const jupyterActions = {
      store,
      clear_outputs: jest.fn(() => {
        store.updateCell("cell1", { output: undefined, end: undefined });
      }),
      set_cell_input: jest.fn((_id: string, value: string) => {
        store.updateCell("cell1", { input: value });
      }),
      runCells: jest.fn(() => {
        store.updateCell("cell1", {
          output: [
            { output_type: "execute_result", data: { "text/plain": "5" } },
          ],
          state: "done",
          exec_count: 1,
          kernel: "python3",
          start: 10,
          end: 11,
        });
        store.emit("change");
      }),
      syncdb: { save },
    };
    getJupyterActions.mockResolvedValue(jupyterActions);

    await run({
      project_id: "project-1",
      path: "test.board",
      input: "2+3",
      id: "cell1",
      set,
    });

    expect(jupyterActions.clear_outputs).toHaveBeenCalledWith(["cell1"], false);
    expect(jupyterActions.set_cell_input).toHaveBeenCalledWith(
      "cell1",
      "2+3",
      false,
    );
    expect(jupyterActions.runCells).toHaveBeenCalledWith(["cell1"]);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      output: [{ output_type: "execute_result", data: { "text/plain": "5" } }],
      runState: "done",
      execCount: 1,
      kernel: "python3",
      start: 10,
      end: 11,
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("syncs the final result after runCells resolves", async () => {
    const store = new FakeStore({
      cell1: {
        id: "cell1",
        pos: 0,
        state: "idle",
        exec_count: 0,
        kernel: "python3",
      },
    });
    const save = jest.fn();
    const set = jest.fn();
    let resolveRun!: () => void;
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const jupyterActions = {
      store,
      clear_outputs: jest.fn(),
      set_cell_input: jest.fn(),
      runCells: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRun = () => {
              store.updateCell("cell1", {
                output: [
                  {
                    output_type: "execute_result",
                    data: { "text/plain": "5" },
                  },
                ],
                state: "done",
                exec_count: 1,
                kernel: "python3",
                start: 10,
                end: 11,
              });
              resolve();
            };
            started();
          }),
      ),
      syncdb: { save },
    };
    getJupyterActions.mockResolvedValue(jupyterActions);

    const promise = run({
      project_id: "project-1",
      path: "test.board",
      input: "2+3",
      id: "cell1",
      set,
    });
    await runStarted;

    resolveRun();
    await promise;

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      output: [{ output_type: "execute_result", data: { "text/plain": "5" } }],
      runState: "done",
      execCount: 1,
      kernel: "python3",
      start: 10,
      end: 11,
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
