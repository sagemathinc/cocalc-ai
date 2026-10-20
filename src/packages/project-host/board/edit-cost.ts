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

This is a conservative, calibrated cost model for admission, not a proved
runtime bound: diff_main's own wall-clock timeout (0.2 s) still stands behind
it, and only a deterministic bound inside the diff (patchflow#26, P3) and
running merges in isolation make the bound hard. It refuses some cheap edits
too (many scattered edits across a large field, a large replacement), as
"too-large" work, which the frame keeps for the user (keepUnsaved).

The cap is per host, and an admission policy: BOARD_EDIT_WORK_CEILING (the
cap at which the worst measured admitted edit took about 170 ms, and one
cold run 255 ms, on the reference host: an AMD EPYC 7B13, GCP t2d-standard-16,
under load) times a safety factor, BOARD_EDIT_WORK_SAFETY, and scaled down on
a slower host by its reference loop (calibrateEditWorkLimits). A faster host
is not given more. The reference loop is telemetry for that scaling, not a
wall-time proof: it runs in the background from the host's start, one diff
per event-loop task (startEditWorkCalibration), and until it is done edits
are admitted at the uncalibrated cap, never a higher one. Figures:
plans/boards (G2) and #1236.
*/

import type { Change, Key } from "@sagemathinc/sagebrush-board/submission";
import { makePatch } from "@cocalc/sync/patchflow";
import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { getLogger } from "@cocalc/backend/logger";

const logger = getLogger("project-host:board:edit-cost");

// The absolute ceiling on an edit's work: no host is given more.
export const BOARD_EDIT_WORK_CEILING = 24_000_000;

// The margin below the ceiling every host admits at (so 19.2M on the
// reference host: the cold 255 ms there scales to about 204 ms, and 208 ms
// with 8 saves at once to about 166 ms).
export const BOARD_EDIT_WORK_SAFETY = 0.8;

export const BOARD_EDIT_WORK_LIMITS = {
  // The work (see above), summed over the edit's text fields: the cap a
  // host admits at until (and unless) its calibration lowers it.
  maxWork: Math.floor(BOARD_EDIT_WORK_CEILING * BOARD_EDIT_WORK_SAFETY),
  // Text fields one edit may change.
  maxFields: 64,
};

// The reference loop: 4 diffs of 1 KiB replaced by 1 KiB of other text (the
// shape that costs the most per unit of work), each timed; their sum, the
// median of 5 samples. On the reference host it takes REFERENCE_LOOP_MS.
export const REFERENCE_LOOP_MS = 51;
const REFERENCE_DIFFS = 4;
const REFERENCE_SAMPLES = 5;

function referenceDiff(makePatch: (a: string, b: string) => unknown): number {
  const a = "a".repeat(1024);
  const b = "b".repeat(1024);
  const t = performance.now();
  makePatch(a, b);
  return performance.now() - t;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

// The reference loop at once (for tests, which compare it with work timed
// in the same process).
export function referenceLoopMs(
  makePatch: (a: string, b: string) => unknown,
  runs = REFERENCE_SAMPLES,
): number {
  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    let ms = 0;
    for (let i = 0; i < REFERENCE_DIFFS; i++) ms += referenceDiff(makePatch);
    samples.push(ms);
  }
  return median(samples);
}

// The reference loop without holding the event loop: each diff is its own
// task, and the loop yields between them (about 13 ms each on the
// reference host).
export async function referenceLoopMsInSlices(
  makePatch: (a: string, b: string) => unknown,
  {
    runs = REFERENCE_SAMPLES,
    yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve)),
  }: { runs?: number; yieldNow?: () => Promise<void> } = {},
): Promise<number> {
  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    let ms = 0;
    for (let i = 0; i < REFERENCE_DIFFS; i++) {
      await yieldNow();
      ms += referenceDiff(makePatch);
    }
    samples.push(ms);
  }
  return median(samples);
}

// This host's limits from its reference loop: the ceiling times the safety
// factor, scaled down by how much slower than the reference host it is
// (never up).
export function calibrateEditWorkLimits(measuredMs: number): EditWorkLimits {
  const ratio =
    Number.isFinite(measuredMs) && measuredMs > 0
      ? Math.min(1, REFERENCE_LOOP_MS / measuredMs)
      : 0;
  return {
    ...BOARD_EDIT_WORK_LIMITS,
    maxWork: Math.min(
      BOARD_EDIT_WORK_LIMITS.maxWork,
      Math.floor(BOARD_EDIT_WORK_CEILING * BOARD_EDIT_WORK_SAFETY * ratio),
    ),
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

// This host's limits: the uncalibrated cap until its calibration is done.
// Never waits for it.
let hostLimits: (EditWorkLimits & { referenceMs?: number }) | undefined;
let calibrating: Promise<void> | undefined;

export function hostEditWorkLimits(): EditWorkLimits & {
  referenceMs?: number;
} {
  return hostLimits ?? BOARD_EDIT_WORK_LIMITS;
}

// Calibrate this host's cap in the background (at the host's start), one
// diff per event-loop task, and log what it was calibrated on. Idempotent.
export function startEditWorkCalibration(
  opts: Parameters<typeof referenceLoopMsInSlices>[1] = {},
): Promise<void> {
  calibrating ??= (async () => {
    const referenceMs = await referenceLoopMsInSlices(makePatch, opts);
    // Never above the uncalibrated cap admitted meanwhile.
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
  })().catch((err) => {
    // The uncalibrated cap stays.
    logger.warn("board edit work calibration failed", { err: `${err}` });
  });
  return calibrating;
}

/** For tests. */
export function resetEditWorkCalibration(): void {
  hostLimits = undefined;
  calibrating = undefined;
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
