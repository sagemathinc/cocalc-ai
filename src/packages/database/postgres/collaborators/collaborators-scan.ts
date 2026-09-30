/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import {
  assertCollaborationAccountAuthority,
  assertCollaborationOwnerAuthority,
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

async function boundScanMaintenanceQueries(db: PoolClient) {
  await db.query("SET LOCAL lock_timeout = '1s'");
  await db.query("SET LOCAL statement_timeout = '2s'");
}

/** Retire only unstarted work with no live admission receipts. The project lock
 * serializes this with coalescing and start; running work needs host recovery,
 * not an inference from expired receipts. Retry history is retained unchanged.
 */
export async function retireExpiredQueuedCollaborationScan(
  opts: { project_id: string; job_id: string },
  authority: CollaborationOwnerAuthority,
): Promise<boolean> {
  uuid(opts.job_id, "scan job");
  return transaction(async (db) => {
    await boundScanMaintenanceQueries(db);
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const { rows } = await db.query(
      `DELETE FROM collaboration_scan_jobs j
       WHERE j.project_id=$1 AND j.job_id=$2 AND j.state='queued'
       AND NOT EXISTS (
         WITH receipts AS MATERIALIZED (
           SELECT expires_at FROM collaboration_scan_receipts r
           WHERE r.project_id=j.project_id AND r.receipt->>'job_id'=j.job_id::text
         ) SELECT 1 FROM receipts WHERE expires_at>clock_timestamp()
       ) RETURNING job_id`,
      [opts.project_id, opts.job_id],
    );
    return rows.length > 0;
  });
}
import type {
  ScanAdmissionRequest,
  ScanReceipt,
  ScanDiscoveryStatus,
  ScanDeferralReason,
} from "@cocalc/util/collaboration-scan";
export type {
  ScanAdmissionRequest,
  ScanReceipt,
  ScanDiscoveryStatus,
} from "@cocalc/util/collaboration-scan";

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
        `SELECT r.result,j.state,j.started_at,j.host_id,p.host_id AS current_host,
          j.deferred_reason,GREATEST(0,EXTRACT(EPOCH FROM (j.deferred_until-clock_timestamp()))*1000) AS retry_after_ms
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
      return {
        state: "running",
        started_at: row.started_at.getTime(),
        ...(row.deferred_reason
          ? {
              deferred: {
                reason: row.deferred_reason,
                retry_after_ms: Number(row.retry_after_ms),
              },
            }
          : {}),
      };
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
  await db.query(`ALTER TABLE collaboration_scan_jobs
    ADD COLUMN IF NOT EXISTS batch_id UUID,
    ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS progress JSONB,
    ADD COLUMN IF NOT EXISTS finish_result JSONB`);
  await db.query(`ALTER TABLE collaboration_scan_jobs
    ADD COLUMN IF NOT EXISTS recovery_pending BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS recovery_after TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recovery_token UUID,
    ADD COLUMN IF NOT EXISTS recovery_until TIMESTAMPTZ`);
  // Existing jobs may already have sent work. Only new batch jobs explicitly
  // opt into the provably-unsubmitted state; migration must remain conservative.
  await db.query(`ALTER TABLE collaboration_scan_jobs
    ADD COLUMN IF NOT EXISTS host_request_started BOOLEAN NOT NULL DEFAULT true`);
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
    ADD COLUMN IF NOT EXISTS dispatch_probe_token UUID,
    ADD COLUMN IF NOT EXISTS dispatch_until TIMESTAMPTZ`);
  // An older worker can claim a new job during a rolling upgrade/rollback. It
  // does not implement the submission boundary, so its lease must immediately
  // make execution ambiguous. New workers attest their probe-aware lease by
  // setting both tokens together; no writer can reset a true boundary to false.
  await db.query(`CREATE OR REPLACE FUNCTION collaboration_scan_submission_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.host_request_started OR
         (NEW.dispatch_token IS NOT NULL AND
          NEW.dispatch_token IS DISTINCT FROM NEW.dispatch_probe_token) THEN
        NEW.host_request_started := true;
      END IF;
      RETURN NEW;
    END $$`);
  await db.query(`CREATE OR REPLACE TRIGGER collaboration_scan_submission_guard
    BEFORE UPDATE ON collaboration_scan_jobs FOR EACH ROW
    EXECUTE FUNCTION collaboration_scan_submission_guard()`);
  await db.query(`ALTER TABLE collaboration_scan_jobs
    ADD COLUMN IF NOT EXISTS deferred_reason TEXT,
    ADD COLUMN IF NOT EXISTS deferred_until TIMESTAMPTZ`);
  await db.query(
    `ALTER TABLE collaboration_scan_jobs ADD COLUMN IF NOT EXISTS last_dispatch_at TIMESTAMPTZ`,
  );
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_scan_jobs_fair
    ON collaboration_scan_jobs((COALESCE(last_dispatch_at,created_at)),job_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_scan_budget (
    project_id UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
    tokens DOUBLE PRECISION NOT NULL CHECK(tokens>=0 AND tokens<=2),
    updated_at TIMESTAMPTZ NOT NULL)`);
  await db.query(`ALTER TABLE collaboration_scan_budget
    ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_admitted_at TIMESTAMPTZ`);
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
      AND r.request_id=$4 AND r.expires_at>clock_timestamp() AND NOT j.cancel_requested`,
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
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `scan-execution:${authority.owning_bay_id}`,
    ]);
    const capacity = (
      await db.query(
        `SELECT count(*) FILTER (WHERE NOT recovery_pending)::int AS bay,
      count(*) FILTER (WHERE host_id=$1)::int AS host FROM collaboration_scan_jobs WHERE state='running'`,
        [host],
      )
    ).rows[0];
    if (capacity.bay >= 8 || capacity.host >= 2) return null;
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
        "SELECT state,host_id,batch_id,cancel_requested,recovery_pending FROM collaboration_scan_jobs WHERE project_id=$1 AND job_id=$2",
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
    if (
      job.state !== "running" ||
      job.host_id !== authority.host_id ||
      job.batch_id ||
      job.cancel_requested ||
      job.recovery_pending
    )
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
      SET dispatch_token=$4,dispatch_probe_token=$4,dispatch_until=clock_timestamp()+interval '90 seconds',last_dispatch_at=clock_timestamp(),deferred_reason=NULL,deferred_until=NULL
      WHERE project_id=$1 AND job_id=$2 AND state='running' AND NOT cancel_requested
      AND (dispatch_until IS NULL OR dispatch_until<=clock_timestamp())
      AND (deferred_until IS NULL OR deferred_until<=clock_timestamp())
      AND EXISTS(SELECT 1 FROM collaboration_scan_receipts r WHERE r.project_id=j.project_id
        AND r.account_id=$3 AND r.receipt->>'job_id'=j.job_id::text AND r.expires_at>clock_timestamp())
      RETURNING job_id`,
      [opts.project_id, opts.job_id, opts.account_id, token],
    );
    return result.rows.length ? token : null;
  });
}

/** Commit the possible remote-execution boundary before sending a start RPC.
 * The project fence serializes this with cancellation and unsubmitted cleanup.
 * A worker delayed in its read-only probe cannot submit after either wins.
 */
export async function markCollaborationScanHostRequest(
  opts: {
    project_id: string;
    account_id: string;
    job_id: string;
    token: string;
  },
  authority: CollaborationOwnerAuthority,
): Promise<boolean> {
  uuid(opts.job_id, "scan job");
  uuid(opts.token, "dispatch token");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const result = await db.query(
      `UPDATE collaboration_scan_jobs SET host_request_started=true
       WHERE project_id=$1 AND job_id=$2 AND dispatch_token=$3
       AND dispatch_until>clock_timestamp() AND state='running'
       AND NOT cancel_requested AND finish_result IS NULL RETURNING job_id`,
      [opts.project_id, opts.job_id, opts.token],
    );
    return result.rows.length > 0;
  });
}

/** Bounded result discovery from active jobs, never historical memberships.
 * Selection is only a hint: start/claim recheck authority and serialize work.
 */
export async function listCollaborationScanDispatchCandidates(
  authority: CollaborationOwnerAuthority,
): Promise<
  Array<{
    project_id: string;
    job_id: string;
    account_id: string;
    request_id: string;
  }>
> {
  return transaction(async (db) => {
    const page = await scanJobPage(
      db,
      `scan-dispatch:${authority.owning_bay_id}`,
    );
    const { rows } = await db.query(scanDispatchCandidatesSql, [
      authority.owning_bay_id,
      page.map((row) => row.job_id),
    ]);
    return rows;
  });
}

/** Examine at most twenty active jobs, including ineligible ones. Retirement
 * rechecks under a project fence in its own transaction after this cursor commits.
 */
export async function listCollaborationScanRetirementCandidates(
  authority: CollaborationOwnerAuthority,
): Promise<Array<{ project_id: string; job_id: string }>> {
  return transaction(async (db) => {
    const page = await scanJobPage(
      db,
      `scan-retire:${authority.owning_bay_id}`,
    );
    const { rows } = await db.query(scanRetirementCandidatesSql, [
      authority.owning_bay_id,
      page.map((row) => row.job_id),
    ]);
    return rows;
  });
}

// Keep expiry filtering inside a job-scoped materialization. After mass expiry,
// the global expiry index can still contain many unvacuumed formerly-live tuples.
export const scanRetirementCandidatesSql = `WITH page AS MATERIALIZED (
  SELECT * FROM collaboration_scan_jobs WHERE job_id=ANY($2::uuid[])
) SELECT j.project_id,j.job_id FROM page j JOIN projects p USING(project_id)
WHERE p.owning_bay_id=$1 AND j.state='queued'
AND NOT EXISTS (
  WITH receipts AS MATERIALIZED (
    SELECT expires_at FROM collaboration_scan_receipts r
    WHERE r.project_id=j.project_id AND r.receipt->>'job_id'=j.job_id::text
  ) SELECT 1 FROM receipts WHERE expires_at>statement_timestamp()
)`;

export async function scanJobPage(
  db: PoolClient,
  id: string,
): Promise<Array<{ job_id: string }>> {
  await boundScanMaintenanceQueries(db);
  await db.query(
    "INSERT INTO collaboration_maintenance(id,cursor) VALUES($1,'{}') ON CONFLICT DO NOTHING",
    [id],
  );
  const cursor = (
    await db.query(
      "SELECT cursor FROM collaboration_maintenance WHERE id=$1 FOR UPDATE",
      [id],
    )
  ).rows[0].cursor;
  let page = (
    await db.query(scanDispatchPageSql, [cursor.job_id ?? ZERO_SCAN_JOB])
  ).rows;
  if (!page.length && cursor.job_id)
    page = (await db.query(scanDispatchPageSql, [ZERO_SCAN_JOB])).rows;
  await db.query(
    "UPDATE collaboration_maintenance SET cursor=$2::jsonb WHERE id=$1",
    [
      id,
      JSON.stringify(
        page.length ? { job_id: page[page.length - 1].job_id } : {},
      ),
    ],
  );
  return page;
}

const ZERO_SCAN_JOB = "00000000-0000-0000-0000-000000000000";
export const scanDispatchPageSql = `SELECT job_id FROM collaboration_scan_jobs
  WHERE job_id>$1::uuid ORDER BY job_id LIMIT 20`;
export const scanDispatchCandidatesSql = `WITH page AS MATERIALIZED (
      SELECT * FROM collaboration_scan_jobs WHERE job_id=ANY($2::uuid[])
      ) SELECT j.project_id,j.job_id,r.account_id,r.request_id
      FROM page j JOIN projects p USING(project_id)
      JOIN collaboration_scan_budget b USING(project_id)
      JOIN LATERAL (
        SELECT account_id,request_id FROM collaboration_scan_receipts r
        WHERE r.project_id=j.project_id AND r.receipt->>'job_id'=j.job_id::text
          AND r.expires_at>statement_timestamp()
          AND p.users->r.account_id::text->>'group' IN ('owner','collaborator')
        ORDER BY r.expires_at DESC LIMIT 1
      ) r ON true
      WHERE j.batch_id IS NULL AND p.owning_bay_id=$1 AND NOT COALESCE(p.deleted,false) AND p.host_id IS NOT NULL
        AND (j.dispatch_until IS NULL OR j.dispatch_until<=statement_timestamp())
        AND (j.deferred_until IS NULL OR j.deferred_until<=statement_timestamp())
        AND (j.last_dispatch_at IS NULL OR j.last_dispatch_at<=statement_timestamp()-interval '5 seconds')
        AND (j.state='running' AND j.host_id=p.host_id OR j.state='queued'
          AND (b.last_started_at IS NULL OR b.last_started_at<=statement_timestamp()-interval '5 minutes')
          AND NOT EXISTS(SELECT 1 FROM collaboration_scan_jobs running
            WHERE running.project_id=j.project_id AND running.state='running' OFFSET 0))
      ORDER BY COALESCE(j.last_dispatch_at,j.created_at),j.job_id LIMIT 20`;

/** Only the live dispatch holder at the current host can delay this job.
 * Bound host hints so a malformed response cannot suspend work indefinitely.
 */
export async function deferCollaborationScanDispatch(
  opts: {
    project_id: string;
    job_id: string;
    token: string;
    reason: ScanDeferralReason;
    retry_after_ms: number;
  },
  authority: CollaborationWriterAuthority,
): Promise<boolean> {
  uuid(opts.job_id, "scan job");
  uuid(opts.token, "dispatch token");
  if (
    ![
      "host_busy",
      "report_pending",
      "host_throttled",
      "host_deferred",
    ].includes(opts.reason) ||
    !Number.isFinite(opts.retry_after_ms) ||
    opts.retry_after_ms < 0
  )
    throw Error("invalid scan deferral");
  const delay = Math.min(
    300000,
    Math.max(5000, Math.ceil(opts.retry_after_ms)),
  );
  return transaction(async (db) => {
    await assertCollaborationWriterAuthority(db, opts.project_id, authority);
    const { rows } = await db.query(
      `UPDATE collaboration_scan_jobs SET deferred_reason=$4,
        deferred_until=clock_timestamp()+$5::double precision*interval '1 millisecond'
       WHERE project_id=$1 AND job_id=$2 AND dispatch_token=$3
         AND dispatch_until>clock_timestamp() AND state='running' AND host_id=$6
       RETURNING job_id`,
      [
        opts.project_id,
        opts.job_id,
        opts.token,
        opts.reason,
        delay,
        authority.host_id,
      ],
    );
    return rows.length > 0;
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

/** Reconcile the host frontier under the current dispatch lease. An owner-side
 * attempt may never have reached the host. Only before possible submission may
 * its inherited predecessor be replaced (including by an empty frontier).
 */
export async function adoptCollaborationScanPredecessor(
  opts: {
    project_id: string;
    job_id: string;
    token: string;
    predecessor: string | null;
  },
  authority: CollaborationWriterAuthority,
) {
  uuid(opts.job_id, "scan job");
  uuid(opts.token, "dispatch token");
  if (opts.predecessor !== null) uuid(opts.predecessor, "scan predecessor");
  if (opts.job_id === opts.predecessor)
    throw Error("scan cannot replace itself");
  return transaction(async (db) => {
    await assertCollaborationWriterAuthority(db, opts.project_id, authority);
    const { rows } = await db.query(
      `UPDATE collaboration_scan_jobs SET expected_run_id=$4
      WHERE project_id=$1 AND job_id=$2 AND dispatch_token=$3 AND dispatch_until>clock_timestamp()
      AND state='running' AND host_id=$5 AND NOT cancel_requested AND finish_result IS NULL
      AND (expected_run_id IS NULL OR expected_run_id IS NOT DISTINCT FROM $4::uuid OR NOT host_request_started)
      RETURNING job_id`,
      [
        opts.project_id,
        opts.job_id,
        opts.token,
        opts.predecessor,
        authority.host_id,
      ],
    );
    return rows.length > 0;
  });
}
