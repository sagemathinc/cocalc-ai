/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  ArtifactCatalogApi,
  CatalogEntry,
  CatalogEntryRequest,
  CatalogIngestRequest,
  CatalogPage,
  CatalogProjectRequest,
  CatalogRegistrationRequest,
  CatalogSourcePageRequest,
  CatalogWriterState,
} from "@cocalc/conat/hub/api/artifact-catalog";
import {
  ARTIFACT_CATALOG_MAX_PROJECT_BYTES,
  ARTIFACT_CATALOG_MAX_PROJECT_ITEMS,
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCE_BYTES,
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCES,
  ARTIFACT_CATALOG_MAX_PROJECT_WORK_PER_HOUR,
  artifactCatalogKey,
  validateArtifactCatalogSnapshot,
} from "@cocalc/util/artifact-catalog";
import type {
  ArtifactCatalogItem,
  ArtifactCatalogSnapshot,
  ArtifactCatalogSource,
} from "@cocalc/util/artifact-catalog";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedIdentity(value: unknown): void {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 200 ||
    value.includes("\0")
  ) {
    throw Error("invalid artifact catalog writer identity");
  }
}

interface SourceRow {
  epoch: string;
  registration_id: string;
  source_sequence: number;
  catalog_revision: number;
  payload_hash: string | null;
  metadata_hash: string | null;
}

/**
 * Trusted, service-local storage for exactly one Lite project. No Postgres or
 * network dependencies. Writer methods are NOT browser RPC implementations.
 * Put the file in service-private data, never the project tree; the caller owns
 * the containing directory and the service lease. close() follows worker drain.
 */
export class LiteArtifactCatalog implements ArtifactCatalogApi {
  private readonly db: DatabaseSync;

  constructor(
    private readonly options: { filename: string; project_id: string },
  ) {
    this.validateSource({
      project_id: options.project_id,
      chat_path: "/validate.chat",
    });
    if (options.filename !== ":memory:") {
      // Create privately before SQLite opens WAL/SHM siblings. Do not change the
      // process umask, which would affect unrelated concurrent Lite services.
      const fd = openSync(options.filename, "a", 0o600);
      closeSync(fd);
      chmodSync(options.filename, 0o600);
    }
    this.db = new DatabaseSync(options.filename);
    try {
      this.db.exec(`
        PRAGMA busy_timeout=5000;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS lite_artifact_project (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), project_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lite_artifact_sources (
          chat_path TEXT PRIMARY KEY, epoch TEXT NOT NULL, registration_id TEXT NOT NULL,
          source_sequence INTEGER NOT NULL DEFAULT 0,
          catalog_revision INTEGER NOT NULL DEFAULT 0,
          payload_hash TEXT, metadata_hash TEXT
        );
        CREATE TABLE IF NOT EXISTS lite_artifact_budget (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          window_start INTEGER NOT NULL, work_units INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lite_artifact_entries (
          entry_id TEXT PRIMARY KEY, chat_path TEXT NOT NULL, metadata TEXT NOT NULL,
          created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS lite_artifact_entries_source
          ON lite_artifact_entries(chat_path);
        CREATE INDEX IF NOT EXISTS lite_artifact_entries_page
          ON lite_artifact_entries(deleted,entry_id);
      `);
      this.transaction(() => {
        this.db
          .prepare("INSERT OR IGNORE INTO lite_artifact_project VALUES(1,?)")
          .run(options.project_id);
        const row = this.db
          .prepare(
            "SELECT project_id FROM lite_artifact_project WHERE singleton=1",
          )
          .get();
        if (row?.project_id !== options.project_id)
          throw Error("artifact catalog belongs to another Lite project");
        this.db
          .prepare("DELETE FROM lite_artifact_entries WHERE deleted=1")
          .run();
      });
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    // Keep the complete CAS / snapshot replacement synchronous under one writer
    // lock, including when separate SQLite connections share this catalog.
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

  private assertProject(project_id: string): void {
    if (project_id !== this.options.project_id)
      throw Error("project is not available in this Lite catalog");
  }

  private validateSource(source: ArtifactCatalogSource): void {
    this.assertProject(source.project_id);
    validateArtifactCatalogSnapshot({
      ...source,
      schema_version: 1,
      epoch: "validate",
      sequence: 1,
      items: [],
    });
  }

  private source(chat_path: string): SourceRow | undefined {
    return this.db
      .prepare("SELECT * FROM lite_artifact_sources WHERE chat_path=?")
      .get(chat_path) as unknown as SourceRow | undefined;
  }

  private chargeProjectWork(units: number): void {
    const now = Date.now();
    const current = this.db
      .prepare(
        "SELECT window_start,work_units FROM lite_artifact_budget WHERE singleton=1",
      )
      .get();
    const used =
      current && now - Number(current.window_start) < 3_600_000
        ? Number(current.work_units) + units
        : units;
    if (used > ARTIFACT_CATALOG_MAX_PROJECT_WORK_PER_HOUR)
      throw Error("artifact catalog project mutation budget exceeded");
    this.db
      .prepare(
        `INSERT INTO lite_artifact_budget(singleton,window_start,work_units) VALUES(1,?,?)
         ON CONFLICT(singleton) DO UPDATE SET window_start=excluded.window_start,work_units=excluded.work_units`,
      )
      .run(
        current && now - Number(current.window_start) < 3_600_000
          ? Number(current.window_start)
          : now,
        used,
      );
  }

  private assertProjectSize(): void {
    const row = this.db
      .prepare(
        `SELECT count(*) AS items,COALESCE(sum(length(CAST(metadata AS BLOB))),0) AS bytes
         FROM lite_artifact_entries`,
      )
      .get();
    if (
      Number(row?.items) > ARTIFACT_CATALOG_MAX_PROJECT_ITEMS ||
      Number(row?.bytes) > ARTIFACT_CATALOG_MAX_PROJECT_BYTES
    )
      throw Error("artifact catalog project metadata limit exceeded");
  }

  async writerState(
    source: ArtifactCatalogSource,
  ): Promise<CatalogWriterState | null> {
    this.validateSource(source);
    const row = this.source(source.chat_path);
    return row
      ? {
          epoch: row.epoch,
          registration_id: row.registration_id,
          source_sequence: row.source_sequence,
          writer_host_id: null,
        }
      : null;
  }

  async registerSource(
    request: CatalogRegistrationRequest,
  ): Promise<{ epoch: string }> {
    this.validateSource(request);
    boundedIdentity(request.registration_id);
    if (request.expected_epoch !== null)
      boundedIdentity(request.expected_epoch);
    return this.transaction(() => {
      const current = this.source(request.chat_path);
      if (current?.registration_id === request.registration_id)
        return { epoch: current.epoch };
      if ((current?.epoch ?? null) !== request.expected_epoch)
        throw Error("artifact catalog writer epoch changed");
      if (!current) {
        const row = this.db
          .prepare(
            `SELECT count(*) AS sources,COALESCE(sum(length(CAST(chat_path AS BLOB))),0) AS bytes
             FROM lite_artifact_sources`,
          )
          .get();
        if (
          Number(row?.sources) >= ARTIFACT_CATALOG_MAX_PROJECT_SOURCES ||
          Number(row?.bytes) + Buffer.byteLength(request.chat_path) >
            ARTIFACT_CATALOG_MAX_PROJECT_SOURCE_BYTES
        )
          throw Error("artifact catalog project source limit exceeded");
      }
      this.chargeProjectWork(1);
      const epoch = randomUUID();
      this.db
        .prepare(
          `INSERT INTO lite_artifact_sources(chat_path,epoch,registration_id)
        VALUES(?,?,?) ON CONFLICT(chat_path) DO UPDATE SET
        epoch=excluded.epoch,registration_id=excluded.registration_id,
        source_sequence=0,payload_hash=NULL`,
        )
        .run(request.chat_path, epoch, request.registration_id);
      return { epoch };
    });
  }

  async ingest(
    request: CatalogIngestRequest,
  ): Promise<{ revision: number; replayed: boolean }> {
    this.validateSource(request);
    if (
      request.snapshot.project_id !== request.project_id ||
      request.snapshot.chat_path !== request.chat_path
    ) {
      throw Error("artifact catalog snapshot source mismatch");
    }
    return this.applySnapshot(request.snapshot);
  }

  /** Bind this to the portable projector's send callback (discard its result). */
  async applySnapshot(
    input: ArtifactCatalogSnapshot,
  ): Promise<{ revision: number; replayed: boolean }> {
    this.assertProject(input.project_id);
    const snapshot = validateArtifactCatalogSnapshot(input);
    const payloadHash = hash(JSON.stringify(snapshot));
    const metadataHash = hash(JSON.stringify(snapshot.items));
    return this.transaction(() => {
      const current = this.source(snapshot.chat_path);
      if (!current || current.epoch !== snapshot.epoch)
        throw Error("stale artifact catalog writer epoch");
      if (current.source_sequence > snapshot.sequence)
        throw Error("stale artifact catalog snapshot");
      if (current.source_sequence === snapshot.sequence) {
        if (current.payload_hash !== payloadHash)
          throw Error(
            "artifact catalog sequence reused with different metadata",
          );
        return { revision: current.catalog_revision, replayed: true };
      }
      const replayed = current.metadata_hash === metadataHash;
      const revision = current.catalog_revision + (replayed ? 0 : 1);
      if (!Number.isSafeInteger(revision))
        throw Error("artifact catalog revision exhausted");
      if (!replayed) {
        const existing = this.db
          .prepare(
            "SELECT count(*) AS items FROM lite_artifact_entries WHERE chat_path=? AND deleted=0",
          )
          .get(snapshot.chat_path);
        this.chargeProjectWork(
          Math.max(1, snapshot.items.length + Number(existing?.items)),
        );
        // Mark-then-upsert avoids SQLite parameter-count limits. The final
        // delete makes omission permanent while retaining time for live edits.
        this.db
          .prepare(
            "UPDATE lite_artifact_entries SET deleted=1 WHERE chat_path=? AND deleted=0",
          )
          .run(snapshot.chat_path);
        const created = this.db.prepare(
          "SELECT created_at FROM lite_artifact_entries WHERE entry_id=?",
        );
        const upsert = this.db.prepare(`INSERT INTO lite_artifact_entries
          (entry_id,chat_path,metadata,created_at) VALUES(?,?,?,?)
          ON CONFLICT(entry_id) DO UPDATE SET metadata=excluded.metadata,deleted=0`);
        for (const item of snapshot.items) {
          const entry_id = hash(artifactCatalogKey(snapshot, item));
          const created_at = Number(
            created.get(entry_id)?.created_at ?? item.created_at,
          );
          upsert.run(
            entry_id,
            snapshot.chat_path,
            JSON.stringify({ ...item, created_at }),
            created_at,
          );
        }
        this.db
          .prepare("DELETE FROM lite_artifact_entries WHERE deleted=1")
          .run();
        this.assertProjectSize();
      }
      this.db
        .prepare(
          `UPDATE lite_artifact_sources SET source_sequence=?,catalog_revision=?,
        payload_hash=?,metadata_hash=? WHERE chat_path=?`,
        )
        .run(
          snapshot.sequence,
          revision,
          payloadHash,
          metadataHash,
          snapshot.chat_path,
        );
      return { revision, replayed };
    });
  }

  async getEntry({
    project_id,
    entry_id,
  }: CatalogEntryRequest): Promise<CatalogEntry | null> {
    this.assertProject(project_id);
    if (typeof entry_id !== "string" || !/^[a-f0-9]{64}$/.test(entry_id))
      throw Error("invalid catalog entry_id");
    const row = this.db
      .prepare(
        `SELECT entry_id,chat_path,metadata FROM lite_artifact_entries
        WHERE entry_id=? AND deleted=0`,
      )
      .get(entry_id);
    return row
      ? {
          entry_id: row.entry_id as string,
          project_id,
          chat_path: row.chat_path as string,
          item: JSON.parse(row.metadata as string) as ArtifactCatalogItem,
        }
      : null;
  }

  async listProject({
    project_id,
    after = "",
  }: CatalogProjectRequest): Promise<CatalogPage> {
    this.assertProject(project_id);
    if (typeof after !== "string" || (after && !/^[a-f0-9]{64}$/.test(after)))
      throw Error("invalid catalog cursor");
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT entry_id,chat_path,metadata FROM lite_artifact_entries
        WHERE deleted=0 AND entry_id>? ORDER BY entry_id LIMIT 101`,
        )
        .all(after);
      const entries = rows.slice(0, 100).map((row) => ({
        entry_id: row.entry_id as string,
        project_id,
        chat_path: row.chat_path as string,
        item: JSON.parse(row.metadata as string) as ArtifactCatalogItem,
      }));
      const count = this.db
        .prepare(
          "SELECT count(*) AS n FROM lite_artifact_sources WHERE source_sequence>0",
        )
        .get();
      return {
        entries,
        indexed_sources: Number(count?.n),
        ...(rows.length > 100 ? { next: entries[99].entry_id } : {}),
      };
    });
  }

  /** Known sources, including empty/deleted chats; discovery seeds come from the caller. */
  async sourcePage({
    project_id,
    after = "",
  }: CatalogSourcePageRequest): Promise<{ paths: string[]; next?: string }> {
    this.assertProject(project_id);
    if (
      typeof after !== "string" ||
      after.length > 4096 ||
      after.includes("\0")
    )
      throw Error("invalid source cursor");
    const rows = this.db
      .prepare(
        "SELECT chat_path FROM lite_artifact_sources WHERE chat_path>? ORDER BY chat_path LIMIT 101",
      )
      .all(after);
    const paths = rows.slice(0, 100).map((row) => row.chat_path as string);
    return { paths, ...(rows.length > 100 ? { next: paths[99] } : {}) };
  }
}

/** Only metadata reads belong on the Lite browser API; local writers bypass RPC. */
export function liteArtifactCatalogReadApi(
  catalog: LiteArtifactCatalog,
  account_id: string,
): Pick<ArtifactCatalogApi, "listProject" | "getEntry"> {
  if (!account_id) throw Error("Lite catalog account is required");
  return {
    async getEntry(request) {
      if (request.account_id !== account_id)
        throw Error("artifact catalog requires the local Lite account");
      return catalog.getEntry(request);
    },
    async listProject(request) {
      if (request.account_id !== account_id)
        throw Error("artifact catalog requires the local Lite account");
      return catalog.listProject(request);
    },
  };
}
