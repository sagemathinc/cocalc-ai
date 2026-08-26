/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";

import { get_leaf_ids, get_visible_leaf_ids } from "./tree-ops";
import type { ImmutableFrameTree } from "./types";

function tree(obj: any): ImmutableFrameTree {
  return fromJS(obj) as ImmutableFrameTree;
}

const SPLIT = tree({
  id: "root",
  type: "node",
  direction: "col",
  children: [
    { id: "cm", type: "cm" },
    { id: "out", type: "output" },
  ],
});

const TABBED = tree({
  id: "root",
  type: "tabs",
  activeTab: 0,
  children: [
    { id: "cm", type: "cm" },
    { id: "out", type: "output" },
  ],
});

describe("get_visible_leaf_ids", () => {
  it("returns every leaf of a plain split", () => {
    expect(get_visible_leaf_ids(SPLIT)).toEqual({ cm: true, out: true });
  });

  it("supports the legacy binary first/second layout", () => {
    const legacy = tree({
      type: "node",
      direction: "col",
      first: { id: "cm", type: "cm" },
      second: { id: "out", type: "output" },
    });
    expect(get_visible_leaf_ids(legacy)).toEqual({ cm: true, out: true });
  });

  it("hides the siblings of a maximized frame", () => {
    expect(get_visible_leaf_ids(SPLIT, { full_id: "cm" })).toEqual({
      cm: true,
    });
  });

  it("ignores a full_id that is not in the tree", () => {
    expect(get_visible_leaf_ids(SPLIT, { full_id: "gone" })).toEqual({
      cm: true,
      out: true,
    });
  });

  it("only reports the active tab of a tabs container", () => {
    expect(get_visible_leaf_ids(TABBED)).toEqual({ cm: true });
    expect(
      get_visible_leaf_ids(TABBED.set("activeTab", 1) as ImmutableFrameTree),
    ).toEqual({ out: true });
  });

  it("lets the active frame win over the stored tab index", () => {
    expect(get_visible_leaf_ids(TABBED, { active_id: "out" })).toEqual({
      out: true,
    });
  });

  it("falls back to the first tab when activeTab is out of range", () => {
    expect(
      get_visible_leaf_ids(TABBED.set("activeTab", 7) as ImmutableFrameTree),
    ).toEqual({ cm: true });
  });

  it("differs from get_leaf_ids exactly where frames are hidden", () => {
    expect(get_leaf_ids(TABBED)).toEqual({ cm: true, out: true });
    expect(get_visible_leaf_ids(TABBED)).toEqual({ cm: true });
  });
});
