/*
Closed streams are garbage collected with the REAL write counter
(persist-write-rate) installed, as in the hub and the persist nodes.  Its
cached probe statements, held by the closures it puts on the connection,
pinned every closed stream (the bay-0 hub leak of 2026-11-19).
*/

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";

setFlagsFromString("--expose-gc");
const gc: () => void = runInNewContext("gc");

const msg = (s: string) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
});

describe("closed persist streams are collected (real write counter)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-close-leak-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const ephemeral of [true, false]) {
    it(`${ephemeral ? "ephemeral" : "disk"} streams`, async () => {
      const refs: WeakRef<object>[] = [];
      let wrappedAfterClose = 0;
      for (let i = 0; i < 50; i++) {
        const stream = pstream({ path: join(dir, `s${i}`), ephemeral });
        stream.set(msg(`m${i}`));
        const db = (stream as any).db;
        stream.close();
        if (Object.prototype.hasOwnProperty.call(db, "prepare")) {
          wrappedAfterClose += 1;
        }
        refs.push(new WeakRef(stream));
      }
      for (let i = 0; i < 10; i++) {
        gc();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // both are reported on a failure: how many were collected, and how many
      // connections kept their wrappers after close
      expect({
        collected:
          refs.filter((ref) => ref.deref() == null).length >= 45
            ? "at least 45 of 50"
            : refs.filter((ref) => ref.deref() == null).length,
        wrappedAfterClose,
      }).toEqual({ collected: "at least 45 of 50", wrappedAfterClose: 0 });
    });
  }
});
