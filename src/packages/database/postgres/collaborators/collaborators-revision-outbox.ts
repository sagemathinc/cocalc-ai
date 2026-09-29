/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";

/** Explicit prototype installation. Do not install in ordinary startup until
 * owner-fenced draining and disabled-after-install behavior are validated.
 */
export async function syncCollaborationRevisionOutboxSchema(
  db: Pick<PoolClient, "query">,
) {
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_revision_outbox (
    project_id UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
    token UUID NOT NULL,
    generation UUID NOT NULL,
    revision BIGINT NOT NULL,
    due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    after_home_bay TEXT
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_revision_outbox_due
    ON collaboration_revision_outbox(due_at,project_id)`);
  await db.query(`CREATE OR REPLACE FUNCTION collaboration_enqueue_revision() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.generation IS NOT DISTINCT FROM NEW.generation
        AND OLD.revision IS NOT DISTINCT FROM NEW.revision THEN
        RETURN NEW;
      END IF;
      INSERT INTO collaboration_revision_outbox(project_id,token,generation,revision)
        VALUES(NEW.project_id,gen_random_uuid(),NEW.generation,NEW.revision)
      ON CONFLICT(project_id) DO UPDATE SET
        token=excluded.token,generation=excluded.generation,revision=excluded.revision,
        due_at=LEAST(collaboration_revision_outbox.due_at,excluded.due_at),after_home_bay=NULL;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='collaboration_enqueue_revision'
      AND tgrelid='collaboration_projects'::regclass) THEN
      CREATE TRIGGER collaboration_enqueue_revision
        AFTER INSERT OR UPDATE OF generation,revision ON collaboration_projects
        FOR EACH ROW EXECUTE FUNCTION collaboration_enqueue_revision();
    END IF;
  END $$`);
}
