/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo, useRef, useState } from "react";

import { useAsyncEffect, useTypedRedux } from "@cocalc/frontend/app-framework";
import api from "@cocalc/frontend/client/api";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  ClaimableMembershipPackage,
  MembershipCandidate,
  MembershipDetails,
  MembershipResolution,
} from "@cocalc/conat/hub/api/purchases";
import { getClaimableMembershipPackages } from "@cocalc/frontend/purchases/api";

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
  action?: "personal" | "site-license";
  class: string;
  grantId?: string;
  grantPackageId?: string;
  grantPurchaseId?: number;
  key: string;
  membership: string;
  note: string;
  poolDescription?: string | null;
  priority?: number;
  selected: boolean;
  source: string;
  sourceKind: "subscription" | "admin" | "grant" | "free" | "site-request";
  siteLicenseId?: string;
  state: string;
  subscriptionInterval?: "month" | "year";
  subscriptionStatus?: "active" | "canceled";
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
  const [claimablePackages, setClaimablePackages] = useState<
    ClaimableMembershipPackage[]
  >([]);
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
        setClaimablePackages([]);
      }
      setLoading(true);
      setError("");
      try {
        const [membershipResult, tiersResult, detailsResult, claimableResult] =
          await Promise.all([
            api("purchases/get-membership"),
            api("purchases/get-membership-tiers"),
            webapp_client.conat_client.hub.purchases.getMembershipDetails({
              refresh_usage_status: true,
            }),
            getClaimableMembershipPackages({
              include_claimed_site_license_pools: true,
            }).catch(() => []),
          ]);
        if (!isMounted()) return;
        const nextDetails = (detailsResult as MembershipDetails) ?? null;
        setMembership(membershipResult as MembershipResolution);
        setTiers((tiersResult as MembershipTiersResponse)?.tiers ?? []);
        setDetails(nextDetails);
        setClaimablePackages(claimableResult);
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
    const candidates = (details?.candidates ?? []).filter(
      shouldDisplayMembershipCandidate,
    );
    const rows: MembershipCandidateRow[] = candidates.map((candidate) => {
      const selected =
        details?.selected.class === candidate.class &&
        details?.selected.source === candidate.source;
      return {
        key: `${candidate.source}-${candidate.class}-${candidate.subscription_id ?? candidate.grant_id ?? "admin"}`,
        class: candidate.class,
        grantId: candidate.grant_id,
        grantPackageId: candidate.grant_package_id,
        grantPurchaseId: candidate.grant_purchase_id,
        membership: membershipName(candidate, tierById),
        source: membershipSourceLabel(candidate),
        sourceKind: candidate.source,
        siteLicenseId: candidate.site_license_id,
        state: membershipCandidateState(candidate),
        note: membershipCandidateNote(candidate),
        poolDescription: candidate.pool_description,
        priority: candidate.priority,
        selected,
        subscriptionInterval: candidate.subscription_interval,
        subscriptionStatus: candidate.subscription_status,
        action: membershipCandidateAction(candidate),
      } satisfies MembershipCandidateRow;
    });
    if (!candidates.some((candidate) => candidate.source === "subscription")) {
      rows.push(
        defaultPersonalFreeRow(tierById, details?.selected.source === "free"),
      );
    }
    for (const claimablePackage of claimablePackages) {
      if (
        claimablePackage.seat_status === "pending" ||
        claimablePackage.pending_request_id
      ) {
        rows.push(claimablePackageRequestRow(claimablePackage, tierById));
      }
    }
    return sortMembershipCandidateRows(rows);
  }, [claimablePackages, details, tierById]);

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

export function sortMembershipCandidateRows(
  rows: MembershipCandidateRow[],
): MembershipCandidateRow[] {
  return rows.sort((a, b) => {
    const priorityOrder = (b.priority ?? 0) - (a.priority ?? 0);
    if (priorityOrder !== 0) return priorityOrder;
    const stateOrder = membershipStateOrder(a) - membershipStateOrder(b);
    if (stateOrder !== 0) return stateOrder;
    return membershipSourceOrder(a) - membershipSourceOrder(b);
  });
}

export function shouldDisplayMembershipCandidate(
  candidate: MembershipCandidate,
): boolean {
  return !(
    candidate.source === "subscription" &&
    candidate.subscription_status === "canceled" &&
    startsInFuture(candidate.starts)
  );
}

function membershipName(
  candidate: MembershipCandidate,
  tierById: Record<string, MembershipTier>,
): string {
  if (candidate.grant_source === "site-license") {
    const poolName = `${candidate.pool_name ?? ""}`.trim();
    if (poolName) return poolName;
  }
  return tierById[candidate.class]?.label ?? candidate.class;
}

function membershipSourceLabel({
  grant_source,
  organization_name,
  site_license_name,
  source,
}: {
  grant_source?: string;
  organization_name?: string | null;
  site_license_name?: string | null;
  source: "subscription" | "admin" | "grant";
}) {
  if (source === "subscription") return "Personal";
  if (source === "admin") return "Admin assigned";
  if (grant_source === "team-seat") return "Team license";
  if (grant_source === "site-license") {
    return (
      siteLicenseDisplayName({ organization_name, site_license_name }) ??
      "Site license"
    );
  }
  if (grant_source?.includes("course")) return "Course membership";
  return "Granted";
}

function membershipCandidateState(candidate: MembershipCandidate): string {
  if (candidate.source === "subscription") {
    if (candidate.subscription_status === "canceled") {
      return "Renewal canceled";
    }
    if (startsInFuture(candidate.starts)) {
      return "Pending";
    }
  }
  return "Active";
}

function membershipCandidateNote(candidate: MembershipCandidate): string {
  if (candidate.source === "subscription") {
    if (candidate.subscription_status === "canceled") {
      return `Ends ${formatLongDate(candidate.expires) ?? "at period end"}`;
    }
    if (startsInFuture(candidate.starts)) {
      return `Starts ${formatLongDate(candidate.starts) ?? "later"}`;
    }
    if (candidate.expires) {
      return `Renews ${formatLongDate(candidate.expires)}`;
    }
  }
  if (candidate.expires) {
    return `Ends ${formatLongDate(candidate.expires)}`;
  }
  return "No scheduled end";
}

function membershipCandidateAction(
  candidate: MembershipCandidate,
): MembershipCandidateRow["action"] {
  if (candidate.source === "subscription") {
    return "personal";
  }
  if (candidate.grant_source === "site-license") {
    return "site-license";
  }
}

function defaultPersonalFreeRow(
  tierById: Record<string, MembershipTier>,
  selected: boolean,
): MembershipCandidateRow {
  return {
    action: "personal",
    class: "free",
    key: "free-personal-default",
    membership: tierById.free?.label ?? "Free",
    note: "No scheduled end",
    priority: tierById.free?.priority ?? 0,
    selected,
    source: "Personal",
    sourceKind: "free",
    state: "Active",
  };
}

function claimablePackageRequestRow(
  claimablePackage: ClaimableMembershipPackage,
  tierById: Record<string, MembershipTier>,
): MembershipCandidateRow {
  const membership =
    `${claimablePackage.pool_name ?? ""}`.trim() ||
    tierById[claimablePackage.membership_class]?.label ||
    claimablePackage.membership_class;
  return {
    action: "site-license",
    class: claimablePackage.membership_class,
    key: `site-request-${claimablePackage.pending_request_id ?? claimablePackage.package_id}`,
    membership,
    note: "Awaiting manager approval",
    poolDescription: claimablePackage.pool_description,
    priority: tierById[claimablePackage.membership_class]?.priority ?? 0,
    selected: false,
    siteLicenseId: claimablePackage.site_license_id,
    source: siteLicenseDisplayName(claimablePackage) ?? "Site license",
    sourceKind: "site-request",
    state: "Pending approval",
  };
}

function siteLicenseDisplayName({
  organization_name,
  site_license_name,
}: {
  organization_name?: string | null;
  site_license_name?: string | null;
}): string | undefined {
  const title = `${site_license_name ?? ""}`.trim();
  const organization = `${organization_name ?? ""}`.trim();
  return title || organization || undefined;
}

function startsInFuture(value?: Date | string): boolean {
  if (value == null) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.valueOf() > Date.now();
}

function formatLongDate(value?: Date | string | null): string | undefined {
  if (value == null) return;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function membershipSourceOrder(row: MembershipCandidateRow): number {
  switch (row.sourceKind) {
    case "subscription":
    case "free":
      return 0;
    case "site-request":
      return 1;
    case "grant":
      return row.action === "site-license" ? 1 : 2;
    case "admin":
      return 3;
  }
}

function membershipStateOrder(row: MembershipCandidateRow): number {
  switch (row.state) {
    case "Renewal canceled":
      return 0;
    case "Pending":
    case "Pending approval":
      return 1;
    case "Active":
      return 2;
    default:
      return 3;
  }
}
