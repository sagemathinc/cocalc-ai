/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
gpu.adminAllowStaleWorkers: GPU launches fail closed while the reaper (and,
from 5d, the reconciler) hasn't completed a recent sweep. An admin may make
an explicit exception for one account: at most 24 hours, with a reason,
fresh authentication, and an audit row (the override row itself, kept). It
bypasses only that staleness check, never a budget check.
*/

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import {
  createInterBayAccountLocalClient,
  type InterBayGpuApi,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

export const MAX_OVERRIDE_HOURS = 24;

export interface GpuWorkerOverride {
  id: string;
  account_id: string;
  expires_at: string;
}

export interface GpuAdminDeps {
  // for tests
  isAdmin?: (account_id: string) => Promise<boolean>;
  freshAuth?: typeof requireDangerousSessionAuth;
  homeClient?: (account_id: string) => Promise<InterBayGpuApi | undefined>;
  now?: () => number;
}

function checkInputs(opts: {
  account_id?: unknown;
  hours?: unknown;
  reason?: unknown;
}) {
  const account_id = `${opts.account_id ?? ""}`;
  if (!isValidUUID(account_id)) throw Error("Give the account to allow.");
  const hours = Number(opts.hours);
  if (!(Number.isFinite(hours) && hours > 0 && hours <= MAX_OVERRIDE_HOURS)) {
    throw Error(`hours must be more than 0 and at most ${MAX_OVERRIDE_HOURS}.`);
  }
  const reason = `${opts.reason ?? ""}`.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw Error("Give a reason of 10 to 500 characters.");
  }
  return { account_id, hours, reason };
}

// On the target account's home bay, where its launches are admitted.
export async function allowStaleWorkersLocal(
  opts: {
    admin_account_id: string;
    account_id: string;
    hours: number;
    reason: string;
  },
  deps: GpuAdminDeps = {},
): Promise<GpuWorkerOverride> {
  const { account_id, hours, reason } = checkInputs(opts);
  const now = new Date((deps.now ?? Date.now)());
  const expires = new Date(now.getTime() + hours * 3_600_000);
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO gpu_worker_overrides (id, key_owner_account_id, admin_account_id, reason, created, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, account_id, opts.admin_account_id, reason, now, expires],
  );
  return { id, account_id, expires_at: expires.toISOString() };
}

async function adminHomeClient(
  account_id: string,
): Promise<InterBayGpuApi | undefined> {
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  const dest_bay = `${home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (dest_bay === getConfiguredBayId()) return undefined;
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
    timeout: 30_000,
  });
}

export async function allowStaleWorkers(
  opts: {
    account_id?: string; // the admin (authenticated caller)
    browser_id?: string | null;
    session_hash?: string | null;
    target_account_id?: unknown;
    hours?: unknown;
    reason?: unknown;
  },
  deps: GpuAdminDeps = {},
): Promise<GpuWorkerOverride> {
  const admin = `${opts.account_id ?? ""}`;
  if (!isValidUUID(admin) || !(await (deps.isAdmin ?? isAdmin)(admin))) {
    throw Error(
      "Only an admin can allow GPU launches while workers are stale.",
    );
  }
  const inputs = checkInputs({
    account_id: opts.target_account_id,
    hours: opts.hours,
    reason: opts.reason,
  });
  await (deps.freshAuth ?? requireDangerousSessionAuth)({
    account_id: admin,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: false,
  });
  const forwarded = { admin_account_id: admin, ...inputs };
  const home = await (deps.homeClient ?? adminHomeClient)(inputs.account_id);
  if (home) return await home.gpuAllowStaleWorkers(forwarded);
  return await allowStaleWorkersLocal(forwarded, deps);
}
