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
  one chain from a single root. The cut is trusted: its snapshot is the
  whole value and ends reconstruction, so nothing at or below it is read,
  and ancestors missing there (a trimmed history) are accepted. A parent
  missing anywhere else (in the suffix, off the cut's ancestry, or in a
  history without a snapshot) makes it incomplete: never safe.
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
The append rule, as the board write service enforces it, with PatchGraph's
own normalization: the stream's stored records (each patch's parents, and a
digest of every stored record's exact bytes) and its one head. One per
stream in the service's process, read from the stream (whole, bounded by
the open check's limits) the first time and kept up to date with each store.
The service runs requests one at a time and calls check() and then commit()
in the same synchronous step as the store, so nothing can come between them.

A board's records are stored without a storage key (SyncDoc's patches stream
is append-only): a keyed store deletes the row with that key before it
inserts, so a keyed record could replace any stored record. Every record
with a key is refused.

For each record of a batch, in order, against the stored records plus the
batch so far:
- a patch whose time is new must have exactly the head as its parents (none
  for the first patch): it is the new head;
- a patch whose time is stored is the same record sent again (a retry) only
  if it is byte for byte the stored one, and then changes nothing (storing
  it again appends an identical copy, which PatchGraph reads as the same
  patch); any other patch at that time is refused (PatchGraph keeps the
  first, so a reopened board could differ from the live one);
- a snapshot record must be of a stored patch, which PatchGraph upgrades in
  place (no new node, no new head), and at most one snapshot record per
  time: the same one again changes nothing, any other is refused; a snapshot
  of anything else is refused.
So after every accepted batch, the stored history's PatchGraph has exactly
one head, the cached head, and reopening it gives the value the live graph
has.
*/

// A record as the service stores it: decoded, a digest of its encoding and
// exact bytes, and its storage key (none, for a board's records).
export interface AppendRecord {
  value: unknown;
  digest: string;
  key?: string;
}

export class BoardAppendCheck {
  private head: string | undefined;
  // Every stored patch: its parents.
  private readonly patches: Map<string, string[]>;
  // The digest of each stored patch ("p:" + time) and snapshot ("s:" +
  // time) record.
  private readonly digests: Map<string, string>;
  // The newest stored seq the graph was read at: if the stream has moved on
  // without us (history deleted or reset), it is read again.
  private seq: number;
  // Why the stored history can't be appended to (it isn't one chain), or
  // undefined.
  private broken?: string;

  constructor({
    patches = new Map(),
    digests = new Map(),
    head,
    seq,
    broken,
  }: {
    patches?: Map<string, string[]>;
    digests?: Map<string, string>;
    head?: string;
    seq: number;
    broken?: string;
  }) {
    this.patches = patches;
    this.digests = digests;
    this.head = head;
    this.seq = seq;
    this.broken = broken;
  }

  // The graph of a stored stream's records, in stream order.
  static fromRecords(
    records: Iterable<AppendRecord>,
    seq: number,
    limits: BoardHistoryLimits = BOARD_HISTORY_LIMITS,
  ): BoardAppendCheck {
    const patches = new Map<string, string[]>();
    const digests = new Map<string, string>();
    const snapshots: string[] = [];
    let broken: string | undefined;
    for (const { value, digest, key } of records) {
      if (key != null) {
        broken ??= "a stored record with a storage key";
        continue;
      }
      const r = parseBoardRecord(value, limits);
      if ("invalid" in r) {
        broken ??= `a stored record that isn't a board patch: ${r.invalid}`;
        continue;
      }
      const id = `${r.snapshot ? "s" : "p"}:${r.time}`;
      const seen = digests.get(id);
      if (seen != null) {
        if (seen !== digest) {
          broken ??= `two different records at ${r.time}`;
        }
        continue;
      }
      digests.set(id, digest);
      if (r.snapshot) {
        snapshots.push(r.time);
      } else {
        patches.set(r.time, r.parents!);
      }
    }
    // A snapshot whose patch isn't stored (a trimmed history) is a node of
    // its own with no parents, as in PatchGraph; the chain after it hangs
    // off it, and anything else makes a second head.
    for (const t of snapshots) {
      if (!patches.has(t)) patches.set(t, []);
    }
    const referenced = new Set<string>();
    for (const parents of patches.values()) {
      for (const p of parents) referenced.add(p);
    }
    const heads = [...patches.keys()].filter((t) => !referenced.has(t));
    if (patches.size > 0 && heads.length !== 1) {
      broken ??= `a stored history with ${heads.length} heads`;
    }
    return new BoardAppendCheck({
      patches,
      digests,
      head: heads.length === 1 ? heads[0] : undefined,
      seq,
      broken,
    });
  }

  get atSeq(): number {
    return this.seq;
  }

  get currentHead(): string | undefined {
    return this.head;
  }

  // The new records and head after these records, or throws a refusal
  // ("branch"). Changes nothing.
  check(
    records: AppendRecord[],
    limits: BoardHistoryLimits = BOARD_HISTORY_LIMITS,
  ): {
    head?: string;
    added: [string, string[]][];
    digests: [string, string][];
    // For each record, whether it adds to the history (else it is the
    // stored record again).
    fresh: boolean[];
  } {
    if (this.broken != null) {
      throw new ConatError(
        `this board's history can't be appended to: ${this.broken}`,
        { code: "branch" },
      );
    }
    let head = this.head;
    const added = new Map<string, string[]>();
    const newDigests = new Map<string, string>();
    const parentsOf = (t: string) => added.get(t) ?? this.patches.get(t);
    const digestOf = (id: string) => newDigests.get(id) ?? this.digests.get(id);
    const fresh: boolean[] = [];
    for (const { value, digest, key } of records) {
      if (key != null) {
        throw new ConatError(
          "a board's records are stored without a storage key",
          { code: "branch" },
        );
      }
      const r = parseBoardRecord(value, limits);
      if ("invalid" in r) {
        throw new ConatError(`not a board patch record: ${r.invalid}`, {
          code: "branch",
        });
      }
      const id = `${r.snapshot ? "s" : "p"}:${r.time}`;
      const stored = digestOf(id);
      if (stored != null) {
        // The same record again changes nothing; any other record at its
        // time is refused.
        if (stored === digest) {
          fresh.push(false);
          continue;
        }
        throw new ConatError(
          r.snapshot
            ? `a different snapshot at ${r.time}, which this board's history already has`
            : `a different patch at ${r.time}, which this board's history already has`,
          { code: "branch" },
        );
      }
      const known = parentsOf(r.time);
      if (r.snapshot) {
        if (known == null) {
          throw new ConatError(
            `a snapshot of ${r.time}, which isn't a patch of this board's history`,
            { code: "branch" },
          );
        }
        newDigests.set(id, digest);
        fresh.push(true);
        continue;
      }
      if (known != null) {
        // A patch at the time of a stored, trimmed snapshot (a node with no
        // parents of its own): not a retry of anything stored.
        throw new ConatError(
          `a different patch at ${r.time}, which this board's history already has`,
          { code: "branch" },
        );
      }
      const parents = r.parents!;
      const expected = head == null ? [] : [head];
      if (!sameList(parents, expected)) {
        throw new ConatError(
          head == null
            ? "the first patch of a board's history has no parents"
            : `a board's history is one chain: this patch must follow ${head}`,
          { code: "branch" },
        );
      }
      if (this.patches.size + added.size >= limits.records) {
        throw new ConatError(
          `a board's history holds at most ${limits.records} patches`,
          { code: "branch" },
        );
      }
      added.set(r.time, parents);
      newDigests.set(id, digest);
      fresh.push(true);
      head = r.time;
    }
    return { head, added: [...added], digests: [...newDigests], fresh };
  }

  commit(next: ReturnType<BoardAppendCheck["check"]>, seq: number): void {
    for (const [t, parents] of next.added) this.patches.set(t, parents);
    for (const [id, digest] of next.digests) this.digests.set(id, digest);
    this.head = next.head;
    this.seq = seq;
  }
}
