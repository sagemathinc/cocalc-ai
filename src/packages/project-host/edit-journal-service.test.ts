/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { from_str } from "@cocalc/sync/editor/db/doc";
import { make_patch } from "@cocalc/util/dmp";
import { __test__ } from "./edit-journal-service";

describe("project-host edit journal", () => {
  it("applies exact cell source patches before notebook reconciliation", () => {
    const current = from_str(
      [
        JSON.stringify({
          type: "cell",
          id: "cell-1",
          pos: 0,
          cell_type: "code",
          input: "print('old')",
          metadata: {
            nbgrader: { grade: false, solution: true },
            tags: ["concurrent"],
          },
        }),
        JSON.stringify({ type: "settings", kernel: "python3" }),
      ].join("\n"),
      ["type", "id"],
      ["input"],
    );
    const exact = make_patch("print('old')", "print('new')");
    const contents = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          id: "cell-1",
          metadata: { nbgrader: { grade: false, solution: true } },
          outputs: [],
          source: "print('new')",
        },
      ],
      metadata: { kernelspec: { name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5,
    });
    const base = JSON.stringify({
      ...JSON.parse(contents),
      cells: [
        {
          ...JSON.parse(contents).cells[0],
          source: "print('old')",
        },
      ],
    });
    const patch = __test__.notebookPatch(
      current,
      {
        path: "/home/user/a.ipynb",
        base_sha256: "base",
        journal_id: "journal",
        sequence: 1,
        contents,
        cell_patches: [{ cell_id: "cell-1", patch: exact }],
      },
      JSON.parse(base),
      JSON.parse(contents),
    );
    const updated = current.apply_patch(patch);
    const cell = updated.get_one({ type: "cell", id: "cell-1" }).toJS();

    expect(cell.input).toBe("print('new')");
    expect(cell.metadata.nbgrader).toEqual({ grade: false, solution: true });
    expect(cell.metadata.tags).toEqual(["concurrent"]);
    expect(patch.slice(0, 2)).toEqual([
      1,
      [{ type: "cell", id: "cell-1", input: exact }],
    ]);
    const exported = JSON.parse(
      __test__.notebookContents(updated, JSON.parse(contents)),
    );
    expect(exported.cells[0].source.join("")).toBe("print('new')");
    expect(exported.cells[0].metadata.nbgrader).toEqual({
      grade: false,
      solution: true,
    });
    expect(exported.cells[0].metadata.tags).toEqual(["concurrent"]);
  });

  it("hashes deterministic UTF-8 content", () => {
    expect(__test__.sha256("CoCalc")).toBe(
      "1ae7db314919409df0d6a17aa3cc72a684d911bcd069233819169e0fe8bbb83c",
    );
  });
});
