/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { uuid } from "@cocalc/database/postgres/collaborators/collaborators-common";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { ensureLroSchema, claimLroOps } from "@cocalc/server/lro/lro-db";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { publishLroSummary } from "@cocalc/server/lro/stream";
import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  SCAN_BATCH_KIND,
  SCAN_ACCOUNT_INTERVAL_MS,
  SCAN_PAGE_SIZE,
  scanChildTerminal,
} from "@cocalc/util/collaboration-scan-batch";
import type {
  ScanProjectsRequest,
  ScanProjectsResponse,
  ScanBatchSummary,
  ScanChild,
  ScanChildRequest,
} from "@cocalc/util/collaboration-scan-batch";
const logger = getLogger("server:collaborators:scan-batch");
const MAX_PROJECTS = 10000;
const PREFLIGHT_LEASE_MS = 90_000;
const PREFLIGHT_RENEW_MS = 15_000;
const PREFLIGHT_CHECK_MS = 30_000;
const WORKER_ID = randomUUID();
const ACTIVE = ["queued", "running"];
let schema: Promise<void> | undefined;
export function ensureScanBatchSchema() {
  return (schema ??= (async () => {
    await ensureLroSchema();
    await getPool()
      .query(`CREATE TABLE IF NOT EXISTS collaboration_scan_batch_accounts (
      account_id UUID PRIMARY KEY, next_eligible_at TIMESTAMPTZ NOT NULL)`);
    await getPool().query(`ALTER TABLE collaboration_scan_batch_accounts
      ADD COLUMN IF NOT EXISTS preflight_id UUID,
      ADD COLUMN IF NOT EXISTS preflight_request_id UUID,
      ADD COLUMN IF NOT EXISTS preflight_selection JSONB,
      ADD COLUMN IF NOT EXISTS preflight_until TIMESTAMPTZ`);
    await getPool()
      .query(`CREATE TABLE IF NOT EXISTS collaboration_scan_batch_requests (
      account_id UUID NOT NULL, request_id UUID NOT NULL, selection JSONB NOT NULL,
      op_id UUID NOT NULL REFERENCES long_running_operations(op_id), PRIMARY KEY(account_id,request_id))`);
    await getPool()
      .query(`CREATE TABLE IF NOT EXISTS collaboration_scan_batch_children (
      op_id UUID NOT NULL REFERENCES long_running_operations(op_id), project_id UUID NOT NULL,
      request_id UUID NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'queued', result JSONB,
      dispatched BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(op_id,project_id))`);
    await getPool().query(`ALTER TABLE collaboration_scan_batch_children
      ADD COLUMN IF NOT EXISTS scan_order INTEGER NOT NULL DEFAULT 0`);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS collaboration_scan_batch_children_due ON collaboration_scan_batch_children(op_id,state,updated_at,project_id)`,
    );
    await getPool()
      .query(`CREATE INDEX IF NOT EXISTS collaboration_scan_batch_successful_projects
      ON collaboration_scan_batch_children(project_id,op_id) WHERE state='successful'`);
    await getPool()
      .query(`CREATE UNIQUE INDEX IF NOT EXISTS collaboration_scan_batch_single_flight
      ON long_running_operations(scope_id) WHERE kind='people-project-scan' AND status IN ('queued','running')`);
  })().catch((err) => {
    schema = undefined;
    throw err;
  }));
}
export async function scanAdmissionEnabled() {
  const settings = await getServerSettings();
  return (
    settings.collaborators_enabled === true &&
    settings.people_scan_enabled === true &&
    process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE === "1"
  );
}
function accountTx<T>(account_id: string, fn: (db: PoolClient) => Promise<T>) {
  return withAccountRehomeWriteFence({
    account_id,
    action: "manage Scan projects",
    fn,
  });
}
// Called only inside the account-home write fence. Settlement charges failures
// and abandoned work as well as successful admissions; a stale worker cannot
// settle a newer reservation.
async function settlePreflight(
  db: PoolClient,
  account_id: string,
  token: string,
) {
  await db.query(
    `UPDATE collaboration_scan_batch_accounts SET
      next_eligible_at=GREATEST(next_eligible_at,clock_timestamp()+$3*interval '1 millisecond'),
      preflight_id=NULL,preflight_request_id=NULL,preflight_selection=NULL,preflight_until=NULL
      WHERE account_id=$1 AND preflight_id=$2`,
    [account_id, token, SCAN_ACCOUNT_INTERVAL_MS],
  );
}
async function renewPreflight(
  db: PoolClient,
  account_id: string,
  token: string,
) {
  const result = await db.query(
    `UPDATE collaboration_scan_batch_accounts
      SET preflight_until=clock_timestamp()+$3*interval '1 millisecond'
      WHERE account_id=$1 AND preflight_id=$2 AND preflight_until>clock_timestamp()
      RETURNING preflight_id`,
    [account_id, token, PREFLIGHT_LEASE_MS],
  );
  if (!result.rows.length)
    throw Error("Scan authorization reservation expired; retry after cooldown");
}
async function boundedEligibility<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "Scan project authorization timed out; retry after cooldown",
              ),
            ),
          PREFLIGHT_CHECK_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function selection(input: string[] | "all") {
  if (input === "all") return input;
  if (!Array.isArray(input) || !input.length || input.length > MAX_PROJECTS)
    throw Error(`select between 1 and ${MAX_PROJECTS} projects`);
  for (const id of input) uuid(id, "scan project");
  return [...new Set(input.map((id) => id.toLowerCase()))].sort();
}
async function existing(
  db: PoolClient,
  account_id: string,
  request_id: string,
  selected: string[] | "all",
) {
  const prior = (
    await db.query(
      `SELECT selection,op_id FROM collaboration_scan_batch_requests WHERE account_id=$1 AND request_id=$2`,
      [account_id, request_id],
    )
  ).rows[0];
  if (prior) {
    if (JSON.stringify(prior.selection) !== JSON.stringify(selected))
      throw Error("scan request id reused with a different selection");
    return prior.op_id as string;
  }
  const active = (
    await db.query(
      `SELECT op_id FROM long_running_operations WHERE kind=$1 AND scope_type='account' AND scope_id=$2 AND status=ANY($3::text[]) LIMIT 1`,
      [SCAN_BATCH_KIND, account_id, ACTIVE],
    )
  ).rows[0];
  if (active) {
    await db.query(
      `INSERT INTO collaboration_scan_batch_requests VALUES($1,$2,$3::jsonb,$4)`,
      [account_id, request_id, JSON.stringify(selected), active.op_id],
    );
    return active.op_id as string;
  }
}
export async function scanProjectsAtHome(
  opts: ScanProjectsRequest,
  eligible: (
    project_id: string,
  ) => Promise<{ project_id: string; title: string } | null>,
): Promise<ScanProjectsResponse> {
  uuid(opts.account_id, "authenticated account");
  const account_id = opts.account_id;
  await ensureScanBatchSchema();
  const enabled = await scanAdmissionEnabled();
  if (opts.action === "projects") {
    if (!enabled) return { enabled, projects: [], total: 0 };
    const limit = opts.limit ?? SCAN_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > 250)
      throw Error("invalid project page size");
    let afterEdited: string | null = null;
    let afterProject: string | null = null;
    if (opts.after) {
      try {
        if (opts.after.length > 512) throw Error();
        const cursor = JSON.parse(
          Buffer.from(opts.after, "base64url").toString(),
        );
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 2 ||
          (cursor[0] !== null &&
            (typeof cursor[0] !== "string" ||
              !Number.isFinite(Date.parse(cursor[0]))))
        )
          throw Error();
        uuid(cursor[1], "project cursor");
        [afterEdited, afterProject] = cursor;
      } catch {
        throw Error("invalid project cursor");
      }
    }
    if (
      typeof (opts.search ?? "") !== "string" ||
      (opts.search?.length ?? 0) > 200
    )
      throw Error("invalid project search");
    const candidates = await accountTx(
      account_id,
      async (db) =>
        (
          await db.query(
            `SELECT project_id,host_id,COALESCE(title,'') AS title,last_edited::text AS sort_edited,
        last_edited,last_scan_at,last_fail,(last_scan_at IS NULL OR last_edited>last_scan_at) AS changed_since_scan
      FROM account_project_index i
      LEFT JOIN LATERAL (
        SELECT max(COALESCE(to_timestamp((c.result->>'last_success')::double precision/1000),l.created_at)) FILTER (WHERE c.state='successful') AS last_scan_at,
        max(COALESCE(to_timestamp((c.result->>'last_fail')::double precision/1000),l.created_at)) FILTER (WHERE c.state IN ('failed','unavailable','cancelled','truncated')) AS last_fail
        FROM collaboration_scan_batch_children c
        JOIN long_running_operations l ON l.op_id=c.op_id
        WHERE c.project_id=i.project_id
          AND l.scope_type='account' AND l.scope_id=$1 AND l.kind='people-project-scan'
      ) scanned ON true
      WHERE account_id=$1 AND users_summary->$1::text->>'group' IN ('owner','collaborator') AND COALESCE(state_summary->>'state','')<>'archived'
      AND ($3::uuid IS NULL OR COALESCE(last_edited,'-infinity'::timestamptz)<COALESCE($2::timestamptz,'-infinity'::timestamptz)
        OR (COALESCE(last_edited,'-infinity'::timestamptz)=COALESCE($2::timestamptz,'-infinity'::timestamptz) AND project_id>$3))
      AND strpos(lower(COALESCE(title,'')),lower($4))>0
      ORDER BY last_edited DESC NULLS LAST,project_id LIMIT $5`,
            [
              account_id,
              afterEdited,
              afterProject,
              opts.search ?? "",
              limit + 1,
            ],
          )
        ).rows,
    );
    // Listing is a bounded account-home projection read, not authorization to
    // execute. A stale membership/title is harmless here: admission and child
    // execution still check the current project owner. Never fan out owner RPCs
    // for search, pagination, or simply opening the Scan page.
    const projects = candidates
      .slice(0, limit)
      .map(
        ({
          project_id,
          host_id,
          title,
          last_edited,
          last_scan_at,
          last_fail,
          changed_since_scan,
        }) => ({
          project_id,
          host_id,
          title,
          last_edited: last_edited?.getTime(),
          last_scan_at: last_scan_at?.getTime(),
          last_success: last_scan_at?.getTime(),
          last_fail: last_fail?.getTime(),
          changed_since_scan: changed_since_scan === true,
        }),
      );
    const total = await accountTx(account_id, async (db) =>
      Number(
        (
          await db.query(
            `SELECT count(*) AS n FROM account_project_index WHERE account_id=$1 AND users_summary->$1::text->>'group' IN ('owner','collaborator') AND COALESCE(state_summary->>'state','')<>'archived'`,
            [account_id],
          )
        ).rows[0].n,
      ),
    );
    return {
      enabled,
      projects,
      total,
      ...(candidates.length > limit
        ? {
            next: Buffer.from(
              JSON.stringify([
                candidates[limit - 1].sort_edited,
                candidates[limit - 1].project_id,
              ]),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  let op_id: string | undefined;
  if (opts.action === "start") {
    uuid(opts.request_id, "scan request");
    const selected = selection(opts.project_ids);
    op_id = await accountTx(account_id, (db) =>
      existing(db, account_id, opts.request_id, selected),
    );
    if (!op_id) {
      if (!enabled)
        throw Error("New Scan operations are disabled by the administrator");
      // Charge before any routed authorization work. Rejected selections and
      // lost callers must not turn the whole owner fanout into a free retry.
      // The account fence serializes this charge across hub processes.
      const preflightStarted = performance.now();
      const preflight = await accountTx(account_id, async (db) => {
        const prior = await existing(db, account_id, opts.request_id, selected);
        if (prior) return { op_id: prior };
        const now = (
          await db.query("SELECT clock_timestamp() AS now")
        ).rows[0].now.getTime();
        const row = (
          await db.query(
            "SELECT * FROM collaboration_scan_batch_accounts WHERE account_id=$1",
            [account_id],
          )
        ).rows[0];
        if (row?.preflight_id) {
          if (
            row.preflight_request_id === opts.request_id &&
            JSON.stringify(row.preflight_selection) !== JSON.stringify(selected)
          )
            throw Error("scan request id reused with a different selection");
          if (row.preflight_until.getTime() <= now) {
            await settlePreflight(db, account_id, row.preflight_id);
            return { next_eligible_at: now + SCAN_ACCOUNT_INTERVAL_MS };
          }
          return {
            next_eligible_at: Math.max(
              row.next_eligible_at.getTime(),
              row.preflight_until.getTime(),
            ),
          };
        }
        if (row?.next_eligible_at.getTime() > now)
          return { next_eligible_at: row.next_eligible_at.getTime() };
        const token = randomUUID();
        await db.query(
          `INSERT INTO collaboration_scan_batch_accounts(account_id,next_eligible_at,preflight_id,preflight_request_id,preflight_selection,preflight_until)
            VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(account_id) DO UPDATE SET
            next_eligible_at=EXCLUDED.next_eligible_at,preflight_id=EXCLUDED.preflight_id,
            preflight_request_id=EXCLUDED.preflight_request_id,preflight_selection=EXCLUDED.preflight_selection,
            preflight_until=EXCLUDED.preflight_until`,
          [
            account_id,
            new Date(now + SCAN_ACCOUNT_INTERVAL_MS),
            token,
            opts.request_id,
            JSON.stringify(selected),
            new Date(now + PREFLIGHT_LEASE_MS),
          ],
        );
        return { token };
      });
      if (preflight.op_id)
        return {
          enabled,
          operation: await readScanBatch(account_id, preflight.op_id),
        };
      if (preflight.next_eligible_at) {
        // A racing tab may have paid for selection validation but not created
        // its LRO yet. Briefly observe that winner; never duplicate its fanout.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const winner = await accountTx(account_id, (db) =>
          existing(db, account_id, opts.request_id, selected),
        );
        return winner
          ? { enabled, operation: await readScanBatch(account_id, winner) }
          : { enabled, next_eligible_at: preflight.next_eligible_at };
      }
      const token = preflight.token!;
      try {
        let renewedAt = preflightStarted;
        const candidates =
          selected === "all"
            ? await accountTx(account_id, async (db) =>
                (
                  await db.query(
                    `SELECT project_id FROM account_project_index WHERE account_id=$1 AND users_summary->$1::text->>'group' IN ('owner','collaborator') AND COALESCE(state_summary->>'state','')<>'archived' ORDER BY last_edited DESC NULLS LAST,project_id LIMIT $2`,
                    [account_id, MAX_PROJECTS + 1],
                  )
                ).rows.map((row) => row.project_id as string),
              )
            : await accountTx(account_id, async (db) =>
                (
                  await db.query(
                    `SELECT p.project_id FROM unnest($2::uuid[]) AS p(project_id)
                  LEFT JOIN account_project_index i ON i.account_id=$1 AND i.project_id=p.project_id
                  ORDER BY i.last_edited DESC NULLS LAST,p.project_id`,
                    [account_id, selected],
                  )
                ).rows.map((row) => row.project_id as string),
              );
        if (candidates.length > MAX_PROJECTS)
          throw Error(
            `Select at most ${MAX_PROJECTS} projects per scan; all was not partially submitted`,
          );
        // Capture the set once at submission, then owner-authorize every member.
        const authorized: string[] = [];
        for (const id of candidates) {
          // Renew between bounded owner calls. A paused/expired worker must renew
          // conditionally before sending any further routed authorization work.
          while (performance.now() - renewedAt >= PREFLIGHT_RENEW_MS) {
            renewedAt = performance.now();
            await accountTx(account_id, (db) =>
              renewPreflight(db, account_id, token),
            );
          }
          const project = await boundedEligibility(() => eligible(id));
          if (project) authorized.push(id);
          else if (selected !== "all")
            throw Error("A selected project is no longer accessible");
        }
        if (!authorized.length) throw Error("No eligible projects selected");
        const admitted = await accountTx(account_id, async (db) => {
          await renewPreflight(db, account_id, token);
          const prior = await existing(
            db,
            account_id,
            opts.request_id,
            selected,
          );
          if (prior) return { op_id: prior };
          if (!(await scanAdmissionEnabled()))
            throw Error(
              "New Scan operations are disabled by the administrator",
            );
          const id = randomUUID();
          await db.query(
            `INSERT INTO long_running_operations(op_id,kind,scope_type,scope_id,status,created_by,input,expires_at,dedupe_key,routing)
          VALUES($1,$2,'account',$3,'queued',$3,$4::jsonb,'infinity',$5,$6)`,
            [
              id,
              SCAN_BATCH_KIND,
              account_id,
              JSON.stringify({
                total: authorized.length,
                cancel_requested: false,
                home_bay_id: getConfiguredBayId(),
              }),
              `scan:${account_id}`,
              getConfiguredBayId(),
            ],
          );
          await db.query(
            `INSERT INTO collaboration_scan_batch_children(op_id,project_id,request_id,scan_order)
          SELECT $1,p,r,n FROM unnest($2::uuid[],$3::uuid[]) WITH ORDINALITY AS t(p,r,n)`,
            [id, authorized, authorized.map(() => randomUUID())],
          );
          await db.query(
            `INSERT INTO collaboration_scan_batch_requests VALUES($1,$2,$3::jsonb,$4)`,
            [account_id, opts.request_id, JSON.stringify(selected), id],
          );
          await settlePreflight(db, account_id, token);
          return { op_id: id };
        });
        op_id = admitted.op_id;
      } finally {
        await accountTx(account_id, (db) =>
          settlePreflight(db, account_id, token),
        );
      }
    }
  } else {
    if (opts.op_id) uuid(opts.op_id, "scan operation");
    op_id = opts.op_id;
  }
  if (opts.action === "cancel") {
    await accountTx(account_id, async (db) => {
      await db.query(
        `UPDATE long_running_operations SET input=input || '{"cancel_requested":true}'::jsonb,updated_at=now()
        WHERE op_id=$1 AND kind=$2 AND scope_type='account' AND scope_id=$3 AND status=ANY($4::text[])`,
        [op_id, SCAN_BATCH_KIND, account_id, ACTIVE],
      );
    });
  }
  const after = opts.action === "status" ? opts.after : undefined;
  if (after) uuid(after, "scan result cursor");
  const operation = await readScanBatch(account_id, op_id, after);
  if (!operation) {
    // A rejected preflight can consume cooldown without creating an LRO. Let
    // status/reload display that limit without another Start request.
    const next = await accountTx(account_id, async (db) =>
      (
        await db.query(
          "SELECT GREATEST(next_eligible_at, preflight_until) AS next_eligible_at FROM collaboration_scan_batch_accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows[0]?.next_eligible_at?.getTime(),
    );
    return { enabled, next_eligible_at: next };
  }
  return { enabled, operation };
}
export async function readScanBatch(
  account_id: string,
  op_id?: string,
  after?: string,
): Promise<ScanBatchSummary | undefined> {
  return accountTx(account_id, async (db) => {
    const op = (
      await db.query(
        `SELECT * FROM long_running_operations WHERE kind=$1 AND scope_type='account' AND scope_id=$2 AND ($3::uuid IS NULL OR op_id=$3) ORDER BY created_at DESC LIMIT 1`,
        [SCAN_BATCH_KIND, account_id, op_id ?? null],
      )
    ).rows[0] as LroSummary | undefined;
    if (!op) return;
    const groups = (
      await db.query(
        `SELECT state,count(*)::int AS n FROM collaboration_scan_batch_children WHERE op_id=$1 GROUP BY state`,
        [op.op_id],
      )
    ).rows;
    const counts = Object.fromEntries(groups.map((row) => [row.state, row.n]));
    const processed = groups
      .filter((row) => scanChildTerminal(row.state))
      .reduce((n, row) => n + row.n, 0);
    const rows = (
      await db.query(
        `SELECT c.project_id,c.request_id,c.state,c.result,i.title FROM collaboration_scan_batch_children c
        LEFT JOIN account_project_index i ON i.account_id=$4 AND i.project_id=c.project_id
        WHERE c.op_id=$1 AND ($2::uuid IS NULL OR c.project_id>$2) ORDER BY c.project_id LIMIT $3`,
        [op.op_id, after ?? null, SCAN_PAGE_SIZE + 1, account_id],
      )
    ).rows;
    const next = (
      await db.query(
        "SELECT GREATEST(next_eligible_at, preflight_until) AS next_eligible_at FROM collaboration_scan_batch_accounts WHERE account_id=$1",
        [account_id],
      )
    ).rows[0]?.next_eligible_at;
    return {
      op_id: op.op_id,
      status: op.status as ScanBatchSummary["status"],
      cancelling: op.input.cancel_requested && ACTIVE.includes(op.status),
      total: op.input.total,
      processed,
      counts,
      next_eligible_at: next?.getTime() ?? 0,
      children: rows.slice(0, SCAN_PAGE_SIZE).map((row) => ({
        ...row.result,
        project_id: row.project_id,
        title: row.title ?? undefined,
        request_id: row.request_id,
        state: row.state,
      })),
      ...(rows.length > SCAN_PAGE_SIZE
        ? { next: rows[SCAN_PAGE_SIZE - 1].project_id }
        : {}),
    };
  });
}

/** Bounded durable execution of already-admitted work, independent of the
 * admission switch. Unknown RPC outcomes retain child identity indefinitely.
 */
export async function runScanBatchPass(
  step: (request: ScanChildRequest) => Promise<ScanChild>,
  active: () => boolean = () => true,
) {
  await ensureScanBatchSchema();
  const ops = await claimLroOps({
    kind: SCAN_BATCH_KIND,
    owner_type: "hub",
    owner_id: WORKER_ID,
    limit: 2,
    lease_ms: 90_000,
    queued_first: false,
  });
  for (const op of ops) {
    if (!active()) return;
    if (op.input.home_bay_id !== getConfiguredBayId()) continue;
    const children = await accountTx(
      op.scope_id,
      async (db) =>
        (
          await db.query(
            `SELECT * FROM collaboration_scan_batch_children WHERE op_id=$1 AND state=ANY($2::text[]) ORDER BY updated_at,scan_order,project_id LIMIT 8`,
            [op.op_id, ["queued", "running", "cancelling"]],
          )
        ).rows,
    );
    for (const child of children) {
      if (!active()) break;
      const intent = await accountTx(op.scope_id, async (db) => {
        const current = (
          await db.query(
            "SELECT input,attempt,status FROM long_running_operations WHERE op_id=$1 FOR UPDATE",
            [op.op_id],
          )
        ).rows[0];
        if (current.attempt !== op.attempt || !ACTIVE.includes(current.status))
          return;
        if (current.input.cancel_requested && !child.dispatched) {
          await db.query(
            "UPDATE collaboration_scan_batch_children SET state='cancelled',updated_at=now() WHERE op_id=$1 AND project_id=$2",
            [op.op_id, child.project_id],
          );
          return;
        }
        await db.query(
          "UPDATE collaboration_scan_batch_children SET dispatched=true,state=CASE WHEN $3 THEN 'cancelling' ELSE state END,updated_at=now() WHERE op_id=$1 AND project_id=$2",
          [op.op_id, child.project_id, !!current.input.cancel_requested],
        );
        return current.input.cancel_requested
          ? ("cancel" as const)
          : ("start" as const);
      });
      if (!intent) continue;
      try {
        const result = await step({
          account_id: op.scope_id,
          project_id: child.project_id,
          request_id: child.request_id,
          batch_id: op.op_id,
          action: intent,
        });
        await accountTx(op.scope_id, async (db) => {
          // Attempt fencing rejects publication from workers whose lease was taken over.
          await db.query(
            `UPDATE collaboration_scan_batch_children c SET state=$3,result=$4::jsonb,updated_at=now()
            FROM long_running_operations l WHERE c.op_id=$1 AND c.project_id=$2 AND l.op_id=c.op_id AND l.attempt=$5 AND l.status=ANY($6::text[])`,
            [
              op.op_id,
              child.project_id,
              result.state,
              JSON.stringify(result),
              op.attempt,
              ACTIVE,
            ],
          );
        });
      } catch {
        logger.debug("scan child outcome unknown; retaining identity", {
          op_id: op.op_id,
          request_id: child.request_id,
        });
      }
    }
    const summary = await readScanBatch(op.scope_id, op.op_id);
    if (!summary) continue;
    const updated = await accountTx(op.scope_id, async (db) => {
      const current = (
        await db.query(
          "SELECT input,attempt FROM long_running_operations WHERE op_id=$1 FOR UPDATE",
          [op.op_id],
        )
      ).rows[0];
      if (current.attempt !== op.attempt) return;
      const done = summary.processed === summary.total;
      const status = done
        ? current.input.cancel_requested && !(summary.counts.unavailable ?? 0)
          ? "canceled"
          : (summary.counts.successful ?? 0) === summary.total
            ? "succeeded"
            : "failed"
        : "running";
      // Release the completed pass with a one-second polling delay. The full
      // ninety-second lease still protects each in-flight pass and its attempt.
      return (
        await db.query(
          `UPDATE long_running_operations SET status=$2,heartbeat_at=now()-interval '89 seconds',updated_at=now(),finished_at=CASE WHEN $3 THEN now() ELSE NULL END,
        progress_summary=$4::jsonb,result=$5::jsonb WHERE op_id=$1 RETURNING *`,
          [
            op.op_id,
            status,
            done,
            JSON.stringify({
              phase: done
                ? "done"
                : current.input.cancel_requested
                  ? "cancelling"
                  : "scanning",
              message: `${summary.processed} of ${summary.total} projects processed`,
              progress: summary.total
                ? (100 * summary.processed) / summary.total
                : 0,
              detail: summary.counts,
            }),
            JSON.stringify({ counts: summary.counts, total: summary.total }),
          ],
        )
      ).rows[0] as LroSummary;
    });
    if (updated) {
      try {
        await publishLroSummary({
          scope_type: "account",
          scope_id: op.scope_id,
          summary: updated,
        });
      } catch {
        logger.debug(
          "scan progress stream unavailable; durable summary retained",
        );
      }
    }
  }
}
