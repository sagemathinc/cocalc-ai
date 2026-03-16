import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { closeDatabase, initDatabase } from "../../sqlite/database";

describe("lite sqlite database pragmas", () => {
  let tempDir: string;

  beforeEach(async () => {
    closeDatabase();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lite-sqlite-"));
  });

  afterEach(async () => {
    closeDatabase();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("sets busy_timeout and synchronous pragmas for shared worker writes", () => {
    const db: any = initDatabase({
      filename: path.join(tempDir, "sqlite.db"),
    });
    expect(db.prepare("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    expect(db.prepare("PRAGMA synchronous").get().synchronous).toBe(1);
    expect(db.prepare("PRAGMA busy_timeout").get().timeout).toBe(5000);
  });
});
