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

export interface MembershipTier extends MembershipTierWithPresentation {
  id: string;
  label?: string;
  store_visible?: boolean;
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
  subscription_id?: number | null;
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
            webapp_client.conat_client.hub.purchases.getMembershipDetails({}),
          ]);
        if (!isMounted()) return;
        setMembership(membershipResult as MembershipResolution);
        setTiers((tiersResult as MembershipTiersResponse)?.tiers ?? []);
        setDetails((detailsResult as MembershipDetails) ?? null);
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
    return candidates.map((candidate) => {
      const selected =
        details?.selected.class === candidate.class &&
        details?.selected.source === candidate.source;
      const tierLabel = tierById[candidate.class]?.label ?? candidate.class;
      return {
        key: `${candidate.source}-${candidate.class}-${candidate.subscription_id ?? candidate.grant_id ?? "admin"}`,
        tier: tierLabel,
        source:
          candidate.source === "subscription"
            ? "Subscription"
            : candidate.source === "grant"
              ? "Granted"
              : "Admin assigned",
        priority: candidate.priority,
        expires: candidate.expires,
        subscription_id: candidate.subscription_id,
        selected,
      };
    });
  }, [details, tierById]);

  function refresh() {
    setRefreshToken((value) => value + 1);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("cocalc:membership-changed"));
    }
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
