/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  InsertNotebookCellAdjacentOptions,
  InsertNotebookCellOptions,
  MoveNotebookCellOptions,
  NotebookCellRecord,
  NotebookSnapshot,
} from "../operations";
import {
  createNotebookSnapshot,
  deleteNotebookCells,
  getNotebookCell,
  insertNotebookCellAdjacent,
  insertNotebookCellAt,
  moveNotebookCell,
  normalizeNotebookCellRows,
  setNotebookCellInput,
  setNotebookCellType,
} from "../operations";

interface NotebookSyncDBLike {
  wait_until_ready(): Promise<void>;
  isClosed(): boolean;
  close(): void | Promise<void>;
  get(where?: unknown): unknown;
  get_one(where?: unknown): unknown;
  set(obj: unknown): void;
  delete(where?: unknown): void;
  commit(): boolean;
  save(): Promise<void>;
  save_to_disk?(): Promise<void>;
}

export interface SyncDBNotebookSessionOptions {
  readOnly?: boolean;
}

export class SyncDBNotebookSession {
  private closed = false;

  constructor(
    private readonly syncdb: NotebookSyncDBLike,
    private readonly options: SyncDBNotebookSessionOptions = {},
  ) {}

  static async open(
    syncdb: NotebookSyncDBLike,
    options: SyncDBNotebookSessionOptions = {},
  ): Promise<SyncDBNotebookSession> {
    await syncdb.wait_until_ready();
    return new SyncDBNotebookSession(syncdb, options);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.syncdb.close();
  }

  async getSnapshot(): Promise<NotebookSnapshot> {
    return this.readSnapshot();
  }

  async listCells(): Promise<NotebookCellRecord[]> {
    return this.readSnapshot().cells;
  }

  async getCell(cellId: string): Promise<NotebookCellRecord | undefined> {
    this.assertOpen();
    const row = this.syncdb.get_one({ type: "cell", id: cellId });
    return normalizeNotebookCellRows(row == null ? [] : [row])[0];
  }

  async setCellInput(
    cellId: string,
    input: string,
  ): Promise<NotebookCellRecord> {
    this.assertWritable();
    const result = setNotebookCellInput(this.readSnapshot(), cellId, input);
    await this.persistResult(result.snapshot, result.changedCellIds);
    return this.requireCell(result.snapshot, cellId);
  }

  async setCellType(
    cellId: string,
    cellType: string,
  ): Promise<NotebookCellRecord> {
    this.assertWritable();
    const result = setNotebookCellType(this.readSnapshot(), cellId, cellType);
    await this.persistResult(result.snapshot, result.changedCellIds);
    return this.requireCell(result.snapshot, cellId);
  }

  async insertCellAt(
    options: InsertNotebookCellOptions = {},
  ): Promise<NotebookCellRecord> {
    this.assertWritable();
    const result = insertNotebookCellAt(this.readSnapshot(), options);
    await this.persistResult(result.snapshot, result.changedCellIds);
    return result.cell;
  }

  async insertCellAdjacent(
    options: InsertNotebookCellAdjacentOptions,
  ): Promise<NotebookCellRecord> {
    this.assertWritable();
    const result = insertNotebookCellAdjacent(this.readSnapshot(), options);
    await this.persistResult(result.snapshot, result.changedCellIds);
    return result.cell;
  }

  async deleteCells(cellIds: readonly string[]): Promise<void> {
    this.assertWritable();
    const result = deleteNotebookCells(this.readSnapshot(), cellIds);
    await this.persistResult(result.snapshot, result.changedCellIds);
  }

  async moveCell(
    options: MoveNotebookCellOptions,
  ): Promise<NotebookCellRecord> {
    this.assertWritable();
    const result = moveNotebookCell(this.readSnapshot(), options);
    await this.persistResult(result.snapshot, result.changedCellIds);
    return this.requireCell(result.snapshot, options.cellId);
  }

  private readSnapshot(): NotebookSnapshot {
    this.assertOpen();
    const rows = this.syncdb.get({ type: "cell" });
    return createNotebookSnapshot(normalizeNotebookCellRows(rows));
  }

  private async persistResult(
    snapshot: NotebookSnapshot,
    changedCellIds: readonly string[],
  ): Promise<void> {
    for (const cellId of changedCellIds) {
      const cell = getNotebookCell(snapshot, cellId);
      if (cell == null) {
        this.syncdb.delete({ type: "cell", id: cellId });
      } else {
        this.syncdb.set(cell);
      }
    }
    this.syncdb.commit();
    await this.syncdb.save();
    await this.syncdb.save_to_disk?.();
  }

  private requireCell(
    snapshot: NotebookSnapshot,
    cellId: string,
  ): NotebookCellRecord {
    const cell = getNotebookCell(snapshot, cellId);
    if (!cell) {
      throw new Error(`Notebook cell \"${cellId}\" not found`);
    }
    return cell;
  }

  private assertOpen(): void {
    if (this.closed || this.syncdb.isClosed()) {
      throw new Error("Notebook session is closed");
    }
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.options.readOnly) {
      throw new Error("Notebook session is read-only");
    }
  }
}
