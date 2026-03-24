/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export type NotebookCellRecord = {
  type: "cell";
  id: string;
  pos: number;
  cell_type?: string;
  input?: string;
  [key: string]: unknown;
};

export interface NotebookSnapshot {
  cells: NotebookCellRecord[];
  cellCount: number;
}

export interface NotebookMutationResult {
  snapshot: NotebookSnapshot;
  changedCellIds: string[];
}

export interface InsertNotebookCellOptions {
  id?: string;
  pos?: number;
  cell_type?: string;
  input?: string;
  base?: Partial<NotebookCellRecord>;
}

export interface InsertNotebookCellAdjacentOptions extends Omit<
  InsertNotebookCellOptions,
  "pos"
> {
  anchorId: string;
  delta: -1 | 1;
}

export interface NotebookInsertResult extends NotebookMutationResult {
  cell: NotebookCellRecord;
}

export function createNotebookSnapshot(
  cells: readonly NotebookCellRecord[],
): NotebookSnapshot {
  const ordered = orderNotebookCells(cells);
  return {
    cells: ordered,
    cellCount: ordered.length,
  };
}

export function orderNotebookCells(
  cells: readonly NotebookCellRecord[],
): NotebookCellRecord[] {
  return [...cells].sort(compareNotebookCells);
}

export function getNotebookCell(
  snapshot: NotebookSnapshot,
  cellId: string,
): NotebookCellRecord | undefined {
  return snapshot.cells.find((cell) => cell.id === cellId);
}

export function setNotebookCellInput(
  snapshot: NotebookSnapshot,
  cellId: string,
  input: string,
): NotebookMutationResult {
  return updateNotebookCell(snapshot, cellId, { input });
}

export function setNotebookCellType(
  snapshot: NotebookSnapshot,
  cellId: string,
  cell_type: string,
): NotebookMutationResult {
  return updateNotebookCell(snapshot, cellId, { cell_type });
}

export function updateNotebookCell(
  snapshot: NotebookSnapshot,
  cellId: string,
  changes: Partial<NotebookCellRecord>,
): NotebookMutationResult {
  let changed = false;
  const next = snapshot.cells.map((cell) => {
    if (cell.id !== cellId) {
      return cell;
    }
    changed = true;
    return { ...cell, ...changes };
  });
  if (!changed) {
    throw new Error(`Notebook cell \"${cellId}\" not found`);
  }
  return {
    snapshot: createNotebookSnapshot(next),
    changedCellIds: [cellId],
  };
}

export function insertNotebookCellAt(
  snapshot: NotebookSnapshot,
  options: InsertNotebookCellOptions = {},
): NotebookInsertResult {
  const id = options.id?.trim() || createNotebookCellId(snapshot);
  if (snapshot.cells.some((cell) => cell.id === id)) {
    throw new Error(`Notebook cell \"${id}\" already exists`);
  }
  const pos =
    options.pos ??
    computeInsertPosition({ beforePos: undefined, afterPos: undefined });
  const cell: NotebookCellRecord = {
    ...(options.base ?? {}),
    type: "cell",
    id,
    pos,
    cell_type: options.cell_type ?? options.base?.cell_type ?? "code",
    input: options.input ?? options.base?.input ?? "",
  };
  return {
    snapshot: createNotebookSnapshot([...snapshot.cells, cell]),
    changedCellIds: [cell.id],
    cell,
  };
}

export function insertNotebookCellAdjacent(
  snapshot: NotebookSnapshot,
  options: InsertNotebookCellAdjacentOptions,
): NotebookInsertResult {
  const ordered = snapshot.cells;
  const anchorIndex = ordered.findIndex((cell) => cell.id === options.anchorId);
  if (anchorIndex === -1) {
    throw new Error(`Notebook cell \"${options.anchorId}\" not found`);
  }
  const anchor = ordered[anchorIndex];
  const adjacentIndex = anchorIndex + options.delta;
  const neighbor =
    adjacentIndex >= 0 && adjacentIndex < ordered.length
      ? ordered[adjacentIndex]
      : undefined;
  const pos =
    options.delta < 0
      ? computeInsertPosition({
          beforePos: neighbor?.pos,
          afterPos: anchor.pos,
        })
      : computeInsertPosition({
          beforePos: anchor.pos,
          afterPos: neighbor?.pos,
        });
  return insertNotebookCellAt(snapshot, {
    ...options,
    pos,
  });
}

export function deleteNotebookCells(
  snapshot: NotebookSnapshot,
  cellIds: readonly string[],
): NotebookMutationResult {
  if (cellIds.length === 0) {
    return { snapshot, changedCellIds: [] };
  }
  const removed = new Set(cellIds);
  const next = snapshot.cells.filter((cell) => !removed.has(cell.id));
  return {
    snapshot: createNotebookSnapshot(next),
    changedCellIds: [...removed],
  };
}

export function normalizeNotebookCellRows(rows: unknown): NotebookCellRecord[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  const cells = rows
    .map((row) => toPlainValue(row))
    .filter((row): row is NotebookCellRecord => row?.type === "cell")
    .map((row, index) => normalizeNotebookCellRow(row, index));
  return orderNotebookCells(cells);
}

function normalizeNotebookCellRow(
  row: NotebookCellRecord,
  index: number,
): NotebookCellRecord {
  const id =
    typeof row.id === "string" && row.id.trim()
      ? row.id.trim()
      : `__missing_cell_id__:${index}`;
  const pos =
    typeof row.pos === "number" && Number.isFinite(row.pos) ? row.pos : index;
  return {
    ...row,
    type: "cell",
    id,
    pos,
    cell_type: typeof row.cell_type === "string" ? row.cell_type : "code",
    input: typeof row.input === "string" ? row.input : `${row.input ?? ""}`,
  };
}

function toPlainValue(value: any): any {
  if (value?.toJS instanceof Function) {
    return value.toJS();
  }
  return value;
}

function compareNotebookCells(
  left: NotebookCellRecord,
  right: NotebookCellRecord,
): number {
  const posDelta = left.pos - right.pos;
  if (posDelta !== 0) {
    return posDelta;
  }
  return left.id.localeCompare(right.id);
}

function createNotebookCellId(snapshot: NotebookSnapshot): string {
  const existing = new Set(snapshot.cells.map((cell) => cell.id));
  while (true) {
    const id = Math.random().toString(16).slice(2, 8);
    if (!existing.has(id)) {
      return id;
    }
  }
}

function computeInsertPosition({
  beforePos,
  afterPos,
}: {
  beforePos?: number;
  afterPos?: number;
}): number {
  if (beforePos != null && afterPos != null) {
    return (beforePos + afterPos) / 2;
  }
  if (beforePos != null) {
    return beforePos + 1;
  }
  if (afterPos != null) {
    return afterPos - 1;
  }
  return 0;
}
