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
admission requires (budgets.ts); a sweep that fails part-way doesn't.
*/

import { hostname } from "node:os";
import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { isGpuProviderKeysEntitled } from "@cocalc/server/gpu/provider-keys";
import {
  recordSeenAddresses,
  resolvePendingForAccount,
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

export interface ReaperDeps extends GpuPodDeps {
  holder?: string;
  isEntitled?: (account_id: string) => Promise<boolean>;
}

const REAPER: Actor = { kind: "reaper" };

export async function acquireWorkerLease(
  name: "reaper" | "reconciler",
  holder: string,
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
      WHERE name = $1 AND (holder IS NULL OR holder = $2 OR expires_at < $3)
      RETURNING name`,
    [name, holder, now, ttlMs / 1000],
  );
  return rows.length > 0;
}

async function finishWorkerLease(
  name: "reaper" | "reconciler",
  holder: string,
  now: Date,
  error?: string,
): Promise<void> {
  await getPool().query(
    error == null
      ? `UPDATE gpu_worker_leases SET last_completed_at = $3, last_error = NULL
          WHERE name = $1 AND holder = $2`
      : `UPDATE gpu_worker_leases SET last_error = $4 WHERE name = $1 AND holder = $2`,
    error == null
      ? [name, holder, now]
      : [name, holder, now, error.slice(0, 500)],
  );
}

const LIVE =
  "p.state NOT IN ('terminated', 'failed') AND p.desired_state <> 'terminated'";

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
                       AND f.entitlement_lapsed_at <= $1::timestamptz - make_interval(secs => ${LAPSE_GRACE_MS / 1000}))`,
  },
];

// Record, per key, whether its owner still has the entitlement: the 7-day
// lapse clock starts the first time it is seen missing.
async function checkEntitlements(now: Date, deps: ReaperDeps): Promise<void> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT f.credential_id, f.key_owner_account_id, f.entitlement_lapsed_at
       FROM gpu_key_fences f JOIN gpu_pods p ON p.credential_id = f.credential_id
      WHERE p.state NOT IN ('terminated', 'failed') LIMIT $1`,
    [BATCH],
  );
  for (const f of rows) {
    let entitled: boolean;
    try {
      entitled = await (deps.isEntitled ?? isGpuProviderKeysEntitled)(
        f.key_owner_account_id,
      );
    } catch {
      continue; // unknown: decide next sweep
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
  }
}

async function markForTermination(now: Date): Promise<number> {
  let marked = 0;
  for (const c of CAUSES) {
    const { rows } = await getPool().query(
      `SELECT p.id FROM gpu_pods p WHERE ${LIVE} AND ${c.where}
        ORDER BY p.deadline LIMIT ${BATCH}`,
      [now],
    );
    for (const { id } of rows) {
      const row = await transition(
        id,
        { desired_state: "terminated", reason: c.reason },
        "AND desired_state <> 'terminated' AND state NOT IN ('terminated', 'failed')",
        { actor: REAPER, action: c.action, details: { cause: c.cause } },
      );
      if (row) marked += 1;
    }
  }
  return marked;
}

async function checkCommunitySsh(now: Date, deps: ReaperDeps): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT p.* FROM gpu_pods p
      WHERE ${LIVE} AND p.state = 'running' AND p.cloud = 'COMMUNITY'
        AND p.ssh_key_fingerprint IS NOT NULL AND p.public_ip IS NULL
        AND p.running_since <= $1::timestamptz - make_interval(secs => $2)
      LIMIT ${BATCH}`,
    [now, COMMUNITY_SSH_DEADLINE_MS / 1000],
  );
  let marked = 0;
  for (const p of rows) {
    const c = await (deps.getCleanup ?? getRunpodCleanupForAccount)(
      p.key_owner_account_id,
    ).catch(() => undefined);
    if (!c || c.credential_id !== p.credential_id) continue;
    const live = await c.getPod(p.provider_pod_id).catch(() => null);
    if (live === null) continue; // couldn't ask: next sweep
    if (live?.sshDirect?.host) {
      await recordSeenAddresses(
        [{ id: p.id, provider_pod_id: p.provider_pod_id } as any],
        [live],
      );
      continue;
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
    if (row) marked += 1;
  }
  return marked;
}

export async function runGpuReaperSweep(
  deps: ReaperDeps = {},
): Promise<{ ran: boolean; marked?: number; accounts?: number }> {
  const now = new Date((deps.now ?? Date.now)());
  const holder = deps.holder ?? `${hostname()}:${process.pid}`;
  if (!(await acquireWorkerLease("reaper", holder, now))) {
    return { ran: false };
  }
  try {
    await checkEntitlements(now, deps);
    const marked =
      (await markForTermination(now)) + (await checkCommunitySsh(now, deps));
    const { rows } = await getPool().query(
      `SELECT DISTINCT key_owner_account_id FROM gpu_pods
        WHERE state IN ('intent', 'creating', 'ambiguous')
           OR (desired_state = 'terminated'
               AND state IN ('running', 'stopped', 'terminating'))
        LIMIT $1`,
      [BATCH],
    );
    for (const { key_owner_account_id } of rows) {
      await resolvePendingForAccount(key_owner_account_id, deps, {
        actor: REAPER,
      });
    }
    await finishWorkerLease("reaper", holder, now);
    return { ran: true, marked, accounts: rows.length };
  } catch (err) {
    log.error("GPU reaper sweep failed", `${err}`);
    await finishWorkerLease("reaper", holder, now, `${err}`).catch(() => {});
    throw err;
  }
}

export function initGpuReaper(): void {
  const run = () =>
    runGpuReaperSweep().catch(() => {
      // logged; the watermark stays put, so launches wait (fail closed)
    });
  void run();
  setInterval(run, REAPER_INTERVAL_MS).unref?.();
}
