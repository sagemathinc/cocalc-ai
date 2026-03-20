import assert from "node:assert/strict";
import test from "node:test";

import {
  getUnseenJupyterLiveRunBatches,
  mapSyncDbNotebookCells,
  parseNotebookCells,
  selectJupyterLiveRunSnapshot,
  selectNotebookCells,
} from "./project-jupyter";

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

test("mapSyncDbNotebookCells orders by live notebook position", () => {
  const cells = mapSyncDbNotebookCells([
    { type: "cell", id: "c2", pos: 2, input: "b = 2" },
    { type: "cell", id: "m1", pos: 0, cell_type: "markdown", input: "# Title" },
    { type: "cell", id: "c1", pos: 1, input: "a = 1" },
  ]);

  assert.deepEqual(
    cells.map((cell) => ({
      id: cell.id,
      index: cell.index,
      cell_type: cell.cell_type,
    })),
    [
      { id: "m1", index: 0, cell_type: "markdown" },
      { id: "c1", index: 1, cell_type: "code" },
      { id: "c2", index: 2, cell_type: "code" },
    ],
  );
});

test("selectJupyterLiveRunSnapshot prefers the newest active run", () => {
  const selected = selectJupyterLiveRunSnapshot({
    path: "/home/user/demo.ipynb",
    all: {
      a: {
        path: "/home/user/demo.ipynb",
        run_id: "done-old",
        updated_at_ms: 10,
        done: true,
        batches: [],
      },
      b: {
        path: "/home/user/demo.ipynb",
        run_id: "active-new",
        updated_at_ms: 20,
        done: false,
        batches: [],
      },
      c: {
        path: "/home/user/demo.ipynb",
        run_id: "active-old",
        updated_at_ms: 15,
        done: false,
        batches: [],
      },
    },
  });

  assert.equal(selected?.run_id, "active-new");
});

test("selectJupyterLiveRunSnapshot can target a specific run id", () => {
  const selected = selectJupyterLiveRunSnapshot({
    path: "/home/user/demo.ipynb",
    runId: "run-2",
    all: {
      a: {
        path: "/home/user/demo.ipynb",
        run_id: "run-1",
        updated_at_ms: 10,
        done: false,
        batches: [],
      },
      b: {
        path: "/home/user/demo.ipynb",
        run_id: "run-2",
        updated_at_ms: 11,
        done: true,
        batches: [],
      },
    },
  });

  assert.equal(selected?.run_id, "run-2");
});

test("getUnseenJupyterLiveRunBatches returns unseen batches in seq order", () => {
  const seen = new Set<string>(["run:2"]);
  const batches = getUnseenJupyterLiveRunBatches(
    {
      path: "/home/user/demo.ipynb",
      run_id: "run",
      updated_at_ms: 1,
      done: false,
      batches: [
        {
          path: "/home/user/demo.ipynb",
          run_id: "run",
          id: "run:3",
          seq: 3,
          sent_at_ms: 30,
          mesgs: [{ msg_type: "stream" }],
        },
        {
          path: "/home/user/demo.ipynb",
          run_id: "run",
          id: "run:1",
          seq: 1,
          sent_at_ms: 10,
          mesgs: [{ msg_type: "stream" }],
        },
        {
          path: "/home/user/demo.ipynb",
          run_id: "run",
          id: "run:2",
          seq: 2,
          sent_at_ms: 20,
          mesgs: [{ msg_type: "stream" }],
        },
      ],
    },
    seen,
  );

  assert.deepEqual(
    batches.map((batch) => batch.id),
    ["run:1", "run:3"],
  );
});
