/*
Merging concurrent edits of notebooks (db documents) in the patch graph. See
src/.agents/harden-jupyter-collaborative-editing-plan-2026-09-30.md.

These were `test.failing` while notebooks fuzzy-applied concurrent patches in
time order: a cell deleted by one user while another edited it came back as
a ghost record without input (delete first), or the edit was silently lost
(edit first). With the db codec's merge3 the result is exact and does not
depend on patch times.
*/

import { createDbCodec, legacyPatchId, PatchGraph } from "patchflow";
import { dbMerge3 } from "../merge3";

// The notebook syncdb's keys and string columns (SYNCDB_OPTIONS in
// @cocalc/jupyter/redux/sync.ts, which depends on this package).
const options = { primaryKeys: ["type", "id"], stringCols: ["input"] };
const base = createDbCodec(options);
const codec = {
  ...base,
  merge3: dbMerge3<any>(base.fromString, base.toString, options),
};
const doc = (records: object[]) =>
  codec.fromString(records.map((r) => JSON.stringify(r)).join("\n"));
const records = (d: any) =>
  codec
    .toString(d)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

const cells = [
  { type: "cell", id: "a", pos: 0, input: "print(1)" },
  { type: "cell", id: "b", pos: 1, input: "b" },
];

// Cell "a" is changed by one user while another deletes it concurrently.
function merged(deleteFirst: boolean, edit: object) {
  const [t0, t1, t2] = [1, 2, 3].map(legacyPatchId);
  const initial = doc(cells);
  const deleted = doc([cells[1]]);
  const edited = doc([{ ...cells[0], ...edit }, cells[1]]);
  const [first, second] = deleteFirst ? [deleted, edited] : [edited, deleted];
  const graph = new PatchGraph({ codec });
  graph.add([
    {
      time: t0,
      parents: [],
      patch: codec.makePatch(codec.fromString(""), initial),
    },
    { time: t1, parents: [t0], patch: codec.makePatch(initial, first) },
    { time: t2, parents: [t0], patch: codec.makePatch(initial, second) },
  ]);
  return records(graph.value());
}

describe("notebook core merge", () => {
  for (const deleteFirst of [true, false]) {
    const order = deleteFirst ? "delete first" : "edit first";

    it(`keeps a cell whose input was edited while it was deleted (${order})`, () => {
      const a = merged(deleteFirst, { pos: 0.5, input: "print(12345)" }).find(
        (cell) => cell.id === "a",
      );
      expect(a).toEqual({
        type: "cell",
        id: "a",
        pos: 0.5,
        input: "print(12345)",
      });
    });

    it(`deletes a cell whose output was written while it was deleted (${order})`, () => {
      const result = merged(deleteFirst, { output: { 0: { text: "1" } } });
      expect(result.map((cell) => cell.id)).toEqual(["b"]);
    });
  }

  it("merges concurrent edits of one cell's input and other fields", () => {
    const [t0, t1, t2] = [1, 2, 3].map(legacyPatchId);
    const initial = doc([
      { type: "cell", id: "a", pos: 0, input: "x = 1\ny = 2\n" },
    ]);
    const left = doc([
      {
        type: "cell",
        id: "a",
        pos: 0,
        input: "x = 10\ny = 2\n",
        cell_type: "code",
      },
    ]);
    const right = doc([
      { type: "cell", id: "a", pos: 3, input: "x = 1\ny = 20\n" },
    ]);
    const graph = new PatchGraph({ codec });
    graph.add([
      {
        time: t0,
        parents: [],
        patch: codec.makePatch(codec.fromString(""), initial),
      },
      { time: t1, parents: [t0], patch: codec.makePatch(initial, left) },
      { time: t2, parents: [t0], patch: codec.makePatch(initial, right) },
    ]);
    expect(records(graph.value())).toEqual([
      {
        type: "cell",
        id: "a",
        pos: 3,
        input: "x = 10\ny = 20\n",
        cell_type: "code",
      },
    ]);
  });
});
