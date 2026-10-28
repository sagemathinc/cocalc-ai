/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Provider billing reconciliation (step 5d-2a; ~/ops2/runpod/STEP5D2.md v6).

When a pod ends, its reservations settle at CoCalc's estimate (runtime x
its hourly rate, a little high: RunPod bills only running seconds). Once
RunPod's billing records for the pod are final, this replaces the estimate
with what RunPod billed, on every layer at once, and alerts when the bill is
well above the estimate.

- Billing is a pod fact: one claim per pod (billing_next_at, before any
  provider call), with a persisted attempt count for the backoff.
- The records count only if they prove the pod's whole billable lifetime:
  exactly one whole-hour record for every hour from running_since to
  terminated_at, stopped hours included. Anything less is "not yet"; 48 h
  after the end it's `missing`, and the estimate stays.
- The correction is idempotent (billing_state = 'estimated') and moves every
  layer's reservation together; if they disagree, nothing is applied and an
  admin alert is raised after the rollback.
*/

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { RunpodBillingRecord } from "@cocalc/cloud/runpod/views";
import { transition, type Actor, type PodRow } from "@cocalc/server/gpu/pods";
import {
  getRunpodCleanupForAccount,
  type RunpodCleanupCapability,
} from "@cocalc/server/gpu/provider-keys";
import { raiseAlert } from "@cocalc/server/gpu/alerts";
import {
  adminRecipients,
  emailAdminAboutAlert,
  projectAdminAlertEmails,
  raiseAdminAlert,
  resolveAdminAlert,
} from "@cocalc/server/gpu/admin-alerts";
import {
  acquireWorkerLease,
  every,
  finishWorkerLease,
  LeaseLost,
  renewWorkerLease,
} from "@cocalc/server/gpu/reaper";

const log = getLogger("server:gpu:billing");

const HOUR = 3_600_000;
const MINUTE = 60_000;

// RunPod's hourly records appear about 50 minutes after the hour closes
// (measured 10-27); a pod is reconciled from 40 minutes beyond that
export const BILLING_HORIZON_MS = 90 * MINUTE;
// never proven complete this long after the end: missing (estimate stays)
export const BILLING_MISSING_AFTER_MS = 48 * HOUR;
// the claim's backoff, by attempt: 1, 2, 4, then 8 hours
export function billingBackoffMs(attempt: number): number {
  return [1, 2, 4, 8][Math.min(Math.max(attempt, 1), 4) - 1] * HOUR;
}

export const BILLING_INTERVAL_MS = 10 * MINUTE;
export const BILLING_KEY_PASS_MS = 30_000;
export const BILLING_SWEEP_MS = 90_000;
export const BILLING_CONCURRENCY = 4;
export const BILLING_PODS_PER_PASS = 50;
// the billing client gives up on one call after this
export const BILLING_CALL_MS = 5_000;

// Drift: a warning above estimate x 1.10 + $0.50; critical (and the key's
// safety pause) above estimate x 1.50 + $5.
export const DRIFT_WARNING = { ratio: "1.10", plus: "0.50" };
export const DRIFT_CRITICAL = { ratio: "1.50", plus: "5" };

const BILLING_ACTOR: Actor = { kind: "billing" };

export type BillingCapability = Pick<
  RunpodCleanupCapability,
  "credential_id" | "listPodBilling"
>;

export interface BillingDeps {
  now?: () => number;
  getBilling?: (account_id: string) => Promise<BillingCapability | undefined>;
  guard?: () => Promise<void>;
}

const floorHour = (t: number) => Math.floor(t / HOUR) * HOUR;
const ceilHour = (t: number) => Math.ceil(t / HOUR) * HOUR;

export type BillingProof =
  | { kind: "complete"; billed_usd: string }
  | { kind: "incomplete"; missing_hours: number }
  | { kind: "invalid"; why: string };

// Whether RunPod's records prove the pod's whole billable lifetime
// [running_since, terminated_at], stopped hours included: exactly one
// whole-hour record for every hour overlapping it, and nothing else.
export function proveBilling(
  records: RunpodBillingRecord[],
  { podId, from, to }: { podId: string; from: Date; to: Date },
): BillingProof {
  const start = floorHour(from.getTime());
  const end = Math.max(ceilHour(to.getTime()), start + HOUR);
  const expected = new Set<number>();
  for (let h = start; h < end; h += HOUR) expected.add(h);
  const seen = new Map<number, RunpodBillingRecord>();
  for (const r of records) {
    if (r.podId !== podId) return { kind: "invalid", why: "another pod" };
    const s = Date.parse(r.startTime);
    const e = Date.parse(r.endTime);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      return { kind: "invalid", why: "unreadable time" };
    }
    if (s % HOUR !== 0 || e - s !== HOUR) {
      return { kind: "invalid", why: "not one whole hour" };
    }
    if (!expected.has(s))
      return { kind: "invalid", why: "outside the pod's lifetime" };
    if (seen.has(s))
      return { kind: "invalid", why: "two records for one hour" };
    seen.set(s, r);
  }
  const missing = [...expected].filter((h) => !seen.has(h)).length;
  if (missing > 0) return { kind: "incomplete", missing_hours: missing };
  let total = toDecimal(0);
  for (const r of seen.values()) total = total.plus(r.totalAmount);
  return { kind: "complete", billed_usd: moneyToDbString(total) };
}

class BillingInconsistent extends Error {}

// The ended incarnation a pass claimed: still ended, at the same time. A
// pod bound back or revived since is another incarnation, and the pass's
// result is stale (a no-op, never an inconsistency).
function sameEnd(pod: PodRow): string {
  return `AND state IN ('terminated', 'failed') AND terminated_at = '${new Date(
    pod.terminated_at!,
  ).toISOString()}'::timestamptz`;
}

// Apply a complete bill to every layer's settled reservation of the pod, in
// one transaction under the budget locks (transition takes them). Throws
// BillingInconsistent (nothing applied) when the layers disagree.
async function applyBilling(
  pod: PodRow,
  billed_usd: string,
): Promise<{ applied: boolean; estimate_usd?: string }> {
  const details: Record<string, unknown> = { billed_usd };
  let estimate_usd: string | undefined;
  const row = await transition(
    pod.id,
    {
      billing_state: "billed",
      billed_at: new Date(),
      billed_usd,
    },
    `AND billing_state = 'estimated' ${sameEnd(pod)}`,
    { actor: BILLING_ACTOR, action: "billed", details },
    {
      after: async (db, b) => {
        const { rows: rs } = await db.query(
          `SELECT r.*, l.authorized_usd, l.key_owner_account_id
             FROM gpu_pod_reservations r JOIN gpu_budget_layers l ON l.id = r.layer_id
            WHERE r.pod_id = $1 ORDER BY r.id`,
          [b.id],
        );
        // no reservation at all is malformed state, not a free pod
        if (rs.length === 0) {
          throw new BillingInconsistent("the pod has no reservations");
        }
        if (rs.some((r: any) => r.state !== "settled")) {
          throw new BillingInconsistent("not every reservation is settled");
        }
        const spent = new Set(
          rs.map((r: any) => toDecimal(r.spent_usd).toString()),
        );
        if (spent.size > 1) {
          throw new BillingInconsistent(
            "the layers disagree on the pod's spend",
          );
        }
        const billed = toDecimal(billed_usd);
        estimate_usd = rs[0] ? moneyToDbString(rs[0].spent_usd) : "0";
        details.estimate_usd = estimate_usd;
        for (const r of rs) {
          const delta = billed.minus(r.spent_usd);
          const reserved = toDecimal(r.reserved_usd);
          await db.query(
            `UPDATE gpu_pod_reservations
                SET spent_usd = $2, released_usd = $3, overrun_usd = $4, updated = now()
              WHERE id = $1`,
            [
              r.id,
              moneyToDbString(billed),
              moneyToDbString(reserved.gt(billed) ? reserved.minus(billed) : 0),
              moneyToDbString(billed.gt(reserved) ? billed.minus(reserved) : 0),
            ],
          );
          const { rows: layer } = await db.query(
            `UPDATE gpu_budget_layers SET spent_usd = spent_usd + $2, updated = now()
              WHERE id = $1 RETURNING id, spent_usd, authorized_usd, scope_kind`,
            [r.layer_id, moneyToDbString(delta)],
          );
          // billing pushed this layer past what it authorizes
          if (
            layer[0] &&
            toDecimal(layer[0].spent_usd).gt(layer[0].authorized_usd)
          ) {
            await raiseAlert(
              {
                key_owner_account_id: b.key_owner_account_id,
                credential_id: b.credential_id,
                kind: "over_budget",
                severity: "warning",
                dedupe_key: `layer:${layer[0].id}`,
                details: {
                  layer_id: layer[0].id,
                  scope_kind: layer[0].scope_kind,
                  spent_usd: moneyToDbString(layer[0].spent_usd),
                  authorized_usd: moneyToDbString(layer[0].authorized_usd),
                },
                observed_at: new Date(),
              },
              db,
            );
          }
        }
        await drift(db, b, toDecimal(estimate_usd), billed);
        // billed after all: an earlier inconsistency about it is over
        await resolveAdminAlert(
          {
            kind: "billing_inconsistent",
            dedupe_key: b.id,
            resolved_by: "billing",
          },
          db,
        );
      },
    },
  );
  return { applied: row != null, estimate_usd };
}

// Billing well above the estimate: the owner is told; far above, launches
// with the key pause (only while its fence is live; the budget locks hold
// the fence row here).
async function drift(
  db: PoolClient,
  pod: PodRow,
  estimate: ReturnType<typeof toDecimal>,
  billed: ReturnType<typeof toDecimal>,
): Promise<void> {
  const over = (t: { ratio: string; plus: string }) =>
    billed.gt(estimate.times(t.ratio).plus(t.plus));
  const critical = over(DRIFT_CRITICAL);
  if (!critical && !over(DRIFT_WARNING)) return;
  await raiseAlert(
    {
      key_owner_account_id: pod.key_owner_account_id,
      credential_id: pod.credential_id,
      kind: "spend_drift",
      severity: critical ? "critical" : "warning",
      dedupe_key: pod.id,
      details: {
        pod_id: pod.id,
        handle: pod.handle,
        provider_pod_id: pod.provider_pod_id,
        billed_usd: moneyToDbString(billed),
        estimate_usd: moneyToDbString(estimate),
      },
      observed_at: new Date(),
    },
    db,
  );
  if (critical) {
    await db.query(
      `UPDATE gpu_key_fences SET paused_reason = 'spend_drift', paused_at = now(), updated = now()
        WHERE credential_id = $1 AND paused_reason IS NULL AND state IN ('active', 'draining')`,
      [pod.credential_id],
    );
  }
}

// The pods of one key that billing may look at now, oldest end first.
async function duePods(credential_id: string, now: Date, limit: number) {
  const { rows } = await getPool().query(
    `SELECT p.* FROM gpu_pods p
      WHERE p.credential_id = $1 AND p.billing_state = 'estimated'
        AND p.provider_pod_id IS NOT NULL AND p.state IN ('terminated', 'failed')
        AND p.terminated_at IS NOT NULL
        AND date_trunc('hour', p.terminated_at) + interval '1 hour'
            + make_interval(secs => $3) <= $2
        AND (p.billing_next_at IS NULL OR p.billing_next_at <= $2)
      ORDER BY p.terminated_at LIMIT $4`,
    [credential_id, now, BILLING_HORIZON_MS / 1000, limit],
  );
  return rows as PodRow[];
}

// Claim one pod for this attempt, before any provider call: the cursor
// moves to the next backoff and the attempt is counted. Undefined if
// another worker claimed it (or it was billed) meanwhile.
async function claimPod(pod: PodRow, now: Date): Promise<PodRow | undefined> {
  const attempt = Number((pod as any).billing_attempts ?? 0) + 1;
  const { rows } = await getPool().query(
    `UPDATE gpu_pods
        SET billing_attempts = billing_attempts + 1,
            billing_next_at = $2::timestamptz + make_interval(secs => $3)
      WHERE id = $1 AND billing_state = 'estimated'
        AND (billing_next_at IS NULL OR billing_next_at <= $2)
        AND state IN ('terminated', 'failed') AND terminated_at = $4
      RETURNING *`,
    [pod.id, now, billingBackoffMs(attempt) / 1000, pod.terminated_at],
  );
  return rows[0];
}

export interface BillingOutcome {
  claimed: number;
  billed: number;
  missing: number;
  not_yet: number;
  invalid: number;
  cut?: boolean;
}

class PassCut extends Error {}

// One bounded pass over one key's due pods.
export async function reconcileKeyBilling(
  {
    credential_id,
    key_owner_account_id,
    deadline,
  }: { credential_id: string; key_owner_account_id: string; deadline: number },
  deps: BillingDeps = {},
): Promise<BillingOutcome> {
  const clock = deps.now ?? Date.now;
  const out: BillingOutcome = {
    claimed: 0,
    billed: 0,
    missing: 0,
    not_yet: 0,
    invalid: 0,
  };
  const bounded = async () => {
    await deps.guard?.();
    if (clock() >= deadline) throw new PassCut("billing pass deadline");
  };
  const pods = await duePods(
    credential_id,
    new Date(clock()),
    BILLING_PODS_PER_PASS,
  );
  if (pods.length === 0) return out;
  let c: BillingCapability | undefined;
  try {
    c = await (
      deps.getBilling ??
      ((a: string) =>
        getRunpodCleanupForAccount(a, { runpodTimeoutMs: BILLING_CALL_MS }))
    )(key_owner_account_id);
  } catch {
    c = undefined;
  }
  // a key CoCalc no longer holds (or another key now) can't be asked
  if (c && c.credential_id !== credential_id) c = undefined;
  // every RunPod call ends with the pass's time
  const within = <T>(call: Promise<T>): Promise<T> => {
    const left = deadline - clock();
    call.catch(() => {});
    if (left <= 0) return Promise.reject(new PassCut("billing pass deadline"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PassCut("billing pass deadline")),
        left,
      );
      timer.unref?.();
    });
    return Promise.race([call, cut]).finally(() => clearTimeout(timer));
  };
  try {
    for (const due of pods) {
      await bounded();
      const now = new Date(clock());
      const pod = await claimPod(due, now);
      if (!pod) continue;
      out.claimed += 1;
      const ended = new Date(pod.terminated_at!);
      const tooLate =
        now.getTime() >= ended.getTime() + BILLING_MISSING_AFTER_MS;
      let proof: BillingProof = { kind: "incomplete", missing_hours: -1 };
      if (c) {
        const from = new Date(pod.running_since ?? pod.created);
        const records = await within(
          c.listPodBilling({
            podId: pod.provider_pod_id!,
            bucketSize: "hour",
            startTime: new Date(floorHour(from.getTime())).toISOString(),
            endTime: new Date(
              Math.max(
                ceilHour(ended.getTime()),
                floorHour(from.getTime()) + HOUR,
              ),
            ).toISOString(),
          }),
        ).catch((err) => {
          if (err instanceof PassCut) throw err;
          log.debug("reading a pod's billing failed", `${err}`);
          return undefined;
        });
        // an answer that came back after the pass's time is not acted on
        await bounded();
        if (records) {
          proof = proveBilling(records, {
            podId: pod.provider_pod_id!,
            from,
            to: ended,
          });
        }
      }
      if (proof.kind === "complete") {
        try {
          if ((await applyBilling(pod, proof.billed_usd)).applied)
            out.billed += 1;
        } catch (err) {
          if (!(err instanceof BillingInconsistent)) throw err;
          // rolled back; the alert is written on its own, after
          out.invalid += 1;
          await raiseAdminAlert({
            kind: "billing_inconsistent",
            severity: "critical",
            dedupe_key: pod.id,
            key_owner_account_id: pod.key_owner_account_id,
            credential_id: pod.credential_id,
            details: { pod_id: pod.id, why: err.message },
          });
        }
        continue;
      }
      if (proof.kind === "invalid") {
        out.invalid += 1;
        await raiseAdminAlert({
          kind: "billing_inconsistent",
          severity: "warning",
          dedupe_key: pod.id,
          key_owner_account_id: pod.key_owner_account_id,
          credential_id: pod.credential_id,
          details: { pod_id: pod.id, why: proof.why },
        });
      }
      if (tooLate) {
        if (await markMissing(pod)) out.missing += 1;
      } else if (proof.kind === "incomplete") {
        out.not_yet += 1;
      }
    }
  } catch (err) {
    if (err instanceof PassCut) return { ...out, cut: true };
    throw err;
  }
  return out;
}

// Never proven within 48 h: the estimate stays as the pod's spend, and the
// owner is told once per key.
async function markMissing(pod: PodRow): Promise<boolean> {
  // the state and the owner's alert commit together (false: a stale pass)
  const marked = await transition(
    pod.id,
    { billing_state: "missing" },
    `AND billing_state = 'estimated' ${sameEnd(pod)}`,
    { actor: BILLING_ACTOR, action: "billed", details: { missing: true } },
    {
      after: async (db) => {
        await raiseAlert(
          {
            key_owner_account_id: pod.key_owner_account_id,
            credential_id: pod.credential_id,
            kind: "billing_missing",
            severity: "warning",
            dedupe_key: "key",
            details: { latest_pod_id: pod.id, handle: pod.handle },
            observed_at: new Date(),
          },
          db,
        );
      },
    },
  );
  return marked != null;
}

// The earliest settlement time in [since, until) among the owner's
// key-layer reservations whose pod billing hasn't resolved yet, or `until`:
// everything settled before it is billed, missing or n/a.
export async function billedThrough(
  key_owner_account_id: string,
  since: Date,
  until: Date,
): Promise<Date> {
  const { rows } = await getPool().query(
    `SELECT MIN(r.settled_at) AS first FROM gpu_pod_reservations r
       JOIN gpu_budget_layers l ON l.id = r.layer_id AND l.scope_kind = 'key'
       JOIN gpu_pods p ON p.id = r.pod_id
      WHERE l.key_owner_account_id = $1 AND r.state = 'settled'
        AND r.settled_at >= $2 AND r.settled_at < $3
        AND p.billing_state = 'estimated' AND p.provider_pod_id IS NOT NULL`,
    [key_owner_account_id, since, until],
  );
  return rows[0]?.first ? new Date(rows[0].first) : until;
}

// ---- the sweep ----

export interface BillingSweepDeps extends BillingDeps {
  holder?: string;
  heartbeatMs?: number;
  keyPassMs?: number;
  sweepMs?: number;
  concurrency?: number;
}

async function dueKeys(now: Date) {
  const { rows } = await getPool().query(
    `SELECT credential_id, key_owner_account_id, MIN(terminated_at) AS oldest
       FROM gpu_pods
      WHERE billing_state = 'estimated' AND provider_pod_id IS NOT NULL
        AND state IN ('terminated', 'failed') AND terminated_at IS NOT NULL
        AND date_trunc('hour', terminated_at) + interval '1 hour'
            + make_interval(secs => $2) <= $1
        AND (billing_next_at IS NULL OR billing_next_at <= $1)
      GROUP BY credential_id, key_owner_account_id
      ORDER BY oldest LIMIT 1000`,
    [now, BILLING_HORIZON_MS / 1000],
  );
  return rows as { credential_id: string; key_owner_account_id: string }[];
}

export async function runBillingSweep(
  deps: BillingSweepDeps = {},
): Promise<{ ran: boolean; keys?: number; billed?: number }> {
  const clock = deps.now ?? Date.now;
  const at = () => new Date(clock());
  const token = `${deps.holder ?? `${hostname()}:${process.pid}`}:${randomUUID()}`;
  if (!(await acquireWorkerLease("billing", token, at())))
    return { ran: false };
  let lost = false;
  const renew = async () => {
    if (lost) throw new LeaseLost("the billing lease was lost");
    await renewWorkerLease("billing", token, at());
  };
  const heartbeat = setInterval(() => {
    renewWorkerLease("billing", token, at()).catch(() => (lost = true));
  }, deps.heartbeatMs ?? 60_000);
  heartbeat.unref?.();
  const sweepDeadline = clock() + (deps.sweepMs ?? BILLING_SWEEP_MS);
  const keyPassMs = deps.keyPassMs ?? BILLING_KEY_PASS_MS;
  let keys = 0;
  let billed = 0;
  try {
    const queue = await dueKeys(at());
    let next = 0;
    const worker = async () => {
      while (next < queue.length && clock() + keyPassMs <= sweepDeadline) {
        const k = queue[next++];
        await renew();
        keys += 1;
        try {
          const r = await reconcileKeyBilling(
            { ...k, deadline: clock() + keyPassMs },
            { ...deps, guard: renew },
          );
          billed += r.billed;
        } catch (err) {
          if (err instanceof LeaseLost || lost) throw err;
          log.warn("a billing pass failed", `${err}`);
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            deps.concurrency ?? BILLING_CONCURRENCY,
            queue.length,
          ),
        },
        worker,
      ),
    );
    await finishWorkerLease("billing", token, at(), undefined, {
      keys,
      billed,
    });
    return { ran: true, keys, billed };
  } catch (err) {
    log.error("GPU billing sweep failed", `${err}`);
    if (!(err instanceof LeaseLost) && !lost) {
      await finishWorkerLease("billing", token, at(), `${err}`).catch(() => {});
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

export function initGpuBilling(): void {
  every("billing", () => runBillingSweep(), BILLING_INTERVAL_MS);
  // admin alerts' email projection (every bay's hub: the rows are local)
  every(
    "admin-alert-email",
    () =>
      projectAdminAlertEmails({
        recipients: adminRecipients,
        send: emailAdminAboutAlert,
      }),
    5 * MINUTE,
  );
}
