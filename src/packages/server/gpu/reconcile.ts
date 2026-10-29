/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The inventory reconciler (step 5d-1; ~/ops2/runpod/STEP5D.md v2.5).

Per key, one bounded pass compares RunPod's inventory with CoCalc's records.
It reads RunPod (listPods, getPod) and records; it never asks RunPod to
terminate anything (its capability can't), and never ends, releases or
resolves anything because a listing didn't show it:

- a listed pod CoCalc doesn't know is an unknown_pod (critical, and the key's
  launches pause until the owner resumes);
- a listed pod named exactly like an ambiguous or quarantined record's handle
  is that record's pod, live: it is bound back (reconcileBindPod);
- a bound, unfinished record whose pod the listing didn't show is checked by
  id: only RunPod's 404 ends it (through the normal terminated path);
- a complete pass moves the key's inventory watermark, which launches need.

Every write carries the pass's observed_at (when its listing started): the
watermark and an alert's last sighting only move forward, and an outcome or
a resolution applies only if no newer pass recorded one, so passes that
overlap (another hub, the request-time pass at connect) are safe.
*/

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { RunpodApiError } from "@cocalc/cloud/runpod/client";
import type { RunpodPodView } from "@cocalc/util/gpu/runpod";
import {
  endPodGoneAtProvider,
  reviveEndedPod,
  podSummary,
  reconcileBindPod,
  recordSeenAddresses,
  type Actor,
  type PodRow,
} from "@cocalc/server/gpu/pods";
import {
  getRunpodCleanupForAccount,
  type RunpodCleanupCapability,
} from "@cocalc/server/gpu/provider-keys";
import { sanitizeProviderName } from "@cocalc/server/gpu/key-events";
import {
  raiseAlert,
  resolveAlert,
  underLiveFence,
} from "@cocalc/server/gpu/alerts";
import {
  INVENTORY_STALE_MS,
  setInventoryWaker,
} from "@cocalc/server/gpu/budgets";
import { watchProviderAccount } from "@cocalc/server/gpu/account-watch";
import {
  acquireWorkerLease,
  every,
  finishWorkerLease,
  LeaseLost,
  renewWorkerLease,
} from "@cocalc/server/gpu/reaper";

const log = getLogger("server:gpu:reconcile");

export const RECONCILE_INTERVAL_MS = 2 * 60_000;
// one key's pass, and a whole sweep (the next sweep continues: most stale
// first)
export const RECONCILE_KEY_PASS_MS = 30_000;
export const RECONCILE_SWEEP_MS = 90_000;
export const RECONCILE_CONCURRENCY = 8;
// the sweep's RunPod client gives up on one call after this (a pass's own
// time ends a call sooner; this ends the abandoned request too)
export const RECONCILE_CALL_MS = 5_000;
export { INVENTORY_STALE_MS };
// the admin backlog signal opens before keys start refusing
export const RECONCILE_BACKLOG_MS = 15 * 60_000;
// after a complete pass, the key is due again in
const RECONCILE_EVERY_MS = 10 * 60_000;

// after the n-th failed attempt in a row: 2, 4, 8, 16, 30, 30, ... minutes
export function reconcileBackoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(1, attempts), 30) * 60_000;
}

const RECONCILER: Actor = { kind: "reconciler" };

// All the reconciler may do with a key: read. (Not terminate.)
export type ReconcileCapability = Pick<
  RunpodCleanupCapability,
  "credential_id" | "listPods" | "getPod"
> &
  // the account checks (5d-2b), for a confirmed account
  Partial<Pick<RunpodCleanupCapability, "getAccountBalance">>;

export interface ReconcileDeps {
  now?: () => number;
  getReconcile?: (
    account_id: string,
  ) => Promise<ReconcileCapability | undefined>;
  // the sweep's lease renewal (request-time passes have none)
  guard?: () => Promise<void>;
}

export interface ReconcileOutcome {
  // false: another pass recorded a newer attempt, or the key isn't eligible
  claimed: boolean;
  complete?: boolean;
  // why an attempt didn't complete
  cut?: boolean;
  rejected?: boolean;
  failed?: boolean;
  unknown_pods?: number;
}

class PassCut extends Error {}

// An unknown pod's alert is keyed by its RunPod id, which a later pass checks
// by id to resolve it. An id that isn't safe to keep as is gets a key no
// check ever resolves (it stays open for the owner to look at).
const UNCHECKABLE = "uncheckable-id";
// (the grammar getPod accepts)
function podAlertKey(id: string): string {
  return /^[A-Za-z0-9_-]{6,64}$/.test(id) && id !== UNCHECKABLE
    ? id
    : UNCHECKABLE;
}

// One bounded pass over one key. `deadline` is absolute (ms): the sweep's
// per-key bound, or a request's, counted from the start of the request.
export async function reconcileKey(
  {
    credential_id,
    key_owner_account_id,
    deadline,
  }: { credential_id: string; key_owner_account_id: string; deadline: number },
  deps: ReconcileDeps = {},
): Promise<ReconcileOutcome> {
  const clock = deps.now ?? Date.now;
  const observed_at = new Date(clock());
  // Claim the attempt before any provider call: the pessimistic outcome (a
  // backoff) is recorded first, so a crash or a stuck pass leaves the key
  // rotated back, not at the head of the queue; a newer attempt wins.
  const { rows: claimed } = await getPool().query(
    `UPDATE gpu_key_fences
        SET last_reconcile_attempt_at = $2,
            next_reconcile_at = $2::timestamptz + make_interval(secs => $3),
            updated = now()
      WHERE credential_id = $1 AND state IN ('active', 'draining')
        AND (last_reconcile_attempt_at IS NULL OR last_reconcile_attempt_at < $2)
      RETURNING reconcile_attempts`,
    [credential_id, observed_at, reconcileBackoffMs(1) / 1000],
  );
  if (!claimed[0]) return { claimed: false };
  const attempts = Number(claimed[0].reconcile_attempts ?? 0);
  const bounded = async () => {
    await deps.guard?.();
    if (clock() >= deadline) throw new PassCut("reconcile pass deadline");
  };
  const fail = async (outcome: ReconcileOutcome) => {
    await recordOutcome(credential_id, observed_at, {
      next: new Date(observed_at.getTime() + reconcileBackoffMs(attempts + 1)),
      attempts: attempts + 1,
    });
    return outcome;
  };
  let key: ReconcileCapability | undefined;
  try {
    key = await (
      deps.getReconcile ??
      ((a: string) =>
        getRunpodCleanupForAccount(a, { runpodTimeoutMs: RECONCILE_CALL_MS }))
    )(key_owner_account_id);
  } catch {
    return await fail({ claimed: true, failed: true });
  }
  // no stored key, or another key now: nothing to reconcile with this one
  if (!key || key.credential_id !== credential_id) {
    return await fail({ claimed: true, failed: true });
  }
  // Every RunPod call ends with the pass's time: one still unanswered when
  // it runs out cuts the pass (the guards around it only check between
  // calls). The client's own per-call timeout ends the abandoned request.
  const raw = key;
  const within = <T>(call: Promise<T>): Promise<T> => {
    const left = deadline - clock();
    if (left <= 0) {
      call.catch(() => {});
      return Promise.reject(new PassCut("reconcile pass deadline"));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PassCut("reconcile pass deadline")),
        left,
      );
      timer.unref?.();
    });
    call.catch(() => {});
    return Promise.race([call, cut]).finally(() => clearTimeout(timer));
  };
  const c: ReconcileCapability = {
    credential_id,
    listPods: (opts) => within(raw.listPods(opts)),
    getPod: (id) => within(raw.getPod(id)),
  };
  try {
    await bounded();
    // Read-only: nothing is terminated while it pages. What a page shows
    // is acted on as it arrives (a sighting needs no complete listing), so
    // a slow or flooded account still raises its alerts; only what needs
    // the whole inventory waits (a handle's pod: bind, or duplicates).
    const k = { credential_id, key_owner_account_id, observed_at };
    let unknown = 0;
    const listed = await c.listPods({
      beforePage: bounded,
      onPage: async (page) => {
        await bounded();
        unknown += await matchInventory(k, page, bounded, "sightings", {
          c,
          now: () => new Date(clock()),
        });
      },
    });
    // the last page may have come back after the pass's time ran out
    await bounded();
    // Everything after the listing is bounded too: each pod's action, and
    // the end (a large inventory, or a lost lease, stops the pass here).
    unknown += await matchInventory(k, listed, bounded, "handles");
    await confirmAbsences(
      { credential_id, key_owner_account_id, observed_at },
      c,
      new Set(listed.map((p) => p.id)),
      bounded,
      () => new Date(clock()),
    );
    await bounded();
    // complete: the watermark moves (forward only), and so does the cursor
    await getPool().query(
      `UPDATE gpu_key_fences
          SET last_inventory_at = GREATEST(COALESCE(last_inventory_at, $2), $2),
              updated = now()
        WHERE credential_id = $1`,
      [credential_id, observed_at],
    );
    await recordOutcome(credential_id, observed_at, {
      next: new Date(observed_at.getTime() + RECONCILE_EVERY_MS),
      attempts: 0,
    });
    // The account checks, in what is left of the pass (only for an account
    // its owner confirmed). A failure here never undoes the inventory.
    const balance = raw.getAccountBalance;
    if (balance) {
      try {
        await bounded();
        await watchProviderAccount(
          { credential_id, key_owner_account_id },
          {
            getAccountBalance: () => within(raw.getAccountBalance!()),
            guard: deps.guard,
            now: clock,
          },
        );
      } catch (err) {
        if (err instanceof LeaseLost) throw err;
        // RunPod rejects the key itself: the rejected-key handling below
        if (err instanceof RunpodApiError && err.kind === "auth") throw err;
        if (!(err instanceof PassCut)) {
          log.warn("checking a RunPod account failed", `${err}`);
        }
      }
    }
    // the reconciliation capability works: a rejected-key alert ends (after
    // the account checks, whose 401 would say otherwise; and only while this
    // worker still holds its lease, which a RunPod call may have outlasted)
    await deps.guard?.();
    await underLiveFence(credential_id, (db) =>
      resolveAlert(
        {
          credential_id,
          kind: "key_rejected",
          observed_at,
          by: "complete_inventory",
        },
        db,
      ),
    );
    return { claimed: true, complete: true, unknown_pods: unknown };
  } catch (err) {
    if (err instanceof PassCut) return await fail({ claimed: true, cut: true });
    if (
      err instanceof RunpodApiError &&
      (err.kind === "auth" || err.kind === "forbidden")
    ) {
      // (nothing, if the key was removed or replaced meanwhile)
      await underLiveFence(credential_id, async (db) => {
        const raised = await raiseAlert(
          {
            key_owner_account_id,
            credential_id,
            kind: "key_rejected",
            severity: "critical",
            dedupe_key: "key",
            details: { status: err.kind === "auth" ? 401 : 403 },
            observed_at,
          },
          db,
        );
        if (raised) await pauseKey(credential_id, "key_rejected", db);
      });
      return await fail({ claimed: true, rejected: true });
    }
    // a lost lease: the next holder continues
    if (!(err instanceof RunpodApiError)) {
      await fail({ claimed: true, failed: true }).catch(() => {});
      throw err;
    }
    log.warn("reconciling a GPU key failed", `${err}`);
    return await fail({ claimed: true, failed: true });
  }
}

// An attempt's outcome, unless a newer attempt recorded one.
async function recordOutcome(
  credential_id: string,
  observed_at: Date,
  { next, attempts }: { next: Date; attempts: number },
): Promise<void> {
  await getPool().query(
    `UPDATE gpu_key_fences
        SET next_reconcile_at = $3, reconcile_attempts = $4, updated = now()
      WHERE credential_id = $1 AND last_reconcile_attempt_at <= $2`,
    [credential_id, observed_at, next, attempts],
  );
}

// The safety pause: admission refuses until the owner resumes (fresh auth).
async function pauseKey(
  credential_id: string,
  reason: string,
  db: Pick<PoolClient, "query">,
): Promise<void> {
  await db.query(
    `UPDATE gpu_key_fences SET paused_reason = $2, paused_at = now(), updated = now()
      WHERE credential_id = $1 AND paused_reason IS NULL
        AND state IN ('active', 'draining')`,
    [credential_id, reason],
  );
}

// What each listed pod is. Records are read after the listing, so a pod
// bound meanwhile is matched by id; a create still in flight (its handle
// on an intent or creating record) is not unknown. Returns how many
// unknown pods it saw.
async function matchInventory(
  {
    credential_id,
    key_owner_account_id,
    observed_at,
  }: {
    credential_id: string;
    key_owner_account_id: string;
    observed_at: Date;
  },
  listed: RunpodPodView[],
  bounded: () => Promise<void>,
  // "sightings": one page, as it arrives: pods bound by id, and pods no
  // record knows (by id or handle). "handles": the complete listing's pods
  // named like a record's handle (bind, duplicates, creates in flight).
  part: "sightings" | "handles",
  // for "sightings": asking RunPod about a listed pod CoCalc recorded as ended
  check?: { c: ReconcileCapability; now: () => Date },
): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods WHERE credential_id = $1
        AND (provider_pod_id = ANY($2) OR handle = ANY($3))`,
    [credential_id, listed.map((p) => p.id), listed.map((p) => p.name ?? "")],
  );
  // Every listed pod CoCalc has bound was seen live at observed_at: one
  // statement, forward only. A "not found" asked before this can't end it.
  if (part === "sightings")
    await getPool().query(
      `UPDATE gpu_pods SET provider_seen_at = GREATEST(COALESCE(provider_seen_at, $3), $3)
      WHERE credential_id = $1 AND provider_pod_id = ANY($2)`,
      [credential_id, listed.map((p) => p.id), observed_at],
    );
  const byProviderId = new Map<string, PodRow>();
  const byHandle = new Map<string, PodRow>();
  for (const r of rows as PodRow[]) {
    if (r.provider_pod_id) byProviderId.set(r.provider_pod_id, r);
    byHandle.set(r.handle, r);
  }
  // how many listed pods carry each handle (one name, normally one pod)
  const handleCount = new Map<string, number>();
  for (const p of listed) {
    if (p.name) handleCount.set(p.name, (handleCount.get(p.name) ?? 0) + 1);
  }
  let unknown = 0;
  const seen: RunpodPodView[] = [];
  for (const pod of listed) {
    if (byProviderId.has(pod.id)) {
      if (part === "sightings") seen.push(pod);
      continue;
    }
    const record = pod.name ? byHandle.get(pod.name) : undefined;
    // a pod named like a record waits for the complete listing; any other
    // is decided on its page
    if ((record != null) !== (part === "handles")) continue;
    if (record && !record.provider_pod_id) {
      if (record.state === "intent" || record.state === "creating") {
        // its create is still in flight: the launch binds it
        continue;
      }
      if (
        (record.state === "ambiguous" || record.state === "failed") &&
        handleCount.get(pod.name!) === 1
      ) {
        await bounded();
        const { row, released } = await reconcileBindPod(
          record,
          pod,
          RECONCILER,
          observed_at,
        );
        if (row && released) {
          // its holds had been released: spend went unaccounted meanwhile
          await underLiveFence(credential_id, async (db) => {
            await raiseAlert(
              {
                key_owner_account_id,
                credential_id,
                kind: "unknown_pod",
                severity: "critical",
                dedupe_key: podAlertKey(pod.id),
                details: {
                  provider_pod_id: podAlertKey(pod.id),
                  handle: record.handle,
                  released_then_seen: true,
                },
                observed_at,
              },
              db,
            );
            // bound just now: it is live, whatever any alert says
            await pauseKey(credential_id, "unknown_pod", db);
          });
        }
        continue;
      }
    }
    // a pod CoCalc didn't start (or more than one under a record's handle)
    unknown += 1;
    await bounded();
    // only while the key is live; not if a newer pass showed it gone
    await underLiveFence(credential_id, async (db) => {
      const raised = await raiseAlert(
        {
          key_owner_account_id,
          credential_id,
          kind: "unknown_pod",
          severity: "critical",
          dedupe_key: podAlertKey(pod.id),
          details: {
            provider_pod_id: podAlertKey(pod.id),
            name: sanitizeProviderName(pod.name),
          },
          observed_at,
        },
        db,
      );
      if (raised) await pauseKey(credential_id, "unknown_pod", db);
    });
  }
  // Listed, but CoCalc recorded it as ended: a listing may lag a
  // termination, so RunPod is asked by id. Only a live answer, newer than
  // the end, makes it CoCalc's again (to terminate, its budget held again).
  if (part === "sightings" && check) {
    for (const pod of seen) {
      const row = byProviderId.get(pod.id)!;
      if (row.state !== "terminated" || row.unmanaged_at) continue;
      await bounded();
      const asked = check.now();
      const live = await check.c.getPod(pod.id);
      await bounded();
      // (a stopped pod still exists, and bills; a TERMINATED one doesn't)
      if (live !== undefined && live.status !== "TERMINATED") {
        await reviveEndedPod(row, RECONCILER, asked);
      }
    }
  }
  if (seen.length > 0) {
    await bounded();
    await recordSeenAddresses(
      seen.map((p) => podSummary(byProviderId.get(p.id)!)),
      seen,
    );
  }
  return unknown;
}

// Bound, unfinished records the listing didn't show, and open unknown-pod
// alerts whose pod it didn't show: a listing proves nothing, so each is
// checked by id. Only RunPod's 404 ends the record or the alert, and only if
// nothing saw it live after it was asked; a pod RunPod still has is a
// sighting like a listed one (an unknown pod's alert and pause are renewed).
async function confirmAbsences(
  {
    credential_id,
    key_owner_account_id,
  }: { credential_id: string; key_owner_account_id: string; observed_at: Date },
  c: ReconcileCapability,
  present: Set<string>,
  bounded: () => Promise<void>,
  now: () => Date,
): Promise<void> {
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods WHERE credential_id = $1 AND provider_pod_id IS NOT NULL
        AND state IN ('running', 'stopped', 'terminating') AND unmanaged_at IS NULL`,
    [credential_id],
  );
  for (const row of rows as PodRow[]) {
    if (present.has(row.provider_pod_id!)) continue;
    await bounded();
    const asked = now();
    const pod = await c.getPod(row.provider_pod_id!);
    // an answer that came back after the pass's time is not acted on
    await bounded();
    if (pod === undefined) {
      await endPodGoneAtProvider(row, RECONCILER, asked);
    } else {
      await getPool().query(
        `UPDATE gpu_pods SET provider_seen_at = GREATEST(COALESCE(provider_seen_at, $2), $2)
          WHERE id = $1`,
        [row.id, asked],
      );
    }
  }
  const { rows: alerts } = await getPool().query(
    `SELECT dedupe_key, details FROM gpu_alerts WHERE credential_id = $1
        AND kind = 'unknown_pod' AND resolved_at IS NULL`,
    [credential_id],
  );
  for (const a of alerts) {
    if (present.has(a.dedupe_key) || a.dedupe_key === UNCHECKABLE) continue;
    await bounded();
    const asked = now();
    const pod = await c.getPod(a.dedupe_key);
    await bounded();
    await underLiveFence(credential_id, async (db) => {
      if (pod === undefined) {
        await resolveAlert(
          {
            credential_id,
            kind: "unknown_pod",
            dedupe_key: a.dedupe_key,
            observed_at: asked,
            by: "gone_at_provider",
          },
          db,
        );
        return;
      }
      // still there: seen again (after a resume, this pauses again)
      if (
        await raiseAlert(
          {
            key_owner_account_id,
            credential_id,
            kind: "unknown_pod",
            severity: "critical",
            dedupe_key: a.dedupe_key,
            details: a.details ?? undefined,
            observed_at: asked,
          },
          db,
        )
      ) {
        await pauseKey(credential_id, "unknown_pod", db);
      }
    });
  }
}

// ---- the sweep ----

export interface ReconcileSweepDeps extends ReconcileDeps {
  holder?: string;
  heartbeatMs?: number;
  keyPassMs?: number;
  sweepMs?: number;
  concurrency?: number;
}

// Which keys are due, most stale first: every active key (an idle one too,
// or its next launch could never be admitted), draining keys only while
// they have unfinished or quarantined pods, compromised keys never (their
// own sweep owns them).
async function dueKeys(now: Date, limit: number) {
  const { rows } = await getPool().query(
    `SELECT f.credential_id, f.key_owner_account_id FROM gpu_key_fences f
      WHERE (f.next_reconcile_at IS NULL OR f.next_reconcile_at <= $1)
        AND (f.state = 'active'
             OR (f.state = 'draining' AND EXISTS (
                   SELECT 1 FROM gpu_pods p WHERE p.credential_id = f.credential_id
                     AND p.unmanaged_at IS NULL
                     AND (p.state NOT IN ('terminated', 'failed')
                          OR EXISTS (SELECT 1 FROM gpu_pod_reservations r
                                      WHERE r.pod_id = p.id AND r.state = 'quarantined')))))
      ORDER BY f.next_reconcile_at NULLS FIRST, f.last_inventory_at NULLS FIRST, f.credential_id
      LIMIT $2`,
    [now, limit],
  );
  return rows as { credential_id: string; key_owner_account_id: string }[];
}

// How far behind the reconciler is, over every active key (backed-off ones
// too, so a deferred failure stays visible).
async function backlogStats(now: Date) {
  const { rows } = await getPool().query(
    `SELECT EXTRACT(EPOCH FROM ($1::timestamptz - MIN(COALESCE(last_inventory_at, created)))) AS oldest_s,
            COUNT(*) FILTER (WHERE next_reconcile_at IS NULL OR next_reconcile_at <= $1) AS due
       FROM gpu_key_fences WHERE state = 'active'`,
    [now],
  );
  const oldest_s = rows[0]?.oldest_s == null ? 0 : Number(rows[0].oldest_s);
  return {
    oldest_watermark_age_s: Math.max(0, Math.round(oldest_s)),
    due_keys: Number(rows[0]?.due ?? 0),
    backlog: oldest_s * 1000 > RECONCILE_BACKLOG_MS,
  };
}

export async function runReconcileSweep(
  deps: ReconcileSweepDeps = {},
): Promise<{ ran: boolean; keys?: number; complete?: number }> {
  const clock = deps.now ?? Date.now;
  const at = () => new Date(clock());
  const token = `${deps.holder ?? `${hostname()}:${process.pid}`}:${randomUUID()}`;
  if (!(await acquireWorkerLease("reconciler", token, at()))) {
    return { ran: false };
  }
  let lost = false;
  const renew = async () => {
    if (lost) throw new LeaseLost("the reconciler lease was lost");
    await renewWorkerLease("reconciler", token, at());
  };
  const heartbeat = setInterval(() => {
    renewWorkerLease("reconciler", token, at()).catch(() => (lost = true));
  }, deps.heartbeatMs ?? 60_000);
  heartbeat.unref?.();
  const sweepDeadline = clock() + (deps.sweepMs ?? RECONCILE_SWEEP_MS);
  const keyPassMs = deps.keyPassMs ?? RECONCILE_KEY_PASS_MS;
  let keys = 0;
  let complete = 0;
  try {
    const queue = await dueKeys(at(), 1000);
    let next = 0;
    const worker = async () => {
      // a key starts only if its whole pass fits in the sweep's time
      while (next < queue.length && clock() + keyPassMs <= sweepDeadline) {
        const k = queue[next++];
        await renew();
        keys += 1;
        let outcome: ReconcileOutcome;
        try {
          outcome = await reconcileKey(
            { ...k, deadline: clock() + keyPassMs },
            { ...deps, guard: renew },
          );
        } catch (err) {
          if (err instanceof LeaseLost || lost) throw err;
          // one key's database trouble doesn't stop the others
          log.warn("a reconcile pass failed", `${err}`);
          continue;
        }
        if (outcome.complete) complete += 1;
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            deps.concurrency ?? RECONCILE_CONCURRENCY,
            queue.length,
          ),
        },
        worker,
      ),
    );
    const stats = { ...(await backlogStats(at())), keys, complete };
    if (stats.backlog) {
      log.warn("the GPU reconciler is behind", JSON.stringify(stats));
    }
    await finishWorkerLease("reconciler", token, at(), undefined, stats);
    return { ran: true, keys, complete };
  } catch (err) {
    log.error("GPU reconcile sweep failed", `${err}`);
    if (!(err instanceof LeaseLost) && !lost) {
      await finishWorkerLease("reconciler", token, at(), `${err}`).catch(
        () => {},
      );
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

// A launch refused for a stale inventory asks for one key's pass now
// (bounded like a sweep's; at most one at a time per key in this hub; the
// conditional claim covers other hubs and the sweep).
const waking = new Set<string>();
export function wakeReconcile(
  k: { credential_id: string; key_owner_account_id: string },
  deps: ReconcileDeps = {},
): Promise<ReconcileOutcome | undefined> {
  if (waking.has(k.credential_id)) return Promise.resolve(undefined);
  waking.add(k.credential_id);
  const clock = deps.now ?? Date.now;
  return reconcileKey({ ...k, deadline: clock() + RECONCILE_KEY_PASS_MS }, deps)
    .catch((err) => {
      log.debug("a requested reconcile pass failed", `${err}`);
      return undefined;
    })
    .finally(() => waking.delete(k.credential_id));
}

export function initGpuReconciler(): void {
  setInventoryWaker((k) => void wakeReconcile(k));
  every("reconciler", () => runReconcileSweep(), RECONCILE_INTERVAL_MS);
}
