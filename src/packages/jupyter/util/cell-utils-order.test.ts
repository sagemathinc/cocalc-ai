/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";
import { sorted_cell_list } from "./cell-utils";

describe("sorted_cell_list", () => {
  it("orders cells by position", () => {
    const cells = fromJS({ b: { pos: 2 }, a: { pos: 1 }, c: { pos: 3 } });
    expect(sorted_cell_list(cells as any).toJS()).toEqual(["a", "b", "c"]);
  });

  it("orders equal positions the same way on every client", () => {
    // Two clients that created first cells at once hold the same cells in
    // opposite insertion orders.
    const local = fromJS({ local: { pos: 0 }, remote: { pos: 0 } });
    const remote = fromJS({ remote: { pos: 0 }, local: { pos: 0 } });
    expect(sorted_cell_list(local as any).toJS()).toEqual(
      sorted_cell_list(remote as any).toJS(),
    );
  });
});
