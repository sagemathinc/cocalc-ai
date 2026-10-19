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
  // A membership lookup failure throws: the caller keeps its previous
  // decision, rather than the site default silently replacing an override.
  return getControlPlaneEgressLimitsFromEffective(
    getEffectiveMembershipUsageLimits(
      await resolveMembershipForAccount(account_id),
    ),
  );
}

export interface ManagedProjectEgressPolicy {
  account_id?: string;
  category: ManagedProjectEgressCategory;
  allowed: boolean;
  // The exceeded window that recovers last (the one the block waits on).
  blocked_by?: "5h" | "7d";
  // Every exceeded window.
  blocked_windows?: ("5h" | "7d")[];
  // When every exceeded window is back under its limit (no new traffic), if
  // known.
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
    const blocked =
      policy.blocked_windows?.includes(window) ?? policy.blocked_by === window;
    maybeNotifyManagedEgressLimit({
      account_id: policy.account_id,
      pool,
      window,
      used,
      limit,
      blocked,
      // the block lifts at blocked_until, which is this window's recovery
      // only if it is the window that recovers last
      resets_at:
        blocked && policy.blocked_by === window
          ? policy.blocked_until
          : undefined,
    });
  }
}

// The block lifts only when every exceeded window has recovered, so report
// the latest recovery; unknown if any exceeded window's recovery is unknown.
export function latestBlockRecovery(
  exceeded: { window: "5h" | "7d"; until?: Date | string }[],
): Pick<
  ManagedProjectEgressPolicy,
  "blocked_by" | "blocked_windows" | "blocked_until"
> {
  if (exceeded.length === 0) return {};
  const blocked_windows = exceeded.map(({ window }) => window);
  const dated = exceeded.map(({ window, until }) => ({
    window,
    until: until == null ? undefined : new Date(until),
  }));
  if (dated.some(({ until }) => !Number.isFinite(until?.getTime()))) {
    // the longest exceeded window is the best description of the wait
    return {
      blocked_by: blocked_windows.includes("7d") ? "7d" : "5h",
      blocked_windows,
    };
  }
  const last = dated.reduce((a, b) =>
    b.until!.getTime() > a.until!.getTime() ? b : a,
  );
  return {
    blocked_by: last.window,
    blocked_windows,
    blocked_until: last.until,
  };
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
    const exceeded: { window: "5h" | "7d"; until?: Date | string }[] = [];
    for (const [window, used, limit] of [
      ["5h", usage.bytes_5h, egress_5h_bytes],
      ["7d", usage.bytes_7d, egress_7d_bytes],
    ] as const) {
      if (!(used > limit)) continue;
      exceeded.push({
        window,
        until: await getManagedEgressCategoryBlockedUntil({
          account_id,
          category,
          window,
          limit,
        }).catch(() => undefined),
      });
    }
    const block = latestBlockRecovery(exceeded);
    return {
      account_id,
      category,
      allowed: block.blocked_by == null,
      ...block,
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
  // Membership windows are fixed: each exceeded window recovers at its reset.
  const block = latestBlockRecovery([
    ...(usage.over_managed_egress_5h
      ? [{ window: "5h" as const, until: usage.managed_egress_5h_reset_at }]
      : []),
    ...(usage.over_managed_egress_7d
      ? [{ window: "7d" as const, until: usage.managed_egress_7d_reset_at }]
      : []),
  ]);
  return {
    account_id,
    category,
    allowed: block.blocked_by == null,
    ...block,
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
