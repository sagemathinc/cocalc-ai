/*
Three-way merge for db documents (notebooks, tasks, chats, whiteboards, ...),
used by the patch graph as the codec's merge3: every patch applies to the
exact value of its own parents and concurrent heads merge from their common
ancestor, instead of fuzzy-applying concurrent patches to each other.

Records are matched by primary key and merged field by field:
- A field changed on one side takes that change; changed identically on both
  sides, it applies once.
- Changed differently on both sides: string columns (user text) are merged
  with patchflow's mergeStrings3, maps are merged key by key, and any other
  value takes the later side (b), as the last write would.
- A value changed on one side and deleted on the other is kept.
- A record added on both sides is merged as if added to an empty record; its
  text columns merge from the text the two sides have in common.
- A record deleted on one side and edited on the other stays deleted, unless
  the edit changed user text (a string column): then the edited record is
  kept whole, so concurrent typing is never lost, and never leaves a partial
  record behind. Other edits of a deleted record (e.g. a kernel writing a
  deleted cell's output) do not bring it back.
*/

import { isEqual, isPlainObject } from "lodash";
import { mergeStrings3 } from "patchflow";
import { DiffMatchPatch } from "@cocalc/util/dmp";

// Merges must be identical on every replica, so no wall-clock diff deadline.
const dmp = new DiffMatchPatch();
dmp.diffTimeout = 0;

export interface DbMergeOptions {
  primaryKeys: string[];
  stringCols: string[];
}

type Record = { [field: string]: any };

function parse(text: string, primaryKeys: string[]): Map<string, Record> {
  const records = new Map<string, Record>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line);
    records.set(
      JSON.stringify(primaryKeys.map((key) => record[key] ?? null)),
      record,
    );
  }
  return records;
}

function mergeValue(
  base: any,
  a: any,
  b: any,
  isString: boolean,
  ancestors: any[],
): any {
  if (isEqual(a, b)) return a;
  if (isEqual(base, a)) return b;
  if (isEqual(base, b)) return a;
  // Changed on one side and deleted on the other: keep the change.
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (isString && typeof a === "string" && typeof b === "string") {
    return mergeStrings3({
      // A text added on both sides (e.g. a deleted cell both users brought
      // back by typing in it) merges from what the two have in common, so
      // shared lines appear once.
      base: typeof base === "string" ? base : commonText(a, b),
      a,
      b,
      ancestors: ancestors.some((x) => typeof x === "string")
        ? ancestors.map((x) => (typeof x === "string" ? x : ""))
        : undefined,
    });
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    return mergeFields(isPlainObject(base) ? base : {}, a, b, new Set(), []);
  }
  return b;
}

// What two versions of a text have in common, in order: the tokens (words,
// runs of whitespace, punctuation) that a diff of the two keeps, so the result
// never fuses parts of different words or lines.
function commonText(a: string, b: string): string {
  // Canonical order: the diff is not symmetric, and the merge must be.
  if (b < a) [a, b] = [b, a];
  const tokenize = (text: string) =>
    text.match(/\n|[^\S\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const ids = new Map<string, string>();
  const tokens: string[] = [];
  const encode = (text: string) =>
    tokenize(text)
      .map((token) => {
        let id = ids.get(token);
        if (id === undefined) {
          id = String.fromCharCode(tokens.length);
          ids.set(token, id);
          tokens.push(token);
        }
        return id;
      })
      .join("");
  const x = encode(a);
  const y = encode(b);
  if (tokens.length > 0xffff || x.length * y.length > 4_000_000) {
    return commonLines(a, b);
  }
  return dmp
    .diff_main(x, y, false)
    .filter(([op]) => op === 0)
    .map(([, ids]) =>
      Array.from(ids, (id) => tokens[id.charCodeAt(0)]).join(""),
    )
    .join("");
}

// The longest common subsequence of the lines of a and b (empty if too
// large to compute cheaply).
function commonLines(a: string, b: string): string {
  const x = a.split(/(?<=\n)/);
  const y = b.split(/(?<=\n)/);
  if (x.length * y.length > 250_000) return "";
  const best: number[][] = Array.from({ length: x.length + 1 }, () =>
    Array.from({ length: y.length + 1 }, () => 0),
  );
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      best[i][j] =
        x[i] === y[j]
          ? best[i + 1][j + 1] + 1
          : Math.max(best[i + 1][j], best[i][j + 1]);
    }
  }
  let out = "";
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out += x[i];
      i++;
      j++;
    } else if (best[i + 1][j] >= best[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

function mergeFields(
  base: Record,
  a: Record,
  b: Record,
  stringCols: Set<string>,
  ancestors: Record[],
): Record {
  const out: Record = {};
  for (const field of new Set([
    ...Object.keys(base),
    ...Object.keys(a),
    ...Object.keys(b),
  ])) {
    const value = mergeValue(
      base[field],
      a[field],
      b[field],
      stringCols.has(field),
      ancestors.map((record) => record[field]),
    );
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function changedText(
  base: Record,
  side: Record,
  stringCols: Set<string>,
): boolean {
  for (const field of stringCols) {
    if (!isEqual(base[field], side[field])) return true;
  }
  return false;
}

export function mergeDbStrings(
  opts: DbMergeOptions & {
    base: string;
    a: string;
    b: string;
    // Common ancestors when `base` is itself a merge (criss-cross history).
    ancestors?: string[];
  },
): string {
  const { primaryKeys } = opts;
  const stringCols = new Set(opts.stringCols);
  const base = parse(opts.base, primaryKeys);
  const a = parse(opts.a, primaryKeys);
  const b = parse(opts.b, primaryKeys);
  const ancestors = (opts.ancestors ?? []).map((x) => parse(x, primaryKeys));
  const out: Record[] = [];
  for (const key of new Set([...base.keys(), ...a.keys(), ...b.keys()])) {
    const anc = ancestors
      .map((records) => records.get(key))
      .filter((r): r is Record => r != null);
    const merged = mergeRecord(
      base.get(key),
      a.get(key),
      b.get(key),
      stringCols,
      anc,
    );
    if (merged != null) out.push(merged);
  }
  return out.map((record) => JSON.stringify(record)).join("\n");
}

// The merge of one record (undefined: the record is deleted).
function mergeRecord(
  r0: Record | undefined,
  ra: Record | undefined,
  rb: Record | undefined,
  stringCols: Set<string>,
  anc: Record[],
): Record | undefined {
  if (r0 == null) {
    // Added on one or both sides.
    if (ra != null && rb != null)
      return mergeFields({}, ra, rb, stringCols, anc);
    return ra ?? rb;
  }
  if (ra == null && rb == null) return undefined; // deleted on both sides
  if (ra == null || rb == null) {
    // Deleted on one side: kept only if the other side changed its text.
    const kept = (ra ?? rb)!;
    return changedText(r0, kept, stringCols) ? kept : undefined;
  }
  return mergeFields(r0, ra, rb, stringCols, anc);
}

// The db document API the fast merge uses. Both of patchflow's documents
// provide it: DbDocument returns immutable keys and records, DbDocumentImmer
// (used for chats) returns plain objects.
interface DbDoc {
  changes(prev: DbDoc): { forEach(fn: (key: any) => void): void };
  getOne(where: object): any;
  set(record: Record): DbDoc;
  delete(where: object): DbDoc;
}

const toPlain = (x: any): Record | undefined =>
  x != null && typeof x.toJS === "function" ? x.toJS() : x;

const isDbDoc = (doc: any): doc is DbDoc =>
  doc != null &&
  typeof doc.changes === "function" &&
  typeof doc.getOne === "function" &&
  typeof doc.set === "function" &&
  typeof doc.delete === "function";

// A DocCodec.merge3 for db documents. The same merge as mergeDbStrings, but
// only records changed on both sides are merged: a record changed on one side
// takes that side's version, so the cost depends on what changed, not on the
// size of the document. (Unchanged records are shared between versions, so
// finding what changed is cheap.)
export function dbMerge3<D>(
  fromStr: (text: string) => D,
  toStr: (doc: D) => string,
  opts: DbMergeOptions,
): (base: D, a: D, b: D, ancestors?: D[]) => D {
  const { primaryKeys } = opts;
  const stringCols = new Set(opts.stringCols);
  const viaStrings = (base: D, a: D, b: D, ancestors?: D[]) =>
    fromStr(
      mergeDbStrings({
        ...opts,
        base: toStr(base),
        a: toStr(a),
        b: toStr(b),
        ancestors: ancestors?.map(toStr),
      }),
    );
  const keyOf = (record: Record) =>
    JSON.stringify(primaryKeys.map((key) => record[key] ?? null));
  // Primary keys of the records that differ between two versions.
  const changed = (doc: DbDoc, prev: DbDoc) => {
    const keys = new Map<string, Record>();
    doc.changes(prev).forEach((key) => {
      const where = toPlain(key)!;
      keys.set(keyOf(where), where);
    });
    return keys;
  };
  return (base, a, b, ancestors) => {
    const docs = [base, a, b, ...(ancestors ?? [])];
    if (!docs.every(isDbDoc)) return viaStrings(base, a, b, ancestors);
    const [d0, da, db] = [base, a, b] as unknown as DbDoc[];
    const changedA = changed(da, d0);
    const changedB = changed(db, d0);
    // Partial selectors can match multiple records: checking getOne's first
    // match cannot make delete(where) safe. Use exact-key string merging.
    for (const keys of [changedA, changedB]) {
      for (const where of keys.values()) {
        if (primaryKeys.some((key) => where[key] == null)) {
          return viaStrings(base, a, b, ancestors);
        }
      }
    }
    if (changedB.size === 0) return a;
    if (changedA.size === 0) return b;
    // The record with exactly this primary key; a where clause could also
    // match a record that has more key fields set.
    const get = (doc: DbDoc, key: string, where: Record) => {
      const record = toPlain(doc.getOne(where));
      if (record == null) return undefined;
      if (keyOf(record) !== key) throw new MismatchedKey();
      return record;
    };
    try {
      let out = da;
      for (const [key, where] of changedB) {
        const ra = get(da, key, where);
        const rb = get(db, key, where);
        const merged = changedA.has(key)
          ? mergeRecord(
              get(d0, key, where),
              ra,
              rb,
              stringCols,
              ((ancestors ?? []) as unknown as DbDoc[])
                .map((doc) => get(doc, key, where))
                .filter((r): r is Record => r != null),
            )
          : rb;
        if (isEqual(merged, ra)) continue;
        if (ra != null) out = out.delete(where);
        if (merged != null) out = out.set(merged);
      }
      return out as unknown as D;
    } catch (err) {
      if (err instanceof MismatchedKey) {
        return viaStrings(base, a, b, ancestors);
      }
      throw err;
    }
  };
}

class MismatchedKey extends Error {}
