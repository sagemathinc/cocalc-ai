/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { checked_three_way_merge, merge_prefer_local } from "./dmp";

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

describe("merge_prefer_local", () => {
  const merge = (base: string, local: string, remote: string) =>
    merge_prefer_local({ base, local, remote });

  test("applies non-overlapping edits from both sides", () => {
    expect(merge("a b c", "A b c", "a b C")).toBe("A b C");
  });

  test("applies an edit made on both sides once", () => {
    expect(merge("x\nold\ny\n", "x\ny\n", "x\ny\n")).toBe("x\ny\n");
    const block = "| t | u |\n| - | - |\n| 1 | 2 |\n";
    expect(merge("a\n\nb\n", `a\n\n${block}\nb\n`, `a\n\n${block}\nb\n`)).toBe(
      `a\n\n${block}\nb\n`,
    );
  });

  test("does not duplicate a block both sides added after a stale base", () => {
    const block = "| t | u |\n| - | - |\n| 1 | 2 |\n";
    const base = "intro\n\nend\n";
    const local = `intro\n\n${block}\n- item one\n\nend\n`;
    const remote = `intro\n\n${block}\n- item one\n\nend\nremote\n`;
    expect(merge(base, local, remote).split("| t | u |").length - 1).toBe(1);
    expect(merge(base, local, remote)).toContain("remote");
  });

  test("keeps a local replacement of text the remote deleted", () => {
    // Found by the collaborative editing fuzzer: a character-level merge kept
    // only fragments of the local insertion.
    expect(
      merge(
        "- - nested tka1q\nrest\n",
        "- - nested \n  tkc9q \nrest\n",
        "- - nested \nrest\n",
      ),
    ).toBe("- - nested \n  tkc9q \nrest\n");
  });

  test("never relocates a deletion onto similar text", () => {
    const base =
      "intro\n\n- - tke1q nested\n- tke2q flat\n\nmiddle\n\n- - tke10q nested\n- tke11q flat\n";
    const local = base.replace("tke1q", "");
    const remote = base.replace("- - tke1q", "- tke1q");
    expect(merge(base, local, remote)).toContain("tke10q");
  });

  test("keeps edits to different words of the same line from both sides", () => {
    expect(
      merge(
        "A long paragraph line about the plan.\n",
        "A long paragraph line about the new plan.\n",
        "A really long paragraph line about the plan.\n",
      ),
    ).toBe("A really long paragraph line about the new plan.\n");
  });

  test("keeps both concurrent insertions at the same position, local first", () => {
    expect(merge("a\n", "a\nlocal\n", "a\nremote\n")).toBe(
      "a\nlocal\nremote\n",
    );
  });

  test("prefers local where edits overlap", () => {
    expect(merge("the cat sat", "the dog sat", "the cow sat")).toBe(
      "the dog sat",
    );
  });
});
