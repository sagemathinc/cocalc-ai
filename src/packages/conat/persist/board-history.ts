/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What a board's patch history may be, before anything reconstructs a value
from it (A2b design, section 8c, G1).

A board's live document is a syncdb whose history (its patch stream) only
the board's fenced writer appends to. That writer appends linearly, so a
history it wrote is a chain: each patch has exactly one parent, the patch
before it, and a snapshot now and then names one of them. Reconstructing a
value from such a history costs one pass over the patches after the newest
snapshot. A history with branches (from before the board policy, restored,
or from a bug) can cost a full multi-way reconstruction, however few heads it
has at the end, so it is never opened in the host's own process.

Two checks, with one set of rules:

- checkBoardHistory (G1, on open): the stream's raw records, streamed and
  bounded (bytes, records, each record's fields), are a history that may be
  opened in-process only if it is a clean cut plus a bounded linear suffix:
  the newest snapshot is a cut (every patch is its ancestor or its
  descendant, as patchflow's PatchGraph.isCut defines it), and its
  descendants form one chain. With no snapshot, the whole history must be
  one chain from a single root. A patch whose parent is missing from the
  loaded history (other than at the cut) makes it incomplete: never safe.
  Everything else is refused, before Session.init is ever reached.

- BoardAppendCheck (on every write, in the board write service): each new
  patch's parents must be exactly the current head (none for the first).
  The service checks this synchronously before it stores anything, in the
  same step as its fence check, so the head it checked against can't change
  before the write is stored. So no write can branch a board's history.

Records are what SyncDoc writes (sync-doc.ts, createPatchflowStore and
snapshot): { time, parents, patch, is_snapshot, snapshot, seq_info, meta,
merge_parent, merge_patch, ... }. A snapshot record has the time of the
patch it is a snapshot of, and no parents.
*/

import { ConatError } from "@cocalc/conat/core/client";

export const BOARD_HISTORY_LIMITS = {
  // The whole stream, as stored.
  totalBytes: 64 * 1024 * 1024,
  records: 20_000,
  // One record, as stored: a snapshot holds the whole board (at most
  // BOARD_EDITABLE_LIMIT, 8 MiB) plus its fields.
  recordBytes: 9 * 1024 * 1024,
  // A patch id (patchflow's encodePatchId: time and client id).
  idChars: 64,
  // Parents a record may name at all (a linear history names one).
  parents: 16,
  // A record's meta, as JSON.
  metaChars: 4096,
  // The chain after the cut (snapshots come every 300 patches, the last
  // interval excepted).
  suffixRecords: 1_000,
  suffixBytes: 32 * 1024 * 1024,
};

export type BoardHistoryLimits = typeof BOARD_HISTORY_LIMITS;

export type HistoryVerdict =
  | {
      ok: true;
      // The patch the value is reconstructed from: the newest snapshot's
      // time, or undefined for a history without one (it starts at its
      // root).
      cut?: string;
      // The chain after the cut (from the root, without a snapshot).
      suffix: number;
      suffixBytes: number;
      // The single head (undefined for an empty history).
      head?: string;
      records: number;
      bytes: number;
    }
  | {
      ok: false;
      // too-large: over a limit (the stream, a record, the suffix);
      // invalid: a record that isn't one; incomplete: a parent missing from
      // inside the history; non-linear: branches, merges, or a snapshot
      // that isn't a cut.
      reason: "too-large" | "invalid" | "incomplete" | "non-linear";
      message: string;
    };

const ID = /^[0-9A-Za-z_-]+$/;

function historyError(
  reason: "too-large" | "invalid" | "incomplete" | "non-linear",
  message: string,
): HistoryVerdict {
  return { ok: false, reason, message };
}

export interface BoardRecord {
  time: string;
  // undefined for a snapshot record (it names its patch by time).
  parents?: string[];
  snapshot: boolean;
}

function validId(x: unknown, limits: BoardHistoryLimits): x is string {
  return (
    typeof x === "string" &&
    x.length > 0 &&
    x.length <= limits.idChars &&
    ID.test(x)
  );
}

// One stored record's graph fields, or why it isn't a board patch record.
// (Its stored size is checked before it is decoded: checkSize.)
export function parseBoardRecord(
  value: unknown,
  limits: BoardHistoryLimits = BOARD_HISTORY_LIMITS,
): BoardRecord | { invalid: string } {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { invalid: "a record that is not an object" };
  }
  const r = value as { [key: string]: unknown };
  if (!validId(r.time, limits)) {
    return { invalid: "a record without a valid time" };
  }
  if (r.meta != null) {
    let meta: string | undefined;
    try {
      meta = JSON.stringify(r.meta);
    } catch {}
    if (meta == null || meta.length > limits.metaChars) {
      return {
        invalid: `a record whose meta is not ${limits.metaChars} characters of JSON`,
      };
    }
  }
  if (r.is_snapshot === true) {
    if (typeof r.snapshot !== "string") {
      return { invalid: "a snapshot record without a snapshot" };
    }
    // A snapshot record names its patch by time; its own parents are
    // never read (patchflow keeps the patch's).
    return { time: r.time, snapshot: true };
  }
  if (r.is_snapshot != null && r.is_snapshot !== false) {
    return { invalid: "a record whose is_snapshot is not a boolean" };
  }
  const parents = r.parents ?? [];
  if (!Array.isArray(parents)) {
    return { invalid: "a record whose parents are not a list" };
  }
  if (parents.length > limits.parents) {
    return { invalid: `a record with over ${limits.parents} parents` };
  }
  for (const p of parents) {
    if (!validId(p, limits)) {
      return { invalid: "a record with an invalid parent" };
    }
  }
  if (new Set(parents).size !== parents.length) {
    return { invalid: "a record naming a parent twice" };
  }
  if (r.patch != null && typeof r.patch !== "string") {
    return { invalid: "a record whose patch is not a string" };
  }
  if (r.merge_parent != null && !validId(r.merge_parent, limits)) {
    return { invalid: "a record with an invalid merge parent" };
  }
  return { time: r.time, parents: parents as string[], snapshot: false };
}

/*
The open check, streaming: add() each stored record in stream order, then
finish(). add() returns a refusal as soon as a limit is passed, so a caller
reading the stream stops there, before reading (or decoding) any more. The
caller checks each record's stored size with checkSize() before decoding it.
*/
export class BoardHistoryCheck {
  private readonly limits: BoardHistoryLimits;
  private bytes = 0;
  private count = 0;
  // Patches by time: their parents, and their stored size.
  private readonly patches = new Map<
    string,
    { parents: string[]; bytes: number }
  >();
  // The times of snapshot records, in stream order (newest last).
  private readonly snapshots: string[] = [];
  private failed?: HistoryVerdict;

  constructor(limits: BoardHistoryLimits = BOARD_HISTORY_LIMITS) {
    this.limits = limits;
  }

  // Before decoding a record of this stored size: a refusal, or undefined.
  checkSize(rawBytes: number): HistoryVerdict | undefined {
    if (this.failed) return this.failed;
    if (!(rawBytes <= this.limits.recordBytes)) {
      return this.fail(
        historyError(
          "too-large",
          `a record of ${rawBytes} bytes, over the ${this.limits.recordBytes} a board's history may hold`,
        ),
      );
    }
    if (this.bytes + rawBytes > this.limits.totalBytes) {
      return this.fail(
        historyError(
          "too-large",
          `a history over ${this.limits.totalBytes} bytes`,
        ),
      );
    }
    if (this.count + 1 > this.limits.records) {
      return this.fail(
        historyError(
          "too-large",
          `a history of over ${this.limits.records} records`,
        ),
      );
    }
    return undefined;
  }

  add(value: unknown, rawBytes: number): HistoryVerdict | undefined {
    const sized = this.checkSize(rawBytes);
    if (sized) return sized;
    this.bytes += rawBytes;
    this.count += 1;
    const r = parseBoardRecord(value, this.limits);
    if ("invalid" in r) return this.fail(historyError("invalid", r.invalid));
    if (r.snapshot) {
      this.snapshots.push(r.time);
      return undefined;
    }
    const parents = r.parents!;
    const seen = this.patches.get(r.time);
    if (seen != null) {
      // The same patch stored again must be the same patch.
      if (!sameList(seen.parents, parents)) {
        return this.fail(
          historyError("invalid", `two different patches at ${r.time}`),
        );
      }
      seen.bytes += rawBytes;
      return undefined;
    }
    this.patches.set(r.time, { parents, bytes: rawBytes });
    return undefined;
  }

  finish(): HistoryVerdict {
    if (this.failed) return this.failed;
    const { patches } = this;
    const totals = { records: this.count, bytes: this.bytes };
    if (patches.size === 0) {
      if (this.snapshots.length > 0) {
        // A snapshot of a patch that isn't there, and nothing after it:
        // nothing to reconstruct from but the snapshot, which is fine only
        // if it is the one record.
        return this.snapshots.length === 1
          ? {
              ok: true,
              cut: this.snapshots[0],
              suffix: 0,
              suffixBytes: 0,
              head: this.snapshots[0],
              ...totals,
            }
          : historyError("non-linear", "snapshots without their patches");
      }
      return { ok: true, suffix: 0, suffixBytes: 0, ...totals };
    }
    // Children, by parent, among the loaded patches.
    const children = new Map<string, string[]>();
    for (const [time, { parents }] of patches) {
      for (const p of parents) {
        let c = children.get(p);
        if (c == null) children.set(p, (c = []));
        c.push(time);
      }
    }
    const cut = this.snapshots[this.snapshots.length - 1];
    let start: string;
    if (cut == null) {
      // No snapshot: one chain from one root.
      const roots = [...patches].filter(([, p]) => p.parents.length === 0);
      if (roots.length !== 1) {
        const missing = [...patches.values()].some((p) =>
          p.parents.some((q) => !patches.has(q)),
        );
        return missing
          ? historyError("incomplete", "a patch whose parent is missing")
          : historyError("non-linear", `a history with ${roots.length} roots`);
      }
      start = roots[0][0];
    } else {
      start = cut;
    }
    // The chain from the start: each link the only child of the one before,
    // with that one as its only parent.
    const chain: string[] = cut == null ? [start] : [];
    let suffixBytes = cut == null ? patches.get(start)!.bytes : 0;
    let cur = start;
    for (;;) {
      const kids = children.get(cur) ?? [];
      if (kids.length === 0) break;
      if (kids.length > 1) {
        return historyError("non-linear", `a branch at ${cur}`);
      }
      const kid = kids[0];
      const p = patches.get(kid)!;
      if (p.parents.length !== 1) {
        return historyError("non-linear", `a merge at ${kid}`);
      }
      chain.push(kid);
      suffixBytes += p.bytes;
      if (chain.length > this.limits.suffixRecords) {
        return historyError(
          "too-large",
          `over ${this.limits.suffixRecords} patches after the newest snapshot`,
        );
      }
      if (suffixBytes > this.limits.suffixBytes) {
        return historyError(
          "too-large",
          `over ${this.limits.suffixBytes} bytes of patches after the newest snapshot`,
        );
      }
      cur = kid;
    }
    // Everything else must be an ancestor of the cut (before it, where the
    // snapshot ends reconstruction).
    const covered = new Set(chain);
    if (cut != null) {
      covered.add(cut);
      const stack = [cut];
      while (stack.length > 0) {
        const t = stack.pop()!;
        for (const q of patches.get(t)?.parents ?? []) {
          if (!covered.has(q) && patches.has(q)) {
            covered.add(q);
            stack.push(q);
          }
        }
      }
    }
    for (const [time, p] of patches) {
      if (covered.has(time)) continue;
      return p.parents.some((q) => !patches.has(q))
        ? historyError("incomplete", `the parent of ${time} is missing`)
        : historyError(
            "non-linear",
            cut == null
              ? `${time} is not on the history's one chain`
              : `${time} is neither before nor after the newest snapshot`,
          );
    }
    return {
      ok: true,
      cut,
      suffix: chain.length,
      suffixBytes,
      head: cur,
      ...totals,
    };
  }

  private fail(verdict: HistoryVerdict): HistoryVerdict {
    this.failed ??= verdict;
    return this.failed;
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/*
The append rule, as the board write service enforces it: a board stream's
head (its newest patch) and the check that a new record keeps the history one
chain. One per stream in the service's process; the service runs requests
one at a time, and calls check() and then commit() in the same synchronous
step as the store, so the head can't change in between.
*/
export class BoardAppendCheck {
  private head: string | undefined;
  private headParents: string[] | undefined;
  // The newest stored seq this head was read at: if the stream has moved
  // on without us (history deleted or reset), the head is read again.
  private seq: number;

  constructor({
    head,
    headParents,
    seq,
  }: {
    head?: string;
    headParents?: string[];
    seq: number;
  }) {
    this.head = head;
    this.headParents = headParents;
    this.seq = seq;
  }

  get atSeq(): number {
    return this.seq;
  }

  // The head after these records, or throws a refusal ("branch"). Changes
  // nothing.
  check(
    records: unknown[],
    limits: BoardHistoryLimits = BOARD_HISTORY_LIMITS,
  ): { head?: string; headParents?: string[] } {
    let head = this.head;
    let headParents = this.headParents;
    for (const value of records) {
      const r = parseBoardRecord(value, limits);
      if ("invalid" in r) {
        throw new ConatError(`not a board patch record: ${r.invalid}`, {
          code: "branch",
        });
      }
      if (r.snapshot) continue;
      const parents = r.parents!;
      // The head sent again (a retried write): the same patch, no change.
      if (
        head != null &&
        r.time === head &&
        headParents != null &&
        sameList(parents, headParents)
      ) {
        continue;
      }
      const expected = head == null ? [] : [head];
      if (!sameList(parents, expected)) {
        throw new ConatError(
          head == null
            ? "the first patch of a board's history has no parents"
            : `a board's history is one chain: this patch must follow ${head}`,
          { code: "branch" },
        );
      }
      head = r.time;
      headParents = parents;
    }
    return { head, headParents };
  }

  commit(
    { head, headParents }: { head?: string; headParents?: string[] },
    seq: number,
  ): void {
    this.head = head;
    this.headParents = headParents;
    this.seq = seq;
  }
}
