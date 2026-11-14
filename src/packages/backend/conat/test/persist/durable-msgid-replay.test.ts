/*
Finding 028 B-1 and the msgID replay (finding 087): a write whose msgID is
already stored is answered with the stored {seq, time} and changes nothing.
In particular it emits NO change, so a live subscriber is never shown bytes,
headers or a key that were not stored under that seq.  (Before B-1, the
dedupe pushed a change with the NEW body under the OLD seq, past the
required-headers fence, the previousSeq check and the limits.)

Rejecting a different body under a reused msgID is B-2's item; here the
property is "nothing stored, nothing emitted" for every field.
*/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";

const msg = (s: string, extra: object = {}) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
  ...extra,
});

interface StoredRow {
  seq: number;
  key: string | null;
  headers: string | null;
  raw: string;
  encoding: number;
  ttl: number | null;
}

function storedRows(stream): StoredRow[] {
  return (
    (stream as any).db
      .prepare(
        "SELECT seq, key, headers, encoding, ttl FROM messages ORDER BY seq",
      )
      .all() as any[]
  ).map((row) => ({
    seq: Number(row.seq),
    key: row.key ?? null,
    headers: row.headers ?? null,
    encoding: Number(row.encoding),
    ttl: row.ttl == null ? null : Number(row.ttl),
    // the stored body, decoded the way readers decode it
    raw: Buffer.from(stream.get({ seq: Number(row.seq) })?.raw ?? []).toString(),
  }));
}

function checkpoints(stream) {
  return (stream as any).db
    .prepare("SELECT name, seq FROM stream_checkpoints ORDER BY name")
    .all();
}

describe("028 B-1: a stored msgID is answered without storing or emitting anything", () => {
  let dir: string;
  let streams: any[] = [];
  const open = (name: string, opts: object = {}) => {
    const s = pstream({ path: join(dir, name), ...opts });
    streams.push(s);
    return s;
  };
  // every change a stream emits, and a check that each emitted set matches
  // what is stored under its seq (stored == live)
  const watch = (stream) => {
    const changes: any[] = [];
    stream.on("change", (c) => changes.push(c));
    return changes;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-msgid-"));
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

  it("an exact resend (set, setQueued, setMany, setManyQueued) returns the stored result and emits zero changes", async () => {
    const stream = open("exact");
    const first = await stream.setQueued(msg("a", { msgID: "m1" }));
    const before = storedRows(stream);
    const changes = watch(stream);
    expect(stream.set(msg("a", { msgID: "m1" }))).toEqual(first);
    expect(await stream.setQueued(msg("a", { msgID: "m1" }))).toEqual(first);
    expect(stream.setMany([msg("a", { msgID: "m1" })])[0]).toEqual(first);
    expect(
      (await stream.setManyQueued([msg("a", { msgID: "m1" })]))[0],
    ).toEqual(first);
    expect(changes).toHaveLength(0);
    expect(storedRows(stream)).toEqual(before);
  });

  // each variant differs from the stored message in one field
  const variants: Array<[string, (seq: number) => object]> = [
    ["raw", () => msg("DIFFERENT", { msgID: "m1" })],
    ["encoding", () => ({ ...msg("a", { msgID: "m1" }), encoding: DataEncoding.MsgPack })],
    ["headers", () => msg("a", { msgID: "m1", headers: { forged: 1 } })],
    ["key", () => msg("a", { msgID: "m1", key: "other-key" })],
    ["ttl", () => msg("a", { msgID: "m1", ttl: 1 })],
    ["previousSeq", (seq) => msg("a", { msgID: "m1", previousSeq: seq + 7 })],
    ["checkpoint", (seq) => msg("a", { msgID: "m1", checkpoint: { name: "cp", seq } })],
  ];

  for (const [field, make] of variants) {
    for (const how of ["set", "setManyQueued"] as const) {
      it(`a resend with a different ${field} (${how}) emits zero changes and mutates nothing`, async () => {
        const stream = open(`diff-${field}-${how}`, {});
        stream.config({ allow_msg_ttl: true });
        const first = await stream.setQueued(msg("a", { msgID: "m1", key: "k" }));
        const before = storedRows(stream);
        const cpBefore = checkpoints(stream);
        const changes = watch(stream);
        const op = make(first.seq);
        const result =
          how == "set"
            ? stream.set(op as any)
            : (await stream.setManyQueued([op as any]))[0];
        expect(result).toEqual(first);
        expect(changes).toHaveLength(0);
        expect(storedRows(stream)).toEqual(before);
        expect(checkpoints(stream)).toEqual(cpBefore);
      });
    }
  }

  it("a resend whose headers fail the required-headers fence emits no live event", async () => {
    const stream = open("fence");
    stream.config({ required_headers: { epoch: 1 } } as any);
    const first = await stream.setQueued(
      msg("a", { msgID: "m1", headers: { epoch: 1 } }),
    );
    const before = storedRows(stream);
    const changes = watch(stream);
    // a writer without the fence header reusing the stored msgID
    const result = stream.set(msg("forged", { msgID: "m1", headers: {} }));
    expect(result).toEqual(first);
    expect(changes).toHaveLength(0);
    expect(storedRows(stream)).toEqual(before);
    // without a msgID the same write is refused by the fence
    expect(() => stream.set(msg("forged", { headers: {} }))).toThrow(
      "required header mismatch",
    );
  });

  it("a cached msgID whose row was deleted never yields a phantom event under the old seq", async () => {
    const stream = open("deleted");
    const first = await stream.setQueued(msg("a", { msgID: "gone" }));
    await stream.setQueued(msg("b"));
    stream.delete({ seq: first.seq });
    const changes = watch(stream);
    const again = await stream.setQueued(msg("a2", { msgID: "gone" }));
    // whatever the answer, no change carries the deleted seq, and every
    // emitted set is exactly what is stored under its seq
    expect(changes.some((c) => c.seq === first.seq)).toBe(false);
    const rows = storedRows(stream);
    for (const c of changes.filter((c) => c.seq != null)) {
      const row = rows.find((r) => r.seq === c.seq);
      expect(row).toBeDefined();
      expect(row!.raw).toBe(Buffer.from(c.raw).toString());
    }
    expect(rows.some((r) => r.seq === again.seq) || again.seq === first.seq).toBe(
      true,
    );
  });

  it("after a history reset, a msgID from the previous epoch is not acknowledged as a duplicate", async () => {
    const stream = open("reset");
    const first = await stream.setQueued(msg("a", { msgID: "pre-reset" }));
    const reset = await stream.resetHistory({});
    expect(reset.reset).toBe(true);
    // a reset fences writers to the new epoch: a current writer sends its
    // header
    const fence = (stream.config() as any).required_headers ?? undefined;
    const changes = watch(stream);
    const again = await stream.setQueued(
      msg("a", { msgID: "pre-reset", headers: fence }),
    );
    // stored anew in the new epoch: a new row, emitted once, stored == live
    expect(again.seq).not.toBe(first.seq);
    const rows = storedRows(stream);
    expect(rows.map((r) => r.seq)).toEqual([again.seq]);
    const sets = changes.filter((c) => c.seq != null);
    expect(sets.map((c) => c.seq)).toEqual([again.seq]);
    expect(Buffer.from(sets[0].raw).toString()).toBe("a");
  });

  it("a cached msgID whose row was trimmed by a limit never yields a phantom event under the old seq", async () => {
    const stream = open("trimmed");
    const first = await stream.setQueued(msg("a", { msgID: "trim" }));
    await stream.setQueued(msg("b"));
    stream.config({ max_msgs: 1 }); // trims seq `first.seq`
    expect(storedRows(stream).some((r) => r.seq === first.seq)).toBe(false);
    const changes = watch(stream);
    await stream.setQueued(msg("a2", { msgID: "trim" }));
    expect(changes.some((c) => c.seq === first.seq)).toBe(false);
    const rows = storedRows(stream);
    for (const c of changes.filter((c) => c.seq != null)) {
      const row = rows.find((r) => r.seq === c.seq);
      expect(row).toBeDefined();
      expect(row!.raw).toBe(Buffer.from(c.raw).toString());
    }
  });
});
