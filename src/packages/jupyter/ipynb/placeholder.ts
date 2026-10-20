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

// Cell metadata that carries no work. Our exporter (cell_to_ipynb) always
// writes `collapsed`, so an untouched placeholder exports as
// {collapsed: false}; anything else, including collapsed: true, is content.
function isRoutineCellMetadata(metadata: unknown): boolean {
  if (isEmptyObject(metadata)) return true;
  if (typeof metadata !== "object") return false;
  const entries = Object.entries(metadata as object);
  return entries.every(
    ([key, value]) => key === "collapsed" && value === false,
  );
}

// Whether an ipynb document is only an empty notebook: no cells, or a single
// code cell with no source, outputs, attachments or metadata (other than the
// exporter's `collapsed: false`), and no notebook metadata beyond the kernel
// description. Anything else, including metadata-only cells (nbgrader, tags,
// slideshow), counts as content.
export function isPlaceholderIpynb(ipynb: any): boolean {
  if (ipynb == null || typeof ipynb !== "object") return false;
  const cells = ipynb.cells;
  if (!Array.isArray(cells) || cells.length > 1) return false;
  if (!isRoutineNotebookMetadata(ipynb.metadata)) return false;
  if (cells.length === 0) return true;
  const cell = cells[0];
  if (cell == null || typeof cell !== "object") return false;
  if (cell.cell_type != null && cell.cell_type !== "code") return false;
  const source = Array.isArray(cell.source)
    ? cell.source.join("")
    : `${cell.source ?? ""}`;
  return (
    source.trim() === "" &&
    cell.execution_count == null &&
    (cell.outputs?.length ?? 0) === 0 &&
    isEmptyObject(cell.attachments) &&
    isRoutineCellMetadata(cell.metadata)
  );
}

// Notebook-level metadata (an object or an immutable Map) with nothing
// beyond the kernel description.
function isRoutineNotebookMetadata(metadata: any): boolean {
  if (metadata == null) return true;
  const keys: string[] =
    typeof metadata.keySeq === "function"
      ? metadata.keySeq().toArray()
      : typeof metadata === "object"
        ? Object.keys(metadata)
        : ["?"];
  return keys.every((key) => ROUTINE_NOTEBOOK_METADATA.has(key));
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

// The same test on the live notebook's raw syncdb cell records (an
// immutable List of Maps), without exporting it: exactly one record, the
// generated "alpha" cell, with nothing the exporter would write as content
// (input, output, attachments, tags, slide, metadata, collapsed, scrolled, a
// run). Whether the notebook ever had content is a separate fact (see
// notebookSettingsArePlaceholder).
export function cellRecordsAreGeneratedPlaceholder(cells: any): boolean {
  if (cells == null || cells.size !== 1) return false;
  const cell = cells.first?.();
  if (cell == null) return false;
  const hasEntries = (key: string) => {
    const value = cell.get(key);
    return value != null && (value.size ?? Object.keys(value).length) > 0;
  };
  return (
    cell.get("id") === "alpha" &&
    `${cell.get("input") ?? ""}`.trim() === "" &&
    (cell.get("cell_type") ?? "code") === "code" &&
    cell.get("slide") == null &&
    !cell.get("collapsed") &&
    !cell.get("scrolled") &&
    cell.get("exec_count") == null &&
    cell.get("last") == null &&
    !hasEntries("output") &&
    !hasEntries("attachments") &&
    !hasEntries("tags") &&
    !hasEntries("metadata")
  );
}

// The live notebook's settings record (an immutable Map) still matches an
// empty notebook: it was never recorded as having had content
// (has_had_content, written when content is cleared or deleted), and has no
// notebook metadata beyond the kernel description.
export function notebookSettingsArePlaceholder(settings: any): boolean {
  if (settings == null) return true;
  return (
    settings.get("has_had_content") !== true &&
    isRoutineNotebookMetadata(settings.get("metadata"))
  );
}

// A live notebook syncdb (cells and settings) that is only the generated
// placeholder. Errors count as content.
export function syncdbIsGeneratedPlaceholder(syncdb: any): boolean {
  try {
    return (
      cellRecordsAreGeneratedPlaceholder(syncdb.get({ type: "cell" })) &&
      notebookSettingsArePlaceholder(syncdb.get_one({ type: "settings" }))
    );
  } catch {
    return false;
  }
}

// Whether the notebook file at path has content a placeholder must not
// replace. A missing file has none; any other read error counts as content.
export async function notebookFileHasContent(
  readFile: (path: string) => Promise<Buffer | string>,
  path: string,
): Promise<boolean> {
  let raw: Buffer | string;
  try {
    raw = await readFile(path);
  } catch (err: any) {
    return err?.code !== "ENOENT";
  }
  return ipynbTextHasContent(
    Buffer.isBuffer(raw) ? raw.toString("utf8") : `${raw}`,
  );
}
