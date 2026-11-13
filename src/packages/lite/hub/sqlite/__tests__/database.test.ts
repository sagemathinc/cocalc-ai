import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, initDatabase } from "../database";

describe("initDatabase", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cocalc-lite-sqlite-"));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("waits for another connection's lock instead of failing at once", async () => {
    const filename = path.join(dir, "sqlite.db");
    // another process holds an exclusive lock for a moment, as a second
    // jest process (or the running host) can
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.exec("CREATE TABLE IF NOT EXISTS t (x)");
         db.exec("BEGIN EXCLUSIVE");
         process.stdout.write("locked\\n");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
        filename,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise((resolve) => holder.once("exit", resolve));
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.on("data", (chunk) => {
        if (`${chunk}`.includes("locked")) resolve();
      });
      holder.once("exit", () => reject(new Error("the lock holder exited")));
    });
    const started = Date.now();
    // blocks until the holder lets go (busy_timeout), then succeeds
    const db = initDatabase({ filename });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "wal",
    });
    await exited;
  });
});
