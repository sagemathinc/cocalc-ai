import { mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  preflightRepairLiteSqliteFiles,
  repairLiteSqliteFileIfNeeded,
} from "../../../sqlite-preflight";

function createDb(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
      "CREATE TABLE data(table_name TEXT, pk TEXT, row TEXT, updated_at INTEGER)",
    );
    db.exec(
      "INSERT INTO data(table_name, pk, row, updated_at) VALUES('t', '1', '{}', 1)",
    );
  } finally {
    db.close();
  }
}

describe("sqlite preflight", () => {
  it("repairs a readonly sqlite file by rebuilding it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lite-sqlite-preflight-"));
    const filename = join(dir, "hub.db");
    createDb(filename);
    chmodSync(filename, 0o444);

    expect(repairLiteSqliteFileIfNeeded(filename)).toBe(true);

    const db = new DatabaseSync(filename);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("UPDATE data SET updated_at = updated_at");
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  });

  it("leaves healthy sqlite files alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "lite-sqlite-preflight-"));
    const filename = join(dir, "sync-fs.sqlite");
    createDb(filename);

    expect(preflightRepairLiteSqliteFiles([filename])).toEqual([]);
  });
});
