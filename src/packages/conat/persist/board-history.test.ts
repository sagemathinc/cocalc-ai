import {
  BOARD_HISTORY_LIMITS,
  BoardAppendCheck,
  BoardHistoryCheck,
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
    // Only the cut may be missing (a deleted older history).
    expect(
      check([snapshot("s"), patch("a", ["s"]), patch("c", ["b"])]),
    ).toMatchObject({ ok: false, reason: "incomplete" });
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
  test("the first patch has no parents; each next follows the head", () => {
    const a = new BoardAppendCheck({ seq: 0 });
    const next = a.check(chain(3));
    expect(next.head).toBe("t2");
    a.commit(next, 3);
    expect(a.check([patch("t3", ["t2"])]).head).toBe("t3");
  });

  test("a branch, a merge, or a second root is refused 'branch', and nothing changes", () => {
    const a = new BoardAppendCheck({ head: "t2", headParents: ["t1"], seq: 3 });
    for (const bad of [
      [patch("x", ["t1"])],
      [patch("x", ["t2", "t1"])],
      [patch("x", [])],
      [patch("x", ["t2"]), patch("y", ["t2"])],
    ]) {
      expect(() => a.check(bad)).toThrow(
        expect.objectContaining({ code: "branch" }),
      );
    }
    expect(a.check([patch("x", ["t2"])]).head).toBe("x");
  });

  test("the head sent again (a retried write) is accepted and changes nothing", () => {
    const a = new BoardAppendCheck({ head: "t2", headParents: ["t1"], seq: 3 });
    expect(a.check([patch("t2", ["t1"])]).head).toBe("t2");
    // The same time with other parents is another patch: refused.
    expect(() => a.check([patch("t2", ["t0"])])).toThrow(/one chain/);
  });

  test("snapshot records pass through; records that aren't patches are refused", () => {
    const a = new BoardAppendCheck({ head: "t2", headParents: ["t1"], seq: 3 });
    expect(a.check([snapshot("t1")]).head).toBe("t2");
    expect(() => a.check([{ edit: 1 }])).toThrow(
      expect.objectContaining({ code: "branch" }),
    );
  });
});
