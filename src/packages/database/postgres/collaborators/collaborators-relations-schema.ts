/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";

export async function syncCollaborationRelationsSchema(
  db: Pick<PoolClient, "query">,
) {
  const ddl = `CREATE TABLE IF NOT EXISTS collaboration_relation_sets (
    set_key TEXT PRIMARY KEY,project_id UUID,source_id TEXT,epoch UUID,sequence BIGINT NOT NULL DEFAULT 0,
    manifest JSONB,byte_count BIGINT NOT NULL DEFAULT 0,row_count BIGINT NOT NULL DEFAULT 0,created_at TIMESTAMP NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS collaboration_relation_sets_source ON collaboration_relation_sets(source_id,created_at);
    CREATE INDEX IF NOT EXISTS collaboration_relation_sets_project ON collaboration_relation_sets(project_id,created_at);
    CREATE TABLE IF NOT EXISTS collaboration_relation_pages (
      id TEXT PRIMARY KEY,project_id UUID,set_key TEXT,page BIGINT NOT NULL DEFAULT 0,payload JSONB,digest TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS collaboration_relation_pages_set ON collaboration_relation_pages(set_key,page);
    CREATE INDEX IF NOT EXISTS collaboration_relation_pages_project ON collaboration_relation_pages(project_id);
    CREATE TABLE IF NOT EXISTS collaboration_participants (
      id TEXT PRIMARY KEY,project_id UUID,set_key TEXT,thread_key TEXT,participant_id UUID);
    CREATE INDEX IF NOT EXISTS collaboration_participants_thread ON collaboration_participants(set_key,thread_key,participant_id);
    CREATE INDEX IF NOT EXISTS collaboration_participants_person ON collaboration_participants(participant_id,set_key,thread_key);
    CREATE INDEX IF NOT EXISTS collaboration_participants_project ON collaboration_participants(project_id);
    CREATE TABLE IF NOT EXISTS collaboration_references (
      id TEXT PRIMARY KEY,project_id UUID,set_key TEXT,thread_key TEXT,message_id TEXT,payload JSONB);
    CREATE INDEX IF NOT EXISTS collaboration_references_thread ON collaboration_references(set_key,thread_key,id);
    CREATE INDEX IF NOT EXISTS collaboration_references_message ON collaboration_references(set_key,thread_key,message_id,id);
    CREATE INDEX IF NOT EXISTS collaboration_references_project ON collaboration_references(project_id);
    CREATE TABLE IF NOT EXISTS collaboration_participant_index (
      account_id UUID,entry_key TEXT,project_id UUID,set_key TEXT,participant_id UUID,
      PRIMARY KEY(account_id,entry_key,set_key,participant_id));
    CREATE INDEX IF NOT EXISTS collaboration_participant_index_person ON collaboration_participant_index(account_id,participant_id,entry_key);
    CREATE INDEX IF NOT EXISTS collaboration_participant_index_project ON collaboration_participant_index(account_id,project_id);
    ALTER TABLE collaboration_sources ADD COLUMN IF NOT EXISTS relation_set TEXT;
    ALTER TABLE collaboration_catalog ADD COLUMN IF NOT EXISTS relation_set TEXT,
      ADD COLUMN IF NOT EXISTS relation_thread TEXT,ADD COLUMN IF NOT EXISTS relation_count BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS relation_digest TEXT,
      ADD COLUMN IF NOT EXISTS relation_digest_set TEXT;
    ALTER TABLE collaboration_access ADD COLUMN IF NOT EXISTS relation_after JSONB;
    ALTER TABLE collaboration_index ADD COLUMN IF NOT EXISTS relation_set TEXT,ADD COLUMN IF NOT EXISTS relation_thread TEXT,
      ADD COLUMN IF NOT EXISTS relation_budget BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS relations_complete BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS collaboration_catalog_relation ON collaboration_catalog(relation_set,relation_thread);
    CREATE INDEX IF NOT EXISTS collaboration_index_relation ON collaboration_index(account_id,relation_set,relation_thread);
    CREATE INDEX IF NOT EXISTS collaboration_index_relations_pending ON collaboration_index(account_id,project_id) WHERE NOT relations_complete;`;
  for (const statement of ddl.split(";").filter((s) => s.trim()))
    await db.query(statement);
  await db.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='collaboration_participant_index_parent') THEN
        ALTER TABLE collaboration_participant_index ADD CONSTRAINT collaboration_participant_index_parent
          FOREIGN KEY(account_id,entry_key) REFERENCES collaboration_index(account_id,entry_key) ON DELETE CASCADE;
      END IF;
    END $$;`);
}
