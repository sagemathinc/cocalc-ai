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
  // How deep a record may nest (a scalar is 0, a record's own map 1, so its
  // meta's top level is 2): the recovery child's msgpack scan has the same
  // bound (conat/board-recovery), so every record G1 admits is one recovery
  // can read.
  recordDepth: 32,
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

// Whether value nests over max containers deep (arrays and objects; a
// top-level container is depth 1). Iterative, so a deep value can't overflow
// the stack, and it stops as soon as the bound is passed.
export function depthOver(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [x, depth] = stack.pop()!;
    if (x == null || typeof x !== "object") continue;
    if (ArrayBuffer.isView(x)) continue;
    if (depth + 1 > max) return true;
    for (const child of Array.isArray(x) ? x : Object.values(x)) {
      if (child != null && typeof child === "object") {
        stack.push([child, depth + 1]);
      }
    }
  }
  return false;
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// A record's identity when its caller has none (its stored bytes' digest,
// as the append check uses): its decoded value.
function valueIdentity(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function validSeq(x: unknown): boolean {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

function validSeqInfo(x: unknown): boolean {
  if (x == null || typeof x !== "object" || Array.isArray(x)) return false;
  const { seq, prev_seq, ...rest } = x as { [key: string]: unknown };
  return (
    Object.keys(rest).length === 0 &&
    validSeq(seq) &&
    (prev_seq == null || validSeq(prev_seq))
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
  if (depthOver(value, limits.recordDepth)) {
    return { invalid: `a record nested over ${limits.recordDepth} deep` };
  }
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
    // SyncDoc reads a snapshot only with its seq_info (the seq of its
    // patch, and of the snapshot before it, if any).
    if (!validSeqInfo(r.seq_info)) {
      return { invalid: "a snapshot record without a valid seq_info" };
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
  // SyncDoc parses a patch (and a merge patch, with its merge parent) as
  // JSON when it loads the record: one that doesn't parse can't be opened.
  if (typeof r.patch === "string" && !parsesAsJson(r.patch)) {
    return { invalid: "a record whose patch is not JSON" };
  }
  if (r.merge_parent != null && !validId(r.merge_parent, limits)) {
    return { invalid: "a record with an invalid merge parent" };
  }
  if (
    r.merge_parent != null &&
    typeof r.merge_patch === "string" &&
    !parsesAsJson(r.merge_patch)
  ) {
    return { invalid: "a record whose merge patch is not JSON" };
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
  // Patches by time: their parents, their stored size, and the identity of
  // their record (a copy of it must be the same record).
  private readonly patches = new Map<
    string,
    { parents: string[]; bytes: number; identity: string }
  >();
  // The times of snapshot records, in stream order (newest last), and the
  // identity of each time's record.
  private readonly snapshots: string[] = [];
  private readonly snapshotIdentity = new Map<string, string>();
  private failed?: HistoryVerdict;
  // After an ok finish(): what the append check projects from.
  private openable?: OpenableHistory;

  constructor(limits: BoardHistoryLimits = BOARD_HISTORY_LIMITS) {
    this.limits = limits;
  }

  // The history as finish() found it openable (undefined if it isn't).
  openableHistory(): OpenableHistory | undefined {
    return this.openable;
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

  // identity: the record's identity as the append check sees it (the
  // digest of its encoding and stored bytes); by default its decoded value.
  add(
    value: unknown,
    rawBytes: number,
    identity: string = valueIdentity(value),
  ): HistoryVerdict | undefined {
    const sized = this.checkSize(rawBytes);
    if (sized) return sized;
    this.bytes += rawBytes;
    this.count += 1;
    const r = parseBoardRecord(value, this.limits);
    if ("invalid" in r) return this.fail(historyError("invalid", r.invalid));
    if (r.snapshot) {
      // The same snapshot stored again must be the same record.
      const seen = this.snapshotIdentity.get(r.time);
      if (seen != null && seen !== identity) {
        return this.fail(
          historyError("invalid", `two different snapshots at ${r.time}`),
        );
      }
      this.snapshotIdentity.set(r.time, identity);
      this.snapshots.push(r.time);
      return undefined;
    }
    const parents = r.parents!;
    const seen = this.patches.get(r.time);
    if (seen != null) {
      // The same patch stored again must be the same record, not only the
      // same parents.
      if (seen.identity !== identity) {
        return this.fail(
          historyError("invalid", `two different patches at ${r.time}`),
        );
      }
      seen.bytes += rawBytes;
      return undefined;
    }
    this.patches.set(r.time, { parents, bytes: rawBytes, identity });
    return undefined;
  }

  finish(): HistoryVerdict {
    if (this.failed) return this.failed;
    // A snapshot whose patch isn't stored (a trimmed history) is a node of
    // its own with no parents, as in PatchGraph (and the append check):
    // every one of them, not only the newest, so that one left over is a
    // second head.
    const patches = new Map(this.patches);
    for (const t of this.snapshotIdentity.keys()) {
      if (!patches.has(t))
        patches.set(t, { parents: [], bytes: 0, identity: "" });
    }
    const totals = { records: this.count, bytes: this.bytes };
    if (patches.size === 0) {
      this.openable = { cutBytes: 0, below: [], chain: [], ...totals };
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
    // The line below the cut, as far as it is one: each patch the only
    // parent of the one above it, and that one its only child. A snapshot
    // of a patch on it moves the cut back without breaking the history.
    // (No longer than the suffix may be: a cut further back would refuse.)
    const below: { time: string; bytes: number }[] = [];
    if (cut != null) {
      let at = cut;
      while (below.length < this.limits.suffixRecords) {
        const parents = patches.get(at)?.parents;
        if (parents?.length !== 1) break;
        const q = parents[0];
        const p = patches.get(q);
        if (p == null || children.get(q)?.length !== 1) break;
        below.push({ time: q, bytes: p.bytes });
        at = q;
      }
    }
    this.openable = {
      cut,
      cutBytes: cut == null ? 0 : (patches.get(cut)?.bytes ?? 0),
      below,
      chain: chain.map((time) => ({ time, bytes: patches.get(time)!.bytes })),
      ...totals,
    };
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

// An openable history, as the append check keeps it: the newest snapshot
// (the cut) and its patch's stored bytes, the line below it (nearest
// first, as far as it is one chain), the chain after it (from the root,
// without a snapshot) with each patch's stored bytes, and the stream's
// totals.
export interface OpenableHistory {
  cut?: string;
  cutBytes: number;
  below: { time: string; bytes: number }[];
  chain: { time: string; bytes: number }[];
  records: number;
  bytes: number;
}

export interface AppendProjection {
  head?: string;
  added: [string, string[]][];
  digests: [string, string][];
  // For each record, whether it adds to the history (else it is the stored
  // record again).
  fresh: boolean[];
  // For each record, whether storage will write it (all but duplicates).
  written: boolean[];
  history: OpenableHistory;
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
And the history after the batch must still pass the open check: the stored
history is read through it (BoardHistoryCheck) before anything is appended
(so a stored history that isn't openable, e.g. a merge leaving one head, or
a snapshot without its seq_info, is never appended to), and each batch is
projected against its bounds: the records and bytes of the whole stream, and
the chain after the newest snapshot (its patches and bytes). A snapshot
moves the cut to its patch, which must be the cut or on the chain after it.
A write the open check would refuse on the next open is refused now, so an
accepted write never quarantines its board.
So after every accepted batch, the stored history's PatchGraph has exactly
one head, the cached head, and reopening it gives the value the live graph
has.
*/

// A record as the service stores it: decoded, a digest of its encoding and
// exact bytes, and its storage key (none, for a board's records).
export interface AppendRecord {
  value: unknown;
  digest: string;
  // Its bytes as stored (as the open check counts them).
  bytes: number;
  key?: string;
  // Storage won't write it: its msgID is stored, with exactly this record
  // (a strict-msgID retry, a no-op; storage.msgIDOutcome).
  duplicate?: boolean;
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
  // The stored history, as the open check bounds it.
  private history: OpenableHistory;

  constructor({
    patches = new Map(),
    digests = new Map(),
    head,
    seq,
    broken,
    history,
  }: {
    patches?: Map<string, string[]>;
    digests?: Map<string, string>;
    head?: string;
    seq: number;
    broken?: string;
    history?: OpenableHistory;
  }) {
    this.patches = patches;
    this.digests = digests;
    this.head = head;
    this.seq = seq;
    this.broken = broken;
    if (history == null && broken == null && patches.size > 0) {
      throw Error("a stored history needs its open-check state");
    }
    this.history = history ?? {
      cutBytes: 0,
      below: [],
      chain: [],
      records: 0,
      bytes: 0,
    };
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
    // The open check, over exactly these records: only a history it would
    // open is appended to.
    const open = new BoardHistoryCheck(limits);
    // The first refusal is final: nothing more is read (each record read
    // is decoded and hashed), and a broken history needs no graph. So a
    // stream past the open check's bounds costs at most those bounds, and
    // its "broken" is cached like any other graph.
    for (const { value, digest, bytes, key } of records) {
      if (key != null) {
        broken = "a stored record with a storage key";
      } else {
        const r = parseBoardRecord(value, limits);
        if ("invalid" in r) {
          broken = `a stored record that isn't a board patch: ${r.invalid}`;
        } else {
          const id = `${r.snapshot ? "s" : "p"}:${r.time}`;
          const seen = digests.get(id);
          if (seen != null) {
            if (seen !== digest) broken = `two different records at ${r.time}`;
          } else {
            digests.set(id, digest);
            if (r.snapshot) {
              snapshots.push(r.time);
            } else {
              patches.set(r.time, r.parents!);
            }
          }
        }
      }
      if (broken == null) {
        const stop = open.add(value, bytes, digest);
        if (stop != null && !stop.ok) {
          broken = `its stored history isn't openable (${stop.reason}): ${stop.message}`;
        }
      }
      if (broken != null) return new BoardAppendCheck({ seq, broken });
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
    if (broken == null) {
      const verdict = open.finish();
      if (!verdict.ok) {
        broken = `its stored history isn't openable (${verdict.reason}): ${verdict.message}`;
      } else if (verdict.head !== (heads[0] as string | undefined)) {
        broken = "its stored history's head is not its open check's";
      }
    }
    return new BoardAppendCheck({
      patches,
      digests,
      head: heads.length === 1 ? heads[0] : undefined,
      seq,
      broken,
      history: broken == null ? open.openableHistory() : undefined,
    });
  }

  get atSeq(): number {
    return this.seq;
  }

  get currentHead(): string | undefined {
    return this.head;
  }

  // The new records and head after exactly the records storage will write
  // (every record but a duplicate, which storage leaves as it is), or
  // throws a refusal ("branch"). Changes nothing. A record that is a stored
  // record again but not a duplicate (a new msgID) is written again, as a
  // copy, and counts as one.
  check(
    records: AppendRecord[],
    limits: BoardHistoryLimits = BOARD_HISTORY_LIMITS,
  ): AppendProjection {
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
    const written: boolean[] = [];
    // The history after the batch, as the open check will bound it. Every
    // record counts in the stream's totals (a record sent again may be
    // stored again, as a copy).
    let { cut, cutBytes } = this.history;
    let below = [...this.history.below];
    let chain = [...this.history.chain];
    let recordCount = this.history.records;
    let byteCount = this.history.bytes;
    const tooLarge = (message: string) =>
      new ConatError(
        `a board's history is bounded (it would not open): ${message}`,
        { code: "branch" },
      );
    const atChain = (t: string) => chain.findIndex((c) => c.time === t);
    // A snapshot of t: the cut moves to t, which must be the cut, on the
    // chain after it, or on the line below it (the open check reads the
    // newest snapshot record in the stream as the cut).
    const moveCut = (t: string) => {
      if (t === cut) return;
      const i = atChain(t);
      if (i >= 0) {
        // Forward: the cut and the chain up to t go below.
        const passed = [
          ...(cut == null ? [] : [{ time: cut, bytes: cutBytes }]),
          ...chain.slice(0, i),
        ];
        below = [...passed.reverse(), ...below].slice(0, limits.suffixRecords);
        cut = t;
        cutBytes = chain[i].bytes;
        chain = chain.slice(i + 1);
        return;
      }
      const j = below.findIndex((c) => c.time === t);
      if (j < 0) {
        throw new ConatError(
          `a snapshot of ${t}, which is not on this board's one chain`,
          { code: "branch" },
        );
      }
      // Back: the line from t up to the cut joins the chain.
      chain = [
        ...below.slice(0, j).reverse(),
        { time: cut!, bytes: cutBytes },
        ...chain,
      ];
      cut = t;
      cutBytes = below[j].bytes;
      below = below.slice(j + 1);
      if (chain.length > limits.suffixRecords) {
        throw tooLarge(
          `over ${limits.suffixRecords} patches after the newest snapshot`,
        );
      }
    };
    for (const { value, digest, bytes, key, duplicate } of records) {
      if (duplicate) {
        // Not written: nothing changes (CORR-956-1: projecting it as stored
        // moved a cut that storage never moved).
        fresh.push(false);
        written.push(false);
        continue;
      }
      written.push(true);
      recordCount += 1;
      byteCount += bytes;
      if (!(bytes <= limits.recordBytes)) {
        throw tooLarge(`a record of ${bytes} bytes`);
      }
      if (recordCount > limits.records) {
        throw tooLarge(`over ${limits.records} records`);
      }
      if (byteCount > limits.totalBytes) {
        throw tooLarge(`over ${limits.totalBytes} bytes`);
      }
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
          // Stored again (a copy), it is read as the same record once more.
          if (r.snapshot) {
            moveCut(r.time);
          } else {
            const i = atChain(r.time);
            if (i >= 0) {
              chain[i] = { ...chain[i], bytes: chain[i].bytes + bytes };
            } else if (r.time === cut) {
              cutBytes += bytes;
            } else {
              const j = below.findIndex((c) => c.time === r.time);
              if (j >= 0)
                below[j] = { ...below[j], bytes: below[j].bytes + bytes };
            }
          }
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
        moveCut(r.time);
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
      chain.push({ time: r.time, bytes });
      if (chain.length > limits.suffixRecords) {
        throw tooLarge(
          `over ${limits.suffixRecords} patches after the newest snapshot`,
        );
      }
      added.set(r.time, parents);
      newDigests.set(id, digest);
      fresh.push(true);
      head = r.time;
    }
    const suffixBytes = chain.reduce((n, c) => n + c.bytes, 0);
    if (suffixBytes > limits.suffixBytes) {
      throw tooLarge(
        `over ${limits.suffixBytes} bytes of patches after the newest snapshot`,
      );
    }
    return {
      head,
      added: [...added],
      digests: [...newDigests],
      fresh,
      written,
      history: {
        cut,
        cutBytes,
        below,
        chain,
        records: recordCount,
        bytes: byteCount,
      },
    };
  }

  commit(next: AppendProjection, seq: number): void {
    for (const [t, parents] of next.added) this.patches.set(t, parents);
    for (const [id, digest] of next.digests) this.digests.set(id, digest);
    this.head = next.head;
    this.history = next.history;
    this.seq = seq;
  }
}
