/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo, useRef, useState } from "react";

import { useAsyncEffect, useTypedRedux } from "@cocalc/frontend/app-framework";
import api from "@cocalc/frontend/client/api";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  MembershipDetails,
  MembershipResolution,
} from "@cocalc/conat/hub/api/purchases";

import type { MembershipTierWithPresentation } from "./membership-tier-benefits";
import { dispatchMembershipDetailsRefreshed } from "./membership-usage-events";

export interface MembershipTier extends MembershipTierWithPresentation {
  id: string;
  label?: string;
  store_visible?: boolean;
  site_license_pool_description?: string;
  priority?: number;
  price_monthly?: number;
  price_yearly?: number;
  project_defaults?: Record<string, unknown>;
  ai_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: Record<string, unknown>;
  disabled?: boolean;
}

interface MembershipTiersResponse {
  tiers?: MembershipTier[];
}

export type MembershipCandidateRow = {
  expires?: Date | string | null;
  key: string;
  priority?: number;
  selected: boolean;
  source: string;
  sourceDetail: string;
  status: string;
  subscriptionStatus?: "active" | "canceled" | "unpaid" | "past_due";
  tier: string;
};

export function useMembershipSettingsData(): {
  account_id?: string;
  candidateRows: MembershipCandidateRow[];
  details: MembershipDetails | null;
  error: string;
  loading: boolean;
  membership: MembershipResolution | null;
  refresh: () => void;
  tierById: Record<string, MembershipTier>;
} {
  const account_id = useTypedRedux("account", "account_id");
  const [membership, setMembership] = useState<MembershipResolution | null>(
    null,
  );
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [details, setDetails] = useState<MembershipDetails | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const previousAccountIdRef = useRef(account_id);

  useAsyncEffect(
    async (isMounted) => {
      const accountChanged = previousAccountIdRef.current !== account_id;
      previousAccountIdRef.current = account_id;
      if (!account_id) {
        setError("");
        setMembership(null);
        setTiers([]);
        setDetails(null);
        setLoading(false);
        return;
      }
      if (accountChanged) {
        setMembership(null);
        setTiers([]);
        setDetails(null);
      }
      setLoading(true);
      setError("");
      try {
        const [membershipResult, tiersResult, detailsResult] =
          await Promise.all([
            api("purchases/get-membership"),
            api("purchases/get-membership-tiers"),
            webapp_client.conat_client.hub.purchases.getMembershipDetails({
              refresh_usage_status: true,
            }),
          ]);
        if (!isMounted()) return;
        const nextDetails = (detailsResult as MembershipDetails) ?? null;
        setMembership(membershipResult as MembershipResolution);
        setTiers((tiersResult as MembershipTiersResponse)?.tiers ?? []);
        setDetails(nextDetails);
        if (nextDetails) {
          dispatchMembershipDetailsRefreshed(nextDetails);
        }
      } catch (err) {
        if (!isMounted()) return;
        setError(`${err}`);
      } finally {
        if (isMounted()) {
          setLoading(false);
        }
      }
    },
    [account_id, refreshToken],
  );

  const tierById = useMemo(() => {
    return tiers.reduce(
      (acc, tier) => {
        acc[tier.id] = tier;
        return acc;
      },
      {} as Record<string, MembershipTier>,
    );
  }, [tiers]);

  const candidateRows = useMemo(() => {
    const candidates = details?.candidates ?? [];
    return candidates
      .map((candidate) => {
        const selected =
          details?.selected.class === candidate.class &&
          details?.selected.source === candidate.source;
        const tierLabel = tierById[candidate.class]?.label ?? candidate.class;
        return {
          key: `${candidate.source}-${candidate.class}-${candidate.subscription_id ?? candidate.grant_id ?? "admin"}`,
          tier: tierLabel,
          source: membershipSourceLabel(candidate),
          sourceDetail: membershipSourceDetail(candidate),
          status: membershipCandidateStatus(candidate, selected),
          priority: candidate.priority,
          expires: candidate.expires,
          subscriptionStatus: candidate.subscription_status,
          selected,
        };
      })
      .sort((a, b) => {
        if (a.selected !== b.selected) return a.selected ? -1 : 1;
        return (b.priority ?? 0) - (a.priority ?? 0);
      });
  }, [details, tierById]);

  function refresh() {
    setRefreshToken((value) => value + 1);
  }

  return {
    account_id,
    candidateRows,
    details,
    error,
    loading,
    membership,
    refresh,
    tierById,
  };
}

function membershipSourceLabel({
  grant_source,
  source,
}: {
  grant_source?: string;
  source: "subscription" | "admin" | "grant";
}) {
  if (source === "subscription") return "Personal membership";
  if (source === "admin") return "Admin assigned";
  if (grant_source === "team-seat") return "Team license";
  if (grant_source === "site-license") return "Site license";
  if (grant_source?.includes("course")) return "Course membership";
  return "Granted";
}

function membershipSourceDetail({
  grant_source,
  source,
}: {
  grant_source?: string;
  source: "subscription" | "admin" | "grant";
}) {
  if (source === "subscription") {
    return "Managed here by you.";
  }
  if (source === "admin") {
    return "Managed by site administrators.";
  }
  if (grant_source === "team-seat") {
    return "Managed by the team license owner.";
  }
  if (grant_source === "site-license") {
    return "Managed by the organization license.";
  }
  if (grant_source?.includes("course")) {
    return "Managed through a course or instructor workflow.";
  }
  return "Managed outside personal membership settings.";
}

function membershipCandidateStatus(
  {
    source,
    subscription_status,
  }: {
    source: "subscription" | "admin" | "grant";
    subscription_status?: "active" | "canceled" | "unpaid" | "past_due";
  },
  selected: boolean,
) {
  if (source === "subscription" && subscription_status === "canceled") {
    return selected ? "Used; renewal canceled" : "Renewal canceled";
  }
  if (source === "subscription" && subscription_status === "past_due") {
    return selected ? "Used; payment past due" : "Payment past due";
  }
  if (source === "subscription" && subscription_status === "unpaid") {
    return selected ? "Used; payment pending" : "Payment pending";
  }
  return selected ? "Used" : "Available";
}
