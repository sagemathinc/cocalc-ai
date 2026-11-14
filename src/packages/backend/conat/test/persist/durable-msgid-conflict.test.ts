/*
Finding 087 (B-2 item): a msgID already used -- stored, or earlier in the
same batch -- is answered as a duplicate only for the SAME write.  A
different body under it is refused with `msgid-conflict` (not retryable):
nothing is stored, nothing is emitted, and a bounded log line and counter
record it.

Compared: raw, encoding, headers, key, ttl and checkpoint against the stored
message; for a duplicate in the same batch also previousSeq (a committed
message does not store its previousSeq, a precondition of its first commit).
*/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  getPersistentStreamDiagnostics,
  sameWriteOperation,
} from "@cocalc/conat/persist/storage";

const msg = (s: string, extra: object = {}) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
  ...extra,
});

function snapshot(stream) {
  const db = (stream as any).db;
  return {
    messages: db
      .prepare("SELECT seq, key, headers, encoding, ttl, raw FROM messages ORDER BY seq")
      .all(),
    ids: db.prepare("SELECT seq, msg_id FROM message_ids ORDER BY seq").all(),
    checkpoints: db
      .prepare("SELECT name, seq, snapshot_seq FROM stream_checkpoints ORDER BY name")
      .all(),
  };
}

function conflicts(): number {
  return Number(
    (getPersistentStreamDiagnostics() as any).msgid_conflicts_total ?? NaN,
  );
}

describe("087: msgID reuse with a different body is refused", () => {
  let dir: string;
  let streams: any[] = [];
  const open = (name: string) => {
    const s = pstream({ path: join(dir, name) });
    streams.push(s);
    return s;
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-087-"));
    streams = [];
  });
  afterEach(async () => {
    for (const s of streams) {
      try {
        if (!s.isPoisoned?.()) s.close();
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("an exact resend is still the canonical duplicate (set and setMany): same result, zero events, zero mutation", async () => {
    const stream = open("exact");
    const first = await stream.setQueued(
      msg("a", { msgID: "m", key: "k", headers: { h: 1 } }),
    );
    const before = snapshot(stream);
    const events: any[] = [];
    stream.on("change", (c) => events.push(c));
    const same = msg("a", { msgID: "m", key: "k", headers: { h: 1 } });
    expect(stream.set(same)).toEqual(first);
    expect((await stream.setManyQueued([same]))[0]).toEqual(first);
    expect(events).toHaveLength(0);
    expect(snapshot(stream)).toEqual(before);
  });

  const differing: Array<[string, object]> = [
    ["raw", msg("OTHER", { msgID: "m", key: "k", headers: { h: 1 } })],
    [
      "encoding",
      { ...msg("a", { msgID: "m", key: "k", headers: { h: 1 } }), encoding: DataEncoding.MsgPack },
    ],
    ["headers", msg("a", { msgID: "m", key: "k", headers: { h: 2 } })],
    ["key", msg("a", { msgID: "m", key: "other", headers: { h: 1 } })],
    ["ttl", msg("a", { msgID: "m", key: "k", headers: { h: 1 }, ttl: 5000 })],
    [
      "checkpoint",
      msg("a", { msgID: "m", key: "k", headers: { h: 1 }, checkpoint: { name: "cp" } }),
    ],
  ];
  for (const [field, op] of differing) {
    for (const how of ["set", "setMany"] as const) {
      it(`a stored msgID with a different ${field} (${how}) → msgid-conflict, zero events, zero mutation`, async () => {
        const stream = open(`diff-${field}-${how}`);
        stream.config({ allow_msg_ttl: true });
        await stream.setQueued(
          msg("a", { msgID: "m", key: "k", headers: { h: 1 } }),
        );
        const before = snapshot(stream);
        const events: any[] = [];
        stream.on("change", (c) => events.push(c));
        const c0 = conflicts();
        if (how == "set") {
          await expect(stream.setQueued(op as any)).rejects.toMatchObject({
            code: "msgid-conflict",
          });
        } else {
          const [r] = await stream.setManyQueued([op as any]);
          expect((r as any).code ?? (r as any).error).toBeDefined();
          expect(JSON.stringify(r)).toContain("msgID was already used");
        }
        expect(events).toHaveLength(0);
        expect(snapshot(stream)).toEqual(before);
        expect(conflicts()).toBe(c0 + 1);
      });
    }
  }

  it("a stored msgID: a different previousSeq alone is not compared (not stored) and answers the duplicate", async () => {
    const stream = open("prev");
    const first = await stream.setQueued(msg("a", { msgID: "m", key: "k" }));
    const before = snapshot(stream);
    expect(
      await stream.setQueued(msg("a", { msgID: "m", key: "k", previousSeq: 99 })),
    ).toEqual(first);
    expect(snapshot(stream)).toEqual(before);
  });

  it("the same batch: a duplicate with a different body is refused, the owner commits once", async () => {
    const stream = open("batch");
    const events: any[] = [];
    stream.on("change", (c) => events.push(c));
    const [owner, other] = await Promise.allSettled([
      stream.setQueued(msg("a", { msgID: "m" })),
      stream.setQueued(msg("forged", { msgID: "m" })),
    ]);
    expect(owner.status).toBe("fulfilled");
    expect(other.status).toBe("rejected");
    expect((other as any).reason.code).toBe("msgid-conflict");
    const sets = events.filter((c) => c.seq != null);
    expect(sets).toHaveLength(1);
    expect(Buffer.from(sets[0].raw).toString()).toBe("a");
  });

  it("the same setMany: a later op with the same msgID and another body fails alone", async () => {
    const stream = open("setmany");
    const results = await stream.setManyQueued([
      msg("a", { msgID: "m" }),
      msg("b", { msgID: "m" }),
      msg("c"),
    ]);
    expect((results[0] as any).seq).toBeGreaterThan(0);
    expect(JSON.stringify(results[1])).toContain("msgID was already used");
    expect((results[2] as any).seq).toBeGreaterThan(0);
    expect(snapshot(stream).messages).toHaveLength(2);
  });

  it("the same batch: a different previousSeq is a different write", async () => {
    const stream = open("batch-prev");
    const [a, b] = await Promise.allSettled([
      stream.setQueued(msg("a", { msgID: "m", key: "k", previousSeq: 0 })),
      stream.setQueued(msg("a", { msgID: "m", key: "k", previousSeq: 5 })),
    ]);
    expect(a.status).toBe("fulfilled");
    expect((b as any).reason?.code).toBe("msgid-conflict");
  });

  it("sameWriteOperation compares every field a client sends", () => {
    const base = msg("a", {
      msgID: "m",
      key: "k",
      headers: { h: 1 },
      ttl: 3,
      previousSeq: 2,
      checkpoint: { name: "n", data: { x: 1 } },
    }) as any;
    expect(sameWriteOperation(base, { ...base })).toBe(true);
    for (const change of [
      { raw: Buffer.from("b") },
      { encoding: DataEncoding.MsgPack },
      { headers: { h: 2 } },
      { key: "j" },
      { ttl: 4 },
      { previousSeq: 3 },
      { checkpoint: { name: "n", data: { x: 2 } } },
    ]) {
      expect(sameWriteOperation(base, { ...base, ...change })).toBe(false);
    }
  });
});
