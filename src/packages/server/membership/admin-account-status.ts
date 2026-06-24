/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { MembershipClass } from "@cocalc/conat/hub/api/purchases";

type MembershipSource = "subscription" | "admin" | "grant" | "free";

export interface AdminAccountMembershipStatus {
  membership_class: MembershipClass | string;
  membership_label?: string | null;
  membership_source: MembershipSource;
}

type TierInfo = {
  label?: string | null;
  priority: number;
  disabled?: boolean | null;
};

type Candidate = Omit<AdminAccountMembershipStatus, "membership_source"> & {
  membership_source: Exclude<MembershipSource, "free">;
  priority: number;
  expires_at?: Date | string | null;
  subscription_status?: string | null;
};

const SOURCE_RANK: Record<Exclude<MembershipSource, "free">, number> = {
  subscription: 3,
  admin: 2,
  grant: 1,
};

function subscriptionStatusRank(status?: string | null): number {
  switch (status) {
    case "active":
      return 4;
    case "canceled":
      return 1;
    default:
      return 0;
  }
}

function pickBestCandidate(candidates: Candidate[]): Candidate | undefined {
  return candidates.reduce<Candidate | undefined>((current, candidate) => {
    if (!current) return candidate;
    if (candidate.priority > current.priority) return candidate;
    if (candidate.priority < current.priority) return current;
    if (
      SOURCE_RANK[candidate.membership_source] >
      SOURCE_RANK[current.membership_source]
    ) {
      return candidate;
    }
    if (
      SOURCE_RANK[candidate.membership_source] <
      SOURCE_RANK[current.membership_source]
    ) {
      return current;
    }
    const candidateStatusRank = subscriptionStatusRank(
      candidate.subscription_status,
    );
    const currentStatusRank = subscriptionStatusRank(
      current.subscription_status,
    );
    if (candidateStatusRank > currentStatusRank) return candidate;
    if (candidateStatusRank < currentStatusRank) return current;
    const candidateExpires = candidate.expires_at
      ? new Date(candidate.expires_at).valueOf()
      : -Infinity;
    const currentExpires = current.expires_at
      ? new Date(current.expires_at).valueOf()
      : -Infinity;
    if (candidateExpires > currentExpires) return candidate;
    return current;
  }, undefined);
}

function fallbackLabel(membershipClass: string): string {
  return membershipClass === "free" ? "Free" : membershipClass;
}

function makeCandidate({
  account_id,
  membership_class,
  membership_source,
  tiers,
  expires_at,
  subscription_status,
}: {
  account_id: string;
  membership_class?: string | null;
  membership_source: Exclude<MembershipSource, "free">;
  tiers: Map<string, TierInfo>;
  expires_at?: Date | string | null;
  subscription_status?: string | null;
}): { account_id: string; candidate?: Candidate } {
  const membershipClass = `${membership_class ?? ""}`.trim();
  if (!membershipClass) {
    return { account_id };
  }
  const tier = tiers.get(membershipClass);
  return {
    account_id,
    candidate: {
      membership_class: membershipClass,
      membership_label: tier?.label ?? fallbackLabel(membershipClass),
      membership_source,
      priority: tier?.priority ?? 0,
      expires_at,
      subscription_status,
    },
  };
}

export async function getAdminAccountMembershipStatusMap(
  accountIds: Iterable<string | null | undefined>,
): Promise<Map<string, AdminAccountMembershipStatus>> {
  const ids = Array.from(
    new Set(
      Array.from(accountIds)
        .map((id) => `${id ?? ""}`.trim())
        .filter(Boolean),
    ),
  );
  const statuses = new Map<string, AdminAccountMembershipStatus>();
  for (const id of ids) {
    statuses.set(id, {
      membership_class: "free",
      membership_label: "Free",
      membership_source: "free",
    });
  }
  if (ids.length === 0) {
    return statuses;
  }

  const pool = getPool("medium");
  const tierRows = await pool.query<{
    id: string;
    label?: string | null;
    priority?: number | string | null;
    disabled?: boolean | null;
  }>(
    `SELECT id, label, priority, disabled
       FROM membership_tiers`,
  );
  const tiers = new Map<string, TierInfo>();
  for (const row of tierRows.rows) {
    tiers.set(row.id, {
      label: row.label ?? null,
      priority: Number(row.priority) || 0,
      disabled: row.disabled ?? false,
    });
  }

  const candidates = new Map<string, Candidate[]>();
  const addCandidate = ({
    account_id,
    candidate,
  }: {
    account_id: string;
    candidate?: Candidate;
  }) => {
    if (!candidate) return;
    const list = candidates.get(account_id) ?? [];
    list.push(candidate);
    candidates.set(account_id, list);
  };

  const [subscriptions, adminAssignments, adminGroups, grants] =
    await Promise.all([
      pool.query<{
        account_id: string;
        membership_class?: string | null;
        status?: string | null;
        current_period_end?: Date | string | null;
      }>(
        `SELECT
            account_id::text AS account_id,
            metadata->>'class' AS membership_class,
            status,
            current_period_end
           FROM subscriptions
          WHERE account_id = ANY($1::uuid[])
            AND metadata->>'type' = 'membership'
            AND status IN ('active','canceled')
            AND current_period_end >= NOW()`,
        [ids],
      ),
      pool.query<{
        account_id: string;
        membership_class?: string | null;
        expires_at?: Date | string | null;
      }>(
        `SELECT account_id::text AS account_id, membership_class, expires_at
           FROM admin_assigned_memberships
          WHERE account_id = ANY($1::uuid[])
            AND (expires_at IS NULL OR expires_at > NOW())`,
        [ids],
      ),
      pool.query<{ account_id: string }>(
        `SELECT account_id::text AS account_id
           FROM accounts
          WHERE account_id = ANY($1::uuid[])
            AND 'admin' = ANY(groups)
            AND COALESCE(deleted, false) = false`,
        [ids],
      ),
      pool.query<{
        account_id: string;
        membership_class?: string | null;
        expires_at?: Date | string | null;
      }>(
        `SELECT account_id::text AS account_id, membership_class, expires_at
           FROM membership_grants
          WHERE account_id = ANY($1::uuid[])
            AND revoked_at IS NULL
            AND (starts_at IS NULL OR starts_at <= NOW())
            AND (expires_at IS NULL OR expires_at > NOW())`,
        [ids],
      ),
    ]);

  for (const row of subscriptions.rows) {
    addCandidate(
      makeCandidate({
        account_id: row.account_id,
        membership_class: row.membership_class,
        membership_source: "subscription",
        tiers,
        expires_at: row.current_period_end,
        subscription_status: row.status,
      }),
    );
  }
  for (const row of adminAssignments.rows) {
    addCandidate(
      makeCandidate({
        account_id: row.account_id,
        membership_class: row.membership_class,
        membership_source: "admin",
        tiers,
        expires_at: row.expires_at,
      }),
    );
  }
  const adminTier = tiers.get("admin");
  if (adminTier && !adminTier.disabled) {
    for (const row of adminGroups.rows) {
      addCandidate(
        makeCandidate({
          account_id: row.account_id,
          membership_class: "admin",
          membership_source: "admin",
          tiers,
        }),
      );
    }
  }
  for (const row of grants.rows) {
    addCandidate(
      makeCandidate({
        account_id: row.account_id,
        membership_class: row.membership_class,
        membership_source: "grant",
        tiers,
        expires_at: row.expires_at,
      }),
    );
  }

  for (const [accountId, accountCandidates] of candidates) {
    const best = pickBestCandidate(accountCandidates);
    if (!best) continue;
    statuses.set(accountId, {
      membership_class: best.membership_class,
      membership_label: best.membership_label,
      membership_source: best.membership_source,
    });
  }

  return statuses;
}
