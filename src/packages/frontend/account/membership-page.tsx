/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Modal,
  Space,
  Tag,
  Table,
  Typography,
} from "antd";
import { lazy, Suspense, useEffect, useState } from "react";
import { defineMessage } from "react-intl";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Loading } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { labels } from "@cocalc/frontend/i18n";
import {
  getSiteLicenseAffiliationReverificationStatus,
  refreshSiteLicenseAffiliationVerification,
} from "@cocalc/frontend/purchases/api";
import type { BillingInterval } from "./membership-pricing-chooser";
import type {
  MembershipCandidate,
  MembershipResolution,
  SiteLicenseAffiliationReverificationUserSeat,
  SiteLicenseAffiliationReverificationUserStatus,
} from "@cocalc/conat/hub/api/purchases";
import { capitalize, currency } from "@cocalc/util/misc";
import { buildMembershipTierPresentation } from "@cocalc/util/membership-tier-presentation";
import {
  type MembershipCandidateRow,
  type MembershipTier,
  useMembershipSettingsData,
} from "./membership-settings-data";
import MembershipPurchaseModal from "./membership-purchase-modal";
import type { SettingsPageDefinition } from "./settings-page";
import { openAccountSettings } from "./settings-routing";
import { UseBalance } from "./balance-toward-subs";

const { Paragraph, Text } = Typography;

const ClaimableMembershipPackagesPanel = lazy(async () => ({
  default: (await import("./membership-package-manager"))
    .ClaimableMembershipPackagesPanel,
}));

export const MEMBERSHIP_SETTINGS_PAGE = {
  component: MembershipPage,
  description: defineMessage({
    id: "account.settings.overview.membership",
    defaultMessage:
      "Review your current membership, its source, and available changes.",
  }),
  icon: "user",
  key: "membership",
  label: labels.membership,
} satisfies SettingsPageDefinition;

export function MembershipPage() {
  return (
    <>
      <Paragraph type="secondary">
        Your membership determines your account limits.{" "}
        <a
          onClick={(event) => {
            event.preventDefault();
            openAccountSettings({ page: "usage-limits" });
          }}
        >
          Check current usage and limits.
        </a>
      </Paragraph>
      <MembershipSettingsContent />
    </>
  );
}

function MembershipSettingsContent() {
  const {
    account_id,
    candidateRows,
    details,
    error,
    loading,
    membership,
    refresh,
    tierById,
  } = useMembershipSettingsData();
  const stripeEnabled = !!useTypedRedux("customize", "stripe_enabled");
  const [purchaseOpen, setPurchaseOpen] = useState<boolean>(false);
  const [purchaseCurrentClass, setPurchaseCurrentClass] = useState<
    string | undefined
  >(undefined);
  const [purchaseCurrentInterval, setPurchaseCurrentInterval] = useState<
    BillingInterval | undefined
  >(undefined);
  const [siteLicenseManageOpen, setSiteLicenseManageOpen] =
    useState<boolean>(false);
  const [siteLicenseManageSource, setSiteLicenseManageSource] =
    useState<string>("site-license");
  const [siteLicenseRefreshToken, setSiteLicenseRefreshToken] =
    useState<number>(0);
  const [reverificationStatus, setReverificationStatus] =
    useState<SiteLicenseAffiliationReverificationUserStatus | null>(null);
  const [reverificationError, setReverificationError] = useState<string>("");
  const [reverifyingSiteLicenseId, setReverifyingSiteLicenseId] =
    useState<string>("");
  const siteLicenseReverificationKey = candidateRows
    .filter(
      (row) =>
        row.action === "site-license" &&
        row.sourceKind === "grant" &&
        row.grantPackageId,
    )
    .map((row) => `${row.siteLicenseId ?? ""}:${row.grantPackageId}`)
    .sort()
    .join("|");

  useEffect(() => {
    let canceled = false;
    async function loadReverificationStatus() {
      if (!account_id || !siteLicenseReverificationKey) {
        setReverificationStatus(null);
        setReverificationError("");
        return;
      }
      setReverificationError("");
      try {
        const next = await getSiteLicenseAffiliationReverificationStatus();
        if (!canceled) {
          setReverificationStatus(next);
        }
      } catch (err) {
        if (!canceled) {
          setReverificationError(`${err}`);
        }
      }
    }
    void loadReverificationStatus();
    return () => {
      canceled = true;
    };
  }, [account_id, siteLicenseReverificationKey, siteLicenseRefreshToken]);

  if (!account_id) return null;
  if (loading && !membership) return <Loading />;
  if (error) return <Alert type="error" title={error} />;
  if (!membership) return null;

  const tier = tierById[membership.class];
  const selectedSourceRow = candidateRows.find((row) => row.selected);
  const effectiveSummary = effectiveMembershipSummary({
    membership,
    selectedSourceRow,
    tier,
  });
  const hasSiteLicenseRow = candidateRows.some(
    (row) => row.action === "site-license",
  );
  const personalMembership = details?.candidates.find(
    (candidate) => candidate.source === "subscription",
  );
  const refreshMembership = () => {
    window.dispatchEvent(new Event("cocalc:membership-changed"));
    refresh();
    setSiteLicenseRefreshToken((value) => value + 1);
  };
  const openPurchase = (
    currentClassOverride?: string,
    currentIntervalOverride?: BillingInterval,
  ) => {
    setPurchaseCurrentClass(currentClassOverride);
    setPurchaseCurrentInterval(currentIntervalOverride);
    setPurchaseOpen(true);
  };
  const closePurchase = () => {
    setPurchaseOpen(false);
    setPurchaseCurrentClass(undefined);
    setPurchaseCurrentInterval(undefined);
    refreshMembership();
  };
  const openSiteLicenseManage = (source = "site license") => {
    setSiteLicenseManageSource(source);
    setSiteLicenseManageOpen(true);
  };
  const openPersonalMembershipManage = () => {
    const currentPersonalRow = candidateRows.find(
      (row) =>
        row.sourceKind === "subscription" &&
        row.subscriptionStatus !== "canceled",
    );
    openPurchase(
      currentPersonalRow?.class ?? "free",
      currentPersonalRow?.subscriptionInterval,
    );
  };
  const reverifySiteLicense = async (siteLicenseId: string) => {
    setReverifyingSiteLicenseId(siteLicenseId);
    setReverificationError("");
    try {
      const refreshed = await refreshSiteLicenseAffiliationVerification({
        site_license_id: siteLicenseId,
      });
      const nextDueDate = refreshed
        .map((seat) => seat.reverification_due_at)
        .filter((date) => date != null)
        .map((date) => new Date(date as Date | string))
        .filter((date) => Number.isFinite(date.valueOf()))
        .sort((left, right) => left.getTime() - right.getTime())[0];
      Modal.success({
        title: "Affiliation reverified",
        content:
          nextDueDate == null
            ? "Your site-license membership affiliation was reverified."
            : `Your site-license membership affiliation was reverified. Reverify by ${formatLongDate(nextDueDate)}.`,
      });
      refreshMembership();
    } catch (err) {
      const message = `${err}`;
      setReverificationError(message);
      Modal.error({
        title: "Reverification failed",
        content: message,
      });
    } finally {
      setReverifyingSiteLicenseId("");
    }
  };

  return (
    <Space vertical size="middle" style={{ width: "100%" }}>
      <Card size="small" title={`Effective: ${effectiveSummary}`}>
        <Space vertical style={{ width: "100%" }}>
          <EffectiveMembershipDescription
            membership={membership}
            selectedSourceRow={selectedSourceRow}
            tier={tier}
          />
          {details?.admin_override ? (
            <Alert
              type="info"
              showIcon
              message="Support override active"
              description={
                <>
                  {details.admin_override.effects?.length ? (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {details.admin_override.effects.map((effect) => (
                        <li key={effect}>{effect}</li>
                      ))}
                    </ul>
                  ) : (
                    "Account-specific support limits are reflected in the values below."
                  )}
                  {details.admin_override.expires_at ? (
                    <>
                      {" "}
                      This override expires{" "}
                      <TimeAgo date={details.admin_override.expires_at} />.
                    </>
                  ) : null}
                </>
              }
            />
          ) : null}
        </Space>
      </Card>

      {isPaidPersonalMembership(personalMembership) ? (
        <Card size="small" title="Personal membership billing">
          <PersonalMembershipDetails
            effective={selectedSourceRow?.sourceKind === "subscription"}
            membership={personalMembership}
            showBalanceControl={
              stripeEnabled &&
              personalMembership.subscription_status !== "canceled"
            }
            tier={tierById[personalMembership.class]}
          />
        </Card>
      ) : null}

      <Card size="small" title="Memberships">
        <Space vertical style={{ width: "100%" }}>
          {candidateRows.length === 0 ? (
            <Text type="secondary">No active memberships.</Text>
          ) : (
            <Table
              size="small"
              pagination={false}
              dataSource={candidateRows}
              columns={[
                {
                  title: "Source",
                  dataIndex: "source",
                },
                {
                  title: "Membership",
                  dataIndex: "membership",
                },
                {
                  title: "State",
                  dataIndex: "state",
                  render: (value) => (
                    <Tag color={membershipStateColor(value)}>{value}</Tag>
                  ),
                },
                {
                  title: "Note",
                  dataIndex: "note",
                  render: (value, row) =>
                    siteLicenseReverificationNote(
                      reverificationSeatForRow(reverificationStatus, row),
                    ) ?? value,
                },
                {
                  title: "Action",
                  key: "action",
                  render: (_, row) => {
                    if (row.action === "personal") {
                      return (
                        <Button onClick={openPersonalMembershipManage}>
                          Manage
                        </Button>
                      );
                    }
                    if (row.action === "site-license") {
                      const seat = reverificationSeatForRow(
                        reverificationStatus,
                        row,
                      );
                      return (
                        <Space wrap size="small">
                          <Button
                            onClick={() => openSiteLicenseManage(row.source)}
                          >
                            Manage
                          </Button>
                          {seat != null ? (
                            <Button
                              disabled={!seat.can_refresh_with_verified_email}
                              loading={
                                reverifyingSiteLicenseId ===
                                seat.site_license_id
                              }
                              onClick={() =>
                                void reverifySiteLicense(seat.site_license_id)
                              }
                            >
                              Reverify
                            </Button>
                          ) : null}
                        </Space>
                      );
                    }
                    return <Text type="secondary">-</Text>;
                  },
                },
              ]}
            />
          )}
          {!hasSiteLicenseRow ? (
            <Space wrap>
              <Button onClick={() => openSiteLicenseManage()}>
                Manage site license membership
              </Button>
            </Space>
          ) : null}
          {reverificationError ? (
            <Alert type="error" title={reverificationError} />
          ) : null}
        </Space>
      </Card>

      <Modal
        open={siteLicenseManageOpen}
        title={`Manage ${siteLicenseManageSource} membership`}
        footer={null}
        onCancel={() => setSiteLicenseManageOpen(false)}
        destroyOnHidden
      >
        <Suspense fallback={<Loading />}>
          <ClaimableMembershipPackagesPanel
            onChanged={refreshMembership}
            onSiteLicenseTitleChange={(source) => {
              if (source) {
                setSiteLicenseManageSource(source);
              }
            }}
            refreshToken={siteLicenseRefreshToken}
          />
        </Suspense>
      </Modal>

      <MembershipPurchaseModal
        currentClassOverride={purchaseCurrentClass}
        currentIntervalOverride={purchaseCurrentInterval}
        open={purchaseOpen}
        onClose={closePurchase}
        onChanged={refreshMembership}
      />
    </Space>
  );
}

function EffectiveTierDescription({ tier }: { tier: MembershipTier }) {
  const presentation = buildMembershipTierPresentation(tier);
  const description = tier.store_description?.trim() || presentation.tagline;
  const highlights = effectiveTierHighlights(tier, presentation);

  return (
    <Space vertical size="small" style={{ width: "100%" }}>
      {description ? <Text type="secondary">{description}</Text> : null}
      {highlights.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {highlights.map((highlight) => (
            <li key={highlight}>{highlight}</li>
          ))}
        </ul>
      ) : null}
    </Space>
  );
}

function EffectiveMembershipDescription({
  membership,
  selectedSourceRow,
  tier,
}: {
  membership: MembershipResolution;
  selectedSourceRow?: MembershipCandidateRow;
  tier?: MembershipTier;
}) {
  const poolDescription = `${
    membership.grant_source === "site-license"
      ? (membership.pool_description ??
        selectedSourceRow?.poolDescription ??
        "")
      : ""
  }`.trim();
  if (poolDescription) {
    return <Paragraph>{poolDescription}</Paragraph>;
  }
  return tier != null ? <EffectiveTierDescription tier={tier} /> : null;
}

function effectiveTierHighlights(
  tier: MembershipTier,
  presentation: ReturnType<typeof buildMembershipTierPresentation>,
): string[] {
  if (tier.store_highlights != null) {
    return tier.store_highlights
      .map((highlight) => highlight.trim())
      .filter((highlight) => highlight.length > 0);
  }
  return presentation.summaryBenefits;
}

function effectiveMembershipSummary({
  membership,
  selectedSourceRow,
  tier,
}: {
  membership: MembershipResolution;
  selectedSourceRow?: MembershipCandidateRow;
  tier?: MembershipTier;
}): string {
  const tierLabel =
    selectedSourceRow?.membership ??
    tier?.label ??
    capitalize(membership.class);
  const source = effectiveMembershipSourceLabel(membership, selectedSourceRow);
  return `${source} - ${tierLabel}`;
}

function PersonalMembershipDetails({
  effective,
  membership,
  showBalanceControl,
  tier,
}: {
  effective: boolean;
  membership: MembershipCandidate;
  showBalanceControl: boolean;
  tier?: MembershipTier;
}) {
  const name = tier?.label ?? capitalize(membership.class);
  const price = personalMembershipPriceLabel(membership);
  const charge = personalMembershipChargeLabel(membership);
  const canceled = membership.subscription_status === "canceled";
  const endDate = formatOptionalLongDate(membership.expires);

  return (
    <Space vertical style={{ width: "100%" }}>
      <Text>{price ? `${name}: ${price}.` : name}</Text>
      {canceled ? (
        <Text>
          {endDate
            ? `Ends ${endDate}. Renewal is canceled.`
            : "Renewal is canceled."}
        </Text>
      ) : (
        <Text>
          {charge
            ? `Next charge: ${charge}.`
            : "Next charge date is not available."}
        </Text>
      )}
      {!effective ? (
        <Text>
          This personal membership is not currently used because another
          membership has higher priority.
        </Text>
      ) : null}
      {showBalanceControl ? <UseBalance /> : null}
    </Space>
  );
}

function isPaidPersonalMembership(
  membership: MembershipCandidate | undefined,
): membership is MembershipCandidate {
  return (
    membership?.source === "subscription" &&
    (numberValue(membership.subscription_cost) ?? 0) > 0
  );
}

function reverificationSeatForRow(
  status: SiteLicenseAffiliationReverificationUserStatus | null,
  row: MembershipCandidateRow,
): SiteLicenseAffiliationReverificationUserSeat | undefined {
  if (
    status == null ||
    row.action !== "site-license" ||
    row.sourceKind !== "grant" ||
    !row.grantPackageId
  ) {
    return;
  }
  return status.seats.find((seat) => {
    if (seat.package_id !== row.grantPackageId) return false;
    return !row.siteLicenseId || seat.site_license_id === row.siteLicenseId;
  });
}

function siteLicenseReverificationNote(
  seat: SiteLicenseAffiliationReverificationUserSeat | undefined,
): string | undefined {
  if (seat?.reverification_due_at == null) return;
  const due = new Date(seat.reverification_due_at);
  if (!Number.isFinite(due.valueOf())) return;
  if (due.getTime() <= Date.now()) {
    return "Reverify now";
  }
  return `Reverify by ${formatLongDate(due)}`;
}

function formatLongDate(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(value);
}

function effectiveMembershipSourceLabel(
  membership: MembershipResolution,
  selectedSourceRow?: MembershipCandidateRow,
): string {
  if (selectedSourceRow?.source) {
    return selectedSourceRow.source;
  }
  if (membership.source === "free") {
    return "Personal";
  }
  if (membership.source === "subscription") {
    return "Personal";
  }
  if (membership.source === "admin") {
    return "Admin assigned";
  }
  if (membership.grant_source === "team-seat") {
    return "Team license";
  }
  if (membership.grant_source === "site-license") {
    return (
      siteLicenseDisplayName(
        membership.site_license_name,
        membership.organization_name,
      ) ?? "Site license"
    );
  }
  if (membership.grant_source?.includes("course")) {
    return "Course membership";
  }
  return "Granted";
}

function siteLicenseDisplayName(
  siteLicenseName?: string | null,
  organizationName?: string | null,
): string | undefined {
  const title = `${siteLicenseName ?? ""}`.trim();
  const organization = `${organizationName ?? ""}`.trim();
  return title || organization || undefined;
}

function personalMembershipPriceLabel(
  membership: Pick<
    MembershipCandidate | MembershipResolution,
    "source" | "subscription_cost" | "subscription_interval"
  >,
): string | undefined {
  if (membership.source !== "subscription") {
    return;
  }
  const cost = numberValue(membership.subscription_cost);
  if (cost == null || cost <= 0) {
    return;
  }
  if (membership.subscription_interval === "month") {
    return `${formatMonthlyPrice(cost)}/month`;
  }
  if (membership.subscription_interval === "year") {
    return `${formatMonthlyPrice(cost / 12)}/month, billed annually`;
  }
}

function personalMembershipChargeLabel(
  membership: MembershipCandidate,
): string | undefined {
  const cost = numberValue(membership.subscription_cost);
  if (cost == null || cost <= 0) return;
  const date = formatOptionalLongDate(membership.expires);
  const amount = formatCurrencyAmount(cost);
  return date ? `${amount} on ${date}` : amount;
}

function formatOptionalLongDate(
  value?: Date | string | null,
): string | undefined {
  if (value == null) return;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return;
  return formatLongDate(date);
}

function formatCurrencyAmount(value: number): string {
  return Number.isInteger(value) ? currency(value, 0) : currency(value);
}

function formatMonthlyPrice(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.005) {
    return currency(rounded, 0);
  }
  return currency(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

function membershipStateColor(state: string) {
  switch (state) {
    case "Active":
      return "green";
    case "Pending":
    case "Pending approval":
      return "gold";
    case "Renewal canceled":
      return "orange";
  }
}
