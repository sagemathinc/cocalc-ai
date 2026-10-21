/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An empty notebook stores no cells until the user starts editing; then the
// first cell is created (support ticket 21023).

import { List } from "immutable";
import { FIRST_CELL_ID, JupyterActions } from "./actions";

function createActions(cellIds: string[]) {
  const actions: any = new JupyterActions("first-cell-test", {
    getStore: jest.fn(() => undefined),
  } as any);
  actions.store = {
    get_cell_list: () => List(cellIds),
    getIn: () => undefined,
    get: () => false,
  };
  actions._set = jest.fn();
  actions.set_trust_notebook = jest.fn();
  actions.insert_cell_adjacent = jest.fn(() => "typed");
  actions.set_cell_input = jest.fn();
  return actions;
}

describe("createFirstCell", () => {
  it("creates the first cell and trusts the notebook", () => {
    const actions = createActions([]);

    expect(actions.createFirstCell()).toBe(FIRST_CELL_ID);

    expect(actions._set).toHaveBeenCalledWith({
      type: "cell",
      id: FIRST_CELL_ID,
      pos: 0,
      input: "",
    });
    expect(actions.set_trust_notebook).toHaveBeenCalledWith(true);
  });

  it("gives typed text a cell of its own, so concurrent starts both keep theirs", () => {
    const actions = createActions([]);
    actions.new_id = jest.fn(() => "typed-1");

    expect(actions.createFirstCell("x")).toBe("typed-1");

    expect(actions._set).toHaveBeenCalledWith({
      type: "cell",
      id: "typed-1",
      pos: expect.any(Number),
      input: "x",
    });
    // Its own position near 0, so concurrent typed starts do not tie.
    const { pos } = actions._set.mock.calls[0][0];
    expect(Math.abs(pos)).toBeLessThanOrEqual(0.5);
    expect(actions.set_trust_notebook).toHaveBeenCalledWith(true);
  });

  it("does nothing when the notebook already has a cell", () => {
    const actions = createActions(["c1", "c2"]);

    expect(actions.createFirstCell()).toBe("c1");

    expect(actions._set).not.toHaveBeenCalled();
    expect(actions.insert_cell_adjacent).not.toHaveBeenCalled();
    expect(actions.set_trust_notebook).not.toHaveBeenCalled();
  });

  it("keeps typed text in a new last cell when a cell arrived first", () => {
    const actions = createActions(["c1", "c2"]);

    expect(actions.createFirstCell("x")).toBe("typed");

    expect(actions.insert_cell_adjacent).toHaveBeenCalledWith("c2", 1);
    expect(actions.set_cell_input).toHaveBeenCalledWith("typed", "x");
    expect(actions._set).not.toHaveBeenCalled();
    expect(actions.set_trust_notebook).not.toHaveBeenCalled();
  });
});

describe("insert_cell_at", () => {
  it("trusts a notebook when its first cell is inserted", () => {
    const actions = createActions([]);
    actions.insert_cell_at(0);
    expect(actions.set_trust_notebook).toHaveBeenCalledWith(true, true);
  });

  it("keeps an uncommitted first insertion uncommitted", () => {
    // e.g. the whiteboard inserts a cell with save=false before its input.
    const actions = createActions([]);
    actions.insert_cell_at(0, false, "w1");
    expect(actions.set_trust_notebook).toHaveBeenCalledWith(true, false);
  });

  it("does not change trust when inserting into a notebook with cells", () => {
    const actions = createActions(["c1"]);
    actions.insert_cell_at(1);
    expect(actions.set_trust_notebook).not.toHaveBeenCalled();
  });

  it("places the first inserted cell at 0 even without a neighbor", () => {
    // Insert above/below the missing current cell computes NaN.
    const actions = createActions([]);
    actions.insert_cell_at(NaN);
    expect(actions._set).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cell", pos: 0 }),
      true,
    );
  });
});
