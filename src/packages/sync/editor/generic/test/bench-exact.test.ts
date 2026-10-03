/*
Benchmark: exact values (codec.merge3) versus applying all patches in time order.

Opt-in: BENCH=1 pnpm exec jest editor/generic/test/bench-exact
(run node with --expose-gc for heap numbers). BENCH_N sets the history length.

Builds a synthetic history (typing-like edits with bursts of concurrent patches,
optionally a snapshot every 300 patches like SyncDoc), then for each mode
measures a cold load (new graph, add everything, value()), incremental editing
(add one patch and read the value, 200 times) and the retained heap.
*/

import { encodePatchId, PatchGraph, type Patch } from "patchflow";
import { StringDocument } from "../../string/doc";
import { stringMerge3 } from "../string-merge3";
import { dbCodec, makeRng, type Rng } from "../../sim";

const RUN = !!process.env.BENCH;
const N = Number(process.env.BENCH_N ?? 3000);

function stringCodec(exact: boolean) {
  const fromString = (s: string) => new StringDocument(s);
  return {
    fromString,
    toString: (d: any) => d.to_str(),
    applyPatch: (d: any, p: unknown) => d.apply_patch(p),
    applyPatchBatch: (d: any, ps: unknown[]) => d.apply_patch_batch(ps),
    makePatch: (a: any, b: any) => a.make_patch(b),
    ...(exact
      ? { merge3: stringMerge3<any>(fromString, (d: any) => d.to_str()) }
      : {}),
  };
}

function notebookCodec(exact: boolean) {
  const c = dbCodec({ primaryKeys: ["type", "id"], stringCols: ["input"] });
  if (!exact) delete (c as any).merge3;
  return c;
}

const WORDS =
  "alpha beta gamma delta sum plot import numpy range print return x y".split(
    " ",
  );
const word = (rng: Rng) => WORDS[Math.floor(rng() * WORDS.length)];

// A typing-like edit near a moving cursor.
function editText(text: string, rng: Rng, cursor: { at: number }): string {
  if (rng() < 0.05) cursor.at = Math.floor(rng() * (text.length + 1));
  const at = Math.min(cursor.at, text.length);
  const r = rng();
  if (r < 0.7) {
    const ins = (rng() < 0.15 ? "\n" : " ") + word(rng);
    cursor.at = at + ins.length;
    return text.slice(0, at) + ins + text.slice(at);
  }
  if (r < 0.9) {
    const n = 1 + Math.floor(rng() * 8);
    cursor.at = Math.max(0, at - n);
    return text.slice(0, Math.max(0, at - n)) + text.slice(at);
  }
  const para = Array.from({ length: 30 }, () => word(rng)).join(" ") + "\n";
  return text.slice(0, at) + para + text.slice(at);
}

type Kind = "text" | "notebook";

interface Model {
  next(rng: Rng, client: number): any; // new document from the current one
}

function textModel(codec: any, size: number, get: () => any): Model {
  const cursors = [0, 1, 2, 3].map(() => ({ at: Math.floor(size / 2) }));
  return {
    next(rng, client) {
      let t = get().to_str();
      if (t.length === 0) {
        t = Array.from({ length: size / 6 }, () => word(rng)).join(" ");
      }
      return codec.fromString(editText(t, rng, cursors[client]));
    },
  };
}

function notebookModel(codec: any, cells: number, get: () => any): Model {
  const cursors = new Map<string, { at: number }>();
  return {
    next(rng) {
      const s: string = get().to_str();
      let records = s
        ? s
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
      if (records.length === 0) {
        records = Array.from({ length: cells }, (_, i) => ({
          type: "cell",
          id: `c${i}`,
          pos: i,
          cell_type: "code",
          input: Array.from({ length: 40 }, () => word(rng)).join(" "),
        }));
      }
      const r = rng();
      const cellRecs = records.filter((x) => x.type === "cell");
      const cell = cellRecs[Math.floor(rng() * cellRecs.length)];
      if (r < 0.75 && cell) {
        const cur = cursors.get(cell.id) ?? { at: cell.input.length };
        cursors.set(cell.id, cur);
        cell.input = editText(cell.input, rng, cur);
      } else if (r < 0.9 && cell) {
        cell.output = { 0: { text: `out ${Math.floor(rng() * 1e6)}` } };
        cell.exec_count = Math.floor(rng() * 100);
      } else if (r < 0.97) {
        const id = `n${Math.floor(rng() * 1e9)}`;
        records.push({
          type: "cell",
          id,
          pos: rng() * cells,
          cell_type: "code",
          input: word(rng),
        });
      } else if (cell && cellRecs.length > 5) {
        records = records.filter((x) => x !== cell);
      }
      return codec.fromString(records.map((x) => JSON.stringify(x)).join("\n"));
    },
  };
}

function generate(
  kind: Kind,
  n: number,
  snapshots: boolean,
  seed = 1,
): Patch[] {
  const rng = makeRng(seed);
  const codec = kind === "text" ? stringCodec(true) : notebookCodec(true);
  const g = new PatchGraph({ codec: codec as any });
  const current = () =>
    g.getHeads().length ? g.value() : codec.fromString("");
  const model =
    kind === "text"
      ? textModel(codec, 40_000, current)
      : notebookModel(codec, 60, current);
  const patches: Patch[] = [];
  let t = 1_000_000;
  let count = 0;
  let sinceSnapshot = 0;
  while (count < n) {
    const heads = g.getHeads();
    const base = current();
    // About 1 in 8 steps is a burst of concurrent edits by 2-3 people.
    const burst = count > 0 && rng() < 0.125 ? 2 + Math.floor(rng() * 2) : 1;
    const batch: Patch[] = [];
    for (let b = 0; b < burst; b++) {
      const next = model.next(rng, b);
      t += 1 + Math.floor(rng() * 500);
      batch.push({
        time: encodePatchId(t, `client${b}`),
        wall: t,
        patch: codec.makePatch(base, next),
        parents: heads.slice(),
        userId: b + 1,
        version: count + b + 1,
      });
    }
    g.add(batch);
    patches.push(...batch);
    count += burst;
    sinceSnapshot += burst;
    if (snapshots && sinceSnapshot >= 300 && g.getHeads().length === 1) {
      // SyncDoc snapshots a single head; the snapshot record replaces the patch.
      const head = g.getHeads()[0];
      const snap = {
        ...g.getPatch(head),
        isSnapshot: true,
        snapshot: g.value({ time: head }).to_str(),
      };
      g.add([snap]);
      patches[patches.findIndex((p) => p.time === head)] = snap;
      sinceSnapshot = 0;
    }
  }
  return patches;
}

function heapMB(): number {
  (global as any).gc?.();
  return process.memoryUsage().heapUsed / 1e6;
}

function measure(kind: Kind, exact: boolean, history: Patch[], extra: Patch[]) {
  const codec = kind === "text" ? stringCodec(exact) : notebookCodec(exact);
  const before = heapMB();
  let t0 = performance.now();
  const g = new PatchGraph({ codec: codec as any });
  g.add(history);
  const value = g.value().to_str();
  const cold = performance.now() - t0;
  t0 = performance.now();
  for (const p of extra) {
    g.add([p]);
    g.value();
  }
  const incremental = (performance.now() - t0) / extra.length;
  const heap = heapMB() - before;
  return { cold, incremental, heap, value, graph: g };
}

// Patches continuing a history, each a single edit on the current head.
function continuation(kind: Kind, history: Patch[], m: number): Patch[] {
  const codec = kind === "text" ? stringCodec(true) : notebookCodec(true);
  const g = new PatchGraph({ codec: codec as any });
  g.add(history);
  const rng = makeRng(99);
  const model =
    kind === "text"
      ? textModel(codec, 40_000, () => g.value())
      : notebookModel(codec, 60, () => g.value());
  let t = 2_000_000_000;
  const out: Patch[] = [];
  for (let i = 0; i < m; i++) {
    const base = g.value();
    const next = model.next(rng, 0);
    t += 100;
    const p = {
      time: encodePatchId(t, "client0"),
      wall: t,
      patch: codec.makePatch(base, next),
      parents: g.getHeads(),
      userId: 1,
    };
    g.add([p]);
    out.push(p);
  }
  return out;
}

(process.env.BENCH_PROFILE ? it : it.skip)(
  "profile notebook exact load",
  () => {
    const history = generate("notebook", N, false);
    const codec: any = notebookCodec(true);
    const acc = { apply: 0, merge: 0, nApply: 0, nMerge: 0, from: 0 };
    const wrap =
      (
        name: string,
        fn: any,
        key: "apply" | "merge" | "from",
        count?: "nApply" | "nMerge",
      ) =>
      (...args: any[]) => {
        const t0 = performance.now();
        const out = fn(...args);
        acc[key] += performance.now() - t0;
        if (count) acc[count]++;
        return out;
      };
    codec.applyPatch = wrap("apply", codec.applyPatch, "apply", "nApply");
    codec.merge3 = wrap("merge", codec.merge3, "merge", "nMerge");
    codec.fromString = wrap("from", codec.fromString, "from");
    const t0 = performance.now();
    const g = new PatchGraph({ codec });
    g.add(history);
    g.value();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ total: performance.now() - t0, ...acc }));
  },
  600_000,
);

(process.env.BENCH_PROFILE ? it : it.skip)(
  "profile text edits",
  () => {
    const history = generate("text", N, true);
    const extra = continuation("text", history, 200);
    const codec: any = stringCodec(true);
    const acc: any = { apply: 0, add: 0, value: 0, make: 0 };
    const apply = codec.applyPatch;
    codec.applyPatch = (d: any, p: any) => {
      const t0 = performance.now();
      const out = apply(d, p);
      acc.apply += performance.now() - t0;
      return out;
    };
    const g = new PatchGraph({ codec });
    g.add(history);
    g.value();
    acc.apply = 0;
    for (const p of extra) {
      let t0 = performance.now();
      g.add([p]);
      acc.add += performance.now() - t0;
      t0 = performance.now();
      g.value();
      acc.value += performance.now() - t0;
    }
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(acc).map(([k, v]: any) => [
            k,
            (v / extra.length).toFixed(3),
          ]),
        ),
      ),
    );
  },
  600_000,
);

(RUN ? describe : describe.skip)("exact values benchmark", () => {
  for (const kind of ["text", "notebook"] as Kind[]) {
    for (const snapshots of [false, true]) {
      it(`${kind}, ${N} patches, ${snapshots ? "snapshots every 300" : "no snapshots"}`, () => {
        const history = generate(kind, N, snapshots);
        const extra = continuation(kind, history, 200);
        const rows: string[] = [];
        const values: string[] = [];
        for (const exact of [false, true]) {
          const r = measure(kind, exact, history, extra);
          values.push(r.value);
          rows.push(
            `${exact ? "exact    " : "apply-all"}  cold ${r.cold.toFixed(0).padStart(6)} ms  ` +
              `edit ${r.incremental.toFixed(2).padStart(7)} ms/patch  heap ${r.heap.toFixed(0).padStart(5)} MB`,
          );
        }
        const size = values[1].length;
        const differ = values[0] !== values[1];
        // eslint-disable-next-line no-console
        console.log(
          `${kind}, ${history.length} patches, ${snapshots ? "snapshots" : "no snapshots"}, ` +
            `final size ${(size / 1000).toFixed(0)} kB${differ ? ", apply-all value differs" : ""}\n` +
            rows.join("\n"),
        );
      }, 1_800_000);
    }
  }
});
