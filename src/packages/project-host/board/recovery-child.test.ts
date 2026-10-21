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
import { reconstruct, runChild } from "./recovery-child";

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

describe("astra CORR-DFC-2: the child accepts its job only at a clean end of input", () => {
  const { PassThrough } = require("node:stream");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { encodeFrame } = require("@cocalc/conat/board-recovery/frame");
  const jobId = "b".repeat(32);

  function paths() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-child-"));
    const leaf = path.join(root, "cocalc-board-recovery", `job-${jobId}`);
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(path.join(leaf, "memory.max"), "1073741824");
    fs.writeFileSync(path.join(leaf, "memory.swap.max"), "0");
    fs.writeFileSync(
      path.join(root, "status"),
      "Uid:\t5\t5\t5\t5\nGid:\t5\t5\t5\t5\nGroups:\t\nNoNewPrivs:\t1\nCapPrm:\t0\nCapEff:\t0\n",
    );
    fs.writeFileSync(
      path.join(root, "cgroup"),
      `0::/cocalc-board-recovery/job-${jobId}\n`,
    );
    return {
      status: path.join(root, "status"),
      cgroup: path.join(root, "cgroup"),
      fdDir: "/proc/self/fd",
      cgroupRoot: root,
    };
  }
  const job = () =>
    Buffer.from(
      encodeFrame({
        v: 1,
        type: "job",
        job_id: jobId,
        kind: "reconstruct",
        records: [],
      }),
    );

  function start() {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Buffer[] = [];
    output.on("data", (b: Buffer) => frames.push(b));
    const done = runChild({ input, output, paths: paths() });
    return { input, done, frames };
  }

  test("a valid job then EOF: exit 0, with a result", async () => {
    const { input, done, frames } = start();
    input.end(job());
    expect(await done).toBe(0);
    expect(Buffer.concat(frames).byteLength).toBeGreaterThan(0);
  });

  test("a trailing byte in the job's own chunk: refused, no result", async () => {
    const { input, done, frames } = start();
    const hello = Buffer.concat(frames).byteLength;
    input.end(Buffer.concat([job(), Buffer.from([0])]));
    await expect(done).rejects.toThrow(/after the last frame/);
    expect(Buffer.concat(frames).byteLength).toBe(hello);
  });

  test("a trailing byte in a later chunk: refused", async () => {
    const { input, done } = start();
    input.write(job());
    input.end(Buffer.from([0]));
    await expect(done).rejects.toThrow(/after the last frame/);
  });

  test("a job but no EOF: nothing is done", async () => {
    const { input, done } = start();
    input.write(job());
    const settled = await Promise.race([
      done.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
    expect(settled).toBe("pending");
    input.end();
    expect(await done).toBe(0);
  });

  test("EOF inside a frame, or before any: refused", async () => {
    const half = start();
    half.input.end(job().subarray(0, 6));
    await expect(half.done).rejects.toThrow(/no complete job before EOF/);
    const none = start();
    none.input.end();
    await expect(none.done).rejects.toThrow(/no complete job before EOF/);
  });
});
