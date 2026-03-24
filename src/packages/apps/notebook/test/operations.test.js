const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createNotebookSnapshot,
  insertNotebookCellAdjacent,
  setNotebookCellInput,
  deleteNotebookCells,
  normalizeNotebookCellRows,
} = require("../dist/index.js");

test("insertNotebookCellAdjacent inserts below the anchor cell", () => {
  const snapshot = createNotebookSnapshot([
    { type: "cell", id: "a", pos: 0, input: "x=1", cell_type: "code" },
    { type: "cell", id: "b", pos: 1, input: "y=2", cell_type: "code" },
  ]);
  const result = insertNotebookCellAdjacent(snapshot, {
    anchorId: "a",
    delta: 1,
    input: "z=3",
  });
  assert.equal(result.cell.input, "z=3");
  assert.deepEqual(
    result.snapshot.cells.map((cell) => cell.id),
    ["a", result.cell.id, "b"],
  );
});

test("setNotebookCellInput updates the selected cell", () => {
  const snapshot = createNotebookSnapshot([
    { type: "cell", id: "a", pos: 0, input: "x=1", cell_type: "code" },
  ]);
  const result = setNotebookCellInput(snapshot, "a", "x=2");
  assert.equal(result.snapshot.cells[0].input, "x=2");
});

test("deleteNotebookCells removes the requested ids", () => {
  const snapshot = createNotebookSnapshot([
    { type: "cell", id: "a", pos: 0, input: "x=1", cell_type: "code" },
    { type: "cell", id: "b", pos: 1, input: "y=2", cell_type: "code" },
  ]);
  const result = deleteNotebookCells(snapshot, ["a"]);
  assert.deepEqual(
    result.snapshot.cells.map((cell) => cell.id),
    ["b"],
  );
});

test("normalizeNotebookCellRows sorts rows by pos", () => {
  const cells = normalizeNotebookCellRows([
    { type: "cell", id: "b", pos: 2, input: "2" },
    { type: "cell", id: "a", pos: 1, input: "1" },
  ]);
  assert.deepEqual(
    cells.map((cell) => cell.id),
    ["a", "b"],
  );
});
