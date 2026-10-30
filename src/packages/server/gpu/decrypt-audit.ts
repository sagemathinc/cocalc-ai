/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The decrypt audit (STEP5D2 5d-2c-2): a worker of its own that checks every
// recorded decrypt of a GPU provider key (5d-2c-1) against the capability it
// presented, once the facts it needs are final, and alerts on what nothing
// explains.
//
// - A missing, malformed or mismatched capability is judged at once
//   (critical: unexplained_decrypt, to CoCalc's admins and, as a warning, to
//   the key's owner).
// - A valid read is judged when its record expired (+60 s), a valid write
//   when its outcome is recorded or its record expired (+60 s), a worker's
//   decrypt when its run's authority ended (+60 s). A decrypt after its
//   record expired, or outside its run's lease, is unexplained. An attempt that
//   never finished, or a write with no outcome, is decrypt_unresolved (a
//   warning to admins: a crash, or a bypass).
// - An admission whose key was never read (never claimed) is recorded as
//   admitted_unused, with no alert.
//
// Every row is marked audited in the transaction that writes its verdict and
// alerts; nothing is skipped by a time watermark. Retention (90 days) deletes
// only rows the audit covered. This reads facts and acts on no key, so it
// takes no key fence.
//
// The audit is local: a compromised hub process can fabricate the record and
// the decrypt alike. That needs the off-host log (security_event_outbox is its
// seam), which doesn't exist yet.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { raiseAdminAlert } from "@cocalc/server/gpu/admin-alerts";
import { raiseAlert } from "@cocalc/server/gpu/alerts";
import {
  isWriteKeyPurpose,
  workerForPurpose,
} from "@cocalc/server/gpu/key-use";
import {
  acquireWorkerLease,
  every,
  finishWorkerLease,
  LeaseLost,
  renewWorkerLease,
} from "@cocalc/server/gpu/reaper";

const log = getLogger("server:gpu:decrypt-audit");

type Db = Pick<PoolClient, "query">;

export const DECRYPT_AUDIT_INTERVAL_MS = 5 * 60_000;
// how long after a capability's end its decrypts are judged
export const MATURITY_GRACE_MS = 60_000;
export const AUDIT_RETENTION_DAYS = 90;
const BATCH = 200;
const SWEEP_MS = 4 * 60_000;

export type DecryptVerdict =
  | "explained"
  | "unexplained"
  | "unresolved"
  | "admitted_unused";

// One decrypt row with what it presented, as the audit reads it.
export interface DecryptFacts {
  id: string;
  purpose: string;
  key_owner_account_id: string;
  credential_id: string;
  principal: string;
  bay_id: string;
  started: Date;
  claimed_at: Date | null;
  finished: Date | null;
  key_use_id: string | null;
  worker_run_id: string | null;
  worker_name: string | null;
  // the record (null when missing)
  use: {
    key_owner_account_id: string;
    credential_id: string | null;
    principal_account_id: string;
    agent_id: string | null;
    purpose: string;
    authorized: boolean;
    bay_id: string;
    created: Date;
    expires: Date;
    max_decrypts: number;
    // decrypt rows that presented it
    decrypt_rows: number;
    outcome: string | null;
    // rule 'project' (PROJECT_FUNDING.md §5): the approval it was bound to,
    // and that approval's layer as it is now (null when missing)
    rule?: string;
    project?: {
      project_id: string;
      approval_id: string;
      layer_id: string;
      actor_kind: string;
      layer: {
        scope_kind: string;
        approval_id: string | null;
        project_id: string | null;
        key_owner_account_id: string;
        credential_id: string;
        starts_at: Date;
        ends_at: Date;
        // when it stopped admitting for good (revoke, expiry, close)
        ended_at: Date | null;
      } | null;
    } | null;
  } | null;
  // the run (null when missing)
  run: {
    name: string;
    started: Date;
    finished: Date | null;
    // finished | failed | lost (null while open)
    outcome: string | null;
    // until when it held the lease, as last taken or renewed
    lease_expires: Date | null;
  } | null;
}

export type Judgement =
  | { mature: false }
  | { mature: true; verdict: DecryptVerdict; why?: string };

const t = (d: Date | null | undefined) =>
  d == null ? undefined : new Date(d).getTime();

// The verdict on one decrypt, or not yet. `homeBay` is the key owner's home
// bay now (the only bay that may hold or read their key).
export function judgeDecrypt(
  d: DecryptFacts,
  { now, thisBay, homeBay }: { now: number; thisBay: string; homeBay: string },
): Judgement {
  const unexplained = (why: string): Judgement => ({
    mature: true,
    verdict: "unexplained",
    why,
  });
  // 1. A missing, malformed or mismatched capability: judged at once.
  if (d.bay_id !== thisBay || homeBay !== d.bay_id) {
    return unexplained("not the key owner's home bay");
  }
  if ((d.key_use_id == null) === (d.worker_run_id == null)) {
    return unexplained("no capability");
  }
  const started = t(d.started)!;
  if (d.key_use_id != null) {
    const u = d.use;
    if (!u) return unexplained("its authorization record is missing");
    if (t(u.created)! > started) {
      return unexplained("its authorization record was made after it");
    }
    if (!u.authorized) return unexplained("its record is not authorized");
    if (u.purpose !== d.purpose) return unexplained("another purpose");
    if (u.key_owner_account_id !== d.key_owner_account_id) {
      return unexplained("another key owner");
    }
    if (u.credential_id !== d.credential_id) {
      return unexplained("another key");
    }
    if (u.bay_id !== d.bay_id) return unexplained("another bay");
    const pr = u.rule === "project" ? u.project : undefined;
    if (u.rule === "project" && !pr) {
      return unexplained("its approval binding is missing");
    }
    const principal = pr
      ? (pr.actor_kind === "project"
          ? `project:${pr.project_id}`
          : `${u.principal_account_id}`
        ).slice(0, 200)
      : u.agent_id
        ? `agent:${u.principal_account_id}:${u.agent_id}`.slice(0, 200)
        : `${u.principal_account_id}`;
    if (principal !== d.principal) return unexplained("another principal");
    if (pr) {
      // Only while its exact approval was valid: from the layer's start,
      // strictly before the earliest of its end and its recorded end
      // (revoke, expiry, close). Grace below delays the verdict; it never
      // widens this.
      const l = pr.layer;
      if (
        !l ||
        l.scope_kind !== "project" ||
        l.approval_id !== pr.approval_id ||
        l.project_id !== pr.project_id ||
        l.key_owner_account_id !== d.key_owner_account_id ||
        l.credential_id !== d.credential_id
      ) {
        return unexplained("not its approval's layer");
      }
      const until = Math.min(
        t(l.ends_at)!,
        l.ended_at == null ? Infinity : t(l.ended_at)!,
      );
      if (started < t(l.starts_at)! || started >= until) {
        return unexplained("outside its approval's validity");
      }
    }
    if (u.decrypt_rows > u.max_decrypts) {
      return unexplained("over its record's limit");
    }
    // (admission needs expires > now: a decrypt at expiry wasn't allowed)
    if (started >= t(u.expires)!) {
      return unexplained("after its authorization record expired");
    }
    // 2-3. A read when its record expired; a write when its outcome is
    // recorded, or its record expired.
    const expiredAt = t(u.expires)! + MATURITY_GRACE_MS;
    const write = isWriteKeyPurpose(d.purpose);
    if (!(now >= expiredAt || (write && u.outcome != null))) {
      return { mature: false };
    }
    if (write && u.outcome == null && d.claimed_at != null) {
      return {
        mature: true,
        verdict: "unresolved",
        why: "a write with no recorded outcome",
      };
    }
  } else {
    const r = d.run;
    if (!r) return unexplained("its worker run is missing");
    if (r.name !== d.worker_name || workerForPurpose(d.purpose) !== r.name) {
      return unexplained("not this worker's purpose");
    }
    // 4. When its authority ended: a run that finished or failed held the
    // lease until then; a lost one only until its lease expired (whenever
    // the loss was noticed); an open one until its lease's current expiry.
    const leaseEnd = t(r.lease_expires);
    const end =
      r.finished == null
        ? leaseEnd
        : r.outcome === "lost"
          ? Math.min(t(r.finished)!, leaseEnd ?? t(r.finished)!)
          : t(r.finished);
    if (end == null) return unexplained("its run never held a lease");
    const closedAt = t(r.finished) ?? end;
    if (now < Math.max(end, closedAt) + MATURITY_GRACE_MS) {
      return { mature: false };
    }
    // the run held the lease when the key was read
    if (started < t(r.started)! || started > end) {
      return unexplained("its run didn't hold the lease then");
    }
  }
  if (d.claimed_at == null) return { mature: true, verdict: "admitted_unused" };
  if (d.finished == null) {
    return {
      mature: true,
      verdict: "unresolved",
      why: "the key was read and the attempt never finished",
    };
  }
  return { mature: true, verdict: "explained" };
}

// The unaudited decrypts after `after` (oldest first), with what they
// presented. Every time comes back as epoch milliseconds, computed by the
// database (never parsed from text).
const MS = (col: string) => `(extract(epoch FROM ${col}) * 1000)::float8`;

async function batch(
  after: { started: number; id: string } | undefined,
): Promise<DecryptFacts[]> {
  const { rows } = await getPool().query(
    `SELECT d.id, d.purpose, d.key_owner_account_id, d.credential_id, d.principal,
            d.bay_id, ${MS("d.started")} AS started_ms,
            ${MS("d.claimed_at")} AS claimed_ms, ${MS("d.finished")} AS finished_ms,
            d.key_use_id, d.worker_run_id, d.worker_name,
            u.id AS u_id, u.key_owner_account_id AS u_owner,
            u.credential_id AS u_credential, u.principal_account_id AS u_principal,
            u.agent_id AS u_agent, u.purpose AS u_purpose,
            u.authorized AS u_authorized, u.bay_id AS u_bay,
            ${MS("u.created")} AS u_created_ms, ${MS("u.expires")} AS u_expires_ms,
            u.max_decrypts AS u_max, u.rule AS u_rule,
            u.project_id AS u_project, u.approval_id AS u_approval,
            u.layer_id AS u_layer, u.actor_kind AS u_actor_kind,
            pl.id AS pl_id, pl.scope_kind AS pl_kind,
            pl.approval_id AS pl_approval, pl.project_id AS pl_project,
            pl.key_owner_account_id AS pl_owner,
            pl.credential_id AS pl_credential,
            ${MS("pl.starts_at")} AS pl_starts_ms, ${MS("pl.ends_at")} AS pl_ends_ms,
            ${MS("pl.ended_at")} AS pl_ended_ms,
            (SELECT count(*)::int FROM gpu_key_decrypts x
              WHERE x.key_use_id = u.id) AS u_rows,
            o.outcome AS u_outcome,
            r.id AS r_id, r.name AS r_name, ${MS("r.started")} AS r_started_ms,
            ${MS("r.finished")} AS r_finished_ms, r.outcome AS r_outcome,
            ${MS("r.lease_expires_at")} AS r_lease_ms
       FROM gpu_key_decrypts d
       LEFT JOIN gpu_key_uses u ON u.id = d.key_use_id
       LEFT JOIN gpu_key_use_outcomes o ON o.key_use_id = u.id
       LEFT JOIN gpu_budget_layers pl ON pl.id = u.layer_id
       LEFT JOIN gpu_worker_runs r ON r.id = d.worker_run_id
      WHERE d.audited_at IS NULL
        AND ($1::float8 IS NULL OR (${MS("d.started")}, d.id) > ($1::float8, $2::uuid))
      ORDER BY d.started, d.id
      LIMIT ${BATCH}`,
    [after?.started ?? null, after?.id ?? null],
  );
  const date = (v: any) => (v == null ? null : new Date(Number(v)));
  return rows.map((r: any) => ({
    id: r.id,
    purpose: r.purpose,
    key_owner_account_id: r.key_owner_account_id,
    credential_id: r.credential_id,
    principal: r.principal,
    bay_id: r.bay_id,
    started: date(r.started_ms)!,
    claimed_at: date(r.claimed_ms),
    finished: date(r.finished_ms),
    key_use_id: r.key_use_id,
    worker_run_id: r.worker_run_id,
    worker_name: r.worker_name,
    use:
      r.u_id == null
        ? null
        : {
            key_owner_account_id: r.u_owner,
            credential_id: r.u_credential,
            principal_account_id: r.u_principal,
            agent_id: r.u_agent,
            purpose: r.u_purpose,
            authorized: r.u_authorized,
            bay_id: r.u_bay,
            created: date(r.u_created_ms)!,
            expires: date(r.u_expires_ms)!,
            max_decrypts: Number(r.u_max),
            decrypt_rows: Number(r.u_rows),
            outcome: r.u_outcome ?? null,
            rule: r.u_rule,
            project:
              r.u_rule !== "project"
                ? null
                : {
                    project_id: r.u_project,
                    approval_id: r.u_approval,
                    layer_id: r.u_layer,
                    actor_kind: r.u_actor_kind,
                    layer:
                      r.pl_id == null
                        ? null
                        : {
                            scope_kind: r.pl_kind,
                            approval_id: r.pl_approval,
                            project_id: r.pl_project,
                            key_owner_account_id: r.pl_owner,
                            credential_id: r.pl_credential,
                            starts_at: date(r.pl_starts_ms)!,
                            ends_at: date(r.pl_ends_ms)!,
                            ended_at: date(r.pl_ended_ms),
                          },
                  },
          },
    run:
      r.r_id == null
        ? null
        : {
            name: r.r_name,
            started: date(r.r_started_ms)!,
            finished: date(r.r_finished_ms),
            outcome: r.r_outcome ?? null,
            lease_expires: date(r.r_lease_ms),
          },
  }));
}

// The verdict, the row's audited mark and its alerts, in one transaction
// (only if no other pass audited it first).
async function record(
  d: DecryptFacts,
  j: Extract<Judgement, { mature: true }>,
  ownerHere: boolean,
): Promise<boolean> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const { rowCount } = await db.query(
      `UPDATE gpu_key_decrypts SET verdict = $2, audited_at = now()
        WHERE id = $1 AND audited_at IS NULL`,
      [d.id, j.verdict],
    );
    if (rowCount) await alertFor(db, d, j, ownerHere);
    await db.query("COMMIT");
    return !!rowCount;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

// `ownerHere`: the key owner's alerts are read on their home bay, so the
// owner's warning is written only when that is this bay. Otherwise (a decrypt
// away from the owner's home) the admins' alert says the owner wasn't told,
// for an admin to follow up.
async function alertFor(
  db: Db,
  d: DecryptFacts,
  j: Extract<Judgement, { mature: true }>,
  ownerHere: boolean,
): Promise<void> {
  // what the alerts say: never key material
  const details = {
    decrypt_id: d.id,
    purpose: d.purpose,
    at: new Date(d.started).toISOString(),
    bay_id: d.bay_id,
    why: j.why,
    ...(j.verdict === "unexplained" ? { owner_notified: ownerHere } : {}),
  };
  if (j.verdict === "unexplained") {
    await raiseAdminAlert(
      {
        kind: "unexplained_decrypt",
        severity: "critical",
        dedupe_key: d.credential_id,
        key_owner_account_id: d.key_owner_account_id,
        credential_id: d.credential_id,
        details,
      },
      db,
    );
    if (!ownerHere) return;
    await raiseAlert(
      {
        key_owner_account_id: d.key_owner_account_id,
        credential_id: d.credential_id,
        kind: "unexplained_decrypt",
        severity: "warning",
        dedupe_key: "key",
        details: { purpose: d.purpose, at: details.at },
        observed_at: new Date(),
      },
      db,
    );
  } else if (j.verdict === "unresolved") {
    await raiseAdminAlert(
      {
        kind: "decrypt_unresolved",
        severity: "warning",
        dedupe_key: d.credential_id,
        key_owner_account_id: d.key_owner_account_id,
        credential_id: d.credential_id,
        details,
      },
      db,
    );
  }
}

export interface DecryptAuditDeps {
  now?: () => number;
  holder?: string;
  heartbeatMs?: number;
  // the account's home bay now (default: the bay directory)
  homeBayOf?: (account_id: string) => Promise<string>;
  sweepMs?: number;
}

async function homeBayOf(account_id: string): Promise<string> {
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  return `${home_bay_id ?? ""}`.trim() || getConfiguredBayId();
}

// One pass over every unaudited decrypt, then retention.
export async function auditDecrypts(
  deps: DecryptAuditDeps,
  guard: () => Promise<void>,
): Promise<{ audited: number; pending: number; alerts: number }> {
  const clock = deps.now ?? Date.now;
  const deadline = clock() + (deps.sweepMs ?? SWEEP_MS);
  const thisBay = getConfiguredBayId();
  // (null: the lookup failed this pass)
  const homes = new Map<string, string | null>();
  const out = { audited: 0, pending: 0, alerts: 0 };
  let after: { started: number; id: string } | undefined;
  for (;;) {
    const rows = await batch(after);
    for (const d of rows) {
      await guard();
      if (!homes.has(d.key_owner_account_id)) {
        // a home that can't be looked up now: the row waits for a pass that
        // can (never judged without it)
        homes.set(
          d.key_owner_account_id,
          await (deps.homeBayOf ?? homeBayOf)(d.key_owner_account_id).catch(
            () => null,
          ),
        );
      }
      const homeBay = homes.get(d.key_owner_account_id);
      if (homeBay == null) {
        out.pending += 1;
        continue;
      }
      const j = judgeDecrypt(d, { now: clock(), thisBay, homeBay });
      if (!j.mature) {
        out.pending += 1;
        continue;
      }
      if (await record(d, j, homeBay === thisBay)) {
        out.audited += 1;
        if (j.verdict === "unexplained" || j.verdict === "unresolved") {
          out.alerts += 1;
        }
      }
    }
    if (rows.length < BATCH || clock() >= deadline) break;
    const last = rows[rows.length - 1];
    after = { started: new Date(last.started).getTime(), id: last.id };
  }
  await guard();
  await retain(clock());
  return out;
}

// Records whose every decrypt is audited are audited once they expired;
// after the retention period, only what the audit covered is deleted (and
// the outbox's rows once acked, or at the retention period).
export async function retain(now: number, db: Db = getPool()): Promise<void> {
  const at = new Date(now);
  await db.query(
    `UPDATE gpu_key_uses u SET audited_at = $1
      WHERE u.audited_at IS NULL
        AND u.expires < $1::timestamptz - make_interval(secs => $2)
        AND NOT EXISTS (SELECT 1 FROM gpu_key_decrypts d
                         WHERE d.key_use_id = u.id AND d.audited_at IS NULL)`,
    [at, MATURITY_GRACE_MS / 1000],
  );
  const cutoff = `$1::timestamptz - make_interval(days => ${AUDIT_RETENTION_DAYS})`;
  await db.query(
    `DELETE FROM gpu_key_decrypts
      WHERE audited_at IS NOT NULL AND started < ${cutoff}`,
    [at],
  );
  await db.query(
    `DELETE FROM gpu_key_use_outcomes o USING gpu_key_uses u
      WHERE o.key_use_id = u.id AND u.audited_at IS NOT NULL
        AND u.created < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM gpu_key_decrypts d WHERE d.key_use_id = u.id)`,
    [at],
  );
  await db.query(
    `DELETE FROM gpu_key_uses u
      WHERE u.audited_at IS NOT NULL AND u.created < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM gpu_key_decrypts d WHERE d.key_use_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM gpu_key_use_outcomes o WHERE o.key_use_id = u.id)`,
    [at],
  );
  await db.query(
    `DELETE FROM gpu_worker_runs r
      WHERE r.finished IS NOT NULL AND r.started < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM gpu_key_decrypts d WHERE d.worker_run_id = r.id)`,
    [at],
  );
  await db.query(
    `DELETE FROM security_event_outbox
      WHERE acked_at IS NOT NULL OR created < ${cutoff}`,
    [at],
  );
}

export async function runDecryptAuditSweep(
  deps: DecryptAuditDeps = {},
): Promise<{ ran: boolean; audited?: number; pending?: number }> {
  const clock = deps.now ?? Date.now;
  const at = () => new Date(clock());
  const token = `${deps.holder ?? `${hostname()}:${process.pid}`}:${randomUUID()}`;
  if (!(await acquireWorkerLease("decrypt_audit", token, at()))) {
    return { ran: false };
  }
  let lost = false;
  const renew = async () => {
    if (lost) throw new LeaseLost("the decrypt audit lease was lost");
    await renewWorkerLease("decrypt_audit", token, at());
  };
  const heartbeat = setInterval(() => {
    renewWorkerLease("decrypt_audit", token, at()).catch(() => (lost = true));
  }, deps.heartbeatMs ?? 60_000);
  heartbeat.unref?.();
  try {
    const stats = await auditDecrypts(deps, renew);
    if (stats.alerts > 0) {
      log.warn("the decrypt audit raised alerts", JSON.stringify(stats));
    }
    await finishWorkerLease("decrypt_audit", token, at(), undefined, stats);
    return { ran: true, audited: stats.audited, pending: stats.pending };
  } catch (err) {
    log.error("GPU decrypt audit failed", `${err}`);
    if (!(err instanceof LeaseLost) && !lost) {
      await finishWorkerLease("decrypt_audit", token, at(), `${err}`).catch(
        () => {},
      );
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

export function initGpuDecryptAudit(): void {
  every(
    "decrypt_audit",
    () => runDecryptAuditSweep(),
    DECRYPT_AUDIT_INTERVAL_MS,
  );
}
