/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Descriptions,
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
import { Loading } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { labels } from "@cocalc/frontend/i18n";
import {
  cancelSubscription,
  resumeSubscription,
} from "@cocalc/frontend/purchases/api";
import type { MembershipCandidate } from "@cocalc/conat/hub/api/purchases";
import { capitalize } from "@cocalc/util/misc";
import { useMembershipSettingsData } from "./membership-settings-data";
import {
  formatFeatureTag,
  normalizeRecord,
} from "./membership-settings-format";
import {
  ClaimableMembershipPackagesPanel,
  SiteLicenseReverificationPanel,
} from "./membership-package-manager";
import MembershipPurchaseModal from "./membership-purchase-modal";
import { MembershipTierBenefits } from "./membership-tier-benefits";
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
  const [purchaseOpen, setPurchaseOpen] = useState<boolean>(false);
  const [purchaseCurrentClass, setPurchaseCurrentClass] = useState<
    string | undefined
  >(undefined);

  if (!account_id) return null;
  if (loading) return <Loading />;
  if (error) return <Alert type="error" title={error} />;
  if (!membership) return null;

  const tier = tierById[membership.class];
  const tierLabel =
    tier?.label ?? (membership ? capitalize(membership.class) : "");
  const membershipSourceLabel =
    membership.source === "subscription"
      ? "Personal membership"
      : membership.source === "grant"
        ? "Granted"
        : membership.source === "admin"
          ? "Admin assigned"
          : "Free";
  const expiresLabel = "Expires";
  const entitlements = normalizeRecord(membership.entitlements);
  const features = normalizeRecord(entitlements.features);
  const featureTags = Object.entries(features)
    .map(([key, value]) => formatFeatureTag(key, value))
    .filter((value): value is string => !!value);
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
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small" title="Membership sources">
        <Space orientation="vertical" style={{ width: "100%" }}>
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
                    <Space orientation="vertical" size={0}>
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
          {personalMembership &&
          personalMembership.subscription_status !== "canceled" ? (
            <UseBalance minimal />
          ) : null}
          <SiteLicenseReverificationPanel onChanged={refreshMembership} />
        </Space>
      </Card>

      <Card size="small" title="Effective membership">
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="Tier">
              <Space>
                <Tag color={membership.class === "free" ? "default" : "blue"}>
                  {tierLabel || membership.class}
                </Tag>
                <Text type="secondary">{membership.class}</Text>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="Source">
              {selectedSourceRow?.source ?? membershipSourceLabel}
            </Descriptions.Item>
            {membership.expires && membership.source !== "subscription" && (
              <Descriptions.Item label={expiresLabel}>
                <MembershipDate date={membership.expires} />
              </Descriptions.Item>
            )}
          </Descriptions>
          {tier != null ? <MembershipTierBenefits compact tier={tier} /> : null}
          {featureTags.length > 0 ? (
            <div>
              <Text strong>Features</Text>
              <div style={{ marginTop: "6px" }}>
                <Space wrap>
                  {featureTags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </Space>
              </div>
            </div>
          ) : null}
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

function MembershipDate({ date }: { date: Date | string }) {
  return (
    <Space wrap size="small">
      <Text>{new Date(date).toLocaleString()}</Text>
      <Text type="secondary">
        <TimeAgo date={date} />
      </Text>
    </Space>
  );
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
