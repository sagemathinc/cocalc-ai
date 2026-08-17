/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { checked_three_way_merge } from "../dmp";

export interface MergeNotebookCell {
  id?: string;
  source?: string | string[];
}

export interface MergeNotebookDocument<
  Cell extends MergeNotebookCell = MergeNotebookCell,
> {
  cells: Cell[];
}

export type CheckedNotebookMergeReason =
  | "duplicate-cell-id"
  | "missing-cell-id"
  | "overlapping-cell-change"
  | "overlapping-cell-order"
  | "overlapping-notebook-change";

export type CheckedNotebookMergeResult<Document> =
  | { clean: true; dirty: boolean; merged: Document }
  | { clean: false; reason: CheckedNotebookMergeReason };

const MISSING = Symbol("missing");

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        deepEqual(left[key], right[key]),
    )
  );
}

type JsonMergeResult =
  | { clean: true; value: unknown | typeof MISSING }
  | { clean: false };

function mergeJson(
  base: unknown | typeof MISSING,
  local: unknown | typeof MISSING,
  remote: unknown | typeof MISSING,
): JsonMergeResult {
  if (deepEqual(local, remote)) return { clean: true, value: local };
  if (deepEqual(local, base)) return { clean: true, value: remote };
  if (deepEqual(remote, base)) return { clean: true, value: local };
  if (!isObject(base) || !isObject(local) || !isObject(remote)) {
    return { clean: false };
  }
  const value: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);
  for (const key of keys) {
    const merged = mergeJson(
      Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MISSING,
      Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MISSING,
      Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MISSING,
    );
    if (!merged.clean) return merged;
    if (merged.value !== MISSING) value[key] = merged.value;
  }
  return { clean: true, value };
}

function sourceText(source?: string | string[]): string {
  return Array.isArray(source) ? source.join("") : (source ?? "");
}

function comparableCell(cell: MergeNotebookCell): Record<string, unknown> {
  return { ...cell, source: sourceText(cell.source) };
}

function cellEqual(left: MergeNotebookCell, right: MergeNotebookCell): boolean {
  return deepEqual(comparableCell(left), comparableCell(right));
}

type CellMergeResult<Cell> = { clean: true; cell?: Cell } | { clean: false };

function mergeCell<Cell extends MergeNotebookCell>(
  base?: Cell,
  local?: Cell,
  remote?: Cell,
): CellMergeResult<Cell> {
  if (base == null) {
    if (local == null) return { clean: true, cell: remote };
    if (remote == null) return { clean: true, cell: local };
    return cellEqual(local, remote)
      ? { clean: true, cell: local }
      : { clean: false };
  }
  if (local == null && remote == null) return { clean: true };
  if (local == null) {
    return remote != null && cellEqual(base, remote)
      ? { clean: true }
      : { clean: false };
  }
  if (remote == null) {
    return cellEqual(base, local) ? { clean: true } : { clean: false };
  }

  const baseSource = sourceText(base.source);
  const localSource = sourceText(local.source);
  const remoteSource = sourceText(remote.source);
  const localSourceChanged = localSource !== baseSource;
  const remoteSourceChanged = remoteSource !== baseSource;
  if (
    localSourceChanged &&
    remoteSourceChanged &&
    localSource !== remoteSource
  ) {
    return { clean: false };
  }
  const source = localSourceChanged ? local.source : remote.source;
  const withoutSource = (cell: Cell) => {
    const value = { ...cell } as Record<string, unknown>;
    delete value.source;
    return value;
  };
  const merged = mergeJson(
    withoutSource(base),
    withoutSource(local),
    withoutSource(remote),
  );
  if (!merged.clean || !isObject(merged.value)) return { clean: false };
  return { clean: true, cell: { ...merged.value, source } as Cell };
}

function cellIds<Cell extends MergeNotebookCell>(
  cells: Cell[],
): { ids: string[] } | { reason: CheckedNotebookMergeReason } {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const cell of cells) {
    if (!cell.id) return { reason: "missing-cell-id" };
    if (seen.has(cell.id)) return { reason: "duplicate-cell-id" };
    seen.add(cell.id);
    ids.push(cell.id);
  }
  return { ids };
}

function token(index: number): string | undefined {
  let code = index + 1;
  if (code >= 0xd800) code += 0x800;
  return code <= 0xfffd ? String.fromCharCode(code) : undefined;
}

function mergeCellOrder(opts: {
  base: string[];
  local: string[];
  remote: string[];
}): string[] | undefined {
  const all = [...new Set([...opts.base, ...opts.local, ...opts.remote])];
  const idToToken = new Map<string, string>();
  const tokenToId = new Map<string, string>();
  for (const [index, id] of all.entries()) {
    const value = token(index);
    if (value == null) return;
    idToToken.set(id, value);
    tokenToId.set(value, id);
  }
  const encode = (ids: string[]) =>
    ids.map((id) => idToToken.get(id)!).join("");
  const merged = checked_three_way_merge({
    base: encode(opts.base),
    local: encode(opts.local),
    remote: encode(opts.remote),
  });
  if (!merged.clean) return;
  const ids: string[] = [];
  for (const value of merged.merged) {
    const id = tokenToId.get(value);
    if (id == null) return;
    ids.push(id);
  }
  return ids;
}

/**
 * Conservatively merge notebooks by stable cell id. Cell order and independent
 * cell fields may merge, but concurrent source edits in one cell are rejected.
 */
export function checked_notebook_three_way_merge<
  Cell extends MergeNotebookCell,
  Document extends MergeNotebookDocument<Cell>,
>(opts: {
  base: Document;
  local: Document;
  remote: Document;
}): CheckedNotebookMergeResult<Document> {
  const baseIds = cellIds(opts.base.cells);
  const localIds = cellIds(opts.local.cells);
  const remoteIds = cellIds(opts.remote.cells);
  if ("reason" in baseIds) return { clean: false, reason: baseIds.reason };
  if ("reason" in localIds) return { clean: false, reason: localIds.reason };
  if ("reason" in remoteIds) return { clean: false, reason: remoteIds.reason };

  const byId = (cells: Cell[]) =>
    new Map(cells.map((cell) => [cell.id!, cell] as const));
  const baseCells = byId(opts.base.cells);
  const localCells = byId(opts.local.cells);
  const remoteCells = byId(opts.remote.cells);
  const mergedCells = new Map<string, Cell | undefined>();
  for (const id of new Set([
    ...baseIds.ids,
    ...localIds.ids,
    ...remoteIds.ids,
  ])) {
    const merged = mergeCell(
      baseCells.get(id),
      localCells.get(id),
      remoteCells.get(id),
    );
    if (!merged.clean) {
      return { clean: false, reason: "overlapping-cell-change" };
    }
    mergedCells.set(id, merged.cell);
  }

  const order = mergeCellOrder({
    base: baseIds.ids,
    local: localIds.ids,
    remote: remoteIds.ids,
  });
  if (order == null) {
    return { clean: false, reason: "overlapping-cell-order" };
  }
  const topLevel = (notebook: Document) => {
    const value = { ...notebook } as Record<string, unknown>;
    delete value.cells;
    return value;
  };
  const mergedTopLevel = mergeJson(
    topLevel(opts.base),
    topLevel(opts.local),
    topLevel(opts.remote),
  );
  if (!mergedTopLevel.clean || !isObject(mergedTopLevel.value)) {
    return { clean: false, reason: "overlapping-notebook-change" };
  }
  const cells = order.flatMap((id) => {
    const cell = mergedCells.get(id);
    return cell == null ? [] : [cell];
  });
  const merged = { ...mergedTopLevel.value, cells } as Document;
  return { clean: true, dirty: !deepEqual(merged, opts.remote), merged };
}
