/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Popconfirm,
  Space,
  Tag,
  Table,
  Typography,
} from "antd";
import { useState } from "react";
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
import {
  ClaimableMembershipPackagesPanel,
  SiteLicenseReverificationPanel,
} from "./membership-package-manager";
import MembershipPurchaseModal from "./membership-purchase-modal";
import type { SettingsPageDefinition } from "./settings-page";
import { openAccountSettings } from "./settings-routing";
import { UseBalance } from "./balance-toward-subs";

const { Paragraph, Text } = Typography;

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
  const isCommercial = !!useTypedRedux("customize", "is_commercial");
  const [purchaseOpen, setPurchaseOpen] = useState<boolean>(false);
  const [purchaseCurrentClass, setPurchaseCurrentClass] = useState<
    string | undefined
  >(undefined);

  if (!account_id) return null;
  if (loading) return <Loading />;
  if (error) return <Alert type="error" title={error} />;
  if (!membership) return null;

  const tier = tierById[membership.class];
  const selectedSourceRow = candidateRows.find((row) => row.selected);
  const personalMembership = details?.candidates.find(
    (candidate) => candidate.source === "subscription",
  );
  const refreshMembership = () => {
    window.dispatchEvent(new Event("cocalc:membership-changed"));
    refresh();
  };
  const openPurchase = (currentClassOverride?: string) => {
    setPurchaseCurrentClass(currentClassOverride);
    setPurchaseOpen(true);
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small" title="Effective membership">
        <Space direction="vertical" style={{ width: "100%" }}>
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
        <Space direction="vertical" style={{ width: "100%" }}>
          {candidateRows.length === 0 ? (
            <Text type="secondary">No active membership sources.</Text>
          ) : (
            <Table
              size="small"
              pagination={false}
              dataSource={candidateRows}
              columns={[
                {
                  title: "Membership",
                  dataIndex: "tier",
                  render: (value, row) => (
                    <Space>
                      <Tag color={row.selected ? "blue" : undefined}>
                        {value}
                      </Tag>
                    </Space>
                  ),
                },
                {
                  title: "Source",
                  dataIndex: "source",
                  render: (value, row) => (
                    <Space direction="vertical" size={0}>
                      <Text>{value}</Text>
                      <Text type="secondary">{row.sourceDetail}</Text>
                    </Space>
                  ),
                },
                {
                  title: "Status",
                  dataIndex: "status",
                  render: (value, row) => (
                    <Tag color={membershipStatusColor(row)}>{value}</Tag>
                  ),
                },
                {
                  title: "Expires",
                  dataIndex: "expires",
                  render: (value) =>
                    value ? <TimeAgo date={value} /> : <Text>Never</Text>,
                },
              ]}
            />
          )}
          <Space wrap>
            <Button
              onClick={() => {
                openPurchase(personalMembership?.class ?? "free");
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
            <ClaimableMembershipPackagesPanel
              compact
              onChanged={refreshMembership}
            />
          </Space>
          {isCommercial ? <UseBalance /> : null}
          <SiteLicenseReverificationPanel onChanged={refreshMembership} />
        </Space>
      </Card>

      <MembershipPurchaseModal
        currentClassOverride={purchaseCurrentClass}
        open={purchaseOpen}
        onClose={() => {
          setPurchaseOpen(false);
          setPurchaseCurrentClass(undefined);
        }}
        onChanged={refresh}
      />
    </Space>
  );
}

function EffectiveTierDescription({ tier }: { tier: MembershipTier }) {
  const presentation = buildMembershipTierPresentation(tier);
  const description = tier.store_description?.trim() || presentation.tagline;
  const highlights = effectiveTierHighlights(tier, presentation);

  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
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
  const tierLabel = tier?.label ?? capitalize(membership.class);
  const price = personalMembershipPriceLabel(membership);
  const source = effectiveMembershipSourceLabel(membership, selectedSourceRow);
  return `${tierLabel}${price ? ` (${price})` : ""} - ${source}`;
}

function effectiveMembershipSourceLabel(
  membership: MembershipResolution,
  selectedSourceRow?: MembershipCandidateRow,
): string {
  if (membership.source === "free") {
    return "CoCalc";
  }
  if (selectedSourceRow?.source) {
    return selectedSourceRow.source;
  }
  if (membership.source === "subscription") {
    return "Personal membership";
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

function membershipStatusColor({
  selected,
  subscriptionStatus,
}: {
  selected: boolean;
  subscriptionStatus?: "active" | "canceled" | "unpaid" | "past_due";
}) {
  if (selected) return "blue";
  if (subscriptionStatus === "canceled") return "orange";
  if (subscriptionStatus === "past_due" || subscriptionStatus === "unpaid") {
    return "red";
  }
  return undefined;
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
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

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
