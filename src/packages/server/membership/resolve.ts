import getPool from "@cocalc/database/pool";
import type {
  MembershipClass,
  MembershipCandidate,
  MembershipDetails,
  MembershipEntitlements,
  MembershipResolution,
} from "@cocalc/conat/hub/api/purchases";
import { getMembershipTierMap, MembershipTierRecord } from "./tiers";

function tierToEntitlements(tier?: MembershipTierRecord): MembershipEntitlements {
  if (!tier) return {};
  return {
    project_defaults: tier.project_defaults,
    llm_limits: tier.llm_limits,
    features: tier.features,
  };
}

async function buildMembershipCandidates(
  account_id: string,
  tiers: Record<string, MembershipTierRecord>,
): Promise<MembershipCandidate[]> {
  const pool = getPool("medium");
  const [subResult, adminResult] = await Promise.all([
    pool.query(
      `SELECT id, metadata, current_period_end, status
       FROM subscriptions
       WHERE account_id=$1
         AND metadata->>'type'='membership'
         AND status IN ('active','unpaid','past_due')
         AND current_period_end >= NOW()
       ORDER BY current_period_end DESC
       LIMIT 1`,
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
  ]);

  const candidates: MembershipCandidate[] = [];

  const sub = subResult.rows[0];
  if (sub) {
    const membershipClass = (sub.metadata?.class ??
      "free") as MembershipClass;
    const tier = tiers[membershipClass];
    candidates.push({
      class: membershipClass,
      source: "subscription",
      priority: tier?.priority ?? 0,
      entitlements: tierToEntitlements(tier),
      subscription_id: sub.id,
      expires: sub.current_period_end,
    });
  }

  const admin = adminResult.rows[0];
  if (admin?.membership_class) {
    const membershipClass = admin.membership_class as MembershipClass;
    const tier = tiers[membershipClass];
    candidates.push({
      class: membershipClass,
      source: "admin",
      priority: tier?.priority ?? 0,
      entitlements: tierToEntitlements(tier),
      expires: admin.expires_at ?? undefined,
    });
  }

  return candidates;
}

function pickBestMembership(
  candidates: MembershipCandidate[],
  tiers: Record<string, MembershipTierRecord>,
): MembershipResolution {
  if (candidates.length > 0) {
    const sourceRank = {
      subscription: 2,
      admin: 1,
    } as const;
    const best = candidates.reduce((current, candidate) => {
      if (!current) return candidate;
      if (candidate.priority > current.priority) return candidate;
      if (candidate.priority < current.priority) return current;
      return sourceRank[candidate.source] > sourceRank[current.source]
        ? candidate
        : current;
    }, candidates[0]);
    return {
      class: best.class,
      source: best.source,
      entitlements: best.entitlements,
      subscription_id: best.subscription_id,
      expires: best.expires,
    };
  }

  return {
    class: "free",
    source: "free",
    entitlements: tierToEntitlements(tiers["free"]),
  };
}

export async function resolveMembershipDetailsForAccount(
  account_id: string,
): Promise<MembershipDetails> {
  const tiers = await getMembershipTierMap({ includeDisabled: true });
  const candidates = await buildMembershipCandidates(account_id, tiers);
  return {
    selected: pickBestMembership(candidates, tiers),
    candidates,
  };
}

export async function resolveMembershipForAccount(
  account_id: string,
): Promise<MembershipResolution> {
  const details = await resolveMembershipDetailsForAccount(account_id);
  return details.selected;
}
