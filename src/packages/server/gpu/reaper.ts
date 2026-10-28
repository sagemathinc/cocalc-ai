/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The GPU reaper (step 5b): once a minute, on each bay, one hub (under a
lease) makes sure no pod outlives what it was allowed:

- it marks for termination pods past their deadline, pods that used up
  their own reservation, pods under a budget layer that was suspended,
  revoked or ended, and pods whose key owner lost the entitlement more than
  7 days ago;
- then, per key owner, it resolves crash-left intents and creates,
  ambiguous creates, and pods that must go (resolvePendingForAccount), with
  per-pod backoff.

A layer that is merely full blocks new launches; it never terminates pods
already funded. Only a *completed* sweep moves the watermark that launch
admission requires (budgets.ts): every query is paged to its end, and a
sweep that fails, loses its lease, or can't drain an owner in time doesn't
move it. The watermark is the time the sweep finished.

Each sweep holds the lease under its own token, renewed before every
record it works on, so a second tick (on this hub or another) can't start
while one is running; a sweep that finds its lease lost or expired stops at
once and writes nothing.
*/

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { isGpuProviderKeysEntitled } from "@cocalc/server/gpu/provider-keys";
import {
  recordSeenAddresses,
  resolvePendingForAccount,
  STALE_CREATE_MS,
  transition,
  type Actor,
  type GpuPodDeps,
} from "@cocalc/server/gpu/pods";
import { getRunpodCleanupForAccount } from "@cocalc/server/gpu/provider-keys";

const log = getLogger("server:gpu:reaper");

export const REAPER_INTERVAL_MS = 60_000;
export const REAPER_LEASE_MS = 5 * 60_000;
export const LAPSE_GRACE_MS = 7 * 24 * 60 * 60_000;
// Community Cloud doesn't always give a pod a public port (measured 10-27):
// a pod with its own SSH key (kernel-capable) that has none this long after
// it started is terminated, rather than billing for nothing.
export const COMMUNITY_SSH_DEADLINE_MS = 10 * 60_000;
const BATCH = 100;
// passes over one owner's pending records before the sweep counts as
// incomplete (each pass takes up to BATCH of each kind)
const OWNER_PASSES = 20;

export interface ReaperDeps extends GpuPodDeps {
  holder?: string;
  // how often the lease is renewed in the background (default: a minute)
  heartbeatMs?: number;
  isEntitled?: (account_id: string) => Promise<boolean>;
}

const REAPER: Actor = { kind: "reaper" };

// The lease is taken under a token unique to one sweep: nobody, not even
// the same hub, takes it again until that sweep releases it or it expires.
export async function acquireWorkerLease(
  name: "reaper" | "reconciler",
  token: string,
  now: Date,
  ttlMs = REAPER_LEASE_MS,
): Promise<boolean> {
  await getPool().query(
    `INSERT INTO gpu_worker_leases (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [name],
  );
  const { rows } = await getPool().query(
    `UPDATE gpu_worker_leases
        SET holder = $2, expires_at = $3::timestamptz + make_interval(secs => $4),
            last_started_at = $3
      WHERE name = $1 AND (holder IS NULL OR expires_at < $3)
      RETURNING name`,
    [name, token, now, ttlMs / 1000],
  );
  return rows.length > 0;
}

class LeaseLost extends Error {}

// Extend this sweep's lease; a sweep that lost it stops at once.
async function renewWorkerLease(
  name: "reaper" | "reconciler",
  token: string,
  now: Date,
  ttlMs = REAPER_LEASE_MS,
): Promise<void> {
  const { rows } = await getPool().query(
    `UPDATE gpu_worker_leases
        SET expires_at = $3::timestamptz + make_interval(secs => $4)
      WHERE name = $1 AND holder = $2 AND expires_at >= $3 RETURNING name`,
    [name, token, now, ttlMs / 1000],
  );
  if (rows.length === 0) throw new LeaseLost("the reaper lease was lost");
}

// Release this sweep's lease; only a complete sweep that still holds an
// unexpired lease moves the watermark, to the time it finished. A sweep
// that lost its lease writes nothing.
async function finishWorkerLease(
  name: "reaper" | "reconciler",
  token: string,
  finished: Date,
  error?: string,
): Promise<void> {
  const { rows } = await getPool().query(
    error == null
      ? `UPDATE gpu_worker_leases
            SET last_completed_at = $3, last_error = NULL, holder = NULL, expires_at = NULL
          WHERE name = $1 AND holder = $2 AND expires_at >= $3 RETURNING name`
      : `UPDATE gpu_worker_leases
            SET last_error = $4, holder = NULL, expires_at = NULL
          WHERE name = $1 AND holder = $2 AND expires_at >= $3 RETURNING name`,
    error == null
      ? [name, token, finished]
      : [name, token, finished, error.slice(0, 500)],
  );
  if (rows.length === 0) throw new LeaseLost("the reaper lease was lost");
}

const LIVE =
  "p.state NOT IN ('terminated', 'failed') AND p.desired_state <> 'terminated' AND p.unmanaged_at IS NULL";

// Why a pod must go, and the SQL that finds such pods (bounded).
const CAUSES: {
  cause: string;
  action: "terminate" | "budget_stop";
  reason: string;
  where: string;
}[] = [
  {
    cause: "deadline",
    action: "terminate",
    reason: "Reached its maximum runtime.",
    where: "p.deadline <= $1",
  },
  {
    cause: "reservation_used",
    action: "budget_stop",
    reason: "Used up what its budget reserved for it.",
    where: `p.state = 'running' AND p.running_since IS NOT NULL AND p.cost_per_hr IS NOT NULL
      AND EXISTS (SELECT 1 FROM gpu_pod_reservations r
                   WHERE r.pod_id = p.id AND r.state = 'active'
                     AND r.reserved_usd <= p.cost_per_hr
                         * EXTRACT(EPOCH FROM ($1::timestamptz - p.running_since)) / 3600)`,
  },
  {
    cause: "layer_ended",
    action: "budget_stop",
    reason: "Its GPU budget was suspended, revoked or ended.",
    where: `EXISTS (SELECT 1 FROM gpu_pod_reservations r
                      JOIN gpu_budget_layers l ON l.id = r.layer_id
                     WHERE r.pod_id = p.id AND r.state = 'active'
                       AND (l.state IN ('suspended', 'revoked', 'expired', 'closed')
                            OR l.ends_at <= $1))`,
  },
  {
    cause: "lapsed",
    action: "budget_stop",
    reason:
      "Its key owner's membership no longer includes GPUs on their own key (for more than 7 days).",
    where: `EXISTS (SELECT 1 FROM gpu_key_fences f
                     WHERE f.credential_id = p.credential_id
                       AND f.entitlement_lapsed_at IS NOT NULL
                       AND f.entitlement_lapsed_at <= $1::timestamptz - make_interval(secs => ${LAPSE_GRACE_MS / 1000}))
            -- an entitlement this sweep couldn't check: decide next sweep
            AND p.credential_id <> ALL($3::uuid[])`,
  },
];

// Record, per key, whether its owner still has the entitlement: the 7-day
// lapse clock starts the first time it is seen missing.
// Returns the keys whose entitlement couldn't be checked this sweep.
async function checkEntitlements(
  now: Date,
  deps: ReaperDeps,
  renew: () => Promise<void>,
): Promise<string[]> {
  const unknown: string[] = [];
  let after = "";
  for (;;) {
    const { rows } = await getPool().query(
      `SELECT f.credential_id, f.key_owner_account_id, f.entitlement_lapsed_at
         FROM gpu_key_fences f
        WHERE f.credential_id::text > $2
          AND EXISTS (SELECT 1 FROM gpu_pods p WHERE p.credential_id = f.credential_id
                        AND p.state NOT IN ('terminated', 'failed'))
        ORDER BY f.credential_id::text LIMIT $1`,
      [BATCH, after],
    );
    for (const f of rows) {
      await renew();
      if (!(await checkEntitlement(f, now, deps))) {
        unknown.push(f.credential_id);
      }
    }
    if (rows.length < BATCH) return unknown;
    after = `${rows[rows.length - 1].credential_id}`;
    await renew();
  }
}

async function checkEntitlement(
  f: {
    credential_id: string;
    key_owner_account_id: string;
    entitlement_lapsed_at: Date | null;
  },
  now: Date,
  deps: ReaperDeps,
): Promise<boolean> {
  let entitled: boolean;
  try {
    entitled = await (deps.isEntitled ?? isGpuProviderKeysEntitled)(
      f.key_owner_account_id,
    );
  } catch {
    return false; // unknown: decide next sweep
  }
  if (!entitled && f.entitlement_lapsed_at == null) {
    await getPool().query(
      `UPDATE gpu_key_fences SET entitlement_lapsed_at = $2, updated = now() WHERE credential_id = $1`,
      [f.credential_id, now],
    );
  } else if (entitled && f.entitlement_lapsed_at != null) {
    await getPool().query(
      `UPDATE gpu_key_fences SET entitlement_lapsed_at = NULL, updated = now() WHERE credential_id = $1`,
      [f.credential_id],
    );
  }
  return true;
}

async function markForTermination(
  now: Date,
  renew: () => Promise<void>,
  // keys whose entitlement couldn't be checked this sweep
  unknown: string[] = [],
): Promise<number> {
  let marked = 0;
  for (const c of CAUSES) {
    let after = "";
    for (;;) {
      const { rows } = await getPool().query(
        `SELECT p.id FROM gpu_pods p WHERE ${LIVE} AND ${c.where}
            AND p.id::text > $2
          ORDER BY p.id::text LIMIT ${BATCH}`,
        c.where.includes("$3") ? [now, after, unknown] : [now, after],
      );
      for (const { id } of rows) {
        await renew();
        const row = await transition(
          id,
          { desired_state: "terminated", reason: c.reason },
          "AND desired_state <> 'terminated' AND state NOT IN ('terminated', 'failed')",
          { actor: REAPER, action: c.action, details: { cause: c.cause } },
        );
        if (row) marked += 1;
      }
      if (rows.length < BATCH) break;
      after = `${rows[rows.length - 1].id}`;
      await renew();
    }
  }
  return marked;
}

// public_ip is recorded only from a complete SSH endpoint (host, port and
// user: cloud/runpod/views.ts), so a pod with only a public IP, or none, is
// still a candidate here.
async function checkCommunitySsh(
  now: Date,
  deps: ReaperDeps,
  renew: () => Promise<void>,
): Promise<number> {
  let marked = 0;
  let after = "";
  for (;;) {
    const { rows } = await getPool().query(
      `SELECT p.* FROM gpu_pods p
        WHERE ${LIVE} AND p.state = 'running' AND p.cloud = 'COMMUNITY'
          AND p.ssh_key_fingerprint IS NOT NULL AND p.public_ip IS NULL
          AND p.running_since <= $1::timestamptz - make_interval(secs => $2)
          AND p.id::text > $3
        ORDER BY p.id::text LIMIT ${BATCH}`,
      [now, COMMUNITY_SSH_DEADLINE_MS / 1000, after],
    );
    for (const p of rows) {
      await renew();
      marked += await checkCommunityPod(p, deps);
    }
    if (rows.length < BATCH) return marked;
    after = `${rows[rows.length - 1].id}`;
    await renew();
  }
}

// 1 if the pod is marked for termination, else 0
async function checkCommunityPod(p: any, deps: ReaperDeps): Promise<number> {
  const c = await (deps.getCleanup ?? getRunpodCleanupForAccount)(
    p.key_owner_account_id,
  ).catch(() => undefined);
  if (!c || c.credential_id !== p.credential_id) return 0;
  const live = await c.getPod(p.provider_pod_id).catch(() => null);
  if (live === null) return 0; // couldn't ask: next sweep
  if (live?.sshDirect?.host && live.sshDirect.port) {
    await recordSeenAddresses(
      [{ id: p.id, provider_pod_id: p.provider_pod_id } as any],
      [live],
    );
    return 0;
  }
  const row = await transition(
    p.id,
    {
      desired_state: "terminated",
      reason:
        "No public SSH port appeared within 10 minutes on Community Cloud; try Secure Cloud.",
    },
    "AND desired_state <> 'terminated' AND state NOT IN ('terminated', 'failed')",
    {
      actor: REAPER,
      action: "terminate",
      details: { cause: "community_no_ssh" },
    },
  );
  return row ? 1 : 0;
}

// Key owners with records ready for work now (backed-off pods excluded),
// paged; each owner is passed over until its batches are short.
async function resolveOwners(
  now: Date,
  deps: ReaperDeps,
  renew: () => Promise<void>,
): Promise<{ accounts: number; complete: boolean }> {
  let accounts = 0;
  let complete = true;
  let after = "";
  const staleBefore = new Date(now.getTime() - STALE_CREATE_MS);
  for (;;) {
    const { rows } = await getPool().query(
      `SELECT DISTINCT key_owner_account_id FROM gpu_pods
        WHERE key_owner_account_id::text > $4
          AND unmanaged_at IS NULL
          AND ((state IN ('intent', 'creating') AND updated < $3)
               OR ((state = 'ambiguous'
                    OR (desired_state = 'terminated'
                        AND state IN ('running', 'stopped', 'terminating')
                        AND provider_pod_id IS NOT NULL))
                   AND (reap_after IS NULL OR reap_after <= $2)))
        ORDER BY key_owner_account_id LIMIT $1`,
      [BATCH, now, staleBefore, after],
    );
    for (const { key_owner_account_id } of rows) {
      accounts += 1;
      let drained = false;
      for (let pass = 0; pass < OWNER_PASSES; pass++) {
        await renew();
        const { full } = await resolvePendingForAccount(
          key_owner_account_id,
          deps,
          { actor: REAPER, guard: renew },
        );
        await renew();
        if (!full) {
          drained = true;
          break;
        }
      }
      if (!drained) complete = false;
    }
    if (rows.length < BATCH) return { accounts, complete };
    after = `${rows[rows.length - 1].key_owner_account_id}`;
  }
}

export async function runGpuReaperSweep(deps: ReaperDeps = {}): Promise<{
  ran: boolean;
  complete?: boolean;
  marked?: number;
  accounts?: number;
}> {
  const clock = () => new Date((deps.now ?? Date.now)());
  // the cutoff for every decision in this sweep
  const now = clock();
  const token = `${deps.holder ?? `${hostname()}:${process.pid}`}:${randomUUID()}`;
  if (!(await acquireWorkerLease("reaper", token, now))) {
    return { ran: false };
  }
  // Renewed before every record, and by a heartbeat while one record's
  // provider calls run long (an ambiguous lookup pages RunPod's pod list):
  // another sweep can take over only after this process stalls for the
  // lease's whole TTL, and then this one stops at its next record.
  let lost = false;
  const renew = async () => {
    if (lost) throw new LeaseLost("the reaper lease was lost");
    await renewWorkerLease("reaper", token, clock());
  };
  const heartbeat = setInterval(() => {
    renewWorkerLease("reaper", token, clock()).catch(() => (lost = true));
  }, deps.heartbeatMs ?? 60_000);
  heartbeat.unref?.();
  try {
    const unknown = await checkEntitlements(now, deps, renew);
    const marked =
      (await markForTermination(now, renew, unknown)) +
      (await checkCommunitySsh(now, deps, renew));
    const { accounts, complete } = await resolveOwners(now, deps, renew);
    if (lost) throw new LeaseLost("the reaper lease was lost");
    await finishWorkerLease(
      "reaper",
      token,
      clock(),
      complete ? undefined : "incomplete: an owner's pending work didn't drain",
    );
    return { ran: true, complete, marked, accounts };
  } catch (err) {
    log.error("GPU reaper sweep failed", `${err}`);
    if (!(err instanceof LeaseLost) && !lost) {
      await finishWorkerLease("reaper", token, clock(), `${err}`).catch(
        () => {},
      );
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

export function initGpuReaper(): void {
  // one sweep at a time in this hub (the lease covers other hubs)
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runGpuReaperSweep();
    } catch {
      // logged; the watermark stays put, so launches wait (fail closed)
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(run, REAPER_INTERVAL_MS).unref?.();
}
