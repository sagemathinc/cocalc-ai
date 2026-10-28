/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key budgets (step 5a): CoCalc's own limits on what an
account's RunPod key may spend, checked and reserved before every launch.

- Admission: under the global lock order (the account rehome fence, then the
  key's fence row, then its layers by id), every applicable layer is checked
  and a reservation (list price x GPUs x max runtime) is taken on each, in
  the same transaction as the pod's intent row. A launch that doesn't fit
  writes nothing.
- Settlement: when a pod ends, its reservations are settled in the same
  transaction as the state change: each layer gets reserved -= estimate and
  spent += actual (factual, never capped); the reservation row records
  released = max(estimate - actual, 0) and overrun = max(actual - estimate,
  0). A definite refusal releases in full; an unclear outcome is quarantined
  until the reconciler (5d) knows.

Available on a layer = authorized - spent - reserved - released, where
released is capacity deliberately retired. RunPod money never touches
CoCalc's ledger.
*/

import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import { lockAccountRehomeFence } from "@cocalc/server/accounts/rehome-fence";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";

type Db = Pick<PoolClient, "query">;
type Dec = ReturnType<typeof toDecimal>;

// A new key starts with $20 in total (not per day: there are no rolling
// windows) until the owner changes it.
export const DEFAULT_KEY_LAYER = {
  authorized_usd: "20",
  max_hourly_usd: "5",
  max_concurrent_pods: 2,
  max_gpu_count: 4,
  max_runtime_minutes: 8 * 60,
  years: 1,
} as const;

export interface LayerRow {
  id: string;
  credential_id: string;
  key_owner_account_id: string;
  scope_kind: string;
  state: string;
  authorized_usd: string;
  spent_usd: string;
  reserved_usd: string;
  released_usd: string;
  max_hourly_usd: string | null;
  max_concurrent_pods: number | null;
  max_gpu_count: number | null;
  max_runtime_minutes: number | null;
  allowed_gpu_type_ids: string[] | null;
  allowed_data_center_ids: string[] | null;
  cloud: string | null;
  starts_at: Date;
  ends_at: Date;
}

export interface AdmissionRequest {
  credential_id: string;
  key_owner_account_id: string;
  beneficiary_account_id: string;
  project_id: string;
  agent_id?: string;
  gpu_type_id: string;
  gpu_count: number;
  cloud: string;
  data_center_id?: string;
  max_runtime_minutes: number;
  // list price for the whole pod, USD per hour
  hourly_usd: string;
  now?: Date;
}

export interface Admission {
  layers: LayerRow[];
  hourly_usd: string;
  estimate_usd: string;
}

export class GpuBudgetRefusal extends Error {
  readonly code = "gpu_budget";
}

function refuse(message: string): never {
  throw new GpuBudgetRefusal(message);
}

const usd = (v: Dec | string) => `$${toDecimal(v).toFixed(2)}`;

function available(layer: LayerRow): Dec {
  return toDecimal(layer.authorized_usd)
    .minus(layer.spent_usd)
    .minus(layer.reserved_usd)
    .minus(layer.released_usd);
}

function layerName(layer: LayerRow): string {
  return layer.scope_kind === "key"
    ? "Your GPU budget"
    : `The ${layer.scope_kind} GPU budget`;
}

// The key's fence and its key layer exist (made at connect, or here at the
// first launch). Idempotent.
// The caps a new key layer starts with: the defaults, or for a key that
// follows another (5c), what carryKeyBudget allows.
export interface KeyLayerCaps {
  authorized_usd: string;
  max_hourly_usd: string | null;
  max_concurrent_pods: number | null;
  max_gpu_count: number | null;
  max_runtime_minutes: number | null;
}

export async function ensureKeyBudget(
  db: Db,
  {
    credential_id,
    key_owner_account_id,
    now = new Date(),
    initial,
  }: {
    credential_id: string;
    key_owner_account_id: string;
    now?: Date;
    initial?: KeyLayerCaps;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO gpu_key_fences (credential_id, key_owner_account_id, state, created, updated)
     VALUES ($1, $2, 'active', now(), now()) ON CONFLICT (credential_id) DO NOTHING`,
    [credential_id, key_owner_account_id],
  );
  const d = { ...DEFAULT_KEY_LAYER, ...(initial ?? {}) };
  const ends = new Date(now);
  ends.setFullYear(ends.getFullYear() + d.years);
  const { rows } = await db.query(
    `INSERT INTO gpu_budget_layers (id, credential_id, key_owner_account_id, scope_kind,
       authorized_usd, max_hourly_usd, max_concurrent_pods, max_gpu_count,
       max_runtime_minutes, starts_at, ends_at, state, created, updated)
     VALUES ($1, $2, $3, 'key', $4, $5, $6, $7, $8, $9, $10, 'active', now(), now())
     ON CONFLICT (credential_id) WHERE scope_kind = 'key' DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      credential_id,
      key_owner_account_id,
      d.authorized_usd,
      d.max_hourly_usd,
      d.max_concurrent_pods,
      d.max_gpu_count,
      d.max_runtime_minutes,
      now,
      ends,
    ],
  );
  if (rows[0]) {
    await db.query(
      `INSERT INTO gpu_budget_events (id, layer_id, at, actor_account_id, action, after)
       VALUES ($1, $2, now(), $3, 'create', $4)`,
      [
        randomUUID(),
        rows[0].id,
        key_owner_account_id,
        {
          authorized_usd: d.authorized_usd,
          max_hourly_usd: d.max_hourly_usd,
          max_concurrent_pods: d.max_concurrent_pods,
          max_gpu_count: d.max_gpu_count,
          max_runtime_minutes: d.max_runtime_minutes,
          ends_at: ends.toISOString(),
        },
      ],
    );
  }
}

// The caps for an account's next key (5c): never looser than what the
// account's latest key layer allowed. Money is what that layer had left
// (authorized - spent - reserved - released, at least 0), so a rotation
// never restores dollars; the other caps are the tighter of it and the
// default. With no earlier key layer, the defaults.
export async function carryKeyBudget(
  db: Db,
  key_owner_account_id: string,
): Promise<KeyLayerCaps | undefined> {
  const { rows } = await db.query(
    `SELECT * FROM gpu_budget_layers
      WHERE key_owner_account_id = $1 AND scope_kind = 'key'
      ORDER BY created DESC LIMIT 1`,
    [key_owner_account_id],
  );
  const prior: LayerRow | undefined = rows[0];
  if (!prior) return undefined;
  const d = DEFAULT_KEY_LAYER;
  const min = (a: Dec, b: Dec) => (a.lt(b) ? a : b);
  const avail = available(prior);
  const left = avail.gt(0) ? avail : toDecimal(0);
  const money = min(left, toDecimal(d.authorized_usd));
  const tighter = (cap: number | null, def: number) =>
    cap == null ? def : Math.min(cap, def);
  return {
    authorized_usd: moneyToDbString(money),
    max_hourly_usd: moneyToDbString(
      prior.max_hourly_usd == null
        ? toDecimal(d.max_hourly_usd)
        : min(toDecimal(prior.max_hourly_usd), toDecimal(d.max_hourly_usd)),
    ),
    max_concurrent_pods: tighter(
      prior.max_concurrent_pods,
      d.max_concurrent_pods,
    ),
    max_gpu_count: tighter(prior.max_gpu_count, d.max_gpu_count),
    max_runtime_minutes: tighter(
      prior.max_runtime_minutes,
      d.max_runtime_minutes,
    ),
  };
}

// The key's fence, locked. Every budget change takes it first (after the
// account rehome fence), so admission, settlement and drain serialize.
export async function lockKeyFence(
  db: Db,
  credential_id: string,
): Promise<{
  state: string;
  paused_reason: string | null;
  kill_switch_at: Date | null;
}> {
  const { rows } = await db.query(
    `SELECT state, paused_reason, kill_switch_at FROM gpu_key_fences WHERE credential_id = $1 FOR UPDATE`,
    [credential_id],
  );
  if (!rows[0]) refuse("This RunPod key has no GPU budget yet.");
  return rows[0];
}

// Launches need the reaper to have *completed* a sweep recently: it is what
// terminates pods at their limits. If it hasn't, launches fail closed, unless
// an admin made an explicit, time-limited override for this key owner (which
// never bypasses a budget check).
export const REAPER_STALE_MS = 5 * 60_000;

export async function requireFreshWorkers(
  db: Db,
  { key_owner_account_id, now }: { key_owner_account_id: string; now: Date },
): Promise<void> {
  const { rows } = await db.query(
    `SELECT last_completed_at FROM gpu_worker_leases WHERE name = 'reaper'`,
  );
  const last = rows[0]?.last_completed_at;
  if (last && now.getTime() - new Date(last).getTime() <= REAPER_STALE_MS) {
    return;
  }
  const { rows: overrides } = await db.query(
    `SELECT 1 FROM gpu_worker_overrides
      WHERE key_owner_account_id = $1 AND revoked_at IS NULL AND expires_at > $2
      LIMIT 1`,
    [key_owner_account_id, now],
  );
  if (overrides.length > 0) return;
  refuse(
    "GPU launches are paused because CoCalc's GPU cleanup worker (which terminates pods at their limits) hasn't completed a check recently. Try again in a few minutes.",
  );
}

// Check and reserve on every applicable layer. Call inside the intent's
// transaction, after the account rehome fence and before the pod row; then
// insertReservations() with the new pod's id.
export async function admitLaunch(
  db: Db,
  req: AdmissionRequest,
): Promise<Admission> {
  const now = req.now ?? new Date();
  const fence = await lockKeyFence(db, req.credential_id);
  await requireFreshWorkers(db, {
    key_owner_account_id: req.key_owner_account_id,
    now,
  });
  if (fence.state !== "active") {
    refuse(
      fence.state === "draining"
        ? "This RunPod key is being removed; no new GPUs can be launched with it."
        : "This RunPod key was reported compromised; no new GPUs can be launched with it.",
    );
  }
  if (fence.kill_switch_at) {
    refuse(
      "New GPU launches are paused by your kill switch. Resume them with cocalc gpu resume (it asks you to sign in again).",
    );
  }
  if (fence.paused_reason) {
    refuse(
      "New GPU launches with this key are paused until an alert is resolved. Check gpu alerts.",
    );
  }
  const { rows: layers } = await db.query(
    `SELECT * FROM gpu_budget_layers
      WHERE credential_id = $1
        AND (scope_kind = 'key'
             OR (scope_kind = 'project' AND project_id = $2)
             OR (scope_kind = 'beneficiary' AND beneficiary_account_id = $3)
             OR (scope_kind = 'agent' AND agent_id = $4))
      ORDER BY id FOR UPDATE`,
    [
      req.credential_id,
      req.project_id,
      req.beneficiary_account_id,
      req.agent_id ?? null,
    ],
  );
  if (!layers.some((l: LayerRow) => l.scope_kind === "key")) {
    refuse("This RunPod key has no GPU budget yet.");
  }
  const hourly = toDecimal(req.hourly_usd);
  const estimate = hourly.times(req.max_runtime_minutes).dividedBy(60);
  // What each layer already holds in live reservations.
  const { rows: holds } = await db.query(
    `SELECT layer_id, COALESCE(SUM(hourly_usd), 0) AS hourly,
            COALESCE(SUM(pod_slots), 0)::int AS pods,
            COALESCE(SUM(gpu_count), 0)::int AS gpus
       FROM gpu_pod_reservations
      WHERE layer_id = ANY($1) AND state IN ('active', 'quarantined')
      GROUP BY layer_id`,
    [layers.map((l: LayerRow) => l.id)],
  );
  const held = new Map(holds.map((h: any) => [h.layer_id, h]));
  for (const layer of layers as LayerRow[]) {
    const name = layerName(layer);
    if (layer.state !== "active") refuse(`${name} is ${layer.state}.`);
    if (new Date(layer.starts_at) > now || new Date(layer.ends_at) <= now) {
      refuse(`${name} isn't in effect now.`);
    }
    const left = available(layer);
    if (estimate.gt(left)) {
      refuse(
        `This launch needs up to ${usd(estimate)} (${usd(hourly)}/h for ${req.max_runtime_minutes} min), but ${name[0].toLowerCase()}${name.slice(1)} has ${usd(left.lt(0) ? toDecimal(0) : left)} left.`,
      );
    }
    const h: any = held.get(layer.id) ?? { hourly: "0", pods: 0, gpus: 0 };
    if (
      layer.max_hourly_usd != null &&
      toDecimal(h.hourly).plus(hourly).gt(layer.max_hourly_usd)
    ) {
      refuse(`${name} allows at most ${usd(layer.max_hourly_usd)}/h in all.`);
    }
    if (
      layer.max_concurrent_pods != null &&
      h.pods + 1 > layer.max_concurrent_pods
    ) {
      refuse(
        `${name} allows at most ${layer.max_concurrent_pods} pods at once.`,
      );
    }
    if (
      layer.max_gpu_count != null &&
      h.gpus + req.gpu_count > layer.max_gpu_count
    ) {
      refuse(`${name} allows at most ${layer.max_gpu_count} GPUs at once.`);
    }
    if (
      layer.max_runtime_minutes != null &&
      req.max_runtime_minutes > layer.max_runtime_minutes
    ) {
      refuse(
        `${name} allows at most ${layer.max_runtime_minutes} minutes per pod.`,
      );
    }
    if (
      layer.allowed_gpu_type_ids != null &&
      !layer.allowed_gpu_type_ids.includes(req.gpu_type_id)
    ) {
      refuse(`${name} doesn't allow ${req.gpu_type_id}.`);
    }
    if (
      layer.allowed_data_center_ids != null &&
      !(
        req.data_center_id &&
        layer.allowed_data_center_ids.includes(req.data_center_id)
      )
    ) {
      refuse(
        `${name} allows only data centers ${layer.allowed_data_center_ids.join(", ")}; choose one.`,
      );
    }
    if (layer.cloud != null && layer.cloud !== req.cloud) {
      refuse(`${name} allows only ${layer.cloud} cloud.`);
    }
  }
  return {
    layers,
    hourly_usd: moneyToDbString(hourly),
    estimate_usd: moneyToDbString(estimate),
  };
}

export async function insertReservations(
  db: Db,
  pod_id: string,
  admission: Admission,
  gpu_count: number,
): Promise<void> {
  for (const layer of admission.layers) {
    await db.query(
      `INSERT INTO gpu_pod_reservations (id, pod_id, layer_id, state, reserved_usd,
         hourly_usd, gpu_count, pod_slots, created, updated)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, 1, now(), now())`,
      [
        randomUUID(),
        pod_id,
        layer.id,
        admission.estimate_usd,
        admission.hourly_usd,
        gpu_count,
      ],
    );
    await db.query(
      `UPDATE gpu_budget_layers SET reserved_usd = reserved_usd + $2, updated = now() WHERE id = $1`,
      [layer.id, admission.estimate_usd],
    );
  }
}

// Everything a change to a pod's budget needs, in the global order: the
// account rehome fence, the key's fence, the pod's layers by id, then its
// reservations by id. Call before touching the pod row itself.
export async function lockBudgetsForPod(
  db: Db,
  {
    pod_id,
    credential_id,
    key_owner_account_id,
  }: { pod_id: string; credential_id: string; key_owner_account_id: string },
): Promise<void> {
  await lockAccountRehomeFence({
    db: db as any,
    account_id: key_owner_account_id,
  });
  await db.query(
    `SELECT 1 FROM gpu_key_fences WHERE credential_id = $1 FOR UPDATE`,
    [credential_id],
  );
  await lockReservations(db, pod_id);
}

// Lock a pod's layers (by id) and then its reservations (by id): the global
// order after the fences.
async function lockReservations(db: Db, pod_id: string): Promise<any[]> {
  const { rows: ids } = await db.query(
    `SELECT layer_id FROM gpu_pod_reservations WHERE pod_id = $1 ORDER BY layer_id`,
    [pod_id],
  );
  if (ids.length > 0) {
    await db.query(
      `SELECT id FROM gpu_budget_layers WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
      [ids.map((r: any) => r.layer_id)],
    );
  }
  const { rows } = await db.query(
    `SELECT * FROM gpu_pod_reservations WHERE pod_id = $1 ORDER BY id FOR UPDATE`,
    [pod_id],
  );
  return rows;
}

// RunPod bills more per hour than we reserved: enlarge every reservation
// within its layer's limits. False when that doesn't fit; the caller then
// sets the pod to terminate in the same transaction.
export async function enlargeAtBind(
  db: Db,
  {
    pod_id,
    credential_id,
    actual_hourly_usd,
    max_runtime_minutes,
    force = false,
  }: {
    pod_id: string;
    credential_id: string;
    actual_hourly_usd: string;
    max_runtime_minutes: number;
    // hold the real price even past the caps: for a pod that doesn't fit
    // and is being terminated, so its layers show it (and refuse new
    // launches) until it settles
    force?: boolean;
  },
): Promise<boolean> {
  // the caller holds lockBudgetsForPod (row locks are re-entrant)
  void credential_id;
  const reservations = await lockReservations(db, pod_id);
  const hourly = toDecimal(actual_hourly_usd);
  const estimate = hourly.times(max_runtime_minutes).dividedBy(60);
  const grow = reservations.filter(
    (r) => r.state === "active" && hourly.gt(r.hourly_usd),
  );
  for (const r of grow) {
    const { rows } = await db.query(
      `SELECT * FROM gpu_budget_layers WHERE id = $1`,
      [r.layer_id],
    );
    const layer: LayerRow = rows[0];
    if (force) continue;
    if (estimate.minus(r.reserved_usd).gt(available(layer))) return false;
    if (layer.max_hourly_usd != null) {
      const { rows: h } = await db.query(
        `SELECT COALESCE(SUM(hourly_usd), 0) AS hourly FROM gpu_pod_reservations
          WHERE layer_id = $1 AND state IN ('active', 'quarantined')`,
        [layer.id],
      );
      const after = toDecimal(h[0].hourly).minus(r.hourly_usd).plus(hourly);
      if (after.gt(layer.max_hourly_usd)) return false;
    }
  }
  for (const r of grow) {
    await db.query(
      `UPDATE gpu_pod_reservations SET reserved_usd = $2, hourly_usd = $3, updated = now() WHERE id = $1`,
      [r.id, moneyToDbString(estimate), moneyToDbString(hourly)],
    );
    await db.query(
      `UPDATE gpu_budget_layers SET reserved_usd = reserved_usd + $2, updated = now() WHERE id = $1`,
      [r.layer_id, moneyToDbString(estimate.minus(r.reserved_usd))],
    );
  }
  return true;
}

// How a pod's end settles its reservations:
// - "actual": it ran; spend what it cost (runtime x cost_per_hr; billing
//   corrects it later), never capped at the estimate;
// - "release": definitely never created; return everything;
// - "quarantine": the outcome is unknown; hold everything until reconciled.
export type Settlement =
  | { kind: "actual"; actual_usd: string }
  | { kind: "release" }
  | { kind: "quarantine" };

export async function settleReservations(
  db: Db,
  { pod_id, credential_id }: { pod_id: string; credential_id: string },
  settlement: Settlement,
): Promise<void> {
  // the caller holds lockBudgetsForPod (row locks are re-entrant)
  void credential_id;
  const reservations = await lockReservations(db, pod_id);
  for (const r of reservations) {
    if (r.state === "settled") continue;
    if (settlement.kind === "quarantine") {
      if (r.state === "active") {
        await db.query(
          `UPDATE gpu_pod_reservations SET state = 'quarantined', updated = now() WHERE id = $1`,
          [r.id],
        );
      }
      continue;
    }
    const estimate = toDecimal(r.reserved_usd);
    const actual = toDecimal(
      settlement.kind === "actual" ? settlement.actual_usd : 0,
    );
    const released = estimate.gt(actual)
      ? estimate.minus(actual)
      : toDecimal(0);
    const overrun = actual.gt(estimate) ? actual.minus(estimate) : toDecimal(0);
    await db.query(
      `UPDATE gpu_pod_reservations
          SET state = 'settled', spent_usd = $2, released_usd = $3, overrun_usd = $4,
              settled_at = now(), updated = now()
        WHERE id = $1`,
      [
        r.id,
        moneyToDbString(actual),
        moneyToDbString(released),
        moneyToDbString(overrun),
      ],
    );
    await db.query(
      `UPDATE gpu_budget_layers
          SET reserved_usd = reserved_usd - $2, spent_usd = spent_usd + $3, updated = now()
        WHERE id = $1`,
      [r.layer_id, moneyToDbString(estimate), moneyToDbString(actual)],
    );
  }
}

// What a pod that ran cost: runtime x the bound hourly cost. When RunPod
// didn't report the pod's cost, the reserved list rate stands in (fail
// closed: a pod known to have run never settles at zero) until billing
// replaces it.
export function actualCost({
  cost_per_hr,
  reserved_hourly_usd,
  running_since,
  ended_at,
}: {
  cost_per_hr: string | null;
  reserved_hourly_usd?: string | null;
  running_since: Date | null;
  ended_at: Date;
}): string {
  const rate = cost_per_hr ?? reserved_hourly_usd ?? null;
  if (rate == null || running_since == null) return "0";
  const ms = Math.max(
    0,
    new Date(ended_at).getTime() - new Date(running_since).getTime(),
  );
  return moneyToDbString(toDecimal(rate).times(ms).dividedBy(3_600_000));
}
