/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "../account-rehome-fence";
import { uuid } from "./collaborators-common";
import type { ScanAdmissionRequest } from "./collaborators-scan";

export async function syncCollaborationScanActorSchema(
  db: Pick<PoolClient, "query">,
) {
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_scan_actor_budget (
    account_id UUID PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
    tokens DOUBLE PRECISION NOT NULL CHECK(tokens>=0 AND tokens<=2),updated_at TIMESTAMPTZ NOT NULL)`);
  await db.query(`ALTER TABLE collaboration_scan_actor_budget
    ADD COLUMN IF NOT EXISTS read_tokens DOUBLE PRECISION NOT NULL DEFAULT 10 CHECK(read_tokens>=0 AND read_tokens<=10),
    ADD COLUMN IF NOT EXISTS read_updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z'`);
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_scan_actor_receipts (
    account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    project_id UUID NOT NULL,request_id UUID NOT NULL,mode TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(account_id,project_id,request_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_scan_actor_expiry
    ON collaboration_scan_actor_receipts(account_id,expires_at)`);
}

/** Account-home polling budget, independent of admission tokens and receipts. */
export async function reserveCollaborationScanRead(account_id: string) {
  uuid(account_id, "scan actor");
  return withAccountRehomeWriteFence({
    account_id: account_id.toLowerCase(),
    action: "inspect scan",
    fn: async (db) => {
      await db.query("SET LOCAL lock_timeout = '1s'");
      await db.query("SET LOCAL statement_timeout = '2s'");
      const account = (
        await db.query(
          "SELECT banned,deleted FROM accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows[0];
      if (!account || account.banned || account.deleted)
        throw Error("scan account unavailable");
      const now = (
        await db.query("SELECT clock_timestamp() AS now")
      ).rows[0].now.getTime();
      const prior = (
        await db.query(
          "SELECT read_tokens,read_updated_at FROM collaboration_scan_actor_budget WHERE account_id=$1",
          [account_id],
        )
      ).rows[0];
      const updated = prior?.read_updated_at.getTime() ?? now;
      const tokens = prior
        ? Math.min(10, prior.read_tokens + Math.max(0, now - updated) / 1000)
        : 10;
      if (tokens < 1)
        return {
          allowed: false as const,
          retry_after_ms: Math.ceil(
            (1 - tokens) * 1000 + Math.max(0, updated - now),
          ),
        };
      await db.query(
        `INSERT INTO collaboration_scan_actor_budget
        (account_id,tokens,updated_at,read_tokens,read_updated_at) VALUES($1,2,$2,$3,$4)
        ON CONFLICT(account_id) DO UPDATE SET
          read_tokens=EXCLUDED.read_tokens,read_updated_at=EXCLUDED.read_updated_at`,
        [
          account_id,
          new Date(now),
          tokens - 1,
          new Date(Math.max(now, updated)),
        ],
      );
      return { allowed: true as const, poll_after_ms: 1000 };
    },
  });
}

/** Internal account-home reservation, never a project access grant. Caller
 * identity must be transport-derived. The owner still authorizes admission.
 * Reservations are charged once even if the owner subsequently rejects work.
 */
export async function reserveCollaborationScanActor(
  opts: ScanAdmissionRequest,
) {
  uuid(opts.account_id, "scan actor");
  uuid(opts.project_id, "scan project");
  uuid(opts.request_id, "scan request");
  if (opts.mode !== "check" && opts.mode !== "reconcile")
    throw Error("invalid scan mode");
  return withAccountRehomeWriteFence({
    account_id: opts.account_id.toLowerCase(),
    action: "reserve scan admission",
    fn: async (db) => {
      const account = (
        await db.query(
          "SELECT banned,deleted FROM accounts WHERE account_id=$1",
          [opts.account_id],
        )
      ).rows[0];
      if (!account || account.banned || account.deleted)
        throw Error("scan account unavailable");
      const now = (
        await db.query("SELECT clock_timestamp() AS now")
      ).rows[0].now.getTime();
      const prior = (
        await db.query(
          "SELECT mode,expires_at FROM collaboration_scan_actor_receipts WHERE account_id=$1 AND project_id=$2 AND request_id=$3",
          [opts.account_id, opts.project_id, opts.request_id],
        )
      ).rows[0];
      if (prior) {
        if (prior.mode !== opts.mode)
          throw Error("scan request id reused with different arguments");
        if (prior.expires_at.getTime() <= now)
          throw Error("scan actor reservation expired");
        return {
          reserved: true as const,
          expires_at: prior.expires_at.getTime(),
        };
      }
      const budget = (
        await db.query(
          "SELECT tokens,updated_at FROM collaboration_scan_actor_budget WHERE account_id=$1",
          [opts.account_id],
        )
      ).rows[0];
      const tokens = budget
        ? Math.min(
            2,
            budget.tokens +
              Math.max(0, now - budget.updated_at.getTime()) / 60000,
          )
        : 2;
      if (tokens < 1)
        return {
          reserved: false as const,
          retry_after_ms: Math.ceil(
            (1 - tokens) * 60000 +
              Math.max(0, (budget?.updated_at.getTime() ?? now) - now),
          ),
        };
      await db.query(
        `DELETE FROM collaboration_scan_actor_receipts r USING (
      SELECT project_id,request_id FROM collaboration_scan_actor_receipts WHERE account_id=$1 AND expires_at<=$2 ORDER BY expires_at LIMIT 64
      ) old WHERE r.account_id=$1 AND r.project_id=old.project_id AND r.request_id=old.request_id`,
        [opts.account_id, new Date(now)],
      );
      const count = (
        await db.query(
          "SELECT count(*)::integer AS n FROM collaboration_scan_actor_receipts WHERE account_id=$1",
          [opts.account_id],
        )
      ).rows[0].n;
      if (count >= 11000) throw Error("scan actor receipt capacity reached");
      await db.query(
        `INSERT INTO collaboration_scan_actor_budget(account_id,tokens,updated_at) VALUES($1,$2,$3)
      ON CONFLICT(account_id) DO UPDATE SET tokens=EXCLUDED.tokens,updated_at=EXCLUDED.updated_at`,
        [
          opts.account_id,
          tokens - 1,
          new Date(Math.max(now, budget?.updated_at.getTime() ?? now)),
        ],
      );
      const expires_at = now + 7 * 86400000;
      await db.query(
        "INSERT INTO collaboration_scan_actor_receipts VALUES($1,$2,$3,$4,$5)",
        [
          opts.account_id,
          opts.project_id,
          opts.request_id,
          opts.mode,
          new Date(expires_at),
        ],
      );
      return { reserved: true as const, expires_at };
    },
  });
}
