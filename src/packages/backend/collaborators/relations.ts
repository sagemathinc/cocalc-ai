/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  COLLABORATION_RELATION_PAGE_ROWS,
  COLLABORATION_RELATION_SET_BYTES,
  COLLABORATION_RELATION_SET_ROWS,
  collaborationRelationKey,
  validateCollaborationRelation,
  validateCollaborationRelationSnapshot,
} from "@cocalc/util/collaboration-relations";
import type {
  CollaborationRelation,
  CollaborationRelationManifest,
  CollaborationRelationPage,
  CollaborationRelationSnapshot,
} from "@cocalc/util/collaboration-relations";
import { createCollaborationRelationSet } from "@cocalc/util/collaboration-relations-codec";
import type { CollaborationSourceSnapshot } from "@cocalc/util/collaborators";
import type { CollaborationScan } from "./journal";

export interface CollaborationRelationTransport {
  stage(page: CollaborationRelationPage): Promise<unknown>;
  /** Calls ordinary ingest with {...frozenSnapshot, relations: manifest}. */
  commit(manifest: CollaborationRelationManifest): Promise<unknown>;
}
interface Draft {
  draft_id: string;
  project_id: string;
  chat_path: string;
  epoch: string;
  generation: number;
  sealed: number;
  sequence: number | null;
  delivery_sequence: number | null;
  row_count: number;
  row_bytes: number;
  manifest: string | null;
  next_page: number;
  committed: number;
}

/** Metadata-only spool sharing the source journal's SQLite transaction/fences. */
export class SourceRelations {
  constructor(
    private readonly db: DatabaseSync,
    private readonly capacity = { drafts: 10_000, bytes: 256 * 1024 * 1024 },
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS relation_drafts (
        draft_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chat_path TEXT NOT NULL,
        epoch TEXT NOT NULL, generation INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER, delivery_sequence INTEGER, row_count INTEGER NOT NULL DEFAULT 0,
        row_bytes INTEGER NOT NULL DEFAULT 0, manifest TEXT, next_page INTEGER NOT NULL DEFAULT 0,
        committed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS relation_draft_source ON relation_drafts(project_id,chat_path,epoch,delivery_sequence);
      CREATE TABLE IF NOT EXISTS relation_rows (
        draft_id TEXT NOT NULL, relation_key BLOB NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(draft_id,relation_key));
      CREATE TABLE IF NOT EXISTS relation_pages (
        draft_id TEXT NOT NULL, page INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(draft_id,page));
    `);
  }

  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT collaboration_relations");
    try {
      const value = fn();
      this.db.exec("RELEASE collaboration_relations");
      return value;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO collaboration_relations; RELEASE collaboration_relations",
      );
      throw error;
    }
  }
  private draft(id: string): Draft {
    const row = this.db
      .prepare("SELECT * FROM relation_drafts WHERE draft_id=?")
      .get(id);
    if (!row) throw Error("collaboration relation draft is unavailable");
    return row as unknown as Draft;
  }
  private remove(id: string) {
    this.db.prepare("DELETE FROM relation_pages WHERE draft_id=?").run(id);
    this.db.prepare("DELETE FROM relation_rows WHERE draft_id=?").run(id);
    this.db.prepare("DELETE FROM relation_drafts WHERE draft_id=?").run(id);
  }
  /** Authoritative permanent retirement only, inside the enclosing journal transaction. */
  retireSource(
    source: Pick<CollaborationScan, "project_id" | "chat_path">,
  ): void {
    this.atomic(() => {
      for (const row of this.db
        .prepare(
          "SELECT draft_id FROM relation_drafts WHERE project_id=? AND chat_path=?",
        )
        .all(source.project_id, source.chat_path))
        this.remove(String(row.draft_id));
    });
  }
  private assertCapacity() {
    const bytes = Number(
      this.db
        .prepare(
          `SELECT
      (SELECT coalesce(sum(row_bytes),0) FROM relation_drafts) +
      (SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM relation_pages) AS n`,
        )
        .get()!.n,
    );
    if (bytes > this.capacity.bytes)
      throw Error("collaboration relation journal capacity exceeded");
  }
  begin(scan: CollaborationScan): string {
    validateCollaborationRelationSnapshot({
      project_id: scan.project_id,
      chat_path: scan.chat_path,
      epoch: scan.epoch,
      sequence: 1,
    });
    if (!Number.isSafeInteger(scan.generation) || scan.generation < 0)
      throw Error("invalid relation scan generation");
    return this.atomic(() => {
      // An interrupted read cannot have a completeness receipt. A new read may
      // replace only unbound drafts; admitted deliveries remain immutable.
      for (const row of this.db
        .prepare(
          "SELECT draft_id FROM relation_drafts WHERE project_id=? AND chat_path=? AND sequence IS NULL",
        )
        .all(scan.project_id, scan.chat_path))
        this.remove(String(row.draft_id));
      if (
        Number(
          this.db.prepare("SELECT count(*) AS n FROM relation_drafts").get()!.n,
        ) >= this.capacity.drafts
      )
        throw Error("collaboration relation draft capacity exceeded");
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO relation_drafts(draft_id,project_id,chat_path,epoch,generation)
        VALUES(?,?,?,?,?)`,
        )
        .run(id, scan.project_id, scan.chat_path, scan.epoch, scan.generation);
      return id;
    });
  }
  /** Bounded input batches; cross-page duplicate edges are idempotent. */
  append(id: string, input: Iterable<CollaborationRelation>): void {
    this.atomic(() => {
      const draft = this.draft(id);
      if (draft.sealed || draft.sequence !== null)
        throw Error("relation draft is immutable");
      let count = draft.row_count,
        bytes = draft.row_bytes,
        inputCount = 0;
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO relation_rows VALUES(?,?,?)",
      );
      for (const value of input) {
        if (++inputCount > 1000)
          throw Error("relation append batch exceeds capacity");
        const row = validateCollaborationRelation(value),
          // SQLite UTF-8 text order differs from JS UTF-16 order for non-BMP
          // identities. Big-endian code units preserve the protocol order.
          key = Buffer.from(collaborationRelationKey(row), "utf16le").swap16(),
          payload = JSON.stringify(row);
        if (insert.run(id, key, payload).changes) {
          count++;
          bytes += Buffer.byteLength(payload) + Buffer.byteLength(key);
        }
        if (
          count > COLLABORATION_RELATION_SET_ROWS ||
          bytes > COLLABORATION_RELATION_SET_BYTES
        )
          throw Error("collaboration relation set capacity exceeded");
      }
      this.db
        .prepare(
          "UPDATE relation_drafts SET row_count=?,row_bytes=? WHERE draft_id=?",
        )
        .run(count, bytes, id);
      this.assertCapacity();
    });
  }
  /** Call only after verified full head+archive enumeration, including an empty source. */
  seal(id: string): string {
    const draft = this.draft(id);
    if (draft.sequence !== null) throw Error("relation draft is already bound");
    this.db
      .prepare("UPDATE relation_drafts SET sealed=1 WHERE draft_id=?")
      .run(id);
    return id;
  }
  discard(id: string): void {
    this.atomic(() => {
      if (this.draft(id).sequence !== null)
        throw Error("cannot discard an admitted relation set");
      this.remove(id);
    });
  }
  /** Inside journal.prepare's transaction, after its read-generation checks. */
  bind(
    scan: CollaborationScan,
    id: string | undefined,
    snapshot: CollaborationSourceSnapshot,
  ): void {
    if (!id) return; // Unknown history is never a verified empty relation set.
    this.atomic(() => {
      const draft = this.draft(id);
      if (
        !draft.sealed ||
        draft.sequence !== null ||
        draft.project_id !== scan.project_id ||
        draft.chat_path !== scan.chat_path ||
        draft.epoch !== scan.epoch ||
        draft.generation !== scan.generation ||
        snapshot.project_id !== scan.project_id ||
        snapshot.chat_path !== scan.chat_path ||
        snapshot.epoch !== scan.epoch
      )
        throw Error("relation draft source fence changed");
      const native = new Set(
        snapshot.resources
          .filter((r) => r.kind !== "artifact")
          .map((r) => JSON.stringify([r.kind, r.resource_id, r.thread_id])),
      );
      for (const row of this.rows(id)) {
        if (
          !native.has(
            JSON.stringify([
              row.source.kind,
              row.source.resource_id,
              row.source.thread_id,
            ]),
          )
        )
          throw Error("relation row is not in the native source snapshot");
      }
      validateCollaborationRelationSnapshot({
        project_id: snapshot.project_id,
        chat_path: snapshot.chat_path,
        epoch: snapshot.epoch,
        sequence: snapshot.sequence,
      });
      this.db
        .prepare(
          "UPDATE relation_drafts SET sequence=?,delivery_sequence=? WHERE draft_id=?",
        )
        .run(snapshot.sequence, snapshot.sequence, id);
    });
  }
  private *rows(id: string): Generator<CollaborationRelation> {
    let after: Uint8Array = new Uint8Array();
    while (true) {
      const rows = this.db
        .prepare(
          `SELECT relation_key,payload FROM relation_rows
        WHERE draft_id=? AND relation_key>? ORDER BY relation_key LIMIT ?`,
        )
        .all(id, after, COLLABORATION_RELATION_PAGE_ROWS);
      if (!rows.length) return;
      for (const row of rows) yield JSON.parse(String(row.payload));
      after = rows[rows.length - 1].relation_key as Uint8Array;
    }
  }
  private pending(snapshot: CollaborationRelationSnapshot): Draft | undefined {
    return this.db
      .prepare(
        `SELECT * FROM relation_drafts
      WHERE project_id=? AND chat_path=? AND epoch=? AND delivery_sequence=?`,
      )
      .get(
        snapshot.project_id,
        snapshot.chat_path,
        snapshot.epoch,
        snapshot.sequence,
      ) as unknown as Draft | undefined;
  }
  has(snapshot: CollaborationRelationSnapshot): boolean {
    return this.pending(snapshot) !== undefined;
  }
  /** Same captured facts under a newly admitted writer/locator, never reused wire hashes. */
  rebind(
    previous: CollaborationRelationSnapshot,
    next: CollaborationRelationSnapshot,
  ): void {
    this.atomic(() => {
      const draft = this.pending(previous);
      if (!draft) return;
      if (next.project_id !== previous.project_id)
        throw Error("cannot move relation authority across projects");
      const snapshot = validateCollaborationRelationSnapshot({
        project_id: next.project_id,
        chat_path: next.chat_path,
        epoch: next.epoch,
        sequence: next.sequence,
      });
      this.db
        .prepare("DELETE FROM relation_pages WHERE draft_id=?")
        .run(draft.draft_id);
      this.db
        .prepare(
          `UPDATE relation_drafts SET chat_path=?,epoch=?,sequence=?,delivery_sequence=?,
        manifest=NULL,next_page=0,committed=0 WHERE draft_id=?`,
        )
        .run(
          snapshot.chat_path,
          snapshot.epoch,
          snapshot.sequence,
          snapshot.sequence,
          draft.draft_id,
        );
    });
  }
  /**
   * Stage before metadata admission; commit sends metadata and manifest together.
   * At most four network pages per call; lost replies replay immutable bytes.
   */
  async deliver(
    snapshot: CollaborationRelationSnapshot,
    transport: CollaborationRelationTransport,
    isCurrent: () => boolean = () => true,
    pageLimit = 4,
  ): Promise<boolean> {
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 16)
      throw Error("invalid relation delivery bound");
    let draft = this.pending(snapshot);
    if (!draft) return true;
    if (!isCurrent()) return false;
    if (draft.committed) return true;
    const id = draft.draft_id;
    if (!draft.manifest) {
      const manifest = await createCollaborationRelationSet(
        {
          project_id: draft.project_id,
          chat_path: draft.chat_path,
          epoch: draft.epoch,
          sequence: draft.sequence!,
        },
        this.rows(id),
        (page) => {
          if (!isCurrent())
            throw Error("relation delivery source fence changed");
          this.atomic(() => {
            const previous = this.db
              .prepare(
                "SELECT digest FROM relation_pages WHERE draft_id=? AND page=?",
              )
              .get(id, page.page);
            if (previous && previous.digest !== page.digest)
              throw Error("conflicting immutable relation page");
            this.db
              .prepare("INSERT OR IGNORE INTO relation_pages VALUES(?,?,?,?)")
              .run(id, page.page, page.digest, JSON.stringify(page));
            this.assertCapacity();
          });
        },
      );
      if (!isCurrent()) return false;
      this.db
        .prepare("UPDATE relation_drafts SET manifest=? WHERE draft_id=?")
        .run(JSON.stringify(manifest), id);
      draft = this.draft(id);
    }
    const manifest = JSON.parse(
      draft.manifest!,
    ) as CollaborationRelationManifest;
    const stop = Math.min(manifest.page_count, draft.next_page + pageLimit);
    for (let page = draft.next_page; page < stop; page++) {
      if (!isCurrent()) return false;
      const payload = this.db
        .prepare(
          "SELECT payload FROM relation_pages WHERE draft_id=? AND page=?",
        )
        .get(id, page);
      if (!payload) throw Error("relation journal lost an immutable page");
      await transport.stage(JSON.parse(String(payload.payload)));
      if (!isCurrent()) return false;
      this.db
        .prepare("UPDATE relation_drafts SET next_page=? WHERE draft_id=?")
        .run(page + 1, id);
    }
    if (stop < manifest.page_count || !isCurrent()) return false;
    await transport.commit(manifest);
    if (!isCurrent()) return false;
    this.db
      .prepare("UPDATE relation_drafts SET committed=1 WHERE draft_id=?")
      .run(id);
    return true;
  }
  /** Inside journal ACK; notification-only batches reuse the committed set. */
  acknowledge(
    snapshot: CollaborationRelationSnapshot,
    next?: CollaborationRelationSnapshot,
  ): void {
    this.atomic(() => {
      const draft = this.pending(snapshot);
      if (!draft) return;
      if (!draft.committed) throw Error("relation set has not been committed");
      if (next) {
        if (
          next.project_id !== snapshot.project_id ||
          next.chat_path !== snapshot.chat_path ||
          next.epoch !== snapshot.epoch ||
          next.sequence !== snapshot.sequence + 1
        )
          throw Error("invalid relation notification-only successor");
        this.db
          .prepare(
            "UPDATE relation_drafts SET delivery_sequence=?,committed=0 WHERE draft_id=?",
          )
          .run(next.sequence, draft.draft_id);
      } else this.remove(draft.draft_id);
    });
  }
  /** On restart/epoch recovery, remove only drafts absent from the durable journal. */
  recover(): void {
    this.atomic(() => {
      for (const row of this.db
        .prepare(
          `SELECT r.draft_id FROM relation_drafts r
        WHERE r.sequence IS NULL OR NOT EXISTS (SELECT 1 FROM deliveries d
          WHERE d.project_id=r.project_id AND d.chat_path=r.chat_path AND d.epoch=r.epoch AND d.sequence=r.delivery_sequence)`,
        )
        .all())
        this.remove(String(row.draft_id));
    });
  }
}

/** Stream resolved head+archive facts; EOF alone is not proof of completeness. */
export async function collectCollaborationRelationDraft(
  store: SourceRelations,
  scan: CollaborationScan,
  input: Iterable<CollaborationRelation> | AsyncIterable<CollaborationRelation>,
  complete: () => boolean | Promise<boolean>,
): Promise<string | undefined> {
  const draft = store.begin(scan);
  try {
    let batch: CollaborationRelation[] = [],
      visited = 0;
    for await (const relation of input) {
      if (++visited > COLLABORATION_RELATION_SET_ROWS)
        throw Error("collaboration relation extraction work capacity exceeded");
      batch.push(relation);
      if (batch.length === COLLABORATION_RELATION_PAGE_ROWS) {
        store.append(draft, batch);
        batch = [];
      }
    }
    if (batch.length) store.append(draft, batch);
    if (await complete()) return store.seal(draft);
    store.discard(draft);
    return undefined;
  } catch (error) {
    store.discard(draft);
    throw error;
  }
}
