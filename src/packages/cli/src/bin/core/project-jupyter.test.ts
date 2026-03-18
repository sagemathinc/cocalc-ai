import assert from "node:assert/strict";
import test from "node:test";

import { parseNotebookCells, selectNotebookCells } from "./project-jupyter";

test("parseNotebookCells preserves explicit ids and marks missing ids", () => {
  const cells = parseNotebookCells(
    JSON.stringify({
      cells: [
        { id: "code-1", cell_type: "code", source: ["print(2+3)\n"] },
        { cell_type: "markdown", source: "# Title\n" },
      ],
    }),
  );

  assert.equal(cells.length, 2);
  assert.deepEqual(cells[0], {
    id: "code-1",
    index: 0,
    cell_type: "code",
    input: "print(2+3)\n",
    preview: "print(2+3)",
    line_count: 2,
    generated_id: false,
  });
  assert.equal(cells[1].id, "__missing_cell_id__:1");
  assert.equal(cells[1].generated_id, true);
});

test("selectNotebookCells supports notebook-order all-code selection", () => {
  const cells = parseNotebookCells(
    JSON.stringify({
      cells: [
        { id: "m1", cell_type: "markdown", source: "intro" },
        { id: "c1", cell_type: "code", source: "a = 5" },
        { id: "c2", cell_type: "code", source: "a + 1" },
      ],
    }),
  );

  const selected = selectNotebookCells(cells, { allCode: true });

  assert.deepEqual(
    selected.map((cell) => cell.id),
    ["c1", "c2"],
  );
});

test("selectNotebookCells rejects non-code selections", () => {
  const cells = parseNotebookCells(
    JSON.stringify({
      cells: [{ id: "m1", cell_type: "markdown", source: "intro" }],
    }),
  );

  assert.throws(
    () => selectNotebookCells(cells, { cellIds: ["m1"] }),
    /selected cells must be code cells/,
  );
});
