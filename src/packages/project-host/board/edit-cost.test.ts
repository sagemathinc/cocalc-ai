/*
G2 (A2b design 8c): an edit's commit work, counted from the edit, and the
caps on it. The bound must hold for diff-match-patch as patchflow runs it;
the worst edit the caps admit must commit within the budget; and the worst
edit the limits admitted before G2 is refused now.
*/

import * as lib from "@sagemathinc/sagebrush-board";
import {
  editState,
  sharedPreviewBudget,
} from "@sagemathinc/sagebrush-board/submission";
import { makePatch } from "@cocalc/sync/patchflow";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
} from "@cocalc/util/board/names";
import {
  BOARD_EDIT_WORK_CEILING,
  BOARD_EDIT_WORK_LIMITS,
  REFERENCE_LOOP_MS,
  calibrateEditWorkLimits,
  editWork,
  editWorkRefusal,
  fieldWork,
  fileMergeWork,
  referenceLoopMs,
} from "./edit-cost";
import { recordsToString } from "./service";

const KiB = 1024;
const STRING_COLS = new Set(BOARD_STRING_COLS);

// A small deterministic random generator (mulberry32).
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the bound on an edit's patches, from the edit alone", () => {
  test("exact values", () => {
    expect(fieldWork("same", "same")).toEqual({ patches: 0, span: 0, work: 0 });
    // A pure insertion or deletion is one patch, however long.
    expect(fieldWork("ab", `a${"x".repeat(1000)}b`)).toEqual({
      patches: 1,
      span: 0,
      work: 1004,
    });
    expect(fieldWork("abcdef", "af")).toEqual({ patches: 1, span: 0, work: 8 });
    // A replacement of 16 characters by 20: m = 16, k ≤ 16/8 + 1 = 3, and
    // the search is charged (16 + 20)·20.
    expect(
      fieldWork(`pre${"a".repeat(16)}post`, `pre${"b".repeat(20)}post`),
    ).toEqual({ patches: 3, span: 16, work: 3 * (23 + 27) + 36 * 20 });
    expect(fieldWork("", "new")).toEqual({ patches: 1, span: 0, work: 3 });
  });

  test("it is never below diff-match-patch's real number of patches (5,000 random edits)", () => {
    const random = rng(8_8_2026);
    const alphabets = ["ab", "abc ", "abcdefghijklmnopqrstuvwxyz \n"];
    for (let i = 0; i < 5000; i++) {
      const alpha = alphabets[i % alphabets.length];
      const len = Math.floor(random() * 2000);
      let before = "";
      for (let j = 0; j < len; j++) {
        before += alpha[Math.floor(random() * alpha.length)];
      }
      // Some edits: replace, insert or delete runs at random places.
      let after = before;
      const edits = 1 + Math.floor(random() * 40);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(random() * (after.length + 1));
        const n = Math.floor(random() * 12);
        const insert = Array.from(
          { length: Math.floor(random() * 12) },
          () => alpha[Math.floor(random() * alpha.length)],
        ).join("");
        after = after.slice(0, at) + insert + after.slice(at + n);
      }
      const actual = before === after ? 0 : makePatch(before, after).length;
      const bound = fieldWork(before, after).patches;
      if (actual > bound) {
        throw Error(
          `case ${i}: ${actual} patches, over the bound ${bound}: ${JSON.stringify({ before, after })}`,
        );
      }
    }
  });

  test("an edit's work: its text fields only, against the record as it is", () => {
    const records = new Map<string, any>([
      ["item::a", { type: "item", page: "", id: "a", text: "hello", x: 1 }],
    ]);
    const current = (k: any) => records.get(`${k.type}:${k.page}:${k.id}`);
    const work = editWork(
      [
        // A text field (pure insertion: 1 patch over 5 + 11 characters).
        {
          op: "set",
          key: { type: "item", page: "", id: "a" },
          fields: { text: "hello world", x: 2 },
        },
        // A new record's text: from "".
        {
          op: "set",
          key: { type: "item", page: "", id: "b" },
          fields: { text: "new", title: 7 as any },
        },
        { op: "delete", key: { type: "item", page: "", id: "c" } },
      ] as any,
      current,
      STRING_COLS,
    );
    expect(work).toEqual({ fields: 2, patches: 2, span: 0, work: 16 + 3 });
  });
});

describe("a changed file's merge work", () => {
  const keyOf = (r: any) => `${r.type}:${r.page}:${r.id}`;
  const item = (id: string, text: string, extra = {}) => ({
    type: "item",
    page: "",
    id,
    text,
    ...extra,
  });

  test("exact values: base → file and current → file, for each text field the file changed", () => {
    const base = [item("a", "hello"), item("b", "same"), item("gone", "x")];
    const current = [item("a", "hello brave"), item("b", "same")];
    const file = [
      item("a", "hello world", { x: 9 }),
      item("b", "same", { x: 3 }), // no text change: nothing
      item("new", "fresh"), // from "" on both sides
    ];
    const work = fileMergeWork({
      current,
      base,
      file,
      stringCols: STRING_COLS,
      keyOf,
    });
    const a1 = fieldWork("hello", "hello world");
    const a2 = fieldWork("hello brave", "hello world");
    const n = fieldWork("", "fresh");
    expect(work).toEqual({
      fields: 2,
      patches: a1.patches + a2.patches + 2 * n.patches,
      span: a1.span + a2.span + 2 * n.span,
      work: a1.work + a2.work + 2 * n.work,
    });
  });

  test("with no base, both sides are the current document", () => {
    const current = [item("a", "x".repeat(100))];
    const file = [item("a", "y".repeat(100))];
    const w = fieldWork("x".repeat(100), "y".repeat(100));
    expect(
      fileMergeWork({
        current,
        base: undefined,
        file,
        stringCols: STRING_COLS,
        keyOf,
      }),
    ).toEqual({
      fields: 1,
      patches: 2 * w.patches,
      span: 2 * w.span,
      work: 2 * w.work,
    });
  });

  test("an unchanged file is no work; a file that rewrites a long note is over the cap", () => {
    const current = [item("a", "a".repeat(200_000))];
    expect(
      fileMergeWork({
        current,
        base: current,
        file: current,
        stringCols: STRING_COLS,
        keyOf,
      }).work,
    ).toBe(0);
    const work = fileMergeWork({
      current,
      base: current,
      file: [item("a", "b".repeat(200_000))],
      stringCols: STRING_COLS,
      keyOf,
    });
    expect(editWorkRefusal(work)).toMatchObject({
      reason: "too-large",
      what: "work",
    });
  });

  test("its patches are never below the two diffs' real ones (1,000 random merges)", () => {
    const random = rng(20_10_2026);
    const word = () =>
      Array.from(
        { length: Math.floor(random() * 8) },
        () => "abc "[Math.floor(random() * 4)],
      ).join("");
    const mutate = (s: string) => {
      for (let e = Math.floor(random() * 6); e >= 0; e--) {
        const at = Math.floor(random() * (s.length + 1));
        s = s.slice(0, at) + word() + s.slice(at + Math.floor(random() * 6));
      }
      return s;
    };
    for (let i = 0; i < 1000; i++) {
      let start = "";
      for (let j = Math.floor(random() * 60); j > 0; j--) start += word();
      const base = mutate(start);
      const now = mutate(base);
      const file = mutate(base);
      const real =
        (base === file ? 0 : makePatch(base, file).length) +
        (now === file ? 0 : makePatch(now, file).length);
      const bound = fileMergeWork({
        current: [item("a", now)],
        base: [item("a", base)],
        file: [item("a", file)],
        stringCols: STRING_COLS,
        keyOf,
      }).patches;
      if (real > bound) {
        throw Error(
          `case ${i}: ${real} patches, over ${bound}: ${JSON.stringify({ base, now, file })}`,
        );
      }
    }
  });
});

test("an edit's own 'was' is never what its work is counted against", () => {
  const current = () => ({ text: "x".repeat(1000) });
  const change = {
    op: "set",
    key: { type: "item", page: "", id: "a" },
    fields: { text: "x".repeat(1000) + "!" },
    // What the frame says it saw: not what the host will diff.
    was: { text: "" },
  };
  expect(editWork([change] as any, current, STRING_COLS)).toEqual({
    fields: 1,
    patches: 1,
    span: 0,
    work: 2001,
  });
});

describe("the caps, just below and just above", () => {
  const field = (n: number) => ({
    op: "set",
    key: { type: "item", page: "", id: `n${n}` },
    fields: { text: "x" },
  });
  const none = () => undefined;

  test(`at most ${BOARD_EDIT_WORK_LIMITS.maxFields} text fields in one edit`, () => {
    const max = BOARD_EDIT_WORK_LIMITS.maxFields;
    const at = editWork(
      Array.from({ length: max }, (_, i) => field(i)) as any,
      none,
      STRING_COLS,
    );
    expect(editWorkRefusal(at)).toBeUndefined();
    const over = editWork(
      Array.from({ length: max + 1 }, (_, i) => field(i)) as any,
      none,
      STRING_COLS,
    );
    expect(editWorkRefusal(over)).toMatchObject({
      reason: "too-large",
      what: "work",
      limit: max,
      size: max + 1,
    });
  });

  test("at most the work cap", () => {
    const cap = BOARD_EDIT_WORK_LIMITS.maxWork;
    expect(editWorkRefusal({ fields: 1, patches: 1, span: 0, work: cap })).toBe(
      undefined,
    );
    expect(
      editWorkRefusal({ fields: 1, patches: 1, span: 0, work: cap + 1 }),
    ).toMatchObject({ what: "work", limit: cap, size: cap + 1 });
  });
});

// The board, an edit of some of its items' texts, and what committing it
// costs in the host's process: editState's preview and apply, and the
// syncdb document's patch (what SyncDoc's commit computes).
function commitCost({
  N,
  every,
  F,
  from = 0,
  to = 1,
}: {
  N: number;
  every: number;
  F: number;
  from?: number;
  to?: number;
}) {
  const text = (seed: string) => {
    let s = "";
    for (let i = 0; s.length < N; i++) {
      s += `${seed} ${i} `.padEnd(63, "abcdefghij klmnop ") + "\n";
    }
    return s.slice(0, N);
  };
  const edited = (s: string) => {
    const out = s.split("");
    const a = Math.floor(s.length * from);
    const b = Math.floor(s.length * to);
    for (let i = a + every - 1; i < b; i += every) {
      out[i] = out[i] === "X" ? "Y" : "X";
    }
    return out.join("");
  };
  const doc = lib.cleanDoc({
    format: "sagebrush-board",
    version: 1,
    title: "worst",
    nodes: Array.from({ length: F + 1 }, (_, i) => ({
      id: `n${i}`,
      text: text(`node${i}`),
      x: i,
      y: 0,
    })),
  });
  const records = lib.toRecords(doc) as any[];
  const items = records.filter((r) => r.type === "item").slice(0, F);
  const message = {
    sagebrush: "edit",
    version: 1,
    id: "7d0c2f5e-1b2a-4c3d-9e8f-0a1b2c3d4e5f",
    base: "r1",
    changes: items.map((r) => ({
      op: "set",
      key: { type: r.type, page: r.page, id: r.id },
      fields: { text: edited(r.text) },
      was: { text: r.text },
    })),
  };
  const es = editState(lib.canonical(doc), {
    pictures: "by-reference",
    previewBudget: sharedPreviewBudget({
      editBurst: 1e9,
      editsPerSecond: 1e9,
      workBurst: 1e15,
      workPerSecond: 1e15,
    }),
  });
  const byKey = new Map(records.map((r) => [`${r.type}:${r.page}:${r.id}`, r]));
  const t0 = performance.now();
  const preview = es.preview(message) as any;
  const work = editWork(
    preview.changes ?? [],
    (k) => byKey.get(`${k.type}:${k.page}:${k.id}`),
    STRING_COLS,
  );
  const applied = es.apply(message) as any;
  const old = from_str(
    recordsToString(records),
    BOARD_PRIMARY_KEYS,
    BOARD_STRING_COLS,
  ) as any;
  let next = old;
  for (const c of applied.changes ?? []) {
    next = next.set({
      ...byKey.get(`${c.key.type}:${c.key.page}:${c.key.id}`),
      ...c.fields,
    });
  }
  const rss0 = process.resourceUsage().maxRSS;
  const patch = old.make_patch(next);
  const ms = performance.now() - t0;
  const rssMB = (process.resourceUsage().maxRSS - rss0) / 1024;
  let hunks = 0;
  for (const x of JSON.parse(JSON.stringify(patch))[1] ?? []) {
    if (Array.isArray(x?.text)) hunks += x.text.length;
  }
  return {
    ok: preview.ok && applied.ok,
    editBytes: Buffer.byteLength(JSON.stringify(message)),
    patchBytes: Buffer.byteLength(JSON.stringify(patch)),
    work,
    refusal: editWorkRefusal(work),
    hunks,
    ms,
    rssMB,
  };
}

// Commit these (old text, new text) pairs, one item each, end to end:
// preview, apply, the syncdb document's patch.
function commitPairs(
  pairs: [string, string][],
  limits = BOARD_EDIT_WORK_LIMITS,
) {
  const doc = lib.cleanDoc({
    format: "sagebrush-board",
    version: 1,
    title: "pairs",
    nodes: pairs.map(([before], i) => ({
      id: `n${i}`,
      text: before,
      x: i,
      y: 0,
    })),
  });
  const records = lib.toRecords(doc) as any[];
  const items = records.filter((r) => r.type === "item");
  const message = {
    sagebrush: "edit",
    version: 1,
    id: "7d0c2f5e-1b2a-4c3d-9e8f-0a1b2c3d4e60",
    base: "r1",
    changes: items.map((r, i) => ({
      op: "set",
      key: { type: r.type, page: r.page, id: r.id },
      fields: { text: pairs[i][1] },
      was: { text: r.text },
    })),
  };
  const es = editState(lib.canonical(doc), {
    pictures: "by-reference",
    previewBudget: sharedPreviewBudget({
      editBurst: 1e9,
      editsPerSecond: 1e9,
      workBurst: 1e15,
      workPerSecond: 1e15,
    }),
  });
  const byKey = new Map(records.map((r) => [`${r.type}:${r.page}:${r.id}`, r]));
  const t0 = performance.now();
  const preview = es.preview(message) as any;
  const work = editWork(
    preview.changes ?? [],
    (k) => byKey.get(`${k.type}:${k.page}:${k.id}`),
    STRING_COLS,
  );
  const refusal = editWorkRefusal(work, limits);
  es.apply(message);
  const old = from_str(
    recordsToString(records),
    BOARD_PRIMARY_KEYS,
    BOARD_STRING_COLS,
  ) as any;
  let next = old;
  items.forEach((r, i) => (next = next.set({ ...r, text: pairs[i][1] })));
  const patch = old.make_patch(next);
  const ms = performance.now() - t0;
  return {
    ok: preview.ok === true,
    editBytes: Buffer.byteLength(JSON.stringify(message)),
    patchBytes: Buffer.byteLength(JSON.stringify(patch)),
    work,
    refusal,
    ms,
  };
}

describe("the work model, in both directions", () => {
  test("it is symmetric: an edit and its reverse cost the same", () => {
    const random = rng(1236);
    const shapes = [
      ["a".repeat(500), "b".repeat(200_000)],
      ["x", "x" + "b".repeat(10_000)],
      ["pre" + "a".repeat(3000) + "post", "pre" + "b".repeat(70) + "post"],
    ];
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(random() * 300);
      let a = "";
      for (let j = 0; j < len; j++) a += "abc"[Math.floor(random() * 3)];
      let b = a;
      for (let e = 0; e < 1 + Math.floor(random() * 6); e++) {
        const at = Math.floor(random() * (b.length + 1));
        b =
          b.slice(0, at) +
          "z".repeat(Math.floor(random() * 30)) +
          b.slice(at + Math.floor(random() * 30));
      }
      shapes.push([a, b]);
    }
    for (const [a, b] of shapes) {
      expect(fieldWork(a, b)).toEqual(fieldWork(b, a));
    }
  });

  test("astra's PERF-731-2 and its mirror are refused: two fields of 500 characters replaced by 200,000, and back", () => {
    const longer: [string, string] = ["a".repeat(500), "b".repeat(200_000)];
    for (const pair of [longer, [longer[1], longer[0]] as [string, string]]) {
      const work = editWork(
        [0, 1].map((i) => ({
          op: "set",
          key: { type: "item", page: "", id: `n${i}` },
          fields: { text: pair[1] },
        })) as any,
        () => ({ text: pair[0] }),
        STRING_COLS,
      );
      // (500 + 200,000)·200,000 per field: far over the cap.
      expect(work.work).toBeGreaterThan(2 * 200_500 * 200_000);
      expect(editWorkRefusal(work)).toMatchObject({
        reason: "too-large",
        what: "work",
      });
    }
  });

  test("pure insertions and deletions are one patch and no search, in either direction", () => {
    const insert = fieldWork("x", "x" + "b".repeat(200_000));
    expect(insert).toEqual({ patches: 1, span: 0, work: 200_002 });
    expect(fieldWork("x" + "b".repeat(200_000), "x")).toEqual(insert);
  });
});

describe("the worst edits, end to end", () => {
  test("the worst edit the limits admitted before G2 is refused now", () => {
    // Three 64 KiB texts, each edited every 50 characters: 390 KiB, a
    // 317 KiB patch, so within the commit's limits; it took about 520 ms
    // to commit on the reference host.
    const r = commitCost({ N: 64 * KiB, every: 50, F: 3 });
    expect(r.ok).toBe(true);
    expect(r.editBytes).toBeLessThanOrEqual(512 * KiB);
    expect(r.patchBytes).toBeLessThanOrEqual(512 * KiB);
    expect(r.refusal).toMatchObject({ reason: "too-large", what: "work" });
    expect(r.hunks).toBeLessThanOrEqual(r.work.patches);
  });

  test("calibration: a slower host gets a proportionally lower cap, never above the ceiling", () => {
    expect(calibrateEditWorkLimits(REFERENCE_LOOP_MS / 2).maxWork).toBe(
      BOARD_EDIT_WORK_CEILING,
    );
    expect(calibrateEditWorkLimits(REFERENCE_LOOP_MS).maxWork).toBe(
      BOARD_EDIT_WORK_CEILING,
    );
    expect(calibrateEditWorkLimits(REFERENCE_LOOP_MS * 4).maxWork).toBe(
      BOARD_EDIT_WORK_CEILING / 4,
    );
    expect(calibrateEditWorkLimits(NaN).maxWork).toBe(0);
    expect(calibrateEditWorkLimits(0).maxWork).toBe(0);
  });

  test("on this host's calibrated cap, the adversarial shapes tuned just under it commit within the normalized budget", () => {
    // This host's speed, against the reference host's, by the reference
    // loop; its cap; and its budget: 250 ms on the reference host, scaled
    // by how much slower this one is (the cap scales the same way).
    const ref = referenceLoopMs(makePatch);
    const limits = calibrateEditWorkLimits(ref);
    const budgetMs = 250 * Math.max(1, ref / REFERENCE_LOOP_MS);
    const shapes: { name: string; pair: (n: number) => [string, string] }[] = [
      { name: "replace 1:1", pair: (n) => ["a".repeat(n), "b".repeat(n)] },
      {
        name: "replace short->long",
        pair: (n) => ["a".repeat(Math.max(1, n >> 4)), "b".repeat(n)],
      },
      {
        name: "replace long->short",
        pair: (n) => ["a".repeat(n), "b".repeat(Math.max(1, n >> 4))],
      },
      {
        name: "scattered every 9th",
        pair: (n) => {
          const a = Array.from(
            { length: n },
            (_, i) => "abcdefghij"[i % 10],
          ).join("");
          return [
            a,
            a
              .split("")
              .map((c, i) => (i % 9 === 8 ? "X" : c))
              .join(""),
          ];
        },
      },
    ];
    const results: string[] = [];
    for (const shape of shapes) {
      for (const n of [512, 1024, 2048, 4096]) {
        const pair = shape.pair(n);
        const per = fieldWork(pair[0], pair[1]).work;
        const F = Math.min(64, Math.floor(limits.maxWork / per));
        if (F < 1) continue;
        const r = commitPairs(
          Array.from({ length: F }, () => pair),
          limits,
        );
        expect(r.ok).toBe(true);
        expect(r.refusal).toBeUndefined();
        expect(r.ms).toBeLessThan(budgetMs);
        results.push(`${shape.name} ${n}x${F}: ${Math.round(r.ms)} ms`);
        // One more field is over the cap.
        if (F < 64) {
          const over = commitPairs(
            Array.from({ length: F + 1 }, () => pair),
            limits,
          );
          expect(over.refusal).toMatchObject({ what: "work" });
        }
      }
    }
    console.log(
      `G2: reference loop ${Math.round(ref)} ms (reference host ${REFERENCE_LOOP_MS}), cap ${limits.maxWork}, budget ${Math.round(budgetMs)} ms; ${results.join("; ")}`,
    );
  });

  test("ordinary edits are far from the caps", () => {
    // In a 250 KiB note: typing a word in one place, replacing one word by
    // another, and pasting 20,000 characters.
    const note = "lorem ipsum dolor sit amet "
      .repeat(10_000)
      .slice(0, 250 * KiB);
    const mid = note.length >> 1;
    const typing = fieldWork(
      note,
      note.slice(0, mid) + "hello " + note.slice(mid),
    );
    const word = fieldWork(
      note,
      note.slice(0, mid) + "LOREM" + note.slice(mid + 5),
    );
    const paste = fieldWork(
      note,
      note.slice(0, mid) + "P".repeat(20_000) + note.slice(mid),
    );
    for (const w of [typing, word, paste]) {
      expect(w.patches).toBe(1);
      expect(w.work).toBeLessThan(BOARD_EDIT_WORK_LIMITS.maxWork / 20);
    }
  });
});
