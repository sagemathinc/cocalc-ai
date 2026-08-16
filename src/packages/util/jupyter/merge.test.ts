/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { checked_notebook_three_way_merge } from "./merge";

function notebook(cells: any[], metadata: Record<string, unknown> = {}) {
  return { cells, metadata, nbformat: 4, nbformat_minor: 5 };
}

function cell(id: string, source: string, extra: Record<string, unknown> = {}) {
  return {
    cell_type: "code",
    execution_count: null,
    id,
    metadata: {},
    outputs: [],
    source,
    ...extra,
  };
}

test("merges changes to independent notebook cells", () => {
  const base = notebook([cell("a", "a = 1"), cell("b", "b = 1")]);
  const local = notebook([cell("a", "a = 2"), cell("b", "b = 1")]);
  const remote = notebook([cell("a", "a = 1"), cell("b", "b = 2")]);

  expect(checked_notebook_three_way_merge({ base, local, remote })).toEqual({
    clean: true,
    dirty: true,
    merged: notebook([cell("a", "a = 2"), cell("b", "b = 2")]),
  });
});

test("merges local source with remote output in the same cell", () => {
  const base = notebook([cell("a", "print(1)")]);
  const local = notebook([cell("a", "print(2)")]);
  const remote = notebook([
    cell("a", "print(1)", {
      execution_count: 1,
      outputs: [{ output_type: "stream", text: "1\n" }],
    }),
  ]);

  const result = checked_notebook_three_way_merge({ base, local, remote });
  expect(result.clean).toBe(true);
  if (result.clean) {
    expect(result.merged.cells[0]).toMatchObject({
      execution_count: 1,
      source: "print(2)",
      outputs: [{ output_type: "stream", text: "1\n" }],
    });
  }
});

test("rejects concurrent source edits in one cell", () => {
  const base = notebook([cell("a", "value = 1")]);
  const local = notebook([cell("a", "value = 2")]);
  const remote = notebook([cell("a", "value = 3")]);

  expect(checked_notebook_three_way_merge({ base, local, remote })).toEqual({
    clean: false,
    reason: "overlapping-cell-change",
  });
});

test("merges independent nested notebook metadata", () => {
  const base = notebook([cell("a", "1")], {
    language_info: { name: "python" },
  });
  const local = notebook([cell("a", "1")], {
    language_info: { name: "python", version: "3.12" },
  });
  const remote = notebook([cell("a", "1")], {
    kernelspec: { name: "python3" },
    language_info: { name: "python" },
  });

  const result = checked_notebook_three_way_merge({ base, local, remote });
  expect(result.clean).toBe(true);
  if (result.clean) {
    expect(result.merged.metadata).toEqual({
      kernelspec: { name: "python3" },
      language_info: { name: "python", version: "3.12" },
    });
  }
});

test("merges independent cell insertion and editing", () => {
  const base = notebook([cell("a", "a"), cell("b", "b")]);
  const local = notebook([cell("a", "a"), cell("x", "x"), cell("b", "b")]);
  const remote = notebook([cell("a", "A"), cell("b", "b")]);

  const result = checked_notebook_three_way_merge({ base, local, remote });
  expect(result.clean).toBe(true);
  if (result.clean) {
    expect(result.merged.cells.map(({ id }) => id)).toEqual(["a", "x", "b"]);
    expect(result.merged.cells[0].source).toBe("A");
  }
});

test("rejects deleting a cell modified by the other side", () => {
  const base = notebook([cell("a", "a")]);
  const local = notebook([]);
  const remote = notebook([cell("a", "A")]);

  expect(checked_notebook_three_way_merge({ base, local, remote })).toEqual({
    clean: false,
    reason: "overlapping-cell-change",
  });
});

test("requires stable cell ids", () => {
  const base = notebook([{ cell_type: "code", source: "1" }]);
  expect(
    checked_notebook_three_way_merge({ base, local: base, remote: base }),
  ).toEqual({ clean: false, reason: "missing-cell-id" });
});
