/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  collaborationRelationKey,
  collaborationRelationSetKey,
  COLLABORATION_RELATION_PAGE_BYTES,
  COLLABORATION_RELATION_SET_BYTES,
  COLLABORATION_RELATION_SET_ROWS,
  validateCollaborationRelationManifest,
} from "@cocalc/util/collaboration-relations";
import type {
  CollaborationRelationManifest,
  CollaborationRelationPage,
  CollaborationRelationSnapshot,
  CollaborationReferenceRelation,
  VerifiedCollaborationRelationSet,
} from "@cocalc/util/collaboration-relations";
import {
  verifyCollaborationRelationPage,
  verifyCollaborationRelationSet,
  collaborationRelationActivation,
} from "@cocalc/util/collaboration-relations-codec";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import {
  COLLABORATION_PAGE_LIMIT,
  COLLABORATION_PARTICIPANT_SUMMARY_LIMIT,
} from "@cocalc/util/collaborators";
import type {
  CollaborationResource,
  CollaborationSourceSnapshot,
} from "@cocalc/util/collaborators";
import { resolveAgentReference } from "./agent-identity";

const snapshotOf = (
  source: CollaborationRelationSnapshot,
): CollaborationRelationSnapshot => ({
  project_id: source.project_id,
  chat_path: source.chat_path,
  epoch: source.epoch,
  sequence: source.sequence,
});
const nativeKey = (
  source: Pick<CollaborationResource, "kind" | "resource_id" | "thread_id">,
) => JSON.stringify([source.kind, source.resource_id, source.thread_id]);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface Options {
  db: DatabaseSync;
  project_id: string;
  transaction<T>(fn: () => T): T;
  /** Current writer authority and relocation/deletion fences, inside transaction. */
  writer(
    snapshot: CollaborationRelationSnapshot,
  ): CollaborationRelationSnapshot;
  changed(): void;
  revision(): number;
}
interface Prepared {
  manifest: CollaborationRelationManifest;
  verified?: VerifiedCollaborationRelationSet;
}

/** Service-local standalone owner. No participant preview is an authoritative edge. */
export class LiteCollaborationRelations {
  private readonly db: DatabaseSync;
  private readonly prepared = new WeakSet<Prepared>();
  constructor(private readonly options: Options) {
    this.db = options.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_relation_sets (
        set_key TEXT PRIMARY KEY, chat_path TEXT NOT NULL, epoch TEXT NOT NULL, sequence INTEGER NOT NULL,
        manifest TEXT, page_count INTEGER NOT NULL DEFAULT 0, row_count INTEGER NOT NULL DEFAULT 0,
        byte_count INTEGER NOT NULL DEFAULT 0, stored_bytes INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS collaboration_relation_set_source ON collaboration_relation_sets(chat_path);
      CREATE TABLE IF NOT EXISTS collaboration_relation_pages (
        set_key TEXT NOT NULL, page INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT,
        PRIMARY KEY(set_key,page));
      CREATE TABLE IF NOT EXISTS collaboration_relation_bindings (
        set_key TEXT NOT NULL, native_key TEXT NOT NULL, resource_key TEXT,
        PRIMARY KEY(set_key,native_key));
      CREATE INDEX IF NOT EXISTS collaboration_relation_binding_resource ON collaboration_relation_bindings(resource_key,set_key,native_key);
      CREATE TABLE IF NOT EXISTS collaboration_relation_edges (
        set_key TEXT NOT NULL, edge_key TEXT NOT NULL, native_key TEXT NOT NULL, kind TEXT NOT NULL,
        account_id TEXT, target_key TEXT, payload TEXT NOT NULL, PRIMARY KEY(set_key,edge_key));
      CREATE INDEX IF NOT EXISTS collaboration_relation_edge_native ON collaboration_relation_edges(set_key,native_key,kind,edge_key);
      CREATE INDEX IF NOT EXISTS collaboration_relation_edge_person ON collaboration_relation_edges(account_id,set_key,native_key);
      CREATE INDEX IF NOT EXISTS collaboration_relation_edge_target ON collaboration_relation_edges(target_key,set_key,edge_key);
      CREATE TABLE IF NOT EXISTS collaboration_relation_active (
        chat_path TEXT PRIMARY KEY, set_key TEXT NOT NULL UNIQUE, accepted_sequence INTEGER NOT NULL);
      CREATE VIEW IF NOT EXISTS collaboration_full_participants AS
        SELECT DISTINCT b.resource_key,e.account_id FROM collaboration_relation_active a
        JOIN collaboration_relation_edges e ON e.set_key=a.set_key AND e.kind='participant'
        JOIN collaboration_relation_bindings b ON b.set_key=e.set_key AND b.native_key=e.native_key
        JOIN collaboration_resources r ON r.resource_key=b.resource_key AND r.deleted=0;
    `);
  }
  private remove(key: string) {
    for (const table of ["edges", "bindings", "pages", "sets"])
      this.db
        .prepare(`DELETE FROM collaboration_relation_${table} WHERE set_key=?`)
        .run(key);
  }
  /** Permanent source retirement, atomic with room CAS and metadata tombstones. */
  retireSource(chat_path: string): void {
    this.db
      .prepare("DELETE FROM collaboration_relation_active WHERE chat_path=?")
      .run(chat_path);
    for (const row of this.db
      .prepare(
        "SELECT set_key FROM collaboration_relation_sets WHERE chat_path=?",
      )
      .all(chat_path))
      this.remove(String(row.set_key));
  }
  private createSet(s: CollaborationRelationSnapshot): string {
    const key = collaborationRelationSetKey(s);
    if (
      this.db
        .prepare("SELECT 1 FROM collaboration_relation_sets WHERE set_key=?")
        .get(key)
    )
      return key;
    if (
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM collaboration_relation_sets WHERE chat_path=? AND manifest IS NULL",
          )
          .get(s.chat_path)!.n,
      ) >= 2
    )
      throw Error("Lite relation staged set capacity exceeded");
    if (
      Number(
        this.db
          .prepare("SELECT count(*) AS n FROM collaboration_relation_sets")
          .get()!.n,
      ) >= 20_000
    )
      throw Error("Lite relation source retention capacity exceeded");
    this.db
      .prepare(
        "INSERT INTO collaboration_relation_sets(set_key,chat_path,epoch,sequence) VALUES(?,?,?,?)",
      )
      .run(key, s.chat_path, s.epoch, s.sequence);
    return key;
  }
  /** Bounded stale staging cleanup; committed sets survive partial reads. */
  prune(current: CollaborationRelationSnapshot): void {
    for (const row of this.db
      .prepare(
        `SELECT set_key FROM collaboration_relation_sets
      WHERE chat_path=? AND (epoch<>? OR sequence<=?)
        AND set_key NOT IN (SELECT set_key FROM collaboration_relation_active)
      ORDER BY sequence LIMIT 8`,
      )
      .all(current.chat_path, current.epoch, current.sequence))
      this.remove(String(row.set_key));
  }
  /** In metadata ingest's transaction AFTER canonical adaptation/binding saves. */
  private capture(
    key: string,
    snapshot: CollaborationSourceSnapshot,
    canonical: readonly CollaborationResource[],
  ): void {
    const present = new Map(
      canonical.map((resource) => [collaborationTargetKey(resource), resource]),
    );
    const nativeKeys = new Set(
      snapshot.resources.filter((r) => r.kind !== "artifact").map(nativeKey),
    );
    for (const row of this.db
      .prepare(
        "SELECT DISTINCT native_key FROM collaboration_relation_edges WHERE set_key=?",
      )
      .all(key))
      if (!nativeKeys.has(String(row.native_key)))
        throw Error("Lite relation native provenance is not admitted");
    this.db
      .prepare("DELETE FROM collaboration_relation_bindings WHERE set_key=?")
      .run(key);
    // A mediated move preserves resource identity. Once its new complete source
    // activates, old-path bindings must not keep removed edges publicly visible.
    for (const resource_key of present.keys())
      this.db
        .prepare(
          `DELETE FROM collaboration_relation_bindings
      WHERE resource_key=? AND set_key IN (SELECT set_key FROM collaboration_relation_active WHERE chat_path<>?)`,
        )
        .run(resource_key, snapshot.chat_path);
    const insert = this.db.prepare(
      "INSERT INTO collaboration_relation_bindings VALUES(?,?,?)",
    );
    for (const resource of snapshot.resources) {
      if (resource.kind === "artifact") continue;
      const native = nativeKey(resource);
      const canonicalKey = resolveAgentReference(
        this.db,
        collaborationTargetKey(resource),
      );
      const current = present.get(canonicalKey);
      // Disabled/tombstoned registered identities retain native provenance, not
      // a public edge to a guessed replacement identity.
      insert.run(
        key,
        native,
        current?.kind === resource.kind &&
          current.thread_id === resource.thread_id
          ? canonicalKey
          : null,
      );
    }
  }
  private active(chat_path: string) {
    return this.db
      .prepare(
        `SELECT s.manifest,a.set_key,a.accepted_sequence FROM collaboration_relation_active a
      JOIN collaboration_relation_sets s USING(set_key) WHERE a.chat_path=?`,
      )
      .get(chat_path);
  }
  private assertSource(
    snapshot: CollaborationRelationSnapshot,
  ): CollaborationRelationSnapshot {
    if (snapshot.project_id !== this.options.project_id)
      throw Error("foreign Lite relation source");
    return this.options.writer(snapshot);
  }
  async stage(
    input: CollaborationRelationPage,
  ): Promise<{ replayed: boolean }> {
    const page = await verifyCollaborationRelationPage(input);
    const key = collaborationRelationSetKey(page.snapshot);
    return this.options.transaction(() => {
      const current = this.assertSource(page.snapshot);
      this.prune(current);
      const active = this.active(page.snapshot.chat_path);
      if (current.sequence >= page.snapshot.sequence && active?.set_key !== key)
        throw Error("stale Lite relation page sequence");
      const existing = this.db
        .prepare(
          "SELECT digest FROM collaboration_relation_pages WHERE set_key=? AND page=?",
        )
        .get(key, page.page);
      if (existing) {
        if (existing.digest !== page.digest)
          throw Error("conflicting immutable Lite relation page");
        return { replayed: true };
      }
      this.createSet(page.snapshot);
      const set = this.db
        .prepare("SELECT * FROM collaboration_relation_sets WHERE set_key=?")
        .get(key);
      if (!set || set.manifest)
        throw Error("relation set is not admitted for staging");
      const payload = JSON.stringify(page),
        bytes = Buffer.byteLength(payload);
      const row_count = Number(set.row_count) + page.rows.length;
      const byte_count = Number(set.byte_count) + bytes;
      if (
        row_count > COLLABORATION_RELATION_SET_ROWS ||
        byte_count > COLLABORATION_RELATION_SET_BYTES
      )
        throw Error("Lite relation set capacity exceeded");
      let stored = bytes;
      const insert = this.db.prepare(
        "INSERT INTO collaboration_relation_edges VALUES(?,?,?,?,?,?,?)",
      );
      for (const row of page.rows) {
        const native = nativeKey(row.source),
          edgeKey = collaborationRelationKey(row);
        const body = JSON.stringify(row),
          account = row.kind === "participant" ? row.account_id : null;
        const target =
          row.kind === "reference"
            ? collaborationTargetKey(row.reference.target)
            : null;
        insert.run(key, edgeKey, native, row.kind, account, target, body);
        stored +=
          Buffer.byteLength(
            body + edgeKey + native + (account ?? "") + (target ?? ""),
          ) + 64;
      }
      this.db
        .prepare("INSERT INTO collaboration_relation_pages VALUES(?,?,?,?)")
        .run(key, page.page, page.digest, payload);
      this.db
        .prepare(
          `UPDATE collaboration_relation_sets SET page_count=page_count+1,row_count=?,byte_count=?,stored_bytes=stored_bytes+? WHERE set_key=?`,
        )
        .run(row_count, byte_count, stored, key);
      if (
        Number(
          this.db
            .prepare(
              "SELECT coalesce(sum(stored_bytes),0) AS n FROM collaboration_relation_sets",
            )
            .get()!.n,
        ) >
        256 * 1024 * 1024
      )
        throw Error("Lite relation storage capacity exceeded");
      return { replayed: false };
    });
  }
  private *pages(key: string): Generator<CollaborationRelationPage> {
    let page = 0;
    while (true) {
      const row = this.db
        .prepare(
          "SELECT payload FROM collaboration_relation_pages WHERE set_key=? AND page=?",
        )
        .get(key, page++);
      if (!row) return;
      if (!row.payload) throw Error("relation staged payload is unavailable");
      yield JSON.parse(String(row.payload));
    }
  }
  /** Async hash verification before ingest's synchronous SQLite transaction. */
  async prepare(input: CollaborationRelationManifest): Promise<Prepared> {
    const manifest = validateCollaborationRelationManifest(input),
      encoded = JSON.stringify(manifest);
    const key = collaborationRelationSetKey(manifest.snapshot);
    const replay = this.options.transaction(() => {
      this.assertSource(manifest.snapshot);
      const active = this.active(manifest.snapshot.chat_path);
      if (active?.set_key !== key) return;
      if (active.manifest !== encoded)
        throw Error("conflicting committed Lite relation manifest");
      return true;
    });
    const prepared = Object.freeze({
      manifest,
      ...(replay
        ? {}
        : {
            verified: await verifyCollaborationRelationSet(
              manifest,
              this.pages(key),
            ),
          }),
    });
    this.prepared.add(prepared);
    return prepared;
  }
  /** The preview is derived from the verified relation, never the reverse. */
  summarize<T extends CollaborationResource>(
    snapshot: CollaborationSourceSnapshot,
    prepared: Prepared,
    resources: readonly T[],
  ): T[] {
    if (!this.prepared.has(prepared))
      throw Error("unverified Lite relation set");
    const key = collaborationRelationSetKey(prepared.manifest.snapshot);
    const counts = new Map(
      this.db
        .prepare(
          `SELECT native_key,count(*) AS n FROM collaboration_relation_edges
      WHERE set_key=? AND kind='participant' GROUP BY native_key`,
        )
        .all(key)
        .map((row) => [String(row.native_key), Number(row.n)]),
    );
    return resources.map((resource) => {
      if (resource.kind === "artifact") return resource;
      const raw = snapshot.resources.find(
        (r) =>
          r.kind === resource.kind &&
          r.thread_id === resource.thread_id &&
          (r.resource_id === resource.resource_id ||
            (resource.kind === "agent" &&
              !!resource.agent_id &&
              !r.resource_id.startsWith("copy:"))),
      );
      if (!raw) return resource;
      const native = nativeKey(raw),
        count = counts.get(native) ?? 0;
      const ids = this.db
        .prepare(
          `SELECT account_id FROM collaboration_relation_edges
        WHERE set_key=? AND native_key=? AND kind='participant' ORDER BY account_id LIMIT ?`,
        )
        .all(key, native, COLLABORATION_PARTICIPANT_SUMMARY_LIMIT)
        .map((row) => String(row.account_id));
      return {
        ...resource,
        participant_ids: ids,
        participant_count: count,
        participants_truncated: count > ids.length,
      };
    });
  }
  /** Atomic with metadata/source-sequence publication, never a separate RPC. */
  activate(
    snapshot: CollaborationSourceSnapshot,
    prepared: Prepared,
    canonical: readonly CollaborationResource[],
  ): void {
    if (!this.prepared.has(prepared))
      throw Error("unverified Lite relation set");
    const { manifest, verified } = prepared,
      encoded = JSON.stringify(manifest);
    const expected = snapshotOf(snapshot),
      key = collaborationRelationSetKey(manifest.snapshot);
    const active = this.active(manifest.snapshot.chat_path);
    if (
      manifest.snapshot.project_id !== expected.project_id ||
      manifest.snapshot.chat_path !== expected.chat_path ||
      manifest.snapshot.epoch !== expected.epoch
    )
      throw Error("Lite relation source epoch mismatch");
    if (verified)
      collaborationRelationActivation(
        verified,
        expected,
        active?.manifest ? JSON.parse(String(active.manifest)) : undefined,
      );
    else if (
      active?.set_key !== key ||
      active.manifest !== encoded ||
      manifest.snapshot.sequence > expected.sequence
    )
      throw Error("committed Lite relation set changed");
    this.createSet(manifest.snapshot);
    const set = this.db
      .prepare("SELECT * FROM collaboration_relation_sets WHERE set_key=?")
      .get(key);
    if (
      !set ||
      Number(set.page_count) !== manifest.page_count ||
      Number(set.row_count) !==
        manifest.participant_count + manifest.reference_count ||
      Number(set.byte_count) !== manifest.byte_count
    )
      throw Error("Lite relation set changed during verification");
    this.capture(key, snapshot, canonical);
    this.db
      .prepare(
        "UPDATE collaboration_relation_sets SET manifest=? WHERE set_key=?",
      )
      .run(encoded, key);
    this.db
      .prepare(
        `INSERT INTO collaboration_relation_active VALUES(?,?,?) ON CONFLICT(chat_path)
        DO UPDATE SET set_key=excluded.set_key,accepted_sequence=excluded.accepted_sequence`,
      )
      .run(manifest.snapshot.chat_path, key, expected.sequence);
    // Visible graph rows remain; retain page hashes for conflicting retries,
    // but release full duplicate page payloads after successful activation.
    this.db
      .prepare(
        "UPDATE collaboration_relation_pages SET payload=NULL WHERE set_key=?",
      )
      .run(key);
    if (!set.manifest)
      this.db
        .prepare(
          "UPDATE collaboration_relation_sets SET stored_bytes=stored_bytes-byte_count WHERE set_key=?",
        )
        .run(key);
    if (active && active.set_key !== key) this.remove(String(active.set_key));
    this.options.changed();
  }
  private coverage(
    resource_key: string,
    thread_id?: string,
  ): "complete" | "partial" {
    const rows = this.db
      .prepare(
        `SELECT a.accepted_sequence,s.sequence,s.epoch,t.epoch AS committed_epoch
      FROM collaboration_relation_bindings b JOIN collaboration_relation_active a USING(set_key)
      JOIN collaboration_relation_sets t USING(set_key) JOIN collaboration_sources s ON s.chat_path=a.chat_path
      JOIN collaboration_resources r ON r.resource_key=b.resource_key AND r.chat_path=a.chat_path AND r.deleted=0
      WHERE b.resource_key=? AND (? IS NULL OR json_extract(b.native_key,'$[2]')=?)`,
      )
      .all(resource_key, thread_id ?? null, thread_id ?? null);
    return rows.length > 0 &&
      rows.every(
        (r) =>
          r.accepted_sequence === r.sequence && r.epoch === r.committed_epoch,
      )
      ? "complete"
      : "partial";
  }
  private cursor(filter: string, after: string | undefined, limit: number) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > COLLABORATION_PAGE_LIMIT
    )
      throw Error("invalid Lite relation page limit");
    const revision = this.options.revision();
    if (!after) return { last: "", revision };
    if (after.length > 8192) throw Error("invalid Lite relation cursor");
    let cursor;
    try {
      cursor = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
    } catch {
      throw Error("invalid Lite relation cursor");
    }
    if (
      cursor?.filter !== filter ||
      typeof cursor?.last !== "string" ||
      cursor.revision !== revision
    )
      throw Error("Lite relation query changed; restart pagination");
    return { last: cursor.last, revision };
  }
  participants(
    resource_key: string,
    opts: { after?: string; limit?: number } = {},
    thread_id?: string,
  ) {
    const limit = opts.limit ?? COLLABORATION_PAGE_LIMIT,
      filter = digest(["participants", resource_key, thread_id ?? null, limit]);
    const { last, revision } = this.cursor(filter, opts.after, limit);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.account_id FROM collaboration_relation_active a
      JOIN collaboration_relation_edges e USING(set_key)
      JOIN collaboration_relation_bindings b ON b.set_key=e.set_key AND b.native_key=e.native_key
      JOIN collaboration_resources r ON r.resource_key=b.resource_key AND r.deleted=0
      WHERE b.resource_key=? AND e.kind='participant' AND e.account_id>?
      AND (? IS NULL OR json_extract(b.native_key,'$[2]')=?) ORDER BY e.account_id LIMIT ?`,
      )
      .all(resource_key, last, thread_id ?? null, thread_id ?? null, limit + 1);
    const items = rows.slice(0, limit).map((r) => String(r.account_id));
    return {
      items,
      revision: String(revision),
      coverage: this.coverage(resource_key, thread_id),
      ...(rows.length > limit
        ? {
            next: Buffer.from(
              JSON.stringify({
                filter,
                revision,
                last: items[items.length - 1],
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  references(
    resource_key: string,
    opts: { after?: string; limit?: number; message_id?: string } = {},
    thread_id?: string,
  ) {
    const limit = opts.limit ?? COLLABORATION_PAGE_LIMIT;
    if (
      opts.message_id !== undefined &&
      (typeof opts.message_id !== "string" ||
        !opts.message_id.length ||
        opts.message_id.length > 256)
    )
      throw Error("invalid Lite reference message filter");
    const filter = digest([
      "references",
      resource_key,
      thread_id ?? null,
      opts.message_id ?? null,
      limit,
    ]);
    const { last, revision } = this.cursor(filter, opts.after, limit);
    const rows = this.db
      .prepare(
        `SELECT e.edge_key,e.payload FROM collaboration_relation_active a
      JOIN collaboration_relation_edges e USING(set_key)
      JOIN collaboration_relation_bindings b ON b.set_key=e.set_key AND b.native_key=e.native_key
      JOIN collaboration_resources r ON r.resource_key=b.resource_key AND r.deleted=0
      WHERE b.resource_key=? AND e.kind='reference' AND e.edge_key>? AND (? IS NULL OR json_extract(b.native_key,'$[2]')=?) ${opts.message_id ? "AND json_extract(e.payload,'$.message_id')=?" : ""}
      ORDER BY e.edge_key LIMIT ?`,
      )
      .all(
        resource_key,
        last,
        thread_id ?? null,
        thread_id ?? null,
        ...(opts.message_id ? [opts.message_id] : []),
        limit + 1,
      );
    const items: CollaborationReferenceRelation[] = [];
    let bytes = 8192;
    for (const row of rows.slice(0, limit)) {
      bytes += Buffer.byteLength(String(row.payload));
      if (bytes > COLLABORATION_RELATION_PAGE_BYTES) break;
      items.push(
        JSON.parse(String(row.payload)) as CollaborationReferenceRelation,
      );
    }
    return {
      items,
      revision: String(revision),
      coverage: this.coverage(resource_key, thread_id),
      ...(rows.length > items.length
        ? {
            next: Buffer.from(
              JSON.stringify({
                filter,
                revision,
                last: rows[items.length - 1].edge_key,
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
}
