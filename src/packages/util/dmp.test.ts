/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { checked_three_way_merge } from "./dmp";

test("checked merge preserves independent edits", () => {
  expect(
    checked_three_way_merge({
      base: "alpha\nbeta\ngamma\n",
      local: "alpha local\nbeta\ngamma\n",
      remote: "alpha\nbeta\ngamma remote\n",
    }),
  ).toEqual({
    clean: true,
    merged: "alpha local\nbeta\ngamma remote\n",
  });
});

test("checked merge rejects overlapping replacements", () => {
  expect(
    checked_three_way_merge({
      base: "answer = 1\n",
      local: "answer = 2\n",
      remote: "answer = 3\n",
    }),
  ).toEqual({ clean: false, reason: "overlapping-edits" });
});

test("checked merge accepts the same edit from both sides once", () => {
  expect(
    checked_three_way_merge({
      base: "old\n",
      local: "new\n",
      remote: "new\n",
    }),
  ).toEqual({ clean: true, merged: "new\n" });
});

test("checked merge rejects competing insertions at one position", () => {
  expect(
    checked_three_way_merge({
      base: "ab",
      local: "a local b",
      remote: "a remote b",
    }),
  ).toEqual({ clean: false, reason: "overlapping-edits" });
});

test("checked merge preserves insertions at replacement boundaries", () => {
  expect(
    checked_three_way_merge({
      base: "ab",
      local: "aXb",
      remote: "aB",
    }),
  ).toEqual({ clean: true, merged: "aXB" });
});
