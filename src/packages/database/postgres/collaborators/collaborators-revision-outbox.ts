/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import { randomUUID } from "node:crypto";
import { transaction, uuid, boundedText } from "./collaborators-common";
import { assertCollaborationOwnerAuthority } from "./collaborators-owner";
import type { CollaborationOwnerAuthority } from "./collaborators-owner";

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
  await db.query(`ALTER TABLE collaboration_revision_outbox
    ADD COLUMN IF NOT EXISTS claim_id UUID,
    ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ`);
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
        due_at=LEAST(collaboration_revision_outbox.due_at,excluded.due_at),after_home_bay=NULL,
        claim_id=NULL,claim_until=NULL;
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

export interface RevisionOutboxClaim {
  project_id: string;
  token: string;
  claim_id: string;
  generation: string;
  revision: string;
  after_home_bay: string | null;
}

/** Internal scheduling primitive; callers resolve current ownership first.
 * Unknown delivery outcomes retain the claim until its bounded retry deadline.
 */
export async function claimCollaborationRevisionOutbox(
  project_id: string,
  authority: CollaborationOwnerAuthority,
): Promise<RevisionOutboxClaim | null> {
  uuid(project_id, "outbox project");
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    await assertCollaborationOwnerAuthority(db, project_id, authority);
    const { rows } = await db.query(
      `UPDATE collaboration_revision_outbox
       SET claim_id=$2,claim_until=clock_timestamp()+interval '30 seconds',
         due_at=clock_timestamp()+interval '30 seconds'
       WHERE project_id=$1 AND due_at<=clock_timestamp()
         AND (claim_until IS NULL OR claim_until<=clock_timestamp())
       RETURNING project_id,token,claim_id,generation,revision::text,after_home_bay`,
      [project_id, randomUUID()],
    );
    return rows[0] ?? null;
  });
}

/** Advance only after a bounded recipient page has been durably handled.
 * null means traversal completed, not that recipient projections are current.
 */
export async function settleCollaborationRevisionOutbox(
  claim: RevisionOutboxClaim,
  after_home_bay: string | null,
  authority: CollaborationOwnerAuthority,
): Promise<boolean> {
  uuid(claim.project_id, "outbox project");
  uuid(claim.token, "outbox token");
  uuid(claim.claim_id, "outbox claim");
  if (after_home_bay !== null)
    boundedText(after_home_bay, "outbox home cursor", 128);
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    await assertCollaborationOwnerAuthority(db, claim.project_id, authority);
    const where = `project_id=$1 AND token=$2 AND claim_id=$3
      AND claim_until>clock_timestamp()`;
    const params = [claim.project_id, claim.token, claim.claim_id];
    const { rows } =
      after_home_bay === null
        ? await db.query(
            `DELETE FROM collaboration_revision_outbox WHERE ${where} RETURNING project_id`,
            params,
          )
        : await db.query(
            `UPDATE collaboration_revision_outbox
          SET after_home_bay=$4,claim_id=NULL,claim_until=NULL,due_at=clock_timestamp()
          WHERE ${where} AND (after_home_bay IS NULL OR after_home_bay<$4)
          RETURNING project_id`,
            [...params, after_home_bay],
          );
    return rows.length === 1;
  });
}
