/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";

let ready: Promise<void> | undefined;
export async function ensurePeopleSchema() {
  if (!ready)
    ready = installHomeSchema().catch((err) => {
      ready = undefined;
      throw err;
    });
  return ready;
}
async function installHomeSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS people_account_state (
      account_id UUID PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE, revision BIGINT NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS people_contacts (
      account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE, person_id UUID NOT NULL,
      identity_key TEXT NOT NULL, display_label TEXT, email_ciphertext TEXT,
      linked_account_id UUID, link_provenance TEXT,
      archived BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds',now()),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds',now()),
      PRIMARY KEY (account_id,person_id), UNIQUE (account_id,identity_key)
    )`,
    `CREATE TABLE IF NOT EXISTS people_invitation_index (
      account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE, invitation_id UUID NOT NULL, project_id UUID NOT NULL,
      source_bay_id TEXT NOT NULL, source_version BIGINT NOT NULL,
      sender_account_id UUID NOT NULL, recipient_account_id UUID, accepted_account_id UUID,
      person_id UUID, status TEXT NOT NULL, expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL, deleted BOOLEAN NOT NULL DEFAULT false,
      invitation JSONB NOT NULL, PRIMARY KEY(account_id,invitation_id)
    )`,
    `CREATE INDEX IF NOT EXISTS people_invitation_page_idx
      ON people_invitation_index(account_id,created_at DESC,invitation_id DESC) WHERE NOT deleted`,
    `CREATE INDEX IF NOT EXISTS people_invitation_person_idx
      ON people_invitation_index(account_id,person_id,created_at DESC,invitation_id DESC) WHERE NOT deleted`,
    `CREATE INDEX IF NOT EXISTS people_invitation_project_idx
      ON people_invitation_index(account_id,project_id,created_at DESC,invitation_id DESC) WHERE NOT deleted`,
    `CREATE INDEX IF NOT EXISTS people_invitation_notice_idx
      ON people_invitation_index(account_id,(invitation->>'notification_id'))
      WHERE NOT deleted AND invitation->>'kind'='collaboration'`,
    `CREATE TABLE IF NOT EXISTS people_collaboration_outbox (
      account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE, invitation_id UUID NOT NULL, version BIGINT NOT NULL,
      invitation JSONB NOT NULL, delivered_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT now(), lease_until TIMESTAMPTZ,
      PRIMARY KEY(account_id,invitation_id)
    )`,
    `CREATE INDEX IF NOT EXISTS people_collaboration_outbox_due_idx
      ON people_collaboration_outbox(available_at,invitation_id) WHERE delivered_at IS NULL`,
  ];
  for (const sql of statements) await getPool().query(sql);
}

/** Installed after the existing access-invite schema, before its first write.
 * The trigger covers course/bulk/expiry/delete writers without a second source
 * of permission truth. One coalesced retry row per invite bounds queue growth.
 */
export async function ensurePeopleInviteSourceSchema() {
  const db = getPool();
  const statements = [
    `ALTER TABLE project_collab_invites ADD COLUMN IF NOT EXISTS people_version BIGINT NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS people_invite_outbox (
      invitation_id UUID PRIMARY KEY, project_id UUID NOT NULL,
      version BIGINT NOT NULL, payload JSONB NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT false,
      attempts INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_until TIMESTAMPTZ, delivered_at TIMESTAMPTZ
    )`,
    `ALTER TABLE people_invite_outbox ADD COLUMN IF NOT EXISTS audience UUID[] NOT NULL DEFAULT '{}'`,
    `CREATE INDEX IF NOT EXISTS people_invite_outbox_due_idx
      ON people_invite_outbox(available_at,invitation_id) WHERE delivered_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS people_invite_backfill (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), after_id UUID,
      complete BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `INSERT INTO people_invite_backfill(singleton) VALUES(true) ON CONFLICT DO NOTHING`,
    `CREATE OR REPLACE FUNCTION people_capture_access_invite() RETURNS trigger AS $$
    DECLARE r project_collab_invites%ROWTYPE; v BIGINT; p JSONB; targets UUID[];
    BEGIN
      IF TG_OP='DELETE' THEN r := OLD; v := OLD.people_version+1;
      ELSE
        IF TG_OP='INSERT' THEN
          SELECT COALESCE(max(version),0)+1 INTO NEW.people_version FROM people_invite_outbox WHERE invitation_id=NEW.invite_id;
        ELSE NEW.people_version := OLD.people_version+1; END IF;
        r := NEW; v := NEW.people_version;
      END IF;
      targets := ARRAY[r.inviter_account_id,r.invitee_account_id,r.accepted_account_id];
      IF TG_OP='UPDATE' THEN targets := targets || ARRAY[OLD.inviter_account_id,OLD.invitee_account_id,OLD.accepted_account_id]; END IF;
      PERFORM pg_advisory_xact_lock(hashtext('project-rehome'),hashtext(r.project_id::text));
      IF to_regclass('public.project_rehome_operations') IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM project_rehome_operations WHERE project_id=r.project_id AND status='running') THEN
          RAISE EXCEPTION 'people invitation write blocked by project rehome';
        END IF;
      END IF;
      p := jsonb_build_object(
        'invitation_id',r.invite_id,'kind','access','project_id',r.project_id,
        'sender_account_id',r.inviter_account_id,'recipient_account_id',r.invitee_account_id,
        'accepted_account_id',r.accepted_account_id,'status',r.status,
        'role',COALESCE(r.invite_role,'collaborator'),'read_policy',r.read_policy,
        'message',left(r.message,4096),'invite_source',COALESCE(r.invite_source,'account'),
        'scope',r.scope,'created_at',r.created,'updated_at',r.updated,
        'expires_at',r.created + CASE WHEN r.invite_source IN ('email','course_email') THEN interval '14 days' ELSE interval '30 days' END,
        'responded_at',r.responded,'last_sent_at',r.last_sent,'resend_count',COALESCE(r.resend_count,0),
        'email_ciphertext',r.email_ciphertext);
      IF TG_OP='DELETE' THEN p := p - 'email_ciphertext' - 'message' - 'read_policy'; END IF;
      INSERT INTO people_invite_outbox(invitation_id,project_id,version,payload,deleted,audience)
        VALUES(r.invite_id,r.project_id,v,p,TG_OP='DELETE',array_remove(targets,NULL))
        ON CONFLICT(invitation_id) DO UPDATE SET version=EXCLUDED.version,
          payload=EXCLUDED.payload, deleted=EXCLUDED.deleted, attempts=0,
          audience=ARRAY(SELECT DISTINCT unnest(people_invite_outbox.audience || EXCLUDED.audience)),
          available_at=now(),lease_until=NULL,delivered_at=NULL;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END; $$ LANGUAGE plpgsql`,
    `DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='people_capture_access_invite' AND tgrelid='project_collab_invites'::regclass) THEN
        CREATE TRIGGER people_capture_access_invite BEFORE INSERT OR UPDATE OR DELETE ON project_collab_invites
          FOR EACH ROW EXECUTE FUNCTION people_capture_access_invite();
      END IF;
    END $$`,
  ];
  for (const sql of statements) await db.query(sql);
}

export type PeopleDb = {
  query(
    sql: string,
    values?: any[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
};
export async function bumpPeopleRevision(db: PeopleDb, account_id: string) {
  await db.query(
    `INSERT INTO people_account_state(account_id,revision) VALUES($1,1)
    ON CONFLICT(account_id) DO UPDATE SET revision=people_account_state.revision+1`,
    [account_id],
  );
}
export async function peopleRevision(
  db: PeopleDb,
  account_id: string,
): Promise<string> {
  return (
    (
      await db.query(
        "SELECT revision::text FROM people_account_state WHERE account_id=$1",
        [account_id],
      )
    ).rows[0]?.revision ?? "0"
  );
}
