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
// only for its first cell).  A file without
// cells is given the importer's default cell here, so that cell gets a
// deterministic id too.
export function withDeterministicCellIds<T = any>(ipynb: T): T {
  if (ipynb == null || typeof ipynb != "object") return ipynb;
  const fileCells = (ipynb as any).cells;
  const cells: any[] =
    Array.isArray(fileCells) && fileCells.length > 0
      ? fileCells
      : deep_copy(DEFAULT_IPYNB.cells);
  const fileIds = cells.filter(hasId).map((cell) => cell.id);
  const unique = new Set<string>(fileIds).size === fileIds.length;
  if (cells === fileCells && unique && cells.every(hasId)) {
    return ipynb;
  }
  // The first cell with an id keeps it; a later cell repeating it is given a
  // deterministic id below (the importer would give it a random one).
  const used = new Set<string>();
  const kept = new Set<number>();
  cells.forEach((cell, index) => {
    if (hasId(cell) && !used.has(cell.id)) {
      used.add(cell.id);
      kept.add(index);
    }
  });
  return {
    ...(ipynb as any),
    cells: cells.map((cell, index) => {
      if (kept.has(index)) return cell;
      const source = Array.isArray(cell?.source)
        ? cell.source.join("")
        : `${cell?.source ?? ""}`;
      const hash = sha1(`${cell?.cell_type ?? ""}\0${source}`).slice(0, 10);
      let id = `c${index}-${hash}`;
      while (used.has(id)) id += "x";
      used.add(id);
      return { ...cell, id };
    }),
  };
}

function hasId(cell: any): boolean {
  return typeof cell?.id === "string" && cell.id.length > 0;
}
