/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
gpu.budget / gpu.setBudget: the key owner reads and changes the budget of
their RunPod key (its key layer). Lowering a limit narrows and needs only the
owner; raising one (more money, a higher cap, removing a cap, a later end)
needs fresh authentication, which the bay the user is signed in to checks
before forwarding (fresh_auth_verified). Both run on the key owner's home
bay, under the account rehome fence, then the key's fence, then the layer.
*/

import { randomUUID } from "node:crypto";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import { isValidUUID } from "@cocalc/util/misc";
import type { GpuBudget, GpuBudgetChange } from "@cocalc/util/gpu/types";
import { lockGpuAccountFence } from "@cocalc/server/gpu/account-fence";
import { inTransaction } from "@cocalc/server/gpu/pods";
import type { PoolClient } from "@cocalc/database/pool";
import { getRunpodLaunchAccessForAccount } from "@cocalc/server/gpu/provider-keys";
import { ensureKeyBudget, lockKeyFence } from "@cocalc/server/gpu/budgets";
import {
  createInterBayAccountLocalClient,
  type InterBayGpuApi,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";

export interface GpuBudgetDeps {
  // for tests
  homeClient?: (account_id: string) => Promise<InterBayGpuApi | undefined>;
  freshAuth?: typeof requireDangerousSessionAuth;
  credentialId?: (account_id: string) => Promise<string | undefined>;
  // for tests: the account fence (default: lockGpuAccountFence)
  accountWriteFence?: typeof lockGpuAccountFence;
  isHomeBay?: (account_id: string) => Promise<boolean>;
}

const LIMITS = {
  authorized_usd: 100_000,
  max_hourly_usd: 1_000,
  max_concurrent_pods: 100,
  max_gpu_count: 512,
  max_runtime_minutes: 7 * 24 * 60,
} as const;

const MONEY = ["authorized_usd", "max_hourly_usd"] as const;
const COUNTS = [
  "max_concurrent_pods",
  "max_gpu_count",
  "max_runtime_minutes",
] as const;

function requireAccount(account_id: unknown): string {
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    throw Error("must be signed in");
  }
  return account_id;
}

async function credentialIdFor(
  account_id: string,
): Promise<string | undefined> {
  // Only the id is used here; nothing is sent to RunPod.
  return (
    await getRunpodLaunchAccessForAccount(account_id).catch(() => undefined)
  )?.credential_id;
}

async function requireKey(account_id: string, deps: GpuBudgetDeps) {
  const credential_id = await (deps.credentialId ?? credentialIdFor)(
    account_id,
  );
  if (!credential_id) {
    throw Error(
      "No RunPod API key is connected. Connect one in Settings → Connectors.",
    );
  }
  return credential_id;
}

function view(layer: any, live: { pods: number; gpus: number }): GpuBudget {
  const available = toDecimal(layer.authorized_usd)
    .minus(layer.spent_usd)
    .minus(layer.reserved_usd)
    .minus(layer.released_usd);
  return {
    layer_id: layer.id,
    version: layer.version,
    state: layer.state,
    authorized_usd: moneyToDbString(layer.authorized_usd),
    spent_usd: moneyToDbString(layer.spent_usd),
    reserved_usd: moneyToDbString(layer.reserved_usd),
    released_usd: moneyToDbString(layer.released_usd),
    available_usd: moneyToDbString(available.lt(0) ? 0 : available),
    over_budget_usd: available.lt(0)
      ? moneyToDbString(available.neg())
      : undefined,
    max_hourly_usd:
      layer.max_hourly_usd == null
        ? null
        : moneyToDbString(layer.max_hourly_usd),
    max_concurrent_pods: layer.max_concurrent_pods,
    max_gpu_count: layer.max_gpu_count,
    max_runtime_minutes: layer.max_runtime_minutes,
    starts_at: new Date(layer.starts_at).toISOString(),
    ends_at: new Date(layer.ends_at).toISOString(),
    live_pods: live.pods,
    live_gpus: live.gpus,
  };
}

async function liveHolds(db, layer_id: string) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(pod_slots), 0)::int AS pods, COALESCE(SUM(gpu_count), 0)::int AS gpus
       FROM gpu_pod_reservations WHERE layer_id = $1 AND state IN ('active', 'quarantined')`,
    [layer_id],
  );
  return rows[0];
}

// Under the account fence that key replacement and removal take, the key is
// chosen there too: a budget is never read or changed for a key replaced or
// removed meanwhile.
async function withKeyUnderFence<T>({
  account_id,
  action,
  deps,
  fn,
}: {
  account_id: string;
  action: string;
  deps: GpuBudgetDeps;
  fn: (db: PoolClient, credential_id: string) => Promise<T>;
}): Promise<T> {
  return await inTransaction(async (db) => {
    await (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      account_id,
      action,
    );
    return await fn(db, await requireKey(account_id, deps));
  });
}

export async function getGpuBudgetLocal(
  opts: { account_id?: string },
  deps: GpuBudgetDeps = {},
): Promise<GpuBudget> {
  const account_id = requireAccount(opts.account_id);
  return await withKeyUnderFence({
    account_id,
    action: "read a GPU budget",
    deps,
    fn: async (db, credential_id) => {
      await ensureKeyBudget(db, {
        credential_id,
        key_owner_account_id: account_id,
      });
      const { rows } = await db.query(
        `SELECT * FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'`,
        [credential_id],
      );
      return view(rows[0], await liveHolds(db, rows[0].id));
    },
  });
}

// Validated values, and whether the change loosens anything.
export function planBudgetChange(
  layer: any,
  change: GpuBudgetChange,
): { fields: Record<string, unknown>; raises: string[] } {
  const fields: Record<string, unknown> = {};
  const raises: string[] = [];
  for (const k of MONEY) {
    if (!(k in change)) continue;
    const v = change[k];
    if (v == null) {
      if (k === "authorized_usd") throw Error("authorized_usd is required.");
      fields[k] = null;
      if (layer[k] != null) raises.push(k);
      continue;
    }
    let d: ReturnType<typeof toDecimal>;
    try {
      d = toDecimal(`${v}`);
    } catch {
      throw Error(`${k} must be a number.`);
    }
    if (!Number.isFinite(d.toNumber()) || d.lte(0) || d.gt(LIMITS[k])) {
      throw Error(`${k} must be more than 0 and at most ${LIMITS[k]}.`);
    }
    fields[k] = moneyToDbString(d);
    // no limit (null) is the loosest: adding one narrows
    if (layer[k] != null && d.gt(layer[k])) raises.push(k);
  }
  for (const k of COUNTS) {
    if (!(k in change)) continue;
    const v = change[k];
    if (v == null) {
      fields[k] = null;
      if (layer[k] != null) raises.push(k);
      continue;
    }
    if (!Number.isInteger(v) || v < 0 || v > LIMITS[k]) {
      throw Error(`${k} must be a whole number from 0 to ${LIMITS[k]}.`);
    }
    fields[k] = v;
    if (layer[k] != null && v > layer[k]) raises.push(k);
  }
  if ("ends_at" in change) {
    const t = new Date(`${change.ends_at}`);
    if (!Number.isFinite(t.getTime()) || t <= new Date(layer.starts_at)) {
      throw Error("ends_at must be a time after the budget starts.");
    }
    fields.ends_at = t;
    if (t > new Date(layer.ends_at)) raises.push("ends_at");
  }
  if (Object.keys(fields).length === 0) throw Error("Nothing to change.");
  return { fields, raises };
}

export async function setGpuBudgetLocal(
  opts: {
    account_id?: string;
    change?: GpuBudgetChange;
    expected_version?: number;
    fresh_auth_verified?: boolean;
  },
  deps: GpuBudgetDeps = {},
): Promise<GpuBudget> {
  const account_id = requireAccount(opts.account_id);
  if (opts.change == null || typeof opts.change !== "object") {
    throw Error("Give the budget changes.");
  }
  return await withKeyUnderFence({
    account_id,
    action: "change a GPU budget",
    deps,
    fn: async (db, credential_id) => {
      await ensureKeyBudget(db, {
        credential_id,
        key_owner_account_id: account_id,
      });
      await lockKeyFence(db, credential_id);
      const { rows } = await db.query(
        `SELECT * FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key' FOR UPDATE`,
        [credential_id],
      );
      const layer = rows[0];
      if (
        opts.expected_version != null &&
        opts.expected_version !== layer.version
      ) {
        throw Error(
          "The budget changed since you loaded it. Reload and try again.",
        );
      }
      const { fields, raises } = planBudgetChange(layer, opts.change!);
      if (raises.length > 0 && opts.fresh_auth_verified !== true) {
        throw Object.assign(
          Error(
            `Raising ${raises.join(", ")} needs you to sign in again; do it from Settings in the browser. Lowering limits doesn't.`,
          ),
          { code: "fresh_auth_required" },
        );
      }
      const keys = Object.keys(fields);
      const { rows: updated } = await db.query(
        `UPDATE gpu_budget_layers
            SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
                version = version + 1, updated = now()
          WHERE id = $1 RETURNING *`,
        [layer.id, ...keys.map((k) => fields[k])],
      );
      const before = Object.fromEntries(keys.map((k) => [k, layer[k]]));
      await db.query(
        `INSERT INTO gpu_budget_events (id, layer_id, at, actor_account_id, action, before, after)
         VALUES ($1, $2, now(), $3, 'update', $4, $5)`,
        [randomUUID(), layer.id, account_id, before, fields],
      );
      return view(updated[0], await liveHolds(db, layer.id));
    },
  });
}

// ---- routed entry points (hub API) ----

async function budgetHomeClient(
  account_id: string,
): Promise<InterBayGpuApi | undefined> {
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  const dest_bay = `${home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (dest_bay === getConfiguredBayId()) return undefined;
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
    timeout: 30_000,
  });
}

export async function getGpuBudget(
  opts: { account_id?: string },
  deps: GpuBudgetDeps = {},
): Promise<GpuBudget> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuBudget({ account_id });
  return await getGpuBudgetLocal({ account_id }, deps);
}

// Fresh authentication is checked here, on the bay the user is signed in
// to, for the caller's own session (bound by the hub transform); the home
// bay decides whether the change needs it. A session that isn't fresh is
// not an error here: lowering limits needs none, and the home bay refuses a
// raise without it.
export async function setGpuBudget(
  opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    change?: unknown;
    expected_version?: number;
  },
  deps: GpuBudgetDeps = {},
): Promise<GpuBudget> {
  const account_id = requireAccount(opts.account_id);
  let fresh_auth_verified = false;
  if (opts.browser_id || opts.session_hash) {
    try {
      await (deps.freshAuth ?? requireDangerousSessionAuth)({
        account_id,
        browser_id: opts.browser_id,
        session_hash: opts.session_hash,
        require_second_factor: false,
      });
      fresh_auth_verified = true;
    } catch {
      // not fresh (or not checkable): only a raise needs it
      fresh_auth_verified = false;
    }
  }
  const forwarded = {
    account_id,
    change: opts.change,
    expected_version: opts.expected_version,
    fresh_auth_verified,
  };
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuSetBudget(forwarded);
  return await setGpuBudgetLocal(forwarded as any, deps);
}

// Resuming launches after the kill switch paused them widens what the key
// may do, so it needs fresh authentication, always (checked on the signed-in
// bay, as for setGpuBudget). Only the kill switch's own pause is lifted; a
// safety pause (paused_reason, an alert's) stays.
export async function resumeGpuLaunchesLocal(
  opts: { account_id?: string; fresh_auth_verified?: boolean },
  deps: GpuBudgetDeps = {},
): Promise<{ resumed: number }> {
  const account_id = requireAccount(opts.account_id);
  if (opts.fresh_auth_verified !== true) {
    throw Object.assign(
      Error("Resuming GPU launches needs you to sign in again."),
      { code: "fresh_auth_required" },
    );
  }
  return await inTransaction(async (db) => {
    await (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      account_id,
      "resume GPU launches",
    );
    const { rows } = await db.query(
      `UPDATE gpu_key_fences SET kill_switch_at = NULL, updated = now()
        WHERE key_owner_account_id = $1 AND kill_switch_at IS NOT NULL
        RETURNING credential_id`,
      [account_id],
    );
    return { resumed: rows.length };
  });
}

export async function resumeGpuLaunches(
  opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
  },
  deps: GpuBudgetDeps = {},
): Promise<{ resumed: number }> {
  const account_id = requireAccount(opts.account_id);
  await (deps.freshAuth ?? requireDangerousSessionAuth)({
    account_id,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: false,
  });
  const forwarded = { account_id, fresh_auth_verified: true };
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuResume(forwarded);
  return await resumeGpuLaunchesLocal(forwarded, deps);
}
