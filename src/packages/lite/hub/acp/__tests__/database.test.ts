import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { closeDatabase, initDatabase } from "../../sqlite/database";
import { closeAcpDatabase, initAcpDatabase } from "../../sqlite/acp-database";
import { getAcpWorker } from "../../sqlite/acp-workers";

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

describe("ACP sqlite database", () => {
  let tempDir: string;

  beforeEach(async () => {
    closeDatabase();
    closeAcpDatabase();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lite-acp-sqlite-"));
  });

  afterEach(async () => {
    closeAcpDatabase();
    closeDatabase();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses a separate ACP sqlite file with the same pragmas", () => {
    const db: any = initAcpDatabase({
      filename: path.join(tempDir, "acp.sqlite"),
    });
    expect(db.prepare("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    expect(db.prepare("PRAGMA synchronous").get().synchronous).toBe(1);
    expect(db.prepare("PRAGMA busy_timeout").get().timeout).toBe(5000);
  });

  it("migrates ACP tables from the legacy shared sqlite file on first use", () => {
    const legacy = initDatabase({
      filename: path.join(tempDir, "sqlite.db"),
    }) as any;
    legacy.exec(`
      CREATE TABLE acp_workers (
        worker_id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        bundle_version TEXT NOT NULL,
        bundle_path TEXT NOT NULL,
        pid INTEGER,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_heartbeat_at INTEGER NOT NULL,
        last_seen_running_jobs INTEGER NOT NULL DEFAULT 0,
        exit_requested_at INTEGER,
        stopped_at INTEGER,
        stop_reason TEXT
      )
    `);
    legacy
      .prepare(
        `INSERT INTO acp_workers(worker_id, host_id, bundle_version, bundle_path, pid, state, started_at, last_heartbeat_at, last_seen_running_jobs, exit_requested_at, stopped_at, stop_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "worker-1",
        "host-1",
        "bundle-1",
        "/bundle",
        123,
        "active",
        10,
        20,
        0,
        null,
        null,
        null,
      );
    closeDatabase();

    initAcpDatabase({
      filename: path.join(tempDir, "acp.sqlite"),
      legacyFilename: path.join(tempDir, "sqlite.db"),
    });
    expect(getAcpWorker("worker-1")).toMatchObject({
      worker_id: "worker-1",
      host_id: "host-1",
      bundle_version: "bundle-1",
      bundle_path: "/bundle",
      pid: 123,
      state: "active",
    });
  });
});
