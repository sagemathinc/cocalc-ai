/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolClient } from "@cocalc/database/pool";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/database/postgres/account-rehome-fence";
import {
  PEOPLE_INVITATION_LIMITS as LIMITS,
  normalizePeopleInvitationPayload,
} from "@cocalc/util/people-invitations";
import type {
  PeopleInvitationDraft,
  PeopleInvitationReview,
  PeopleInvitationOperation,
  PeopleInvitationPreflight,
  PeopleInvitationPayload,
  SendPeopleInvitationInput,
} from "@cocalc/util/people-invitations";

export interface InvitationCodec {
  seal(value: unknown): Promise<string>;
  open<T>(value: string): Promise<T>;
}

function sessionBinding(session: string): string {
  return createHash("sha256")
    .update("people-invitation-review:v1\0")
    .update(session)
    .digest("hex");
}

/** All authored/contact-bearing data is encrypted; relational keys contain no email. */
export class PeopleInvitationStore {
  constructor(
    private pool: Pool,
    private codec: InvitationCodec,
  ) {}
  private schema?: Promise<void>;

  async ensureSchema() {
    if (!this.schema)
      this.schema = this.installSchema().catch((error) => {
        this.schema = undefined;
        throw error;
      });
    return this.schema;
  }
  private async installSchema() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS people_invitation_drafts (
      account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      draft_id UUID NOT NULL, revision INTEGER NOT NULL, ciphertext TEXT NOT NULL,
      expires_at BIGINT NOT NULL, review_id UUID, review_session TEXT,
      review_expires_at BIGINT, operation_id UUID,
      PRIMARY KEY(account_id,draft_id)
    )`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS people_invitation_operations (
      account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      operation_id UUID NOT NULL, draft_id UUID NOT NULL, revision INTEGER NOT NULL,
      review_id UUID NOT NULL, ciphertext TEXT NOT NULL,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      pending BOOLEAN NOT NULL DEFAULT true, lease_id UUID, lease_until BIGINT NOT NULL DEFAULT 0,
      next_attempt_at BIGINT NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id,operation_id), UNIQUE(account_id,draft_id,revision)
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS people_invitation_work
      ON people_invitation_operations(next_attempt_at,lease_until) WHERE pending`);
  }

  private async transaction<T>(
    account_id: string,
    fn: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await assertAccountNotRehoming({
        db,
        account_id,
        action: "manage invitations",
      });
      await assertAccountWriteOnHomeBay({
        db,
        account_id,
        action: "manage invitations",
      });
      const row = await db.query(
        "SELECT account_id FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE FOR UPDATE",
        [account_id],
      );
      if (!row.rows.length) throw Error("invitation owner unavailable");
      const value = await fn(db);
      await db.query("COMMIT");
      return value;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async prepare(
    account_id: string,
    draft_id: string,
    expected_revision: number,
    payload: PeopleInvitationPayload,
    preflight: PeopleInvitationPreflight[],
  ): Promise<PeopleInvitationDraft> {
    return this.transaction(account_id, async (db) => {
      const now = Date.now();
      const row = (
        await db.query(
          "SELECT * FROM people_invitation_drafts WHERE account_id=$1 AND draft_id=$2 FOR UPDATE",
          [account_id, draft_id],
        )
      ).rows[0];
      if (row?.operation_id) throw Error("invitation draft already sent");
      if (row) {
        const old = await this.codec.open<PeopleInvitationDraft>(
          row.ciphertext,
        );
        // A lost response to the immediately preceding revision is retryable.
        if (
          old.revision === expected_revision + 1 &&
          old.expires_at > now &&
          JSON.stringify(normalizePeopleInvitationPayload(old.payload)) ===
            JSON.stringify(payload)
        )
          return old;
        if (old.revision !== expected_revision || old.expires_at <= now)
          throw Error("invitation draft revision changed or expired");
      } else if (expected_revision !== 0)
        throw Error("invitation draft not found");
      if (!row) {
        await db.query(
          "DELETE FROM people_invitation_drafts WHERE account_id=$1 AND expires_at<$2 AND operation_id IS NULL",
          [account_id, now],
        );
        const count = (
          await db.query(
            "SELECT count(*)::int AS n FROM people_invitation_drafts WHERE account_id=$1 AND operation_id IS NULL",
            [account_id],
          )
        ).rows[0].n;
        if (count >= LIMITS.pending_drafts)
          throw Error("too many invitation drafts");
      }
      const draft: PeopleInvitationDraft = {
        account_id,
        draft_id,
        revision: expected_revision + 1,
        payload,
        preflight,
        created_at: now,
        expires_at: now + LIMITS.draft_ttl_ms,
      };
      await db.query(
        `INSERT INTO people_invitation_drafts(account_id,draft_id,revision,ciphertext,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,draft_id) DO UPDATE SET
        revision=$3,ciphertext=$4,expires_at=$5,review_id=NULL,review_session=NULL,review_expires_at=NULL`,
        [
          account_id,
          draft_id,
          draft.revision,
          await this.codec.seal(draft),
          draft.expires_at,
        ],
      );
      return draft;
    });
  }

  async draft(
    account_id: string,
    draft_id: string,
  ): Promise<PeopleInvitationDraft> {
    const row = (
      await this.pool.query(
        "SELECT ciphertext FROM people_invitation_drafts WHERE account_id=$1 AND draft_id=$2",
        [account_id, draft_id],
      )
    ).rows[0];
    if (!row) throw Error("invitation draft not found");
    return this.codec.open(row.ciphertext);
  }

  async review(
    account_id: string,
    draft_id: string,
    revision: number,
    session: string,
    authorize: (draft: PeopleInvitationDraft) => Promise<void>,
  ): Promise<PeopleInvitationReview> {
    const current = await this.draft(account_id, draft_id);
    if (current.revision !== revision || current.expires_at <= Date.now())
      throw Error("invitation review required");
    await authorize(current);
    return this.transaction(account_id, async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM people_invitation_drafts WHERE account_id=$1 AND draft_id=$2 FOR UPDATE",
          [account_id, draft_id],
        )
      ).rows[0];
      if (
        !row ||
        row.revision !== revision ||
        row.operation_id ||
        Number(row.expires_at) <= Date.now()
      )
        throw Error("invitation review required");
      const draft = await this.codec.open<PeopleInvitationDraft>(
        row.ciphertext,
      );
      const review: PeopleInvitationReview = {
        review_id: randomUUID(),
        draft,
        expires_at: Math.min(
          draft.expires_at,
          Date.now() + LIMITS.review_ttl_ms,
        ),
      };
      await db.query(
        "UPDATE people_invitation_drafts SET review_id=$3,review_session=$4,review_expires_at=$5 WHERE account_id=$1 AND draft_id=$2",
        [
          account_id,
          draft_id,
          review.review_id,
          sessionBinding(session),
          review.expires_at,
        ],
      );
      return review;
    });
  }

  async admit(
    account_id: string,
    input: SendPeopleInvitationInput,
    session: string,
  ): Promise<PeopleInvitationOperation> {
    return this.transaction(account_id, async (db) => {
      const previous = (
        await db.query(
          "SELECT * FROM people_invitation_operations WHERE account_id=$1 AND operation_id=$2",
          [account_id, input.idempotency_key],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.draft_id !== input.draft_id ||
          previous.revision !== input.revision ||
          previous.review_id !== input.review_id
        )
          throw Error("invitation idempotency key already used");
        return this.codec.open(previous.ciphertext);
      }
      const row = (
        await db.query(
          "SELECT * FROM people_invitation_drafts WHERE account_id=$1 AND draft_id=$2 FOR UPDATE",
          [account_id, input.draft_id],
        )
      ).rows[0];
      const now = Date.now();
      if (
        !row ||
        row.revision !== input.revision ||
        row.review_id !== input.review_id ||
        row.review_session !== sessionBinding(session) ||
        Number(row.review_expires_at) <= now ||
        Number(row.expires_at) <= now ||
        row.operation_id
      )
        throw Error("invitation review required");
      await db.query(
        `DELETE FROM people_invitation_drafts WHERE account_id=$1 AND operation_id IN
        (SELECT operation_id FROM people_invitation_operations WHERE account_id=$1 AND NOT pending AND updated_at<$2 ORDER BY updated_at LIMIT 100)`,
        [account_id, now - LIMITS.history_retention_ms],
      );
      await db.query(
        `DELETE FROM people_invitation_operations WHERE account_id=$1 AND operation_id IN
        (SELECT operation_id FROM people_invitation_operations WHERE account_id=$1 AND NOT pending AND updated_at<$2 ORDER BY updated_at LIMIT 100)`,
        [account_id, now - LIMITS.history_retention_ms],
      );
      const counts = (
        await db.query(
          `SELECT count(*)::int AS retained,
        count(*) FILTER(WHERE created_at>$2)::int AS recent FROM people_invitation_operations WHERE account_id=$1`,
          [account_id, now - 3600000],
        )
      ).rows[0];
      if (
        counts.retained >= LIMITS.retained_operations ||
        counts.recent >= LIMITS.sends_per_hour
      )
        throw Error("invitation send limit reached");
      const draft = await this.codec.open<PeopleInvitationDraft>(
        row.ciphertext,
      );
      const operation: PeopleInvitationOperation = {
        operation_id: input.idempotency_key,
        account_id,
        draft_id: draft.draft_id,
        revision: draft.revision,
        payload: draft.payload,
        status: "admitted",
        created_at: now,
        updated_at: now,
        source_version: 1,
        authorization_expires_at: Number(row.review_expires_at),
        outcomes: draft.payload.projects.map((p) => ({
          project_id: p.project_id,
          action: p.action,
          child_operation_id: randomUUID(),
          status: "pending",
          delivery: [],
        })),
      };
      // This row is both the immutable send intent and its durable work queue entry.
      await db.query(
        `INSERT INTO people_invitation_operations(account_id,operation_id,draft_id,revision,review_id,ciphertext,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
        [
          account_id,
          operation.operation_id,
          draft.draft_id,
          draft.revision,
          input.review_id,
          await this.codec.seal(operation),
          now,
        ],
      );
      await db.query(
        "UPDATE people_invitation_drafts SET operation_id=$3 WHERE account_id=$1 AND draft_id=$2",
        [account_id, draft.draft_id, operation.operation_id],
      );
      return operation;
    });
  }

  async operation(
    account_id: string,
    operation_id: string,
  ): Promise<PeopleInvitationOperation> {
    const row = (
      await this.pool.query(
        "SELECT ciphertext FROM people_invitation_operations WHERE account_id=$1 AND operation_id=$2",
        [account_id, operation_id],
      )
    ).rows[0];
    if (!row) throw Error("invitation operation not found");
    return this.codec.open(row.ciphertext);
  }

  async claim(
    account_id: string,
    operation_id: string,
  ): Promise<
    { operation: PeopleInvitationOperation; lease_id: string } | undefined
  > {
    return this.transaction(account_id, async (db) => {
      const lease_id = randomUUID();
      const now = Date.now();
      const row = (
        await db.query(
          `UPDATE people_invitation_operations SET lease_id=$3,lease_until=$4,attempts=attempts+1
        WHERE account_id=$1 AND operation_id=$2 AND pending AND lease_until<$5 AND next_attempt_at<=$5 RETURNING ciphertext`,
          [account_id, operation_id, lease_id, now + 60000, now],
        )
      ).rows[0];
      return row
        ? {
            operation: await this.codec.open<PeopleInvitationOperation>(
              row.ciphertext,
            ),
            lease_id,
          }
        : undefined;
    });
  }

  async save(
    operation: PeopleInvitationOperation,
    lease_id: string,
    finish: boolean,
    retry = false,
    receipt?: (
      db: PoolClient,
      operation: PeopleInvitationOperation,
    ) => Promise<void>,
  ): Promise<void> {
    const saved = structuredClone(operation);
    await this.transaction(operation.account_id, async (db) => {
      const locked = await db.query(
        "SELECT 1 FROM people_invitation_operations WHERE account_id=$1 AND operation_id=$2 AND lease_id=$3 FOR UPDATE",
        [operation.account_id, operation.operation_id, lease_id],
      );
      if (!locked.rows.length)
        throw Error("invitation worker lease superseded");
      if (receipt) await receipt(db, saved);
      saved.updated_at = Date.now();
      saved.source_version++;
      const result = await db.query(
        `UPDATE people_invitation_operations SET ciphertext=$4,updated_at=$5,
        pending=$6,lease_until=$7,next_attempt_at=$8 WHERE account_id=$1 AND operation_id=$2 AND lease_id=$3`,
        [
          operation.account_id,
          operation.operation_id,
          lease_id,
          await this.codec.seal(saved),
          saved.updated_at,
          !finish || retry,
          finish ? 0 : Date.now() + 60000,
          retry ? Date.now() + 30000 : 0,
        ],
      );
      if (!result.rowCount) throw Error("invitation worker lease superseded");
    });
    // Do not retain callback-mutated receipts after a rolled-back notification write.
    Object.assign(operation, saved);
  }

  async pending(
    limit = 8,
  ): Promise<{ account_id: string; operation_id: string }[]> {
    return (
      await this.pool.query(
        `SELECT account_id,operation_id FROM people_invitation_operations
      WHERE pending AND lease_until<$1 AND next_attempt_at<=$1 ORDER BY next_attempt_at,created_at LIMIT $2`,
        [Date.now(), Math.min(limit, 8)],
      )
    ).rows;
  }
}
