/*
G1's open check against patchflow itself: on random small histories, every
history the check accepts is one patchflow agrees is a clean cut plus one
chain (PatchGraph.isCut on the cut, exactly one head, the check's head), and
every refusal is a history where that does not hold.
*/

import { legacyPatchId, PatchGraph, StringCodec } from "@cocalc/sync/patchflow";
import {
  BoardAppendCheck,
  BoardHistoryCheck,
} from "@cocalc/conat/persist/board-history";

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

interface Rec {
  time: string;
  parents: string[];
}

// A random history of n patches: mostly a chain, with branches, merges,
// extra roots and missing parents now and then; and maybe a snapshot.
function history(random: () => number, n: number) {
  const ids = Array.from({ length: n }, (_, i) => legacyPatchId(i + 1));
  const patches: Rec[] = [];
  for (let i = 0; i < n; i++) {
    const r = random();
    let parents: string[];
    if (i === 0 || r < 0.05) parents = [];
    else if (r < 0.75) parents = [ids[i - 1]];
    else if (r < 0.88) parents = [ids[Math.floor(random() * i)]];
    else if (r < 0.95 && i >= 2) {
      const a = Math.floor(random() * i);
      let b = Math.floor(random() * i);
      if (b === a) b = (a + 1) % i;
      parents = [ids[a], ids[b]];
    } else parents = [legacyPatchId(1000 + i)]; // missing
    patches.push({ time: ids[i], parents });
  }
  const snapshot = random() < 0.6 ? ids[Math.floor(random() * n)] : undefined;
  return { patches, snapshot };
}

function ourCheck(patches: Rec[], snapshot?: string) {
  const c = new BoardHistoryCheck();
  for (const p of patches) {
    c.add({ ...p, patch: "[]" }, 100);
  }
  if (snapshot != null) {
    c.add({ time: snapshot, is_snapshot: true, snapshot: "" }, 100);
  }
  return c.finish();
}

// What patchflow says: is it a clean cut plus one chain after it?
function patchflowSays(patches: Rec[], snapshot?: string) {
  const graph = new PatchGraph({ codec: StringCodec as any });
  graph.add(
    patches.map((p) => ({
      time: p.time,
      parents: p.parents,
      patch: StringCodec.makePatch(
        StringCodec.fromString(""),
        StringCodec.fromString(""),
      ),
      ...(p.time === snapshot ? { isSnapshot: true, snapshot: "" } : {}),
    })) as any,
  );
  const known = new Set(patches.map((p) => p.time));
  const heads = graph.getHeads();
  if (heads.length !== 1) return { linear: false };
  // The chain from the start (the cut, or the one root) to the head: each
  // link has one parent, the one before, and is its only child.
  const children = new Map<string, string[]>();
  for (const p of patches)
    for (const q of p.parents) {
      children.set(q, [...(children.get(q) ?? []), p.time]);
    }
  let start: string | undefined = snapshot;
  if (start == null) {
    const roots = patches.filter((p) => p.parents.length === 0);
    if (roots.length !== 1) return { linear: false };
    start = roots[0].time;
  } else if (!graph.isCut(start)) {
    return { linear: false };
  }
  let cur = start;
  for (;;) {
    const kids = children.get(cur) ?? [];
    if (kids.length === 0) break;
    if (kids.length > 1) return { linear: false };
    const kid = patches.find((p) => p.time === kids[0])!;
    if (kid.parents.length !== 1) return { linear: false };
    cur = kid.time;
  }
  // Without a snapshot, every patch must be on the chain (no missing
  // parents anywhere); with one, every patch is related to the cut.
  if (snapshot == null) {
    if (patches.some((p) => p.parents.some((q) => !known.has(q)))) {
      return { linear: false };
    }
  }
  return { linear: true, head: heads[0] };
}

test("the open check agrees with patchflow on 3,000 random histories", () => {
  const random = rng(20261020);
  let accepted = 0;
  for (let i = 0; i < 3000; i++) {
    const { patches, snapshot } = history(
      random,
      2 + Math.floor(random() * 10),
    );
    // A snapshot is of a patch the history has.
    const ours = ourCheck(patches, snapshot);
    const theirs = patchflowSays(patches, snapshot);
    if (ours.ok) {
      accepted += 1;
      expect({ i, ...theirs }).toEqual({
        i,
        linear: true,
        head: ours.head,
      });
    } else {
      // Refused: patchflow sees no clean cut plus one chain, or a missing
      // parent after the cut (which patchflow tolerates, and G1 doesn't).
      if (theirs.linear) {
        expect(ours.reason).toBe("incomplete");
      }
    }
  }
  // Both outcomes are exercised.
  expect(accepted).toBeGreaterThan(300);
  expect(accepted).toBeLessThan(2700);
});

// The write service's append rule against patchflow: random sequences of
// appends, including retries, conflicting re-appends, branches, second roots
// and snapshots of known and unknown patches.
function graphHeads(records: any[]): string[] {
  const graph = new PatchGraph({ codec: StringCodec as any });
  const empty = StringCodec.makePatch(
    StringCodec.fromString(""),
    StringCodec.fromString(""),
  );
  graph.add(
    records.map((r) =>
      r.is_snapshot
        ? { time: r.time, isSnapshot: true, snapshot: "", parents: [] }
        : { time: r.time, parents: r.parents, patch: empty },
    ) as any,
  );
  return graph.getHeads();
}

test("the append rule agrees with patchflow on 2,000 random append sequences", () => {
  const random = rng(4242);
  let accepted = 0;
  let refused = 0;
  for (let run = 0; run < 2000; run++) {
    const stored: any[] = [];
    const guard = BoardAppendCheck.fromRecords([], 0);
    const ids: string[] = [];
    let next = 1;
    const fresh = () => legacyPatchId(next++);
    const pick = () => ids[Math.floor(random() * ids.length)];
    for (let step = 0; step < 12; step++) {
      const batch: any[] = [];
      const size = 1 + Math.floor(random() * 3);
      for (let k = 0; k < size; k++) {
        const r = random();
        const head = guard.currentHead;
        const lastInBatch = [...batch].reverse().find((x) => !x.is_snapshot);
        const tip = lastInBatch?.time ?? head;
        if (r < 0.45 || ids.length === 0) {
          batch.push({
            time: fresh(),
            parents: tip == null ? [] : [tip],
            patch: "[]",
          });
        } else if (r < 0.55) {
          batch.push({ time: fresh(), parents: [pick()], patch: "[]" });
        } else if (r < 0.6) {
          batch.push({ time: fresh(), parents: [], patch: "[]" });
        } else if (r < 0.7) {
          // A retry of a stored patch.
          const t = pick();
          const same = stored.find((x) => x.time === t && !x.is_snapshot);
          if (same) batch.push({ ...same });
        } else if (r < 0.78) {
          // Its time again, with other parents.
          batch.push({ time: pick(), parents: [pick()], patch: "[]" });
        } else if (r < 0.9) {
          batch.push({ time: pick(), is_snapshot: true, snapshot: "" });
        } else {
          batch.push({
            time: legacyPatchId(5000 + next++),
            is_snapshot: true,
            snapshot: "",
          });
        }
      }
      if (batch.length === 0) continue;
      let ok = true;
      try {
        const result = guard.check(batch);
        guard.commit(result, stored.length + batch.length);
      } catch {
        ok = false;
      }
      if (ok) {
        accepted += 1;
        stored.push(...batch);
        for (const r of batch)
          if (!r.is_snapshot && !ids.includes(r.time)) ids.push(r.time);
        // Sound: patchflow sees exactly one head, the guard's.
        expect({ run, step, heads: graphHeads(stored) }).toEqual({
          run,
          step,
          heads: [guard.currentHead],
        });
      } else {
        refused += 1;
        // Complete: a refused batch would not leave patchflow one head, or
        // re-appends a stored time with other parents (which patchflow
        // would silently ignore, keeping the first).
        const heads = graphHeads([...stored, ...batch]);
        const conflicting = batch.some((r) => {
          if (r.is_snapshot) return false;
          const first = [...stored, ...batch].find(
            (x) => x.time === r.time && !x.is_snapshot,
          );
          return (
            first !== r &&
            JSON.stringify(first.parents) !== JSON.stringify(r.parents)
          );
        });
        if (!conflicting) {
          expect({ run, step, heads: heads.length }).not.toEqual({
            run,
            step,
            heads: 1,
          });
        }
      }
    }
  }
  expect(accepted).toBeGreaterThan(2000);
  expect(refused).toBeGreaterThan(2000);
});
