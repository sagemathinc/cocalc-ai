import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import TTL from "@isaacs/ttlcache";
import type {
  MembershipClass,
  MembershipCandidate,
  MembershipDetails,
  MembershipEntitlements,
  MembershipResolution,
} from "@cocalc/conat/hub/api/purchases";
import {
  getSeedMembershipTierById,
  getSeedMembershipTierMap,
  MembershipTierRecord,
} from "./tiers";
import { listActiveMembershipGrantsForAccount } from "./grants";
import getLogger from "@cocalc/backend/logger";
import { normalizeMembershipEffectiveLimits } from "./effective-limits";
import { TIER_TEMPLATES } from "@cocalc/util/membership-tier-templates";
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
  client?: PoolClient,
): Promise<MembershipCandidate[]> {
  const pool = client ?? getPool("medium");
  const [subResult, adminResult, adminGroupResult, grants] = await Promise.all([
    pool.query(
      `SELECT s.id, s.metadata, s.cost, s.interval,
              s.current_period_start, s.current_period_end, s.status,
              CASE WHEN a.not_before <= NOW() THEN a.state END
                AS renewal_state,
              CASE WHEN a.not_before <= NOW() THEN a.not_before END
                AS renewal_started_at
         FROM subscriptions s
         LEFT JOIN LATERAL (
           SELECT state, not_before
             FROM subscription_renewal_attempts
            WHERE subscription_id=s.id
              AND state IN ('scheduled','processing')
            ORDER BY period_end DESC
            LIMIT 1
         ) a ON TRUE
        WHERE s.account_id=$1
          AND s.metadata->>'type'='membership'
          AND s.status IN ('active','canceled')
          AND (
            s.current_period_end >= NOW() OR
            (s.status='active' AND a.not_before <= NOW())
          )
        ORDER BY s.current_period_end DESC, s.id DESC`,
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
    listActiveMembershipGrantsForAccount(account_id, client),
  ]);

  const candidates: MembershipCandidate[] = [];
  const packageMetadata = await getMembershipPackageMetadataForGrants(
    grants,
    client,
  );
  const [siteLicenseDisplayNames, teamLicenseInfo] = await Promise.all([
    getCurrentSiteLicenseDisplayNamesForGrants(grants, client),
    getCurrentTeamLicenseInfoForPackageMetadata(packageMetadata, client),
  ]);

  for (const sub of subResult.rows) {
    const membershipClass = (sub.metadata?.class ?? "free") as MembershipClass;
    const tier =
      tiers[membershipClass] ??
      (client
        ? undefined
        : await getSeedMembershipTierById({
            id: membershipClass,
            allowStale: true,
          }));
    candidates.push({
      class: membershipClass,
      source: "subscription",
      priority: tier?.priority ?? 0,
      entitlements: tierToEntitlements(tier),
      effective_limits: normalizeMembershipEffectiveLimits(tier?.usage_limits),
      starts: sub.current_period_start,
      subscription_id: sub.id,
      subscription_status: sub.status,
      subscription_renewal_state: sub.renewal_state,
      subscription_renewal_started_at: sub.renewal_started_at,
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
      (client
        ? undefined
        : await getSeedMembershipTierById({
            id: membershipClass,
            allowStale: true,
          }));
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
      (client
        ? undefined
        : await getSeedMembershipTierById({
            id: membershipClass,
            allowStale: true,
          }));
    const siteLicenseId = getMetadataString(grant.metadata, "site_license_id");
    const siteLicenseDisplayName =
      siteLicenseId == null
        ? undefined
        : siteLicenseDisplayNames.get(siteLicenseId);
    const pkgMetadata = grant.package_id
      ? packageMetadata.get(grant.package_id)
      : undefined;
    const teamLicenseId =
      getMetadataString(pkgMetadata, "team_license_id") ??
      getMetadataString(grant.metadata, "team_license_id");
    const teamLicense = teamLicenseId
      ? teamLicenseInfo.get(teamLicenseId)
      : undefined;
    const teamLicensePeriodEnd = teamLicense?.current_period_end;
    const teamLicenseWarning =
      teamLicenseId &&
      teamLicense?.status === "past_due" &&
      teamLicensePeriodEnd
        ? {
            type: "past_due" as const,
            team_license_id: teamLicenseId,
            expired_at: teamLicensePeriodEnd,
            message: `Your Team License expired on ${formatDate(teamLicensePeriodEnd)}. Please contact your manager to avoid losing access.`,
          }
        : undefined;
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
      pool_name:
        getMetadataString(grant.metadata, "pool_name") ??
        getMetadataString(pkgMetadata, "pool_name"),
      pool_description:
        getMetadataString(grant.metadata, "pool_description") ??
        getMetadataString(pkgMetadata, "pool_description"),
      site_license_id: siteLicenseId ?? undefined,
      site_license_name:
        siteLicenseDisplayName?.name ??
        getMetadataString(grant.metadata, "site_license_name"),
      organization_name:
        siteLicenseDisplayName?.organization_name ??
        getMetadataString(grant.metadata, "organization_name"),
      team_license_id: teamLicenseId,
      team_license_status:
        teamLicense?.status === "past_due" || teamLicense?.status === "canceled"
          ? teamLicense.status
          : teamLicense?.status
            ? "active"
            : undefined,
      team_license_period_end: teamLicensePeriodEnd,
      team_license_warning: teamLicenseWarning,
      expires: grant.expires_at ? new Date(grant.expires_at) : undefined,
    });
  }

  return dedupeEquivalentAdminCandidates(candidates);
}

async function getMembershipPackageMetadataForGrants(
  grants: Awaited<ReturnType<typeof listActiveMembershipGrantsForAccount>>,
  client?: PoolClient,
): Promise<Map<string, Record<string, unknown> | null>> {
  const packageIds = Array.from(
    new Set(
      grants
        .map((grant) => grant.package_id)
        .filter((id): id is string => !!id),
    ),
  );
  if (packageIds.length === 0) {
    return new Map();
  }
  const { rows } = await (client ?? getPool("medium")).query<{
    id: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, metadata
       FROM membership_packages
      WHERE id = ANY($1::uuid[])`,
    [packageIds],
  );
  return new Map(rows.map((row) => [row.id, row.metadata]));
}

async function getCurrentTeamLicenseInfoForPackageMetadata(
  packageMetadata: Map<string, Record<string, unknown> | null>,
  client?: PoolClient,
): Promise<
  Map<string, { status?: string; current_period_end?: Date | string }>
> {
  const teamLicenseIds = Array.from(
    new Set(
      Array.from(packageMetadata.values())
        .map((metadata) => getMetadataString(metadata, "team_license_id"))
        .filter((teamLicenseId): teamLicenseId is string => !!teamLicenseId),
    ),
  );
  if (teamLicenseIds.length === 0) {
    return new Map();
  }
  const { rows } = await (client ?? getPool("medium")).query<{
    id: string;
    status?: string | null;
    current_period_end?: Date | string | null;
  }>(
    `SELECT id::text AS id, status, current_period_end
       FROM team_licenses
      WHERE id::text = ANY($1::text[])`,
    [teamLicenseIds],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        status: getMetadataString(row, "status"),
        current_period_end: row.current_period_end ?? undefined,
      },
    ]),
  );
}

async function getCurrentSiteLicenseDisplayNamesForGrants(
  grants: Awaited<ReturnType<typeof listActiveMembershipGrantsForAccount>>,
  client?: PoolClient,
): Promise<Map<string, { name?: string; organization_name?: string }>> {
  const siteLicenseIds = Array.from(
    new Set(
      grants
        .map((grant) => getMetadataString(grant.metadata, "site_license_id"))
        .filter((siteLicenseId): siteLicenseId is string => !!siteLicenseId),
    ),
  );
  if (siteLicenseIds.length === 0) {
    return new Map();
  }
  const { rows } = await (client ?? getPool("medium")).query<{
    id: string;
    name?: string | null;
    organization_name?: string | null;
  }>(
    `SELECT id::text AS id, name, organization_name
       FROM site_licenses
      WHERE id::text = ANY($1::text[])`,
    [siteLicenseIds],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        name: getMetadataString(row, "name"),
        organization_name: getMetadataString(row, "organization_name"),
      },
    ]),
  );
}

function getMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = `${metadata?.[key] ?? ""}`.trim();
  return value || undefined;
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

async function buildMembershipResolutionForAccount(
  account_id: string,
  options?: { client: PoolClient; tiers: Record<string, MembershipTierRecord> },
): Promise<{
  candidates: MembershipCandidate[];
  selected: MembershipResolution;
}> {
  const tiers =
    options?.tiers ??
    (await getSeedMembershipTierMap({
      includeDisabled: true,
      allowStale: true,
    }));
  const candidates = await buildMembershipCandidates(
    account_id,
    tiers,
    options?.client,
  );
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
      starts: best.starts,
      subscription_id: best.subscription_id,
      subscription_status: best.subscription_status,
      subscription_renewal_state: best.subscription_renewal_state,
      subscription_renewal_started_at: best.subscription_renewal_started_at,
      subscription_cost: best.subscription_cost,
      subscription_interval: best.subscription_interval,
      grant_id: best.grant_id,
      grant_source: best.grant_source,
      grant_package_id: best.grant_package_id,
      grant_purchase_id: best.grant_purchase_id,
      pool_name: best.pool_name,
      pool_description: best.pool_description,
      site_license_id: best.site_license_id,
      site_license_name: best.site_license_name,
      organization_name: best.organization_name,
      team_license_id: best.team_license_id,
      team_license_status: best.team_license_status,
      team_license_period_end: best.team_license_period_end,
      team_license_warning: best.team_license_warning,
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

// CoCalc Star is a self-hosted server without billing: membership tiers do
// not limit what one account may do there, only the machine-wide cap on
// running projects does. Every usage limit is classified below, and a test
// keeps the classification exhaustive.

// Removed: consumers treat a missing limit as no limit, or (agent turn
// admission) fall back to the server-wide operational defaults.
export const STAR_UNLIMITED_USAGE_LIMITS = [
  "max_projects",
  "max_sponsored_running_projects",
  "total_storage_soft_bytes",
  "total_storage_hard_bytes",
  "egress_5h_bytes",
  "egress_7d_bytes",
  "cpu_5h_seconds",
  "cpu_7d_seconds",
  "browser_idle_timeout_seconds",
  "public_directory_shares",
  "project_max_collaborators_and_pending_invites",
  "course_max_students_and_pending_invites",
  "acp_max_queued_per_account",
  "acp_max_queued_per_thread",
  "acp_max_created_5h_per_account",
  "acp_max_created_7d_per_account",
  "acp_max_running_per_account",
  "acp_max_running_per_project",
  "acp_max_active_automations_per_project",
  "blob_account_total_bytes",
  "blob_account_count",
  "blob_project_total_bytes",
  "blob_project_count",
  "rootfs_count",
  "rootfs_total_storage_gb",
  "rootfs_max_storage_gb",
] as const;

// Set from the most generous built-in tier: a missing value would mean a
// small default (or, for OCI images, disallowed) rather than no limit.
export const STAR_GENEROUS_USAGE_LIMITS = [
  "max_named_agents",
  "max_agent_network_members",
  "max_snapshots_per_project",
  "max_backups_per_project",
  "rootfs_oci_images",
] as const;

// Kept as configured: not allowances of a membership tier. Scheduling
// priority; egress policy (Star never network-blocks projects, see
// run-quota.ts); spending limits (Star has no billing); and anti-spam email
// limits (outgoing email is the admin's own configuration).
export const STAR_RETAINED_USAGE_LIMITS = [
  "shared_compute_priority",
  "egress_policy",
  "dedicated_host_egress_policy",
  "credit_spend_limit_5h_usd",
  "credit_spend_limit_7d_usd",
  "prepaid_host_usage_limit_5h_usd",
  "prepaid_host_usage_limit_7d_usd",
  "notification_email_send_limit_5h",
  "notification_email_send_limit_7d",
  "invite_email_send_enabled",
  "invite_email_daily_count",
  "invite_email_hourly_count",
  "invite_email_recipients_per_batch",
  "invite_email_pending_per_project",
  "invite_email_pending_per_course",
  "invite_email_resend_cooldown_minutes",
  "invite_email_custom_message_max_chars",
  "invite_email_allow_project_title",
  "invite_email_allow_course_title",
  "invite_email_allow_urls",
  "invite_email_link_copy_enabled",
] as const;

// Per-project sizes on Star (MB): at least this much, or the tier's own
// larger defaults. Still bounded by the machine's project pool.
export const STAR_PROJECT_DEFAULTS = { memory: 8000, disk_quota: 20000 };

export function applySetupProfileMembershipLimits(
  membership: MembershipResolution,
  setupProfile: string | undefined = process.env.COCALC_SETUP_PROFILE,
): MembershipResolution {
  if (`${setupProfile ?? ""}`.trim() !== "star") return membership;
  const generous = TIER_TEMPLATES.admin.usage_limits as Record<string, unknown>;
  function unlimited<T extends object | undefined>(limits: T): T {
    if (limits == null) return limits;
    const next: Record<string, unknown> = { ...limits };
    for (const key of STAR_UNLIMITED_USAGE_LIMITS) delete next[key];
    for (const key of STAR_GENEROUS_USAGE_LIMITS) next[key] = generous[key];
    return next as T;
  }
  return {
    ...membership,
    entitlements: membership.entitlements && {
      ...membership.entitlements,
      usage_limits: unlimited(membership.entitlements.usage_limits),
      project_defaults: starProjectDefaults(
        membership.entitlements.project_defaults,
      ),
    },
    effective_limits: unlimited(membership.effective_limits),
  };
}

function starProjectDefaults(
  defaults: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...defaults };
  for (const [key, minimum] of Object.entries(STAR_PROJECT_DEFAULTS)) {
    const current = Number(next[key]);
    next[key] = Number.isFinite(current) ? Math.max(current, minimum) : minimum;
  }
  return next;
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
  const effectiveSelected = applySetupProfileMembershipLimits(
    applyAccountEntitlementOverride({
      membership: selected,
      override,
    }),
  );
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
  options?: { client: PoolClient; tiers: Record<string, MembershipTierRecord> },
): Promise<MembershipResolution> {
  const { selected } = await buildMembershipResolutionForAccount(
    account_id,
    options,
  );
  const override = await getActiveAccountEntitlementOverride(
    account_id,
    options?.client,
  );
  return applySetupProfileMembershipLimits(
    applyAccountEntitlementOverride({ membership: selected, override }),
  );
}
