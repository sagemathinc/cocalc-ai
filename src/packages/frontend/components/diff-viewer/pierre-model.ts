/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata, SelectionSide } from "@pierre/diffs";
import type { DiffPreviewSource } from "./preview-types";

export function parsePreviewSource(
  source: DiffPreviewSource,
): FileDiffMetadata[] {
  if (source.kind === "patch") {
    return parsePatchFiles(source.patch, undefined, true).flatMap(
      (x) => x.files,
    );
  }
  return [
    parseDiffFromFile(
      { name: source.path, contents: source.before },
      { name: source.path, contents: source.after },
      undefined,
      true,
    ),
  ];
}

export function containsPreviewLine(
  file: FileDiffMetadata,
  line: number,
  side: SelectionSide,
): boolean {
  if (!Number.isSafeInteger(line) || line < 1) return false;
  if (!file.isPartial) {
    return (
      line <=
      (side === "additions" ? file.additionLines : file.deletionLines).length
    );
  }
  return file.hunks.some((hunk) => {
    const start =
      side === "additions" ? hunk.additionStart : hunk.deletionStart;
    const count =
      side === "additions" ? hunk.additionCount : hunk.deletionCount;
    return line >= start && line < start + count;
  });
}

/** Preserve the legacy list's identity until the Git metadata facade replaces it. */
export function parseReviewPatchFiles(
  files: ReadonlyArray<{ path: string; lines: readonly string[] }>,
  linesTruncated: boolean,
): FileDiffMetadata[] {
  if (linesTruncated)
    throw Error("Cannot render an incomplete review with Pierre.");
  let lineCount = 0;
  let byteCount = 0;
  const encoder = new TextEncoder();
  const patches = files.map((file) => {
    lineCount += file.lines.length;
    if (lineCount > 20_000)
      throw Error("Review exceeds the 20,000-line limit.");
    const patch = file.lines.join("\n") + "\n";
    byteCount += encoder.encode(patch).byteLength;
    if (byteCount > 4 * 1024 * 1024)
      throw Error("Review exceeds the 4 MB limit.");
    return patch;
  });
  return patches.map((patch, index) => {
    const parsed = parsePatchFiles(patch, undefined, true).flatMap(
      (x) => x.files,
    );
    if (parsed.length !== 1)
      throw Error("A review file did not parse as exactly one diff.");
    if (parsed[0].name !== files[index].path)
      throw Error(
        "Git filename interpretations differ; retain the original review renderer.",
      );
    return parsed[0];
  });
}
