/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import {
  activateCollaborationRelations,
  pruneCollaborationRelations,
  retainedAgentRelations,
} from "./collaborators-relations-owner";
import { readOwnerParticipantProjection } from "./collaborators-relations-projection";
import { agentReferenceIds } from "@cocalc/util/collaboration-agent-identity";
import {
  adaptCollaborationAgents,
  normalizeOwnedCollaborationAgent,
  saveCollaborationAgentBindings,
  upsertCollaborationAgent,
} from "./collaborators-agent-identity";
import { assertProjectNotRehoming } from "../project-rehome-fence";
import {
  appendCollaborationNotificationEvents,
  readCollaborationNotificationAttention,
} from "./collaborators-notifications";
import type { PoolClient } from "@cocalc/database/pool";
import type {
  CollaborationSourceSnapshot,
  CollaborationTarget,
} from "@cocalc/util/collaborators";
import { COLLABORATION_ROOM_PATH } from "@cocalc/util/collaborators";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import {
  boundedText,
  collaboratorRole,
  entryKey,
  hash,
  integer,
  MAX_PROJECT_RESOURCES,
  MAX_ARTIFACT_ENTRY_IDS,
  PAGE_BYTES,
  sourceKey,
  transaction,
  uuid,
  validateSnapshot,
  validateResource,
  validateSource,
  validateTarget,
} from "./collaborators-common";
import type {
  CollaborationProjectionPage,
  CollaborationProjectionRequest,
  CollaborationRelocateRequest,
  CollaborationInitializeRequest,
  CollaborationOwnedResource,
} from "@cocalc/conat/inter-bay/collaborators";

export interface CollaborationWriterAuthority {
  owning_bay_id: string;
  host_id: string;
}
export interface CollaborationOwnerAuthority {
  owning_bay_id: string;
}

async function project(
  db: PoolClient,
  project_id: string,
  authority: CollaborationOwnerAuthority,
  host_id?: string,
  initialize = true,
) {
  uuid(project_id, "project_id");
  await assertProjectNotRehoming({
    db,
    project_id,
    action: "use collaboration catalog",
  });
  if (host_id != null) uuid(host_id, "authenticated host_id");
  const { rows } = await db.query(
    `SELECT users,deleted,host_id FROM projects
    WHERE project_id=$1 AND owning_bay_id=$2 FOR UPDATE`,
    [project_id, authority.owning_bay_id],
  );
  const row = rows[0];
  if (!row || (host_id != null && (row.host_id !== host_id || row.deleted)))
    throw Error("collaboration project owner/host unavailable");
  if (initialize)
    await db.query(
      `INSERT INTO collaboration_projects(project_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [project_id, randomUUID()],
    );
  return row;
}
function assertMember(row: any, account_id: string) {
  uuid(account_id, "account_id");
  if (row.deleted || !collaboratorRole(row.users?.[account_id]?.group))
    throw Error("collaboration access denied");
}
/** Internal transaction helper for bounded host recovery reads; never initializes state. */
export async function assertCollaborationWriterAuthority(
  db: PoolClient,
  project_id: string,
  authority: CollaborationWriterAuthority,
): Promise<void> {
  await project(db, project_id, authority, authority.host_id, false);
}
/** Internal maintenance fence; does not require a remaining human member. */
export async function assertCollaborationOwnerAuthority(
  db: PoolClient,
  project_id: string,
  authority: CollaborationOwnerAuthority,
): Promise<void> {
  await project(db, project_id, authority, undefined, false);
}
export async function assertCollaborationAccountAuthority(
  db: PoolClient,
  project_id: string,
  account_id: string,
  authority: CollaborationOwnerAuthority,
): Promise<void> {
  assertMember(
    await project(db, project_id, authority, undefined, false),
    account_id,
  );
}
async function charge(db: PoolClient, project_id: string, units: number) {
  const { rows } = await db.query(
    `UPDATE collaboration_projects SET
    work_units=CASE WHEN window_start IS NULL OR window_start < now()-interval '1 hour' THEN $2 ELSE work_units+$2 END,
    window_start=CASE WHEN window_start IS NULL OR window_start < now()-interval '1 hour' THEN now() ELSE window_start END
    WHERE project_id=$1 RETURNING work_units`,
    [project_id, units],
  );
  if (Number(rows[0].work_units) > 1000000)
    throw Error("collaboration project mutation budget exceeded");
}

export async function registerCollaborationSource(
  input: { project_id: string; chat_path: string },
  authority: CollaborationWriterAuthority,
  expected_epoch: string | null,
  registration_id: string,
  allow_new = true,
) {
  const source = validateSource(input);
  uuid(registration_id, "registration_id");
  if (expected_epoch !== null) uuid(expected_epoch, "expected_epoch");
  return transaction(async (db) => {
    await project(db, source.project_id, authority, authority.host_id);
    const source_id = sourceKey(source);
    const previous = (
      await db.query("SELECT * FROM collaboration_sources WHERE source_id=$1", [
        source_id,
      ])
    ).rows[0];
    if (previous?.retired_room_id)
      throw Error("collaboration source is permanently retired");
    if (previous?.relocated_to)
      throw Error(
        "collaboration source was relocated; register its current path",
      );
    if (
      previous?.registration_id === registration_id &&
      previous.writer_host_id === authority.host_id &&
      previous.owning_bay_id === authority.owning_bay_id
    )
      return previous.epoch as string;
    if ((previous?.epoch ?? null) !== expected_epoch)
      throw Error("collaboration writer epoch changed");
    if (!previous) {
      if (!allow_new)
        throw Error("Collaborators is not enabled on this server");
      const count = await db.query(
        `SELECT (SELECT count(*) FROM collaboration_sources WHERE project_id=$1) +
          (SELECT count(*) FROM collaboration_source_requests WHERE project_id=$1 AND chat_path<>$2) AS n`,
        [source.project_id, source.chat_path],
      );
      if (Number(count.rows[0].n) >= 1024)
        throw Error("collaboration project source limit exceeded");
    }
    await charge(db, source.project_id, 1);
    const epoch = randomUUID();
    await db.query(
      `INSERT INTO collaboration_sources(source_id,project_id,chat_path,owning_bay_id,writer_host_id,epoch,registration_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id) DO UPDATE SET
      owning_bay_id=excluded.owning_bay_id,writer_host_id=excluded.writer_host_id,epoch=excluded.epoch,
      registration_id=excluded.registration_id,source_sequence=0,payload_hash=NULL`,
      [
        source_id,
        source.project_id,
        source.chat_path,
        authority.owning_bay_id,
        authority.host_id,
        epoch,
        registration_id,
      ],
    );
    await db.query(
      "DELETE FROM collaboration_source_requests WHERE project_id=$1 AND chat_path=$2",
      [source.project_id, source.chat_path],
    );
    return epoch;
  });
}
export async function collaborationWriterState(
  source: { project_id: string; chat_path: string },
  authority: CollaborationWriterAuthority,
  includeCanonicalRoom = false,
) {
  validateSource(source);
  return transaction(async (db) => {
    await project(db, source.project_id, authority, authority.host_id, false);
    const row = (
      await db.query(
        `SELECT s.epoch,s.registration_id,s.source_sequence,s.writer_host_id,s.retired_room_id,r.room_id,r.initialized
        FROM collaboration_sources s LEFT JOIN collaboration_rooms r
        ON $3::boolean AND r.project_id=s.project_id AND r.chat_path=s.chat_path
          AND s.relocated_to IS NULL AND s.retired_room_id IS NULL AND s.writer_host_id=$2
        WHERE s.source_id=$1`,
        [sourceKey(source), authority.host_id, includeCanonicalRoom],
      )
    ).rows[0];
    return row
      ? {
          epoch: row.epoch as string,
          registration_id: row.registration_id as string | null,
          source_sequence: Number(row.source_sequence),
          writer_host_id: row.writer_host_id as string,
          ...(row.retired_room_id
            ? { retired_room_id: row.retired_room_id as string }
            : {}),
          ...(row.room_id
            ? {
                canonical_room: {
                  project_id: source.project_id,
                  chat_path: source.chat_path,
                  room_id: row.room_id as string,
                  initialized: !!row.initialized,
                },
              }
            : {}),
        }
      : null;
  });
}
export async function collaborationSourcePage(
  project_id: string,
  authority: CollaborationWriterAuthority,
  after = "",
) {
  boundedText(after, "source cursor", 1024, true);
  return transaction(async (db) => {
    await project(db, project_id, authority, authority.host_id, false);
    const { rows } = await db.query(
      `SELECT path FROM (
      SELECT chat_path AS path FROM collaboration_sources WHERE project_id=$1 AND relocated_to IS NULL
      UNION SELECT chat_path AS path FROM artifact_catalog_sources a WHERE project_id=$1 AND NOT EXISTS
        (SELECT 1 FROM collaboration_sources s WHERE s.source_id=a.source_id AND s.relocated_to IS NOT NULL)
      UNION SELECT path FROM agent_identities WHERE project_id=$1 AND disabled_at IS NULL
      UNION SELECT chat_path AS path FROM collaboration_rooms WHERE project_id=$1
      UNION SELECT chat_path AS path FROM collaboration_source_requests WHERE project_id=$1
    ) sources WHERE path>$2 AND NOT EXISTS (
      SELECT 1 FROM collaboration_sources retired WHERE retired.project_id=$1
        AND retired.chat_path=sources.path AND retired.retired_room_id IS NOT NULL
    ) ORDER BY path LIMIT 101`,
      [project_id, after],
    );
    const paths = rows.slice(0, 100).map((row) => row.path as string);
    return { paths, ...(rows.length > 100 ? { next: paths[99] } : {}) };
  });
}

export async function ingestCollaborationSnapshot(
  input: CollaborationSourceSnapshot,
  authority: CollaborationWriterAuthority,
) {
  const snapshot = validateSnapshot(input);
  const source_id = sourceKey(snapshot);
  const payload_hash = hash(JSON.stringify(snapshot));
  return transaction(async (db) => {
    await project(db, snapshot.project_id, authority, authority.host_id);
    const current = (
      await db.query("SELECT * FROM collaboration_sources WHERE source_id=$1", [
        source_id,
      ])
    ).rows[0];
    if (
      !current ||
      current.retired_room_id ||
      current.relocated_to ||
      current.epoch !== snapshot.epoch ||
      current.writer_host_id !== authority.host_id ||
      current.owning_bay_id !== authority.owning_bay_id
    )
      throw Error("stale collaboration writer epoch");
    if (Number(current.source_sequence) > snapshot.sequence)
      throw Error("stale collaboration source sequence");
    if (Number(current.source_sequence) === snapshot.sequence) {
      if (current.payload_hash !== payload_hash)
        throw Error("collaboration sequence reused with different metadata");
      return { revision: Number(current.revision), replayed: true };
    }
    await appendCollaborationNotificationEvents(db, snapshot, authority);
    const { resources: adapted, bindings } = await adaptCollaborationAgents(
      db,
      snapshot,
      snapshot.resources,
    );
    const relations = await activateCollaborationRelations(
      db,
      snapshot,
      adapted,
      current,
    );
    const resources = relations.resources;
    const existing = (
      await db.query(
        `SELECT c.entry_key,c.source_id,c.metadata->>'agent_id' AS previous_agent_id,a.path AS agent_path
      FROM collaboration_catalog c LEFT JOIN agent_identities a ON a.agent_id::text=c.metadata->>'agent_id' AND a.disabled_at IS NULL
      WHERE c.entry_key=ANY($1::text[])`,
        [resources.map(entryKey)],
      )
    ).rows;
    const previous = new Map(existing.map((row) => [row.entry_key, row]));
    const metadata_hash = hash(
      JSON.stringify([
        resources,
        bindings.map(({ agent_resource_ids, agent_source_activity }) => [
          agent_resource_ids,
          agent_source_activity,
        ]),
        snapshot.coverage ?? "complete",
        snapshot.coverage_message ?? "",
        snapshot.relations?.digest ?? null,
      ]),
    );
    if (current.metadata_hash === metadata_hash) {
      await db.query(
        "UPDATE collaboration_sources SET source_sequence=$2,payload_hash=$3 WHERE source_id=$1",
        [source_id, snapshot.sequence, payload_hash],
      );
      return { revision: Number(current.revision), replayed: true };
    }
    const previousSize = await db.query(
      "SELECT count(*) AS n FROM collaboration_catalog WHERE source_id=$1 AND deleted_at IS NULL",
      [source_id],
    );
    await charge(
      db,
      snapshot.project_id,
      Math.max(1, snapshot.resources.length + Number(previousSize.rows[0].n)),
    );
    const revision = Number(
      (
        await db.query(
          "UPDATE collaboration_projects SET revision=revision+1 WHERE project_id=$1 RETURNING revision",
          [snapshot.project_id],
        )
      ).rows[0].revision,
    );
    integer(revision, "catalog revision");
    const entries = resources.map((resource) => ({
      entry_key: entryKey(resource),
      kind: resource.kind,
      metadata: resource,
      activity: resource.updated_at,
    }));
    if (
      entries.some((entry) => {
        const old = previous.get(entry.entry_key);
        return (
          old &&
          old.source_id !== source_id &&
          !(
            entry.metadata.kind === "agent" &&
            old.previous_agent_id &&
            old.previous_agent_id === entry.metadata.agent_id
          )
        );
      })
    )
      throw Error(
        "resource identity belongs to another source; explicit move reconciliation required",
      );
    // Tombstones hold the delta floor, but never retain deleted titles or locators.
    await db.query(
      `UPDATE collaboration_catalog SET resource_id=metadata->>'resource_id',
      activity_floor=GREATEST(activity_floor,(metadata->>'activity')::bigint),
      metadata=NULL,deleted_at=now(),revision=$2
      WHERE source_id=$1 AND deleted_at IS NULL AND metadata->>'chat_path'=$4 AND NOT(entry_key=ANY($3::text[]))`,
      [
        source_id,
        revision,
        entries.map((r) => r.entry_key),
        snapshot.chat_path,
      ],
    );
    await db.query(
      `INSERT INTO collaboration_catalog(entry_key,source_id,project_id,kind,resource_id,activity_floor,metadata,revision,activity)
      SELECT e.entry_key,$1,$2,e.kind,e.metadata->>'resource_id',(e.metadata->>'activity')::bigint,e.metadata,$3,e.activity FROM jsonb_to_recordset($4::jsonb)
      AS e(entry_key text,kind text,metadata jsonb,activity bigint)
      ON CONFLICT(entry_key) DO UPDATE SET metadata=jsonb_set(jsonb_set(excluded.metadata,'{activity}',
        to_jsonb(GREATEST(collaboration_catalog.activity_floor,(collaboration_catalog.metadata->>'activity')::bigint,excluded.activity_floor))),
        '{created_at}',COALESCE(collaboration_catalog.metadata->'created_at',excluded.metadata->'created_at')),
        resource_id=excluded.resource_id,activity_floor=GREATEST(collaboration_catalog.activity_floor,excluded.activity_floor),
        source_id=excluded.source_id,revision=excluded.revision,activity=excluded.activity,deleted_at=NULL`,
      [source_id, snapshot.project_id, revision, JSON.stringify(entries)],
    );
    await saveCollaborationAgentBindings(db, bindings, revision);
    await db.query(
      "UPDATE collaboration_catalog SET relation_set=NULL,relation_thread=NULL,relation_count=0 WHERE source_id=$1",
      [source_id],
    );
    if (relations.set_key)
      await db.query(
        `UPDATE collaboration_catalog c SET relation_set=$1,relation_thread=e.thread_key,relation_count=e.count
      FROM jsonb_to_recordset($2::jsonb) AS e(entry_key text,thread_key text,count bigint) WHERE c.entry_key=e.entry_key AND c.deleted_at IS NULL`,
        [relations.set_key, JSON.stringify(relations.bindings)],
      );
    const size = (
      await db.query(
        "SELECT count(*) AS n,COALESCE(sum(COALESCE(octet_length(metadata::text),0)+COALESCE(octet_length(artifact_entry_ids::text),0)+COALESCE(octet_length(agent_resource_ids::text),0)),0) AS bytes FROM collaboration_catalog WHERE project_id=$1",
        [snapshot.project_id],
      )
    ).rows[0];
    if (
      Number(size.n) > MAX_PROJECT_RESOURCES ||
      Number(size.bytes) > 32 * 1024 * 1024
    )
      throw Error("collaboration project catalog quota exceeded");
    await db.query(
      `UPDATE collaboration_sources SET source_sequence=$2,revision=$3,payload_hash=$4,metadata_hash=$5,coverage=$6,coverage_message=$7,relation_set=$8 WHERE source_id=$1`,
      [
        source_id,
        snapshot.sequence,
        revision,
        payload_hash,
        metadata_hash,
        snapshot.relations ? (snapshot.coverage ?? "complete") : "partial",
        snapshot.relations
          ? (snapshot.coverage_message ?? null)
          : (snapshot.coverage_message ??
            "Complete participant/reference relations are not indexed yet."),
        relations.set_key,
      ],
    );
    await pruneCollaborationRelations(db, snapshot.project_id);
    return { revision, replayed: false };
  });
}

export async function ensureCollaborationRoom(
  project_id: string,
  account_id: string,
  request_id: string,
  authority: CollaborationOwnerAuthority,
) {
  uuid(request_id, "request_id");
  return transaction(async (db) => {
    assertMember(await project(db, project_id, authority), account_id);
    await db.query(
      `INSERT INTO collaboration_rooms(project_id,room_id,chat_path,request_id)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [project_id, randomUUID(), COLLABORATION_ROOM_PATH, request_id],
    );
    const row = (
      await db.query(
        "SELECT project_id,room_id,chat_path,initialized FROM collaboration_rooms WHERE project_id=$1",
        [project_id],
      )
    ).rows[0];
    return {
      project_id: row.project_id as string,
      room_id: row.room_id as string,
      chat_path: row.chat_path as string,
      initialized: !!row.initialized,
    };
  });
}
export async function collaborationRoomForHost(
  project_id: string,
  requesting_account_id: string,
  authority: CollaborationWriterAuthority,
) {
  return transaction(async (db) => {
    assertMember(
      await project(db, project_id, authority, authority.host_id),
      requesting_account_id,
    );
    const row = (
      await db.query(
        "SELECT project_id,room_id,chat_path,initialized FROM collaboration_rooms WHERE project_id=$1",
        [project_id],
      )
    ).rows[0];
    if (!row) throw Error("canonical collaboration room is not registered");
    // A lost replacement ACK must not require its original actor to come back.
    // Current-host lookup carries all permanent fences, bounded by the operation cap.
    const retired_rooms = (
      await db.query(
        `SELECT previous_room_id AS room_id,receipt->'request'->>'expected_chat_path' AS chat_path
       FROM collaboration_room_replacements WHERE project_id=$1 ORDER BY operation_id LIMIT 33`,
        [project_id],
      )
    ).rows as Array<{ room_id: string; chat_path: string }>;
    if (retired_rooms.length > 32)
      throw Error("canonical room retirement capacity exceeded");
    return {
      project_id: row.project_id as string,
      room_id: row.room_id as string,
      chat_path: row.chat_path as string,
      initialized: !!row.initialized,
      ...(retired_rooms.length ? { retired_rooms } : {}),
    };
  });
}
export async function markCollaborationRoomInitialized(
  opts: CollaborationInitializeRequest,
  authority: CollaborationWriterAuthority,
) {
  validateSource(opts);
  uuid(opts.room_id, "room_id");
  return transaction(async (db) => {
    assertMember(
      await project(db, opts.project_id, authority, authority.host_id),
      opts.requesting_account_id,
    );
    const row = (
      await db.query(
        `UPDATE collaboration_rooms SET initialized=TRUE WHERE project_id=$1 AND room_id=$2 AND chat_path=$3
      RETURNING project_id,room_id,chat_path,initialized`,
        [opts.project_id, opts.room_id, opts.chat_path],
      )
    ).rows[0];
    if (!row) throw Error("canonical room changed; reconcile initialization");
    return {
      project_id: row.project_id as string,
      room_id: row.room_id as string,
      chat_path: row.chat_path as string,
      initialized: true,
    };
  });
}

export async function relocateCollaborationSource(
  opts: CollaborationRelocateRequest,
  authority: CollaborationWriterAuthority,
) {
  const from = validateSource({
    project_id: opts.project_id,
    chat_path: opts.from_chat_path,
  });
  const to = validateSource({
    project_id: opts.project_id,
    chat_path: opts.to_chat_path,
  });
  uuid(opts.operation_id, "operation_id");
  uuid(opts.expected_epoch, "expected_epoch");
  if (opts.expected_destination_epoch !== null)
    uuid(opts.expected_destination_epoch, "expected_destination_epoch");
  if (from.chat_path === to.chat_path)
    throw Error("relocation paths must differ");
  const from_id = sourceKey(from),
    to_id = sourceKey(to);
  const request_hash = hash(
    JSON.stringify([
      from,
      to,
      opts.expected_epoch,
      opts.expected_destination_epoch,
    ]),
  );
  return transaction(async (db) => {
    await project(db, opts.project_id, authority, authority.host_id);
    const previous = (
      await db.query(
        "SELECT * FROM collaboration_relocations WHERE operation_id=$1",
        [opts.operation_id],
      )
    ).rows[0];
    if (previous) {
      if (
        previous.project_id !== opts.project_id ||
        previous.request_hash !== request_hash
      )
        throw Error("relocation operation reused with different input");
      return {
        epoch: previous.epoch as string,
        revision: Number(previous.revision),
      };
    }
    const rows = (
      await db.query(
        "SELECT * FROM collaboration_sources WHERE source_id=ANY($1::text[])",
        [[from_id, to_id]],
      )
    ).rows;
    const source = rows.find((row) => row.source_id === from_id),
      destination = rows.find((row) => row.source_id === to_id);
    if (source?.retired_room_id || destination?.retired_room_id)
      throw Error("collaboration source is permanently retired");
    if (
      !source ||
      source.epoch !== opts.expected_epoch ||
      source.relocated_to ||
      source.writer_host_id !== authority.host_id
    )
      throw Error("stale relocation source epoch");
    if ((destination?.epoch ?? null) !== opts.expected_destination_epoch)
      throw Error("relocation destination epoch changed");
    if (destination && !destination.relocated_to)
      throw Error("relocation destination is already registered");
    await db.query(
      "DELETE FROM collaboration_relocations WHERE project_id=$1 AND created_at<now()-interval '7 days'",
      [opts.project_id],
    );
    const budget = (
      await db.query(
        `SELECT (SELECT count(*) FROM collaboration_relocations WHERE project_id=$1) AS operations,
      (SELECT count(*) FROM collaboration_sources WHERE project_id=$1) AS sources`,
        [opts.project_id],
      )
    ).rows[0];
    if (
      Number(budget.operations) >= 1000 ||
      (!destination && Number(budget.sources) >= 1024)
    )
      throw Error("relocation capacity exceeded");
    const records = (
      await db.query(
        "SELECT entry_key,metadata,artifact_entry_ids FROM collaboration_catalog WHERE source_id=$1 AND deleted_at IS NULL",
        [from_id],
      )
    ).rows;
    if (records.length > 5000) throw Error("relocation source size exceeded");
    await charge(db, opts.project_id, Math.max(1, records.length));
    const revision = Number(
      (
        await db.query(
          "UPDATE collaboration_projects SET revision=revision+1 WHERE project_id=$1 RETURNING revision",
          [opts.project_id],
        )
      ).rows[0].revision,
    );
    const epoch = randomUUID();
    await db.query(
      `INSERT INTO collaboration_sources(source_id,project_id,chat_path,owning_bay_id,writer_host_id,epoch,registration_id,revision,coverage,coverage_message,relation_set)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(source_id) DO UPDATE SET owning_bay_id=excluded.owning_bay_id,
      writer_host_id=excluded.writer_host_id,epoch=excluded.epoch,registration_id=excluded.registration_id,revision=excluded.revision,
      source_sequence=0,payload_hash=NULL,metadata_hash=NULL,relocated_to=NULL,coverage=excluded.coverage,coverage_message=excluded.coverage_message,relation_set=excluded.relation_set`,
      [
        to_id,
        opts.project_id,
        to.chat_path,
        authority.owning_bay_id,
        authority.host_id,
        epoch,
        opts.operation_id,
        revision,
        source.coverage,
        source.coverage_message,
        source.relation_set,
      ],
    );
    await db.query(
      `UPDATE collaboration_sources SET relocated_to=$2,epoch=$3,registration_id=NULL,source_sequence=0,payload_hash=NULL,metadata_hash=NULL,relation_set=NULL WHERE source_id=$1`,
      [from_id, to.chat_path, randomUUID()],
    );
    const moved = records.map((row) => {
      const metadata = { ...row.metadata, chat_path: to.chat_path };
      let artifact_entry_ids = row.artifact_entry_ids ?? [];
      if (metadata.kind === "artifact" && metadata.artifact_id) {
        artifact_entry_ids = [
          ...new Set<string>([
            ...artifact_entry_ids,
            hash(artifactCatalogKey(from, metadata)),
          ]),
        ];
        if (artifact_entry_ids.length > MAX_ARTIFACT_ENTRY_IDS)
          throw Error("artifact relocation history capacity exceeded");
        metadata.entry_id = hash(artifactCatalogKey(to, metadata));
      }
      return {
        entry_key: row.entry_key,
        metadata: validateResource(metadata),
        artifact_entry_ids,
      };
    });
    await db.query(
      `UPDATE collaboration_catalog c SET source_id=$1,metadata=e.metadata,revision=$2,artifact_entry_ids=e.artifact_entry_ids
      FROM jsonb_to_recordset($3::jsonb) AS e(entry_key text,metadata jsonb,artifact_entry_ids text[]) WHERE c.entry_key=e.entry_key`,
      [to_id, revision, JSON.stringify(moved)],
    );
    const size = (
      await db.query(
        `SELECT COALESCE(sum(COALESCE(octet_length(metadata::text),0)+COALESCE(octet_length(artifact_entry_ids::text),0)+COALESCE(octet_length(agent_resource_ids::text),0)),0) AS bytes
      FROM collaboration_catalog WHERE project_id=$1`,
        [opts.project_id],
      )
    ).rows[0];
    if (Number(size.bytes) > 32 * 1024 * 1024)
      throw Error("collaboration project catalog quota exceeded");
    await db.query(
      "UPDATE collaboration_catalog SET source_id=$2,revision=$3 WHERE source_id=$1 AND deleted_at IS NOT NULL",
      [from_id, to_id, revision],
    );
    await db.query(
      "UPDATE collaboration_rooms SET chat_path=$3 WHERE project_id=$1 AND chat_path=$2",
      [opts.project_id, from.chat_path, to.chat_path],
    );
    await db.query(
      "UPDATE agent_identities SET path=$3 WHERE project_id=$1 AND path=$2 AND disabled_at IS NULL",
      [opts.project_id, from.chat_path, to.chat_path],
    );

    // Library uses a locator-derived key. Move its bounded owner catalog in the
    // same transaction; both old and destination artifact writers are fenced.
    const artifactSource = (
      await db.query(
        "SELECT * FROM artifact_catalog_sources WHERE source_id=$1",
        [from_id],
      )
    ).rows[0];
    if (artifactSource) {
      if (
        (
          await db.query(
            "SELECT 1 FROM artifact_catalog WHERE source_id=$1 AND NOT deleted LIMIT 1",
            [to_id],
          )
        ).rows.length
      )
        throw Error("artifact relocation destination is occupied");
      const artifacts = (
        await db.query(
          "SELECT entry_id,metadata FROM artifact_catalog WHERE source_id=$1 LIMIT 5001",
          [from_id],
        )
      ).rows;
      if (artifacts.length > 5000)
        throw Error("artifact relocation source size exceeded");
      await db.query(
        `INSERT INTO artifact_catalog_sources(source_id,project_id,chat_path,owning_bay_id,writer_host_id,epoch,registration_id,catalog_revision,updated_at)
        VALUES($1,$2,$3,$4,NULL,$5,NULL,$6,now()) ON CONFLICT(source_id) DO UPDATE SET epoch=excluded.epoch,writer_host_id=NULL,
        registration_id=NULL,source_sequence=0,payload_hash=NULL,metadata_hash=NULL,catalog_revision=excluded.catalog_revision,updated_at=now()`,
        [
          to_id,
          opts.project_id,
          to.chat_path,
          authority.owning_bay_id,
          randomUUID(),
          Number(artifactSource.catalog_revision) + 1,
        ],
      );
      const changes = artifacts.map((row) => ({
        old_key: row.entry_id,
        new_key: hash(artifactCatalogKey(to, row.metadata)),
      }));
      await db.query(
        `UPDATE artifact_catalog c SET entry_id=e.new_key,source_id=$1,revision=$2
        FROM jsonb_to_recordset($3::jsonb) AS e(old_key text,new_key text) WHERE c.entry_id=e.old_key`,
        [
          to_id,
          Number(artifactSource.catalog_revision) + 1,
          JSON.stringify(changes),
        ],
      );
      await db.query(
        "UPDATE artifact_catalog_sources SET epoch=$2,writer_host_id=NULL,registration_id=NULL,source_sequence=0,payload_hash=NULL,metadata_hash=NULL WHERE source_id=$1",
        [from_id, randomUUID()],
      );
    }
    await db.query(
      "INSERT INTO collaboration_relocations(operation_id,project_id,request_hash,epoch,revision,created_at) VALUES($1,$2,$3,$4,$5,now())",
      [opts.operation_id, opts.project_id, request_hash, epoch, revision],
    );
    return { epoch, revision };
  });
}
export async function getOwnedCollaborationResource(
  target: CollaborationTarget,
  account_id: string,
  authority: CollaborationOwnerAuthority,
): Promise<CollaborationOwnedResource | null> {
  validateTarget(target);
  return transaction(async (db) => {
    assertMember(await project(db, target.project_id, authority), account_id);
    const rows = (
      await db.query(
        `SELECT metadata,artifact_entry_ids,agent_resource_ids FROM collaboration_catalog
        WHERE project_id=$2 AND deleted_at IS NULL AND (entry_key=$1 OR
        ($3='agent' AND kind='agent' AND (agent_resource_ids @> ARRAY[$4::text]
          OR metadata->>'agent_id'=$4))) ORDER BY (entry_key=$1) DESC LIMIT 2`,
        [entryKey(target), target.project_id, target.kind, target.resource_id],
      )
    ).rows;
    if (rows.length > 1) throw Error("ambiguous collaboration reference");
    const row = rows[0];
    if (
      row?.metadata.kind === "agent" &&
      row.metadata.agent_id &&
      !row.metadata.resource_id.startsWith("copy:")
    ) {
      const identity = (
        await db.query(
          "SELECT path,thread_id FROM agent_identities WHERE project_id=$1 AND agent_id::text=$2 AND disabled_at IS NULL",
          [target.project_id, row.metadata.agent_id],
        )
      ).rows[0];
      if (!identity) return null;
      row.agent_catalog_resource_id = row.metadata.resource_id;
      row.agent_resource_ids = agentReferenceIds(row.agent_resource_ids ?? []);
      row.metadata = {
        ...row.metadata,
        chat_path: identity.path,
        thread_id: identity.thread_id,
        ...(row.metadata.thread_id !== identity.thread_id
          ? { archived: false }
          : {}),
      };
    }
    return row
      ? {
          ...row.metadata,
          // Legacy callers compare the returned typed target to their authored target.
          resource_id: target.resource_id,
          ...(row.agent_catalog_resource_id
            ? { agent_catalog_resource_id: row.agent_catalog_resource_id }
            : {}),
          ...(row.agent_resource_ids?.length
            ? { agent_resource_ids: row.agent_resource_ids }
            : {}),
          ...(row.artifact_entry_ids?.length
            ? { artifact_entry_ids: row.artifact_entry_ids }
            : {}),
        }
      : null;
  });
}

/** A bounded pull outbox: the catalog revision and tombstones are committed with ingestion. */
export async function readCollaborationProjection(
  opts: CollaborationProjectionRequest,
  authority: CollaborationOwnerAuthority,
): Promise<CollaborationProjectionPage> {
  const batch = await readCollaborationSharedProjection(
    { ...opts, account_ids: [opts.account_id] },
    authority,
  );
  const recipient = batch.recipients[0];
  if (!batch.catalog || !recipient.allowed) return { allowed: false };
  return {
    allowed: true,
    ...batch.catalog,
    attention_generation: recipient.attention_generation,
    items: batch.catalog.items.map((item) => ({
      ...item,
      ...(item.resource
        ? { initial_activity: recipient.floors[item.resource.resource_id] }
        : {}),
    })),
  };
}

/** Internal shared catalog read. Recipients have independent authorization and
 * notification cutover floors; the common catalog alone is never an access grant.
 * All recipients use one compatible catalog/relation cursor under one owner fence.
 */
export async function readCollaborationSharedProjection(
  opts: Omit<CollaborationProjectionRequest, "account_id"> & {
    account_ids: string[];
  },
  authority: CollaborationOwnerAuthority,
) {
  if (
    !Array.isArray(opts.account_ids) ||
    !opts.account_ids.length ||
    opts.account_ids.length > 16
  )
    throw Error("invalid shared projection recipient count");
  for (const id of opts.account_ids) uuid(id, "account_id");
  const account_ids = [
    ...new Set(opts.account_ids.map((id) => id.toLowerCase())),
  ];
  integer(opts.revision, "projection revision");
  boundedText(opts.after_key, "projection cursor", 64, true);
  if (opts.generation != null) uuid(opts.generation, "generation");
  return transaction(async (db) => {
    const p = await project(db, opts.project_id, authority);
    const allowed = account_ids.filter(
      (id) => !p.deleted && collaboratorRole(p.users?.[id]?.group),
    );
    type Recipient =
      | { account_id: string; allowed: false }
      | {
          account_id: string;
          allowed: true;
          attention_generation: string;
          floors: Record<string, number>;
        };
    const recipients: Recipient[] = [];
    if (!allowed.length)
      return {
        catalog: null,
        recipients: account_ids.map((account_id) => ({
          account_id,
          allowed: false as const,
        })),
      };
    const state = (
      await db.query(
        "SELECT generation,revision FROM collaboration_projects WHERE project_id=$1",
        [opts.project_id],
      )
    ).rows[0];
    const reset = state.generation !== opts.generation;
    const revision = reset ? 0 : opts.revision;
    const after_key = reset ? "" : opts.after_key;
    const { rows } = await db.query(
      `SELECT entry_key,metadata,revision,artifact_entry_ids,agent_resource_ids,relation_set,relation_thread,relation_count FROM collaboration_catalog
      WHERE project_id=$1 AND ${after_key ? "(revision,entry_key)>($2::bigint,$3::text)" : "revision>$2::bigint"}
      ORDER BY revision,entry_key LIMIT 51`,
      after_key
        ? [opts.project_id, revision, after_key]
        : [opts.project_id, revision],
    );
    let bytes = 1024 + account_ids.length * 256;
    const items: NonNullable<
      Extract<CollaborationProjectionPage, { allowed: true }>["items"]
    > = [];
    for (const row of rows.slice(0, 50)) {
      if (items.length && row.relation_set) break;
      const item = {
        entry_key: row.entry_key as string,
        revision: Number(row.revision),
        resource: row.metadata
          ? {
              ...row.metadata,
              ...(row.agent_resource_ids?.length
                ? { agent_resource_ids: row.agent_resource_ids }
                : {}),
              ...(row.artifact_entry_ids?.length
                ? { artifact_entry_ids: row.artifact_entry_ids }
                : {}),
            }
          : null,
      };
      const size =
        Buffer.byteLength(JSON.stringify(item)) +
        64 +
        account_ids.length *
          (item.resource
            ? Buffer.byteLength(JSON.stringify(item.resource.resource_id)) + 32
            : 0);
      if (bytes + size > PAGE_BYTES) break;
      items.push(item);
      bytes += size;
      if (row.relation_set) break;
    }
    const relation = await readOwnerParticipantProjection(
      db,
      items[0],
      rows[0],
      reset ? undefined : opts.relation_after,
    );
    const complete = !relation.next && items.length === rows.length;
    const last = items[items.length - 1];
    for (const account_id of account_ids) {
      if (!allowed.includes(account_id)) {
        recipients.push({ account_id, allowed: false });
        continue;
      }
      const attention = await readCollaborationNotificationAttention(db, {
        project_id: opts.project_id,
        account_id,
        resources: items.flatMap((item) =>
          item.resource ? [item.resource] : [],
        ),
      });
      recipients.push({
        account_id,
        allowed: true,
        attention_generation: attention.generation,
        floors: attention.floors,
      });
    }
    return {
      recipients,
      catalog: {
        generation: state.generation,
        reset,
        items,
        complete,
        revision: relation.next
          ? revision
          : complete
            ? Number(state.revision)
            : last.revision,
        after_key: relation.next ? after_key : complete ? "" : last.entry_key,
        ...(relation.next ? { relation_after: relation.next } : {}),
      },
    };
  });
}

/** Removing old delta tombstones rotates the generation, forcing explicit resnapshot. */
export async function compactCollaborationProject(
  project_id: string,
  authority: CollaborationOwnerAuthority,
) {
  return transaction(async (db) => {
    await project(db, project_id, authority);
    await pruneCollaborationRelations(db, project_id);
    const result = await db.query(
      `DELETE FROM collaboration_catalog c WHERE project_id=$1 AND deleted_at < now()-interval '7 days' AND agent_resource_ids IS NULL
       AND NOT EXISTS(SELECT 1 FROM collaboration_sources s WHERE s.source_id=c.source_id AND s.retired_room_id IS NOT NULL)`,
      [project_id],
    );
    if (result.rowCount)
      await db.query(
        "UPDATE collaboration_projects SET generation=$2 WHERE project_id=$1",
        [project_id, randomUUID()],
      );
    return result.rowCount ?? 0;
  });
}

export async function compactNextCollaborationProject(owning_bay_id: string) {
  const project_id = await transaction(async (db) => {
    await db.query(
      "INSERT INTO collaboration_maintenance(id,cursor) VALUES('compact','{}') ON CONFLICT DO NOTHING",
    );
    const cursor = (
      await db.query(
        "SELECT cursor FROM collaboration_maintenance WHERE id='compact' FOR UPDATE",
      )
    ).rows[0].cursor;
    const row = (
      await db.query(
        `SELECT c.project_id FROM collaboration_projects c JOIN projects p USING(project_id)
      WHERE p.owning_bay_id=$1 AND c.project_id>$2::uuid ORDER BY c.project_id LIMIT 1`,
        [
          owning_bay_id,
          cursor.project_id ?? "00000000-0000-0000-0000-000000000000",
        ],
      )
    ).rows[0];
    await db.query(
      "UPDATE collaboration_maintenance SET cursor=$1::jsonb WHERE id='compact'",
      [JSON.stringify(row ?? {})],
    );
    return row?.project_id as string | undefined;
  });
  if (project_id) {
    await reconcileCollaborationAgents(project_id, { owning_bay_id });
    await compactCollaborationProject(project_id, { owning_bay_id });
  }
}

/** Registration/moves may happen while the chat is stopped; reconcile 50 at a time. */
export async function reconcileCollaborationAgents(
  project_id: string,
  authority: CollaborationOwnerAuthority,
) {
  return transaction(async (db) => {
    await project(db, project_id, authority);
    const { rows } = await db.query(
      `SELECT c.entry_key,c.source_id,c.metadata,c.agent_source_activity,a.agent_id,a.path,a.thread_id,a.conversation_history
      FROM collaboration_catalog c LEFT JOIN LATERAL (
        SELECT agent_id,path,thread_id,conversation_history FROM agent_identities a WHERE a.project_id=c.project_id AND a.disabled_at IS NULL
        AND ((c.metadata ? 'agent_id' AND a.agent_id::text=c.metadata->>'agent_id')
          OR (NOT(c.metadata ? 'agent_id') AND c.metadata->>'resource_id' NOT LIKE 'copy:%'
            AND a.path=c.metadata->>'chat_path' AND (a.thread_id=c.metadata->>'thread_id'
              OR a.conversation_history @> jsonb_build_array(jsonb_build_object('thread_id',c.metadata->>'thread_id'))))) LIMIT 1
      ) a ON TRUE WHERE c.project_id=$1 AND c.kind='agent' AND c.deleted_at IS NULL
      AND (c.metadata->>'agent_id' IS DISTINCT FROM a.agent_id::text
        OR (a.agent_id IS NOT NULL AND (c.resource_id IS DISTINCT FROM a.agent_id::text
          OR c.metadata->>'chat_path' IS DISTINCT FROM a.path OR c.metadata->>'thread_id' IS DISTINCT FROM a.thread_id)))
      ORDER BY c.entry_key LIMIT 50`,
      [project_id],
    );
    if (!rows.length) return 0;
    const revision = (
      await db.query(
        "UPDATE collaboration_projects SET revision=revision+1 WHERE project_id=$1 RETURNING revision",
        [project_id],
      )
    ).rows[0].revision;
    for (const row of rows) {
      if (!row.agent_id) {
        await db.query(
          "UPDATE collaboration_catalog SET metadata=NULL,deleted_at=now(),revision=$2 WHERE entry_key=$1",
          [row.entry_key, revision],
        );
        continue;
      }
      const { bindings } = await adaptCollaborationAgents(
        db,
        { project_id, chat_path: row.path },
        [
          normalizeOwnedCollaborationAgent(
            {
              ...row.metadata,
              chat_path: row.path,
              activity:
                row.metadata.resource_id === row.agent_id
                  ? Number(row.agent_source_activity)
                  : row.metadata.activity,
            },
            { ...row, project_id },
          ),
        ],
      );
      for (const binding of bindings) {
        const retained = await retainedAgentRelations(
          db,
          binding.resource,
          row.entry_key,
        );
        await upsertCollaborationAgent(
          db,
          binding,
          row.source_id,
          Number(revision),
        );
        await db.query(
          `UPDATE collaboration_catalog SET relation_set=$2,relation_thread=$3,relation_count=$4 WHERE entry_key=$1`,
          [
            entryKey(binding.resource),
            retained?.relation_set ?? null,
            retained?.relation_thread ?? null,
            Number(retained?.relation_count ?? 0),
          ],
        );
      }
    }
    await db.query(
      "UPDATE collaboration_sources SET metadata_hash=NULL WHERE source_id=ANY($1::text[])",
      [[...new Set(rows.map((row) => row.source_id))]],
    );
    const size = (
      await db.query(
        "SELECT count(*) AS n,COALESCE(sum(COALESCE(octet_length(metadata::text),0)+COALESCE(octet_length(artifact_entry_ids::text),0)+COALESCE(octet_length(agent_resource_ids::text),0)),0) AS bytes FROM collaboration_catalog WHERE project_id=$1",
        [project_id],
      )
    ).rows[0];
    if (
      Number(size.n) > MAX_PROJECT_RESOURCES ||
      Number(size.bytes) > 32 * 1024 * 1024
    )
      throw Error("collaboration project catalog quota exceeded");
    return rows.length;
  });
}
