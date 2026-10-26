/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";
import { coursePathsToOmit } from "./folders-tool-bar";

describe("coursePathsToOmit", () => {
  it("omits existing items by their home-relative path", () => {
    const items = fromJS({
      a: { path: "Handouts/Handout1" },
      b: { path: "/home/user/Handouts/Handout4" },
      c: { path: "/root/Old" },
      d: { path: "Deleted", deleted: true },
      e: {},
    });
    expect([...coursePathsToOmit(items)].sort()).toEqual([
      "Handouts/Handout1",
      "Handouts/Handout4",
      "Old",
    ]);
  });
});
