/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { validateCollaborationMessageEvent } from "@cocalc/util/collaboration-attention";
import type { LegacyCollaborationAttention } from "@cocalc/util/collaboration-attention";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import {
  collaborationTargetKey,
  COLLABORATION_MAX_SOURCE_BYTES,
  COLLABORATION_MAX_SOURCE_RESOURCES,
  COLLABORATION_PARTICIPANT_SUMMARY_LIMIT,
} from "@cocalc/util/collaborators";
import type {
  CollaborationResource,
  CollaborationSourceSnapshot,
  CollaborationTarget,
} from "@cocalc/util/collaborators";

export const MAX_PROJECT_RESOURCES = 50000;
export const MAX_ACCOUNT_RESOURCES = 100000;
export const ACCESS_LEASE_MS = 60000;
export const PAGE_BYTES = 256 * 1024;
export const MAX_RESOURCE_BYTES = 8192;
export const MAX_ARTIFACT_ENTRY_IDS = 64;
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const entryKey = (value: CollaborationTarget) =>
  hash(collaborationTargetKey(value));
export const sourceKey = (value: { project_id: string; chat_path: string }) =>
  hash(JSON.stringify([value.project_id, value.chat_path]));
export const collaboratorRole = (role: unknown) =>
  role === "owner" || role === "collaborator";

export function uuid(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw Error(`invalid ${label}`);
}
export function boundedText(
  value: unknown,
  label: string,
  max: number,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.length) ||
    Buffer.byteLength(value) > max ||
    /[\x00-\x08\x0b-\x1f]/.test(value)
  )
    throw Error(`invalid ${label}`);
  return value;
}
export function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw Error(`invalid ${label}`);
  return value;
}
export function validateSource(source: {
  project_id: string;
  chat_path: string;
}) {
  uuid(source.project_id, "project_id");
  const path = boundedText(source.chat_path, "chat_path", 1024);
  if (
    !path.startsWith("/") ||
    posix.normalize(path) !== path ||
    !path.endsWith(".chat")
  )
    throw Error("chat_path must be a canonical absolute .chat path");
  return { project_id: source.project_id, chat_path: path };
}
export function validateTarget(
  target: CollaborationTarget,
): CollaborationTarget {
  uuid(target.project_id, "project_id");
  if (!["agent", "artifact", "conversation"].includes(target.kind))
    throw Error("invalid resource kind");
  return {
    project_id: target.project_id,
    kind: target.kind,
    resource_id: boundedText(target.resource_id, "resource_id", 256),
  };
}
export function validateResource(
  input: CollaborationResource,
): CollaborationResource {
  const target = validateTarget(input);
  validateSource(input);
  if (
    !Array.isArray(input.participant_ids) ||
    input.participant_ids.length > COLLABORATION_PARTICIPANT_SUMMARY_LIMIT
  )
    throw Error("participant summary limit exceeded");
  input.participant_ids.forEach((id) => uuid(id, "participant_id"));
  if (input.created_by != null) uuid(input.created_by, "created_by");
  const resource: CollaborationResource & LegacyCollaborationAttention = {
    ...target,
    chat_path: input.chat_path,
    thread_id: boundedText(input.thread_id, "thread_id", 256),
    title: boundedText(input.title, "title", 512, true),
    participant_ids: [...new Set(input.participant_ids)].sort(),
    created_at: integer(input.created_at, "created_at"),
    updated_at: integer(input.updated_at, "updated_at"),
    activity: integer(input.activity, "activity"),
    ...(input.created_by == null ? {} : { created_by: input.created_by }),
  };
  for (const field of ["agent_id", "artifact_id", "entry_id"] as const) {
    if (input[field] != null)
      resource[field] = boundedText(input[field], field, 256);
  }
  const legacy = input as CollaborationResource & LegacyCollaborationAttention;
  for (const field of [
    "notification_followers",
    "notification_muted",
  ] as const) {
    if (legacy[field] === undefined) continue;
    const values = legacy[field];
    if (!Array.isArray(values) || values.length > 1000)
      throw Error("legacy attention list limit exceeded");
    values.forEach((id) => uuid(id, field));
    resource[field] = [...new Set(values)].sort();
  }
  if (input.participant_count !== undefined) {
    resource.participant_count = integer(
      input.participant_count,
      "participant_count",
    );
    if (resource.participant_count < resource.participant_ids.length)
      throw Error("participant_count is smaller than its summary");
  }
  if (input.participants_truncated !== undefined) {
    if (typeof input.participants_truncated !== "boolean")
      throw Error("invalid participants_truncated");
    resource.participants_truncated = input.participants_truncated;
    if (
      resource.participants_truncated &&
      (resource.participant_count ?? 0) <= resource.participant_ids.length
    )
      throw Error("truncated participants require total count");
  }
  if (input.archived != null) {
    if (typeof input.archived !== "boolean") throw Error("invalid archived");
    resource.archived = input.archived;
  }
  if (Buffer.byteLength(JSON.stringify(resource)) > MAX_RESOURCE_BYTES)
    throw Error("resource metadata limit exceeded");
  return resource;
}
export function validateSnapshot(
  input: CollaborationSourceSnapshot,
): CollaborationSourceSnapshot {
  const source = validateSource(input);
  uuid(input.epoch, "epoch");
  integer(input.sequence, "sequence");
  if (
    !input.sequence ||
    !Array.isArray(input.resources) ||
    input.resources.length > COLLABORATION_MAX_SOURCE_RESOURCES
  )
    throw Error("invalid snapshot size/sequence");
  if (Buffer.byteLength(JSON.stringify(input)) > COLLABORATION_MAX_SOURCE_BYTES)
    throw Error("snapshot byte limit exceeded");
  const resources = input.resources
    .map(validateResource)
    .sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  const keys = new Set<string>();
  for (const item of resources) {
    if (
      item.project_id !== source.project_id ||
      item.chat_path !== source.chat_path
    )
      throw Error("snapshot source mismatch");
    const key = entryKey(item);
    if (keys.has(key)) throw Error("duplicate resource identity");
    keys.add(key);
  }
  if (
    input.coverage !== undefined &&
    !["complete", "partial"].includes(input.coverage)
  )
    throw Error("invalid source coverage");
  const coverage_message =
    input.coverage_message === undefined
      ? undefined
      : boundedText(input.coverage_message, "coverage_message", 512, true);
  if (
    input.notification_events !== undefined &&
    (!Array.isArray(input.notification_events) ||
      input.notification_events.length > 1000)
  )
    throw Error("notification event limit exceeded");
  const notification_events = input.notification_events?.map(
    validateCollaborationMessageEvent,
  );
  for (const event of notification_events ?? [])
    if (event.project_id !== source.project_id)
      throw Error("notification event source mismatch");
  return {
    ...source,
    epoch: input.epoch,
    sequence: input.sequence,
    resources,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    ...(coverage_message ? { coverage_message } : {}),
    ...(notification_events ? { notification_events } : {}),
  };
}
export async function transaction<T>(
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

/** Install before serving discovery or running its maintenance worker. */
export async function syncCollaboratorsSchema(
  db: Pick<PoolClient, "query"> = getPool(),
) {
  await db.query(
    "ALTER TABLE collaboration_catalog ADD COLUMN IF NOT EXISTS agent_resource_ids TEXT[], ADD COLUMN IF NOT EXISTS agent_source_activity BIGINT NOT NULL DEFAULT 0",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS collaboration_catalog_agent_references ON collaboration_catalog USING GIN(agent_resource_ids)",
  );
  await db.query(`CREATE OR REPLACE FUNCTION collaboration_account_changed() RETURNS trigger AS $$
  DECLARE target uuid;
  BEGIN
    IF TG_OP='DELETE' THEN target:=OLD.account_id; ELSE target:=NEW.account_id; END IF;
    INSERT INTO collaboration_account_state(account_id,revision,revision_xid) VALUES(target,1,txid_current())
      ON CONFLICT(account_id) DO UPDATE SET revision=collaboration_account_state.revision+1,revision_xid=excluded.revision_xid
      WHERE collaboration_account_state.revision_xid IS DISTINCT FROM excluded.revision_xid;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql`);
  for (const table of [
    "account_project_index",
    "account_collaborator_index",
    "collaboration_personal",
    "agent_personal_names",
    "personal_library_aliases",
    "personal_library_pins",
  ]) {
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='collaboration_account_changed' AND tgrelid='${table}'::regclass) THEN
        CREATE TRIGGER collaboration_account_changed AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION collaboration_account_changed();
      END IF;
    END $$`);
  }
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='collaboration_account_changed' AND tgrelid='accounts'::regclass) THEN
      CREATE TRIGGER collaboration_account_changed AFTER UPDATE OF other_settings,home_bay_id,deleted,banned ON accounts
      FOR EACH ROW EXECUTE FUNCTION collaboration_account_changed();
    END IF;
  END $$`);
  await db.query(`CREATE OR REPLACE FUNCTION collaboration_project_fence() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM collaboration_memberships WHERE project_id=OLD.project_id;
      UPDATE collaboration_projects SET generation=gen_random_uuid() WHERE project_id=OLD.project_id;
      UPDATE collaboration_sources SET epoch=gen_random_uuid(),registration_id=NULL,source_sequence=0,payload_hash=NULL WHERE project_id=OLD.project_id;
      RETURN OLD;
    END IF;
    IF OLD.users IS DISTINCT FROM NEW.users OR OLD.deleted IS DISTINCT FROM NEW.deleted
      OR OLD.owning_bay_id IS DISTINCT FROM NEW.owning_bay_id THEN
      UPDATE collaboration_projects SET generation=gen_random_uuid() WHERE project_id=NEW.project_id;
      DELETE FROM collaboration_memberships m WHERE m.project_id=NEW.project_id AND (
        NEW.deleted IS TRUE OR OLD.deleted IS DISTINCT FROM NEW.deleted
        OR OLD.owning_bay_id IS DISTINCT FROM NEW.owning_bay_id
        OR NOT COALESCE(OLD.users #>> ARRAY[m.account_id::text,'group'] IN ('owner','collaborator'),FALSE)
        OR NOT COALESCE(NEW.users #>> ARRAY[m.account_id::text,'group'] IN ('owner','collaborator'),FALSE));
      IF NEW.deleted IS NOT TRUE AND EXISTS(SELECT 1 FROM collaboration_projects WHERE project_id=NEW.project_id) THEN
        INSERT INTO collaboration_memberships(project_id,account_id,epoch,notification_position)
          SELECT NEW.project_id,u.key::uuid,gen_random_uuid(),GREATEST(
            COALESCE((SELECT max(position) FROM collaboration_notification_events WHERE project_id=NEW.project_id),0),
            COALESCE((SELECT position FROM collaboration_notification_floors WHERE project_id=NEW.project_id),0))
          FROM jsonb_each(COALESCE(NEW.users,'{}'::jsonb)) u WHERE u.value->>'group' IN ('owner','collaborator')
          ON CONFLICT(project_id,account_id) DO NOTHING;
      END IF;
    END IF;
    IF OLD.host_id IS DISTINCT FROM NEW.host_id OR OLD.owning_bay_id IS DISTINCT FROM NEW.owning_bay_id
      OR OLD.deleted IS DISTINCT FROM NEW.deleted THEN
      UPDATE collaboration_sources SET epoch=gen_random_uuid(),registration_id=NULL,source_sequence=0,payload_hash=NULL WHERE project_id=NEW.project_id;
    END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql`);
  // No drop/recreate gap when another hub starts while membership writes run.
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='collaboration_project_fence' AND tgrelid='projects'::regclass) THEN
      CREATE TRIGGER collaboration_project_fence AFTER UPDATE OF users,deleted,host_id,owning_bay_id OR DELETE ON projects
      FOR EACH ROW EXECUTE FUNCTION collaboration_project_fence();
    END IF;
  END $$`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS collaboration_project_title_search ON account_project_index USING GIN(to_tsvector('simple',COALESCE(title,'')))",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS collaboration_person_name_search ON account_collaborator_index USING GIN(to_tsvector('simple',COALESCE(display_name,'')))",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS collaboration_agent_alias_search ON agent_personal_names USING GIN(to_tsvector('simple',name))",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS collaboration_artifact_alias_search ON personal_library_aliases USING GIN(to_tsvector('simple',name))",
  );
}
