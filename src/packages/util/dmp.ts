import { DiffMatchPatch, PatchObject } from "@cocalc/diff-match-patch";
export { DiffMatchPatch };

export type CompressedPatch = [
  [-1 | 0 | 1, string][],
  number,
  number,
  number,
  number,
][];

const dmp = new DiffMatchPatch();
// computing a diff shouldn't block longer than about 0.2s, though
// due to the structure of the algorithms it can be a little worse.
dmp.diffTimeout = 0.2;

// Here's what a diff-match-patch patch looks like
//
// [{"diffs":[[1,"{\"x\":5,\"y\":3}"]],"start1":0,"start2":0,"length1":0,"length2":13},...]
//

export const diff_main = dmp.diff_main.bind(dmp);
export const patch_make = dmp.patch_make.bind(dmp);

export function compressPatch(patch: PatchObject[]): CompressedPatch {
  return patch.map((p) => [p.diffs, p.start1, p.start2, p.length1, p.length2]);
}

export function decompressPatch(patch: CompressedPatch): PatchObject[] {
  return patch.map((p) => {
    const obj = new PatchObject();
    obj.diffs = p[0].map(([op, text]) => [op, text]);
    obj.start1 = p[1];
    obj.start2 = p[2];
    obj.length1 = p[3];
    obj.length2 = p[4];
    return obj;
  });
}

// return *a* compressed patch that transforms string s0 into string s1.
export function make_patch(s0: string, s1: string): CompressedPatch {
  // @ts-ignore
  return compressPatch(dmp.patch_make(s0, s1));
}

// apply a compressed patch to a string.
// Returns the result *and* whether or not the patch applied cleanly.
export function apply_patch(
  patch: CompressedPatch,
  s: string,
): [string, boolean] {
  let x;
  try {
    x = dmp.patch_apply(decompressPatch(patch), s);
    //console.log('patch_apply ', misc.to_json(decompressPatch(patch)), x)
  } catch (err) {
    // If a patch is so corrupted it can't be parsed -- e.g., due to a bug in SMC -- we at least
    // want to make application the identity map (i.e., "best effort"), so
    // the document isn't completely unreadable!
    console.warn(`apply_patch -- ${err}, ${JSON.stringify(patch)}`);
    return [s, false];
  }
  let clean = true;
  for (const a of x[1]) {
    if (!a) {
      clean = false;
      break;
    }
  }
  return [x[0], clean];
}

// Do a 3-way **string** merge by computing patch that transforms
// base to remote, then applying that patch to local.
export function three_way_merge(opts: {
  base: string;
  local: string;
  remote: string;
}): string {
  if (opts.base === opts.remote) {
    // trivial special case...
    return opts.local;
  }
  // @ts-ignore
  return dmp.patch_apply(dmp.patch_make(opts.base, opts.remote), opts.local)[0];
}

export type CheckedThreeWayMergeResult =
  | { clean: true; merged: string }
  | { clean: false; reason: "overlapping-edits" };

interface StringEdit {
  from: number;
  to: number;
  insert: string;
}

function stringEdits(base: string, target: string): StringEdit[] {
  if (base === target) return [];
  const edits: StringEdit[] = [];
  let cursor = 0;
  let current: StringEdit | undefined;
  const flush = () => {
    if (current != null) edits.push(current);
    current = undefined;
  };
  for (const [operation, value] of dmp.diff_main(base, target)) {
    if (operation === 0) {
      flush();
      cursor += value.length;
      continue;
    }
    current ??= { from: cursor, to: cursor, insert: "" };
    if (operation === -1) {
      current.to += value.length;
      cursor += value.length;
    } else {
      current.insert += value;
    }
  }
  flush();
  return edits;
}

function sameEdit(left: StringEdit, right: StringEdit): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    left.insert === right.insert
  );
}

function editsOverlap(left: StringEdit, right: StringEdit): boolean {
  if (sameEdit(left, right)) return false;
  const leftInsertion = left.from === left.to;
  const rightInsertion = right.from === right.to;
  if (leftInsertion && rightInsertion) return left.from === right.from;
  if (leftInsertion) {
    return left.from > right.from && left.from < right.to;
  }
  if (rightInsertion) {
    return right.from > left.from && right.from < left.to;
  }
  return left.from < right.to && right.from < left.to;
}

/**
 * Conservatively merge two string edits against a common base.
 *
 * Unlike three_way_merge, this never uses fuzzy patch application to choose a
 * winner. Overlapping edits are rejected so callers can retain the local draft
 * unchanged and ask the user how to proceed.
 */
export function checked_three_way_merge(opts: {
  base: string;
  local: string;
  remote: string;
}): CheckedThreeWayMergeResult {
  const localEdits = stringEdits(opts.base, opts.local);
  const remoteEdits = stringEdits(opts.base, opts.remote);
  for (const local of localEdits) {
    for (const remote of remoteEdits) {
      if (editsOverlap(local, remote)) {
        return { clean: false, reason: "overlapping-edits" };
      }
    }
  }

  const edits = [...localEdits];
  for (const remote of remoteEdits) {
    if (!edits.some((local) => sameEdit(local, remote))) edits.push(remote);
  }
  edits.sort((left, right) => {
    if (left.from !== right.from) return left.from - right.from;
    const leftInsertion = left.from === left.to;
    const rightInsertion = right.from === right.to;
    if (leftInsertion !== rightInsertion) return leftInsertion ? -1 : 1;
    return left.to - right.to;
  });

  let cursor = 0;
  let merged = "";
  for (const edit of edits) {
    if (edit.from < cursor) {
      return { clean: false, reason: "overlapping-edits" };
    }
    merged += opts.base.slice(cursor, edit.from);
    merged += edit.insert;
    cursor = edit.to;
  }
  merged += opts.base.slice(cursor);
  return { clean: true, merged };
}

function diffsToEdits(diffs: [number, string][]): StringEdit[] {
  const edits: StringEdit[] = [];
  let cursor = 0;
  let current: StringEdit | undefined;
  for (const [operation, value] of diffs) {
    if (operation === 0) {
      if (current != null) edits.push(current);
      current = undefined;
      cursor += value.length;
      continue;
    }
    current ??= { from: cursor, to: cursor, insert: "" };
    if (operation === -1) {
      current.to += value.length;
      cursor += value.length;
    } else {
      current.insert += value;
    }
  }
  if (current != null) edits.push(current);
  return edits;
}

// Line-granular edits: every edit starts and ends on a line boundary.
function lineEdits(base: string, target: string): StringEdit[] {
  if (base === target) return [];
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars(base, target);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines(diffs, lineArray);
  return diffsToEdits(diffs as [number, string][]);
}

// Character edits from a semantically cleaned diff, so a replaced word is one
// edit rather than a mix of kept and changed characters.
function semanticEdits(base: string, target: string): StringEdit[] {
  if (base === target) return [];
  const diffs = dmp.diff_main(base, target);
  dmp.diff_cleanupSemantic(diffs);
  return diffsToEdits(diffs as [number, string][]);
}

function applyEdits(text: string, edits: StringEdit[]): string {
  let cursor = 0;
  let out = "";
  for (const edit of [...edits].sort((a, b) => a.from - b.from)) {
    out += text.slice(cursor, edit.from) + edit.insert;
    cursor = edit.to;
  }
  return out + text.slice(cursor);
}

// Merge local and remote edits of base. Identical changes apply once;
// non-overlapping changes apply at exact positions; overlapping changes are
// resolved by `resolve` (called with the base region and each side's version of
// it), and local wins if no resolver is given.
function mergeEdits(
  base: string,
  localEdits: StringEdit[],
  remoteEdits: StringEdit[],
  resolve?: (region: { base: string; local: string; remote: string }) => string,
): string {
  const applyOne = (edit: StringEdit) =>
    base.slice(0, edit.from) + edit.insert + base.slice(edit.to);
  const localResults = localEdits.map(applyOne);
  // Edits are the same change if applying either one alone gives the same
  // text, even if the diffs placed it at different offsets.
  const remote = remoteEdits.filter(
    (r) =>
      !localEdits.some((l) => sameEdit(l, r)) &&
      !localResults.includes(applyOne(r)),
  );
  // Two pure insertions at the same position do not conflict: keep both,
  // local first. Other overlapping edits conflict.
  const conflicts = (a: StringEdit, b: StringEdit) =>
    !(a.from === a.to && b.from === b.to) && editsOverlap(a, b);
  const isInsertion = (edit: StringEdit) => edit.from === edit.to;
  // Group conflicting edits into clusters over base ranges.
  const all = [
    ...localEdits.map((edit) => ({ edit, local: true })),
    ...remote.map((edit) => ({ edit, local: false })),
  ].sort(
    (a, b) =>
      a.edit.from - b.edit.from ||
      Number(isInsertion(b.edit)) - Number(isInsertion(a.edit)) ||
      Number(b.local) - Number(a.local) ||
      a.edit.to - b.edit.to,
  );
  const clusters: { from: number; to: number; items: typeof all }[] = [];
  for (const item of all) {
    const last = clusters[clusters.length - 1];
    const overlapsLast =
      last != null &&
      last.items.some((other) => conflicts(other.edit, item.edit));
    if (overlapsLast) {
      last.items.push(item);
      last.to = Math.max(last.to, item.edit.to);
    } else {
      clusters.push({ from: item.edit.from, to: item.edit.to, items: [item] });
    }
  }
  let cursor = 0;
  let merged = "";
  for (const cluster of clusters) {
    merged += base.slice(cursor, cluster.from);
    const regionBase = base.slice(cluster.from, cluster.to);
    const shift = (edit: StringEdit) => ({
      from: edit.from - cluster.from,
      to: edit.to - cluster.from,
      insert: edit.insert,
    });
    const localIn = cluster.items
      .filter((i) => i.local)
      .map((i) => shift(i.edit));
    const remoteIn = cluster.items
      .filter((i) => !i.local)
      .map((i) => shift(i.edit));
    if (remoteIn.length === 0) {
      merged += applyEdits(regionBase, localIn);
    } else if (localIn.length === 0) {
      merged += applyEdits(regionBase, remoteIn);
    } else {
      const region = {
        base: regionBase,
        local: applyEdits(regionBase, localIn),
        remote: applyEdits(regionBase, remoteIn),
      };
      merged += resolve != null ? resolve(region) : region.local;
    }
    cursor = cluster.to;
  }
  return merged + base.slice(cursor);
}

/**
 * Three-way merge for a live editor buffer: merge the local and remote edits
 * of a common base, applying each change once at its exact position (in the
 * style of diff3).
 *
 * - Changes are matched line by line first, so block-level edits align; where
 *   both sides changed the same lines, those lines are merged character by
 *   character (semantically cleaned), so edits to different words of one line
 *   both survive.
 * - Identical changes made on both sides (for example, both deleted the same
 *   text, or a stale base where both already contain the same inserted block)
 *   apply once.
 * - Nothing is relocated by fuzzy matching, so a deletion can never land on
 *   similar text elsewhere.
 * - Where local and remote change the same characters, the local version wins,
 *   since the user is editing there right now (the remote change remains in
 *   history).
 */
export function merge_prefer_local(opts: {
  base: string;
  local: string;
  remote: string;
}): string {
  const { base, local, remote } = opts;
  if (local === remote) return local;
  if (base === remote) return local;
  if (base === local) return remote;
  return mergeEdits(
    base,
    lineEdits(base, local),
    lineEdits(base, remote),
    (region) =>
      region.local === region.remote
        ? region.local
        : mergeEdits(
            region.base,
            semanticEdits(region.base, region.local),
            semanticEdits(region.base, region.remote),
          ),
  );
}
