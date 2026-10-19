/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An empty notebook is shown with one blank cell. Such a placeholder carries
// no work, so it must never take priority over, or be saved on top of, a
// notebook file that has content. That happened when a course assignment was
// opened just as its file was being copied: the file read as empty, the
// placeholder was created, and it then won over the copied lab (support
// ticket 21023).

// Notebook-level metadata that every notebook carries and that is not work.
const ROUTINE_NOTEBOOK_METADATA = new Set(["kernelspec", "language_info"]);

function isEmptyObject(value: unknown): boolean {
  return (
    value == null ||
    (typeof value === "object" && Object.keys(value as object).length === 0)
  );
}

// Whether an ipynb document is only an empty notebook: no cells, or a single
// code cell with no source, outputs, attachments or metadata, and no
// notebook metadata beyond the kernel description. Anything else, including
// metadata-only cells (nbgrader, tags, slideshow), counts as content.
export function isPlaceholderIpynb(ipynb: any): boolean {
  if (ipynb == null || typeof ipynb !== "object") return false;
  const cells = ipynb.cells;
  if (!Array.isArray(cells) || cells.length > 1) return false;
  for (const key of Object.keys(ipynb.metadata ?? {})) {
    if (!ROUTINE_NOTEBOOK_METADATA.has(key)) return false;
  }
  if (cells.length === 0) return true;
  const cell = cells[0];
  if (cell == null || typeof cell !== "object") return false;
  if (cell.cell_type != null && cell.cell_type !== "code") return false;
  const source = Array.isArray(cell.source)
    ? cell.source.join("")
    : `${cell.source ?? ""}`;
  return (
    source.trim() === "" &&
    (cell.outputs?.length ?? 0) === 0 &&
    isEmptyObject(cell.attachments) &&
    isEmptyObject(cell.metadata)
  );
}

// Whether the text of a notebook file has content that must not be replaced
// by an empty notebook. Fails closed: text that does not parse (for example a
// file caught while it is being written) counts as content.
export function ipynbTextHasContent(text: string): boolean {
  if (text.trim() === "") return false;
  try {
    return !isPlaceholderIpynb(JSON.parse(text));
  } catch {
    return true;
  }
}
