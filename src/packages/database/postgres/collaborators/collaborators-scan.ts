/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import { assertCollaborationAccountAuthority } from "./collaborators-owner";
import type { CollaborationOwnerAuthority } from "./collaborators-owner";
import { transaction, uuid } from "./collaborators-common";

const RETENTION_MS = 7 * 86400000;
const COOLDOWN_MS = 300000;
// Seven days at one admission/minute, plus the initial burst and headroom.
const MAX_RECEIPTS = 11000;
const TOKEN_INTERVAL_MS = 60000;
export interface ScanAdmissionRequest {
  project_id: string;
  /** Authenticated actor, supplied by the future owner service, not public input. */
  account_id: string;
  request_id: string;
  mode: "check" | "reconcile";
}
export interface ScanReceipt {
  job_id: string;
  admission: "accepted" | "coalesced";
  expires_at: number;
}

/** Explicit prototype installation only. These receipts are not rebuildable
 * view caches; movement must remain guarded until their transfer is supported.
 */
export async function syncCollaborationScanSchema(
  db: Pick<PoolClient, "query">,
) {
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_scan_jobs (
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK(slot IN (0,1)), job_id UUID NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('queued','running')),
    created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(project_id,slot))`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_scan_jobs_due
    ON collaboration_scan_jobs(state,created_at,project_id)`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS collaboration_scan_jobs_state
    ON collaboration_scan_jobs(project_id,state)`);
  await db.query(`ALTER TABLE collaboration_scan_jobs
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_scan_budget (
    project_id UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
    tokens DOUBLE PRECISION NOT NULL CHECK(tokens>=0 AND tokens<=2),
    updated_at TIMESTAMPTZ NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_scan_receipts (
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    account_id UUID NOT NULL, request_id UUID NOT NULL, mode TEXT NOT NULL,
    receipt JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(project_id,account_id,request_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_scan_receipts_expiry
    ON collaboration_scan_receipts(expires_at,project_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_scan_receipts_project_expiry
    ON collaboration_scan_receipts(project_id,expires_at)`);
}

/** No host RPC or filesystem work in this transaction. The owner project lock
 * serializes admission, retries and queued-job coalescing across all actors.
 * Public actor/bay/global admission budgets must precede this prototype store.
 */
export async function admitCollaborationScan(
  opts: ScanAdmissionRequest,
  authority: CollaborationOwnerAuthority,
): Promise<ScanReceipt | { admission: "throttled"; retry_after_ms: number }> {
  uuid(opts.project_id, "scan project");
  uuid(opts.account_id, "scan account");
  uuid(opts.request_id, "scan request");
  if (opts.mode !== "check" && opts.mode !== "reconcile")
    throw Error("invalid scan mode");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const now = (
      await db.query("SELECT clock_timestamp() AS now")
    ).rows[0].now.getTime();
    const prior = (
      await db.query(
        `SELECT mode,receipt,expires_at FROM collaboration_scan_receipts
      WHERE project_id=$1 AND account_id=$2 AND request_id=$3`,
        [opts.project_id, opts.account_id, opts.request_id],
      )
    ).rows[0];
    if (prior) {
      if (prior.mode !== opts.mode)
        throw Error("scan request id reused with different arguments");
      if (prior.expires_at.getTime() <= now)
        throw Error("scan receipt expired; request status is unknown");
      return prior.receipt as ScanReceipt;
    }
    const jobs = (
      await db.query(
        "SELECT * FROM collaboration_scan_jobs WHERE project_id=$1 ORDER BY slot",
        [opts.project_id],
      )
    ).rows;
    let job = jobs.find((row) => row.state === "queued");
    if (!job && jobs.length) {
      // Raw generation equality is not a validated no-change proof: checks
      // currently require the same conservative work/cooldown as reconciliation.
      const remaining =
        (jobs[0].started_at ?? jobs[0].created_at).getTime() +
        COOLDOWN_MS -
        now;
      if (remaining > 0)
        return { admission: "throttled" as const, retry_after_ms: remaining };
    }
    // The project row is already locked. All actors share this bucket, and a
    // replay returns above without spending a token. Failed transactions do
    // not consume capacity. Actor-wide budgets belong at account home.
    const budget = (
      await db.query(
        "SELECT tokens,updated_at FROM collaboration_scan_budget WHERE project_id=$1",
        [opts.project_id],
      )
    ).rows[0];
    const tokens = budget
      ? Math.min(
          2,
          budget.tokens +
            Math.max(0, now - budget.updated_at.getTime()) / TOKEN_INTERVAL_MS,
        )
      : 2;
    if (tokens < 1)
      return {
        admission: "throttled" as const,
        retry_after_ms: Math.ceil(
          (1 - tokens) * TOKEN_INTERVAL_MS +
            Math.max(0, (budget?.updated_at.getTime() ?? now) - now),
        ),
      };
    // Opportunistic, bounded retention work only on a new budget-eligible
    // request. Cold projects incur no polling; retries never erase their own
    // receipt. After seven days request IDs no longer promise deduplication.
    await db.query(
      `DELETE FROM collaboration_scan_receipts r USING (
        SELECT project_id,account_id,request_id FROM collaboration_scan_receipts
        WHERE project_id=$1 AND expires_at<=$2
        ORDER BY expires_at LIMIT 64
      ) expired WHERE r.project_id=expired.project_id
        AND r.account_id=expired.account_id AND r.request_id=expired.request_id`,
      [opts.project_id, new Date(now)],
    );
    const count = (
      await db.query(
        "SELECT count(*)::integer AS n FROM collaboration_scan_receipts WHERE project_id=$1",
        [opts.project_id],
      )
    ).rows[0].n;
    if (count >= MAX_RECEIPTS) throw Error("scan receipt capacity reached");
    await db.query(
      `INSERT INTO collaboration_scan_budget(project_id,tokens,updated_at) VALUES($1,$2,$3)
      ON CONFLICT(project_id) DO UPDATE SET tokens=EXCLUDED.tokens,updated_at=EXCLUDED.updated_at`,
      [
        opts.project_id,
        tokens - 1,
        new Date(Math.max(now, budget?.updated_at.getTime() ?? now)),
      ],
    );
    const admission = job ? "coalesced" : "accepted";
    if (!job) {
      const slot = jobs.length ? 1 : 0;
      job = (
        await db.query(
          "INSERT INTO collaboration_scan_jobs(project_id,slot,job_id,state,created_at) VALUES($1,$2,$3,'queued',$4) RETURNING *",
          [opts.project_id, slot, randomUUID(), new Date(now)],
        )
      ).rows[0];
    }
    const receipt: ScanReceipt = {
      job_id: job.job_id,
      admission,
      expires_at: now + RETENTION_MS,
    };
    await db.query(
      "INSERT INTO collaboration_scan_receipts(project_id,account_id,request_id,mode,receipt,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [
        opts.project_id,
        opts.account_id,
        opts.request_id,
        opts.mode,
        JSON.stringify(receipt),
        new Date(receipt.expires_at),
      ],
    );
    return receipt;
  });
}

/** Inspection never admits work; even receipt replay requires current access. */
export async function inspectCollaborationScan(
  opts: Omit<ScanAdmissionRequest, "mode">,
  authority: CollaborationOwnerAuthority,
) {
  uuid(opts.request_id, "scan request");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const { rows } = await db.query(
      `SELECT receipt FROM collaboration_scan_receipts WHERE project_id=$1 AND account_id=$2
      AND request_id=$3 AND expires_at>clock_timestamp()`,
      [opts.project_id, opts.account_id, opts.request_id],
    );
    return (rows[0]?.receipt as ScanReceipt | undefined) ?? null;
  });
}

/** Internal owner dispatch preparation only. Commit the boundary before any
 * host request; retry with the same job ID after an ambiguous transport result.
 * This is not a worker lease or permission to launch work on an arbitrary host.
 */
export async function startCollaborationScan(
  opts: Omit<ScanAdmissionRequest, "mode"> & { job_id: string },
  authority: CollaborationOwnerAuthority,
): Promise<{ job_id: string; started_at: number; replayed: boolean } | null> {
  uuid(opts.request_id, "scan request");
  uuid(opts.job_id, "scan job");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const { rows } = await db.query(
      `SELECT j.job_id,j.state,j.started_at FROM collaboration_scan_jobs j
      JOIN collaboration_scan_receipts r ON r.project_id=j.project_id
      AND r.receipt->>'job_id'=j.job_id::text
      WHERE j.project_id=$1 AND j.job_id=$2 AND r.account_id=$3
      AND r.request_id=$4 AND r.expires_at>clock_timestamp()`,
      [opts.project_id, opts.job_id, opts.account_id, opts.request_id],
    );
    const job = rows[0];
    if (!job) return null;
    if (job.state === "running") {
      if (!job.started_at) throw Error("scan execution boundary missing");
      return {
        job_id: job.job_id,
        started_at: job.started_at.getTime(),
        replayed: true,
      };
    }
    const running = await db.query(
      "SELECT 1 FROM collaboration_scan_jobs WHERE project_id=$1 AND state='running'",
      [opts.project_id],
    );
    if (running.rows.length) return null;
    const result = await db.query(
      `UPDATE collaboration_scan_jobs SET state='running',started_at=clock_timestamp()
      WHERE project_id=$1 AND job_id=$2 AND state='queued' RETURNING started_at`,
      [opts.project_id, opts.job_id],
    );
    return {
      job_id: job.job_id,
      started_at: result.rows[0].started_at.getTime(),
      replayed: false,
    };
  });
}
