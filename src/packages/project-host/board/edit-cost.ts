/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What an edit costs the host to commit, counted from the edit itself (A2b
design, section 8c, G2), so the same edit is admitted or refused on any
machine, before any of that work is done.

Committing an edit diffs each text field it changes (the syncdb's string
columns), old value to new, with diff-match-patch: diff_main over the part
that changed, then patch_make, which for each patch it makes scans the whole
text (patch_addContext_). So a field's cost is about

    k·N + m²

where N is the field's length (old plus new), m the changed part (after the
common prefix and suffix: the shorter of the two middles) and k the number of
patches. k isn't known without the diff, but it is bounded without one:
diff-match-patch starts a new patch only after 8 or more equal characters,
and those are in both middles, so k ≤ ⌊m / 8⌋ + 1; and k = 1 for a pure
insertion or deletion (m = 0). The work of an edit is the sum over its text
fields of k·N + m², and is capped, as is the number of text fields one edit
may change. No diff is ever run to count anything: this is two scans of each
changed field.

The caps were measured (plans/boards, G2): the worst edit within them costs
about 120 ms of diffing on a development machine, under the 250 ms a commit
may take; the worst the limits admitted before (one edit of three 64 KiB
fields edited every 50 characters) cost 520 ms. The bound refuses some cheap
edits too: many scattered edits across one large field in a single save (k
counts the span, not the edits). Those are "too-large" work, which the frame
keeps for the user (keepUnsaved); a bounded diff (patchflow#26, P3) can lift
this later.
*/

import type { Change, Key } from "@sagemathinc/sagebrush-board/submission";

export const BOARD_EDIT_WORK_LIMITS = {
  // k·N + m², summed over the edit's text fields (characters).
  maxWork: 48_000_000,
  // Text fields one edit may change.
  maxFields: 64,
};

export type EditWorkLimits = typeof BOARD_EDIT_WORK_LIMITS;

export interface EditWork {
  // Text fields changed.
  fields: number;
  // The bound on the patches their diffs make.
  patches: number;
  // Σ m: the changed parts.
  span: number;
  // Σ (k·N + m²).
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
  return { patches, span: m, work: patches * N + m * m };
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
