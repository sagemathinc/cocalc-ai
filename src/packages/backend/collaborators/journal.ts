/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import { posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomReplacementJournal } from "./room-replacement-journal";
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import { SourceRelations } from "./relations";
import { COLLABORATION_RELATION_MANIFEST_BYTES } from "@cocalc/util/collaboration-relations";
import type { CollaborationMessageEvent } from "@cocalc/util/collaboration-attention";
import {
  SourceActivity,
  type ActivitySource,
  type CollaborationActivityPage,
} from "./activity";
import {
  SourceNotifications,
  type CollaborationDelivery,
} from "./notifications";
import {
  COLLABORATION_MAX_SOURCE_BYTES,
  COLLABORATION_MAX_SOURCE_RESOURCES,
  type CollaborationSourceSnapshot,
} from "@cocalc/util/collaborators";

export interface CollaborationSource {
  project_id: string;
  chat_path: string;
}
export interface CollaborationScan extends CollaborationSource {
  epoch: string;
  generation: number;
}
export interface CollaborationRegistration extends CollaborationSource {
  registration_id: string;
  expected_epoch: string | null;
}
export interface CollaborationRead {
  resources: CollaborationSourceSnapshot["resources"];
  activity_ids: Record<string, string[]>;
  /** A sealed complete-history relation draft; never inferred from preview arrays. */
  relation_draft?: string;
  /** Summary/relation coverage only; resources must always be a complete scan. */
  coverage?: "complete" | "partial";
  coverage_message?: string;
  notification_room_id?: string;
  notification_messages?: Omit<
    CollaborationMessageEvent,
    "activity" | "mode"
  >[];
  lifecycle_generation?: number;
}
export interface CollaborationRelocation {
  operation_id: string;
  project_id: string;
  from_path: string;
  to_path: string;
  state: "pending" | "ready" | "unknown";
}
export interface CollaborationRelocationRequest {
  operation_id: string;
  project_id: string;
  from_chat_path: string;
  to_chat_path: string;
  expected_epoch: string;
  expected_destination_epoch: string | null;
}
export interface CollaborationCopy extends CollaborationSource {
  from_path: string;
  operation_id: string;
  state: "pending" | "ready" | "unknown";
  fingerprint: string | null;
}

function validateSource(source: CollaborationSource) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      source.project_id,
    ) ||
    typeof source.chat_path !== "string" ||
    source.chat_path.length > 2048 ||
    source.chat_path.includes("\0") ||
    !posix.isAbsolute(source.chat_path) ||
    posix.normalize(source.chat_path) !== source.chat_path ||
    !/\.(sage-)?chat$/.test(source.chat_path)
  )
    throw Error("invalid collaboration source");
}
function limit(n: number) {
  if (!Number.isInteger(n) || n < 1 || n > 100)
    throw Error("invalid collaboration page limit");
}

/** Count work, not historical clean sources. UNION deduplicates dirty deliveries. */
export const collaborationCensusProgressSql = `SELECT
  (SELECT count(*) FROM (
    SELECT chat_path FROM sources WHERE project_id=? AND (dirty<>0 OR epoch='')
    UNION
    SELECT d.chat_path FROM deliveries d JOIN sources s
      ON s.project_id=d.project_id AND s.chat_path=d.chat_path WHERE d.project_id=?
  ) p WHERE NOT EXISTS(SELECT 1 FROM source_redirects r WHERE r.project_id=? AND r.chat_path=p.chat_path)) pending,
  (SELECT count(*) FROM sources s WHERE s.project_id=? AND s.failures>0
    AND NOT EXISTS(SELECT 1 FROM source_redirects r WHERE r.project_id=s.project_id AND r.chat_path=s.chat_path)) errors`;

/** Host-private durable intent, one pending delivery per source, never transcripts. */
export class CollaborationJournal {
  private readonly db: DatabaseSync;
  private readonly notifications: SourceNotifications;
  private readonly activity: SourceActivity;
  private readonly roomReplacements: RoomReplacementJournal;
  readonly relations: SourceRelations;
  private closed = false;
  private disabledObserved = false;
  constructor(
    filename: string,
    private readonly capacity = { sources: 10_000, bytes: 256 * 1024 * 1024 },
    private readonly requireActivityRecovery = false,
    private readonly enabled?: () => Promise<boolean> | boolean,
  ) {
    this.db = new DatabaseSync(filename);
    this.notifications = new SourceNotifications(this.db);
    this.activity = new SourceActivity(this.db);
    this.relations = new SourceRelations(this.db);
    this.roomReplacements = new RoomReplacementJournal(this.db, (source) =>
      this.relations.retireSource(source),
    );
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sources (
        project_id TEXT NOT NULL, chat_path TEXT NOT NULL,
        registration_id TEXT NOT NULL, expected_epoch TEXT, registration_prepared INTEGER NOT NULL DEFAULT 0, epoch TEXT NOT NULL DEFAULT '',
        generation INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 1, retry_at INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0, activity TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(project_id,chat_path));
      CREATE INDEX IF NOT EXISTS sources_ready ON sources(dirty,retry_at);
      CREATE INDEX IF NOT EXISTS sources_census_pending ON sources(project_id,chat_path) WHERE dirty<>0 OR epoch='';
      CREATE INDEX IF NOT EXISTS sources_census_errors ON sources(project_id,chat_path) WHERE failures>0;
      CREATE TABLE IF NOT EXISTS census_receipts (
        project_id TEXT NOT NULL, chat_path TEXT NOT NULL, run_id TEXT NOT NULL,
        PRIMARY KEY(project_id,chat_path));
      CREATE TABLE IF NOT EXISTS writes (token TEXT PRIMARY KEY, project_id TEXT NOT NULL, chat_path TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS writes_source ON writes(project_id,chat_path);
      CREATE TABLE IF NOT EXISTS deliveries (
        project_id TEXT NOT NULL, chat_path TEXT NOT NULL, epoch TEXT NOT NULL,
        sequence INTEGER NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(project_id,chat_path));
      CREATE TABLE IF NOT EXISTS rooms (project_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS room_initializations (
        project_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, chat_path TEXT NOT NULL,
        lifecycle_generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS locators (
        project_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL, chat_path TEXT NOT NULL,
        PRIMARY KEY(project_id,kind,resource_id));
      CREATE INDEX IF NOT EXISTS locators_source ON locators(project_id,chat_path);
      CREATE TABLE IF NOT EXISTS relocations (
        operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_path TEXT NOT NULL,
        to_path TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relocation_requests (
        operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS source_redirects (
        project_id TEXT NOT NULL, chat_path TEXT NOT NULL, to_path TEXT NOT NULL,
        PRIMARY KEY(project_id,chat_path));
      CREATE TABLE IF NOT EXISTS copies (
        project_id TEXT NOT NULL, chat_path TEXT NOT NULL, from_path TEXT NOT NULL,
        operation_id TEXT, state TEXT NOT NULL DEFAULT 'unknown', fingerprint TEXT,
        retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id,chat_path));
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(sources)")
        .all()
        .some((column) => column.name === "registration_prepared")
    )
      this.db.exec(
        "ALTER TABLE sources ADD COLUMN registration_prepared INTEGER NOT NULL DEFAULT 0",
      );
    for (const [name, definition] of [
      ["operation_id", "TEXT"],
      ["state", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["fingerprint", "TEXT"],
      ["retry_at", "INTEGER NOT NULL DEFAULT 0"],
      ["failures", "INTEGER NOT NULL DEFAULT 0"],
    ]) {
      if (
        !this.db
          .prepare("PRAGMA table_info(copies)")
          .all()
          .some((column) => column.name === name)
      )
        this.db.exec(`ALTER TABLE copies ADD COLUMN ${name} ${definition}`);
    }
  }
  close() {
    this.closed = true;
    this.db.close();
  }
  async isEnabled(): Promise<boolean> {
    if (this.closed) return false;
    let enabled = false;
    try {
      enabled = this.enabled ? (await this.enabled()) === true : true;
    } catch {}
    if (this.closed) return false;
    if (!enabled) {
      // No disk or source work while disabled, even on retained filesystem objects.
      this.disabledObserved = true;
      return false;
    }
    if (this.disabledObserved) {
      this.transaction(() =>
        this.db.exec(`
        UPDATE sources SET dirty=1,generation=generation+1,retry_at=0;
        DELETE FROM notification_baselines;
      `),
      );
      this.disabledObserved = false;
    }
    return true;
  }
  private transaction<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = f();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  private source(source: CollaborationSource) {
    return this.db
      .prepare("SELECT * FROM sources WHERE project_id=? AND chat_path=?")
      .get(source.project_id, source.chat_path);
  }
  private payloadBytes(): number {
    return (
      this.activity.bytes +
      this.notifications.bytes +
      Number(
        this.db
          .prepare(
            "SELECT COALESCE(SUM(length(CAST(activity AS BLOB))),0) AS n FROM sources",
          )
          .get()!.n,
      ) +
      Number(
        this.db
          .prepare(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM deliveries",
          )
          .get()!.n,
      )
    );
  }
  beginWrite(source: CollaborationSource): string {
    validateSource(source);
    return this.transaction(() => this.beginWriteInTransaction(source));
  }
  private beginWriteInTransaction(source: CollaborationSource): string {
    this.roomReplacements.assertWritable(source);
    if (!this.source(source)) {
      if (
        Number(this.db.prepare("SELECT count(*) AS n FROM sources").get()!.n) >=
        this.capacity.sources
      )
        throw Error("collaboration source journal capacity reached");
      this.db
        .prepare(
          "INSERT INTO sources(project_id,chat_path,registration_id) VALUES(?,?,?)",
        )
        .run(source.project_id, source.chat_path, randomUUID());
    }
    if (
      Number(this.db.prepare("SELECT count(*) AS n FROM writes").get()!.n) >=
      1000
    )
      throw Error("collaboration write capacity reached");
    this.db
      .prepare(
        "UPDATE sources SET generation=generation+1,dirty=1 WHERE project_id=? AND chat_path=?",
      )
      .run(source.project_id, source.chat_path);
    const token = randomUUID();
    this.db
      .prepare("INSERT INTO writes VALUES(?,?,?)")
      .run(token, source.project_id, source.chat_path);
    return token;
  }
  /** Receipt and dirty intent are atomic; a lost census ACK does not re-dirty it. */
  acceptCensusCandidate(
    source: CollaborationSource & { run_id: string },
  ): boolean {
    validateSource(source);
    if (!source.run_id || source.run_id.length > 200)
      throw Error("invalid census run id");
    if (this.roomReplacements.isRetired(source)) return false;
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT run_id FROM census_receipts WHERE project_id=? AND chat_path=?",
        )
        .get(source.project_id, source.chat_path);
      if (prior?.run_id === source.run_id) return false;
      this.finishWrite(this.beginWriteInTransaction(source));
      this.db
        .prepare(
          "INSERT INTO census_receipts VALUES(?,?,?) ON CONFLICT(project_id,chat_path) DO UPDATE SET run_id=excluded.run_id",
        )
        .run(source.project_id, source.chat_path, source.run_id);
      return true;
    });
  }
  finishWrite(token: string) {
    this.db.prepare("DELETE FROM writes WHERE token=?").run(token);
  }
  touch(source: CollaborationSource) {
    if (this.roomReplacements.isRetired(source)) return;
    this.finishWrite(this.beginWrite(source));
  }
  armNotifications(
    source: CollaborationSource,
    room_id: string,
    lifecycle_generation = 0,
  ) {
    validateSource(source);
    this.touch(source);
    this.transaction(() =>
      this.notifications.arm(source, room_id, lifecycle_generation),
    );
  }
  recoverInterruptedWrites() {
    this.transaction(() => {
      this.db.exec(
        `UPDATE sources SET dirty=1,generation=generation+1 WHERE EXISTS (SELECT 1 FROM writes w WHERE w.project_id=sources.project_id AND w.chat_path=sources.chat_path); DELETE FROM writes;
         UPDATE relocations SET state='unknown' WHERE state='pending'; UPDATE copies SET state='unknown' WHERE state='pending';`,
      );
    });
  }
  activityRecovery(source: ActivitySource) {
    return this.activity.recovery(source);
  }
  restartActivityRecovery(source: ActivitySource) {
    this.activity.restart(source);
  }
  activityRecoveries(count = 16, now = Date.now()): ActivitySource[] {
    limit(count);
    return this.db
      .prepare(
        `SELECT s.project_id,s.chat_path,s.epoch FROM sources s WHERE s.epoch<>'' AND s.retry_at<=?
      AND NOT EXISTS (SELECT 1 FROM activity_imports a WHERE a.project_id=s.project_id AND a.chat_path=s.chat_path AND a.epoch=s.epoch AND a.complete=1)
      AND NOT EXISTS (SELECT 1 FROM relocations r WHERE r.project_id=s.project_id AND (r.from_path=s.chat_path OR r.to_path=s.chat_path))
      AND NOT EXISTS (SELECT 1 FROM copies c WHERE c.project_id=s.project_id AND c.chat_path=s.chat_path)
      AND NOT EXISTS (SELECT 1 FROM source_redirects d WHERE d.project_id=s.project_id AND d.chat_path=s.chat_path)
      ORDER BY s.retry_at,s.project_id,s.chat_path LIMIT ?`,
      )
      .all(now, count) as unknown as ActivitySource[];
  }
  importActivityPage(
    source: ActivitySource,
    page: CollaborationActivityPage,
  ): boolean {
    return this.transaction(() => {
      if (this.source(source)?.epoch !== source.epoch) return false;
      this.activity.importPage(source, page);
      // Before the first send under a recovered epoch, keep metadata above owner
      // floors while preserving immutable pending event facts and positions.
      const delivery = this.db
        .prepare(
          "SELECT payload FROM deliveries WHERE project_id=? AND chat_path=? AND epoch=?",
        )
        .get(source.project_id, source.chat_path, source.epoch);
      if (delivery) {
        const snapshot: CollaborationDelivery = JSON.parse(
          String(delivery.payload),
        );
        snapshot.resources = snapshot.resources.map((resource) => ({
          ...resource,
          activity: Math.max(
            resource.activity,
            this.activity.floor(source, resource),
          ),
        }));
        if (
          Buffer.byteLength(JSON.stringify(snapshot)) >
          COLLABORATION_MAX_SOURCE_BYTES
        )
          throw Error(
            "recovered collaboration snapshot byte capacity exceeded",
          );
        this.db
          .prepare(
            "UPDATE deliveries SET payload=? WHERE project_id=? AND chat_path=? AND epoch=?",
          )
          .run(
            JSON.stringify(snapshot),
            source.project_id,
            source.chat_path,
            source.epoch,
          );
      }
      if (this.payloadBytes() > this.capacity.bytes)
        throw Error("collaboration activity checkpoint byte capacity exceeded");
      return this.activity.recovery(source).complete;
    });
  }
  censusProgress(project_id: string): {
    source_pending: number;
    source_errors: number;
  } {
    const row = this.db
      .prepare(collaborationCensusProgressSql)
      .get(project_id, project_id, project_id, project_id)!;
    return {
      source_pending: Number(row.pending),
      source_errors: Number(row.errors),
    };
  }

  sources(after = "", count = 100): CollaborationSource[] {
    limit(count);
    return this.db
      .prepare(
        "SELECT project_id,chat_path FROM sources s WHERE project_id || ':' || chat_path > ? AND NOT EXISTS (SELECT 1 FROM source_redirects d WHERE d.project_id=s.project_id AND d.chat_path=s.chat_path) ORDER BY project_id,chat_path LIMIT ?",
      )
      .all(after, count) as unknown as CollaborationSource[];
  }
  descendants(
    project_id: string,
    path: string,
    after = "",
  ): CollaborationSource[] {
    const root = path.replace(/\/$/, "");
    return this.db
      .prepare(
        "SELECT project_id,chat_path FROM sources s WHERE project_id=? AND chat_path>=? AND chat_path<? AND chat_path>? AND NOT EXISTS (SELECT 1 FROM source_redirects d WHERE d.project_id=s.project_id AND d.chat_path=s.chat_path) ORDER BY chat_path LIMIT 100",
      )
      .all(
        project_id,
        root + "/",
        root + "0",
        after,
      ) as unknown as CollaborationSource[];
  }
  /** Shared with the independent artifact producer during cross-catalog moves. */
  assertSourceReady(source: CollaborationSource) {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM relocations WHERE project_id=? AND (from_path=? OR to_path=?)
      UNION ALL SELECT 1 FROM copies WHERE project_id=? AND chat_path=?
      UNION ALL SELECT 1 FROM source_redirects WHERE project_id=? AND chat_path=? LIMIT 1`,
        )
        .get(
          source.project_id,
          source.chat_path,
          source.chat_path,
          source.project_id,
          source.chat_path,
          source.project_id,
          source.chat_path,
        )
    )
      throw Error(
        "collaboration source identity transition pending or retired",
      );
  }
  registrationIsCurrent(source: CollaborationRegistration): boolean {
    const row = this.source(source);
    return (
      row?.epoch === "" &&
      row.registration_id === source.registration_id &&
      !this.db
        .prepare(
          `SELECT 1 FROM relocations WHERE project_id=? AND to_path=?
      UNION ALL SELECT 1 FROM source_redirects WHERE project_id=? AND chat_path=? LIMIT 1`,
        )
        .get(
          source.project_id,
          source.chat_path,
          source.project_id,
          source.chat_path,
        )
    );
  }
  deliveryIsCurrent(snapshot: CollaborationSourceSnapshot): boolean {
    try {
      this.assertSourceReady(snapshot);
    } catch {
      return false;
    }
    return (
      !!this.db
        .prepare(
          `SELECT 1 FROM deliveries d JOIN sources s USING(project_id,chat_path)
      WHERE d.project_id=? AND d.chat_path=? AND d.epoch=? AND d.sequence=? AND d.epoch=s.epoch`,
        )
        .get(
          snapshot.project_id,
          snapshot.chat_path,
          snapshot.epoch,
          snapshot.sequence,
        ) &&
      (!this.requireActivityRecovery ||
        this.activity.recovery(snapshot).complete)
    );
  }
  registrations(count = 16, now = Date.now()): CollaborationRegistration[] {
    limit(count);
    return this.db
      .prepare(
        `SELECT project_id,chat_path,registration_id,expected_epoch FROM sources s WHERE epoch='' AND retry_at<=?
        AND NOT EXISTS (SELECT 1 FROM relocations r WHERE r.project_id=s.project_id AND r.to_path=s.chat_path)
        AND NOT EXISTS (SELECT 1 FROM source_redirects d WHERE d.project_id=s.project_id AND d.chat_path=s.chat_path)
        ORDER BY retry_at,project_id,chat_path LIMIT ?`,
      )
      .all(now, count) as unknown as CollaborationRegistration[];
  }
  registered(source: CollaborationRegistration, epoch: string) {
    if (typeof epoch !== "string" || !epoch || epoch.length > 200)
      throw Error("invalid collaboration epoch");
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE sources SET epoch=?,retry_at=0,failures=0 WHERE project_id=? AND chat_path=? AND registration_id=? AND epoch=''",
        )
        .run(
          epoch,
          source.project_id,
          source.chat_path,
          source.registration_id,
        );
      if (this.source(source)?.epoch !== epoch) return;
      const delivery = this.db
        .prepare(
          "SELECT payload FROM deliveries WHERE project_id=? AND chat_path=? AND epoch<>?",
        )
        .get(source.project_id, source.chat_path, epoch);
      if (delivery) {
        // Preserve immutable facts and frozen resources when only the writer fence changes.
        const previous = JSON.parse(String(delivery.payload));
        const snapshot = {
          ...previous,
          epoch,
          sequence: 1,
        };
        this.relations.rebind(previous, snapshot);
        this.db
          .prepare(
            "UPDATE deliveries SET epoch=?,sequence=1,payload=? WHERE project_id=? AND chat_path=?",
          )
          .run(
            epoch,
            JSON.stringify(snapshot),
            source.project_id,
            source.chat_path,
          );
        this.db
          .prepare(
            "UPDATE sources SET sequence=1 WHERE project_id=? AND chat_path=?",
          )
          .run(source.project_id, source.chat_path);
      }
    });
  }
  registrationBase(
    source: CollaborationRegistration,
  ): { expected_epoch: string | null } | undefined {
    const row = this.source(source);
    return row?.registration_id === source.registration_id &&
      row.registration_prepared === 1
      ? { expected_epoch: row.expected_epoch as string | null }
      : undefined;
  }
  prepareRegistration(
    source: CollaborationRegistration,
    expected_epoch: string | null,
  ) {
    this.db
      .prepare(
        "UPDATE sources SET expected_epoch=?,registration_prepared=1 WHERE project_id=? AND chat_path=? AND registration_id=? AND registration_prepared=0 AND epoch=''",
      )
      .run(
        expected_epoch,
        source.project_id,
        source.chat_path,
        source.registration_id,
      );
    const base = this.registrationBase(source);
    if (!base) throw Error("collaboration registration superseded");
    return base;
  }
  /** Only an authoritative reassignment hook may supply a new CAS base. */
  reassign(source: CollaborationSource, expected_epoch: string | null) {
    validateSource(source);
    if (!this.source(source)) this.touch(source);
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE sources SET registration_id=?,expected_epoch=?,registration_prepared=1,epoch='',sequence=0,generation=generation+1,dirty=1,retry_at=0,failures=0 WHERE project_id=? AND chat_path=?",
        )
        .run(randomUUID(), expected_epoch, source.project_id, source.chat_path);
      this.db
        .prepare(
          "DELETE FROM deliveries WHERE project_id=? AND chat_path=? AND NOT EXISTS (SELECT 1 FROM notification_events n WHERE n.project_id=deliveries.project_id AND n.chat_path=deliveries.chat_path)",
        )
        .run(source.project_id, source.chat_path);
    });
  }
  requeueRegistration(
    source:
      | CollaborationRegistration
      | CollaborationSourceSnapshot
      | ActivitySource,
    expected_epoch: string | null,
  ): boolean {
    const current = this.source(source);
    if (
      !current ||
      ("registration_id" in source
        ? current.epoch !== "" ||
          current.registration_id !== source.registration_id
        : current.epoch !== source.epoch)
    )
      return false;
    this.reassign(source, expected_epoch);
    return true;
  }
  scans(count = 16, now = Date.now()): CollaborationScan[] {
    return this.eligibleScans(count, now);
  }
  /** Refresh after a service flush without bypassing epoch, write, or identity fences. */
  currentScan(
    source: CollaborationScan,
    now = Date.now(),
  ): CollaborationScan | undefined {
    return this.eligibleScans(1, now, source)[0];
  }
  private eligibleScans(
    count: number,
    now: number,
    source?: CollaborationScan,
  ): CollaborationScan[] {
    limit(count);
    return this.db
      .prepare(
        `SELECT s.project_id,s.chat_path,s.epoch,s.generation FROM sources s WHERE dirty=1 AND epoch<>'' AND retry_at<=?
      AND NOT EXISTS (SELECT 1 FROM writes w WHERE w.project_id=s.project_id AND w.chat_path=s.chat_path)
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.project_id=s.project_id AND d.chat_path=s.chat_path)
      AND NOT EXISTS (SELECT 1 FROM relocations r WHERE r.project_id=s.project_id AND (r.from_path=s.chat_path OR r.to_path=s.chat_path))
      AND NOT EXISTS (SELECT 1 FROM copies c WHERE c.project_id=s.project_id AND c.chat_path=s.chat_path)
      AND NOT EXISTS (SELECT 1 FROM source_redirects d WHERE d.project_id=s.project_id AND d.chat_path=s.chat_path)
      ${this.requireActivityRecovery ? "AND EXISTS (SELECT 1 FROM activity_imports a WHERE a.project_id=s.project_id AND a.chat_path=s.chat_path AND a.epoch=s.epoch AND a.complete=1)" : ""}
      ${source ? "AND s.project_id=? AND s.chat_path=? AND s.epoch=?" : ""}
      ORDER BY retry_at,project_id,chat_path LIMIT ?`,
      )
      .all(
        now,
        ...(source ? [source.project_id, source.chat_path, source.epoch] : []),
        count,
      ) as unknown as CollaborationScan[];
  }
  prepare(scan: CollaborationScan, read: CollaborationRead): boolean {
    if (this.roomReplacements.isRetired(scan)) return false;
    if (read.notification_room_id)
      this.roomReplacements.assertRoom(
        scan.project_id,
        read.notification_room_id,
      );
    return this.transaction(() => {
      const current = this.source(scan);
      if (
        !current ||
        current.epoch !== scan.epoch ||
        current.generation !== scan.generation ||
        (this.requireActivityRecovery &&
          !this.activity.recovery(scan).complete) ||
        this.db
          .prepare(
            "SELECT 1 FROM writes WHERE project_id=? AND chat_path=? LIMIT 1",
          )
          .get(scan.project_id, scan.chat_path)
      )
        return false;
      if (read.resources.length > COLLABORATION_MAX_SOURCE_RESOURCES)
        throw Error("collaboration resource capacity exceeded");
      const activity: Record<string, string[]> = JSON.parse(
        String(current.activity),
      );
      const keys = new Set<string>();
      const positions = new Map<string, number>();
      let locatorCount = Number(
        this.db.prepare("SELECT count(*) AS n FROM locators").get()!.n,
      );
      const resources = read.resources.map((resource) => {
        if (
          resource.project_id !== scan.project_id ||
          resource.chat_path !== scan.chat_path ||
          !resource.resource_id ||
          keys.has(resource.resource_id)
        )
          throw Error("invalid collaboration resource identity");
        keys.add(resource.resource_id);
        const locator = this.db
          .prepare(
            "SELECT chat_path FROM locators WHERE project_id=? AND kind=? AND resource_id=?",
          )
          .get(scan.project_id, resource.kind, resource.resource_id);
        if (locator && locator.chat_path !== scan.chat_path)
          throw Error(
            "copied chat identity conflict; explicit identity allocation or relocation required",
          );
        if (!locator) {
          if (locatorCount >= 100_000)
            throw Error("collaboration identity ledger capacity exceeded");
          locatorCount++;
          this.db
            .prepare("INSERT INTO locators VALUES(?,?,?,?)")
            .run(
              scan.project_id,
              resource.kind,
              resource.resource_id,
              scan.chat_path,
            );
        }
        const key = JSON.stringify([resource.kind, resource.resource_id]);
        const seen = new Set(activity[key] ?? []);
        const advanced = this.activity.advance(
          scan,
          resource,
          seen,
          read.activity_ids[resource.resource_id] ?? [],
        );
        if (resource.kind === "conversation")
          for (const [id, position] of advanced.positions)
            positions.set(JSON.stringify([resource.thread_id, id]), position);
        activity[key] = [...seen].sort();
        return {
          ...resource,
          activity: advanced.activity,
          ...(resource.kind === "artifact" && resource.artifact_id
            ? {
                entry_id: createHash("sha256")
                  .update(
                    artifactCatalogKey(scan, {
                      thread_id: resource.thread_id,
                      artifact_id: resource.artifact_id,
                    }),
                  )
                  .digest("hex"),
              }
            : {}),
        };
      });
      const state = JSON.stringify(activity);
      this.activity.assertCapacity();
      if (Buffer.byteLength(state) > 8 * 1024 * 1024)
        throw Error("collaboration activity journal capacity exceeded");
      const sequence = Number(current.sequence) + 1;
      if (!Number.isSafeInteger(sequence))
        throw Error("collaboration sequence exhausted");
      const snapshot: CollaborationSourceSnapshot = {
        project_id: scan.project_id,
        chat_path: scan.chat_path,
        epoch: scan.epoch,
        sequence,
        resources,
        ...(read.coverage === "partial"
          ? {
              coverage: "partial" as const,
              coverage_message: (
                read.coverage_message ?? "Source metadata coverage is partial."
              ).slice(0, 512),
            }
          : {}),
      };
      const relationBytes = read.relation_draft
        ? COLLABORATION_RELATION_MANIFEST_BYTES +
          Buffer.byteLength(',"relations":')
        : 0;
      this.notifications.prepare(scan, read, positions);
      this.notifications.assertFits(snapshot, relationBytes);
      const payload = JSON.stringify(
        this.notifications.batch(snapshot, relationBytes),
      );
      if (
        Buffer.byteLength(payload) + relationBytes >
        COLLABORATION_MAX_SOURCE_BYTES
      )
        throw Error("collaboration snapshot byte capacity exceeded");
      const bytes =
        Number(
          this.db
            .prepare(
              "SELECT COALESCE(SUM(length(CAST(activity AS BLOB))),0) AS n FROM sources",
            )
            .get()!.n,
        ) +
        Number(
          this.db
            .prepare(
              "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM deliveries",
            )
            .get()!.n,
        );
      if (
        bytes +
          this.activity.bytes +
          this.notifications.bytes -
          Buffer.byteLength(String(current.activity)) +
          Buffer.byteLength(state) +
          Buffer.byteLength(payload) >
        this.capacity.bytes
      )
        throw Error("collaboration journal byte capacity exceeded");
      this.db
        .prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?)")
        .run(
          scan.project_id,
          scan.chat_path,
          scan.epoch,
          sequence,
          scan.generation,
          payload,
        );
      this.relations.bind(scan, read.relation_draft, snapshot);
      this.db
        .prepare(
          "UPDATE sources SET sequence=?,activity=? WHERE project_id=? AND chat_path=?",
        )
        .run(sequence, state, scan.project_id, scan.chat_path);
      return true;
    });
  }
  deliveries(count = 16, now = Date.now()): CollaborationDelivery[] {
    limit(count);
    // Prepared payloads are immutable until ack, even if another write arrived.
    return this.db
      .prepare(
        `SELECT d.payload FROM deliveries d JOIN sources s USING(project_id,chat_path) WHERE d.epoch=s.epoch AND s.retry_at<=?
      AND NOT EXISTS (SELECT 1 FROM relocations r WHERE r.project_id=s.project_id AND (r.from_path=s.chat_path OR r.to_path=s.chat_path))
      AND NOT EXISTS (SELECT 1 FROM copies c WHERE c.project_id=s.project_id AND c.chat_path=s.chat_path)
      ${this.requireActivityRecovery ? "AND EXISTS (SELECT 1 FROM activity_imports a WHERE a.project_id=s.project_id AND a.chat_path=s.chat_path AND a.epoch=s.epoch AND a.complete=1)" : ""}
      ORDER BY s.retry_at,d.project_id,d.chat_path LIMIT ?`,
      )
      .all(now, count)
      .map((row) => JSON.parse(String(row.payload)));
  }
  /** Persist before renaming; neither source may publish until ownership is reconciled. */
  beginRelocation(source: CollaborationSource, to_path: string): string {
    validateSource(source);
    validateSource({ ...source, chat_path: to_path });
    if (source.chat_path === to_path)
      throw Error("relocation needs distinct paths");
    this.touch(source);
    this.touch({ ...source, chat_path: to_path });
    return this.transaction(() => {
      if (
        Number(
          this.db.prepare("SELECT count(*) AS n FROM relocations").get()!.n,
        ) >= 1000
      )
        throw Error("collaboration relocation capacity exceeded");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM relocations WHERE project_id=? AND (from_path IN (?,?) OR to_path IN (?,?)) LIMIT 1",
          )
          .get(
            source.project_id,
            source.chat_path,
            to_path,
            source.chat_path,
            to_path,
          )
      )
        throw Error("collaboration relocation already pending");
      const operation_id = randomUUID();
      this.db
        .prepare("INSERT INTO relocations VALUES(?,?,?,?,?)")
        .run(
          operation_id,
          source.project_id,
          source.chat_path,
          to_path,
          "pending",
        );
      return operation_id;
    });
  }
  finishRelocation(operation_id: string, succeeded: boolean) {
    this.db
      .prepare(
        "UPDATE relocations SET state=? WHERE operation_id=? AND state='pending'",
      )
      .run(succeeded ? "ready" : "unknown", operation_id);
  }
  relocations(count = 100, readyAt?: number): CollaborationRelocation[] {
    limit(count);
    return (readyAt === undefined
      ? this.db
          .prepare("SELECT * FROM relocations ORDER BY operation_id LIMIT ?")
          .all(count)
      : this.db
          .prepare(
            "SELECT r.* FROM relocations r LEFT JOIN relocation_requests q USING(operation_id) WHERE r.state='ready' AND COALESCE(q.retry_at,0)<=? ORDER BY COALESCE(q.retry_at,0),r.operation_id LIMIT ?",
          )
          .all(readyAt, count)) as unknown as CollaborationRelocation[];
  }
  relocationRequest(
    operation_id: string,
  ): CollaborationRelocationRequest | undefined {
    const row = this.db
      .prepare("SELECT payload FROM relocation_requests WHERE operation_id=?")
      .get(operation_id);
    return row?.payload ? JSON.parse(String(row.payload)) : undefined;
  }
  prepareRelocation(
    move: CollaborationRelocation,
    expected_epoch: string,
    expected_destination_epoch: string | null,
  ): CollaborationRelocationRequest {
    return this.transaction(() => {
      const frozen = this.relocationRequest(move.operation_id);
      if (frozen) return frozen;
      const row = this.db
        .prepare(
          "SELECT * FROM relocations WHERE operation_id=? AND state='ready'",
        )
        .get(move.operation_id);
      if (
        !row ||
        row.project_id !== move.project_id ||
        row.from_path !== move.from_path ||
        row.to_path !== move.to_path
      )
        throw Error("relocation intent superseded");
      if (!expected_epoch) throw Error("relocation source is not registered");
      if (
        this.db
          .prepare("SELECT 1 FROM copies WHERE project_id=? AND chat_path=?")
          .get(move.project_id, move.to_path) ||
        this.db
          .prepare(
            "SELECT 1 FROM locators WHERE project_id=? AND chat_path=? LIMIT 1",
          )
          .get(move.project_id, move.to_path)
      )
        throw Error("relocation destination has existing identities");
      const request = {
        operation_id: move.operation_id,
        project_id: move.project_id,
        from_chat_path: move.from_path,
        to_chat_path: move.to_path,
        expected_epoch,
        expected_destination_epoch,
      };
      this.db
        .prepare(
          "INSERT INTO relocation_requests(operation_id,payload) VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET payload=excluded.payload",
        )
        .run(move.operation_id, JSON.stringify(request));
      return request;
    });
  }
  deferRelocation(operation_id: string, now = Date.now()) {
    this.db
      .prepare(
        "INSERT INTO relocation_requests(operation_id,payload,retry_at,failures) VALUES(?,'',?+1000,1) ON CONFLICT(operation_id) DO UPDATE SET retry_at=?+MIN(60000,1000*(1 << MIN(failures,6))),failures=MIN(failures+1,10)",
      )
      .run(operation_id, now, now);
  }
  /** Call only after the owning bay confirms its locator CAS with this operation ID. */
  acknowledgeRelocation(operation_id: string, epoch?: string) {
    this.transaction(() => {
      const move = this.db
        .prepare("SELECT * FROM relocations WHERE operation_id=?")
        .get(operation_id);
      if (!move) return;
      if (move.state !== "ready")
        throw Error("relocation filesystem outcome requires reconciliation");
      const project_id = String(move.project_id),
        from_path = String(move.from_path),
        to_path = String(move.to_path);
      if (
        this.db
          .prepare(
            "SELECT 1 FROM locators WHERE project_id=? AND chat_path=? LIMIT 1",
          )
          .get(project_id, to_path)
      )
        throw Error("relocation destination has existing resource identities");
      const previous = this.source({ project_id, chat_path: from_path });
      if (epoch !== undefined && (!epoch || epoch.length > 200))
        throw Error("invalid relocation epoch");
      const destination = this.source({ project_id, chat_path: to_path });
      const nextEpoch = epoch ?? String(destination?.epoch ?? "");
      const pending = this.db
        .prepare(
          "SELECT payload FROM deliveries WHERE project_id=? AND chat_path=?",
        )
        .get(project_id, from_path);
      this.notifications.relocate(project_id, from_path, to_path);
      this.activity.relocate(project_id, from_path, to_path);
      this.db
        .prepare(
          "UPDATE sources SET activity=?,dirty=1,generation=generation+1,epoch=?,registration_id=?,registration_prepared=1,sequence=0,retry_at=0,failures=0 WHERE project_id=? AND chat_path=?",
        )
        .run(
          previous?.activity ?? "{}",
          nextEpoch,
          operation_id,
          project_id,
          to_path,
        );
      this.db
        .prepare(
          "UPDATE locators SET chat_path=? WHERE project_id=? AND chat_path=?",
        )
        .run(to_path, project_id, from_path);
      // Deliveries prepared before the rename must not restore stale locators.
      this.db
        .prepare(
          "DELETE FROM deliveries WHERE project_id=? AND chat_path IN (?,?)",
        )
        .run(project_id, from_path, to_path);
      if (pending && nextEpoch) {
        const old: CollaborationDelivery = JSON.parse(String(pending.payload));
        const snapshot: CollaborationDelivery = {
          ...old,
          chat_path: to_path,
          epoch: nextEpoch,
          sequence: 1,
          resources: old.resources.map((resource) => ({
            ...resource,
            chat_path: to_path,
            ...(resource.kind === "artifact" && resource.artifact_id
              ? {
                  entry_id: createHash("sha256")
                    .update(
                      artifactCatalogKey(
                        { project_id, chat_path: to_path },
                        {
                          thread_id: resource.thread_id,
                          artifact_id: resource.artifact_id,
                        },
                      ),
                    )
                    .digest("hex"),
                }
              : {}),
          })),
        };
        this.relations.rebind(old, snapshot);
        this.db
          .prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?)")
          .run(project_id, to_path, nextEpoch, 1, -1, JSON.stringify(snapshot));
        this.db
          .prepare(
            "UPDATE sources SET sequence=1 WHERE project_id=? AND chat_path=?",
          )
          .run(project_id, to_path);
      }
      this.db
        .prepare(
          "UPDATE copies SET chat_path=? WHERE project_id=? AND chat_path=?",
        )
        .run(to_path, project_id, from_path);
      this.db
        .prepare(
          "DELETE FROM source_redirects WHERE project_id=? AND chat_path=?",
        )
        .run(project_id, to_path);
      this.db
        .prepare(
          "INSERT INTO source_redirects VALUES(?,?,?) ON CONFLICT(project_id,chat_path) DO UPDATE SET to_path=excluded.to_path",
        )
        .run(project_id, from_path, to_path);
      this.db
        .prepare(
          "UPDATE sources SET dirty=0 WHERE project_id=? AND chat_path=?",
        )
        .run(project_id, from_path);
      this.db
        .prepare("DELETE FROM relocation_requests WHERE operation_id=?")
        .run(operation_id);
      this.db
        .prepare("DELETE FROM relocations WHERE operation_id=?")
        .run(operation_id);
    });
  }
  /** A copied chat retains file contents, but is not a second instance of its IDs. */
  copied(source: CollaborationSource, from_path: string) {
    this.beginCopy(source, from_path, false);
  }
  /** The filesystem adapter proves absence before copying; overwrites stay quarantined. */
  beginCopy(
    source: CollaborationSource,
    from_path: string,
    fresh: boolean,
  ): string {
    validateSource(source);
    this.touch(source);
    if (
      Number(this.db.prepare("SELECT count(*) AS n FROM copies").get()!.n) >=
      10_000
    )
      throw Error("collaboration copy quarantine capacity exceeded");
    const operation_id = randomUUID();
    const existing = this.db
      .prepare("SELECT 1 FROM copies WHERE project_id=? AND chat_path=?")
      .get(source.project_id, source.chat_path);
    const allocated = this.db
      .prepare(
        "SELECT 1 FROM locators WHERE project_id=? AND chat_path=? LIMIT 1",
      )
      .get(source.project_id, source.chat_path);
    this.db
      .prepare(
        "INSERT INTO copies(project_id,chat_path,from_path,operation_id,state) VALUES(?,?,?,?,?) ON CONFLICT(project_id,chat_path) DO UPDATE SET from_path=excluded.from_path,operation_id=excluded.operation_id,state='unknown',fingerprint=NULL",
      )
      .run(
        source.project_id,
        source.chat_path,
        from_path,
        operation_id,
        fresh && !existing && !allocated ? "pending" : "unknown",
      );
    return operation_id;
  }
  finishCopy(operation_id: string, fingerprint?: string) {
    this.db
      .prepare(
        "UPDATE copies SET state=?,fingerprint=? WHERE operation_id=? AND state='pending'",
      )
      .run(
        fingerprint ? "ready" : "unknown",
        fingerprint ?? null,
        operation_id,
      );
  }
  copies(count = 100, readyAt?: number): CollaborationCopy[] {
    limit(count);
    return (readyAt === undefined
      ? this.db
          .prepare("SELECT * FROM copies ORDER BY operation_id LIMIT ?")
          .all(count)
      : this.db
          .prepare(
            "SELECT * FROM copies WHERE state='ready' AND retry_at<=? ORDER BY retry_at,operation_id LIMIT ?",
          )
          .all(readyAt, count)) as unknown as CollaborationCopy[];
  }
  deferCopy(operation_id: string, now = Date.now()) {
    this.db
      .prepare(
        "UPDATE copies SET retry_at=?+MIN(60000,1000*(1 << MIN(failures,6))),failures=MIN(failures+1,10) WHERE operation_id=?",
      )
      .run(now, operation_id);
  }
  /** Release only after live SyncDB durably saved and verified this exact namespace. */
  acknowledgeCopy(operation_id: string) {
    this.transaction(() => {
      const copy = this.db
        .prepare("SELECT * FROM copies WHERE operation_id=?")
        .get(operation_id);
      if (!copy) return;
      if (copy.state !== "ready")
        throw Error("copy outcome requires reconciliation");
      this.db
        .prepare("DELETE FROM deliveries WHERE project_id=? AND chat_path=?")
        .run(copy.project_id, copy.chat_path);
      this.db
        .prepare(
          "UPDATE sources SET dirty=1,generation=generation+1,retry_at=0,failures=0 WHERE project_id=? AND chat_path=?",
        )
        .run(copy.project_id, copy.chat_path);
      this.db
        .prepare("DELETE FROM copies WHERE operation_id=?")
        .run(operation_id);
    });
  }
  acknowledge(snapshot: CollaborationSourceSnapshot) {
    this.transaction(() => {
      const args = [
        snapshot.project_id,
        snapshot.chat_path,
        snapshot.epoch,
        snapshot.sequence,
      ];
      const delivery = this.db
        .prepare(
          "SELECT generation,payload FROM deliveries WHERE project_id=? AND chat_path=? AND epoch=? AND sequence=?",
        )
        .get(...args);
      if (!delivery) return;
      // Trust only the journal's frozen payload, not fields in a remote acknowledgement.
      const frozen: CollaborationDelivery = JSON.parse(
        String(delivery.payload),
      );
      this.notifications.acknowledge(frozen);
      const next = this.notifications.batch(
        {
          ...frozen,
          sequence: frozen.sequence + 1,
        },
        this.relations.has(snapshot)
          ? COLLABORATION_RELATION_MANIFEST_BYTES +
              Buffer.byteLength(',"relations":')
          : 0,
      );
      if (next.notification_events?.length) {
        if (!Number.isSafeInteger(next.sequence))
          throw Error("collaboration sequence exhausted");
        this.relations.acknowledge(snapshot, next);
        this.db
          .prepare(
            "UPDATE deliveries SET sequence=?,payload=? WHERE project_id=? AND chat_path=?",
          )
          .run(
            next.sequence,
            JSON.stringify(next),
            snapshot.project_id,
            snapshot.chat_path,
          );
        this.db
          .prepare(
            "UPDATE sources SET sequence=?,retry_at=0,failures=0 WHERE project_id=? AND chat_path=?",
          )
          .run(next.sequence, snapshot.project_id, snapshot.chat_path);
        return;
      }
      this.relations.acknowledge(snapshot);
      this.db
        .prepare(
          "UPDATE sources SET dirty=CASE WHEN generation=? THEN 0 ELSE 1 END,retry_at=0,failures=0 WHERE project_id=? AND chat_path=? AND epoch=? AND sequence=?",
        )
        .run(delivery.generation!, ...args);
      this.db
        .prepare(
          "DELETE FROM deliveries WHERE project_id=? AND chat_path=? AND epoch=? AND sequence=?",
        )
        .run(...args);
    });
  }
  defer(
    source:
      | CollaborationRegistration
      | CollaborationScan
      | ActivitySource
      | CollaborationSourceSnapshot,
    now = Date.now(),
  ) {
    const field = "registration_id" in source ? "registration_id" : "epoch";
    this.db
      .prepare(
        `UPDATE sources SET retry_at=?+MIN(60000,1000*(1 << MIN(failures,6))),failures=MIN(failures+1,10) WHERE project_id=? AND chat_path=? AND ${field}=?`,
      )
      .run(
        now,
        source.project_id,
        source.chat_path,
        "registration_id" in source ? source.registration_id : source.epoch,
      );
  }
  roomState(project_id: string, room_id: string): boolean {
    this.roomReplacements.assertRoom(project_id, room_id);
    const row = this.db
      .prepare("SELECT room_id,initialized FROM rooms WHERE project_id=?")
      .get(project_id);
    if (row && row.room_id !== room_id)
      throw Error("room replacement requires explicit lifecycle transition");
    if (!row) {
      if (
        Number(this.db.prepare("SELECT count(*) AS n FROM rooms").get()!.n) >=
        this.capacity.sources
      )
        throw Error("room journal capacity exceeded");
      this.db
        .prepare("INSERT INTO rooms(project_id,room_id) VALUES(?,?)")
        .run(project_id, room_id);
    }
    return row?.initialized === 1;
  }
  initializedRoom(project_id: string, room_id: string) {
    this.roomState(project_id, room_id);
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE rooms SET initialized=1 WHERE project_id=? AND room_id=?",
        )
        .run(project_id, room_id);
      this.db
        .prepare("DELETE FROM room_initializations WHERE project_id=?")
        .run(project_id);
    });
  }
  withRoomReplacementLock<T>(
    source: CollaborationSource,
    run: () => Promise<T>,
  ): Promise<T> {
    validateSource(source);
    return this.roomReplacements.lock(source, run);
  }
  replaceRoom(previous: CollaborationRoom, next: CollaborationRoom) {
    validateSource(previous);
    validateSource(next);
    this.transaction(() => this.roomReplacements.replace(previous, next));
  }
  reconcileRoom(
    room: CollaborationRoom & {
      retired_rooms?: Array<Pick<CollaborationRoom, "room_id" | "chat_path">>;
    },
  ) {
    validateSource(room);
    if (!Array.isArray(room.retired_rooms) || room.retired_rooms.length > 32)
      throw Error("invalid canonical room retirement metadata");
    for (const retired of room.retired_rooms) {
      validateSource({
        project_id: room.project_id,
        chat_path: retired.chat_path,
      });
      if (
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(retired.room_id)
      )
        throw Error("invalid retired room identity");
    }
    this.transaction(() => this.roomReplacements.reconcile(room));
  }
  /** Current owner writerState supplies this terminal identity, not file metadata. */
  retireRoomSource(source: CollaborationSource, room_id: string) {
    validateSource(source);
    this.transaction(() => this.roomReplacements.retire(source, room_id));
  }
  /** Persist before writing the first marker; existing/restored markers are not proof of freshness. */
  beginRoomInitialization(
    source: CollaborationSource,
    room_id: string,
    lifecycle_generation: number,
  ) {
    validateSource(source);
    if (!Number.isSafeInteger(lifecycle_generation) || lifecycle_generation < 0)
      throw Error("invalid room lifecycle generation");
    if (this.roomState(source.project_id, room_id))
      throw Error("human room is already initialized");
    this.db
      .prepare(
        "INSERT INTO room_initializations VALUES(?,?,?,?) ON CONFLICT(project_id) DO NOTHING",
      )
      .run(source.project_id, room_id, source.chat_path, lifecycle_generation);
  }
  pendingRoomInitialization(
    source: CollaborationSource,
    room_id: string,
    lifecycle_generation: number,
  ): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM room_initializations i JOIN rooms r USING(project_id,room_id) WHERE i.project_id=? AND i.room_id=? AND i.chat_path=? AND i.lifecycle_generation=? AND r.initialized=0",
      )
      .get(source.project_id, room_id, source.chat_path, lifecycle_generation);
  }
}
