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
- A record added on both sides is merged as if added to an empty record.
- A record deleted on one side and edited on the other stays deleted, unless
  the edit changed user text (a string column): then the edited record is
  kept whole, so concurrent typing is never lost, and never leaves a partial
  record behind. Other edits of a deleted record (e.g. a kernel writing a
  deleted cell's output) do not bring it back.
*/

import { isEqual, isPlainObject } from "lodash";
import { mergeStrings3 } from "patchflow";

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
      base: typeof base === "string" ? base : "",
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
    const r0 = base.get(key);
    const ra = a.get(key);
    const rb = b.get(key);
    const anc = ancestors
      .map((records) => records.get(key))
      .filter((r): r is Record => r != null);
    if (r0 == null) {
      // Added on one or both sides.
      if (ra != null && rb != null)
        out.push(mergeFields({}, ra, rb, stringCols, anc));
      else out.push((ra ?? rb)!);
    } else if (ra == null && rb == null) {
      continue; // deleted on both sides
    } else if (ra == null || rb == null) {
      // Deleted on one side: kept only if the other side changed its text.
      const kept = (ra ?? rb)!;
      if (changedText(r0, kept, stringCols)) out.push(kept);
    } else {
      out.push(mergeFields(r0, ra, rb, stringCols, anc));
    }
  }
  return out.map((record) => JSON.stringify(record)).join("\n");
}

// A DocCodec.merge3 for db documents.
export function dbMerge3<D>(
  fromStr: (text: string) => D,
  toStr: (doc: D) => string,
  opts: DbMergeOptions,
): (base: D, a: D, b: D, ancestors?: D[]) => D {
  return (base, a, b, ancestors) =>
    fromStr(
      mergeDbStrings({
        ...opts,
        base: toStr(base),
        a: toStr(a),
        b: toStr(b),
        ancestors: ancestors?.map(toStr),
      }),
    );
}
