/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Where a caret goes when an editor's text is replaced by a new version of
// it (e.g. a collaborator's change merged in). Used by the rich text editor
// and by CodeMirror's setValueNoJump.

import { diff_main } from "@cocalc/util/dmp";

// The offset in `next` of the position `offset` in `prev`. Unchanged words
// (and runs of whitespace) are aligned by a diff of whole words, so a caret
// never lands inside a different word (a character diff can align similar
// words wrongly); within text that changed it is mapped by characters. A
// caret at the place where text was inserted stays in front of it (as most
// editors map a remote insertion at the cursor), so it does not jump into
// what a collaborator is typing there and interleave with it.
export function mapTextOffset(
  prev: string,
  next: string,
  offset: number,
): number {
  // Only the part between the common prefix and suffix changed (widened to
  // whole words, which the mapping works with): map within it, so a small
  // change to a large document costs little.
  let start = 0;
  const shorter = Math.min(prev.length, next.length);
  while (start < shorter && prev[start] === next[start]) start++;
  let end = 0;
  while (
    end < shorter - start &&
    prev[prev.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  while (start > 0 && !/\s/.test(prev[start - 1])) start--;
  while (end > 0 && !/\s/.test(prev[prev.length - end])) end--;
  if (offset < start) return offset;
  if (offset > prev.length - end) return offset + next.length - prev.length;
  return (
    start +
    mapInChange(
      prev.slice(start, prev.length - end),
      next.slice(start, next.length - end),
      offset - start,
    )
  );
}

function mapInChange(prev: string, next: string, offset: number): number {
  let mapped = mapTextOffsetByWords(prev, next, offset);
  // A caret at the end of a word that a collaborator extended (they were
  // still typing it) goes past the rest of the word, not into it.
  const word = /[\p{L}\p{N}_]/u;
  if (
    offset > 0 &&
    word.test(prev[offset - 1]) &&
    !word.test(prev[offset] ?? "") &&
    word.test(next[mapped - 1] ?? "") &&
    word.test(next[mapped] ?? "")
  ) {
    while (mapped < next.length && word.test(next[mapped])) mapped++;
  }
  return mapped;
}

function mapTextOffsetByWords(
  prev: string,
  next: string,
  offset: number,
): number {
  const tokens = (text: string) => text.match(/\s+|\S+/g) ?? [];
  const a = tokens(prev);
  const b = tokens(next);
  const ids = new Map<string, string>();
  const encode = (list: string[]) =>
    list
      .map((token) => {
        let id = ids.get(token);
        if (id == null) {
          id = String.fromCharCode(ids.size + 1);
          ids.set(token, id);
        }
        return id;
      })
      .join("");
  const x = encode(a);
  const y = encode(b);
  if (ids.size >= 0xffff) return mapChangedText(prev, next, offset);
  let p = 0;
  let n = 0;
  let i = 0;
  let j = 0;
  let deleted = "";
  let inserted = "";
  // A changed region (deleted and inserted tokens between unchanged ones).
  const region = (): number | undefined => {
    const result =
      deleted === ""
        ? offset === p
          ? n
          : undefined
        : offset >= p && offset <= p + deleted.length
          ? n + mapChangedText(deleted, inserted, offset - p)
          : undefined;
    p += deleted.length;
    n += inserted.length;
    deleted = "";
    inserted = "";
    return result;
  };
  for (const [op, run] of diff_main(x, y)) {
    for (let k = 0; k < run.length; k++) {
      if (op === 0) {
        const mapped = region();
        if (mapped != null) return mapped;
        const length = a[i++].length;
        j++;
        if (offset <= p + length) return n + (offset - p);
        p += length;
        n += length;
      } else if (op === -1) {
        deleted += a[i++];
      } else {
        inserted += b[j++];
      }
    }
  }
  return region() ?? n;
}

// mapTextOffset by characters, for text that changed.
function mapChangedText(prev: string, next: string, offset: number): number {
  let p = 0;
  let n = 0;
  for (const [op, text] of diff_main(prev, next)) {
    if (op === 0) {
      if (offset <= p + text.length) return n + (offset - p);
      p += text.length;
      n += text.length;
    } else if (op === -1) {
      if (offset < p + text.length) return n;
      p += text.length;
    } else {
      if (offset === p) return n;
      n += text.length;
    }
  }
  return n;
}
