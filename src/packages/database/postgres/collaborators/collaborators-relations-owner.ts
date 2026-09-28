/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import type {
  CollaborationResource,
  CollaborationSourceSnapshot,
} from "@cocalc/util/collaborators";
import {
  COLLABORATION_RELATION_SET_BYTES,
  COLLABORATION_RELATION_SET_ROWS,
  collaborationRelationSetKey,
  collaborationRelationKey,
} from "@cocalc/util/collaboration-relations";
import type {
  CollaborationRelationPage,
  CollaborationRelationManifest,
} from "@cocalc/util/collaboration-relations";
import {
  verifyCollaborationRelationPage,
  verifyCollaborationRelationSet,
  collaborationRelationActivation,
} from "@cocalc/util/collaboration-relations-codec";
import { entryKey, hash, sourceKey, transaction } from "./collaborators-common";
import { assertCollaborationWriterAuthority } from "./collaborators-owner";
import type { CollaborationWriterAuthority } from "./collaborators-owner";

export const relationThreadKey = (r: {
  kind: string;
  resource_id: string;
  thread_id: string;
}) => hash(JSON.stringify([r.kind, r.resource_id, r.thread_id]));
export const relationSetKey = (
  m: CollaborationRelationManifest | CollaborationRelationPage,
) => hash(collaborationRelationSetKey(m.snapshot));

/** Capture before canonical upsert changes its locator. Registry enrollment and
 * moves retain native facts; a fresh conversation never inherits its predecessor. */
export async function retainedAgentRelations(
  db: Pick<PoolClient, "query">,
  resource: CollaborationResource,
  previousEntryKey: string,
) {
  const canonical = entryKey(resource);
  return (
    await db.query(
      `SELECT relation_set,relation_thread,relation_count FROM collaboration_catalog
      WHERE entry_key=ANY($1::text[]) AND deleted_at IS NULL AND relation_set IS NOT NULL
      AND metadata->>'thread_id'=$2 ORDER BY (entry_key=$3) DESC LIMIT 1`,
      [[canonical, previousEntryKey], resource.thread_id, canonical],
    )
  ).rows[0];
}

/** Authenticated current host only. Each immutable page and its edges commit together. */
export async function stageCollaborationRelationPage(
  input: CollaborationRelationPage,
  authority: CollaborationWriterAuthority,
) {
  const page = await verifyCollaborationRelationPage(input);
  const source_id = sourceKey(page.snapshot),
    set_key = relationSetKey(page);
  const id = hash(JSON.stringify([set_key, page.page]));
  return transaction(async (db) => {
    await assertCollaborationWriterAuthority(
      db,
      page.snapshot.project_id,
      authority,
    );
    const current = (
      await db.query("SELECT * FROM collaboration_sources WHERE source_id=$1", [
        source_id,
      ])
    ).rows[0];
    if (
      !current ||
      current.retired_room_id ||
      current.relocated_to ||
      current.epoch !== page.snapshot.epoch ||
      current.writer_host_id !== authority.host_id ||
      current.owning_bay_id !== authority.owning_bay_id
    )
      throw Error("stale collaboration relation writer epoch");
    const prior = (
      await db.query(
        "SELECT digest FROM collaboration_relation_pages WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (prior) {
      if (prior.digest !== page.digest)
        throw Error("conflicting immutable relation page replay");
      return { replayed: true };
    }
    if (page.snapshot.sequence <= Number(current.source_sequence))
      throw Error("stale collaboration relation sequence");
    await pruneCollaborationRelations(db, page.snapshot.project_id, source_id);
    const pending = (
      await db.query(
        "SELECT count(*) AS n FROM collaboration_relation_sets WHERE source_id=$1 AND manifest IS NULL AND set_key<>$2 AND epoch=$3",
        [source_id, set_key, current.epoch],
      )
    ).rows[0];
    if (Number(pending.n) >= 2)
      throw Error("relation staged set quota exceeded");
    await db.query(
      `INSERT INTO collaboration_relation_sets(set_key,project_id,source_id,epoch,sequence)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [
        set_key,
        page.snapshot.project_id,
        source_id,
        page.snapshot.epoch,
        page.snapshot.sequence,
      ],
    );
    const bytes = Buffer.byteLength(JSON.stringify(page));
    const totals = (
      await db.query(
        `UPDATE collaboration_relation_sets SET byte_count=byte_count+$2,row_count=row_count+$3
      WHERE set_key=$1 AND manifest IS NULL RETURNING byte_count,row_count`,
        [set_key, bytes, page.rows.length],
      )
    ).rows[0];
    if (
      !totals ||
      Number(totals.byte_count) > COLLABORATION_RELATION_SET_BYTES ||
      Number(totals.row_count) > COLLABORATION_RELATION_SET_ROWS
    )
      throw Error("relation set quota exceeded");
    const project = (
      await db.query(
        "SELECT sum(byte_count) AS bytes,sum(row_count) AS rows FROM collaboration_relation_sets WHERE project_id=$1",
        [page.snapshot.project_id],
      )
    ).rows[0];
    if (
      Number(project.bytes) > 256 * 1024 * 1024 ||
      Number(project.rows) > 2_000_000
    )
      throw Error("project relation quota exceeded");
    await db.query(
      "INSERT INTO collaboration_relation_pages(id,project_id,set_key,page,payload,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [
        id,
        page.snapshot.project_id,
        set_key,
        page.page,
        JSON.stringify(page),
        page.digest,
      ],
    );
    const participants = page.rows.flatMap((row) =>
      row.kind === "participant"
        ? [
            {
              id: hash(
                JSON.stringify([set_key, collaborationRelationKey(row)]),
              ),
              thread_key: relationThreadKey(row.source),
              participant_id: row.account_id,
            },
          ]
        : [],
    );
    const references = page.rows.flatMap((row) =>
      row.kind === "reference"
        ? [
            {
              id: hash(
                JSON.stringify([set_key, collaborationRelationKey(row)]),
              ),
              thread_key: relationThreadKey(row.source),
              message_id: row.message_id,
              payload: row,
            },
          ]
        : [],
    );
    await db.query(
      `INSERT INTO collaboration_participants(id,project_id,set_key,thread_key,participant_id)
      SELECT e.id,$1,$2,e.thread_key,e.participant_id FROM jsonb_to_recordset($3::jsonb) AS e(id text,thread_key text,participant_id uuid)`,
      [page.snapshot.project_id, set_key, JSON.stringify(participants)],
    );
    await db.query(
      `INSERT INTO collaboration_references(id,project_id,set_key,thread_key,message_id,payload)
      SELECT e.id,$1,$2,e.thread_key,e.message_id,e.payload FROM jsonb_to_recordset($3::jsonb) AS e(id text,thread_key text,message_id text,payload jsonb)`,
      [page.snapshot.project_id, set_key, JSON.stringify(references)],
    );
    return { replayed: false };
  });
}

function nativeResource(
  snapshot: CollaborationSourceSnapshot,
  resource: CollaborationResource,
) {
  return snapshot.resources.find(
    (r) =>
      r.kind === resource.kind &&
      r.thread_id === resource.thread_id &&
      (r.resource_id === resource.resource_id ||
        (resource.kind === "agent" &&
          !!resource.agent_id &&
          !r.resource_id.startsWith("copy:"))),
  );
}

/** Missing facts are not a verified empty replacement. Capture before catalog
 * upsert, matching native provenance rather than the adaptable public identity. */
async function retainCollaborationRelations(
  db: PoolClient,
  snapshot: CollaborationSourceSnapshot,
  resources: CollaborationResource[],
  set_key: string | null,
) {
  const previous = set_key
    ? (
        await db.query(
          `SELECT c.relation_thread,c.relation_count,c.metadata->'participant_ids' AS participant_ids
          FROM collaboration_catalog c JOIN collaboration_relation_sets s ON s.set_key=c.relation_set
          WHERE c.source_id=$1 AND c.relation_set=$2 AND c.deleted_at IS NULL AND s.manifest IS NOT NULL
          AND c.metadata->>'chat_path'=$3 AND c.relation_thread IS NOT NULL`,
          [sourceKey(snapshot), set_key, snapshot.chat_path],
        )
      ).rows
    : [];
  const byThread = new Map(previous.map((r) => [r.relation_thread, r]));
  const bindings: { entry_key: string; thread_key: string; count: number }[] =
    [];
  const normalized = resources.map((resource) => {
    const raw = nativeResource(snapshot, resource);
    if (!raw) return resource;
    const thread_key = relationThreadKey(raw),
      retained = byThread.get(thread_key);
    if (!retained) return resource;
    const count = Number(retained.relation_count),
      ids = retained.participant_ids as string[];
    bindings.push({ entry_key: entryKey(resource), thread_key, count });
    return {
      ...resource,
      participant_ids: ids,
      participant_count: count,
      participants_truncated: count > ids.length,
    };
  });
  return { resources: normalized, set_key, bindings };
}

/** Caller holds the same project/writer lock as source snapshot ingestion. */
export async function activateCollaborationRelations(
  db: PoolClient,
  snapshot: CollaborationSourceSnapshot,
  resources: CollaborationResource[],
  current: { relation_set?: string | null },
) {
  if (!snapshot.relations)
    return retainCollaborationRelations(
      db,
      snapshot,
      resources,
      current.relation_set ?? null,
    );
  const manifest = snapshot.relations,
    set_key = relationSetKey(manifest);
  const admitted = {
    project_id: snapshot.project_id,
    chat_path: snapshot.chat_path,
    epoch: snapshot.epoch,
    sequence: snapshot.sequence,
  };
  const active = current.relation_set
    ? (
        await db.query(
          "SELECT manifest FROM collaboration_relation_sets WHERE set_key=$1",
          [current.relation_set],
        )
      ).rows[0]?.manifest
    : undefined;
  const native = new Map(
    snapshot.resources.map((r) => [relationThreadKey(r), r]),
  );
  const counts = new Map<string, { count: number; ids: string[] }>();
  async function* pages() {
    let after = -1;
    for (;;) {
      const batch = (
        await db.query(
          "SELECT page,payload FROM collaboration_relation_pages WHERE set_key=$1 AND page>$2 ORDER BY page LIMIT 8",
          [set_key, after],
        )
      ).rows;
      if (!batch.length) break;
      for (const page of batch) {
        for (const row of (page.payload as CollaborationRelationPage).rows) {
          const key = relationThreadKey(row.source);
          if (!native.has(key))
            throw Error("relation source thread is absent from snapshot");
          if (row.kind === "participant") {
            const summary = counts.get(key) ?? { count: 0, ids: [] };
            summary.count++;
            if (summary.ids.length < 64) summary.ids.push(row.account_id);
            counts.set(key, summary);
          }
        }
        after = Number(page.page);
        yield page.payload as CollaborationRelationPage;
      }
    }
  }
  const verified = await verifyCollaborationRelationSet(manifest, pages());
  collaborationRelationActivation(verified, admitted, active);
  await db.query(
    `INSERT INTO collaboration_relation_sets(set_key,project_id,source_id,epoch,sequence,manifest,byte_count,row_count)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(set_key) DO UPDATE SET manifest=excluded.manifest`,
    [
      set_key,
      snapshot.project_id,
      sourceKey(snapshot),
      manifest.snapshot.epoch,
      manifest.snapshot.sequence,
      JSON.stringify(manifest),
      manifest.byte_count,
      manifest.participant_count + manifest.reference_count,
    ],
  );
  const bindings: { entry_key: string; thread_key: string; count: number }[] =
    [];
  const normalized = resources.map((resource) => {
    // Registered identities may collapse several input threads. Only the actual
    // current thread binds; a predecessor must not lend participation to it.
    const raw = nativeResource(snapshot, resource);
    if (!raw) return resource;
    const thread_key = relationThreadKey(raw),
      summary = counts.get(thread_key) ?? { count: 0, ids: [] };
    bindings.push({
      entry_key: entryKey(resource),
      thread_key,
      count: summary.count,
    });
    return {
      ...resource,
      participant_ids: summary.ids,
      participant_count: summary.count,
      participants_truncated: summary.count > summary.ids.length,
    };
  });
  return { resources: normalized, set_key, bindings };
}

/** Caller holds the project lock. Obsolete writers cannot resume hidden uploads;
 * current-epoch staging and active/catalog-pinned sets must survive retries. */
export async function pruneCollaborationRelations(
  db: Pick<PoolClient, "query">,
  project_id: string,
  source_id?: string,
) {
  const doomed = (
    await db.query(
      `SELECT s.set_key FROM collaboration_relation_sets s WHERE s.project_id=$1
    AND ($2::text IS NULL OR s.source_id=$2)
    AND NOT EXISTS(SELECT 1 FROM collaboration_sources x WHERE x.relation_set=s.set_key)
    AND NOT EXISTS(SELECT 1 FROM collaboration_catalog c WHERE c.relation_set=s.set_key AND c.deleted_at IS NULL)
    AND (s.manifest IS NOT NULL
      OR EXISTS(SELECT 1 FROM collaboration_sources x WHERE x.source_id=s.source_id AND x.epoch<>s.epoch)
      OR (s.created_at<now()-interval '1 day'
        AND NOT EXISTS(SELECT 1 FROM collaboration_sources x WHERE x.source_id=s.source_id)))
    ORDER BY s.created_at,s.set_key LIMIT 8`,
      [project_id, source_id ?? null],
    )
  ).rows.map((r) => r.set_key);
  if (!doomed.length) return;
  for (const table of [
    "collaboration_participants",
    "collaboration_references",
    "collaboration_relation_pages",
    "collaboration_relation_sets",
  ])
    await db.query(`DELETE FROM ${table} WHERE set_key=ANY($1::text[])`, [
      doomed,
    ]);
}
