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
