/*
Known limitations of the core merge for notebooks, found while planning
src/.agents/harden-jupyter-collaborative-editing-plan-2026-09-30.md.
These are `test.failing` so they start passing (and must be flipped) once
db documents get exact three-way merges.
*/

import { createDbCodec, legacyPatchId, PatchGraph } from "patchflow";

// The notebook syncdb's keys and string columns (SYNCDB_OPTIONS in
// @cocalc/jupyter/redux/sync.ts, which depends on this package).
const codec = createDbCodec({
  primaryKeys: ["type", "id"],
  stringCols: ["input"],
});
const doc = (records: object[]) =>
  codec.fromString(records.map((r) => JSON.stringify(r)).join("\n"));
const records = (d: any) =>
  codec
    .toString(d)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

// Cell "a" is deleted by one user while another edits it concurrently.
function merged(deleteFirst: boolean) {
  const [t0, t1, t2] = [1, 2, 3].map(legacyPatchId);
  const base = doc([
    { type: "cell", id: "a", pos: 0, input: "print(1)" },
    { type: "cell", id: "b", pos: 1, input: "b" },
  ]);
  const deleted = doc([{ type: "cell", id: "b", pos: 1, input: "b" }]);
  const edited = doc([
    { type: "cell", id: "a", pos: 0.5, input: "print(12345)" },
    { type: "cell", id: "b", pos: 1, input: "b" },
  ]);
  const [first, second] = deleteFirst ? [deleted, edited] : [edited, deleted];
  const graph = new PatchGraph({ codec });
  graph.add([
    {
      time: t0,
      parents: [],
      patch: codec.makePatch(codec.fromString(""), base),
    },
    { time: t1, parents: [t0], patch: codec.makePatch(base, first) },
    { time: t2, parents: [t0], patch: codec.makePatch(base, second) },
  ]);
  return records(graph.value());
}

describe("notebook core merge limitations", () => {
  test.failing("a concurrent delete and edit never leaves a ghost cell", () => {
    // Today: {type: "cell", id: "a", pos: 0.5}, with no input.
    for (const cell of merged(true)) {
      expect(typeof cell.input).toBe("string");
    }
  });

  test.failing("a concurrent delete does not silently drop an edit", () => {
    // Today the delete wins when it is the later patch.
    const a = merged(false).find((cell) => cell.id === "a");
    expect(a?.input).toBe("print(12345)");
  });
});
