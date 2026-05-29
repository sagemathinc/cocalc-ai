import assert from "node:assert/strict";

import { SyncDBNotebookSession } from "../src";
import type { NotebookCellRecord } from "../src";

class FakeSyncDb {
  public readonly setCalls: unknown[] = [];
  public readonly saveCalls: string[] = [];
  private rows: NotebookCellRecord[];

  constructor(rows: NotebookCellRecord[]) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  async wait_until_ready() {}

  isClosed() {
    return false;
  }

  close() {}

  get(where?: any) {
    if (where?.type === "cell") {
      return this.rows.map((row) => ({ ...row }));
    }
    return this.rows.map((row) => ({ ...row }));
  }

  get_one(where?: any) {
    return this.rows.find(
      (row) =>
        (where?.type == null || row.type === where.type) &&
        (where?.id == null || row.id === where.id),
    );
  }

  set(obj: any) {
    this.setCalls.push({ ...obj });
    const index = this.rows.findIndex(
      (row) => row.type === obj.type && row.id === obj.id,
    );
    if (index === -1) {
      this.rows.push({ ...obj });
    } else {
      this.rows[index] = { ...this.rows[index], ...obj };
    }
  }

  delete(where?: any) {
    this.rows = this.rows.filter(
      (row) =>
        !(
          (where?.type == null || row.type === where.type) &&
          (where?.id == null || row.id === where.id)
        ),
    );
  }

  commit() {
    return true;
  }

  async save() {
    this.saveCalls.push("save");
  }

  async save_to_disk() {
    this.saveCalls.push("save_to_disk");
  }
}

test("SyncDBNotebookSession.moveCell only persists the moved cell position", async () => {
  const syncdb = new FakeSyncDb([
    { type: "cell", id: "a", pos: 0, input: "alpha", cell_type: "code" },
    { type: "cell", id: "b", pos: 1, input: "bravo", cell_type: "code" },
    { type: "cell", id: "c", pos: 2, input: "charlie", cell_type: "code" },
  ]);
  const session = new SyncDBNotebookSession(syncdb as any);

  const moved = await session.moveCell({ cellId: "c", beforeId: "a" });

  assert.equal(moved.input, "charlie");
  assert.deepEqual(syncdb.setCalls, [{ type: "cell", id: "c", pos: -1 }]);
  assert.deepEqual(syncdb.saveCalls, ["save", "save_to_disk"]);
});
