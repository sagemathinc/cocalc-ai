/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { DEFAULT_IPYNB } from "@cocalc/jupyter/ipynb/import-from-ipynb";
import { deep_copy, sha1 } from "@cocalc/util/misc";

// Cell ids for an empty notebook's initial import from its .ipynb file.
// Cells without an id in the file otherwise get a random id in each client,
// so two clients that import the same file at once each add a copy of every
// cell (a doubled notebook, a customer report).  Ids derived from each
// cell's position and content are the same in every client, so concurrent
// imports write the same cells.  Ids in the file are kept (a repeated id
// only for its first cell).
//
// This follows IPynbImporter: the cells of a file before nbformat 4 are in
// its worksheets, which the importer appends after any top-level cells (it
// ignores worksheets from nbformat 4 on), and a file without cells gets the
// importer's default cell, given here so that it gets a deterministic id too.
export function withDeterministicCellIds<T = any>(ipynb: T): T {
  if (ipynb == null || typeof ipynb != "object") return ipynb;
  const notebook = ipynb as any;
  const topCells: any[] = Array.isArray(notebook.cells) ? notebook.cells : [];
  const legacy = !(notebook.nbformat >= 4);
  const worksheets: any[] =
    legacy && Array.isArray(notebook.worksheets) ? notebook.worksheets : [];
  const worksheetCells: any[][] = worksheets.map((worksheet) =>
    Array.isArray(worksheet?.cells) ? worksheet.cells : [],
  );
  // Every cell, in the order the importer reads them.
  const all = [...topCells, ...worksheetCells.flat()];
  if (all.length === 0) {
    return { ...notebook, cells: assignIds(deep_copy(DEFAULT_IPYNB.cells)) };
  }
  const assigned = assignIds(all);
  if (assigned.every((cell, i) => cell === all[i])) {
    return ipynb;
  }
  let offset = topCells.length;
  const result: any = { ...notebook };
  if (Array.isArray(notebook.cells)) {
    result.cells = assigned.slice(0, topCells.length);
  }
  if (worksheets.length > 0) {
    result.worksheets = worksheets.map((worksheet, i) => {
      const cells = assigned.slice(offset, offset + worksheetCells[i].length);
      offset += worksheetCells[i].length;
      return Array.isArray(worksheet?.cells)
        ? { ...worksheet, cells }
        : worksheet;
    });
  }
  return result;
}

// The first cell with a given id keeps it; every such id is reserved before
// any id is generated, so a generated id never takes a file's id.  Other
// cells get an id from their position and content.
function assignIds(cells: any[]): any[] {
  const used = new Set<string>();
  const kept = cells.map((cell) => {
    if (hasId(cell) && !used.has(cell.id)) {
      used.add(cell.id);
      return true;
    }
    return false;
  });
  return cells.map((cell, i) => {
    if (kept[i]) return cell;
    const source = cell?.source ?? cell?.input ?? "";
    const text = Array.isArray(source) ? source.join("") : `${source}`;
    const hash = sha1(`${cell?.cell_type ?? ""}\0${text}`).slice(0, 10);
    let id = `c${i}-${hash}`;
    while (used.has(id)) id += "x";
    used.add(id);
    return { ...cell, id };
  });
}

function hasId(cell: any): boolean {
  return typeof cell?.id === "string" && cell.id.length > 0;
}
