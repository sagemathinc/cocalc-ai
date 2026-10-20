/*
G2 probe (A2b design 8c): the in-process cost of one admitted edit, over a
grid of shapes, with the limits as they are. Run with G2_PROBE=1; prints a
table. Not a regression test (edit-cost.test.ts is).
*/

import * as lib from "@sagemathinc/sagebrush-board";
import {
  editState,
  sharedPreviewBudget,
} from "@sagemathinc/sagebrush-board/submission";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
} from "@cocalc/util/board/names";
import { recordsToString } from "./service";

const KiB = 1024;
const probe = process.env.G2_PROBE === "1" ? test : test.skip;

function text(n: number, seed: string): string {
  const lines: string[] = [];
  let i = 0;
  while (lines.join("\n").length < n) {
    lines.push(`${seed} ${i++} `.padEnd(63, "abcdefghij klmnop "));
  }
  return lines.join("\n").slice(0, n);
}

// Every `every`-th character changed, within the window [from, to) (as
// fractions of the text); `paste` inserts that many characters instead.
let shape = { from: 0, to: 1, paste: 0 };
function dense(s: string, every: number): string {
  if (shape.paste > 0) {
    const at = Math.floor(s.length * shape.from);
    return s.slice(0, at) + "P".repeat(shape.paste) + s.slice(at);
  }
  const out = s.split("");
  const a = Math.floor(out.length * shape.from);
  const b = Math.floor(out.length * shape.to);
  for (let i = a + every - 1; i < b; i += every) {
    out[i] = out[i] === "X" ? "Y" : "X";
  }
  return out.join("");
}

// The bound on the patches a field's diff can have, from the edit alone:
// after the common prefix and suffix, patches are separated by at least 8
// equal characters, found in both middles.
function bound(a: string, b: string) {
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let q = 0;
  while (
    q < n - p &&
    a.charCodeAt(a.length - 1 - q) === b.charCodeAt(b.length - 1 - q)
  )
    q++;
  const mo = a.length - p - q;
  const mn = b.length - p - q;
  const m = Math.min(mo, mn);
  const k = mo + mn === 0 ? 0 : m === 0 ? 1 : Math.floor(m / 8) + 1;
  return { k, m, N: a.length + b.length };
}

function run(N: number, every: number, F: number) {
  const nodes = Array.from({ length: F + 2 }, (_, i) => ({
    id: `n${i}`,
    text: text(N, `node${i}`),
    x: i * 10,
    y: 0,
  }));
  const doc = lib.cleanDoc({
    format: "sagebrush-board",
    version: 1,
    title: "probe",
    nodes,
  });
  const boardText = lib.canonical(doc);
  const budget = sharedPreviewBudget({
    editBurst: 1e9,
    editsPerSecond: 1e9,
    workBurst: 1e15,
    workPerSecond: 1e15,
  });
  const es = editState(boardText, {
    pictures: "by-reference",
    previewBudget: budget,
  });
  const records = lib.toRecords(doc) as any[];
  const items = records.filter((r) => r.type === "item").slice(0, F);
  const message = {
    sagebrush: "edit",
    version: 1,
    id: "0b6d1f0e-2a7c-4d39-9b0a-3c2f8e5d7a11",
    base: "r1",
    changes: items.map((r) => ({
      op: "set",
      key: { type: r.type, page: r.page, id: r.id },
      fields: { text: dense(r.text, every) },
      was: { text: r.text },
    })),
  };
  const editBytes = Buffer.byteLength(JSON.stringify(message));
  let t = performance.now();
  const preview = es.preview(message) as any;
  const previewMs = performance.now() - t;
  if (!preview.ok && process.env.G2_PROBE_WHY) {
    console.log(
      "WHY",
      JSON.stringify({ ...preview, changes: undefined }),
      JSON.stringify(records.slice(0, 3)).slice(0, 400),
    );
  }
  t = performance.now();
  const applied = es.apply(message) as any;
  const applyMs = performance.now() - t;
  const old = from_str(
    recordsToString(records),
    BOARD_PRIMARY_KEYS,
    BOARD_STRING_COLS,
  ) as any;
  let next = old;
  for (const r of items) next = next.set({ ...r, text: dense(r.text, every) });
  const rss0 = process.resourceUsage().maxRSS;
  t = performance.now();
  const patch = old.make_patch(next);
  const patchMs = performance.now() - t;
  const rss1 = process.resourceUsage().maxRSS;
  const patchBytes = Buffer.byteLength(JSON.stringify(patch));
  // Hunks: the text patches' entries.
  let hunks = 0;
  for (const x of JSON.parse(JSON.stringify(patch))[1] ?? []) {
    if (Array.isArray(x?.text)) hunks += x.text.length;
  }
  let K = 0;
  let W = 0;
  let S = 0;
  for (const r of items) {
    const b = bound(r.text, dense(r.text, every));
    K += b.k;
    W += b.k * b.N + b.m * b.m;
    S += b.m;
  }
  return {
    N,
    every,
    F,
    win: shape.paste ? `paste${shape.paste}` : `${shape.from}-${shape.to}`,
    K,
    W: Math.round(W / 1e6),
    S,
    totalMs: Math.round(previewMs + applyMs + patchMs),
    editKiB: Math.round(editBytes / KiB),
    admitted: preview.ok && editBytes <= 512 * KiB && patchBytes <= 512 * KiB,
    previewOk: preview.ok === true,
    applyOk: applied.ok === true,
    previewMs: Math.round(previewMs),
    applyMs: Math.round(applyMs),
    patchMs: Math.round(patchMs),
    patchKiB: Math.round(patchBytes / KiB),
    hunks,
    rssRaisedMB: Math.round((rss1 - rss0) / 1024),
  };
}

// The worst admitted edit under a work cap, over field sizes, densities,
// windows and numbers of fields (estimated W first; run those near the cap).
probe(
  "the worst edit under a work cap",
  () => {
    const cap = Number(process.env.G2_CAP ?? 64e6);
    const rows: any[] = [];
    for (const N of [1, 2, 4, 8, 16, 32, 64, 128, 250].map((k) => k * KiB)) {
      for (const every of [9, 10, 16, 64]) {
        for (const frac of [1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005]) {
          const m = Math.floor(N * frac);
          const per = (Math.floor(m / 8) + 1) * 2 * N + m * m;
          const maxF = Math.min(
            Number(process.env.G2_FIELDS ?? 200),
            Math.floor((500 * KiB) / (2 * N)),
          );
          const F = Math.min(maxF, Math.floor(cap / per));
          if (F < 1 || F * per < cap / 3) continue;
          shape =
            frac >= 1
              ? { from: 0, to: 1, paste: 0 }
              : { from: 0.5 - frac / 2, to: 0.5 + frac / 2, paste: 0 };
          const r = run(N, every, F);
          if (r.W * 1e6 <= cap && r.admitted) rows.push(r);
        }
      }
    }
    rows.sort((a, b) => b.totalMs - a.totalMs);
    console.log(JSON.stringify(rows.slice(0, 8)));
  },
  30 * 60_000,
);

probe(
  "the cost of one edit, by shape",
  () => {
    const rows: any[] = [];
    const shapes = [
      { from: 0, to: 1, paste: 0 },
      { from: 0.4, to: 0.45, paste: 0 },
      { from: 0.5, to: 0.51, paste: 0 },
      { from: 0.5, to: 0.5, paste: 20_000 },
    ];
    for (const sh of shapes) {
      shape = sh;
      for (const N of [16 * KiB, 64 * KiB, 250 * KiB]) {
        for (const every of sh.paste ? [10] : [10, 50, 400]) {
          // As many fields as fit an edit of at most 512 KiB (was + new).
          const F = Math.max(1, Math.min(8, Math.floor((500 * KiB) / (2 * N))));
          rows.push(run(N, every, F));
        }
      }
    }
    console.log(JSON.stringify(rows));
  },
  20 * 60_000,
);

// Adversarial shapes under a work cap with the shipped model (edit-cost.ts):
// unequal replacements both ways (astra's PERF-731-2 and its mirror), pure
// insertions and deletions, and dense equal-length edits, each with as many
// fields as fit under the cap and the 512 KiB edit.
import { fieldWork } from "./edit-cost";

function pairCost(pairs: [string, string][]) {
  const nodes = pairs.map(([before], i) => ({
    id: `n${i}`,
    text: before,
    x: i,
    y: 0,
  }));
  const doc = lib.cleanDoc({
    format: "sagebrush-board",
    version: 1,
    title: "p",
    nodes,
  });
  const records = lib.toRecords(doc) as any[];
  const items = records.filter((r) => r.type === "item");
  const message = {
    sagebrush: "edit",
    version: 1,
    id: "0b6d1f0e-2a7c-4d39-9b0a-3c2f8e5d7a12",
    base: "r1",
    changes: items.map((r, i) => ({
      op: "set",
      key: { type: r.type, page: r.page, id: r.id },
      fields: { text: pairs[i][1] },
      was: { text: r.text },
    })),
  };
  const editBytes = Buffer.byteLength(JSON.stringify(message));
  const es = editState(lib.canonical(doc), {
    pictures: "by-reference",
    previewBudget: sharedPreviewBudget({
      editBurst: 1e9,
      editsPerSecond: 1e9,
      workBurst: 1e15,
      workPerSecond: 1e15,
    }),
  });
  let t = performance.now();
  const preview = es.preview(message) as any;
  es.apply(message);
  const old = from_str(
    recordsToString(records),
    BOARD_PRIMARY_KEYS,
    BOARD_STRING_COLS,
  ) as any;
  let next = old;
  items.forEach((r, i) => (next = next.set({ ...r, text: pairs[i][1] })));
  const patch = old.make_patch(next);
  const ms = performance.now() - t;
  const patchBytes = Buffer.byteLength(JSON.stringify(patch));
  let W = 0;
  for (const [a, b] of pairs) W += fieldWork(a, b).work;
  return { ok: preview.ok, editBytes, patchBytes, W, ms };
}

probe(
  "adversarial shapes under the cap",
  () => {
    const cap = Number(process.env.G2_CAP ?? 24e6);
    const KiBs = 1024;
    const rows: any[] = [];
    const scattered = (n: number, every: number) => {
      const a = Array.from({ length: n }, (_, i) => "abcdefghij"[i % 10]).join(
        "",
      );
      const b = a
        .split("")
        .map((c, i) => (i % every === every - 1 ? "X" : c))
        .join("");
      return [a, b] as [string, string];
    };
    const shapes: { name: string; pair: (size: number) => [string, string] }[] =
      [
        {
          name: "replace a->B",
          pair: (n) => [
            "a".repeat(Math.max(1, Math.floor(n / 400))),
            "b".repeat(n),
          ],
        },
        {
          name: "replace A->b",
          pair: (n) => [
            "a".repeat(n),
            "b".repeat(Math.max(1, Math.floor(n / 400))),
          ],
        },
        {
          name: "replace 1:10",
          pair: (n) => ["a".repeat(Math.floor(n / 10)), "b".repeat(n)],
        },
        {
          name: "replace 10:1",
          pair: (n) => ["a".repeat(n), "b".repeat(Math.floor(n / 10))],
        },
        { name: "replace 1:1", pair: (n) => ["a".repeat(n), "b".repeat(n)] },
        {
          name: "replace mixed",
          pair: (n) => ["ab".repeat(n / 2), "ba".repeat(n / 2)],
        },
        { name: "insert", pair: (n) => ["x", "x" + "b".repeat(n)] },
        { name: "delete", pair: (n) => ["x" + "b".repeat(n), "x"] },
        { name: "scattered/9", pair: (n) => scattered(n, 9) },
        { name: "scattered/40", pair: (n) => scattered(n, 40) },
      ];
    for (const shape of shapes) {
      for (const size of [
        256,
        1024,
        2048,
        4096,
        8192,
        16384,
        32768,
        65536,
        128 * KiBs,
        200000,
        250 * KiBs,
      ]) {
        const pair = shape.pair(size);
        const w = fieldWork(pair[0], pair[1]).work;
        if (w === 0 || w > cap) continue;
        const bytes = pair[0].length + pair[1].length;
        const F = Math.max(
          1,
          Math.min(64, Math.floor(cap / w), Math.floor((500 * KiBs) / bytes)),
        );
        const r = pairCost(Array.from({ length: F }, () => pair));
        if (
          r.W > cap ||
          r.editBytes > 512 * KiBs ||
          r.patchBytes > 512 * KiBs ||
          !r.ok
        )
          continue;
        rows.push({ shape: shape.name, size, F, W: r.W, ms: Math.round(r.ms) });
      }
    }
    rows.sort((a, b) => b.ms - a.ms);
    console.log(JSON.stringify(rows.slice(0, 12)));
  },
  30 * 60_000,
);
