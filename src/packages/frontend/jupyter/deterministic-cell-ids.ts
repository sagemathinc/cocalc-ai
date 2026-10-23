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
// only for its first cell).  Cells of an nbformat 3 file are in its
// worksheets, which the importer appends after any top-level cells; they are
// numbered in that order.  Only a file without any cells is given the
// importer's default cell here, so that cell gets a deterministic id too.
export function withDeterministicCellIds<T = any>(ipynb: T): T {
  if (ipynb == null || typeof ipynb != "object") return ipynb;
  const notebook = ipynb as any;
  const topCells: any[] = Array.isArray(notebook.cells) ? notebook.cells : [];
  const worksheets: any[] = Array.isArray(notebook.worksheets)
    ? notebook.worksheets
    : [];
  const worksheetCells: any[][] = worksheets.map((worksheet) =>
    Array.isArray(worksheet?.cells) ? worksheet.cells : [],
  );
  const total =
    topCells.length +
    worksheetCells.reduce((sum, cells) => sum + cells.length, 0);
  if (total === 0) {
    return {
      ...notebook,
      cells: assignIds(deep_copy(DEFAULT_IPYNB.cells), 0, new Set()),
    };
  }
  const all = [...topCells, ...worksheetCells.flat()];
  const ids = all.filter(hasId).map((cell) => cell.id);
  if (all.every(hasId) && new Set(ids).size === ids.length) {
    return ipynb;
  }
  const used = new Set<string>();
  const cells = assignIds(topCells, 0, used);
  let offset = topCells.length;
  const newWorksheets = worksheets.map((worksheet, i) => {
    const assigned = assignIds(worksheetCells[i], offset, used);
    offset += worksheetCells[i].length;
    return Array.isArray(worksheet?.cells)
      ? { ...worksheet, cells: assigned }
      : worksheet;
  });
  return {
    ...notebook,
    ...(Array.isArray(notebook.cells) ? { cells } : {}),
    ...(worksheets.length > 0 ? { worksheets: newWorksheets } : {}),
  };
}

// The first cell with a given id keeps it (`used` is shared across calls, in
// import order); other cells get an id from their position and content.
function assignIds(cells: any[], offset: number, used: Set<string>): any[] {
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
    let id = `c${offset + i}-${hash}`;
    while (used.has(id)) id += "x";
    used.add(id);
    return { ...cell, id };
  });
}

function hasId(cell: any): boolean {
  return typeof cell?.id === "string" && cell.id.length > 0;
}
