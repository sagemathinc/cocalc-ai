/*
reconstruct(): the recovery child's work, in-process (the runner tests run it
in a real child process).
*/

import { DataEncoding, encode } from "@cocalc/conat/core/codec";
import type { JobRecord } from "@cocalc/conat/board-recovery/frame";
import { legacyPatchId } from "@cocalc/sync/patchflow";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
} from "@cocalc/util/board/names";
import { reconstruct } from "./recovery-child";

const empty = () => from_str("", BOARD_PRIMARY_KEYS, BOARD_STRING_COLS);
const id = (n: number) => legacyPatchId(1_700_000_000_000 + n);

// A patch record, as SyncDoc stores it, taking the document from `from` to
// `to`.
function record(n: number, parents: number[], from: any, to: any): any {
  return {
    time: id(n),
    wall: 1_700_000_000_000 + n,
    user_id: 0,
    parents: parents.map(id),
    patch: JSON.stringify(from.make_patch(to)),
    is_snapshot: false,
  };
}

const stored = (records: any[]): JobRecord[] =>
  records.map((mesg) => ({
    encoding: DataEncoding.MsgPack,
    raw: encode({ encoding: DataEncoding.MsgPack, mesg }),
  }));

const item = (key: string, text: string) => ({
  type: "item",
  page: "p",
  id: key,
  text,
});

test("a clean chain: its value, as the live document has it", () => {
  const d0 = empty();
  const d1 = d0.set({ type: "doc", page: "", id: "", title: "Plan" });
  const d2 = d1.set(item("a", "hello"));
  const d3 = d2.set(item("a", "hello world"));
  const out = reconstruct(
    stored([
      record(0, [], d0, d1),
      record(1, [0], d1, d2),
      record(2, [1], d2, d3),
    ]),
  );
  expect(out).toEqual({
    verdict: "clean",
    value: d3.to_str(),
    identifiers: [id(0), id(1), id(2)].sort(),
  });
});

test("branches: non-linear, with both branches' changes merged", () => {
  const d0 = empty();
  const d1 = d0.set({ type: "doc", page: "", id: "", title: "Plan" });
  const left = d1.set(item("x", "left"));
  const right = d1.set(item("y", "right"));
  const out = reconstruct(
    stored([
      record(0, [], d0, d1),
      record(1, [0], d1, left),
      record(2, [0], d1, right),
    ]),
  );
  expect(out.verdict).toBe("non-linear");
  expect(out.value).toContain('"left"');
  expect(out.value).toContain('"right"');
});

test("a missing parent: incomplete, and no value", () => {
  const d0 = empty();
  const d1 = d0.set(item("a", "x"));
  const out = reconstruct(
    stored([record(0, [], d0, d1), record(2, [1], d1, d1.set(item("b", "y")))]),
  );
  expect(out).toMatchObject({ verdict: "incomplete", value: null });
});

test("a record that isn't a board patch, or doesn't decode: invalid, and no value", () => {
  const d0 = empty();
  const d1 = d0.set(item("a", "x"));
  const good = stored([record(0, [], d0, d1)]);
  expect(reconstruct([...good, ...stored([{ time: "bad id!" }])])).toEqual({
    verdict: "invalid",
    value: null,
    identifiers: [],
  });
  expect(
    reconstruct([
      ...good,
      { encoding: DataEncoding.MsgPack, raw: Uint8Array.from([0xc1]) },
    ]),
  ).toMatchObject({ verdict: "invalid", value: null });
  expect(
    reconstruct([...good, { encoding: 7, raw: new Uint8Array(1) }]),
  ).toMatchObject({ verdict: "invalid" });
});

test("G1's depth contract: a record 33 deep is invalid, 32 is read", () => {
  const d0 = empty();
  const d1 = d0.set(item("a", "x"));
  const meta = (depth: number) => {
    let m: any = 1;
    for (let i = 0; i < depth - 1; i++) m = { m };
    return m;
  };
  const at = (depth: number) =>
    reconstruct(stored([{ ...record(0, [], d0, d1), meta: meta(depth) }]));
  expect(at(32).verdict).toBe("clean");
  expect(at(33)).toMatchObject({ verdict: "invalid", value: null });
});

test("astra's eight branches over one head: non-linear, never clean", () => {
  const d0 = empty();
  const d1 = d0.set({ type: "doc", page: "", id: "", title: "Plan" });
  const records = [record(0, [], d0, d1)];
  const branches: number[] = [];
  for (let b = 1; b <= 8; b++) {
    records.push(record(b, [0], d1, d1.set(item(`b${b}`, `branch ${b}`))));
    branches.push(b);
  }
  // One merge of all of them: a single head.
  records.push({ ...record(9, branches, d1, d1), patch: "[]" });
  const out = reconstruct(stored(records));
  expect(out.verdict).toBe("non-linear");
  for (let b = 1; b <= 8; b++) expect(out.value).toContain(`branch ${b}`);
});
