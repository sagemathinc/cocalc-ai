/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import {
  assertCollaborationAccountAuthority,
  assertCollaborationWriterAuthority,
} from "./collaborators-owner";
import type { CollaborationWriterAuthority } from "./collaborators-owner";
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
export type ScanDiscoveryStatus =
  | { state: "unknown" }
  | { state: "queued" }
  | { state: "running"; started_at: number }
  | { state: "discovered" | "failed"; settled_at: number };

/** Read-only internal status. Requires a current member's own live receipt,
 * rather than disclosing another requester's retained job by UUID alone.
 * No host calls, new work, token charging, or retention cleanup.
 */
export async function readCollaborationScanStatus(
  opts: { project_id: string; account_id: string; job_id: string },
  authority: CollaborationOwnerAuthority,
): Promise<ScanDiscoveryStatus> {
  uuid(opts.job_id, "scan job");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const row = (
      await db.query(
        `SELECT r.result,j.state,j.started_at,j.host_id,p.host_id AS current_host
      FROM collaboration_scan_receipts r
      JOIN projects p ON p.project_id=r.project_id
      LEFT JOIN collaboration_scan_jobs j ON j.project_id=r.project_id
        AND j.job_id::text=r.receipt->>'job_id'
      WHERE r.project_id=$1 AND r.account_id=$2 AND r.receipt->>'job_id'=$3
        AND r.expires_at>clock_timestamp() LIMIT 1`,
        [opts.project_id, opts.account_id, opts.job_id],
      )
    ).rows[0];
    if (!row) return { state: "unknown" };
    if (row.result?.state === "discovered" || row.result?.state === "failed") {
      return {
        state: row.result.state,
        settled_at: new Date(row.result.settled_at).getTime(),
      };
    }
    if (row.state === "queued") return { state: "queued" };
    if (
      row.state === "running" &&
      row.started_at &&
      row.host_id === row.current_host
    ) {
      return { state: "running", started_at: row.started_at.getTime() };
    }
    return { state: "unknown" };
  });
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
  await db.query(`ALTER TABLE collaboration_scan_jobs
    ADD COLUMN IF NOT EXISTS host_id UUID`);
  await db.query(
    `ALTER TABLE collaboration_scan_jobs ADD COLUMN IF NOT EXISTS expected_run_id UUID`,
  );
  await db.query(`ALTER TABLE collaboration_scan_jobs
    ADD COLUMN IF NOT EXISTS dispatch_token UUID,
    ADD COLUMN IF NOT EXISTS dispatch_until TIMESTAMPTZ`);
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_scan_budget (
    project_id UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
    tokens DOUBLE PRECISION NOT NULL CHECK(tokens>=0 AND tokens<=2),
    updated_at TIMESTAMPTZ NOT NULL)`);
  await db.query(`ALTER TABLE collaboration_scan_budget
    ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ`);
  await db.query(
    `ALTER TABLE collaboration_scan_budget ADD COLUMN IF NOT EXISTS last_job_id UUID`,
  );
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_scan_receipts (
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    account_id UUID NOT NULL, request_id UUID NOT NULL, mode TEXT NOT NULL,
    receipt JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(project_id,account_id,request_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_scan_receipts_expiry
    ON collaboration_scan_receipts(expires_at,project_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_scan_receipts_project_expiry
    ON collaboration_scan_receipts(project_id,expires_at)`);
  await db.query(`ALTER TABLE collaboration_scan_receipts
    ADD COLUMN IF NOT EXISTS result JSONB`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_scan_receipts_job
    ON collaboration_scan_receipts(project_id,(receipt->>'job_id'))`);
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
      const slot = jobs.some((row) => row.slot === 0) ? 1 : 0;
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
): Promise<{
  job_id: string;
  started_at: number;
  replayed: boolean;
  host_id: string;
  expected_run_id?: string;
} | null> {
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
      `SELECT j.job_id,j.state,j.started_at,j.host_id,j.expected_run_id FROM collaboration_scan_jobs j
      JOIN collaboration_scan_receipts r ON r.project_id=j.project_id
      AND r.receipt->>'job_id'=j.job_id::text
      WHERE j.project_id=$1 AND j.job_id=$2 AND r.account_id=$3
      AND r.request_id=$4 AND r.expires_at>clock_timestamp()`,
      [opts.project_id, opts.job_id, opts.account_id, opts.request_id],
    );
    const job = rows[0];
    if (!job) return null;
    const host = (
      await db.query("SELECT host_id FROM projects WHERE project_id=$1", [
        opts.project_id,
      ])
    ).rows[0].host_id;
    if (!host) return null;
    if (job.state === "running") {
      if (job.host_id !== host)
        throw Error("scan host changed; recovery required");
      if (!job.started_at) throw Error("scan execution boundary missing");
      return {
        job_id: job.job_id,
        started_at: job.started_at.getTime(),
        replayed: true,
        host_id: host,
        expected_run_id: job.expected_run_id ?? undefined,
      };
    }
    const running = await db.query(
      "SELECT 1 FROM collaboration_scan_jobs WHERE project_id=$1 AND state='running'",
      [opts.project_id],
    );
    if (running.rows.length) return null;
    // Admission may queue a newer boundary immediately. Execution cooldown
    // survives removal of completed active jobs and cannot be reset by callers.
    // Until a no-change proof exists, check and reconcile both spend this work.
    const clock = (
      await db.query(
        `SELECT clock_timestamp() AS now,last_started_at,last_job_id FROM collaboration_scan_budget
      WHERE project_id=$1`,
        [opts.project_id],
      )
    ).rows[0];
    if (!clock) throw Error("scan admission budget missing");
    if (
      clock.last_started_at &&
      clock.last_started_at.getTime() + COOLDOWN_MS > clock.now.getTime()
    )
      return null;
    const result = await db.query(
      `UPDATE collaboration_scan_jobs SET state='running',started_at=$3,host_id=$4,expected_run_id=$5
      WHERE project_id=$1 AND job_id=$2 AND state='queued' RETURNING started_at`,
      [opts.project_id, opts.job_id, clock.now, host, clock.last_job_id],
    );
    await db.query(
      "UPDATE collaboration_scan_budget SET last_started_at=$2,last_job_id=$3 WHERE project_id=$1",
      [opts.project_id, clock.now, opts.job_id],
    );
    return {
      job_id: job.job_id,
      started_at: result.rows[0].started_at.getTime(),
      replayed: false,
      host_id: host,
      expected_run_id: clock.last_job_id ?? undefined,
    };
  });
}

/** Host discovery is not owner ingestion or view freshness. Only internal
 * authenticated host reports may settle active discovery; never a public input.
 */
export async function settleCollaborationScanDiscovery(
  opts: { project_id: string; job_id: string; state: "discovered" | "failed" },
  authority: CollaborationWriterAuthority,
): Promise<boolean> {
  uuid(opts.job_id, "scan job");
  if (opts.state !== "discovered" && opts.state !== "failed")
    throw Error("invalid discovery result");
  return transaction(async (db) => {
    await assertCollaborationWriterAuthority(db, opts.project_id, authority);
    const job = (
      await db.query(
        "SELECT state,host_id FROM collaboration_scan_jobs WHERE project_id=$1 AND job_id=$2",
        [opts.project_id, opts.job_id],
      )
    ).rows[0];
    if (!job) {
      const prior = (
        await db.query(
          `SELECT result FROM collaboration_scan_receipts
        WHERE project_id=$1 AND receipt->>'job_id'=$2 AND expires_at>clock_timestamp() LIMIT 1`,
          [opts.project_id, opts.job_id],
        )
      ).rows[0]?.result;
      return (
        prior?.state === opts.state && prior?.host_id === authority.host_id
      );
    }
    if (job.state !== "running" || job.host_id !== authority.host_id)
      return false;
    await db.query(
      `UPDATE collaboration_scan_receipts SET result=jsonb_build_object(
      'state',$3::text,'host_id',$4::text,'settled_at',clock_timestamp())
      WHERE project_id=$1 AND receipt->>'job_id'=$2`,
      [opts.project_id, opts.job_id, opts.state, authority.host_id],
    );
    await db.query(
      "DELETE FROM collaboration_scan_jobs WHERE project_id=$1 AND job_id=$2",
      [opts.project_id, opts.job_id],
    );
    return true;
  });
}

/** A bounded transport lease, not a new host run identity. Expired workers can
 * still have in-flight RPCs; host run-id idempotency remains essential.
 */
export async function claimCollaborationScanDispatch(
  opts: { project_id: string; account_id: string; job_id: string },
  authority: CollaborationOwnerAuthority,
): Promise<string | null> {
  uuid(opts.job_id, "scan job");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const token = randomUUID();
    const result = await db.query(
      `UPDATE collaboration_scan_jobs j
      SET dispatch_token=$4,dispatch_until=clock_timestamp()+interval '90 seconds'
      WHERE project_id=$1 AND job_id=$2 AND state='running'
      AND (dispatch_until IS NULL OR dispatch_until<=clock_timestamp())
      AND EXISTS(SELECT 1 FROM collaboration_scan_receipts r WHERE r.project_id=j.project_id
        AND r.account_id=$3 AND r.receipt->>'job_id'=j.job_id::text AND r.expires_at>clock_timestamp())
      RETURNING job_id`,
      [opts.project_id, opts.job_id, opts.account_id, token],
    );
    return result.rows.length ? token : null;
  });
}

export async function releaseCollaborationScanDispatch(
  opts: {
    project_id: string;
    account_id: string;
    job_id: string;
    token: string;
  },
  authority: CollaborationOwnerAuthority,
) {
  uuid(opts.job_id, "scan job");
  uuid(opts.token, "dispatch token");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    await db.query(
      `UPDATE collaboration_scan_jobs SET dispatch_token=NULL,dispatch_until=NULL
      WHERE project_id=$1 AND job_id=$2 AND dispatch_token=$3`,
      [opts.project_id, opts.job_id, opts.token],
    );
  });
}
