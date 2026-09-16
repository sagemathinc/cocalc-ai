/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { damerauLevenshtein, fuzzyFindWord, typoLimit } from "./fuzzy";

describe("damerauLevenshtein", () => {
  it("counts insert, delete, substitute and adjacent swap as one edit each", () => {
    expect(damerauLevenshtein("", "")).toBe(0);
    expect(damerauLevenshtein("abc", "abc")).toBe(0);
    expect(damerauLevenshtein("abc", "")).toBe(3);
    expect(damerauLevenshtein("rnw", "rwn")).toBe(1); // swap
    expect(damerauLevenshtein("spect", "specct")).toBe(1); // insert
    expect(damerauLevenshtein("notes", "ntes")).toBe(1); // delete
    expect(damerauLevenshtein("notes", "nates")).toBe(1); // substitute
    expect(damerauLevenshtein("appearance", "apperaance")).toBe(1);
    expect(damerauLevenshtein("other", "notes")).toBeGreaterThan(1);
  });
});

describe("fuzzyFindWord", () => {
  it("allows one typo, two in long terms", () => {
    expect(typoLimit("rwn")).toBe(1);
    expect(typoLimit("appearance")).toBe(2);
    expect(fuzzyFindWord("rwn", "rnw.rnw")).toEqual({
      index: 0,
      length: 3,
      cost: 1,
    });
    expect(fuzzyFindWord("apperaance", "appearance")?.cost).toBe(1);
    expect(fuzzyFindWord("apearnce", "appearance")?.cost).toBe(2);
    expect(fuzzyFindWord("apearnc", "appearance")).toBeUndefined();
  });
  it("matches a prefix of a longer word, including an extra typed character", () => {
    expect(fuzzyFindWord("specct", "spectral.ipynb")).toEqual({
      index: 0,
      length: 5,
      cost: 1,
    });
    expect(fuzzyFindWord("chatper", "chapter2")).toEqual({
      index: 0,
      length: 7,
      cost: 1,
    });
    expect(fuzzyFindWord("notes", "my notes2026")?.index).toBe(3);
  });
  it("anchors on the first letter and ignores tiny or huge terms", () => {
    expect(fuzzyFindWord("botes", "notes")).toBeUndefined();
    expect(fuzzyFindWord("pf", "pdf")).toBeUndefined();
    expect(fuzzyFindWord("pfd", "pdf")?.cost).toBe(1);
    expect(fuzzyFindWord("a".repeat(65), "a".repeat(65))).toBeUndefined();
  });
  it("prefers the cheapest match and the earliest on ties", () => {
    expect(fuzzyFindWord("rnw", "rwn rnw")).toEqual({
      index: 4,
      length: 3,
      cost: 0,
    });
    expect(fuzzyFindWord("rwn", "rnw rnw")?.index).toBe(0);
  });
});
