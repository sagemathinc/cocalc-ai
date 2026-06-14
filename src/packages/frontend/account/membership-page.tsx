/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Table,
  Typography,
} from "antd";
import { lazy, Suspense, useState } from "react";
import { defineMessage } from "react-intl";

import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Loading } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { labels } from "@cocalc/frontend/i18n";
import {
  cancelSubscription,
  resumeSubscription,
} from "@cocalc/frontend/purchases/api";
import type { BillingInterval } from "./membership-pricing-chooser";
import type {
  MembershipCandidate,
  MembershipResolution,
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

const SiteLicenseReverificationPanel = lazy(async () => ({
  default: (await import("./membership-package-manager"))
    .SiteLicenseReverificationPanel,
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
  const [siteLicenseRefreshToken, setSiteLicenseRefreshToken] =
    useState<number>(0);

  if (!account_id) return null;
  if (loading && !membership) return <Loading />;
  if (error) return <Alert type="error" title={error} />;
  if (!membership) return null;

  const tier = tierById[membership.class];
  const selectedSourceRow = candidateRows.find((row) => row.selected);
  const personalMembership = details?.candidates.find(
    (candidate) => candidate.source === "subscription",
  );
  const hasSiteLicenseMembership =
    membership.grant_source === "site-license" ||
    details?.candidates.some(
      (candidate) => candidate.grant_source === "site-license",
    ) === true;
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

  return (
    <Space vertical size="middle" style={{ width: "100%" }}>
      <Card size="small" title="Effective membership">
        <Space vertical style={{ width: "100%" }}>
          <Text strong>
            {effectiveMembershipSummary({
              membership,
              selectedSourceRow,
              tier,
            })}
          </Text>
          {tier != null ? <EffectiveTierDescription tier={tier} /> : null}
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

      <Card size="small" title="Membership sources">
        <Space vertical style={{ width: "100%" }}>
          {candidateRows.length === 0 ? (
            <Text type="secondary">No active membership sources.</Text>
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
                },
                {
                  title: "Action",
                  key: "action",
                  render: (_, row) => {
                    if (row.action === "personal") {
                      return (
                        <Button
                          onClick={() =>
                            openPurchase(row.class, row.subscriptionInterval)
                          }
                        >
                          Manage
                        </Button>
                      );
                    }
                    if (row.action === "site-license") {
                      return (
                        <Button onClick={() => setSiteLicenseManageOpen(true)}>
                          Manage
                        </Button>
                      );
                    }
                    return <Text type="secondary">-</Text>;
                  },
                },
              ]}
            />
          )}
          <Space wrap>
            <Button
              onClick={() => {
                openPurchase(
                  personalMembership?.class ?? "free",
                  personalMembership?.subscription_interval,
                );
              }}
            >
              Configure personal membership
            </Button>
            {personalMembership ? (
              <PersonalSubscriptionActions
                membership={personalMembership}
                refresh={refreshMembership}
              />
            ) : null}
            <Suspense fallback={null}>
              <ClaimableMembershipPackagesPanel
                compact
                hasSiteLicenseMembership={hasSiteLicenseMembership}
                onChanged={refreshMembership}
                refreshToken={siteLicenseRefreshToken}
                tiers={Object.values(tierById)}
              />
            </Suspense>
          </Space>
          {stripeEnabled ? <UseBalance /> : null}
          <Suspense fallback={null}>
            <SiteLicenseReverificationPanel onChanged={refreshMembership} />
          </Suspense>
        </Space>
      </Card>

      <Modal
        open={siteLicenseManageOpen}
        title="Manage site-license membership"
        footer={null}
        onCancel={() => setSiteLicenseManageOpen(false)}
        destroyOnHidden
      >
        <Suspense fallback={<Loading />}>
          <ClaimableMembershipPackagesPanel
            hasSiteLicenseMembership={hasSiteLicenseMembership}
            onChanged={refreshMembership}
            refreshToken={siteLicenseRefreshToken}
            tiers={Object.values(tierById)}
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
  const price = personalMembershipPriceLabel(membership);
  const source = effectiveMembershipSourceLabel(membership, selectedSourceRow);
  return `${tierLabel}${price ? ` (${price})` : ""} - ${source}`;
}

function effectiveMembershipSourceLabel(
  membership: MembershipResolution,
  selectedSourceRow?: MembershipCandidateRow,
): string {
  if (membership.source === "free") {
    return "Personal";
  }
  if (membership.source === "subscription") {
    return "Personal membership";
  }
  if (selectedSourceRow?.source) {
    return selectedSourceRow.source;
  }
  if (membership.source === "admin") {
    return "Admin assigned";
  }
  if (membership.grant_source === "team-seat") {
    return "Team license";
  }
  if (membership.grant_source === "site-license") {
    return "Site license";
  }
  if (membership.grant_source?.includes("course")) {
    return "Course membership";
  }
  return "Granted";
}

function personalMembershipPriceLabel(
  membership: MembershipResolution,
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

function PersonalSubscriptionActions({
  membership,
  refresh,
}: {
  membership: MembershipCandidate;
  refresh: () => void;
}) {
  const subscriptionId = membership.subscription_id;
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  if (subscriptionId == null) {
    return null;
  }

  const canceled = membership.subscription_status === "canceled";
  const cancel = async () => {
    setLoading(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        await cancelSubscription({
          subscription_id: subscriptionId,
          reason: "Canceled from Membership settings.",
        });
        refresh();
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };
  const resume = async () => {
    setLoading(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        await resumeSubscription(subscriptionId);
        refresh();
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {error && <Alert type="error" message={error} closable />}
      {canceled ? (
        <Button loading={loading} onClick={resume}>
          Resume renewal
        </Button>
      ) : (
        <Popconfirm
          title="Cancel membership renewal?"
          description="Your current paid membership remains active until its listed expiration date."
          okButtonProps={{ danger: true, loading }}
          okText="Cancel renewal"
          onConfirm={cancel}
        >
          <Button danger loading={loading}>
            Cancel...
          </Button>
        </Popconfirm>
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
