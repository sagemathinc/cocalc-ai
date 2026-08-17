/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { NotebookFrameActions } from "./actions";

describe("NotebookFrameActions lifecycle", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("ignores cell callbacks retained after frame teardown", () => {
    const target = {
      is_closed: () => true,
      jupyter_actions: undefined,
      store: undefined,
    } as any;

    expect(() => {
      NotebookFrameActions.prototype.set_cur_id.call(target, "cell-id");
      NotebookFrameActions.prototype.activate_cell.call(target, "cell-id", {
        mode: "edit",
      });
      expect(
        NotebookFrameActions.prototype.get_cell_by_id.call(target, "cell-id"),
      ).toBeUndefined();
    }).not.toThrow();
  });

  it("moves DOM focus back to the notebook in command mode", () => {
    const focus = jest.fn();
    const target = {
      cell_list_div: {
        get: () => ({ focus }),
      },
      enable_key_handler: jest.fn(),
      jupyter_actions: {
        store: {
          get: jest.fn(),
        },
      },
      setState: jest.fn(),
    } as any;

    NotebookFrameActions.prototype.set_mode.call(target, "escape");

    expect(target.setState).toHaveBeenCalledWith({ mode: "escape" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("stores the cell list without requiring global jQuery", () => {
    delete (globalThis as { $?: unknown }).$;
    const target = {} as any;
    const node = document.createElement("div");

    NotebookFrameActions.prototype.set_cell_list_div.call(target, node);

    expect(target.cell_list_div.get(0)).toBe(node);
  });

  it.each(["undo", "redo"] as const)(
    "routes %s through the lifecycle-aware Jupyter action",
    (operation) => {
      jest.useFakeTimers();
      const invoke = jest.fn(() => false);
      let cells;
      const frameTreeActions = {
        jupyter_actions: {
          store: {
            get: jest.fn(() => cells),
            on: jest.fn(),
          },
          [operation]: invoke,
        },
        _get_frame_data: jest.fn((_id, _key, fallback) => fallback),
        set_frame_data: jest.fn(),
      } as any;
      const actions = new NotebookFrameActions(frameTreeActions, "frame-id");
      cells = {};
      const focusFirstChangedCell = jest.fn();
      (actions as any).focusFirstChangedCell = focusFirstChangedCell;

      actions[operation]();
      jest.runAllTimers();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(focusFirstChangedCell).not.toHaveBeenCalled();
    },
  );
});
