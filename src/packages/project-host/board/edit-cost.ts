/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What an edit costs the host to commit, counted from the edit itself (A2b
design, section 8c, G2), so the same edit is admitted or refused on any one
host, before any of that work is done.

Committing an edit diffs each text field it changes (the syncdb's string
columns), old value to new, with diff-match-patch: diff_main over the part
that changed, then patch_make, which for each patch it makes scans the whole
text (patch_addContext_). After the common prefix and suffix, call the two
changed middles m_a (old) and m_b (new) and N the field's length (old plus
new). A field's work is charged as

    k·N + (m_a + m_b)·max(m_a, m_b)        (0 for the second term when
                                            min(m_a, m_b) = 0)

- k bounds the patches: diff-match-patch starts a new patch only after 8 or
  more equal characters, found in both middles, so k ≤ ⌊min(m_a, m_b)/8⌋ + 1,
  and 1 for a pure insertion or deletion.
- The second term charges diff_main's search in both middles' lengths (its
  bisection is O((m_a + m_b)·D), D ≤ m_a + m_b); a pure insertion or deletion
  is one diff, with no search.

This is a conservative, calibrated cost model, not a proved runtime bound:
diff_main's own wall-clock timeout (0.2 s) still stands behind it, and only a
deterministic bound inside the diff (patchflow#26, P3) makes G2 more than
empirical. It refuses some cheap edits too (many scattered edits across a
large field, a large replacement), as "too-large" work, which the frame keeps
for the user (keepUnsaved).

The cap is per host: BOARD_EDIT_WORK_CEILING, the cap at which the worst
measured admitted edit took about 170 ms on the reference host (an AMD EPYC
7B13, 16 vCPU, under load), scaled down on a slower host by its reference
loop (calibrateEditWorkLimits, measured at the host's first use). It is
never raised above the ceiling. Figures: plans/boards (G2) and #1236.
*/

import type { Change, Key } from "@sagemathinc/sagebrush-board/submission";
import { makePatch } from "@cocalc/sync/patchflow";
import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { getLogger } from "@cocalc/backend/logger";

const logger = getLogger("project-host:board:edit-cost");

// The work cap on the reference host, and the most any host is given.
export const BOARD_EDIT_WORK_CEILING = 24_000_000;

export const BOARD_EDIT_WORK_LIMITS = {
  // The work (see above), summed over the edit's text fields.
  maxWork: BOARD_EDIT_WORK_CEILING,
  // Text fields one edit may change.
  maxFields: 64,
};

// The reference loop: 4 diffs of 1 KiB replaced by 1 KiB of other text (the
// shape that costs the most per unit of work), timed; the median of 5 runs.
// On the reference host it takes REFERENCE_LOOP_MS.
export const REFERENCE_LOOP_MS = 51;

export function referenceLoopMs(
  makePatch: (a: string, b: string) => unknown,
  runs = 5,
): number {
  const a = "a".repeat(1024);
  const b = "b".repeat(1024);
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t = performance.now();
    for (let i = 0; i < 4; i++) makePatch(a, b);
    times.push(performance.now() - t);
  }
  times.sort((x, y) => x - y);
  return times[Math.floor(times.length / 2)];
}

// This host's limits from its reference loop: the ceiling, scaled down by
// how much slower than the reference host it is (never up).
export function calibrateEditWorkLimits(measuredMs: number): EditWorkLimits {
  const ratio =
    Number.isFinite(measuredMs) && measuredMs > 0
      ? Math.min(1, REFERENCE_LOOP_MS / measuredMs)
      : 0;
  return {
    ...BOARD_EDIT_WORK_LIMITS,
    maxWork: Math.floor(BOARD_EDIT_WORK_CEILING * ratio),
  };
}

export type EditWorkLimits = typeof BOARD_EDIT_WORK_LIMITS;

export interface EditWork {
  // Text fields changed.
  fields: number;
  // The bound on the patches their diffs make.
  patches: number;
  // Σ m: the changed parts.
  span: number;
  // Σ of the fields' work (see above).
  work: number;
}

// One text field's bound: old and new values (a missing old value is "").
export function fieldWork(
  before: string,
  after: string,
): { patches: number; span: number; work: number } {
  const n = Math.min(before.length, after.length);
  let p = 0;
  while (p < n && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let q = 0;
  while (
    q < n - p &&
    before.charCodeAt(before.length - 1 - q) ===
      after.charCodeAt(after.length - 1 - q)
  ) {
    q++;
  }
  const mBefore = before.length - p - q;
  const mAfter = after.length - p - q;
  if (mBefore + mAfter === 0) return { patches: 0, span: 0, work: 0 };
  const m = Math.min(mBefore, mAfter);
  const patches = m === 0 ? 1 : Math.floor(m / 8) + 1;
  const N = before.length + after.length;
  // diff_main over the middles: nothing to search when one is empty (a pure
  // insertion or deletion is one diff); otherwise its search is charged in
  // both lengths, (mBefore + mAfter)·max(mBefore, mAfter), conservative for
  // unequal middles as well as equal ones.
  const search = m === 0 ? 0 : (mBefore + mAfter) * Math.max(mBefore, mAfter);
  return { patches, span: m, work: patches * N + search };
}

// The work of these changes (as the host writes them: editState's preview
// or apply), against the records as they are now.
export function editWork(
  changes: readonly Change[],
  current: (key: Key) => { [field: string]: unknown } | undefined,
  stringCols: ReadonlySet<string>,
): EditWork {
  const total: EditWork = { fields: 0, patches: 0, span: 0, work: 0 };
  for (const change of changes) {
    if (change?.op !== "set") continue;
    const record = current(change.key);
    for (const [field, value] of Object.entries(change.fields ?? {})) {
      if (!stringCols.has(field) || typeof value !== "string") continue;
      const was = record?.[field];
      const w = fieldWork(typeof was === "string" ? was : "", value);
      if (w.work === 0) continue;
      total.fields += 1;
      total.patches += w.patches;
      total.span += w.span;
      total.work += w.work;
    }
  }
  return total;
}

// Why this edit is too much work to commit at once, or undefined.
export function editWorkRefusal(
  work: EditWork,
  limits: EditWorkLimits = BOARD_EDIT_WORK_LIMITS,
):
  | {
      message: string;
      reason: "too-large";
      what: "work";
      limit: number;
      size: number;
    }
  | undefined {
  if (work.fields > limits.maxFields) {
    return {
      message: `this change edits ${work.fields} texts at once, over the ${limits.maxFields} one save may; save it in smaller steps`,
      reason: "too-large",
      what: "work",
      limit: limits.maxFields,
      size: work.fields,
    };
  }
  if (work.work > limits.maxWork) {
    return {
      message:
        "this change is too much work to save at once; save it in smaller steps",
      reason: "too-large",
      what: "work",
      limit: limits.maxWork,
      size: work.work,
    };
  }
  return undefined;
}

// This host's limits, calibrated once, the first time they are needed (a
// few hundred milliseconds of diffing).
let hostLimits: (EditWorkLimits & { referenceMs: number }) | undefined;

export function hostEditWorkLimits(): EditWorkLimits & { referenceMs: number } {
  if (hostLimits == null) {
    const referenceMs = referenceLoopMs(makePatch);
    hostLimits = { ...calibrateEditWorkLimits(referenceMs), referenceMs };
    // What the cap was calibrated on, so each host's figure can be compared
    // with the reference host's.
    let cpuMax: string | undefined;
    try {
      cpuMax = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
    } catch {}
    logger.info("board edit work cap calibrated", {
      referenceMs,
      referenceHostMs: REFERENCE_LOOP_MS,
      maxWork: hostLimits.maxWork,
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      cpuMax,
      load: loadavg(),
    });
  }
  return hostLimits;
}

// The work of merging a changed file into the live document (the manager's
// three-way merge by records, then its commit), counted before anything is
// merged: for each text field the file changed, the diffs base → file (the
// merge's) and current → file (the commit's, the merged value being at most
// that far from the current one), each by fieldWork. Conservative, as an
// edit's is.
export function fileMergeWork({
  current,
  base,
  file,
  stringCols,
  keyOf,
}: {
  current: readonly { [field: string]: unknown }[];
  base: readonly { [field: string]: unknown }[] | undefined;
  file: readonly { [field: string]: unknown }[];
  stringCols: ReadonlySet<string>;
  keyOf: (record: { [field: string]: unknown }) => string;
}): EditWork {
  const byKey = (records: readonly { [field: string]: unknown }[]) =>
    new Map(records.map((r) => [keyOf(r), r]));
  const now = byKey(current);
  const before = base == null ? now : byKey(base);
  const total: EditWork = { fields: 0, patches: 0, span: 0, work: 0 };
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  for (const record of file) {
    const key = keyOf(record);
    const was = before.get(key);
    const is = now.get(key);
    for (const field of stringCols) {
      const value = record[field];
      if (typeof value !== "string") continue;
      const fromBase = fieldWork(text(was?.[field]), value);
      const fromNow = fieldWork(text(is?.[field]), value);
      if (fromBase.work === 0 && fromNow.work === 0) continue;
      total.fields += 1;
      total.patches += fromBase.patches + fromNow.patches;
      total.span += fromBase.span + fromNow.span;
      total.work += fromBase.work + fromNow.work;
    }
  }
  return total;
}
