import {
  BOARD_HISTORY_LIMITS,
  BoardAppendCheck,
  BoardHistoryCheck,
  depthOver,
  type HistoryVerdict,
  parseBoardRecord,
} from "./board-history";

// A patch record and a snapshot record, as SyncDoc writes them.
const patch = (time: string, parents: string[] = [], extra = {}) => ({
  time,
  parents,
  patch: "[]",
  is_snapshot: false,
  ...extra,
});
const snapshot = (time: string) => ({
  time,
  is_snapshot: true,
  snapshot: "{}",
  seq_info: { seq: 1 },
});

// A chain t0 <- t1 <- ... of n patches (t0 has no parents), after `from`.
function chain(n: number, prefix = "t", from?: string) {
  const out: any[] = [];
  let prev = from;
  for (let i = 0; i < n; i++) {
    const time = `${prefix}${i}`;
    out.push(patch(time, prev == null ? [] : [prev]));
    prev = time;
  }
  return out;
}

function check(
  records: any[],
  limits = BOARD_HISTORY_LIMITS,
  size = (r: any) => JSON.stringify(r).length,
): HistoryVerdict {
  const c = new BoardHistoryCheck(limits);
  for (const r of records) {
    const stop = c.add(r, size(r));
    if (stop) return stop;
  }
  return c.finish();
}

describe("the open check: a clean cut plus a bounded linear suffix", () => {
  test("an empty history", () => {
    const v = check([]);
    expect(v).toMatchObject({ ok: true, suffix: 0 });
    expect((v as any).head).toBeUndefined();
  });

  test("one chain from one root, without a snapshot", () => {
    expect(check(chain(5))).toMatchObject({
      ok: true,
      cut: undefined,
      suffix: 5,
      head: "t4",
      records: 5,
    });
  });

  test("a snapshot, then the chain after it", () => {
    const records = [...chain(5), snapshot("t2")];
    expect(check(records)).toMatchObject({
      ok: true,
      cut: "t2",
      suffix: 2,
      head: "t4",
    });
  });

  test("branches before the cut are fine: the snapshot ends reconstruction", () => {
    const records = [
      patch("r"),
      patch("a", ["r"]),
      patch("b", ["r"]),
      patch("m", ["a", "b"]),
      patch("x", ["m"]),
      patch("y", ["x"]),
      snapshot("m"),
    ];
    expect(check(records)).toMatchObject({ ok: true, cut: "m", head: "y" });
  });

  test("a snapshot whose own patch was deleted, with the chain after it", () => {
    const records = [snapshot("s"), ...chain(3, "u", "s")];
    expect(check(records)).toMatchObject({ ok: true, cut: "s", suffix: 3 });
  });

  test("eight branches joined by one merge: a single head, refused", () => {
    const records: any[] = [patch("r")];
    const tips: string[] = [];
    for (let b = 0; b < 8; b++) {
      records.push(patch(`b${b}x`, ["r"]), patch(`b${b}y`, [`b${b}x`]));
      tips.push(`b${b}y`);
    }
    records.push(patch("merge", tips));
    expect(check(records)).toMatchObject({ ok: false, reason: "non-linear" });
  });

  test("a branch after the cut is refused", () => {
    const records = [...chain(3), patch("side", ["t1"]), snapshot("t1")];
    expect(check(records)).toMatchObject({
      ok: false,
      reason: "non-linear",
      message: "a branch at t1",
    });
  });

  test("a merge after the cut is refused", () => {
    const records = [
      patch("r"),
      patch("a", ["r"]),
      patch("b", ["r"]),
      snapshot("a"),
      patch("m", ["a", "b"]),
    ];
    expect(check(records)).toMatchObject({ ok: false, reason: "non-linear" });
  });

  test("a merge after the cut with a patch from before it is refused", () => {
    // m's second parent is an ancestor of the cut, so the cut is still a
    // cut (patchflow's isCut holds), but reconstructing m is a merge.
    const records = [
      patch("r"),
      patch("a", ["r"]),
      patch("s", ["a"]),
      snapshot("s"),
      patch("m", ["s", "r"]),
    ];
    expect(check(records)).toMatchObject({
      ok: false,
      reason: "non-linear",
      message: "a merge at m",
    });
  });

  test("with several snapshots, the newest is the cut", () => {
    const records = [...chain(6), snapshot("t1"), snapshot("t4")];
    expect(check(records)).toMatchObject({ ok: true, cut: "t4", suffix: 1 });
    // So the suffix limit counts from the newest one.
    expect(
      check(records, { ...BOARD_HISTORY_LIMITS, suffixRecords: 1 }),
    ).toMatchObject({ ok: true, cut: "t4" });
  });

  test("a newer snapshot on one branch does not cover another branch", () => {
    const records = [
      patch("r"),
      patch("a1", ["r"]),
      patch("a2", ["a1"]),
      patch("b1", ["r"]),
      snapshot("a2"),
    ];
    // b1 is neither before a2 nor after it.
    expect(check(records)).toMatchObject({ ok: false, reason: "non-linear" });
  });

  test("the newest snapshot is the cut, even when an older one would pass", () => {
    const records = [
      ...chain(3),
      snapshot("t1"),
      patch("side", ["t0"]),
      snapshot("side"),
    ];
    expect(check(records)).toMatchObject({ ok: false, reason: "non-linear" });
  });

  test("a parent missing inside the history is incomplete, never safe", () => {
    expect(check([patch("t0"), patch("t2", ["t1"])])).toMatchObject({
      ok: false,
      reason: "incomplete",
    });
    // A parent missing after the cut is incomplete.
    expect(
      check([snapshot("s"), patch("a", ["s"]), patch("c", ["b"])]),
    ).toMatchObject({ ok: false, reason: "incomplete" });
    // So is one off the cut's ancestry, though its child is below the cut.
    expect(
      check([
        patch("r"),
        patch("s", ["r"]),
        patch("o", ["gone"]),
        snapshot("s"),
      ]),
    ).toMatchObject({ ok: false, reason: "incomplete" });
  });

  test("ancestors missing at or below the trusted cut are a trimmed history", () => {
    // The cut's snapshot is the whole value, so nothing below it is read:
    // A (parent X, missing), B (parent A), snapshot B (astra's probe).
    expect(
      check([patch("A", ["X"]), patch("B", ["A"]), snapshot("B")]),
    ).toMatchObject({ ok: true, cut: "B", suffix: 0, head: "B" });
    // And with a suffix after it.
    expect(
      check([
        patch("A", ["X"]),
        patch("B", ["A"]),
        snapshot("B"),
        ...chain(2, "u", "B"),
      ]),
    ).toMatchObject({ ok: true, cut: "B", suffix: 2, head: "u1" });
    // No root and no snapshot: incomplete, not empty.
    expect(check([patch("t5", ["t4"])])).toMatchObject({
      ok: false,
      reason: "incomplete",
    });
  });

  test("two roots without a snapshot are refused", () => {
    expect(check([patch("a"), patch("b")])).toMatchObject({
      ok: false,
      reason: "non-linear",
    });
  });

  test("the same patch twice is one patch; two different patches at one time are invalid", () => {
    expect(check([...chain(2), patch("t1", ["t0"])])).toMatchObject({
      ok: true,
      head: "t1",
    });
    expect(check([...chain(2), patch("t1", [])])).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  test("records that aren't board patches are invalid", () => {
    for (const bad of [
      null,
      "x",
      [],
      {},
      { time: "" },
      { time: "has space" },
      { time: 5 },
      { time: "t", parents: "p" },
      { time: "t", parents: [5] },
      { time: "t", parents: ["p", "p"] },
      { time: "t", patch: 7 },
      { time: "t", is_snapshot: "yes" },
      { time: "t", is_snapshot: true },
      { time: "t", merge_parent: "a b" },
    ]) {
      expect(check([bad])).toMatchObject({ ok: false, reason: "invalid" });
    }
  });
});

describe("the open check's limits, just below and just above", () => {
  const L = BOARD_HISTORY_LIMITS;

  test("a record's stored size", () => {
    const c = new BoardHistoryCheck();
    expect(c.checkSize(L.recordBytes)).toBeUndefined();
    expect(new BoardHistoryCheck().checkSize(L.recordBytes + 1)).toMatchObject({
      reason: "too-large",
    });
  });

  test("the whole history's bytes, stopping at the record that passes them", () => {
    const limits = { ...L, totalBytes: 1000 };
    const records = chain(20);
    const c = new BoardHistoryCheck(limits);
    let seen = 0;
    let stop: HistoryVerdict | undefined;
    for (const r of records) {
      stop = c.add(r, 100);
      if (stop) break;
      seen += 1;
    }
    expect(seen).toBe(10);
    expect(stop).toMatchObject({ ok: false, reason: "too-large" });
  });

  test("the number of records", () => {
    const limits = { ...L, records: 10 };
    expect(check(chain(10), limits)).toMatchObject({ ok: true });
    expect(check(chain(11), limits)).toMatchObject({ reason: "too-large" });
  });

  test("parents per record", () => {
    const limits = { ...L, parents: 3 };
    const p = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
    expect(parseBoardRecord(patch("t", p(3)), limits)).toMatchObject({
      time: "t",
    });
    expect(parseBoardRecord(patch("t", p(4)), limits)).toHaveProperty(
      "invalid",
    );
  });

  test("an id's length", () => {
    const id = (n: number) => "a".repeat(n);
    expect(parseBoardRecord(patch(id(L.idChars)))).toMatchObject({
      time: id(L.idChars),
    });
    expect(parseBoardRecord(patch(id(L.idChars + 1)))).toHaveProperty(
      "invalid",
    );
  });

  test("a record's meta", () => {
    const meta = (n: number) => ({ m: "x".repeat(n - 8) }); // {"m":"..."}
    expect(
      parseBoardRecord(patch("t", [], { meta: meta(L.metaChars) })),
    ).toMatchObject({ time: "t" });
    expect(
      parseBoardRecord(patch("t", [], { meta: meta(L.metaChars + 1) })),
    ).toHaveProperty("invalid");
  });

  test("the suffix's length", () => {
    const limits = { ...L, suffixRecords: 5 };
    expect(check([...chain(6), snapshot("t0")], limits)).toMatchObject({
      ok: true,
      suffix: 5,
    });
    expect(check([...chain(7), snapshot("t0")], limits)).toMatchObject({
      ok: false,
      reason: "too-large",
    });
    // Without a snapshot the whole chain is the suffix.
    expect(check(chain(5), limits)).toMatchObject({ ok: true });
    expect(check(chain(6), limits)).toMatchObject({ reason: "too-large" });
  });

  test("the suffix's bytes", () => {
    const limits = { ...L, suffixBytes: 500 };
    const size = () => 100;
    expect(check([...chain(6), snapshot("t0")], limits, size)).toMatchObject({
      ok: true,
      suffixBytes: 500,
    });
    expect(check([...chain(7), snapshot("t0")], limits, size)).toMatchObject({
      reason: "too-large",
    });
  });
});

describe("the append rule", () => {
  // Records as the service sees them: a digest of their bytes (here their
  // JSON) and no storage key.
  const R = (records: any[], key?: string) =>
    records.map((value) => ({
      value,
      digest: JSON.stringify(value),
      bytes: JSON.stringify(value).length,
      key,
    }));
  const stored = (records: any[]) => {
    const c = BoardAppendCheck.fromRecords(R(records), 0);
    return {
      check: (records: any[], key?: string) => c.check(R(records, key)),
      commit: (next: ReturnType<typeof c.check>, seq: number) =>
        c.commit(next, seq),
      get currentHead() {
        return c.currentHead;
      },
    };
  };
  const branch = expect.objectContaining({ code: "branch" });

  test("the first patch has no parents; each next follows the head", () => {
    const a = stored([]);
    const next = a.check(chain(3));
    expect(next.head).toBe("t2");
    a.commit(next, 3);
    expect(a.check([patch("t3", ["t2"])]).head).toBe("t3");
  });

  test("a branch, a merge, or a second root is refused 'branch', and nothing changes", () => {
    const a = stored(chain(3));
    for (const bad of [
      [patch("x", ["t1"])],
      [patch("x", ["t2", "t1"])],
      [patch("x", [])],
      [patch("x", ["t2"]), patch("y", ["t2"])],
    ]) {
      expect(() => a.check(bad)).toThrow(branch);
    }
    expect(a.check([patch("x", ["t2"])]).head).toBe("x");
  });

  test("a stored patch sent again changes nothing; another patch with its time is refused", () => {
    const a = stored(chain(3));
    expect(a.check([patch("t2", ["t1"])]).head).toBe("t2");
    expect(a.check([patch("t0", [])])).toEqual({
      head: "t2",
      added: [],
      digests: [],
      fresh: [false],
      history: expect.anything(),
      written: [true],
    });
    expect(() => a.check([patch("t2", ["t0"])])).toThrow(/different patch/);
    expect(() => a.check([patch("t0", ["t2"])])).toThrow(/different patch/);
  });

  test("astra's probe 1: re-appending a root under a later patch is refused", () => {
    // A (root), B (A), A again (B), C (A): PatchGraph keeps the first A and
    // ends with heads B and C.
    const a = stored([]);
    a.commit(a.check([patch("A", [])]), 1);
    a.commit(a.check([patch("B", ["A"])]), 2);
    expect(() => a.check([patch("A", ["B"])])).toThrow(branch);
    expect(() => a.check([patch("C", ["A"])])).toThrow(branch);
    expect(a.currentHead).toBe("B");
  });

  test("astra's probe 2: a snapshot of a patch the history doesn't have is refused", () => {
    const a = stored([]);
    a.commit(a.check([patch("A", [])]), 1);
    expect(() => a.check([snapshot("X")])).toThrow(branch);
    // A snapshot of a stored patch (here an earlier one, as SyncDoc makes
    // them) is PatchGraph's in-place upgrade: no new node, no new head.
    a.commit(a.check([patch("B", ["A"])]), 2);
    expect(a.check([snapshot("A")]).head).toBe("B");
    expect(a.check([snapshot("B")]).head).toBe("B");
  });

  test("within a batch, records are checked against the batch so far", () => {
    const a = stored(chain(2));
    // A patch, then its snapshot and a retry of it: fine.
    expect(
      a.check([patch("n", ["t1"]), snapshot("n"), patch("n", ["t1"])]).head,
    ).toBe("n");
    // A snapshot of a patch later in the batch: refused (it would be a node).
    expect(() => a.check([snapshot("m"), patch("m", ["t1"])])).toThrow(branch);
  });

  test("a stored history that isn't one chain takes no appends at all", () => {
    for (const records of [
      [patch("r"), patch("a", ["r"]), patch("b", ["r"])],
      [patch("r"), snapshot("x")],
      [patch("r"), patch("r", ["q"])],
      [{ edit: 1 }],
    ]) {
      const a = stored(records);
      expect(() => a.check([patch("z", ["r"])])).toThrow(/can't be appended/);
    }
  });

  test("a stored history with snapshots of its patches keeps their parents and its one head", () => {
    // SyncDoc's ordinary history: snapshots of earlier patches, upgraded in
    // place (a snapshot record has no parents; the patch keeps its own).
    const a = stored([...chain(5), snapshot("t1"), snapshot("t3")]);
    expect(a.currentHead).toBe("t4");
    expect(a.check([patch("t5", ["t4"])]).head).toBe("t5");
    // Before its patch in stream order, the same.
    const b = stored([patch("t0"), snapshot("t1"), patch("t1", ["t0"])]);
    expect(b.currentHead).toBe("t1");
    expect(b.check([patch("t2", ["t1"])]).head).toBe("t2");
  });

  test("a trimmed history (a snapshot whose patch was deleted) takes appends after its head", () => {
    // As in PatchGraph, the snapshot is a node of its own with no parents.
    const a = stored([snapshot("s"), ...chain(2, "u", "s")]);
    expect(a.currentHead).toBe("u1");
    expect(a.check([patch("u2", ["u1"])]).head).toBe("u2");
    expect(() => a.check([patch("x", ["s"])])).toThrow(branch);
    // Only the snapshot: the next patch follows it.
    const b = stored([snapshot("s")]);
    expect(b.check([patch("n", ["s"])]).head).toBe("n");
    expect(() => b.check([patch("n", [])])).toThrow(branch);
  });

  test("astra's round 2: a retry changes nothing only if it is the stored record exactly", () => {
    const a = stored([patch("A", [], { patch: '"old"' })]);
    // The same time and parents, another payload: refused (PatchGraph keeps
    // the first, so a reopened board could differ from the live one).
    expect(() => a.check([patch("A", [], { patch: '"new"' })])).toThrow(
      /different patch at A/,
    );
    // The same payload, other parents: refused.
    expect(() => a.check([patch("A", ["A0"], { patch: '"old"' })])).toThrow(
      /different patch at A/,
    );
    // Exactly the stored record again: nothing changes.
    expect(a.check([patch("A", [], { patch: '"old"' })])).toEqual({
      head: "A",
      added: [],
      digests: [],
      fresh: [false],
      history: expect.anything(),
      written: [true],
    });
    // Within one batch too.
    expect(() =>
      a.check([
        patch("B", ["A"], { patch: '"b"' }),
        patch("B", ["A"], { patch: '"b2"' }),
      ]),
    ).toThrow(/different patch at B/);
  });

  test("one snapshot record per time: the same again changes nothing, another is refused", () => {
    const a = stored([...chain(2), snapshot("t0")]);
    expect(a.check([snapshot("t0")]).head).toBe("t1");
    expect(() =>
      a.check([{ ...snapshot("t0"), snapshot: '{"other":1}' }]),
    ).toThrow(/different snapshot at t0/);
    // A snapshot of a stored patch without one is the in-place upgrade.
    const next = a.check([snapshot("t1")]);
    expect(next.digests.map(([id]) => id)).toEqual(["s:t1"]);
    a.commit(next, 4);
    expect(() =>
      a.check([{ ...snapshot("t1"), seq_info: { seq: 9 } }]),
    ).toThrow(/different snapshot at t1/);
  });

  test("a board's records have no storage key: a keyed record is refused, a stored one takes no appends", () => {
    const a = stored(chain(2));
    // A keyed set deletes the row with that key before it inserts: refused,
    // whatever it claims to be.
    expect(() => a.check([patch("t2", ["t1"])], "t0")).toThrow(
      /without a storage key/,
    );
    expect(() => a.check([patch("t1", ["t0"])], "t1")).toThrow(
      /without a storage key/,
    );
    const keyed = BoardAppendCheck.fromRecords(
      [
        { value: patch("t0"), digest: "d0", bytes: 10 },
        { value: patch("t1", ["t0"]), digest: "d1", bytes: 10, key: "k" },
      ],
      0,
    );
    expect(() =>
      keyed.check([{ value: patch("t2", ["t1"]), digest: "d2", bytes: 10 }]),
    ).toThrow(/storage key/);
  });

  test("a stored history with two different records at one time takes no appends", () => {
    const c = BoardAppendCheck.fromRecords(
      [
        { value: patch("A", [], { patch: '"old"' }), digest: "old", bytes: 10 },
        { value: patch("A", [], { patch: '"new"' }), digest: "new", bytes: 10 },
      ],
      0,
    );
    expect(() =>
      c.check([{ value: patch("B", ["A"]), digest: "b", bytes: 10 }]),
    ).toThrow(/two different records at A/);
  });

  test("records that aren't patches are refused", () => {
    const a = stored(chain(1));
    expect(() => a.check([{ edit: 1 }])).toThrow(branch);
  });
});

describe("an append never makes a history the open check refuses", () => {
  const L = BOARD_HISTORY_LIMITS;
  const R = (records: any[]) =>
    records.map((value) => ({
      value,
      digest: JSON.stringify(value),
      bytes: JSON.stringify(value).length,
    }));
  const open = (records: any[], limits = L) => check(records, limits);
  const branch = expect.objectContaining({ code: "branch" });

  test("a stored merge leaving one head takes no appends (codex 4331981051)", () => {
    const stored = [
      patch("r"),
      patch("a", ["r"]),
      patch("b", ["r"]),
      patch("m", ["a", "b"]),
    ];
    expect(open(stored)).toMatchObject({ ok: false, reason: "non-linear" });
    const c = BoardAppendCheck.fromRecords(R(stored), 0);
    expect(c.currentHead).toBe("m");
    expect(() => c.check(R([patch("n", ["m"])]))).toThrow(/isn't openable/);
  });

  test("a snapshot needs its seq_info (codex 4331981059)", () => {
    for (const seq_info of [
      undefined,
      {},
      { seq: -1 },
      { seq: 1.5 },
      { seq: 1, prev_seq: "0" },
      { seq: 1, x: 1 },
    ]) {
      const bad = { time: "t0", is_snapshot: true, snapshot: "{}", seq_info };
      expect(open([patch("t0"), bad])).toMatchObject({
        ok: false,
        reason: "invalid",
      });
      const c = BoardAppendCheck.fromRecords(R([patch("t0")]), 0);
      expect(() => c.check(R([bad]))).toThrow(branch);
    }
    const good = {
      time: "t0",
      is_snapshot: true,
      snapshot: "{}",
      seq_info: { seq: 1, prev_seq: 0 },
    };
    expect(open([patch("t0"), good])).toMatchObject({ ok: true });
  });

  // codex 4331981047: every bound of the open check, projected.
  test("the record count includes snapshots", () => {
    const limits = { ...L, records: 4 };
    const c = BoardAppendCheck.fromRecords(R(chain(3)), 0, limits);
    expect(() => c.check(R([snapshot("t2")]), limits)).not.toThrow();
    expect(() =>
      c.check(R([snapshot("t2"), patch("t3", ["t2"])]), limits),
    ).toThrow(/over 4 records/);
  });

  test("the stream's bytes", () => {
    const records = chain(3);
    const bytes = R(records).reduce((n, r) => n + r.bytes, 0);
    const limits = { ...L, totalBytes: bytes + 60 };
    const c = BoardAppendCheck.fromRecords(R(records), 0, limits);
    expect(() =>
      c.check(
        R([patch("t3", ["t2"], { patch: "[" + "1,".repeat(40) + "1]" })]),
        limits,
      ),
    ).toThrow(/bytes/);
  });

  test("the chain after the newest snapshot, which a snapshot cuts", () => {
    const limits = { ...L, suffixRecords: 3 };
    const c = BoardAppendCheck.fromRecords(R(chain(3)), 0, limits);
    expect(() => c.check(R([patch("t3", ["t2"])]), limits)).toThrow(
      /after the newest snapshot/,
    );
    const next = c.check(R([snapshot("t2"), patch("t3", ["t2"])]), limits);
    c.commit(next, 5);
    expect(next.history).toMatchObject({ cut: "t2", chain: [{ time: "t3" }] });
    const all = [...chain(3), snapshot("t2"), patch("t3", ["t2"])];
    expect(open(all, limits)).toMatchObject({ ok: true, cut: "t2", suffix: 1 });
  });

  test("the chain's bytes", () => {
    const limits = { ...L, suffixBytes: 400 };
    const c = BoardAppendCheck.fromRecords(R(chain(2)), 0, limits);
    expect(() =>
      c.check(
        R([patch("t2", ["t1"], { patch: `"${"x".repeat(300)}"` })]),
        limits,
      ),
    ).toThrow(/bytes of patches/);
  });

  test("a snapshot older than the newest one: allowed on the line below it, refused off it", () => {
    // On the line: the cut moves back, and the history still opens.
    const line = [...chain(3), snapshot("t2")];
    const c = BoardAppendCheck.fromRecords(R(line), 0);
    const next = c.check(R([snapshot("t1"), patch("t3", ["t2"])]));
    expect(next.history).toMatchObject({
      cut: "t1",
      chain: [{ time: "t2" }, { time: "t3" }],
    });
    expect(open([...line, snapshot("t1"), patch("t3", ["t2"])])).toMatchObject({
      ok: true,
      cut: "t1",
      suffix: 2,
    });
    // Below a merge (ancestors of a cut may branch): refused, as the open
    // check would refuse it.
    const merged = [
      patch("r"),
      patch("a", ["r"]),
      patch("b", ["r"]),
      patch("m", ["a", "b"]),
      snapshot("m"),
    ];
    expect(open(merged)).toMatchObject({ ok: true, cut: "m" });
    const d = BoardAppendCheck.fromRecords(R(merged), 0);
    expect(open([...merged, snapshot("a")])).toMatchObject({ ok: false });
    expect(() => d.check(R([snapshot("a")]))).toThrow(
      /not on this board's one chain/,
    );
  });

  test("random accepted appends always open (agreement with the open check)", () => {
    const limits = { ...L, records: 40, suffixRecords: 6, suffixBytes: 600 };
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let accepted = 0;
    let refused = 0;
    for (let round = 0; round < 50; round++) {
      const stored: any[] = [];
      let c = BoardAppendCheck.fromRecords([], 0, limits);
      let n = 0;
      for (let step = 0; step < 60; step++) {
        const head = c.currentHead;
        const times = stored.filter((r) => !r.is_snapshot).map((r) => r.time);
        const pick = () => times[Math.floor(rand() * times.length)];
        const batch: any[] = [];
        for (let k = 0; k < 1 + Math.floor(rand() * 3); k++) {
          const x = rand();
          const last =
            batch.filter((r) => !r.is_snapshot).slice(-1)[0]?.time ?? head;
          if (x < 0.6 || times.length === 0) {
            batch.push(
              patch(`p${n++}`, last == null ? [] : [last], {
                patch: `"${"y".repeat(Math.floor(rand() * 80))}"`,
              }),
            );
          } else if (x < 0.9) {
            batch.push(snapshot(pick()));
          } else {
            batch.push(stored[Math.floor(rand() * stored.length)]);
          }
        }
        let next;
        try {
          next = c.check(R(batch), limits);
        } catch {
          refused += 1;
          continue;
        }
        accepted += 1;
        stored.push(...batch);
        if (next.fresh.every((f) => f)) c.commit(next, stored.length);
        else c = BoardAppendCheck.fromRecords(R(stored), stored.length, limits);
        expect(open(stored, limits)).toMatchObject({ ok: true });
      }
    }
    // Both outcomes are exercised.
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(200);
  });
});

describe("the open check and the append check agree (codex round 6)", () => {
  const R = (records: any[]) =>
    records.map((value) => ({
      value,
      digest: JSON.stringify(value),
      bytes: JSON.stringify(value).length,
    }));

  test("every snapshot-only node is a node: a leftover one is a second head (4332146118)", () => {
    // An older snapshot whose patch is gone, an unrelated patch, and a
    // newer snapshot of that patch: PatchGraph has two heads.
    const records = [snapshot("gone"), patch("p"), snapshot("p")];
    expect(check(records)).toMatchObject({ ok: false, reason: "non-linear" });
    const c = BoardAppendCheck.fromRecords(R(records), 0);
    expect(() => c.check(R([patch("q", ["p"])]))).toThrow(/heads|openable/);
    // One trimmed snapshot with the chain after it still opens.
    expect(
      check([snapshot("gone"), patch("q", ["gone"]), patch("r", ["q"])]),
    ).toMatchObject({ ok: true, cut: "gone", suffix: 2, head: "r" });
  });

  test("a copy of a patch must be the same record, not only the same parents (4332146123)", () => {
    const a = patch("A", [], { patch: '"one"' });
    const b = patch("A", [], { patch: '"two"' });
    expect(check([a, b])).toMatchObject({
      ok: false,
      reason: "invalid",
      message: "two different patches at A",
    });
    expect(check([a, { ...a }])).toMatchObject({ ok: true });
    // With the stored bytes' identity, as the service reads it.
    const c = new BoardHistoryCheck();
    c.add(a, 10, "d1");
    expect(c.add(a, 10, "d2")).toMatchObject({ ok: false, reason: "invalid" });
    // And two different snapshots at one time.
    expect(
      check([
        patch("A"),
        snapshot("A"),
        { ...snapshot("A"), snapshot: '{"x":1}' },
      ]),
    ).toMatchObject({ ok: false, message: "two different snapshots at A" });
  });

  test("a patch (or merge patch) that isn't JSON is refused (4332146126)", () => {
    for (const bad of [
      patch("A", [], { patch: "{not json" }),
      patch("A", ["B"], { merge_parent: "B", merge_patch: "[" }),
    ]) {
      expect(check([bad])).toMatchObject({ ok: false, reason: "invalid" });
      const c = BoardAppendCheck.fromRecords([], 0);
      expect(() => c.check(R([bad]))).toThrow(/not JSON/);
    }
    // merge_patch without a merge_parent is never parsed by SyncDoc.
    expect(check([patch("A", [], { merge_patch: "[" })])).toMatchObject({
      ok: true,
    });
  });
});

describe("G1's record depth contract (32, as the recovery scan)", () => {
  const R = (records: any[]) =>
    records.map((value) => ({
      value,
      digest: JSON.stringify(value),
      bytes: JSON.stringify(value).length,
    }));
  // A record whose meta nests so that the record is `depth` deep (the
  // record's own map is 1).
  const deepMeta = (depth: number) => {
    let meta: any = 1;
    for (let i = 0; i < depth - 1; i++) meta = { m: meta };
    return meta;
  };

  test("a record exactly 32 deep opens and appends; 33 is refused by both", () => {
    expect(depthOver(patch("t0", [], { meta: deepMeta(32) }), 32)).toBe(false);
    expect(depthOver(patch("t0", [], { meta: deepMeta(33) }), 32)).toBe(true);
    const at32 = [patch("t0"), patch("t1", ["t0"], { meta: deepMeta(32) })];
    expect(check(at32)).toMatchObject({ ok: true });
    const c = BoardAppendCheck.fromRecords(R(at32), 0);
    expect(c.check(R([patch("t2", ["t1"], { meta: deepMeta(32) })])).head).toBe(
      "t2",
    );
    const at33 = patch("t2", ["t1"], { meta: deepMeta(33) });
    expect(() => c.check(R([at33]))).toThrow(/nested over 32 deep/);
    // On open: quarantined (invalid), never opened.
    expect(check([...at32, at33])).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  test("SyncDoc's own records, with every field they carry, fit", () => {
    const patchRecord = {
      string_id: "s".repeat(40),
      time: "lz3k1v4c_a1b2c3",
      wall: 1_700_000_000_000,
      user_id: 1,
      patch: JSON.stringify([
        [
          ["x", 1, 2],
          ["y", { a: [1, { b: 2 }] }],
        ],
        0,
      ]),
      // A merge: its merge_parent is one of its parents.
      parents: ["lz3k1v4b_a1b2c3", "lz3k1v4a_a1b2c3"],
      version: 7,
      size: 100,
      file: true,
      meta: { source: "file", nested: { a: { b: { c: [1, [2, [3]]] } } } },
      hash: "h".repeat(32),
      merge_parent: "lz3k1v4a_a1b2c3",
      merge_patch: JSON.stringify([[1, 2]]),
      inexact: true,
      is_snapshot: false,
    };
    const snapshotRecord = {
      size: 2,
      string_id: "s".repeat(40),
      time: "lz3k1v4c_a1b2c3",
      wall: 1_700_000_000_000,
      is_snapshot: true,
      snapshot: "{}",
      user_id: 1,
      seq_info: { seq: 12, prev_seq: 3 },
      hash: "h".repeat(32),
      __checkpoint: {
        name: "latest-snapshot",
        seq: 12,
        data: { patchId: "lz3k1v4c_a1b2c3" },
      },
    };
    for (const r of [patchRecord, snapshotRecord]) {
      expect(depthOver(r, 32)).toBe(false);
      expect(parseBoardRecord(r)).not.toHaveProperty("invalid");
    }
  });

  test("depthOver is iterative: a value 100,000 deep is measured without overflow", () => {
    let x: any = 1;
    for (let i = 0; i < 100_000; i++) x = [x];
    expect(depthOver(x, 32)).toBe(true);
    expect(depthOver(x, 100_000)).toBe(false);
  });
});

test("codex 4332517570: a snapshot's body must be a board document (one JSON object per line)", () => {
  const snap = (body: string) => ({ ...snapshot("t0"), snapshot: body });
  for (const good of ["", "{}", '{"type":"doc"}\n{"type":"item","id":"a"}\n']) {
    expect(check([patch("t0"), snap(good)])).toMatchObject({ ok: true });
  }
  for (const bad of [
    "{",
    '{"a":1}\nnot json',
    "null",
    "[1]",
    '"text"',
    "{}\n[]",
  ]) {
    expect(check([patch("t0"), snap(bad)])).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    const c = BoardAppendCheck.fromRecords(
      [{ value: patch("t0"), digest: "p", bytes: 10 }],
      0,
    );
    expect(() =>
      c.check([{ value: snap(bad), digest: "s", bytes: 10 }]),
    ).toThrow(/isn't a board document/);
  }
});

test("codex 4332816476: a merge parent must be one of the record's parents", () => {
  const R = (records: any[]) =>
    records.map((value) => ({
      value,
      digest: JSON.stringify(value),
      bytes: JSON.stringify(value).length,
    }));
  const merged = [
    patch("a"),
    patch("b", ["a"]),
    patch("m", ["b"], { merge_parent: "b", merge_patch: "[]" }),
  ];
  expect(check(merged)).toMatchObject({ ok: true });
  for (const bad of [
    // Off the chain, or missing.
    patch("m", ["b"], { merge_parent: "a", merge_patch: "[]" }),
    patch("m", ["b"], { merge_parent: "zz", merge_patch: "[]" }),
    // A merge patch that isn't a string.
    patch("m", ["b"], { merge_parent: "b", merge_patch: [] }),
  ]) {
    const records = [patch("a"), patch("b", ["a"]), bad];
    expect(check(records)).toMatchObject({ ok: false, reason: "invalid" });
    const c = BoardAppendCheck.fromRecords(R(records.slice(0, 2)), 0);
    expect(() => c.check(R([bad]))).toThrow(/merge (parent|patch)/);
  }
});
