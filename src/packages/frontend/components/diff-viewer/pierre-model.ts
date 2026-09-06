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
