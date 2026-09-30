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

type Diff = [number, string][];

// Line-granular diff: every change starts and ends on a line boundary.
function lineDiff(base: string, target: string): Diff {
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars(base, target);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines(diffs, lineArray);
  return diffs as Diff;
}

// Character diff with semantic cleanup, so a replaced word is one change rather
// than a mix of kept and changed characters.
function charDiff(base: string, target: string): Diff {
  const diffs = dmp.diff_main(base, target);
  dmp.diff_cleanupSemantic(diffs);
  return diffs as Diff;
}

// Unchanged spans of base in a diff, with their offset in the target.
function equalRuns(
  diffs: Diff,
): { from: number; to: number; target: number }[] {
  const runs: { from: number; to: number; target: number }[] = [];
  let b = 0;
  let t = 0;
  for (const [op, text] of diffs) {
    if (op === 0) {
      runs.push({ from: b, to: b + text.length, target: t });
      b += text.length;
      t += text.length;
    } else if (op === -1) {
      b += text.length;
    } else {
      t += text.length;
    }
  }
  return runs;
}

// Map a base offset inside (or at an end of) an unchanged run to the target.
// Changes located exactly at a run boundary belong to the chunk before the
// following stable span, so a chunk start maps through the run that ends at the
// offset (before any insertion there) and a chunk end maps through the run that
// starts at it (after any insertion there).
function mapOffset(
  runs: { from: number; to: number; target: number }[],
  offset: number,
  side: "chunk-start" | "chunk-end",
): number {
  const preferred = runs.find((run) =>
    side === "chunk-start" ? run.to === offset : run.from === offset,
  );
  const run =
    preferred ?? runs.find((run) => run.from <= offset && offset <= run.to);
  if (run == null) throw new Error("offset is not in an unchanged run");
  return run.target + (offset - run.from);
}

/*
diff3: split base into stable spans (unchanged on both sides) and unstable
chunks between them. For each chunk compare contents: identical changes apply
once, a change on one side applies, and a real conflict goes to `conflict`.
Comparing chunk contents (not edit decompositions) recognizes the same net
change even when the two diffs expressed it differently.
*/
function diff3(
  base: string,
  local: string,
  remote: string,
  diff: (a: string, b: string) => Diff,
  conflict: (chunk: { base: string; local: string; remote: string }) => string,
  // Whether an unchanged span is a trustworthy anchor between chunks. Blank
  // lines are not: the two diffs may match different blank lines, splitting one
  // change into chunks that differ between the sides and duplicating content.
  isAnchor: (text: string) => boolean = () => true,
): string {
  const localRuns = equalRuns(diff(base, local));
  const remoteRuns = equalRuns(diff(base, remote));
  // Stable spans: intersections of unchanged runs on both sides.
  const stable: { from: number; to: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < localRuns.length && j < remoteRuns.length) {
    const from = Math.max(localRuns[i].from, remoteRuns[j].from);
    const to = Math.min(localRuns[i].to, remoteRuns[j].to);
    if (from < to && isAnchor(base.slice(from, to))) stable.push({ from, to });
    if (localRuns[i].to < remoteRuns[j].to) i++;
    else j++;
  }
  let out = "";
  // Chunk boundaries: the start of the document or the end of a stable span,
  // up to the start of the next stable span or the end of the document.
  let startBase = 0;
  let startLocal = 0;
  let startRemote = 0;
  const emitChunk = (endBase: number, endLocal: number, endRemote: number) => {
    const chunk = {
      base: base.slice(startBase, endBase),
      local: local.slice(startLocal, endLocal),
      remote: remote.slice(startRemote, endRemote),
    };
    if (chunk.local === chunk.remote) out += chunk.local;
    else if (chunk.local === chunk.base) out += chunk.remote;
    else if (chunk.remote === chunk.base) out += chunk.local;
    else out += conflict(chunk);
  };
  for (const span of stable) {
    emitChunk(
      span.from,
      mapOffset(localRuns, span.from, "chunk-end"),
      mapOffset(remoteRuns, span.from, "chunk-end"),
    );
    out += base.slice(span.from, span.to);
    startBase = span.to;
    startLocal = mapOffset(localRuns, span.to, "chunk-start");
    startRemote = mapOffset(remoteRuns, span.to, "chunk-start");
  }
  emitChunk(base.length, local.length, remote.length);
  return out;
}

/**
 * Three-way merge for a live editor buffer, in the style of diff3.
 *
 * - Matches changes line by line; where both sides changed the same lines
 *   differently, merges those lines character by character, so edits to
 *   different words of one line both survive.
 * - Identical net changes made on both sides (both deleted the same text, both
 *   moved the same line, or a stale base where both already contain the same
 *   block) apply once, even if the two diffs expressed them differently.
 * - Nothing is relocated by fuzzy matching, so a deletion can never land on
 *   similar text elsewhere.
 * - Where both sides changed the same characters: concurrent pure insertions
 *   are both kept (local first); otherwise the local version wins, since the
 *   user is editing there right now (the remote change remains in history).
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
  return diff3(
    base,
    local,
    remote,
    lineDiff,
    (lines) =>
      diff3(lines.base, lines.local, lines.remote, charDiff, (chars) =>
        chars.base === "" ? chars.local + chars.remote : chars.local,
      ),
    (text) => text.trim() !== "",
  );
}
