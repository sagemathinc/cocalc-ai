/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon, Loading, Tooltip } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { MembershipTierBenefits } from "./membership-tier-benefits";
import type { MembershipTierLike } from "./membership-tiers";
import MoneyStatistic from "@cocalc/frontend/purchases/money-statistic";
import Payments from "@cocalc/frontend/purchases/payments";
import {
  addSiteLicensePool,
  adminProvisionSiteLicense,
  archiveSiteLicensePool,
  assignMembershipPackageSeat,
  claimMembershipPackageSeat,
  getSiteLicenseAffiliationReverificationStatus,
  getClaimableMembershipPackages,
  getMembershipPackageQuote,
  getMembershipPackages,
  isPurchaseAllowed,
  listSiteLicenseOverviews,
  processPaymentIntents,
  purchaseMembershipPackage,
  refreshSiteLicenseAffiliationVerification,
  removeSiteLicenseManager,
  requestSiteLicensePool,
  reviewSiteLicensePoolRequest,
  revokeMembershipPackageSeat,
  setSiteLicenseManager,
  updateMembershipPackage,
  updateSiteLicense,
} from "@cocalc/frontend/purchases/api";
import StripePayment from "@cocalc/frontend/purchases/stripe-payment";
import openSupportTab from "@cocalc/frontend/support/open";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  ClaimableMembershipPackage,
  MembershipClass,
  MembershipPackageAssignment,
  MembershipPackageDetails,
  MembershipPackageKind,
  MembershipPackageQuote,
  SiteLicenseManagerRole,
  SiteLicenseAffiliationReverificationUserStatus,
  SiteLicenseOverview,
  SiteLicensePoolConfig,
  SiteLicensePoolRequest,
  SiteLicenseVerificationPolicy,
} from "@cocalc/conat/hub/api/purchases";
import { MEMBERSHIP_PACKAGE_PURCHASE } from "@cocalc/util/db-schema/purchases";
import {
  capitalize,
  currency,
  is_valid_email_address as isValidEmailAddress,
} from "@cocalc/util/misc";
import { moneyRound2Up, toDecimal } from "@cocalc/util/money";
import { sortMembershipTiersByDisplayOrder } from "@cocalc/util/membership-tier-order";
import { COLORS } from "@cocalc/util/theme";
import type { LineItem } from "@cocalc/util/stripe/types";
import { openAccountSettings } from "./settings-routing";

const { Paragraph, Text, Title } = Typography;

interface Props {
  tiers: MembershipTierLike[];
  onChanged?: () => void;
  user_account_id?: string;
}

interface PackageUserSearchResult {
  account_id: string;
  first_name?: string;
  last_name?: string;
  email_address?: string;
}

function packageUserSearchLabel(user: PackageUserSearchResult): ReactNode {
  const displayName = [user.first_name, user.last_name]
    .map((part) => `${part ?? ""}`.trim())
    .filter(Boolean)
    .join(" ");
  return (
    <Space orientation="vertical" size={0}>
      <Text>{displayName || user.email_address || user.account_id}</Text>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {[user.email_address, user.account_id].filter(Boolean).join(" · ")}
      </Text>
    </Space>
  );
}

interface ClaimableMembershipPackagesPanelProps {
  compact?: boolean;
  hasSiteLicenseMembership?: boolean;
  onChanged?: () => void;
  tiers?: MembershipTierLike[];
}

function CompactField({
  children,
  help,
  label,
  style,
}: {
  children: ReactNode;
  help?: ReactNode;
  label: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
        ...style,
      }}
    >
      <Text strong>{label}</Text>
      {children}
      {help ? <Text type="secondary">{help}</Text> : null}
    </div>
  );
}

function getProvisionPoolTheme(
  pool: SiteLicensePoolConfig,
  index: number,
): {
  accent: string;
  background: string;
  description: string;
  icon: IconName;
} {
  const name = `${pool.pool_name ?? ""}`.toLowerCase();
  const membershipClass = `${pool.membership_class ?? ""}`.toLowerCase();
  if (name.includes("instructor") || membershipClass.includes("instructor")) {
    return {
      accent: COLORS.BS_BLUE_TEXT,
      background: COLORS.ANTD_BG_BLUE_L,
      description: "Higher-trust teaching access with manager review.",
      icon: "graduation-cap",
    };
  }
  if (name.includes("research") || membershipClass.includes("research")) {
    return {
      accent: COLORS.BRWN,
      background: COLORS.YELL_LLL,
      description: "Research access can coexist with teaching access.",
      icon: "atom",
    };
  }
  if (name.includes("student") || membershipClass.includes("student")) {
    return {
      accent: COLORS.ANTD_GREEN_D,
      background: COLORS.BS_GREEN_LL,
      description: "Baseline campus access for verified-domain users.",
      icon: "users",
    };
  }
  return {
    accent: COLORS.BLUE_D,
    background: index % 2 === 0 ? COLORS.BLUE_LLLL : COLORS.GRAY_LLL,
    description: "Custom seat pool for this site license.",
    icon: "users",
  };
}

function toTime(value?: Date | null): number {
  return value instanceof Date ? value.valueOf() : 0;
}

function isActiveAssignment(
  assignment?: MembershipPackageAssignment | null,
): boolean {
  return !!assignment && !assignment.revoked_at;
}

function sortPackagesByRecent(
  packages: MembershipPackageDetails[],
): MembershipPackageDetails[] {
  return [...packages].sort(
    (left, right) =>
      toTime(right.updated) - toTime(left.updated) ||
      toTime(right.created) - toTime(left.created),
  );
}

function getPackageKindLabel(kind: MembershipPackageKind): string {
  switch (kind) {
    case "team":
      return "Team package";
    case "site":
      return "Site license";
    case "course":
      return "Course package";
  }
}

function getTeamSeatTiers(tiers: MembershipTierLike[]): MembershipTierLike[] {
  return sortMembershipTiersByDisplayOrder(
    tiers.filter(
      (tier) =>
        !tier.disabled &&
        tier.store_visible !== false &&
        tier.id !== "free" &&
        tier.id !== "student",
    ),
  );
}

function getSiteLicenseProvisioningTiers(
  tiers: MembershipTierLike[],
): MembershipTierLike[] {
  return sortMembershipTiersByDisplayOrder(
    tiers.filter(
      (tier) => !tier.disabled && tier.id !== "free" && tier.id !== "admin",
    ),
  );
}

function findSiteLicenseTier({
  tiers,
  used,
  keywords,
  fallbackIndex,
}: {
  tiers: MembershipTierLike[];
  used: Set<string>;
  keywords: string[];
  fallbackIndex: number;
}): MembershipTierLike | undefined {
  const available = tiers.filter((tier) => !used.has(tier.id));
  const keywordMatch = available.find((tier) => {
    const text = `${tier.id} ${tier.label ?? ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
  });
  return keywordMatch ?? available[fallbackIndex] ?? available[0];
}

function makeDefaultSiteLicensePool({
  tiers,
  index,
}: {
  tiers: MembershipTierLike[];
  index: number;
}): SiteLicensePoolConfig {
  const tier = tiers[0];
  return {
    pool_name: `Pool ${index + 1}`,
    pool_description: getTierSiteLicensePoolDescription(tier),
    membership_class: (tier?.id ?? "standard") as MembershipClass,
    seat_count: 25,
    requires_approval: true,
    verification_policy: "email-domain",
    exclusive_group: `group-${index + 1}`,
    affiliation_reverification_days: 365,
    affiliation_reverification_grace_days: 30,
  };
}

function getTierSiteLicensePoolDescription(tier?: MembershipTierLike): string {
  return `${tier?.site_license_pool_description ?? ""}`.trim();
}

function getPoolDescriptionPatchForTierChange({
  currentPool,
  currentTier,
  nextTier,
}: {
  currentPool: SiteLicensePoolConfig;
  currentTier?: MembershipTierLike;
  nextTier?: MembershipTierLike;
}): Pick<SiteLicensePoolConfig, "pool_description"> | undefined {
  const currentDescription = `${currentPool.pool_description ?? ""}`.trim();
  const currentTierDescription = getTierSiteLicensePoolDescription(currentTier);
  if (currentDescription && currentDescription !== currentTierDescription) {
    return;
  }
  return {
    pool_description: getTierSiteLicensePoolDescription(nextTier) || null,
  };
}

function getPackageDomains(
  membershipPackage: MembershipPackageDetails,
): string[] {
  const candidates = [
    membershipPackage.metadata?.allowed_domains,
    membershipPackage.metadata?.domains,
    membershipPackage.metadata?.email_domains,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
    }
  }
  return [];
}

function normalizeDomainList(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) => `${value ?? ""}`.split(/[\s,;]+/))
        .map((domain) => domain.trim().toLowerCase().replace(/^@+/, ""))
        .filter((domain) => domain.length > 0),
    ),
  ).sort();
}

const SITE_LICENSE_VERIFICATION_OPTIONS: {
  label: string;
  value: SiteLicenseVerificationPolicy;
}[] = [
  { label: "Email domain", value: "email-domain" },
  { label: "Manager approval", value: "manager-approval" },
  { label: "SSO affiliation", value: "sso-affiliation" },
];

function normalizeSiteLicenseVerificationPolicy(
  value: unknown,
): SiteLicenseVerificationPolicy {
  const policy = `${value ?? ""}`.trim();
  if (
    policy === "email-domain" ||
    policy === "manager-approval" ||
    policy === "sso-affiliation"
  ) {
    return policy;
  }
  return "email-domain";
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return null;
  }
  return normalized;
}

function siteLicensePoolConfigFromPackage(
  membershipPackage: MembershipPackageDetails,
): SiteLicensePoolConfig {
  const metadata = membershipPackage.metadata ?? {};
  return {
    pool_name:
      `${metadata.pool_name ?? ""}`.trim() ||
      capitalize(membershipPackage.membership_class),
    pool_description: `${metadata.pool_description ?? ""}`.trim() || null,
    membership_class: membershipPackage.membership_class,
    seat_count: membershipPackage.seat_count,
    requires_approval: metadata.requires_approval === true,
    verification_policy: normalizeSiteLicenseVerificationPolicy(
      metadata.verification_policy,
    ),
    exclusive_group:
      `${metadata.exclusive_group ?? ""}`.trim() ||
      membershipPackage.membership_class,
    affiliation_reverification_days: normalizeOptionalPositiveInteger(
      metadata.affiliation_reverification_days,
    ),
    affiliation_reverification_grace_days: normalizeOptionalPositiveInteger(
      metadata.affiliation_reverification_grace_days,
    ),
    allowed_domains: normalizeDomainList(getPackageDomains(membershipPackage)),
  };
}

function getAccountDisplayName(
  assignment: MembershipPackageAssignment,
  names: Record<
    string,
    { first_name?: string; last_name?: string } | undefined
  >,
): string {
  if (!assignment.account_id) {
    return assignment.email_address ?? "Pending email claim";
  }
  const name = names[assignment.account_id];
  const fullName = `${name?.first_name ?? ""} ${name?.last_name ?? ""}`.trim();
  return fullName || assignment.account_id;
}

function getAccountSecondaryLabel(
  assignment: MembershipPackageAssignment,
  names: Record<
    string,
    { first_name?: string; last_name?: string } | undefined
  >,
): string | undefined {
  if (!assignment.account_id) {
    return "Reserved by email";
  }
  const name = names[assignment.account_id];
  const fullName = `${name?.first_name ?? ""} ${name?.last_name ?? ""}`.trim();
  if (!fullName) return;
  return assignment.account_id;
}

async function revokeSeatOrThrow({
  package_id,
  assignment,
}: {
  package_id: string;
  assignment: MembershipPackageAssignment;
}): Promise<void> {
  const targetAccountId = assignment.account_id ?? undefined;
  const result = await revokeMembershipPackageSeat({
    package_id,
    target_account_id: targetAccountId,
    target_email_address: targetAccountId
      ? undefined
      : (assignment.email_address ?? undefined),
  });
  if (!result.revoked) {
    throw Error("Seat was not revoked. Refresh the page and try again.");
  }
}

function ClaimablePoolSummary({
  claimablePackage,
}: {
  claimablePackage: ClaimableMembershipPackage;
}) {
  const description = `${claimablePackage.pool_description ?? ""}`.trim();
  if (!description) {
    return null;
  }
  return <Text type="secondary">{description}</Text>;
}

function getClaimableSeatStatus(
  claimablePackage: ClaimableMembershipPackage,
): NonNullable<ClaimableMembershipPackage["seat_status"]> {
  return (
    claimablePackage.seat_status ??
    (claimablePackage.pending_request_id ? "pending" : "claimable")
  );
}

function dateLabel(value?: Date | string | null): string {
  if (!value) return "none";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return `${value}`;
  return date.toISOString().slice(0, 10);
}

function getSiteLicenseDisplayTitle(
  siteLicense: SiteLicenseOverview["site_license"],
): string {
  const name = `${siteLicense.name ?? ""}`.trim();
  const organizationName = `${siteLicense.organization_name ?? ""}`.trim();
  const normalizedName = name.toLowerCase();
  const normalizedOrganizationName = organizationName.toLowerCase();
  if (
    name &&
    organizationName &&
    normalizedName !== normalizedOrganizationName
  ) {
    return `${name} - ${organizationName}`;
  }
  return name || organizationName || "Site license";
}

function siteLicenseDate(value?: Date | string | null): Dayjs | undefined {
  if (!value) return undefined;
  const date = dayjs(value);
  return date.isValid() ? date : undefined;
}

function formatSiteLicenseDate(value: Dayjs): string {
  return value.format("MMMM D, YYYY");
}

function getSiteLicenseLifecycleInfo(
  siteLicense: SiteLicenseOverview["site_license"],
): {
  expired: boolean;
  expires?: string;
  starts?: string;
} {
  const today = dayjs().startOf("day");
  const startsAt = siteLicenseDate(siteLicense.starts_at);
  const expiresAt = siteLicenseDate(siteLicense.expires_at);
  const starts =
    startsAt != null && startsAt.startOf("day").isAfter(today)
      ? `Starts on ${formatSiteLicenseDate(startsAt)}`
      : undefined;
  if (expiresAt == null) {
    return { expired: false, starts };
  }
  const expired = expiresAt.startOf("day").isBefore(today);
  return {
    expired,
    expires: `${expired ? "Expired on" : "Valid until"} ${formatSiteLicenseDate(
      expiresAt,
    )}`,
    starts,
  };
}

function countPendingRequests(overview: SiteLicenseOverview): number {
  return overview.pending_requests.filter(
    (request) => request.state === "pending",
  ).length;
}

function getPoolActiveSeats(
  pool: SiteLicenseOverview["pools"][number],
): number {
  return pool.assignments.filter(isActiveAssignment).length;
}

function getPoolAvailableSeats(
  pool: SiteLicenseOverview["pools"][number],
): number {
  return Math.max(0, pool.seat_count - getPoolActiveSeats(pool));
}

function getPoolUtilizationPercent(
  pool: SiteLicenseOverview["pools"][number],
): number {
  if (pool.seat_count <= 0) return 0;
  return Math.min(
    100,
    Math.round((getPoolActiveSeats(pool) / pool.seat_count) * 100),
  );
}

function getOverviewSeatTotals(overview: SiteLicenseOverview): {
  activeSeats: number;
  availableSeats: number;
  pendingRequests: number;
  totalSeats: number;
} {
  const seatTotals = overview.pools.reduce(
    (totals, pool) => ({
      activeSeats: totals.activeSeats + getPoolActiveSeats(pool),
      availableSeats: totals.availableSeats + getPoolAvailableSeats(pool),
      totalSeats: totals.totalSeats + pool.seat_count,
    }),
    { activeSeats: 0, availableSeats: 0, totalSeats: 0 },
  );
  return {
    ...seatTotals,
    pendingRequests: countPendingRequests(overview),
  };
}

function getSiteLicensePeriodLabel(overview: SiteLicenseOverview): string {
  const starts = dateLabel(overview.site_license.starts_at);
  const expires = dateLabel(overview.site_license.expires_at);
  if (starts === "none" && expires === "none") {
    return "no dates";
  }
  if (starts === "none") {
    return `until ${expires}`;
  }
  if (expires === "none") {
    return `from ${starts}`;
  }
  return `${starts} to ${expires}`;
}

function getSiteLicenseSearchText(overview: SiteLicenseOverview): string {
  return [
    overview.site_license.id,
    overview.site_license.name,
    overview.site_license.organization_name,
    overview.site_license.bay_id,
    ...(overview.site_license.allowed_domains ?? []),
    ...overview.pools.map((pool) => pool.pool_name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function canManageSiteLicenseOverview({
  isAdmin,
  overview,
}: {
  isAdmin: boolean;
  overview: SiteLicenseOverview;
}): boolean {
  return (
    isAdmin ||
    overview.viewer_role === "admin" ||
    overview.viewer_role === "manager"
  );
}

export function ClaimableMembershipPackagesPanel({
  compact,
  hasSiteLicenseMembership = false,
  onChanged,
}: ClaimableMembershipPackagesPanelProps) {
  const account_id = useTypedRedux("account", "account_id");
  const email_address = useTypedRedux("account", "email_address");
  const email_address_verified = useTypedRedux(
    "account",
    "email_address_verified",
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [claimingPackageId, setClaimingPackageId] = useState<string>("");
  const [requestingPackageId, setRequestingPackageId] = useState<string>("");
  const [termsTarget, setTermsTarget] =
    useState<ClaimableMembershipPackage | null>(null);
  const [termsAccepted, setTermsAccepted] = useState<boolean>(false);
  const [compactModalOpen, setCompactModalOpen] = useState<boolean>(false);
  const [claimables, setClaimables] = useState<ClaimableMembershipPackage[]>(
    [],
  );
  async function refreshClaimables() {
    if (!account_id) {
      setClaimables([]);
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setClaimables(
        await getClaimableMembershipPackages({
          include_claimed_site_license_pools: true,
        }),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshClaimables();
  }, [account_id]);

  async function claimPackage(
    claimablePackage: ClaimableMembershipPackage,
    accepted_terms = false,
  ) {
    setClaimingPackageId(claimablePackage.package_id);
    setError("");
    try {
      await claimMembershipPackageSeat({
        package_id: claimablePackage.package_id,
        ...(accepted_terms ? { accepted_terms: true } : {}),
      });
      await refreshClaimables();
      setCompactModalOpen(false);
      onChanged?.();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setClaimingPackageId("");
    }
  }

  async function requestPool(
    claimablePackage: ClaimableMembershipPackage,
    accepted_terms = false,
  ) {
    setRequestingPackageId(claimablePackage.package_id);
    setError("");
    try {
      await requestSiteLicensePool({
        owner_account_id: claimablePackage.owner_account_id,
        package_id: claimablePackage.package_id,
        ...(accepted_terms ? { accepted_terms: true } : {}),
      });
      await refreshClaimables();
      setCompactModalOpen(false);
      onChanged?.();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRequestingPackageId("");
    }
  }

  function handlePrimaryAction(claimablePackage: ClaimableMembershipPackage) {
    if (claimablePackage.requires_terms_acceptance) {
      setTermsTarget(claimablePackage);
      setTermsAccepted(false);
      return;
    }
    if (claimablePackage.requires_approval) {
      void requestPool(claimablePackage);
    } else {
      void claimPackage(claimablePackage);
    }
  }

  if (!account_id) {
    return null;
  }
  const emailVerified =
    !!email_address && !!email_address_verified?.get?.(email_address);
  const compactButtonPrimary =
    !hasSiteLicenseMembership &&
    claimables.some(
      (claimablePackage) =>
        getClaimableSeatStatus(claimablePackage) === "claimable",
    );

  function renderClaimablePackages() {
    return (
      <Space vertical size="middle" style={{ width: "100%" }}>
        {claimables.map((claimablePackage) => {
          const seatStatus = getClaimableSeatStatus(claimablePackage);
          const title =
            `${claimablePackage.pool_name ?? ""}`.trim() ||
            "Site license membership";
          return (
            <Card
              key={`${claimablePackage.package_id}-${claimablePackage.reason}-${claimablePackage.assignment_id ?? "open"}`}
              size="small"
              title={<Text strong>{title}</Text>}
            >
              <Space vertical size="small" style={{ width: "100%" }}>
                <ClaimablePoolSummary claimablePackage={claimablePackage} />
                {claimablePackage.requires_terms_acceptance ? (
                  <Text type="secondary">
                    Review institution terms before claiming this membership.
                  </Text>
                ) : null}
                {claimablePackage.expires_at ? (
                  <Text type="secondary">
                    Expires <TimeAgo date={claimablePackage.expires_at} />.
                  </Text>
                ) : null}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  {seatStatus === "claimed" ? (
                    <Button disabled title="Seat claimed">
                      Seat claimed
                    </Button>
                  ) : claimablePackage.requires_approval ? (
                    <Button
                      loading={
                        requestingPackageId === claimablePackage.package_id
                      }
                      disabled={seatStatus === "pending"}
                      title={seatStatus === "pending" ? "Request pending" : ""}
                      onClick={() => handlePrimaryAction(claimablePackage)}
                    >
                      {seatStatus === "pending"
                        ? "Request pending"
                        : "Request access"}
                    </Button>
                  ) : (
                    <Button
                      loading={
                        claimingPackageId === claimablePackage.package_id
                      }
                      onClick={() => handlePrimaryAction(claimablePackage)}
                    >
                      Claim seat
                    </Button>
                  )}
                </div>
              </Space>
            </Card>
          );
        })}
      </Space>
    );
  }

  const termsModal = (
    <Modal
      open={termsTarget != null}
      title="Review institution terms"
      okText={termsTarget?.requires_approval ? "Request access" : "Claim seat"}
      okButtonProps={{ disabled: !termsAccepted }}
      onCancel={() => {
        setTermsTarget(null);
        setTermsAccepted(false);
      }}
      onOk={async () => {
        const target = termsTarget;
        if (!target) return;
        setTermsTarget(null);
        setTermsAccepted(false);
        if (target.requires_approval) {
          await requestPool(target, true);
        } else {
          await claimPackage(target, true);
        }
      }}
      destroyOnHidden
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="Your institution requires custom terms or policies"
          description="Review the configured links before using this institution-funded CoCalc membership."
        />
        {termsTarget?.custom_terms_url ? (
          <a
            href={termsTarget.custom_terms_url}
            target="_blank"
            rel="noreferrer"
          >
            Custom terms of service
          </a>
        ) : null}
        {termsTarget?.custom_policy_url ? (
          <a
            href={termsTarget.custom_policy_url}
            target="_blank"
            rel="noreferrer"
          >
            Institution policy
          </a>
        ) : null}
        {termsTarget?.terms_version_label ? (
          <Text type="secondary">
            Terms version: {termsTarget.terms_version_label}
          </Text>
        ) : null}
        <Checkbox
          checked={termsAccepted}
          onChange={(event) => setTermsAccepted(event.target.checked)}
        >
          I have reviewed the institution terms and policies for this
          membership.
        </Checkbox>
      </Space>
    </Modal>
  );

  if (compact) {
    const disabledReason =
      claimables.length > 0
        ? undefined
        : emailVerified
          ? `Your signed-in email address ${email_address} is verified, but no reserved seats or matching site-license pools are available for it right now.`
          : `Verify your signed-in email address ${email_address} to claim reserved seats or matching site-license memberships.`;
    return (
      <>
        <Tooltip title={disabledReason}>
          <span>
            <Button
              disabled={!loading && claimables.length === 0}
              loading={loading}
              onClick={() => setCompactModalOpen(true)}
              type={compactButtonPrimary ? "primary" : undefined}
            >
              Claim site license membership
            </Button>
          </span>
        </Tooltip>
        {error ? <Alert type="error" message={error} showIcon /> : null}
        <Modal
          open={compactModalOpen}
          title="Claim site license membership"
          footer={null}
          onCancel={() => setCompactModalOpen(false)}
          destroyOnHidden
        >
          {renderClaimablePackages()}
        </Modal>
        {termsModal}
      </>
    );
  }

  return (
    <div>
      <Text strong>Claim memberships</Text>
      <Paragraph type="secondary" style={{ marginTop: "6px" }}>
        If a seat was reserved for one of your verified email addresses, or if
        your verified domain matches an available site license, you can claim
        that membership here.
      </Paragraph>
      {loading ? <Loading /> : null}
      {error ? (
        <Alert type="error" title={error} style={{ marginBottom: 12 }} />
      ) : null}
      {!loading && !error && claimables.length === 0 ? (
        <Alert
          type="info"
          showIcon
          title="No claimable memberships right now"
          description={
            emailVerified ? (
              <span>
                Your signed-in email address <Text code>{email_address}</Text>{" "}
                is verified, but no reserved seats or matching site-license
                pools are available for it right now.
              </span>
            ) : (
              <Space orientation="vertical" size="small">
                <span>
                  Verify your signed-in email address{" "}
                  <Text code>{email_address}</Text> to claim reserved seats or
                  matching site-license memberships.
                </span>
                <Button
                  size="small"
                  onClick={() => openAccountSettings({ page: "profile" })}
                >
                  Open Profile email verification
                </Button>
              </Space>
            )
          }
        />
      ) : null}
      {!loading && claimables.length > 0 ? renderClaimablePackages() : null}
      {termsModal}
    </div>
  );
}

export function SiteLicenseReverificationPanel({
  onChanged,
}: {
  onChanged?: () => void;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const [loading, setLoading] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [status, setStatus] =
    useState<SiteLicenseAffiliationReverificationUserStatus | null>(null);

  async function refreshStatus() {
    if (!account_id) {
      setStatus(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setStatus(await getSiteLicenseAffiliationReverificationStatus());
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, [account_id]);

  async function refreshAffiliation(site_license_id?: string) {
    setRefreshing(site_license_id ?? "all");
    setError("");
    try {
      await refreshSiteLicenseAffiliationVerification({ site_license_id });
      await refreshStatus();
      onChanged?.();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRefreshing("");
    }
  }

  if (!account_id) return null;
  if (loading && status == null) return null;
  if (!error && (!status || status.seats.length === 0)) return null;

  return (
    <Card
      size="small"
      title={
        <Space>
          <Icon name="refresh" />
          <span>Site-license affiliation</span>
          {status?.pending_count ? (
            <Tag color="gold">{status.pending_count} need review</Tag>
          ) : null}
          {status?.grace_expired_count ? (
            <Tag color="red">{status.grace_expired_count} grace expired</Tag>
          ) : null}
        </Space>
      }
      extra={
        <Button
          size="small"
          loading={refreshing === "all"}
          onClick={() => void refreshAffiliation()}
        >
          Refresh with verified email
        </Button>
      }
    >
      {error ? (
        <Alert type="error" title={error} style={{ marginBottom: 12 }} />
      ) : null}
      <Space orientation="vertical" style={{ width: "100%" }}>
        {(status?.seats ?? []).map((seat) => (
          <div
            key={`${seat.site_license_id}-${seat.package_id}`}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              borderBottom: `1px solid ${COLORS.GRAY_LLL}`,
              paddingBottom: 8,
            }}
          >
            <Space orientation="vertical" size={1}>
              <Space wrap>
                <Text strong>
                  {seat.organization_name ||
                    seat.site_license_name ||
                    seat.site_license_id}
                </Text>
                <Tag color={seat.state === "current" ? "green" : "gold"}>
                  {seat.state.replace(/_/g, " ")}
                </Tag>
                <Tag>{capitalize(seat.membership_class)}</Tag>
                {seat.pool_name ? <Tag>{seat.pool_name}</Tag> : null}
              </Space>
              <Text type="secondary">
                Verified {dateLabel(seat.affiliation_verified_at)} using{" "}
                {seat.matched_email_address || seat.verification_policy}.
                Reverify by {dateLabel(seat.reverification_due_at)}; grace ends{" "}
                {dateLabel(seat.reverification_grace_expires_at)}.
              </Text>
            </Space>
            <Button
              size="small"
              disabled={!seat.can_refresh_with_verified_email}
              loading={refreshing === seat.site_license_id}
              onClick={() => void refreshAffiliation(seat.site_license_id)}
            >
              Refresh
            </Button>
          </div>
        ))}
      </Space>
    </Card>
  );
}

export function TeamPackageManager({
  tiers,
  onChanged,
  user_account_id,
}: Props) {
  const account_id = useTypedRedux("account", "account_id");
  const ownerAccountId = user_account_id ?? account_id;
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [membershipPackages, setMembershipPackages] = useState<
    MembershipPackageDetails[]
  >([]);
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [purchaseTarget, setPurchaseTarget] = useState<
    MembershipPackageDetails | null | undefined
  >(undefined);
  const [assignmentTarget, setAssignmentTarget] =
    useState<MembershipPackageDetails | null>(null);
  const [accountNames, setAccountNames] = useState<
    Record<string, { first_name?: string; last_name?: string } | undefined>
  >({});
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

  const refreshPackages = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getMembershipPackages(
        user_account_id ? { user_account_id } : {},
      );
      setMembershipPackages(sortPackagesByRecent(next));
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!ownerAccountId) {
      setMembershipPackages([]);
      setAccountNames({});
      setError("");
      setLoading(false);
      return;
    }
    void refreshPackages();
  }, [ownerAccountId, refreshToken, user_account_id]);

  const assignedAccountIds = useMemo(() => {
    return Array.from(
      new Set(
        [
          ...membershipPackages.flatMap((membershipPackage) =>
            membershipPackage.assignments
              .filter(isActiveAssignment)
              .map((assignment) => assignment.account_id),
          ),
        ].filter((value): value is string => !!value),
      ),
    );
  }, [membershipPackages]);

  useEffect(() => {
    let canceled = false;
    async function loadNames() {
      if (assignedAccountIds.length === 0) {
        setAccountNames({});
        return;
      }
      try {
        const next =
          await webapp_client.users_client.getNames(assignedAccountIds);
        if (!canceled) {
          setAccountNames(next ?? {});
        }
      } catch (_err) {
        if (!canceled) {
          setAccountNames({});
        }
      }
    }
    void loadNames();
    return () => {
      canceled = true;
    };
  }, [assignedAccountIds]);

  const teamPackages = useMemo(
    () =>
      membershipPackages.filter(
        (membershipPackage) => membershipPackage.kind === "team",
      ),
    [membershipPackages],
  );

  const handleChanged = async () => {
    await refreshPackages();
    onChanged?.();
  };

  if (!ownerAccountId) {
    return null;
  }

  return (
    <div>
      {error && (
        <Alert type="error" title={error} style={{ marginBottom: 12 }} />
      )}
      <Space wrap style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setPurchaseTarget(null)}>
          <Icon name="shopping-cart" /> Buy team seats
        </Button>
        <Button onClick={() => setRefreshToken((value) => value + 1)}>
          <Icon name="refresh" /> Refresh
        </Button>
      </Space>
      {loading ? (
        <Loading />
      ) : (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <PackageGroup
            title="Team packages"
            emptyTitle="No team packages yet"
            emptyDescription="Buy team seats here, then assign them to the accounts that should receive membership access."
            membershipPackages={teamPackages}
            tiers={tiers}
            accountNames={accountNames}
            onAddSeats={(membershipPackage) =>
              setPurchaseTarget(membershipPackage)
            }
            onAssignSeat={(membershipPackage) =>
              setAssignmentTarget(membershipPackage)
            }
            onRevokeSeat={async (membershipPackage, assignment) => {
              setError("");
              try {
                await runFreshAuthAction(async () => {
                  await revokeSeatOrThrow({
                    package_id: membershipPackage.id,
                    assignment,
                  });
                  await handleChanged();
                });
              } catch (err) {
                setError(`${err}`);
              }
            }}
          />
        </Space>
      )}
      <TeamPackagePurchaseModal
        open={purchaseTarget !== undefined}
        membershipPackage={purchaseTarget ?? undefined}
        tiers={tiers}
        onClose={() => setPurchaseTarget(undefined)}
        onPurchased={handleChanged}
      />
      <AssignMembershipSeatModal
        open={assignmentTarget != null}
        membershipPackage={assignmentTarget}
        onClose={() => setAssignmentTarget(null)}
        onAssigned={async () => {
          setAssignmentTarget(null);
          await handleChanged();
        }}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}

export function SiteLicenseManager({
  tiers,
  onChanged,
}: {
  tiers: MembershipTierLike[];
  onChanged?: () => void;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const zendesk = !!useTypedRedux("customize", "zendesk");
  const [error, setError] = useState<string>("");
  const [siteLicenseOverviews, setSiteLicenseOverviews] = useState<
    SiteLicenseOverview[]
  >([]);
  const [siteLicenseReviewLoadingId, setSiteLicenseReviewLoadingId] =
    useState<string>("");
  const [siteLicenseOverviewLoading, setSiteLicenseOverviewLoading] =
    useState<boolean>(true);
  const [siteLicenseOverviewError, setSiteLicenseOverviewError] =
    useState<string>("");
  const [accountNames, setAccountNames] = useState<
    Record<string, { first_name?: string; last_name?: string } | undefined>
  >({});
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

  const refreshSiteLicenseOverviews = async () => {
    if (!account_id) {
      setSiteLicenseOverviews([]);
      setSiteLicenseOverviewError("");
      setSiteLicenseOverviewLoading(false);
      return;
    }
    setSiteLicenseOverviewLoading(true);
    setSiteLicenseOverviewError("");
    try {
      setSiteLicenseOverviews(await listSiteLicenseOverviews());
    } catch (err) {
      setSiteLicenseOverviews([]);
      setSiteLicenseOverviewError(`${err}`);
    } finally {
      setSiteLicenseOverviewLoading(false);
    }
  };

  useEffect(() => {
    void refreshSiteLicenseOverviews();
  }, [account_id]);

  const assignedAccountIds = useMemo(() => {
    return Array.from(
      new Set(
        siteLicenseOverviews
          .flatMap((overview) =>
            overview.pools.flatMap((pool) =>
              pool.assignments
                .filter(isActiveAssignment)
                .map((assignment) => assignment.account_id),
            ),
          )
          .filter((value): value is string => !!value),
      ),
    );
  }, [siteLicenseOverviews]);

  useEffect(() => {
    let canceled = false;
    async function loadNames() {
      if (assignedAccountIds.length === 0) {
        setAccountNames({});
        return;
      }
      try {
        const next =
          await webapp_client.users_client.getNames(assignedAccountIds);
        if (!canceled) {
          setAccountNames(next ?? {});
        }
      } catch (_err) {
        if (!canceled) {
          setAccountNames({});
        }
      }
    }
    void loadNames();
    return () => {
      canceled = true;
    };
  }, [assignedAccountIds]);

  const handleChanged = async () => {
    await refreshSiteLicenseOverviews();
    onChanged?.();
  };

  if (!account_id) {
    return null;
  }

  return (
    <div>
      {error && (
        <Alert type="error" title={error} style={{ marginBottom: 12 }} />
      )}
      {!siteLicenseOverviewLoading &&
      !siteLicenseOverviewError &&
      siteLicenseOverviews.length === 0 ? (
        <Alert
          type="info"
          showIcon
          title="No site licenses to manage"
          description={
            <Space orientation="vertical">
              <Text>
                Site-license owners and managers see their license dashboards
                here after an admin attaches them.
              </Text>
              {zendesk ? (
                <Button
                  type="primary"
                  onClick={() =>
                    openSupportTab({
                      body: "I would like to discuss setting up or managing a CoCalc site license.",
                      subject: "Site license request",
                      type: "purchase",
                    })
                  }
                >
                  File a support ticket
                </Button>
              ) : null}
            </Space>
          }
        />
      ) : null}
      <SiteLicenseDashboard
        overviews={siteLicenseOverviews}
        loading={siteLicenseOverviewLoading}
        error={siteLicenseOverviewError}
        tiers={tiers}
        accountNames={accountNames}
        isAdmin={false}
        reviewingRequestId={siteLicenseReviewLoadingId}
        onReview={async (_overview, request, action) => {
          setSiteLicenseReviewLoadingId(request.id);
          setError("");
          try {
            await runFreshAuthAction(async () => {
              await reviewSiteLicensePoolRequest({
                request_id: request.id,
                action,
              });
              await handleChanged();
            });
          } catch (err) {
            setError(`${err}`);
          } finally {
            setSiteLicenseReviewLoadingId("");
          }
        }}
        onRevokeSeat={async (pool, assignment) => {
          setError("");
          try {
            await runFreshAuthAction(async () => {
              await revokeSeatOrThrow({
                package_id: pool.id,
                assignment,
              });
              await handleChanged();
            });
          } catch (err) {
            setError(`${err}`);
          }
        }}
        onSetManager={async (site_license_id, target_account_id, role) => {
          await runFreshAuthAction(async () => {
            await setSiteLicenseManager({
              site_license_id,
              target_account_id,
              role,
            });
            await handleChanged();
          });
        }}
        onRemoveManager={async (site_license_id, target_account_id) => {
          await runFreshAuthAction(async () => {
            await removeSiteLicenseManager({
              site_license_id,
              target_account_id,
            });
            await handleChanged();
          });
        }}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}

export function SiteLicenseAdminPanel({
  tiers,
  onChanged,
}: {
  tiers: MembershipTierLike[];
  onChanged?: () => void;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const [overviews, setOverviews] = useState<SiteLicenseOverview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [licenseSearch, setLicenseSearch] = useState("");
  const [selectedSiteLicenseId, setSelectedSiteLicenseId] = useState("");
  const [editTarget, setEditTarget] = useState<MembershipPackageDetails | null>(
    null,
  );
  const [accountNames, setAccountNames] = useState<
    Record<string, { first_name?: string; last_name?: string } | undefined>
  >({});
  const [reviewingRequestId, setReviewingRequestId] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

  async function refreshOverviews() {
    if (!account_id) {
      setOverviews([]);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setOverviews(await listSiteLicenseOverviews({ admin: true }));
    } catch (err) {
      setOverviews([]);
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshOverviews();
  }, [account_id, refreshToken]);

  const assignedAccountIds = useMemo(
    () =>
      Array.from(
        new Set(
          overviews
            .flatMap((overview) =>
              overview.pools.flatMap((pool) =>
                pool.assignments
                  .filter(isActiveAssignment)
                  .map((assignment) => assignment.account_id),
              ),
            )
            .filter((value): value is string => !!value),
        ),
      ),
    [overviews],
  );

  useEffect(() => {
    let canceled = false;
    async function loadNames() {
      if (assignedAccountIds.length === 0) {
        setAccountNames({});
        return;
      }
      try {
        const next =
          await webapp_client.users_client.getNames(assignedAccountIds);
        if (!canceled) {
          setAccountNames(next ?? {});
        }
      } catch (_err) {
        if (!canceled) {
          setAccountNames({});
        }
      }
    }
    void loadNames();
    return () => {
      canceled = true;
    };
  }, [assignedAccountIds]);

  async function handleChanged() {
    await refreshOverviews();
    onChanged?.();
  }

  const filteredOverviews = useMemo(() => {
    const needle = licenseSearch.trim().toLowerCase();
    if (!needle) {
      return overviews;
    }
    return overviews.filter((overview) =>
      getSiteLicenseSearchText(overview).includes(needle),
    );
  }, [licenseSearch, overviews]);

  useEffect(() => {
    if (filteredOverviews.length === 0) {
      if (selectedSiteLicenseId) {
        setSelectedSiteLicenseId("");
      }
      return;
    }
    if (
      selectedSiteLicenseId &&
      !filteredOverviews.some(
        (overview) => overview.site_license.id === selectedSiteLicenseId,
      )
    ) {
      setSelectedSiteLicenseId("");
    }
  }, [filteredOverviews, selectedSiteLicenseId]);

  const renderAdminDashboard = (dashboardOverviews: SiteLicenseOverview[]) => (
    <SiteLicenseDashboard
      overviews={dashboardOverviews}
      loading={false}
      error=""
      tiers={tiers}
      accountNames={accountNames}
      isAdmin={true}
      reviewingRequestId={reviewingRequestId}
      onEditPool={(pool) => setEditTarget(pool)}
      onAddPool={async (site_license_id, pool) => {
        await runFreshAuthAction(async () => {
          await addSiteLicensePool({ site_license_id, pool });
          await handleChanged();
        });
      }}
      onArchivePool={async (pool) => {
        setError("");
        try {
          await runFreshAuthAction(async () => {
            await archiveSiteLicensePool({ package_id: pool.id });
            await handleChanged();
          });
        } catch (err) {
          setError(`${err}`);
        }
      }}
      onReview={async (_overview, request, action) => {
        setReviewingRequestId(request.id);
        setError("");
        try {
          await runFreshAuthAction(async () => {
            await reviewSiteLicensePoolRequest({
              request_id: request.id,
              action,
            });
            await handleChanged();
          });
        } catch (err) {
          setError(`${err}`);
        } finally {
          setReviewingRequestId("");
        }
      }}
      onRevokeSeat={async (pool, assignment) => {
        setError("");
        try {
          await runFreshAuthAction(async () => {
            await revokeSeatOrThrow({
              package_id: pool.id,
              assignment,
            });
            await handleChanged();
          });
        } catch (err) {
          setError(`${err}`);
        }
      }}
      onUpdateLicense={async (site_license_id, updates) => {
        await runFreshAuthAction(async () => {
          await updateSiteLicense({ site_license_id, ...updates });
          await handleChanged();
        });
      }}
      onSetManager={async (site_license_id, target_account_id, role) => {
        await runFreshAuthAction(async () => {
          await setSiteLicenseManager({
            site_license_id,
            target_account_id,
            role,
          });
          await handleChanged();
        });
      }}
      onRemoveManager={async (site_license_id, target_account_id) => {
        await runFreshAuthAction(async () => {
          await removeSiteLicenseManager({
            site_license_id,
            target_account_id,
          });
          await handleChanged();
        });
      }}
    />
  );

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Button type="primary" onClick={() => setProvisionOpen(true)}>
          <Icon name="plus-circle" /> Provision site license
        </Button>
        <Button onClick={() => setRefreshToken((value) => value + 1)}>
          <Icon name="refresh" /> Refresh list
        </Button>
        <Input.Search
          allowClear
          placeholder="Find by license, organization, domain, or bay"
          style={{ width: 360 }}
          value={licenseSearch}
          onChange={(event) => setLicenseSearch(event.target.value)}
          onSearch={setLicenseSearch}
        />
      </Space>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {!loading && overviews.length === 0 && !error ? (
        <Alert
          type="info"
          showIcon
          title="No site licenses configured"
          description="Provision a site license here, then add customer owners or managers after the license has been checked."
        />
      ) : null}
      {overviews.length > 0 ? (
        <SiteLicenseSummaryTable
          overviews={filteredOverviews}
          selectedSiteLicenseId={selectedSiteLicenseId}
          totalCount={overviews.length}
          onToggle={(siteLicenseId) =>
            setSelectedSiteLicenseId((currentSiteLicenseId) =>
              currentSiteLicenseId === siteLicenseId ? "" : siteLicenseId,
            )
          }
          renderExpandedRow={(overview) => renderAdminDashboard([overview])}
        />
      ) : null}
      {overviews.length > 0 && filteredOverviews.length === 0 ? (
        <Alert
          type="info"
          showIcon
          title="No matching site licenses"
          description="Clear the search to show all configured site licenses."
        />
      ) : null}
      <ProvisionSiteLicenseModal
        open={provisionOpen}
        tiers={tiers}
        onClose={() => setProvisionOpen(false)}
        onProvisioned={async () => {
          setProvisionOpen(false);
          await handleChanged();
        }}
      />
      <EditSiteLicenseModal
        open={editTarget != null}
        membershipPackage={editTarget}
        tiers={tiers}
        onClose={() => setEditTarget(null)}
        onUpdated={async () => {
          setEditTarget(null);
          await handleChanged();
        }}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}

function SiteLicenseSummaryTable({
  overviews,
  selectedSiteLicenseId,
  totalCount,
  onToggle,
  renderExpandedRow,
}: {
  overviews: SiteLicenseOverview[];
  selectedSiteLicenseId: string;
  totalCount: number;
  onToggle: (siteLicenseId: string) => void;
  renderExpandedRow: (overview: SiteLicenseOverview) => ReactNode;
}) {
  return (
    <Card size="small">
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        <Space wrap style={{ justifyContent: "space-between", width: "100%" }}>
          <Text strong>Site licenses</Text>
          <Text type="secondary">
            Showing {overviews.length} of {totalCount}
          </Text>
        </Space>
        <Table<SiteLicenseOverview>
          dataSource={overviews}
          expandable={{
            expandedRowKeys: selectedSiteLicenseId
              ? [selectedSiteLicenseId]
              : [],
            expandedRowRender: (overview) =>
              selectedSiteLicenseId === overview.site_license.id
                ? renderExpandedRow(overview)
                : null,
            showExpandColumn: false,
          }}
          pagination={false}
          rowKey={(overview) => overview.site_license.id}
          onRow={(overview) => ({
            "aria-expanded": selectedSiteLicenseId === overview.site_license.id,
            "data-site-license-id": overview.site_license.id,
            onClick: () => onToggle(overview.site_license.id),
            style: { cursor: "pointer" },
          })}
          scroll={{ x: true }}
          size="small"
        >
          <Table.Column<SiteLicenseOverview>
            title="License"
            render={(_, overview) => (
              <Space orientation="vertical" size={0}>
                <Text strong>{overview.site_license.name}</Text>
                <Text type="secondary">
                  {overview.site_license.organization_name}
                </Text>
              </Space>
            )}
          />
          <Table.Column<SiteLicenseOverview>
            title="Seats"
            render={(_, overview) => {
              const totals = getOverviewSeatTotals(overview);
              return (
                <Space orientation="vertical" size={0}>
                  <Text strong>
                    {totals.activeSeats} / {totals.totalSeats}
                  </Text>
                  <Text type="secondary">
                    {totals.availableSeats} available
                  </Text>
                </Space>
              );
            }}
          />
          <Table.Column<SiteLicenseOverview>
            title="Requests"
            render={(_, overview) => {
              const pending = getOverviewSeatTotals(overview).pendingRequests;
              return pending ? (
                <Tag color="gold">{pending} pending</Tag>
              ) : (
                <Text type="secondary">none</Text>
              );
            }}
          />
          <Table.Column<SiteLicenseOverview>
            title="Pools"
            render={(_, overview) => overview.pools.length}
          />
          <Table.Column<SiteLicenseOverview>
            title="Domains"
            render={(_, overview) => {
              const domains = overview.site_license.allowed_domains ?? [];
              if (domains.length === 0) {
                return <Text type="secondary">none</Text>;
              }
              return (
                <Space wrap size={4}>
                  {domains.slice(0, 2).map((domain) => (
                    <Tag key={domain}>{domain}</Tag>
                  ))}
                  {domains.length > 2 ? <Tag>+{domains.length - 2}</Tag> : null}
                </Space>
              );
            }}
          />
          <Table.Column<SiteLicenseOverview>
            title="Period"
            render={(_, overview) => (
              <Text type="secondary">
                {getSiteLicensePeriodLabel(overview)}
              </Text>
            )}
          />
          <Table.Column<SiteLicenseOverview>
            title="Seed bay"
            render={(_, overview) => (
              <Text type="secondary">{overview.site_license.bay_id}</Text>
            )}
          />
        </Table>
      </Space>
    </Card>
  );
}

function SiteLicenseDashboard({
  overviews,
  loading,
  error,
  tiers,
  accountNames,
  isAdmin,
  reviewingRequestId,
  onEditPool,
  onAddPool,
  onArchivePool,
  onReview,
  onRevokeSeat,
  onUpdateLicense,
  onSetManager,
  onRemoveManager,
}: {
  overviews: SiteLicenseOverview[];
  loading: boolean;
  error: string;
  tiers: MembershipTierLike[];
  accountNames: Record<
    string,
    { first_name?: string; last_name?: string } | undefined
  >;
  isAdmin: boolean;
  reviewingRequestId: string;
  onEditPool?: (pool: SiteLicenseOverview["pools"][number]) => void;
  onAddPool?: (
    site_license_id: string,
    pool: SiteLicensePoolConfig,
  ) => Promise<void>;
  onArchivePool?: (pool: SiteLicenseOverview["pools"][number]) => Promise<void>;
  onReview: (
    overview: SiteLicenseOverview,
    request: SiteLicensePoolRequest,
    action: "approve" | "reject",
  ) => Promise<void>;
  onRevokeSeat: (
    pool: SiteLicenseOverview["pools"][number],
    assignment: MembershipPackageAssignment,
  ) => Promise<void>;
  onUpdateLicense?: (
    site_license_id: string,
    updates: {
      name?: string;
      organization_name?: string;
      allowed_domains?: string[];
      custom_terms_url?: string | null;
      custom_policy_url?: string | null;
      terms_version_label?: string | null;
      renewal_policy?: string | null;
      overage_policy?: string | null;
      starts_at?: Date | string | null;
      expires_at?: Date | string | null;
    },
  ) => Promise<void>;
  onSetManager: (
    site_license_id: string,
    target_account_id: string,
    role: SiteLicenseManagerRole,
  ) => Promise<void>;
  onRemoveManager: (
    site_license_id: string,
    target_account_id: string,
  ) => Promise<void>;
}) {
  const [revokingSeat, setRevokingSeat] = useState<string>("");
  const [archivingPoolId, setArchivingPoolId] = useState<string>("");
  const [editingLicense, setEditingLicense] =
    useState<SiteLicenseOverview | null>(null);
  const [addingPool, setAddingPool] = useState<{
    overview: SiteLicenseOverview;
    pool: SiteLicensePoolConfig;
  } | null>(null);
  const [addingPoolSubmitting, setAddingPoolSubmitting] = useState(false);
  const [addingPoolError, setAddingPoolError] = useState("");
  const siteLicenseTierOptions = useMemo(
    () => getSiteLicenseProvisioningTiers(tiers),
    [tiers],
  );
  const requests = overviews.flatMap((overview) =>
    overview.pending_requests.map((request) => ({
      overview,
      request,
      pool: overview.pools.find((pool) => pool.id === request.package_id),
    })),
  );
  if (loading) {
    return (
      <Card size="small">
        <Spin /> <Text type="secondary">Loading site-license dashboard...</Text>
      </Card>
    );
  }
  if (error) {
    return (
      <Alert
        type="warning"
        showIcon
        title="Could not load site-license dashboard"
        description={error}
      />
    );
  }
  if (overviews.length === 0) {
    return null;
  }
  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      {overviews.map((overview) => {
        const overviewRequests = requests.filter(
          ({ overview: requestOverview, request }) =>
            requestOverview.site_license.id === overview.site_license.id &&
            request.state === "pending",
        );
        const canEditManagers = isAdmin;
        const canManageLicense = canManageSiteLicenseOverview({
          isAdmin,
          overview,
        });
        const lifecycleInfo = getSiteLicenseLifecycleInfo(
          overview.site_license,
        );
        const lifecycleItems = [
          lifecycleInfo.starts,
          lifecycleInfo.expired ? undefined : lifecycleInfo.expires,
        ].filter((item): item is string => !!item);
        const domains = overview.site_license.allowed_domains ?? [];
        const hasDocuments =
          !!overview.site_license.terms_version_label ||
          !!overview.site_license.custom_terms_url ||
          !!overview.site_license.custom_policy_url;
        return (
          <Card
            key={overview.site_license.id}
            style={{
              border: `1px solid ${COLORS.GRAY_LL}`,
              borderRadius: 18,
              boxShadow: `0 14px 32px ${COLORS.GRAY_LL}`,
              overflow: "hidden",
            }}
            styles={{ body: { padding: 0 } }}
          >
            <div
              style={{
                background: `linear-gradient(135deg, ${COLORS.BLUE_DDD}, ${COLORS.BLUE_D})`,
                color: "white",
                padding: 22,
              }}
            >
              <Space
                wrap
                align="start"
                style={{ justifyContent: "space-between", width: "100%" }}
              >
                <Space
                  orientation="vertical"
                  size={8}
                  style={{ maxWidth: 720 }}
                >
                  <Title level={3} style={{ color: "white", margin: 0 }}>
                    {getSiteLicenseDisplayTitle(overview.site_license)}
                  </Title>
                  {lifecycleInfo.expired && lifecycleInfo.expires ? (
                    <Alert
                      type="error"
                      showIcon
                      title={lifecycleInfo.expires}
                      style={{ maxWidth: 520 }}
                    />
                  ) : lifecycleItems.length > 0 ? (
                    <Paragraph style={{ color: "white", marginBottom: 0 }}>
                      {lifecycleItems.join(" · ")}
                    </Paragraph>
                  ) : null}
                  <Space wrap>
                    <Text strong style={{ color: "white" }}>
                      Covered domains:
                    </Text>
                    {domains.length > 0 ? (
                      domains.map((domain) => <Tag key={domain}>{domain}</Tag>)
                    ) : (
                      <Text style={{ color: "white" }}>none configured</Text>
                    )}
                  </Space>
                  {hasDocuments ? (
                    <Space wrap>
                      <Text strong style={{ color: "white" }}>
                        Documents:
                      </Text>
                      {overview.site_license.terms_version_label ? (
                        <Tag>{overview.site_license.terms_version_label}</Tag>
                      ) : null}
                      {overview.site_license.custom_terms_url ? (
                        <a
                          href={overview.site_license.custom_terms_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: "white",
                            textDecoration: "underline",
                          }}
                        >
                          terms
                        </a>
                      ) : null}
                      {overview.site_license.custom_policy_url ? (
                        <a
                          href={overview.site_license.custom_policy_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: "white",
                            textDecoration: "underline",
                          }}
                        >
                          policy
                        </a>
                      ) : null}
                    </Space>
                  ) : null}
                </Space>
                <Space wrap>
                  {onUpdateLicense ? (
                    <Button ghost onClick={() => setEditingLicense(overview)}>
                      <Icon name="edit" /> Edit license
                    </Button>
                  ) : null}
                </Space>
              </Space>
            </div>

            <div style={{ padding: 22 }}>
              <Space
                orientation="vertical"
                size="large"
                style={{ width: "100%" }}
              >
                {overviewRequests.length ? (
                  <Card
                    size="small"
                    title={
                      <Space>
                        <Icon name="bell" />
                        <span>Approval queue</span>
                        <Tag color="gold">{overviewRequests.length}</Tag>
                      </Space>
                    }
                    style={{
                      borderColor: COLORS.YELL_LL,
                      background: COLORS.YELL_LLL,
                    }}
                  >
                    <Space
                      orientation="vertical"
                      size="small"
                      style={{ width: "100%" }}
                    >
                      {overviewRequests.map(({ request, pool }) => (
                        <div
                          key={request.id}
                          style={{
                            alignItems: "flex-start",
                            background: "white",
                            border: `1px solid ${COLORS.GRAY_LL}`,
                            borderRadius: 12,
                            display: "flex",
                            gap: 16,
                            justifyContent: "space-between",
                            padding: 12,
                          }}
                        >
                          <Space orientation="vertical" size={2}>
                            <Space wrap>
                              <Text strong>
                                {request.matched_email_address}
                              </Text>
                              <Tag color="blue">
                                {capitalize(request.requested_membership_class)}
                              </Tag>
                              {pool?.pool_name ? (
                                <Tag>{pool.pool_name}</Tag>
                              ) : null}
                            </Space>
                            <Text type="secondary">
                              account {request.account_id}; requested{" "}
                              <TimeAgo date={request.requested_at} />
                            </Text>
                            {request.requester_note ? (
                              <Text>{request.requester_note}</Text>
                            ) : null}
                          </Space>
                          {canManageLicense ? (
                            <Space>
                              <Button
                                type="primary"
                                loading={reviewingRequestId === request.id}
                                onClick={() =>
                                  void onReview(overview, request, "approve")
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                danger
                                loading={reviewingRequestId === request.id}
                                onClick={() =>
                                  void onReview(overview, request, "reject")
                                }
                              >
                                Reject
                              </Button>
                            </Space>
                          ) : null}
                        </div>
                      ))}
                    </Space>
                  </Card>
                ) : null}

                <div>
                  <Space
                    wrap
                    align="baseline"
                    style={{
                      justifyContent: "space-between",
                      marginBottom: 12,
                      width: "100%",
                    }}
                  >
                    <Title level={5} style={{ margin: 0 }}>
                      Seat pools
                    </Title>
                    {onAddPool ? (
                      <Button
                        onClick={() =>
                          setAddingPool({
                            overview,
                            pool: makeDefaultSiteLicensePool({
                              tiers: siteLicenseTierOptions,
                              index: overview.pools.length,
                            }),
                          })
                        }
                      >
                        <Icon name="plus-circle" /> Add pool
                      </Button>
                    ) : null}
                  </Space>
                  <div
                    style={{
                      display: "grid",
                      gap: 14,
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(280px, 1fr))",
                    }}
                  >
                    {overview.pools.map((pool) => {
                      const activeSeats = getPoolActiveSeats(pool);
                      const description =
                        `${pool.pool_description ?? ""}`.trim();
                      const utilizationPercent =
                        getPoolUtilizationPercent(pool);
                      const canArchivePool =
                        onArchivePool != null &&
                        activeSeats === 0 &&
                        pool.pending_request_count === 0;
                      return (
                        <Card
                          size="small"
                          key={pool.id}
                          style={{
                            border: `1px solid ${COLORS.GRAY_LL}`,
                            borderRadius: 14,
                          }}
                          styles={{ body: { padding: 14 } }}
                        >
                          <Space
                            orientation="vertical"
                            size="middle"
                            style={{ width: "100%" }}
                          >
                            <Space
                              wrap
                              align="start"
                              style={{
                                justifyContent: "space-between",
                                width: "100%",
                              }}
                            >
                              <Text strong style={{ fontSize: 16 }}>
                                {pool.pool_name}
                              </Text>
                              {pool.requires_approval ? (
                                <Tag color="gold">Approval required</Tag>
                              ) : (
                                <Tag color="green">Self claim</Tag>
                              )}
                            </Space>

                            <div>
                              <Space
                                wrap
                                style={{
                                  justifyContent: "space-between",
                                  marginBottom: 6,
                                  width: "100%",
                                }}
                              >
                                <Text type="secondary">
                                  {activeSeats} of {pool.seat_count} seats used
                                </Text>
                                <Text strong>{utilizationPercent}%</Text>
                              </Space>
                              <Progress
                                percent={utilizationPercent}
                                showInfo={false}
                                strokeColor={
                                  utilizationPercent >= 90
                                    ? COLORS.BG_WARNING
                                    : COLORS.BS_GREEN
                                }
                              />
                            </div>
                            {description ? (
                              <Text type="secondary">{description}</Text>
                            ) : null}

                            {onEditPool || canArchivePool ? (
                              <Space wrap>
                                {onEditPool ? (
                                  <Button
                                    size="small"
                                    onClick={() => onEditPool(pool)}
                                  >
                                    <Icon name="edit" /> Edit pool
                                  </Button>
                                ) : null}
                                {canArchivePool ? (
                                  <Popconfirm
                                    title="Archive this pool?"
                                    description="The pool will be hidden, but its audit history and past seat records will be preserved."
                                    okButtonProps={{
                                      danger: true,
                                      loading: archivingPoolId === pool.id,
                                    }}
                                    okText="Archive"
                                    onConfirm={async () => {
                                      setArchivingPoolId(pool.id);
                                      try {
                                        await onArchivePool?.(pool);
                                      } finally {
                                        setArchivingPoolId("");
                                      }
                                    }}
                                  >
                                    <Button
                                      danger
                                      size="small"
                                      loading={archivingPoolId === pool.id}
                                    >
                                      <Icon name="trash" /> Archive pool
                                    </Button>
                                  </Popconfirm>
                                ) : null}
                              </Space>
                            ) : null}

                            {pool.assignments.filter(isActiveAssignment)
                              .length === 0 ? (
                              <Text type="secondary">No active seats.</Text>
                            ) : (
                              <Space
                                orientation="vertical"
                                size="small"
                                style={{ width: "100%" }}
                              >
                                {pool.assignments
                                  .filter(isActiveAssignment)
                                  .map((assignment) => {
                                    const key = `${pool.id}-${assignment.id}`;
                                    return (
                                      <div
                                        key={key}
                                        style={{
                                          alignItems: "center",
                                          borderTop: `1px solid ${COLORS.GRAY_LLL}`,
                                          display: "flex",
                                          gap: 12,
                                          justifyContent: "space-between",
                                          paddingTop: 8,
                                        }}
                                      >
                                        <Space orientation="vertical" size={0}>
                                          <Text>
                                            {getAccountDisplayName(
                                              assignment,
                                              accountNames,
                                            )}
                                          </Text>
                                          <Text type="secondary">
                                            {assignment.email_address ||
                                              assignment.account_id ||
                                              "unknown account"}{" "}
                                            assigned{" "}
                                            {dateLabel(assignment.assigned_at)}
                                          </Text>
                                        </Space>
                                        {canManageLicense ? (
                                          <Button
                                            size="small"
                                            danger
                                            loading={revokingSeat === key}
                                            onClick={async () => {
                                              setRevokingSeat(key);
                                              try {
                                                await onRevokeSeat(
                                                  pool,
                                                  assignment,
                                                );
                                              } finally {
                                                setRevokingSeat("");
                                              }
                                            }}
                                          >
                                            Revoke
                                          </Button>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                              </Space>
                            )}
                          </Space>
                        </Card>
                      );
                    })}
                  </div>
                </div>

                <Card
                  size="small"
                  title={
                    <Space>
                      <Icon name="users" />
                      <span>Managers</span>
                    </Space>
                  }
                  style={{ borderRadius: 14 }}
                >
                  <SiteLicenseManagersEditor
                    overview={overview}
                    canEdit={canEditManagers}
                    onSetManager={onSetManager}
                    onRemoveManager={onRemoveManager}
                  />
                </Card>

                {overview.recent_audit_events?.length ? (
                  <Card
                    size="small"
                    title={
                      <Space>
                        <Icon name="history" />
                        <span>Recent activity</span>
                      </Space>
                    }
                    style={{ borderRadius: 14 }}
                  >
                    <Space
                      orientation="vertical"
                      size={4}
                      style={{ width: "100%" }}
                    >
                      {overview.recent_audit_events.map((event) => (
                        <Text key={event.id} type="secondary">
                          {dateLabel(event.created)}: {event.action}
                          {event.target_account_id
                            ? ` for ${event.target_account_id}`
                            : ""}
                        </Text>
                      ))}
                    </Space>
                  </Card>
                ) : null}

                <Space wrap>
                  <Text type="secondary">
                    License id {overview.site_license.id}; seed bay{" "}
                    {overview.site_license.bay_id}
                  </Text>
                  {overview.site_license.owner_account_id ? (
                    <Text type="secondary">
                      owner account {overview.site_license.owner_account_id}
                    </Text>
                  ) : null}
                </Space>
              </Space>
            </div>
          </Card>
        );
      })}
      <EditSiteLicenseSettingsModal
        overview={editingLicense}
        onClose={() => setEditingLicense(null)}
        onSave={async (updates) => {
          if (!editingLicense || !onUpdateLicense) return;
          await onUpdateLicense(editingLicense.site_license.id, updates);
          setEditingLicense(null);
        }}
      />
      <ProvisionPoolEditModal
        open={addingPool != null}
        pool={addingPool?.pool}
        poolIndex={addingPool?.overview.pools.length ?? 0}
        siteLicenseTierOptions={siteLicenseTierOptions}
        onChange={(patch) =>
          setAddingPool((current) =>
            current == null
              ? null
              : { ...current, pool: { ...current.pool, ...patch } },
          )
        }
        onClose={() => {
          setAddingPool(null);
          setAddingPoolError("");
        }}
        mode="add"
        error={addingPoolError}
        submitting={addingPoolSubmitting}
        onSubmit={async () => {
          if (addingPool == null || onAddPool == null) return;
          setAddingPoolSubmitting(true);
          setAddingPoolError("");
          try {
            await onAddPool(
              addingPool.overview.site_license.id,
              addingPool.pool,
            );
            setAddingPool(null);
          } catch (err) {
            setAddingPoolError(`${err}`);
          } finally {
            setAddingPoolSubmitting(false);
          }
        }}
      />
    </Space>
  );
}

function EditSiteLicenseSettingsModal({
  overview,
  onClose,
  onSave,
}: {
  overview: SiteLicenseOverview | null;
  onClose: () => void;
  onSave: (updates: Parameters<typeof updateSiteLicense>[0]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [termsUrl, setTermsUrl] = useState("");
  const [policyUrl, setPolicyUrl] = useState("");
  const [termsVersion, setTermsVersion] = useState("");
  const [renewalPolicy, setRenewalPolicy] = useState("");
  const [overagePolicy, setOveragePolicy] = useState("");
  const [startsAt, setStartsAt] = useState<Dayjs | null>(null);
  const [expiresAt, setExpiresAt] = useState<Dayjs | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!overview) return;
    const license = overview.site_license;
    setName(license.name);
    setOrganizationName(license.organization_name);
    setDomains(normalizeDomainList(license.allowed_domains));
    setTermsUrl(license.custom_terms_url ?? "");
    setPolicyUrl(license.custom_policy_url ?? "");
    setTermsVersion(license.terms_version_label ?? "");
    setRenewalPolicy(license.renewal_policy ?? "");
    setOveragePolicy(license.overage_policy ?? "");
    setStartsAt(license.starts_at ? dayjs(license.starts_at) : null);
    setExpiresAt(license.expires_at ? dayjs(license.expires_at) : null);
    setSubmitting(false);
    setError("");
  }, [overview]);

  async function save() {
    if (!overview) return;
    setSubmitting(true);
    setError("");
    try {
      const allowed_domains = normalizeDomainList(domains);
      if (allowed_domains.length === 0) {
        throw Error("Enter at least one allowed email domain.");
      }
      await onSave({
        site_license_id: overview.site_license.id,
        name,
        organization_name: organizationName,
        allowed_domains,
        custom_terms_url: termsUrl || null,
        custom_policy_url: policyUrl || null,
        terms_version_label: termsVersion || null,
        renewal_policy: renewalPolicy || null,
        overage_policy: overagePolicy || null,
        starts_at: startsAt?.startOf("day").toDate() ?? null,
        expires_at: expiresAt?.endOf("day").toDate() ?? null,
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={overview != null}
      onCancel={onClose}
      onOk={save}
      okButtonProps={{ loading: submitting }}
      okText="Save license"
      title="Edit site-license settings"
      destroyOnHidden
      width={760}
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          }}
        >
          <CompactField label="License name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </CompactField>
          <CompactField label="Organization">
            <Input
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
            />
          </CompactField>
        </div>
        <CompactField label="Allowed domains">
          <Select
            mode="tags"
            tokenSeparators={[",", " ", "\n", ";"]}
            value={domains}
            onChange={(values) => setDomains(normalizeDomainList(values))}
            style={{ width: "100%" }}
          />
        </CompactField>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          <CompactField label="Starts">
            <DatePicker
              value={startsAt}
              onChange={setStartsAt}
              style={{ width: "100%" }}
            />
          </CompactField>
          <CompactField label="Expires">
            <DatePicker
              value={expiresAt}
              onChange={setExpiresAt}
              style={{ width: "100%" }}
            />
          </CompactField>
        </div>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          }}
        >
          <CompactField label="Terms URL">
            <Input
              value={termsUrl}
              onChange={(e) => setTermsUrl(e.target.value)}
            />
          </CompactField>
          <CompactField label="Policy URL">
            <Input
              value={policyUrl}
              onChange={(e) => setPolicyUrl(e.target.value)}
            />
          </CompactField>
          <CompactField label="Terms version">
            <Input
              value={termsVersion}
              onChange={(e) => setTermsVersion(e.target.value)}
            />
          </CompactField>
          <CompactField label="Renewal policy">
            <Input
              value={renewalPolicy}
              onChange={(e) => setRenewalPolicy(e.target.value)}
            />
          </CompactField>
          <CompactField label="Overage policy">
            <Input
              value={overagePolicy}
              onChange={(e) => setOveragePolicy(e.target.value)}
            />
          </CompactField>
        </div>
      </Space>
    </Modal>
  );
}

function SiteLicenseManagersEditor({
  overview,
  canEdit,
  onSetManager,
  onRemoveManager,
}: {
  overview: SiteLicenseOverview;
  canEdit: boolean;
  onSetManager: (
    site_license_id: string,
    target_account_id: string,
    role: SiteLicenseManagerRole,
  ) => Promise<void>;
  onRemoveManager: (
    site_license_id: string,
    target_account_id: string,
  ) => Promise<void>;
}) {
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<PackageUserSearchResult[]>(
    [],
  );
  const searchRunRef = useRef(0);
  const [role, setRole] = useState<SiteLicenseManagerRole>("manager");
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");

  async function searchAccounts(query: string) {
    const trimmed = query.trim();
    const run = ++searchRunRef.current;
    if (!trimmed) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    setError("");
    try {
      const rawResults = await webapp_client.users_client.user_search({
        query: trimmed,
        limit: 20,
        admin: true,
      });
      if (run !== searchRunRef.current) return;
      const existingAccountIds = new Set(
        overview.managers.map((manager) => manager.account_id),
      );
      setSearchResults(
        (rawResults ?? [])
          .filter(
            (result): result is PackageUserSearchResult =>
              typeof result?.account_id === "string" &&
              result.account_id.length > 0 &&
              !existingAccountIds.has(result.account_id),
          )
          .slice(0, 20),
      );
    } catch (err) {
      if (run === searchRunRef.current) {
        setError(`${err}`);
        setSearchResults([]);
      }
    } finally {
      if (run === searchRunRef.current) {
        setSearching(false);
      }
    }
  }

  async function addOrUpdateManager() {
    const target = selectedAccountId.trim();
    if (!target) return;
    setWorking(`set-${target}`);
    setError("");
    try {
      await onSetManager(overview.site_license.id, target, role);
      setSelectedAccountId("");
      setSearchResults([]);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setWorking("");
    }
  }

  async function removeManager(target: string) {
    setWorking(`remove-${target}`);
    setError("");
    try {
      await onRemoveManager(overview.site_license.id, target);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setWorking("");
    }
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {overview.managers.length ? (
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          {overview.managers.map((manager) => (
            <div
              key={manager.id}
              style={{
                alignItems: "center",
                display: "flex",
                gap: 10,
                justifyContent: "space-between",
              }}
            >
              <Space wrap>
                <Text code>{manager.account_id}</Text>
                <Tag>{manager.role}</Tag>
              </Space>
              <Space>
                {canEdit ? (
                  <>
                    <Select
                      size="small"
                      value={manager.role}
                      style={{ width: 110 }}
                      options={[
                        { label: "Manager", value: "manager" },
                        { label: "Viewer", value: "viewer" },
                      ]}
                      onChange={(nextRole) =>
                        void onSetManager(
                          overview.site_license.id,
                          manager.account_id,
                          nextRole,
                        )
                      }
                    />
                    <Button
                      size="small"
                      danger
                      loading={working === `remove-${manager.account_id}`}
                      onClick={() => void removeManager(manager.account_id)}
                    >
                      Remove
                    </Button>
                  </>
                ) : null}
              </Space>
            </div>
          ))}
        </Space>
      ) : (
        <Text type="secondary">No delegated managers listed.</Text>
      )}
      {canEdit ? (
        <>
          <Divider style={{ margin: "4px 0" }} />
          <Text type="secondary">
            Owner is the billing/responsible account. Managers are delegated
            operational users who can review requests; viewers can inspect only.
          </Text>
          <Space wrap>
            <Select
              showSearch
              filterOption={false}
              value={selectedAccountId || undefined}
              loading={searching}
              notFoundContent={searching ? <Spin size="small" /> : null}
              placeholder="Search by name, email, or account id"
              style={{ minWidth: 360 }}
              options={searchResults.map((user) => ({
                value: user.account_id,
                label: packageUserSearchLabel(user),
              }))}
              onSearch={(query) => void searchAccounts(query)}
              onChange={(value) => setSelectedAccountId(value)}
              onClear={() => {
                setSelectedAccountId("");
                setSearchResults([]);
              }}
              allowClear
            />
            <Select
              value={role}
              style={{ width: 130 }}
              options={[
                { label: "Manager", value: "manager" },
                { label: "Viewer", value: "viewer" },
              ]}
              onChange={setRole}
            />
            <Button
              type="primary"
              disabled={!selectedAccountId}
              loading={working === `set-${selectedAccountId.trim()}`}
              onClick={() => void addOrUpdateManager()}
            >
              Add delegate
            </Button>
          </Space>
        </>
      ) : (
        <Text type="secondary">
          Only CoCalc admins can change delegated site-license roles.
        </Text>
      )}
    </Space>
  );
}

function PackageGroup({
  title,
  emptyTitle,
  emptyDescription,
  membershipPackages,
  tiers,
  accountNames,
  onAddSeats,
  onAssignSeat,
  onRevokeSeat,
}: {
  title: string;
  emptyTitle: string;
  emptyDescription: string;
  membershipPackages: MembershipPackageDetails[];
  tiers: MembershipTierLike[];
  accountNames: Record<
    string,
    { first_name?: string; last_name?: string } | undefined
  >;
  onAddSeats?: (membershipPackage: MembershipPackageDetails) => void;
  onAssignSeat: (membershipPackage: MembershipPackageDetails) => void;
  onRevokeSeat: (
    membershipPackage: MembershipPackageDetails,
    assignment: MembershipPackageAssignment,
  ) => Promise<void>;
}) {
  if (membershipPackages.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }
  return (
    <div>
      <Title level={5} style={{ marginTop: 0 }}>
        {title}
      </Title>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {membershipPackages.map((membershipPackage) => (
          <MembershipPackageCard
            key={membershipPackage.id}
            membershipPackage={membershipPackage}
            tierLabel={
              tiers.find(
                (tier) => tier.id === membershipPackage.membership_class,
              )?.label ?? capitalize(membershipPackage.membership_class)
            }
            accountNames={accountNames}
            onAddSeats={onAddSeats}
            onAssignSeat={onAssignSeat}
            onRevokeSeat={onRevokeSeat}
          />
        ))}
      </Space>
    </div>
  );
}

function MembershipPackageCard({
  membershipPackage,
  tierLabel,
  accountNames,
  onAddSeats,
  onAssignSeat,
  onRevokeSeat,
}: {
  membershipPackage: MembershipPackageDetails;
  tierLabel: string;
  accountNames: Record<
    string,
    { first_name?: string; last_name?: string } | undefined
  >;
  onAddSeats?: (membershipPackage: MembershipPackageDetails) => void;
  onAssignSeat: (membershipPackage: MembershipPackageDetails) => void;
  onRevokeSeat: (
    membershipPackage: MembershipPackageDetails,
    assignment: MembershipPackageAssignment,
  ) => Promise<void>;
}) {
  const [revokingAccountId, setRevokingAccountId] = useState<string>("");
  const activeAssignments =
    membershipPackage.assignments.filter(isActiveAssignment);
  const domains = getPackageDomains(membershipPackage);
  const interval =
    `${membershipPackage.metadata?.interval ?? ""}` === "year"
      ? "yearly"
      : `${membershipPackage.metadata?.interval ?? ""}` === "month"
        ? "monthly"
        : undefined;

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <span>{getPackageKindLabel(membershipPackage.kind)}</span>
          <Tag color="blue">{tierLabel}</Tag>
          {interval ? <Tag>{interval}</Tag> : null}
        </Space>
      }
      extra={
        <Space wrap>
          <Button
            type="primary"
            onClick={() => onAssignSeat(membershipPackage)}
            disabled={membershipPackage.available_seat_count <= 0}
          >
            Assign seat
          </Button>
          {membershipPackage.kind === "team" && onAddSeats ? (
            <Button onClick={() => onAddSeats(membershipPackage)}>
              Add seats
            </Button>
          ) : null}
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Tag>{`${membershipPackage.seat_count} purchased`}</Tag>
        <Tag color="green">{`${membershipPackage.active_assignment_count} assigned`}</Tag>
        <Tag color="gold">{`${membershipPackage.available_seat_count} available`}</Tag>
      </Space>
      <Descriptions size="small" column={1}>
        {membershipPackage.starts_at ? (
          <Descriptions.Item label="Starts">
            <TimeAgo date={membershipPackage.starts_at} />
          </Descriptions.Item>
        ) : null}
        {membershipPackage.expires_at ? (
          <Descriptions.Item label="Expires">
            <TimeAgo date={membershipPackage.expires_at} />
          </Descriptions.Item>
        ) : null}
        {membershipPackage.kind === "team" &&
        typeof membershipPackage.metadata?.seat_price === "number" ? (
          <Descriptions.Item label="Seat price">
            {currency(Number(membershipPackage.metadata?.seat_price))}
          </Descriptions.Item>
        ) : null}
        {domains.length > 0 ? (
          <Descriptions.Item label="Allowed domains">
            <Space wrap>
              {domains.map((domain) => (
                <Tag key={domain}>{domain}</Tag>
              ))}
            </Space>
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      <Divider style={{ margin: "12px 0" }} />
      <Text strong>Assigned seats</Text>
      {activeAssignments.length === 0 ? (
        <div style={{ marginTop: 6 }}>
          <Text type="secondary">No seats assigned yet.</Text>
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            {activeAssignments.map((assignment) => (
              <div
                key={assignment.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                <Space orientation="vertical" size={0}>
                  <Text>{getAccountDisplayName(assignment, accountNames)}</Text>
                  <Space wrap>
                    {getAccountSecondaryLabel(assignment, accountNames) ? (
                      <Text type="secondary">
                        {getAccountSecondaryLabel(assignment, accountNames)}
                      </Text>
                    ) : null}
                    {assignment.assigned_at ? (
                      <Text type="secondary">
                        Assigned <TimeAgo date={assignment.assigned_at} />
                      </Text>
                    ) : null}
                  </Space>
                </Space>
                <Button
                  danger
                  size="small"
                  loading={
                    revokingAccountId ===
                    (assignment.account_id ?? assignment.email_address ?? "")
                  }
                  onClick={async () => {
                    setRevokingAccountId(
                      assignment.account_id ?? assignment.email_address ?? "",
                    );
                    try {
                      await onRevokeSeat(membershipPackage, assignment);
                    } finally {
                      setRevokingAccountId("");
                    }
                  }}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </Space>
        </div>
      )}
    </Card>
  );
}

function ProvisionSiteLicenseModal({
  open,
  owner_account_id,
  tiers,
  onClose,
  onProvisioned,
}: {
  open: boolean;
  owner_account_id?: string;
  tiers: MembershipTierLike[];
  onClose: () => void;
  onProvisioned: () => Promise<void>;
}) {
  const provisionableTiers = useMemo(() => getTeamSeatTiers(tiers), [tiers]);
  const siteLicenseTierOptions = useMemo(
    () => getSiteLicenseProvisioningTiers(tiers),
    [tiers],
  );
  const [name, setName] = useState<string>("Campus site license");
  const [organizationName, setOrganizationName] =
    useState<string>("Example University");
  const [domains, setDomains] = useState<string[]>([]);
  const [domainSearch, setDomainSearch] = useState<string>("");
  const [customTermsUrl, setCustomTermsUrl] = useState<string>("");
  const [customPolicyUrl, setCustomPolicyUrl] = useState<string>("");
  const [termsVersionLabel, setTermsVersionLabel] = useState<string>("");
  const [renewalPolicy, setRenewalPolicy] = useState<string>("annual");
  const [overagePolicy, setOveragePolicy] = useState<string>("hard-cap");
  const [startsAt, setStartsAt] = useState<Dayjs | null>(null);
  const [expiresAt, setExpiresAt] = useState<Dayjs | null>(null);
  const [pools, setPools] = useState<SiteLicensePoolConfig[]>([]);
  const [editingPoolIndex, setEditingPoolIndex] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

  useEffect(() => {
    if (!open) return;
    const usedTierIds = new Set<string>();
    const studentTier = findSiteLicenseTier({
      tiers: siteLicenseTierOptions,
      used: usedTierIds,
      keywords: ["student"],
      fallbackIndex: 0,
    });
    if (studentTier) usedTierIds.add(studentTier.id);
    const instructorTier = findSiteLicenseTier({
      tiers: siteLicenseTierOptions,
      used: usedTierIds,
      keywords: ["instructor", "teacher", "faculty", "pro"],
      fallbackIndex: 0,
    });
    if (instructorTier) usedTierIds.add(instructorTier.id);
    const researcherTier = findSiteLicenseTier({
      tiers: siteLicenseTierOptions,
      used: usedTierIds,
      keywords: ["research"],
      fallbackIndex: 0,
    });
    setName("Campus site license");
    setOrganizationName("Example University");
    setDomains([]);
    setDomainSearch("");
    setCustomTermsUrl("");
    setCustomPolicyUrl("");
    setTermsVersionLabel("");
    setRenewalPolicy("annual");
    setOveragePolicy("hard-cap");
    setStartsAt(null);
    setExpiresAt(null);
    const defaultPools: SiteLicensePoolConfig[] = [];
    if (studentTier) {
      defaultPools.push({
        pool_name: "Student",
        pool_description: getTierSiteLicensePoolDescription(studentTier),
        membership_class: studentTier.id as MembershipClass,
        seat_count: 5000,
        requires_approval: false,
        verification_policy: "email-domain",
        exclusive_group: "teaching",
        affiliation_reverification_days: 180,
        affiliation_reverification_grace_days: 30,
      });
    }
    if (instructorTier) {
      defaultPools.push({
        pool_name: "Instructor",
        pool_description: getTierSiteLicensePoolDescription(instructorTier),
        membership_class: instructorTier.id as MembershipClass,
        seat_count: 200,
        requires_approval: true,
        verification_policy: "email-domain",
        exclusive_group: "teaching",
        affiliation_reverification_days: 365,
        affiliation_reverification_grace_days: 45,
      });
    }
    if (researcherTier) {
      defaultPools.push({
        pool_name: "Researcher",
        pool_description: getTierSiteLicensePoolDescription(researcherTier),
        membership_class: researcherTier.id as MembershipClass,
        seat_count: 500,
        requires_approval: true,
        verification_policy: "email-domain",
        exclusive_group: "research",
        affiliation_reverification_days: 365,
        affiliation_reverification_grace_days: 45,
      });
    }
    setPools(defaultPools);
    setEditingPoolIndex(null);
    setSubmitting(false);
    setError("");
  }, [open, siteLicenseTierOptions]);

  function updatePool(index: number, patch: Partial<SiteLicensePoolConfig>) {
    setPools((current) =>
      current.map((pool, i) => (i === index ? { ...pool, ...patch } : pool)),
    );
  }

  function addPool() {
    const newPoolIndex = pools.length;
    setPools((current) => [
      ...current,
      makeDefaultSiteLicensePool({
        tiers: provisionableTiers,
        index: current.length,
      }),
    ]);
    setEditingPoolIndex(newPoolIndex);
  }

  async function provision() {
    setSubmitting(true);
    setError("");
    try {
      const allowed_domains = normalizeDomainList([...domains, domainSearch]);
      const cleanName = name.trim();
      const cleanOrganizationName = organizationName.trim();
      if (!cleanName) {
        throw Error("Enter a site license name.");
      }
      if (!cleanOrganizationName) {
        throw Error("Enter an organization name.");
      }
      if (allowed_domains.length === 0) {
        throw Error("Enter at least one allowed email domain.");
      }
      const cleanPools = pools.map((pool) => {
        const poolDomains = normalizeDomainList(pool.allowed_domains ?? []);
        return {
          ...pool,
          pool_name: `${pool.pool_name ?? ""}`.trim(),
          pool_description: `${pool.pool_description ?? ""}`.trim() || null,
          exclusive_group: `${pool.exclusive_group ?? ""}`.trim() || null,
          seat_count: Math.max(1, Math.trunc(Number(pool.seat_count) || 1)),
          allowed_domains:
            poolDomains.length > 0 ? poolDomains : allowed_domains,
          affiliation_reverification_days:
            pool.affiliation_reverification_days == null
              ? null
              : Math.max(
                  1,
                  Math.trunc(Number(pool.affiliation_reverification_days) || 1),
                ),
          affiliation_reverification_grace_days:
            pool.affiliation_reverification_grace_days == null
              ? null
              : Math.max(
                  1,
                  Math.trunc(
                    Number(pool.affiliation_reverification_grace_days) || 1,
                  ),
                ),
        };
      });
      if (cleanPools.length === 0) {
        throw Error("Add at least one pool.");
      }
      if (cleanPools.some((pool) => !pool.pool_name)) {
        throw Error("Every pool needs a name.");
      }
      await runFreshAuthAction(async () => {
        await adminProvisionSiteLicense({
          owner_account_id,
          name: cleanName,
          organization_name: cleanOrganizationName,
          allowed_domains,
          pools: cleanPools,
          custom_terms_url: customTermsUrl.trim() || null,
          custom_policy_url: customPolicyUrl.trim() || null,
          terms_version_label: termsVersionLabel.trim() || null,
          renewal_policy: renewalPolicy.trim() || null,
          overage_policy: overagePolicy.trim() || null,
          starts_at: startsAt?.startOf("day").toDate() ?? undefined,
          expires_at: expiresAt?.endOf("day").toDate() ?? undefined,
        });
        await onProvisioned();
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }
  const editingPool =
    editingPoolIndex == null ? undefined : pools[editingPoolIndex];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={provision}
      okButtonProps={{ loading: submitting }}
      okText="Provision license"
      width={1000}
      destroyOnHidden
      styles={{ body: { maxHeight: "calc(100vh - 220px)", overflowY: "auto" } }}
      title={
        <>
          <Icon name="plus-circle" style={{ marginRight: 10 }} />
          Provision site license
        </>
      }
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {error ? (
          <Alert
            type="error"
            title={error}
            closable
            onClose={() => setError("")}
          />
        ) : null}
        <Card
          style={{
            background: `linear-gradient(135deg, ${COLORS.BLUE_LLLL}, ${COLORS.BS_GREEN_LL})`,
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 16,
          }}
          styles={{ body: { padding: 18 } }}
        >
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Space orientation="vertical" size={2}>
              <Text strong style={{ fontSize: 16 }}>
                Create one customer-facing license with multiple seat pools
              </Text>
              <Paragraph style={{ marginBottom: 0 }}>
                This creates a real site license. The organization sees one
                license; CoCalc enforces the individual pools underneath it.
              </Paragraph>
            </Space>
            <Space wrap>
              <Tag color="blue">1. Identity</Tag>
              <Tag color="green">2. Domains</Tag>
              <Tag color="gold">3. Pools</Tag>
            </Space>
          </Space>
        </Card>

        <Card
          title="License identity"
          size="small"
          style={{ borderRadius: 14 }}
          styles={{ body: { padding: 14 } }}
        >
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            }}
          >
            <CompactField
              label="License name"
              help="Internal and manager-facing name."
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Campus site license"
              />
            </CompactField>
            <CompactField
              label="Organization"
              help="The customer or institution name."
            >
              <Input
                value={organizationName}
                onChange={(event) => setOrganizationName(event.target.value)}
                placeholder="Example University"
              />
            </CompactField>
          </div>
        </Card>

        <Card
          title="Eligibility domains"
          size="small"
          style={{ borderRadius: 14 }}
        >
          <Text type="secondary">
            Users must verify an email at one of these domains before they can
            claim a self-serve seat or request an approval-required seat.
          </Text>
          <Select
            aria-label="Allowed email domains"
            mode="tags"
            tokenSeparators={[",", " ", ";", "\n"]}
            value={domains}
            searchValue={domainSearch}
            onSearch={setDomainSearch}
            onChange={(values) => {
              setDomains(normalizeDomainList(values));
              setDomainSearch("");
            }}
            onBlur={() => {
              const next = normalizeDomainList([...domains, domainSearch]);
              setDomains(next);
              setDomainSearch("");
            }}
            placeholder="example.edu, department.example.edu"
            style={{ width: "100%", marginTop: 10 }}
          />
          <Text type="secondary">
            Separate domains with commas, spaces, or new lines. Do not include
            full email addresses.
          </Text>
        </Card>

        <Collapse
          items={[
            {
              key: "contract",
              label: "Optional contract terms, dates, and policy links",
              children: (
                <Space
                  orientation="vertical"
                  size="middle"
                  style={{ width: "100%" }}
                >
                  <Alert
                    type="info"
                    showIcon
                    title="These fields are visible context, not a billing engine."
                    description="Use them to record negotiated policy links, renewal language, overage handling, and term dates for the site-license dashboard."
                  />
                  <Space wrap style={{ width: "100%" }}>
                    <div style={{ flex: "1 1 260px" }}>
                      <Text strong>Custom terms URL</Text>
                      <Input
                        placeholder="https://example.edu/cocalc-terms"
                        value={customTermsUrl}
                        onChange={(event) =>
                          setCustomTermsUrl(event.target.value)
                        }
                        style={{ marginTop: 6 }}
                      />
                    </div>
                    <div style={{ flex: "1 1 260px" }}>
                      <Text strong>Custom policy URL</Text>
                      <Input
                        placeholder="https://example.edu/acceptable-use"
                        value={customPolicyUrl}
                        onChange={(event) =>
                          setCustomPolicyUrl(event.target.value)
                        }
                        style={{ marginTop: 6 }}
                      />
                    </div>
                    <div style={{ flex: "1 1 190px" }}>
                      <Text strong>Terms version</Text>
                      <Input
                        placeholder="2026 pilot"
                        value={termsVersionLabel}
                        onChange={(event) =>
                          setTermsVersionLabel(event.target.value)
                        }
                        style={{ marginTop: 6 }}
                      />
                    </div>
                  </Space>
                  <Space wrap style={{ width: "100%" }}>
                    <div style={{ flex: "1 1 180px" }}>
                      <Text strong>Renewal policy</Text>
                      <Input
                        value={renewalPolicy}
                        onChange={(event) =>
                          setRenewalPolicy(event.target.value)
                        }
                        style={{ marginTop: 6 }}
                      />
                    </div>
                    <div style={{ flex: "1 1 180px" }}>
                      <Text strong>Overage policy</Text>
                      <Input
                        value={overagePolicy}
                        onChange={(event) =>
                          setOveragePolicy(event.target.value)
                        }
                        style={{ marginTop: 6 }}
                      />
                    </div>
                    <div style={{ flex: "1 1 180px" }}>
                      <Text strong>Starts at</Text>
                      <DatePicker
                        value={startsAt}
                        onChange={setStartsAt}
                        style={{ width: "100%", marginTop: 6 }}
                      />
                    </div>
                    <div style={{ flex: "1 1 180px" }}>
                      <Text strong>Expires at</Text>
                      <DatePicker
                        value={expiresAt}
                        onChange={setExpiresAt}
                        style={{ width: "100%", marginTop: 6 }}
                      />
                    </div>
                  </Space>
                </Space>
              ),
            },
          ]}
        />

        <Divider style={{ margin: "4px 0" }} />

        <Space
          wrap
          align="start"
          style={{ width: "100%", justifyContent: "space-between" }}
        >
          <Space orientation="vertical" size={2}>
            <Text strong style={{ fontSize: 16 }}>
              Seat pools
            </Text>
            <Text type="secondary">
              Start with the default academic pools. Expand advanced settings
              only when a deal needs different identity or reverification rules.
            </Text>
          </Space>
          <Button onClick={addPool}>Add pool</Button>
        </Space>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fit, minmax(285px, 1fr))",
          }}
        >
          {pools.map((pool, index) => {
            const theme = getProvisionPoolTheme(pool, index);
            return (
              <Card
                key={index}
                style={{
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  borderRadius: 18,
                  boxShadow: `0 10px 24px ${COLORS.GRAY_LL}`,
                  overflow: "hidden",
                }}
                styles={{ body: { padding: 0 } }}
              >
                <div
                  style={{
                    background: theme.background,
                    borderBottom: `1px solid ${COLORS.GRAY_LL}`,
                    padding: 14,
                  }}
                >
                  <Space
                    align="start"
                    style={{
                      justifyContent: "space-between",
                      width: "100%",
                    }}
                  >
                    <Space align="start">
                      <div
                        style={{
                          alignItems: "center",
                          background: "white",
                          borderRadius: 14,
                          color: theme.accent,
                          display: "flex",
                          fontSize: 20,
                          height: 42,
                          justifyContent: "center",
                          width: 42,
                        }}
                      >
                        <Icon name={theme.icon} />
                      </div>
                      <Space orientation="vertical" size={2}>
                        <Text strong style={{ fontSize: 16 }}>
                          {pool.pool_name || `Pool ${index + 1}`}
                        </Text>
                        <Text type="secondary">{theme.description}</Text>
                      </Space>
                    </Space>
                    <Button
                      danger
                      size="small"
                      disabled={pools.length <= 1}
                      onClick={() =>
                        setPools((current) =>
                          current.filter((_pool, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </Space>
                  <Space wrap style={{ marginTop: 12 }}>
                    <Tag>{capitalize(pool.membership_class)}</Tag>
                    <Tag>{pool.seat_count} seats</Tag>
                    {pool.requires_approval ? (
                      <Tag color="gold">Approval required</Tag>
                    ) : (
                      <Tag color="green">Self-claim</Tag>
                    )}
                  </Space>
                </div>
                <div style={{ padding: 14 }}>
                  <Space
                    orientation="vertical"
                    size="middle"
                    style={{ width: "100%" }}
                  >
                    <div
                      style={{
                        background: COLORS.GRAY_LLL,
                        border: `1px solid ${COLORS.GRAY_LL}`,
                        borderRadius: 12,
                        padding: 10,
                      }}
                    >
                      <Space
                        wrap
                        style={{
                          justifyContent: "space-between",
                          width: "100%",
                        }}
                      >
                        <Space orientation="vertical" size={0}>
                          <Text strong>{pool.seat_count} seats</Text>
                          <Text type="secondary">
                            {pool.requires_approval
                              ? "Manager approval required"
                              : "Eligible users can self-claim"}
                          </Text>
                        </Space>
                        <Text type="secondary">
                          {pool.verification_policy}; group{" "}
                          {pool.exclusive_group || "none"}
                        </Text>
                      </Space>
                    </div>
                    <Button
                      block
                      onClick={() => setEditingPoolIndex(index)}
                      type="primary"
                    >
                      Edit pool
                    </Button>
                  </Space>
                </div>
              </Card>
            );
          })}
        </div>
        <ProvisionPoolEditModal
          open={editingPool != null}
          pool={editingPool}
          poolIndex={editingPoolIndex ?? 0}
          siteLicenseTierOptions={siteLicenseTierOptions}
          onChange={(patch) => {
            if (editingPoolIndex != null) {
              updatePool(editingPoolIndex, patch);
            }
          }}
          onClose={() => setEditingPoolIndex(null)}
        />
        <FreshAuthModal {...freshAuthModalProps} />
      </Space>
    </Modal>
  );
}

function ProvisionPoolEditModal({
  open,
  pool,
  poolIndex,
  siteLicenseTierOptions,
  onChange,
  onClose,
  mode = "edit",
  activeSeatCount = 0,
  domainsRequired = false,
  expiresAt,
  onExpiresAtChange,
  error,
  submitting,
  onSubmit,
}: {
  open: boolean;
  pool?: SiteLicensePoolConfig;
  poolIndex: number;
  siteLicenseTierOptions: MembershipTierLike[];
  onChange: (patch: Partial<SiteLicensePoolConfig>) => void;
  onClose: () => void;
  mode?: "edit" | "add" | "persisted";
  activeSeatCount?: number;
  domainsRequired?: boolean;
  expiresAt?: Dayjs | null;
  onExpiresAtChange?: (value: Dayjs | null) => void;
  error?: string;
  submitting?: boolean;
  onSubmit?: () => Promise<void>;
}) {
  const [domainSearch, setDomainSearch] = useState<string>("");
  useEffect(() => {
    if (open) {
      setDomainSearch("");
    }
  }, [open, pool?.pool_name]);
  if (pool == null) return null;
  const theme = getProvisionPoolTheme(pool, poolIndex);
  const selectedTier = siteLicenseTierOptions.find(
    (tier) => tier.id === pool.membership_class,
  );
  const isAdd = mode === "add";
  const isPersisted = mode === "persisted";
  const seatMin = Math.max(1, activeSeatCount);
  const setDomains = (values: string[]) => {
    const next = normalizeDomainList(values);
    onChange({
      allowed_domains: domainsRequired || next.length > 0 ? next : undefined,
    });
    setDomainSearch("");
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onSubmit ?? onClose}
      okButtonProps={{ loading: submitting }}
      okText={isAdd ? "Add pool" : isPersisted ? "Save pool" : "Done"}
      width={760}
      destroyOnHidden
      title={
        <Space>
          <Icon name={theme.icon} style={{ color: theme.accent }} />
          <span>
            {isAdd ? "Add" : "Edit"} {pool.pool_name || `Pool ${poolIndex + 1}`}
          </span>
        </Space>
      }
    >
      <Space orientation="vertical" size="large" style={{ width: "100%" }}>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        <Alert
          type="info"
          showIcon
          title={theme.description}
          description={
            isAdd
              ? "This creates a new seed/global site-license pool after fresh auth. Existing pools and assignments are unchanged."
              : isPersisted
                ? "Pool name, description, seats, access mode, domains, expiration, and reverification timing can be updated. Internal tier, verification policy, and exclusive group are read-only after creation."
                : "Changes are applied immediately to the provisioning draft. They are not saved until you provision the site license."
          }
        />
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "minmax(220px, 1fr) minmax(180px, 0.8fr)",
          }}
        >
          <CompactField label="Pool name">
            <Input
              value={pool.pool_name}
              onChange={(event) => onChange({ pool_name: event.target.value })}
              style={{ width: "100%" }}
            />
          </CompactField>
          <CompactField
            label="Tier"
            help={
              isPersisted
                ? "Internal entitlement tier; create a new pool to change it."
                : undefined
            }
          >
            <Select
              disabled={isPersisted}
              value={pool.membership_class}
              onChange={(value) => {
                const nextTier = siteLicenseTierOptions.find(
                  (tier) => tier.id === value,
                );
                onChange({
                  membership_class: value as MembershipClass,
                  ...getPoolDescriptionPatchForTierChange({
                    currentPool: pool,
                    currentTier: selectedTier,
                    nextTier,
                  }),
                });
              }}
              options={siteLicenseTierOptions.map((tier) => ({
                label: tier.label ?? capitalize(tier.id),
                value: tier.id,
              }))}
              style={{ width: "100%" }}
            />
            {selectedTier != null ? (
              <div style={{ marginTop: 8 }}>
                <MembershipTierBenefits
                  compact
                  showBilling={false}
                  tier={selectedTier}
                />
              </div>
            ) : null}
          </CompactField>
        </div>
        <CompactField
          label="Description"
          help="Plain-language text shown to eligible users before they claim or request this pool."
        >
          <Input.TextArea
            rows={3}
            value={pool.pool_description ?? ""}
            onChange={(event) =>
              onChange({ pool_description: event.target.value })
            }
          />
        </CompactField>
        <CompactField
          label="Allowed email domains"
          help={
            domainsRequired
              ? "Add or remove domains for future verified-domain claims. Existing claimed seats stay assigned unless you revoke them explicitly."
              : "Leave empty to use the site-license domains."
          }
        >
          <Select
            mode="tags"
            tokenSeparators={[",", " ", "\n", ";"]}
            value={pool.allowed_domains ?? []}
            onSearch={setDomainSearch}
            onChange={(values) => setDomains(values)}
            onBlur={() =>
              setDomains([...(pool.allowed_domains ?? []), domainSearch])
            }
            placeholder="example.edu, department.example.edu"
            style={{ width: "100%" }}
          />
        </CompactField>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "minmax(150px, 0.55fr) minmax(260px, 1fr)",
          }}
        >
          <CompactField label="Seats">
            <InputNumber
              min={seatMin}
              precision={0}
              value={pool.seat_count}
              onChange={(value) =>
                onChange({ seat_count: Number(value ?? seatMin) })
              }
              style={{ width: "100%" }}
            />
            {isPersisted ? (
              <Text type="secondary">
                Must be at least the current active assignment count (
                {activeSeatCount}).
              </Text>
            ) : null}
          </CompactField>
          <CompactField
            label="Access mode"
            help={
              isPersisted
                ? "Changing this affects future claims and requests only."
                : pool.requires_approval
                  ? "Users submit a request and a site-license manager approves it."
                  : "Eligible users with a verified matching email can claim directly."
            }
          >
            <Radio.Group
              buttonStyle="solid"
              value={pool.requires_approval ? "yes" : "no"}
              onChange={(event) =>
                onChange({ requires_approval: event.target.value === "yes" })
              }
              style={{ display: "flex", width: "100%" }}
            >
              <Radio.Button style={{ flex: 1, textAlign: "center" }} value="no">
                Self-claim
              </Radio.Button>
              <Radio.Button
                style={{ flex: 1, textAlign: "center" }}
                value="yes"
              >
                Approval
              </Radio.Button>
            </Radio.Group>
          </CompactField>
        </div>
        {onExpiresAtChange ? (
          <CompactField
            label="Expires at"
            help="Changing this updates active membership grants for assigned or claimed seats."
          >
            <DatePicker
              allowClear
              value={expiresAt}
              onChange={onExpiresAtChange}
              style={{ width: "100%" }}
            />
          </CompactField>
        ) : null}
        <Divider style={{ margin: "0" }} />
        <Space orientation="vertical" size={2}>
          <Text strong>Advanced policy</Text>
          <Text type="secondary">
            {isPersisted
              ? "Verification and exclusive-group policy are fixed for existing pools. Reverification timing remains editable."
              : "Exclusive groups avoid double-counting seats. Pools in the same group replace each other; pools in different groups can coexist."}
          </Text>
        </Space>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns:
              "minmax(190px, 1fr) minmax(160px, 0.8fr) minmax(130px, 0.65fr) minmax(130px, 0.65fr)",
          }}
        >
          <CompactField
            label="Verification"
            help="Proof required for this pool."
          >
            <Select
              disabled={isPersisted}
              value={pool.verification_policy}
              onChange={(value) =>
                onChange({
                  verification_policy: value as SiteLicenseVerificationPolicy,
                })
              }
              options={SITE_LICENSE_VERIFICATION_OPTIONS}
              style={{ width: "100%" }}
            />
          </CompactField>
          <CompactField
            label="Exclusive group"
            help="Same group seats replace each other."
          >
            <Input
              disabled={isPersisted}
              value={`${pool.exclusive_group ?? ""}`}
              onChange={(event) =>
                onChange({ exclusive_group: event.target.value })
              }
              style={{ width: "100%" }}
            />
          </CompactField>
          <CompactField
            label="Reverify days"
            help="Eligibility refresh interval."
          >
            <InputNumber
              min={1}
              precision={0}
              value={pool.affiliation_reverification_days ?? undefined}
              onChange={(value) =>
                onChange({
                  affiliation_reverification_days:
                    value == null ? null : Number(value),
                })
              }
              style={{ width: "100%" }}
            />
          </CompactField>
          <CompactField label="Grace days" help="Before seat release.">
            <InputNumber
              min={1}
              precision={0}
              value={pool.affiliation_reverification_grace_days ?? undefined}
              onChange={(value) =>
                onChange({
                  affiliation_reverification_grace_days:
                    value == null ? null : Number(value),
                })
              }
              style={{ width: "100%" }}
            />
          </CompactField>
        </div>
      </Space>
    </Modal>
  );
}

function EditSiteLicenseModal({
  open,
  membershipPackage,
  tiers,
  onClose,
  onUpdated,
}: {
  open: boolean;
  membershipPackage: MembershipPackageDetails | null;
  tiers: MembershipTierLike[];
  onClose: () => void;
  onUpdated: () => Promise<void>;
}) {
  const [pool, setPool] = useState<SiteLicensePoolConfig | undefined>();
  const [expiresAt, setExpiresAt] = useState<Dayjs | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const siteLicenseTierOptions = useMemo(() => {
    const options = getSiteLicenseProvisioningTiers(tiers);
    const membershipClass = membershipPackage?.membership_class;
    if (
      membershipClass == null ||
      options.some((tier) => tier.id === membershipClass)
    ) {
      return options;
    }
    return [
      {
        id: membershipClass,
        label: capitalize(membershipClass),
      },
      ...options,
    ];
  }, [membershipPackage?.membership_class, tiers]);

  useEffect(() => {
    if (!open || !membershipPackage) {
      setPool(undefined);
      return;
    }
    setPool(siteLicensePoolConfigFromPackage(membershipPackage));
    setExpiresAt(
      membershipPackage.expires_at ? dayjs(membershipPackage.expires_at) : null,
    );
    setSubmitting(false);
    setError("");
  }, [open, membershipPackage]);

  async function save() {
    if (!membershipPackage) return;
    setSubmitting(true);
    setError("");
    try {
      if (pool == null) return;
      const allowed_domains = normalizeDomainList(pool.allowed_domains ?? []);
      if (allowed_domains.length === 0) {
        throw Error("Enter at least one allowed email domain.");
      }
      const siteLicenseId =
        `${membershipPackage.metadata?.site_license_id ?? ""}`.trim();
      await updateMembershipPackage({
        package_id: membershipPackage.id,
        owner_account_id: membershipPackage.owner_account_id,
        ...(siteLicenseId ? { site_license_id: siteLicenseId } : {}),
        pool_name: pool.pool_name.trim(),
        seat_count: pool.seat_count,
        pool_description: `${pool.pool_description ?? ""}`.trim() || null,
        requires_approval: pool.requires_approval === true,
        affiliation_reverification_days:
          pool.affiliation_reverification_days ?? null,
        affiliation_reverification_grace_days:
          pool.affiliation_reverification_grace_days ?? null,
        allowed_domains,
        expires_at: expiresAt?.endOf("day").toDate() ?? null,
      });
      await onUpdated();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  const activeSeats = membershipPackage?.active_assignment_count ?? 0;
  return (
    <ProvisionPoolEditModal
      open={open}
      pool={pool}
      poolIndex={0}
      siteLicenseTierOptions={siteLicenseTierOptions}
      onChange={(patch) =>
        setPool((current) => (current ? { ...current, ...patch } : current))
      }
      onClose={onClose}
      mode="persisted"
      activeSeatCount={activeSeats}
      domainsRequired
      expiresAt={expiresAt}
      onExpiresAtChange={setExpiresAt}
      error={error}
      submitting={submitting}
      onSubmit={save}
    />
  );
}

function TeamPackagePurchaseModal({
  open,
  membershipPackage,
  tiers,
  onClose,
  onPurchased,
}: {
  open: boolean;
  membershipPackage?: MembershipPackageDetails;
  tiers: MembershipTierLike[];
  onClose: () => void;
  onPurchased: () => Promise<void>;
}) {
  const purchaseableTiers = useMemo(() => getTeamSeatTiers(tiers), [tiers]);
  const [selectedTierId, setSelectedTierId] = useState<string>("");
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [seatCount, setSeatCount] = useState<number>(1);
  const [quote, setQuote] = useState<MembershipPackageQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string>("");
  const [actionError, setActionError] = useState<string>("");
  const [disabled, setDisabled] = useState<boolean>(false);
  const [place, setPlace] = useState<"checkout" | "processing" | "done">(
    "checkout",
  );
  const numPaymentsRef = useRef<number | null>(null);
  const [chargeAmount, setChargeAmount] = useState<number>(0);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setActionError(`${err}`),
  });

  useEffect(() => {
    if (!open) return;
    setPlace("checkout");
    setQuote(null);
    setQuoteError("");
    setActionError("");
    setDisabled(false);
    setSeatCount(1);
    if (membershipPackage) {
      setSelectedTierId(membershipPackage.membership_class);
      setInterval(
        `${membershipPackage.metadata?.interval ?? ""}` === "year"
          ? "year"
          : "month",
      );
    } else {
      setSelectedTierId(purchaseableTiers[0]?.id ?? "");
      setInterval("month");
    }
  }, [open, membershipPackage, purchaseableTiers]);

  const product = useMemo(
    () =>
      membershipPackage
        ? {
            package_id: membershipPackage.id,
            kind: "team" as const,
            seat_count: seatCount,
            membership_class:
              (membershipPackage.membership_class as MembershipClass) ??
              undefined,
            interval: (`${membershipPackage.metadata?.interval ?? interval}` ===
            "year"
              ? "year"
              : "month") as "month" | "year",
          }
        : {
            kind: "team" as const,
            membership_class:
              (selectedTierId as MembershipClass | "") || undefined,
            seat_count: seatCount,
            interval,
          },
    [membershipPackage, seatCount, selectedTierId, interval],
  );

  useEffect(() => {
    if (!open) return;
    if (!seatCount || seatCount < 1) {
      setQuote(null);
      return;
    }
    if (!membershipPackage && !selectedTierId) {
      setQuote(null);
      return;
    }
    let canceled = false;
    async function loadQuote() {
      setQuoteLoading(true);
      setQuoteError("");
      try {
        const nextQuote = await getMembershipPackageQuote(product);
        const purchaseAllowed = await isPurchaseAllowed(
          "membership",
          nextQuote.total_price,
        );
        if (!canceled) {
          setQuote(nextQuote);
          setChargeAmount(
            purchaseAllowed.chargeAmount ?? nextQuote.total_price ?? 0,
          );
        }
      } catch (err) {
        if (!canceled) {
          setQuoteError(`${err}`);
          setQuote(null);
        }
      } finally {
        if (!canceled) {
          setQuoteLoading(false);
        }
      }
    }
    void loadQuote();
    return () => {
      canceled = true;
    };
  }, [open, product, seatCount, membershipPackage, selectedTierId]);

  const selectedTier = purchaseableTiers.find(
    (tier) => tier.id === selectedTierId,
  );
  const selectedTierLabel =
    selectedTier?.label ??
    capitalize(selectedTierId || membershipPackage?.membership_class || "team");
  const totalValue = toDecimal(quote?.total_price ?? 0);
  const chargeAmountValue = toDecimal(chargeAmount);
  const lineItems: LineItem[] = [];
  if (quote) {
    lineItems.push({
      description: `${seatCount} ${selectedTierLabel} team seat${seatCount === 1 ? "" : "s"} (${currency(
        quote.seat_price,
      )} each)`,
      amount: moneyRound2Up(totalValue).toNumber(),
    });
    if (chargeAmountValue.lt(totalValue)) {
      lineItems.push({
        description: "Apply account credit toward team seats",
        amount: chargeAmountValue.sub(totalValue).toNumber(),
      });
    } else if (chargeAmountValue.gt(totalValue)) {
      lineItems.push({
        description: "Minimum charge top-up added to account credit",
        amount: chargeAmountValue.sub(totalValue).toNumber(),
      });
    }
  }

  async function completePurchase() {
    setActionError("");
    setDisabled(true);
    try {
      const completed = await runFreshAuthAction(async () => {
        await purchaseMembershipPackage(product);
        await onPurchased();
        setPlace("done");
      });
      if (!completed) {
        return;
      }
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setDisabled(false);
    }
  }

  async function refreshProcessing() {
    setActionError("");
    try {
      const { count } = await processPaymentIntents();
      if (count > 0) {
        await onPurchased();
        setPlace("done");
      }
    } catch (err) {
      setActionError(`${err}`);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      footer={null}
      width={820}
      destroyOnHidden
      title={
        <>
          <Icon name="shopping-cart" style={{ marginRight: 10 }} />
          {membershipPackage ? "Add team seats" : "Purchase team seats"}
        </>
      }
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {quoteError || actionError ? (
          <Alert
            type="error"
            title={quoteError || actionError}
            closable
            onClose={() => {
              setQuoteError("");
              setActionError("");
            }}
          />
        ) : null}
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Team seats grant account-wide membership access. Mid-term seat
          increases use the same per-seat price as the original package.
        </Paragraph>
        <Space wrap>
          <Tag color="blue">
            {membershipPackage ? "Existing team package" : "New team package"}
          </Tag>
          {membershipPackage ? <Tag>{selectedTierLabel}</Tag> : null}
        </Space>
        {!membershipPackage ? (
          <>
            <div>
              <Text strong>Membership tier</Text>
              <div style={{ marginTop: 8 }}>
                <Radio.Group
                  value={selectedTierId}
                  onChange={(e) => setSelectedTierId(e.target.value)}
                >
                  <Space orientation="vertical">
                    {purchaseableTiers.map((tier) => (
                      <Radio key={tier.id} value={tier.id}>
                        {tier.label ?? capitalize(tier.id)}
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
              </div>
              {selectedTier != null ? (
                <div style={{ marginTop: 8 }}>
                  <MembershipTierBenefits
                    compact
                    showBilling={false}
                    tier={selectedTier}
                  />
                </div>
              ) : null}
            </div>
            <div>
              <Text strong>Billing interval</Text>
              <div style={{ marginTop: 8 }}>
                <Radio.Group
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                >
                  <Space>
                    <Radio.Button value="month">Monthly</Radio.Button>
                    <Radio.Button value="year">Yearly</Radio.Button>
                  </Space>
                </Radio.Group>
              </div>
            </div>
          </>
        ) : null}
        <div>
          <Text strong>
            {membershipPackage ? "Additional seats" : "Seats to purchase"}
          </Text>
          <div style={{ marginTop: 8 }}>
            <InputNumber
              min={1}
              precision={0}
              value={seatCount}
              onChange={(value) =>
                setSeatCount(typeof value === "number" ? value : 1)
              }
            />
          </div>
        </div>
        {quoteLoading ? <Spin /> : null}
        {quote ? (
          <>
            <Space wrap>
              <MoneyStatistic title="Total price" value={quote.total_price} />
              <MoneyStatistic title="Seat price" value={quote.seat_price} />
              <Statistic
                title="Seats after purchase"
                value={(membershipPackage?.seat_count ?? 0) + seatCount}
                precision={0}
              />
            </Space>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Access runs
              {quote.starts_at ? (
                <>
                  {" "}
                  from <TimeAgo date={quote.starts_at} />
                </>
              ) : null}
              {quote.expires_at ? (
                <>
                  {" "}
                  until <TimeAgo date={quote.expires_at} />
                </>
              ) : null}
              .
            </Paragraph>
            {chargeAmountValue.gt(totalValue) ? (
              <Alert
                type="warning"
                showIcon
                title={`The minimum immediate charge is ${currency(
                  chargeAmountValue.toNumber(),
                )}.`}
                description="Any amount above the seat price is added to account credit and can be used for future purchases."
              />
            ) : null}
          </>
        ) : null}
        <Divider style={{ margin: "8px 0" }} />
        {place === "checkout" && quote ? (
          <StripePayment
            disabled={disabled}
            description={
              membershipPackage ? "Add team seats" : "Purchase team seats"
            }
            lineItems={lineItems}
            purpose={MEMBERSHIP_PACKAGE_PURCHASE}
            metadata={{
              membership_package_product: JSON.stringify({
                type: "membership-package",
                ...product,
              }),
            }}
            onFinished={async (total) => {
              if (!total) {
                await completePurchase();
                return;
              }
              setPlace("processing");
              await refreshProcessing();
            }}
          />
        ) : null}
        {place === "processing" ? (
          <>
            <Alert
              type="info"
              showIcon
              title="Payment submitted"
              description="We are waiting for the payment to finish processing. When it does, the purchased seats will appear in this package."
            />
            <Payments
              purpose={MEMBERSHIP_PACKAGE_PURCHASE}
              numPaymentsRef={numPaymentsRef}
              limit={5}
            />
            <Button onClick={refreshProcessing}>
              <Icon name="refresh" /> Refresh status
            </Button>
          </>
        ) : null}
        {place === "done" ? (
          <Alert
            type="success"
            showIcon
            title="Team seats purchased"
            description="The package seat count has been updated. You can assign seats immediately."
          />
        ) : null}
        <FreshAuthModal {...freshAuthModalProps} />
      </Space>
    </Modal>
  );
}

function AssignMembershipSeatModal({
  open,
  membershipPackage,
  onClose,
  onAssigned,
}: {
  open: boolean;
  membershipPackage: MembershipPackageDetails | null;
  onClose: () => void;
  onAssigned: () => Promise<void>;
}) {
  const [query, setQuery] = useState<string>("");
  const [searching, setSearching] = useState<boolean>(false);
  const [results, setResults] = useState<PackageUserSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string>("");
  const [selectedTarget, setSelectedTarget] = useState<string>("");
  const [assigning, setAssigning] = useState<boolean>(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setSearchError(`${err}`),
  });
  const activeAccountIds = useMemo(
    () =>
      new Set(
        membershipPackage?.assignments
          .filter(isActiveAssignment)
          .map((assignment) => assignment.account_id) ?? [],
      ),
    [membershipPackage],
  );
  const activeEmailAddresses = useMemo(
    () =>
      new Set(
        membershipPackage?.assignments
          .filter(isActiveAssignment)
          .map((assignment) => assignment.email_address?.toLowerCase())
          .filter((value): value is string => !!value) ?? [],
      ),
    [membershipPackage],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSearching(false);
    setResults([]);
    setSearchError("");
    setSelectedTarget("");
    setAssigning(false);
  }, [open, membershipPackage?.id]);

  async function runSearch() {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchError("Enter a name to search or an email address to reserve.");
      setResults([]);
      return;
    }
    setSearching(true);
    setSearchError("");
    try {
      const rawResults = await webapp_client.users_client.user_search({
        query: trimmed,
        limit: 20,
      });
      const next = (rawResults ?? [])
        .filter(
          (result): result is PackageUserSearchResult =>
            typeof result?.account_id === "string" &&
            result.account_id.length > 0 &&
            !activeAccountIds.has(result.account_id) &&
            !activeEmailAddresses.has(
              result.email_address?.toLowerCase() ?? "",
            ),
        )
        .slice(0, 20);
      setResults(next);
      if (next.length === 0) {
        const normalizedEmail = query.trim().toLowerCase();
        if (
          isValidEmailAddress(normalizedEmail) &&
          !activeEmailAddresses.has(normalizedEmail)
        ) {
          setSelectedTarget(`email:${normalizedEmail}`);
        } else {
          setSelectedTarget("");
        }
      } else if (
        !next.some(
          (result) => `account:${result.account_id}` === selectedTarget,
        )
      ) {
        setSelectedTarget(`account:${next[0].account_id}`);
      }
    } catch (err) {
      setSearchError(`${err}`);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function assign() {
    if (!membershipPackage || !selectedTarget) return;
    setAssigning(true);
    setSearchError("");
    try {
      await runFreshAuthAction(async () => {
        if (selectedTarget.startsWith("account:")) {
          await assignMembershipPackageSeat({
            package_id: membershipPackage.id,
            target_account_id: selectedTarget.slice("account:".length),
          });
        } else if (selectedTarget.startsWith("email:")) {
          await assignMembershipPackageSeat({
            package_id: membershipPackage.id,
            target_email_address: selectedTarget.slice("email:".length),
          });
        }
        await onAssigned();
      });
    } catch (err) {
      setSearchError(`${err}`);
    } finally {
      setAssigning(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={assign}
      okText="Assign seat"
      okButtonProps={{ disabled: !selectedTarget, loading: assigning }}
      destroyOnHidden
      title={`Assign ${membershipPackage ? getPackageKindLabel(membershipPackage.kind).toLowerCase() : "package"} seat`}
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {membershipPackage ? (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Search related existing accounts or enter an email address to
            reserve a seat from the{" "}
            {getPackageKindLabel(membershipPackage.kind).toLowerCase()}.
            Reserved email seats appear as claimable memberships once that user
            verifies the address on their account.
          </Paragraph>
        ) : null}
        {searchError ? (
          <Alert
            type="error"
            title={searchError}
            closable
            onClose={() => setSearchError("")}
          />
        ) : null}
        <Input.Search
          placeholder="Search by name or enter an email address"
          value={query}
          enterButton="Search"
          loading={searching}
          onChange={(e) => setQuery(e.target.value)}
          onSearch={() => {
            void runSearch();
          }}
        />
        {searching ? <Spin /> : null}
        {results.length > 0 ? (
          <Radio.Group
            value={selectedTarget}
            onChange={(e) => setSelectedTarget(e.target.value)}
            style={{ width: "100%" }}
          >
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              {results.map((result) => {
                const fullName =
                  `${result.first_name ?? ""} ${result.last_name ?? ""}`.trim();
                return (
                  <Radio
                    key={result.account_id}
                    value={`account:${result.account_id}`}
                    style={{ width: "100%" }}
                  >
                    <Space orientation="vertical" size={0}>
                      <Text>{fullName || result.account_id}</Text>
                      <Text type="secondary">
                        {result.email_address || result.account_id}
                      </Text>
                    </Space>
                  </Radio>
                );
              })}
            </Space>
          </Radio.Group>
        ) : null}
        {!searching &&
        query.trim() &&
        results.length === 0 &&
        !searchError &&
        isValidEmailAddress(query.trim().toLowerCase()) &&
        !activeEmailAddresses.has(query.trim().toLowerCase()) ? (
          <Radio.Group
            value={selectedTarget}
            onChange={(e) => setSelectedTarget(e.target.value)}
            style={{ width: "100%" }}
          >
            <Radio value={`email:${query.trim().toLowerCase()}`}>
              <Space orientation="vertical" size={0}>
                <Text>{query.trim().toLowerCase()}</Text>
                <Text type="secondary">
                  Reserve this seat by email until the user verifies it
                </Text>
              </Space>
            </Radio>
          </Radio.Group>
        ) : null}
        {!searching && query.trim() && results.length === 0 && !searchError ? (
          <Alert
            type="info"
            showIcon
            title="No matching existing account found"
            description={
              isValidEmailAddress(query.trim().toLowerCase())
                ? "You can still reserve the seat by email above."
                : "Search by name or enter an email address."
            }
          />
        ) : null}
      </Space>
      <FreshAuthModal {...freshAuthModalProps} />
    </Modal>
  );
}

export default TeamPackageManager;
