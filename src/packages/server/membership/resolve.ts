import getPool from "@cocalc/database/pool";
import TTL from "@isaacs/ttlcache";
import type {
  MembershipClass,
  MembershipCandidate,
  MembershipDetails,
  MembershipEntitlements,
  MembershipResolution,
} from "@cocalc/conat/hub/api/purchases";
import {
  getMembershipTierById,
  getMembershipTierMap,
  MembershipTierRecord,
} from "./tiers";
import { listActiveMembershipGrantsForAccount } from "./grants";
import getLogger from "@cocalc/backend/logger";
import { normalizeMembershipEffectiveLimits } from "./effective-limits";
import { getMembershipUsageStatusForAccount } from "./usage-status";
import {
  applyAccountEntitlementOverride,
  describeAccountEntitlementOverride,
  getActiveAccountEntitlementOverride,
} from "./entitlement-overrides";

const log = getLogger("server:membership:resolve");
const MEMBERSHIP_USAGE_STATUS_CACHE_TTL_MS = 60_000;

type UsageStatusCacheValue = {
  usage_status: MembershipDetails["usage_status"];
};

const membershipUsageStatusCache = new TTL<string, UsageStatusCacheValue>({
  ttl: MEMBERSHIP_USAGE_STATUS_CACHE_TTL_MS,
});
const membershipUsageStatusInflight = new Map<
  string,
  Promise<MembershipDetails["usage_status"]>
>();

function tierToEntitlements(
  tier?: MembershipTierRecord,
): MembershipEntitlements {
  if (!tier) return {};
  return {
    project_defaults: tier.project_defaults,
    ai_limits: tier.ai_limits,
    features: tier.features,
    usage_limits: tier.usage_limits,
  };
}

async function buildMembershipCandidates(
  account_id: string,
  tiers: Record<string, MembershipTierRecord>,
): Promise<MembershipCandidate[]> {
  const pool = getPool("medium");
  const [subResult, adminResult, adminGroupResult, grants] = await Promise.all([
    pool.query(
      `SELECT id, metadata, cost, interval, current_period_end, status
       FROM subscriptions
       WHERE account_id=$1
         AND metadata->>'type'='membership'
         AND status IN ('active','unpaid','past_due','canceled')
         AND current_period_end >= NOW()
       ORDER BY current_period_end DESC, id DESC`,
      [account_id],
    ),
    pool.query(
      `SELECT membership_class, assigned_at, expires_at
       FROM admin_assigned_memberships
       WHERE account_id=$1
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [account_id],
    ),
    pool.query(
      `SELECT 'admin' = ANY(groups) AS is_admin
       FROM accounts
       WHERE account_id=$1
         AND coalesce(deleted,false)=false`,
      [account_id],
    ),
    listActiveMembershipGrantsForAccount(account_id),
  ]);

  const candidates: MembershipCandidate[] = [];

  for (const sub of subResult.rows) {
    const membershipClass = (sub.metadata?.class ?? "free") as MembershipClass;
    const tier =
      tiers[membershipClass] ??
      (await getMembershipTierById({ id: membershipClass }));
    candidates.push({
      class: membershipClass,
      source: "subscription",
      priority: tier?.priority ?? 0,
      entitlements: tierToEntitlements(tier),
      effective_limits: normalizeMembershipEffectiveLimits(tier?.usage_limits),
      subscription_id: sub.id,
      subscription_status: sub.status,
      subscription_cost: normalizeSubscriptionCost(sub.cost),
      subscription_interval: sub.interval,
      expires: sub.current_period_end,
    });
  }

  const admin = adminResult.rows[0];
  if (admin?.membership_class) {
    const membershipClass = admin.membership_class as MembershipClass;
    const tier =
      tiers[membershipClass] ??
      (await getMembershipTierById({ id: membershipClass }));
    candidates.push({
      class: membershipClass,
      source: "admin",
      priority: tier?.priority ?? 0,
      entitlements: tierToEntitlements(tier),
      effective_limits: normalizeMembershipEffectiveLimits(tier?.usage_limits),
      expires: admin.expires_at ?? undefined,
    });
  }

  const adminTier = tiers["admin"];
  if (adminGroupResult.rows[0]?.is_admin && adminTier && !adminTier.disabled) {
    candidates.push({
      class: "admin" as MembershipClass,
      source: "admin",
      priority: adminTier.priority ?? 0,
      entitlements: tierToEntitlements(adminTier),
      effective_limits: normalizeMembershipEffectiveLimits(
        adminTier.usage_limits,
      ),
    });
  }

  for (const grant of grants) {
    const membershipClass = grant.membership_class as MembershipClass;
    const tier =
      tiers[membershipClass] ??
      (await getMembershipTierById({ id: membershipClass }));
    candidates.push({
      class: membershipClass,
      source: "grant",
      priority: tier?.priority ?? 0,
      entitlements: tierToEntitlements(tier),
      effective_limits: normalizeMembershipEffectiveLimits(tier?.usage_limits),
      grant_id: grant.id,
      grant_source: grant.source,
      grant_package_id: grant.package_id ?? undefined,
      grant_purchase_id: grant.purchase_id ?? undefined,
      expires: grant.expires_at ? new Date(grant.expires_at) : undefined,
    });
  }

  return dedupeEquivalentAdminCandidates(candidates);
}

async function buildMembershipResolutionForAccount(
  account_id: string,
): Promise<{
  candidates: MembershipCandidate[];
  selected: MembershipResolution;
}> {
  const tiers = await getMembershipTierMap({ includeDisabled: true });
  const candidates = await buildMembershipCandidates(account_id, tiers);
  const selected = pickBestMembership(candidates, tiers);
  return { candidates, selected };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value != null && typeof value === "object") {
    if (value instanceof Date) {
      return value.toISOString();
    }
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce(
        (result, key) => {
          result[key] = stableJsonValue(record[key]);
          return result;
        },
        {} as Record<string, unknown>,
      );
  }
  return value;
}

function adminCandidateKey(candidate: MembershipCandidate): string {
  return stableStringify({
    class: candidate.class,
    priority: candidate.priority,
    expires: candidate.expires
      ? new Date(candidate.expires).toISOString()
      : undefined,
    entitlements: candidate.entitlements,
    effective_limits: candidate.effective_limits,
  });
}

function dedupeEquivalentAdminCandidates(
  candidates: MembershipCandidate[],
): MembershipCandidate[] {
  const seenAdminCandidates = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.source !== "admin") {
      return true;
    }
    const key = adminCandidateKey(candidate);
    if (seenAdminCandidates.has(key)) {
      return false;
    }
    seenAdminCandidates.add(key);
    return true;
  });
}

function normalizeSubscriptionCost(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pickBestMembership(
  candidates: MembershipCandidate[],
  tiers: Record<string, MembershipTierRecord>,
): MembershipResolution {
  if (candidates.length > 0) {
    const sourceRank = {
      subscription: 3,
      admin: 2,
      grant: 1,
    } as const;
    const best = candidates.reduce((current, candidate) => {
      if (!current) return candidate;
      if (candidate.priority > current.priority) return candidate;
      if (candidate.priority < current.priority) return current;
      if (sourceRank[candidate.source] > sourceRank[current.source]) {
        return candidate;
      }
      if (sourceRank[candidate.source] < sourceRank[current.source]) {
        return current;
      }
      const candidateSubscriptionStatusRank = subscriptionStatusRank(candidate);
      const currentSubscriptionStatusRank = subscriptionStatusRank(current);
      if (candidateSubscriptionStatusRank > currentSubscriptionStatusRank) {
        return candidate;
      }
      if (candidateSubscriptionStatusRank < currentSubscriptionStatusRank) {
        return current;
      }
      const candidateExpires = candidate.expires
        ? new Date(candidate.expires).valueOf()
        : -Infinity;
      const currentExpires = current.expires
        ? new Date(current.expires).valueOf()
        : -Infinity;
      if (candidateExpires > currentExpires) return candidate;
      if (candidateExpires < currentExpires) return current;
      return current;
    }, candidates[0]);
    return {
      class: best.class,
      source: best.source,
      entitlements: best.entitlements,
      effective_limits: best.effective_limits,
      subscription_id: best.subscription_id,
      subscription_status: best.subscription_status,
      subscription_cost: best.subscription_cost,
      subscription_interval: best.subscription_interval,
      grant_id: best.grant_id,
      grant_source: best.grant_source,
      grant_package_id: best.grant_package_id,
      grant_purchase_id: best.grant_purchase_id,
      expires: best.expires,
    };
  }

  return {
    class: "free",
    source: "free",
    entitlements: tierToEntitlements(tiers["free"]),
    effective_limits: normalizeMembershipEffectiveLimits(
      tiers["free"]?.usage_limits,
    ),
  };
}

function subscriptionStatusRank({
  source,
  subscription_status,
}: Pick<MembershipCandidate, "source" | "subscription_status">): number {
  if (source !== "subscription") {
    return 0;
  }
  switch (subscription_status) {
    case "active":
      return 4;
    case "past_due":
      return 3;
    case "unpaid":
      return 2;
    case "canceled":
      return 1;
    default:
      return 0;
  }
}

function usageStatusCacheKey({
  account_id,
  resolution,
}: {
  account_id: string;
  resolution: MembershipResolution;
}): string {
  return JSON.stringify({
    account_id,
    class: resolution.class,
    source: resolution.source,
    expires: resolution.expires ?? null,
    effective_limits: resolution.effective_limits ?? {},
  });
}

async function getMembershipDetailsUsageStatus({
  account_id,
  resolution,
  refresh,
}: {
  account_id: string;
  resolution: MembershipResolution;
  refresh?: boolean;
}): Promise<MembershipDetails["usage_status"]> {
  const cacheKey = usageStatusCacheKey({ account_id, resolution });
  const cached = membershipUsageStatusCache.get(cacheKey);
  if (cached) {
    return cached.usage_status;
  }
  const inflight = membershipUsageStatusInflight.get(cacheKey);
  if (inflight) {
    return await inflight;
  }
  if (!refresh) {
    return undefined;
  }
  const load = (async () => {
    let usage_status: MembershipDetails["usage_status"] = undefined;
    try {
      usage_status = await getMembershipUsageStatusForAccount({
        account_id,
        resolution,
      });
    } catch (err) {
      log.warn("unable to compute membership usage status", {
        account_id,
        err: `${err}`,
      });
    }
    membershipUsageStatusCache.set(cacheKey, { usage_status });
    return usage_status;
  })();
  membershipUsageStatusInflight.set(cacheKey, load);
  try {
    return await load;
  } finally {
    if (membershipUsageStatusInflight.get(cacheKey) === load) {
      membershipUsageStatusInflight.delete(cacheKey);
    }
  }
}

export async function resolveMembershipDetailsForAccount(
  account_id: string,
  opts?: {
    refresh_usage_status?: boolean;
  },
): Promise<MembershipDetails> {
  const { candidates, selected } =
    await buildMembershipResolutionForAccount(account_id);
  const override = await getActiveAccountEntitlementOverride(account_id);
  const effectiveSelected = applyAccountEntitlementOverride({
    membership: selected,
    override,
  });
  const usage_status = await getMembershipDetailsUsageStatus({
    account_id,
    resolution: effectiveSelected,
    refresh: !!opts?.refresh_usage_status,
  });
  return {
    selected: effectiveSelected,
    candidates,
    usage_status,
    admin_override: override
      ? {
          expires_at: override.expires_at ?? null,
          effects: describeAccountEntitlementOverride(override),
          updated_at: override.updated_at,
        }
      : undefined,
  };
}

export async function resolveMembershipForAccount(
  account_id: string,
): Promise<MembershipResolution> {
  const { selected } = await buildMembershipResolutionForAccount(account_id);
  const override = await getActiveAccountEntitlementOverride(account_id);
  return applyAccountEntitlementOverride({ membership: selected, override });
}
