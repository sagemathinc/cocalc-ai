/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  validateArtifactCatalogSnapshot,
  type ArtifactCatalogItem,
  type ArtifactCatalogSnapshot,
  type ArtifactCatalogSource,
} from "@cocalc/util/artifact-catalog";

export interface CatalogScan extends ArtifactCatalogSource {
  epoch: string;
  generation: number;
}

export interface CatalogRegistration extends ArtifactCatalogSource {
  registration_id: string;
}

/**
 * Host-private write-ahead journal. The service owns one instance and fences
 * previous service processes before recovery. Never place this in user HOME.
 * File bytes are authoritative; only immutable metadata deliveries live here.
 */
export class ArtifactCatalogJournal {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS artifact_sources (
        project_id TEXT NOT NULL,
        chat_path TEXT NOT NULL,
        epoch TEXT NOT NULL,
        registration_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        sequence INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 1,
        retry_at INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id, chat_path)
      );
      CREATE INDEX IF NOT EXISTS artifact_sources_ready ON artifact_sources(dirty,retry_at);
      CREATE TABLE IF NOT EXISTS artifact_writes (
        token TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        chat_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifact_writes_source
        ON artifact_writes(project_id,chat_path);
      CREATE TABLE IF NOT EXISTS artifact_deliveries (
        project_id TEXT NOT NULL,
        chat_path TEXT NOT NULL,
        epoch TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(project_id, chat_path)
      );
      CREATE TABLE IF NOT EXISTS artifact_registrations (
        registration_id TEXT PRIMARY KEY,
        expected_epoch TEXT,
        retry_at INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close() {
    this.db.close();
  }

  /** Keyset paging for bounded reconciliation, including sources now deleted. */
  sources(
    project_id: string,
    after = "",
    limit = 100,
  ): ArtifactCatalogSource[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw Error("invalid source page size");
    return this.db
      .prepare(
        `SELECT project_id,chat_path FROM artifact_sources
      WHERE project_id=? AND chat_path>? ORDER BY chat_path LIMIT ?`,
      )
      .all(project_id, after, limit) as unknown as ArtifactCatalogSource[];
  }

  descendants(
    project_id: string,
    path: string,
    after = "",
  ): ArtifactCatalogSource[] {
    const root = path.replace(/\/$/, "");
    return this.db
      .prepare(
        `SELECT project_id,chat_path FROM artifact_sources
      WHERE project_id=? AND chat_path>=? AND chat_path<? AND chat_path>?
      ORDER BY chat_path LIMIT 100`,
      )
      .all(
        project_id,
        root + "/",
        root + "0",
        after,
      ) as unknown as ArtifactCatalogSource[];
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Register only an epoch issued by the owning bay to this host assignment. */
  register(source: ArtifactCatalogSource, epoch: string) {
    validateArtifactCatalogSnapshot({
      ...source,
      schema_version: 1,
      epoch,
      sequence: 1,
      items: [],
    });
    this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT epoch FROM artifact_sources WHERE project_id=? AND chat_path=?",
        )
        .get(source.project_id, source.chat_path);
      if (previous?.epoch === epoch) return;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM artifact_writes WHERE project_id=? AND chat_path=? LIMIT 1",
          )
          .get(source.project_id, source.chat_path)
      )
        throw Error("artifact source is being written");
      this.db
        .prepare(
          `INSERT INTO artifact_sources(project_id,chat_path,epoch,registration_id)
        VALUES(?,?,?,?) ON CONFLICT(project_id,chat_path) DO UPDATE SET
        epoch=excluded.epoch,generation=generation+1,sequence=0,dirty=1,retry_at=0,failures=0`,
        )
        .run(source.project_id, source.chat_path, epoch, randomUUID());
      this.db
        .prepare(
          "DELETE FROM artifact_deliveries WHERE project_id=? AND chat_path=?",
        )
        .run(source.project_id, source.chat_path);
    });
  }

  /** Commit this intent BEFORE touching the file, including deletes/renames. */
  beginWrite(source: ArtifactCatalogSource): string {
    validateArtifactCatalogSnapshot({
      ...source,
      schema_version: 1,
      epoch: "pending",
      sequence: 1,
      items: [],
    });
    return this.transaction(() => {
      // First writes do not require an available hub. Registration is retried
      // asynchronously using this durable identity before any metadata is sent.
      this.db
        .prepare(
          `INSERT INTO artifact_sources(project_id,chat_path,epoch,registration_id)
        VALUES(?,?,'',?) ON CONFLICT(project_id,chat_path) DO NOTHING`,
        )
        .run(source.project_id, source.chat_path, randomUUID());
      const result = this.db
        .prepare(
          `UPDATE artifact_sources
        SET generation=generation+1,dirty=1,retry_at=0,failures=0 WHERE project_id=? AND chat_path=?`,
        )
        .run(source.project_id, source.chat_path);
      if (!result.changes) throw Error("unregistered artifact source");
      const token = randomUUID();
      this.db
        .prepare("INSERT INTO artifact_writes VALUES(?,?,?)")
        .run(token, source.project_id, source.chat_path);
      return token;
    });
  }

  pendingRegistrations(limit = 32, now = Date.now()): CatalogRegistration[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error("invalid catalog registration limit");
    return this.db
      .prepare(
        `SELECT s.project_id,s.chat_path,s.registration_id FROM artifact_sources s
      LEFT JOIN artifact_registrations r USING(registration_id)
      WHERE s.epoch='' AND MAX(s.retry_at,COALESCE(r.retry_at,0))<=?
      ORDER BY s.project_id,s.chat_path LIMIT ?`,
      )
      .all(now, limit) as unknown as CatalogRegistration[];
  }

  registrationBase(
    source: CatalogRegistration,
  ): { expected_epoch: string | null } | undefined {
    const row = this.db
      .prepare(
        "SELECT expected_epoch FROM artifact_registrations WHERE registration_id=?",
      )
      .get(source.registration_id);
    return row
      ? { expected_epoch: row.expected_epoch as string | null }
      : undefined;
  }

  /** Freeze the CAS base before sending; retries must never steal a newer writer. */
  prepareRegistration(
    source: CatalogRegistration,
    expected_epoch: string | null,
  ) {
    this.db
      .prepare(
        `INSERT INTO artifact_registrations(registration_id,expected_epoch)
      VALUES(?,?) ON CONFLICT(registration_id) DO NOTHING`,
      )
      .run(source.registration_id, expected_epoch);
    return this.registrationBase(source)!;
  }

  deferRegistration(source: CatalogRegistration, now = Date.now()) {
    // A lookup can fail before a CAS base exists. Do not invent a base in that
    // case; use the source backoff, which pendingRegistrations also observes.
    this.db
      .prepare(
        `UPDATE artifact_sources SET
      retry_at=?+MIN(60000,1000*(1 << MIN(failures,6))),failures=MIN(failures+1,10)
      WHERE project_id=? AND chat_path=? AND registration_id=? AND epoch=''`,
      )
      .run(now, source.project_id, source.chat_path, source.registration_id);
    this.db
      .prepare(
        `UPDATE artifact_registrations SET
      retry_at=?+MIN(60000,1000*(1 << MIN(failures,6))),failures=MIN(failures+1,10)
      WHERE registration_id=?`,
      )
      .run(now, source.registration_id);
  }

  /** Call in finally: failed writes must also be reconciled against actual bytes. */
  finishWrite(token: string) {
    this.db.prepare("DELETE FROM artifact_writes WHERE token=?").run(token);
  }

  async write<T>(
    source: ArtifactCatalogSource,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const token = this.beginWrite(source);
    try {
      return await mutation();
    } finally {
      this.finishWrite(token);
    }
  }

  /** Only after the supervisor has fenced all old writers; never timeout a writer. */
  recoverInterruptedWrites() {
    this.transaction(() => {
      this.db.exec(`UPDATE artifact_sources SET dirty=1,generation=generation+1
        WHERE EXISTS (SELECT 1 FROM artifact_writes w
          WHERE w.project_id=artifact_sources.project_id AND w.chat_path=artifact_sources.chat_path);
        DELETE FROM artifact_writes;`);
    });
  }

  scans(limit = 32, now = Date.now()): CatalogScan[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error("invalid catalog scan limit");
    return this.db
      .prepare(
        `SELECT project_id,chat_path,epoch,generation FROM artifact_sources s
      WHERE dirty=1 AND epoch<>'' AND retry_at<=? AND NOT EXISTS (SELECT 1 FROM artifact_writes w
        WHERE w.project_id=s.project_id AND w.chat_path=s.chat_path)
      AND NOT EXISTS (SELECT 1 FROM artifact_deliveries d
        WHERE d.project_id=s.project_id AND d.chat_path=s.chat_path AND d.generation=s.generation)
      ORDER BY generation,project_id,chat_path LIMIT ?`,
      )
      .all(now, limit) as unknown as CatalogScan[];
  }

  /** False means a write raced the scan; discard it and rescan, never publish it. */
  prepare(scan: CatalogScan, items: ArtifactCatalogItem[]): boolean {
    return this.transaction(() => {
      const current = this.db
        .prepare(
          `SELECT sequence FROM artifact_sources s
        WHERE project_id=? AND chat_path=? AND epoch=? AND generation=? AND dirty=1
        AND NOT EXISTS (SELECT 1 FROM artifact_writes w
          WHERE w.project_id=s.project_id AND w.chat_path=s.chat_path)`,
        )
        .get(scan.project_id, scan.chat_path, scan.epoch, scan.generation);
      if (!current) return false;
      const sequence = Number(current.sequence) + 1;
      const payload = validateArtifactCatalogSnapshot({
        schema_version: 1,
        project_id: scan.project_id,
        chat_path: scan.chat_path,
        epoch: scan.epoch,
        sequence,
        items,
      });
      this.db
        .prepare(
          `INSERT INTO artifact_deliveries VALUES(?,?,?,?,?,?)
        ON CONFLICT(project_id,chat_path) DO UPDATE SET epoch=excluded.epoch,
        sequence=excluded.sequence,generation=excluded.generation,payload=excluded.payload`,
        )
        .run(
          scan.project_id,
          scan.chat_path,
          scan.epoch,
          sequence,
          scan.generation,
          JSON.stringify(payload),
        );
      this.db
        .prepare(
          "UPDATE artifact_sources SET sequence=? WHERE project_id=? AND chat_path=?",
        )
        .run(sequence, scan.project_id, scan.chat_path);
      return true;
    });
  }

  deliveries(limit = 32, now = Date.now()): ArtifactCatalogSnapshot[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error("invalid catalog delivery limit");
    return this.db
      .prepare(
        `SELECT d.payload FROM artifact_deliveries d
      JOIN artifact_sources s USING(project_id,chat_path)
      WHERE d.epoch=s.epoch AND d.generation=s.generation AND s.retry_at<=?
      AND NOT EXISTS (SELECT 1 FROM artifact_writes w
        WHERE w.project_id=s.project_id AND w.chat_path=s.chat_path)
      ORDER BY d.sequence,d.project_id,d.chat_path LIMIT ?`,
      )
      .all(now, limit)
      .map((row) => JSON.parse(String(row.payload)));
  }

  /** Persist backoff so failing sources cannot starve the rest of a bounded pass. */
  defer(source: CatalogScan | ArtifactCatalogSnapshot, now = Date.now()) {
    const scan = "generation" in source;
    this.db
      .prepare(
        `UPDATE artifact_sources SET
      retry_at=?+MIN(60000,1000*(1 << MIN(failures,6))),failures=MIN(failures+1,10)
      WHERE project_id=? AND chat_path=? AND epoch=? AND ${scan ? "generation" : "sequence"}=?`,
      )
      .run(
        now,
        source.project_id,
        source.chat_path,
        source.epoch,
        scan ? source.generation : source.sequence,
      );
  }

  /** A late acknowledgement must not clear a newer write or prepared delivery. */
  acknowledge(snapshot: ArtifactCatalogSnapshot) {
    this.transaction(() => {
      const args = [
        snapshot.project_id,
        snapshot.chat_path,
        snapshot.epoch,
        snapshot.sequence,
      ];
      const delivery = this.db
        .prepare(
          `SELECT generation FROM artifact_deliveries
        WHERE project_id=? AND chat_path=? AND epoch=? AND sequence=?`,
        )
        .get(...args);
      if (!delivery) return;
      this.db
        .prepare(
          `UPDATE artifact_sources SET dirty=0,retry_at=0,failures=0
        WHERE project_id=? AND chat_path=? AND epoch=? AND sequence=? AND generation=?`,
        )
        .run(...args, delivery.generation!);
      this.db
        .prepare(
          `DELETE FROM artifact_deliveries
        WHERE project_id=? AND chat_path=? AND epoch=? AND sequence=?`,
        )
        .run(...args);
    });
  }
}
