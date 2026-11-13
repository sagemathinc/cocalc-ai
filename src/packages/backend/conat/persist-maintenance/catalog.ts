/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "@cocalc/backend/sqlite";

import type {
  PersistMaintenanceClose,
  PersistMaintenanceFileIdentity,
  PersistMaintenancePageStats,
  PersistMaintenanceStatus,
  PersistMaintenanceUse,
} from "@cocalc/conat/persist/maintenance/types";

export interface PersistMaintenanceDatabaseRow {
  path_key: string;
  logical_path?: string;
  physical_path: string;
  archive_path?: string;
  backup_path?: string;
  scope_type?: string;
  scope_id?: string;
  first_seen_at: number;
  last_seen_at: number;
  last_opened_at?: number;
  last_closed_at?: number;
  last_mutation_at?: number;
  generation: number;
  presence_state: "present" | "missing" | "unverified";
  missing_since?: number;
  device?: number;
  inode?: number;
  file_size_bytes?: number;
  file_mtime_ms?: number;
  wal_size_bytes?: number;
  page_size?: number;
  page_count?: number;
  freelist_count?: number;
  reclaimable_bytes?: number;
  last_inspected_at?: number;
  last_compacted_at?: number;
  last_compact_before_bytes?: number;
  last_compact_after_bytes?: number;
  last_compact_duration_ms?: number;
  consecutive_failures: number;
  retry_after?: number;
  last_error?: string;
  open_owners: number;
}

export interface PersistMaintenanceOwnerRow {
  path_key: string;
  owner_id: string;
  pid: number;
  process_start_token: string;
  worker_id: string;
  opened_at: number;
  last_confirmed_at: number;
}

export interface PersistMaintenanceUnfinishedRun {
  run_id: string;
  state: string;
  started_at: number;
  source_device?: number;
  source_inode?: number;
  source_size_bytes?: number;
  physical_path: string;
  archive_path?: string;
  backup_path?: string;
}

export interface PersistMaintenanceArtifactRun {
  run_id: string;
  physical_path: string;
}

export interface PersistMaintenanceSecondaryRefresh {
  path_key: string;
  source_path: string;
  destination_path: string;
  created_at: number;
  attempts: number;
  retry_after?: number;
  last_error?: string;
}

export function persistMaintenancePathKey(physicalPath: string): string {
  return createHash("sha256").update(physicalPath).digest("hex");
}

function statIdentity(
  path: string,
): PersistMaintenanceFileIdentity | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    let walSizeBytes = 0;
    try {
      walSizeBytes = lstatSync(`${path}-wal`).size;
    } catch {}
    return {
      device: Number(stat.dev),
      inode: Number(stat.ino),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      walSizeBytes,
    };
  } catch {
    return;
  }
}

export class PersistMaintenanceCatalog {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const existed = existsSync(path);
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    if (!existed) {
      this.db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS databases (
        path_key TEXT PRIMARY KEY,
        logical_path TEXT,
        physical_path TEXT NOT NULL,
        archive_path TEXT,
        backup_path TEXT,
        scope_type TEXT,
        scope_id TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_opened_at INTEGER,
        last_closed_at INTEGER,
        last_mutation_at INTEGER,
        generation INTEGER NOT NULL DEFAULT 0,
        presence_state TEXT NOT NULL,
        missing_since INTEGER,
        device INTEGER,
        inode INTEGER,
        file_size_bytes INTEGER,
        file_mtime_ms INTEGER,
        wal_size_bytes INTEGER,
        page_size INTEGER,
        page_count INTEGER,
        freelist_count INTEGER,
        reclaimable_bytes INTEGER,
        last_inspected_at INTEGER,
        last_compacted_at INTEGER,
        last_compact_before_bytes INTEGER,
        last_compact_after_bytes INTEGER,
        last_compact_duration_ms INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        retry_after INTEGER,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS open_owners (
        path_key TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_start_token TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        last_confirmed_at INTEGER NOT NULL,
        PRIMARY KEY (path_key, owner_id)
      );
      CREATE INDEX IF NOT EXISTS open_owners_worker_idx
        ON open_owners(worker_id);
      CREATE TABLE IF NOT EXISTS maintenance_runs (
        run_id TEXT PRIMARY KEY,
        path_key TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        source_generation INTEGER NOT NULL,
        source_device INTEGER,
        source_inode INTEGER,
        source_size_bytes INTEGER,
        expected_reclaim_bytes INTEGER,
        reclaimed_bytes INTEGER,
        duration_ms INTEGER,
        reason TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS maintenance_runs_started_idx
        ON maintenance_runs(started_at);
      CREATE TABLE IF NOT EXISTS secondary_refresh (
        path_key TEXT NOT NULL,
        source_path TEXT NOT NULL,
        destination_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_after INTEGER,
        last_error TEXT,
        PRIMARY KEY(path_key, destination_path)
      );
      CREATE TABLE IF NOT EXISTS catalog_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.setState("schema_version", "1");
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    this.db.close();
  }

  beginOpen(use: PersistMaintenanceUse, now = Date.now()): number {
    const pathKey = persistMaintenancePathKey(use.physicalPath);
    const identity = statIdentity(use.physicalPath);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO databases (
             path_key, logical_path, physical_path, archive_path, backup_path,
             scope_type, scope_id, first_seen_at, last_seen_at, last_opened_at,
             generation, presence_state, missing_since, device, inode,
             file_size_bytes, file_mtime_ms, wal_size_bytes
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path_key) DO UPDATE SET
             logical_path=excluded.logical_path,
             physical_path=excluded.physical_path,
             archive_path=excluded.archive_path,
             backup_path=excluded.backup_path,
             scope_type=excluded.scope_type,
             scope_id=excluded.scope_id,
             last_seen_at=excluded.last_seen_at,
             last_opened_at=excluded.last_opened_at,
             generation=databases.generation + 1,
             presence_state=excluded.presence_state,
             missing_since=excluded.missing_since,
             device=excluded.device,
             inode=excluded.inode,
             file_size_bytes=excluded.file_size_bytes,
             file_mtime_ms=excluded.file_mtime_ms,
             wal_size_bytes=excluded.wal_size_bytes`,
        )
        .run(
          pathKey,
          use.logicalPath,
          use.physicalPath,
          use.archivePath ?? null,
          use.backupPath ?? null,
          use.scopeType,
          use.scopeId ?? null,
          now,
          now,
          now,
          identity ? "present" : "unverified",
          null,
          identity?.device ?? null,
          identity?.inode ?? null,
          identity?.sizeBytes ?? null,
          identity?.mtimeMs ?? null,
          identity?.walSizeBytes ?? null,
        );
      this.db
        .prepare(
          `INSERT INTO open_owners (
             path_key, owner_id, pid, process_start_token, worker_id,
             opened_at, last_confirmed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path_key, owner_id) DO UPDATE SET
             pid=excluded.pid,
             process_start_token=excluded.process_start_token,
             worker_id=excluded.worker_id,
             last_confirmed_at=excluded.last_confirmed_at`,
        )
        .run(
          pathKey,
          use.ownerId,
          use.pid,
          use.processStartToken,
          use.workerId,
          now,
          now,
        );
      const row = this.db
        .prepare("SELECT generation FROM databases WHERE path_key=?")
        .get(pathKey) as { generation: number };
      this.db.exec("COMMIT");
      return row.generation;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  openFailed(use: PersistMaintenanceUse): void {
    this.removeOwner(use.physicalPath, use.ownerId);
  }

  mutation(use: PersistMaintenanceUse, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE databases SET last_mutation_at=?, last_seen_at=? WHERE path_key=?",
      )
      .run(now, now, persistMaintenancePathKey(use.physicalPath));
  }

  closed(close: PersistMaintenanceClose, now = Date.now()): void {
    const pathKey = persistMaintenancePathKey(close.physicalPath);
    const identity = statIdentity(close.physicalPath);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM open_owners WHERE path_key=? AND owner_id=?")
        .run(pathKey, close.ownerId);
      this.db
        .prepare(
          `UPDATE databases SET
             last_seen_at=?, last_closed_at=?,
             last_mutation_at=CASE WHEN ? THEN ? ELSE last_mutation_at END,
             presence_state=?, missing_since=?, device=?, inode=?,
             file_size_bytes=?, file_mtime_ms=?, wal_size_bytes=?
           WHERE path_key=?`,
        )
        .run(
          now,
          now,
          close.dirty ? 1 : 0,
          now,
          identity ? "present" : "missing",
          identity ? null : now,
          identity?.device ?? null,
          identity?.inode ?? null,
          identity?.sizeBytes ?? null,
          identity?.mtimeMs ?? null,
          identity?.walSizeBytes ?? null,
          pathKey,
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  removeOwner(physicalPath: string, ownerId: string): void {
    this.db
      .prepare("DELETE FROM open_owners WHERE path_key=? AND owner_id=?")
      .run(persistMaintenancePathKey(physicalPath), ownerId);
  }

  removeWorkerOwners(workerId: string): void {
    this.db.prepare("DELETE FROM open_owners WHERE worker_id=?").run(workerId);
  }

  listOwners(): PersistMaintenanceOwnerRow[] {
    return this.db
      .prepare("SELECT * FROM open_owners")
      .all() as unknown as PersistMaintenanceOwnerRow[];
  }

  removeOwnerByKey(pathKey: string, ownerId: string): void {
    this.db
      .prepare("DELETE FROM open_owners WHERE path_key=? AND owner_id=?")
      .run(pathKey, ownerId);
  }

  observeFile(
    physicalPath: string,
    identity: PersistMaintenanceFileIdentity,
    now = Date.now(),
  ): void {
    const pathKey = persistMaintenancePathKey(physicalPath);
    const existing = this.db
      .prepare(
        `SELECT device, inode, file_size_bytes, file_mtime_ms, presence_state
         FROM databases WHERE path_key=?`,
      )
      .get(pathKey) as
      | {
          device?: number;
          inode?: number;
          file_size_bytes?: number;
          file_mtime_ms?: number;
          presence_state: string;
        }
      | undefined;
    const replaced =
      existing != null &&
      (existing.presence_state !== "present" ||
        existing.device !== identity.device ||
        existing.inode !== identity.inode ||
        existing.file_size_bytes !== identity.sizeBytes ||
        existing.file_mtime_ms !== identity.mtimeMs);
    this.db
      .prepare(
        `INSERT INTO databases (
           path_key, physical_path, first_seen_at, last_seen_at, generation,
           presence_state, device, inode, file_size_bytes, file_mtime_ms,
           wal_size_bytes
         ) VALUES (?, ?, ?, ?, 0, 'present', ?, ?, ?, ?, ?)
         ON CONFLICT(path_key) DO UPDATE SET
           physical_path=excluded.physical_path,
           last_seen_at=excluded.last_seen_at,
           generation=databases.generation + ?,
           presence_state='present', missing_since=NULL,
           device=excluded.device, inode=excluded.inode,
           file_size_bytes=excluded.file_size_bytes,
           file_mtime_ms=excluded.file_mtime_ms,
           wal_size_bytes=excluded.wal_size_bytes,
           page_size=CASE WHEN ? THEN NULL ELSE databases.page_size END,
           page_count=CASE WHEN ? THEN NULL ELSE databases.page_count END,
           freelist_count=CASE WHEN ? THEN NULL ELSE databases.freelist_count END,
           reclaimable_bytes=CASE WHEN ? THEN NULL ELSE databases.reclaimable_bytes END,
           last_inspected_at=CASE WHEN ? THEN NULL ELSE databases.last_inspected_at END`,
      )
      .run(
        pathKey,
        physicalPath,
        now,
        now,
        identity.device,
        identity.inode,
        identity.sizeBytes,
        identity.mtimeMs,
        identity.walSizeBytes,
        replaced ? 1 : 0,
        replaced ? 1 : 0,
        replaced ? 1 : 0,
        replaced ? 1 : 0,
        replaced ? 1 : 0,
        replaced ? 1 : 0,
      );
  }

  markMissing(physicalPath: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE databases SET presence_state='missing',
           missing_since=COALESCE(missing_since, ?), retry_after=NULL,
           last_error=NULL WHERE path_key=?`,
      )
      .run(now, persistMaintenancePathKey(physicalPath));
  }

  updateInspection(
    physicalPath: string,
    identity: PersistMaintenanceFileIdentity,
    stats: PersistMaintenancePageStats,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE databases SET presence_state='present', missing_since=NULL,
           last_seen_at=?, device=?, inode=?, file_size_bytes=?,
           file_mtime_ms=?, wal_size_bytes=?, page_size=?, page_count=?,
           freelist_count=?, reclaimable_bytes=?, last_inspected_at=?,
           last_error=NULL WHERE path_key=?`,
      )
      .run(
        now,
        identity.device,
        identity.inode,
        identity.sizeBytes,
        identity.mtimeMs,
        identity.walSizeBytes,
        stats.pageSize,
        stats.pageCount,
        stats.freelistCount,
        stats.reclaimableBytes,
        now,
        persistMaintenancePathKey(physicalPath),
      );
  }

  listDatabases(limit = 10_000): PersistMaintenanceDatabaseRow[] {
    return this.db
      .prepare(
        `SELECT d.*, COUNT(o.owner_id) AS open_owners
         FROM databases d LEFT JOIN open_owners o ON o.path_key=d.path_key
         GROUP BY d.path_key ORDER BY d.last_seen_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as PersistMaintenanceDatabaseRow[];
  }

  getDatabase(physicalPath: string): PersistMaintenanceDatabaseRow | undefined {
    return this.db
      .prepare(
        `SELECT d.*, COUNT(o.owner_id) AS open_owners
         FROM databases d LEFT JOIN open_owners o ON o.path_key=d.path_key
         WHERE d.path_key=? GROUP BY d.path_key`,
      )
      .get(persistMaintenancePathKey(physicalPath)) as
      | PersistMaintenanceDatabaseRow
      | undefined;
  }

  listStalePresent(before: number, limit = 1000): string[] {
    return (
      this.db
        .prepare(
          `SELECT physical_path FROM databases
           WHERE presence_state='present' AND last_seen_at<?
           ORDER BY last_seen_at LIMIT ?`,
        )
        .all(before, limit) as unknown as { physical_path: string }[]
    ).map(({ physical_path }) => physical_path);
  }

  createRun(row: PersistMaintenanceDatabaseRow, state: string): string {
    const runId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO maintenance_runs (
           run_id, path_key, state, started_at, source_generation,
           source_device, source_inode, source_size_bytes,
           expected_reclaim_bytes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        row.path_key,
        state,
        Date.now(),
        row.generation,
        row.device ?? null,
        row.inode ?? null,
        row.file_size_bytes ?? null,
        row.reclaimable_bytes ?? null,
      );
    return runId;
  }

  updateRun(
    runId: string,
    state: string,
    options: {
      finished?: boolean;
      reclaimedBytes?: number;
      reason?: string;
      error?: string;
    } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE maintenance_runs SET state=?,
           finished_at=CASE WHEN ? THEN ? ELSE finished_at END,
           reclaimed_bytes=COALESCE(?, reclaimed_bytes),
           duration_ms=CASE WHEN ? THEN ? - started_at ELSE duration_ms END,
           reason=COALESCE(?, reason), error=COALESCE(?, error)
         WHERE run_id=?`,
      )
      .run(
        state,
        options.finished ? 1 : 0,
        Date.now(),
        options.reclaimedBytes ?? null,
        options.finished ? 1 : 0,
        Date.now(),
        options.reason ?? null,
        options.error ?? null,
        runId,
      );
  }

  unfinishedRuns(): PersistMaintenanceUnfinishedRun[] {
    return this.db
      .prepare(
        `SELECT r.run_id, r.state, r.started_at, r.source_device,
           r.source_inode, r.source_size_bytes, d.physical_path,
           d.archive_path, d.backup_path
         FROM maintenance_runs r JOIN databases d ON d.path_key=r.path_key
         WHERE r.finished_at IS NULL`,
      )
      .all() as unknown as PersistMaintenanceUnfinishedRun[];
  }

  finishedArtifactRuns(limit = 1000): PersistMaintenanceArtifactRun[] {
    return this.db
      .prepare(
        `SELECT r.run_id, d.physical_path
         FROM maintenance_runs r JOIN databases d ON d.path_key=r.path_key
         WHERE r.finished_at IS NOT NULL
         ORDER BY r.finished_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as PersistMaintenanceArtifactRun[];
  }

  enqueueSecondaryRefresh(
    sourcePath: string,
    destinationPath: string,
    error?: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO secondary_refresh (
           path_key, source_path, destination_path, created_at, attempts,
           retry_after, last_error
         ) VALUES (?, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(path_key, destination_path) DO UPDATE SET
           source_path=excluded.source_path,
           last_error=excluded.last_error`,
      )
      .run(
        persistMaintenancePathKey(sourcePath),
        sourcePath,
        destinationPath,
        Date.now(),
        error == null ? null : `${error}`.slice(0, 4000),
      );
  }

  nextSecondaryRefresh(
    now = Date.now(),
  ): PersistMaintenanceSecondaryRefresh | undefined {
    return this.db
      .prepare(
        `SELECT * FROM secondary_refresh
         WHERE retry_after IS NULL OR retry_after<=?
         ORDER BY created_at LIMIT 1`,
      )
      .get(now) as PersistMaintenanceSecondaryRefresh | undefined;
  }

  completeSecondaryRefresh(pathKey: string, destinationPath: string): void {
    this.db
      .prepare(
        "DELETE FROM secondary_refresh WHERE path_key=? AND destination_path=?",
      )
      .run(pathKey, destinationPath);
  }

  failSecondaryRefresh(
    pathKey: string,
    destinationPath: string,
    error: unknown,
  ): void {
    this.db
      .prepare(
        `UPDATE secondary_refresh SET attempts=attempts+1,
           retry_after=?, last_error=?
         WHERE path_key=? AND destination_path=?`,
      )
      .run(
        Date.now() + 60 * 60 * 1000,
        `${error}`.slice(0, 4000),
        pathKey,
        destinationPath,
      );
  }

  secondaryRefreshBacklog(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM secondary_refresh")
        .get() as {
        count: number;
      }
    ).count;
  }

  recordSuccess(
    physicalPath: string,
    beforeBytes: number,
    identity: PersistMaintenanceFileIdentity,
    durationMs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE databases SET last_compacted_at=?,
           last_compact_before_bytes=?, last_compact_after_bytes=?,
           last_compact_duration_ms=?, device=?, inode=?, file_size_bytes=?,
           file_mtime_ms=?, wal_size_bytes=?, presence_state='present',
           missing_since=NULL,
           reclaimable_bytes=0, freelist_count=0, consecutive_failures=0,
           retry_after=NULL, last_error=NULL WHERE path_key=?`,
      )
      .run(
        Date.now(),
        beforeBytes,
        identity.sizeBytes,
        durationMs,
        identity.device,
        identity.inode,
        identity.sizeBytes,
        identity.mtimeMs,
        identity.walSizeBytes,
        persistMaintenancePathKey(physicalPath),
      );
  }

  recordFailure(
    physicalPath: string,
    error: unknown,
    retryAfter: number,
  ): void {
    this.db
      .prepare(
        `UPDATE databases SET consecutive_failures=consecutive_failures+1,
           retry_after=?, last_error=? WHERE path_key=?`,
      )
      .run(
        retryAfter,
        `${error}`.slice(0, 4000),
        persistMaintenancePathKey(physicalPath),
      );
  }

  budgetSince(since: number): { attempts: number; bytes: number } {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS attempts,
           COALESCE(SUM(source_size_bytes), 0) AS bytes
         FROM maintenance_runs WHERE started_at>=?`,
      )
      .get(since) as { attempts: number; bytes: number };
  }

  prune({ before, keep }: { before: number; keep: number }): void {
    this.db
      .prepare(
        "DELETE FROM maintenance_runs WHERE finished_at IS NOT NULL AND finished_at<?",
      )
      .run(before);
    this.db
      .prepare(
        `DELETE FROM maintenance_runs WHERE run_id IN (
           SELECT run_id FROM maintenance_runs ORDER BY started_at DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(keep);
    this.db.exec("PRAGMA incremental_vacuum(32)");
  }

  expireMissing(before: number): void {
    this.db
      .prepare(
        `DELETE FROM databases WHERE presence_state='missing'
           AND missing_since<? AND path_key NOT IN (SELECT path_key FROM open_owners)
           AND path_key NOT IN (
             SELECT path_key FROM maintenance_runs WHERE finished_at IS NULL
           )`,
      )
      .run(before);
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO catalog_state(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }

  getState(key: string): string | undefined {
    return (
      this.db
        .prepare("SELECT value FROM catalog_state WHERE key=?")
        .get(key) as { value: string } | undefined
    )?.value;
  }

  statusBase(): Pick<
    PersistMaintenanceStatus,
    | "openPaths"
    | "presentDatabases"
    | "missingDatabases"
    | "unverifiedDatabases"
    | "presentFileBytes"
    | "presentWalBytes"
    | "attempts"
    | "successes"
    | "invalidations"
    | "timeouts"
    | "failures"
    | "inspectedBytes"
    | "reclaimedBytes"
  > {
    const databaseCounts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN presence_state='present' THEN 1 ELSE 0 END) AS present,
           SUM(CASE WHEN presence_state='missing' THEN 1 ELSE 0 END) AS missing,
           SUM(CASE WHEN presence_state='unverified' THEN 1 ELSE 0 END) AS unverified,
           COALESCE(SUM(CASE WHEN presence_state='present' THEN file_size_bytes ELSE 0 END), 0) AS present_file_bytes,
           COALESCE(SUM(CASE WHEN presence_state='present' THEN wal_size_bytes ELSE 0 END), 0) AS present_wal_bytes,
           COALESCE(SUM(CASE WHEN last_inspected_at IS NOT NULL THEN file_size_bytes ELSE 0 END), 0) AS inspected
         FROM databases`,
      )
      .get() as {
      present: number;
      missing: number;
      unverified: number;
      present_file_bytes: number;
      present_wal_bytes: number;
      inspected: number;
    };
    const runCounts = this.db
      .prepare(
        `SELECT COUNT(*) AS attempts,
           SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN state='invalidated' THEN 1 ELSE 0 END) AS invalidations,
           SUM(CASE WHEN state='timeout' THEN 1 ELSE 0 END) AS timeouts,
           SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failures,
           COALESCE(SUM(reclaimed_bytes), 0) AS reclaimed
         FROM maintenance_runs`,
      )
      .get() as {
      attempts: number;
      successes: number;
      invalidations: number;
      timeouts: number;
      failures: number;
      reclaimed: number;
    };
    const open = this.db
      .prepare("SELECT COUNT(DISTINCT path_key) AS count FROM open_owners")
      .get() as { count: number };
    return {
      openPaths: open.count,
      presentDatabases: databaseCounts.present ?? 0,
      missingDatabases: databaseCounts.missing ?? 0,
      unverifiedDatabases: databaseCounts.unverified ?? 0,
      presentFileBytes: databaseCounts.present_file_bytes ?? 0,
      presentWalBytes: databaseCounts.present_wal_bytes ?? 0,
      attempts: runCounts.attempts ?? 0,
      successes: runCounts.successes ?? 0,
      invalidations: runCounts.invalidations ?? 0,
      timeouts: runCounts.timeouts ?? 0,
      failures: runCounts.failures ?? 0,
      inspectedBytes: databaseCounts.inspected ?? 0,
      reclaimedBytes: runCounts.reclaimed ?? 0,
    };
  }
}
