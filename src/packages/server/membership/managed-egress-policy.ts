/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ManagedProjectEgressCategory } from "@cocalc/server/membership/managed-egress";
import {
  getManagedEgressCategoryBlockedUntil,
  getManagedEgressCategoryUsageForAccount,
  getManagedEgressUsageForAccount,
  getProjectUsageAccountId,
} from "@cocalc/server/membership/managed-egress";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { getControlPlaneEgressLimitsFromEffective } from "@cocalc/server/membership/control-plane-egress-limits";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { maybeNotifyManagedEgressLimit } from "@cocalc/server/notifications/managed-egress";
import LRU from "lru-cache";

export {
  DEFAULT_CONTROL_PLANE_EGRESS_5H_BYTES,
  DEFAULT_CONTROL_PLANE_EGRESS_7D_BYTES,
} from "@cocalc/server/membership/control-plane-egress-limits";
const POLICY_CACHE_TTL_MS = 30_000;

const policyCache = new LRU<string, Promise<ManagedProjectEgressPolicy>>({
  max: 20_000,
  ttl: POLICY_CACHE_TTL_MS,
});

async function getControlPlaneEgressLimits(account_id: string): Promise<{
  egress_5h_bytes: number;
  egress_7d_bytes: number;
}> {
  // A membership lookup failure must not block browser sessions: fall back
  // to the site default.
  const resolution = await resolveMembershipForAccount(account_id).catch(
    () => undefined,
  );
  return getControlPlaneEgressLimitsFromEffective(
    getEffectiveMembershipUsageLimits(resolution),
  );
}

export interface ManagedProjectEgressPolicy {
  account_id?: string;
  category: ManagedProjectEgressCategory;
  allowed: boolean;
  blocked_by?: "5h" | "7d";
  // When the blocking window is back under its limit (no new traffic), if known.
  blocked_until?: Date;
  managed_egress_5h_bytes?: number;
  managed_egress_7d_bytes?: number;
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  managed_egress_categories_5h_bytes?: Record<string, number>;
  managed_egress_categories_7d_bytes?: Record<string, number>;
}

// A notice at >= 90% of either window, or when blocked (deduplicated daily).
function notifyIfNearLimit(policy: ManagedProjectEgressPolicy): void {
  if (!policy.account_id) return;
  const pool =
    policy.category === "control-plane-conat" ? "control-plane" : "shared";
  for (const window of ["5h", "7d"] as const) {
    const used =
      window === "5h"
        ? policy.managed_egress_5h_bytes
        : policy.managed_egress_7d_bytes;
    const limit =
      window === "5h" ? policy.egress_5h_bytes : policy.egress_7d_bytes;
    if (used == null || limit == null) continue;
    const blocked = policy.blocked_by === window;
    maybeNotifyManagedEgressLimit({
      account_id: policy.account_id,
      pool,
      window,
      used,
      limit,
      blocked,
      resets_at: blocked ? policy.blocked_until : undefined,
    });
  }
}

async function computeManagedProjectEgressPolicy({
  account_id,
  category,
}: {
  account_id: string;
  category: ManagedProjectEgressCategory;
}): Promise<ManagedProjectEgressPolicy> {
  if (category === "control-plane-conat") {
    const { egress_5h_bytes, egress_7d_bytes } =
      await getControlPlaneEgressLimits(account_id);
    const usage = await getManagedEgressCategoryUsageForAccount({
      account_id,
      category,
    });
    const blocked_by =
      usage.bytes_5h > egress_5h_bytes
        ? "5h"
        : usage.bytes_7d > egress_7d_bytes
          ? "7d"
          : undefined;
    const blocked_until =
      blocked_by == null
        ? undefined
        : await getManagedEgressCategoryBlockedUntil({
            account_id,
            category,
            window: blocked_by,
            limit: blocked_by === "5h" ? egress_5h_bytes : egress_7d_bytes,
          }).catch(() => undefined);
    return {
      account_id,
      category,
      allowed: blocked_by == null,
      blocked_by,
      blocked_until,
      managed_egress_5h_bytes: usage.bytes_5h,
      managed_egress_7d_bytes: usage.bytes_7d,
      egress_5h_bytes,
      egress_7d_bytes,
      managed_egress_categories_5h_bytes: {
        "control-plane-conat": usage.bytes_5h,
      },
      managed_egress_categories_7d_bytes: {
        "control-plane-conat": usage.bytes_7d,
      },
    };
  }
  const resolution = await resolveMembershipForAccount(account_id);
  const effectiveLimits = getEffectiveMembershipUsageLimits(resolution);
  const egress_5h_bytes = effectiveLimits.egress_5h_bytes;
  const egress_7d_bytes = effectiveLimits.egress_7d_bytes;
  const usage = await getManagedEgressUsageForAccount({
    account_id,
    limit5h: egress_5h_bytes,
    limit7d: egress_7d_bytes,
  });
  const blocked_by = usage.over_managed_egress_5h
    ? "5h"
    : usage.over_managed_egress_7d
      ? "7d"
      : undefined;
  return {
    account_id,
    category,
    allowed: blocked_by == null,
    blocked_by,
    // Membership windows are fixed: the block lifts when the window resets.
    blocked_until:
      blocked_by === "5h"
        ? usage.managed_egress_5h_reset_at
        : blocked_by === "7d"
          ? usage.managed_egress_7d_reset_at
          : undefined,
    managed_egress_5h_bytes: usage.managed_egress_5h_bytes,
    managed_egress_7d_bytes: usage.managed_egress_7d_bytes,
    egress_5h_bytes,
    egress_7d_bytes,
    managed_egress_categories_5h_bytes:
      usage.managed_egress_categories_5h_bytes,
    managed_egress_categories_7d_bytes:
      usage.managed_egress_categories_7d_bytes,
  };
}

export async function getManagedProjectEgressPolicy(opts: {
  account_id?: string;
  project_id?: string;
  category: ManagedProjectEgressCategory;
}): Promise<ManagedProjectEgressPolicy> {
  const project_id = `${opts.project_id ?? ""}`.trim() || undefined;
  const account_id =
    `${opts.account_id ?? ""}`.trim() ||
    (project_id ? await getProjectUsageAccountId(project_id) : undefined);
  if (!account_id) {
    return {
      category: opts.category,
      allowed: true,
    };
  }
  const key = `${account_id}:${opts.category}`;
  const cached = policyCache.get(key);
  if (cached) return await cached;
  const value = computeManagedProjectEgressPolicy({
    account_id,
    category: opts.category,
  })
    .then((policy) => {
      notifyIfNearLimit(policy);
      return policy;
    })
    .catch((err) => {
      if (policyCache.get(key) === value) policyCache.delete(key);
      throw err;
    });
  policyCache.set(key, value);
  return await value;
}

export const __test__ = {
  clearPolicyCache: () => policyCache.clear(),
};
