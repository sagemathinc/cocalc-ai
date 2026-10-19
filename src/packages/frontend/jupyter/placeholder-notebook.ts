/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An empty notebook is shown with one blank cell (ensureThereIsACell). Such a
// placeholder carries no work, so it must never take priority over, or be
// saved on top of, a notebook file that has content. That happened when a
// course assignment was opened just as its file was being copied: the file
// read as empty, the placeholder was created, and it then won over the copied
// lab (support ticket 21023).
export function isPlaceholderIpynb(ipynb: any): boolean {
  const cells = ipynb?.cells;
  if (!Array.isArray(cells)) return false;
  if (cells.length === 0) return true;
  if (cells.length > 1) return false;
  const cell = cells[0] ?? {};
  const source = Array.isArray(cell.source)
    ? cell.source.join("")
    : `${cell.source ?? ""}`;
  return (
    source.trim() === "" &&
    (cell.outputs?.length ?? 0) === 0 &&
    Object.keys(cell.attachments ?? {}).length === 0
  );
}

export function diskIpynbHasContent(read?: {
  bytes: number;
  ipynb?: any;
}): boolean {
  return (
    read != null &&
    read.bytes > 0 &&
    read.ipynb != null &&
    !isPlaceholderIpynb(read.ipynb)
  );
}
