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
  BOARD_EDIT_WORK_LIMITS,
  editWork,
  editWorkRefusal,
  fieldWork,
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
    // A replacement of 16 characters by 20: m = 16, k ≤ 16/8 + 1 = 3.
    expect(
      fieldWork(`pre${"a".repeat(16)}post`, `pre${"b".repeat(20)}post`),
    ).toEqual({ patches: 3, span: 16, work: 3 * (23 + 27) + 256 });
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

describe("the worst edits, end to end", () => {
  test("the worst edit the limits admitted before G2 is refused now", () => {
    // Three 64 KiB texts, each edited every 50 characters: 390 KiB, a
    // 317 KiB patch, so within the commit's limits; it took about 520 ms
    // to commit on a development machine.
    const r = commitCost({ N: 64 * KiB, every: 50, F: 3 });
    expect(r.ok).toBe(true);
    expect(r.editBytes).toBeLessThanOrEqual(512 * KiB);
    expect(r.patchBytes).toBeLessThanOrEqual(512 * KiB);
    expect(r.refusal).toMatchObject({ reason: "too-large", what: "work" });
    expect(r.hunks).toBeLessThanOrEqual(r.work.patches);
  });

  test("the worst edit the caps admit commits within the budget; one more field is refused", () => {
    // Found by the probe (edit-cost-probe.test.ts): 1 KiB texts, every 9th
    // character changed, as many as the work cap allows.
    const r = commitCost({ N: KiB, every: 9, F: 37 });
    expect(r.ok).toBe(true);
    expect(r.refusal).toBeUndefined();
    expect(r.work.work).toBeLessThanOrEqual(BOARD_EDIT_WORK_LIMITS.maxWork);
    expect(r.hunks).toBeLessThanOrEqual(r.work.patches);
    // The budget is 250 ms on a development machine (about 120 ms there);
    // CI machines are slower and shared, so this only catches regressions
    // of several times.
    expect(r.ms).toBeLessThan(1000);
    expect(r.rssMB).toBeLessThan(128);
    console.log(
      `G2 worst admitted: ${Math.round(r.ms)} ms, ${r.hunks} patches (bound ${r.work.patches}), work ${r.work.work}, +${Math.round(r.rssMB)} MB peak RSS`,
    );
    const over = commitCost({ N: KiB, every: 9, F: 38 });
    expect(over.refusal).toMatchObject({ reason: "too-large", what: "work" });
  });

  test("ordinary edits are far from the caps", () => {
    // Typing in one place in a 250 KiB note, and pasting 20,000 characters.
    const typing = commitCost({
      N: 250 * KiB,
      every: 9,
      F: 1,
      from: 0.5,
      to: 0.5005,
    });
    expect(typing.refusal).toBeUndefined();
    expect(typing.work.work).toBeLessThan(BOARD_EDIT_WORK_LIMITS.maxWork / 4);
    const paste = fieldWork(
      "a".repeat(100_000),
      "a".repeat(50_000) + "P".repeat(20_000) + "a".repeat(50_000),
    );
    expect(paste.patches).toBe(1);
    expect(paste.work).toBeLessThan(BOARD_EDIT_WORK_LIMITS.maxWork / 100);
  });
});
