/*
Finding 028 B-1 and the msgID replay (finding 087): a write whose msgID is
already stored is answered with the stored {seq, time} and changes nothing.
In particular it emits NO change, so a live subscriber is never shown bytes,
headers or a key that were not stored under that seq.  (Before B-1, the
dedupe pushed a change with the NEW body under the OLD seq, past the
required-headers fence, the previousSeq check and the limits.)

setInternal answers a duplicate on three paths, each tested (SA 3251):
- P1: the in-memory msgIDs cache (the same open stream, recently);
- P2: the persisted message_ids JOIN messages (after a restart, or once the
  cache entry expired: the lost-ack-after-crash case B-1 exists for);
- P3: an owner earlier in the same batch (duplicateOf).
Each assertion of "no event" goes through assertNoEvents, whose message names
the path, so the can-fail mutants (one per path, re-adding the pre-B-1 emit)
are counted only on that assertion.  "No mutation" compares every row of
every non-trash table, before and after.

Refusing a different body under a reused msgID is B-2's item (087); here the
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

// The mapped assertion of the can-fail mutants: its message names the path.
function assertNoEvents(changes: any[], path: "P1" | "P2" | "P3"): void {
  if (changes.length !== 0) {
    throw new Error(
      `NO-EVENT-ASSERTION[${path}]: ${changes.length} change(s) emitted for a duplicate`,
    );
  }
}

// Every row of every table except the reset trash, as stored.
function state(stream): Record<string, any[]> {
  const db = (stream as any).db;
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%trash%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  const out: Record<string, any[]> = {};
  for (const table of tables) {
    out[table] = (db.prepare(`SELECT * FROM "${table}"`).all() as any[]).map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
          ]),
        ),
    );
    out[table].sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
    );
  }
  return out;
}

function storedRaws(stream): Map<number, string> {
  const rows = (stream as any).db
    .prepare("SELECT seq FROM messages ORDER BY seq")
    .all() as { seq: number }[];
  return new Map(
    rows.map(({ seq }) => [
      Number(seq),
      Buffer.from(stream.get({ seq: Number(seq) })?.raw ?? []).toString(),
    ]),
  );
}

// The stored message at seq, as a changefeed set carries it (astra B1-A2):
// every emitted set must equal it field by field.
function expectEmittedEqualsStored(stream, change) {
  const stored = stream.get({ seq: change.seq });
  expect(stored).toBeDefined();
  const norm = (m) => ({
    seq: Number(m.seq),
    key: m.key ?? null,
    encoding: Number(m.encoding),
    headers: JSON.stringify(m.headers ?? null),
    raw: Buffer.from(m.raw).toString("hex"),
    time_s: Math.floor(Number(m.time) / 1000),
  });
  expect(norm(change)).toEqual(norm(stored));
}

// P2 answers time from the stored row (whole seconds × 1000 as stored):
// within 2 ms of the original ack
function expectSameResult(result: any, first: any) {
  expect(result.seq).toBe(first.seq);
  expect(Math.abs(result.time - first.time)).toBeLessThan(2);
}

describe("028 B-1: a stored msgID is answered without storing or emitting anything", () => {
  let dir: string;
  let streams: any[] = [];
  const open = (name: string) => {
    const s = pstream({ path: join(dir, name) });
    streams.push(s);
    return s;
  };
  // P2: a new connection, so the in-memory cache is empty
  const reopen = (stream, name: string) => {
    stream.close();
    streams = streams.filter((s) => s !== stream);
    return open(name);
  };
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

  for (const path of ["P1", "P2"] as const) {
    it(`${path}: an exact resend (set, setQueued, setMany, setManyQueued) returns the stored result, emits nothing and changes nothing`, async () => {
      let stream = open(`exact-${path}`);
      const first = await stream.setQueued(msg("a", { msgID: "m1" }));
      if (path == "P2") stream = reopen(stream, `exact-${path}`);
      const before = state(stream);
      const changes = watch(stream);
      expectSameResult(stream.set(msg("a", { msgID: "m1" })), first);
      expectSameResult(await stream.setQueued(msg("a", { msgID: "m1" })), first);
      expectSameResult(stream.setMany([msg("a", { msgID: "m1" })])[0], first);
      expectSameResult(
        (await stream.setManyQueued([msg("a", { msgID: "m1" })]))[0],
        first,
      );
      assertNoEvents(changes, path);
      expect(state(stream)).toEqual(before);
    });
  }

  // The stored message, and each variant: the SAME envelope with exactly the
  // named field overridden (astra B1-A1).
  const baseline = () => msg("a", { msgID: "m1", key: "k" }) as any;
  const variants: Array<[string, (seq: number) => any]> = [
    ["raw", () => ({ ...baseline(), raw: Buffer.from("DIFFERENT") })],
    ["encoding", () => ({ ...baseline(), encoding: DataEncoding.MsgPack })],
    ["headers", () => ({ ...baseline(), headers: { forged: 1 } })],
    ["key", () => ({ ...baseline(), key: "other-key" })],
    ["ttl", () => ({ ...baseline(), ttl: 1 })],
    ["previousSeq", (seq) => ({ ...baseline(), previousSeq: seq + 7 })],
    ["checkpoint", (seq) => ({ ...baseline(), checkpoint: { name: "cp", seq } })],
  ];
  const changedFields = (op: any): string[] => {
    const base = baseline();
    return [...new Set([...Object.keys(base), ...Object.keys(op)])]
      .filter(
        (k) =>
          JSON.stringify(base[k] instanceof Buffer ? base[k].toString("hex") : base[k]) !==
          JSON.stringify(op[k] instanceof Buffer ? op[k].toString("hex") : op[k]),
      )
      .sort();
  };

  for (const path of ["P1", "P2"] as const) {
    for (const [field, make] of variants) {
      for (const how of ["set", "setManyQueued"] as const) {
        it(`${path}: a resend with a different ${field} (${how}) emits nothing and changes nothing`, async () => {
          const name = `diff-${path}-${field}-${how}`;
          let stream = open(name);
          stream.config({ allow_msg_ttl: true });
          const first = await stream.setQueued(baseline());
          if (path == "P2") stream = reopen(stream, name);
          const before = state(stream);
          const changes = watch(stream);
          const op = make(first.seq);
          expect(changedFields(op)).toEqual([field]);
          const result =
            how == "set"
              ? stream.set(op as any)
              : (await stream.setManyQueued([op as any]))[0];
          expectSameResult(result, first);
          assertNoEvents(changes, path);
          expect(state(stream)).toEqual(before);
        });
      }
    }
  }

  // P3: a duplicate of an op earlier in the same batch
  const p3variants: Array<[string, object]> = [
    ["the same body", msg("a", { msgID: "m1" })],
    ["a different raw", msg("DIFFERENT", { msgID: "m1" })],
    ["different headers", msg("a", { msgID: "m1", headers: { forged: 1 } })],
    ["a different key", msg("a", { msgID: "m1", key: "other-key" })],
  ];
  for (const [what, dup] of p3variants) {
    it(`P3: in one setMany, a later op with the msgID and ${what} gets the first op's result, emits nothing of its own and stores nothing`, async () => {
      const stream = open(`p3-many-${what}`);
      const changes = watch(stream);
      const [r1, r2] = await stream.setManyQueued([msg("a", { msgID: "m1" }), dup as any]);
      // nothing after the owner's own change (the mapped assertion first)
      assertNoEvents(changes.slice(1), "P3");
      expect(r2).toEqual(r1);
      // exactly the owner's change, carrying the owner's bytes
      const sets = changes.filter((c) => c.seq != null);
      expect(sets).toHaveLength(1);
      expect(Buffer.from(sets[0].raw).toString()).toBe("a");
      expect([...storedRaws(stream).values()]).toEqual(["a"]);
    });

    it(`P3: across requests in one batch, a later request with the msgID and ${what} gets the first's result, emits nothing of its own and stores nothing`, async () => {
      const stream = open(`p3-batch-${what}`);
      const changes = watch(stream);
      const [r1, r2] = await Promise.all([
        stream.setQueued(msg("a", { msgID: "m1" })),
        stream.setQueued(dup as any),
      ]);
      assertNoEvents(changes.slice(1), "P3");
      expect(r2).toEqual(r1);
      const sets = changes.filter((c) => c.seq != null);
      expect(sets).toHaveLength(1);
      expect(Buffer.from(sets[0].raw).toString()).toBe("a");
      expect([...storedRaws(stream).values()]).toEqual(["a"]);
    });
  }

  it("P1/P2: a resend whose headers fail the required-headers fence emits no live event", async () => {
    for (const path of ["P1", "P2"] as const) {
      const name = `fence-${path}`;
      let stream = open(name);
      stream.config({ required_headers: { epoch: 1 } } as any);
      const first = await stream.setQueued(
        msg("a", { msgID: "m1", headers: { epoch: 1 } }),
      );
      if (path == "P2") stream = reopen(stream, name);
      const before = state(stream);
      const changes = watch(stream);
      // a writer without the fence header reusing the stored msgID
      expectSameResult(
        stream.set(msg("forged", { msgID: "m1", headers: {} })),
        first,
      );
      assertNoEvents(changes, path);
      expect(state(stream)).toEqual(before);
      // without a msgID the same write is refused by the fence
      expect(() => stream.set(msg("forged", { headers: {} }))).toThrow(
        "required header mismatch",
      );
    }
  });

  it("a cached msgID whose row was deleted never yields a phantom event under the old seq", async () => {
    const stream = open("deleted");
    const first = await stream.setQueued(msg("a", { msgID: "gone" }));
    await stream.setQueued(msg("b"));
    stream.delete({ seq: first.seq });
    const changes = watch(stream);
    const again = await stream.setQueued(msg("a2", { msgID: "gone" }));
    // whatever the answer, no change carries the deleted seq, and every
    // emitted set is exactly what is stored under its seq.  (P1 may answer
    // with the deleted seq and store nothing; whether that answer stands is
    // B-2/087's decision.)
    expect(changes.some((c) => c.seq === first.seq)).toBe(false);
    const raws = storedRaws(stream);
    for (const c of changes.filter((c) => c.seq != null)) {
      expectEmittedEqualsStored(stream, c);
    }
    expect(raws.has(again.seq) || again.seq === first.seq).toBe(true);
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
    const raws = storedRaws(stream);
    expect([...raws.keys()]).toEqual([again.seq]);
    const sets = changes.filter((c) => c.seq != null);
    expect(sets.map((c) => c.seq)).toEqual([again.seq]);
    expect(Buffer.from(sets[0].raw).toString()).toBe("a");
    expectEmittedEqualsStored(stream, sets[0]);
  });

  it("a cached msgID whose row was trimmed by a limit never yields a phantom event under the old seq", async () => {
    const stream = open("trimmed");
    const first = await stream.setQueued(msg("a", { msgID: "trim" }));
    await stream.setQueued(msg("b"));
    stream.config({ max_msgs: 1 }); // trims seq `first.seq`
    expect(storedRaws(stream).has(first.seq)).toBe(false);
    const changes = watch(stream);
    await stream.setQueued(msg("a2", { msgID: "trim" }));
    expect(changes.some((c) => c.seq === first.seq)).toBe(false);
    for (const c of changes.filter((c) => c.seq != null)) {
      expectEmittedEqualsStored(stream, c);
    }
  });
});
