/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, List } from "immutable";
import {
  cellRecordsAreGeneratedPlaceholder,
  ipynbTextHasContent,
  isPlaceholderIpynb,
} from "./placeholder";

const PLACEHOLDER = {
  cells: [{ cell_type: "code", source: "", outputs: [], metadata: {} }],
  metadata: { kernelspec: { name: "python3" }, language_info: {} },
  nbformat: 4,
  nbformat_minor: 5,
};
const LAB = {
  cells: [
    { cell_type: "markdown", source: ["### Lab 3"], metadata: {} },
    {
      cell_type: "code",
      source: ["x = 1"],
      outputs: [],
      metadata: {},
      execution_count: null,
    },
  ],
  metadata: { kernelspec: { name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
};

describe("isPlaceholderIpynb", () => {
  it("recognizes empty notebooks", () => {
    expect(isPlaceholderIpynb({ cells: [] })).toBe(true);
    expect(isPlaceholderIpynb(PLACEHOLDER)).toBe(true);
    expect(isPlaceholderIpynb({ cells: [{ source: ["  \n"] }] })).toBe(true);
  });

  it.each([
    ["a cell with source", { cells: [{ source: "x" }] }],
    ["a cell with output", { cells: [{ source: "", outputs: [{}] }] }],
    ["two cells", { cells: [{}, {}] }],
    ["a markdown cell", { cells: [{ cell_type: "markdown", source: "" }] }],
    [
      "nbgrader cell metadata",
      { cells: [{ source: "", metadata: { nbgrader: { grade: true } } }] },
    ],
    ["cell tags", { cells: [{ source: "", metadata: { tags: ["x"] } }] }],
    [
      "notebook metadata beyond the kernel",
      { cells: [], metadata: { nbgrader: { __altered: false } } },
    ],
    ["not a notebook", undefined],
  ])("treats %s as content", (_label, ipynb) => {
    expect(isPlaceholderIpynb(ipynb)).toBe(false);
  });
});

describe("ipynbTextHasContent", () => {
  it("is false only for empty files and empty notebooks", () => {
    expect(ipynbTextHasContent("")).toBe(false);
    expect(ipynbTextHasContent(" \n")).toBe(false);
    expect(ipynbTextHasContent(JSON.stringify(PLACEHOLDER))).toBe(false);
    expect(ipynbTextHasContent(JSON.stringify(LAB))).toBe(true);
  });

  it("fails closed on text that does not parse (a file still being written)", () => {
    expect(ipynbTextHasContent(JSON.stringify(LAB).slice(0, 40))).toBe(true);
  });
});

describe("cellRecordsAreGeneratedPlaceholder", () => {
  const ALPHA = { type: "cell", id: "alpha", pos: 0, input: "" };
  const records = (...cells: object[]) => List(cells.map((c) => fromJS(c)));

  it("recognizes the generated empty cell", () => {
    expect(cellRecordsAreGeneratedPlaceholder(records(ALPHA))).toBe(true);
    expect(
      cellRecordsAreGeneratedPlaceholder(records({ ...ALPHA, output: {} })),
    ).toBe(true);
  });

  it.each([
    ["no cells", []],
    ["two cells", [ALPHA, { ...ALPHA, id: "b" }]],
    ["another id", [{ ...ALPHA, id: "c1" }]],
    ["input", [{ ...ALPHA, input: "x" }]],
    ["markdown", [{ ...ALPHA, cell_type: "markdown" }]],
    ["output", [{ ...ALPHA, output: { 0: { text: "1" } } }]],
    ["attachments", [{ ...ALPHA, attachments: { "a.png": {} } }]],
    ["tags", [{ ...ALPHA, tags: { exercise: true } }]],
    ["a slide type", [{ ...ALPHA, slide: "slide" }]],
    ["metadata", [{ ...ALPHA, metadata: { nbgrader: {} } }]],
  ])("treats %s as content", (_label, cells) => {
    expect(
      cellRecordsAreGeneratedPlaceholder(records(...(cells as object[]))),
    ).toBe(false);
  });
});
