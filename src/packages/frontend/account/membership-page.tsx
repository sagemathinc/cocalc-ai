/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Divider,
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
import { Icon, Loading } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { labels } from "@cocalc/frontend/i18n";
import {
  cancelSubscription,
  resumeSubscription,
} from "@cocalc/frontend/purchases/api";
import { capitalize } from "@cocalc/util/misc";
import { useMembershipSettingsData } from "./membership-settings-data";
import {
  formatFeatureTag,
  normalizeRecord,
} from "./membership-settings-format";
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

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
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
          {membershipSourceLabel}
        </Descriptions.Item>
        {membership.expires && membership.source !== "subscription" && (
          <Descriptions.Item label={expiresLabel}>
            <MembershipDate date={membership.expires} />
          </Descriptions.Item>
        )}
      </Descriptions>

      <PersonalSubscriptionControls membership={membership} refresh={refresh} />

      {tier != null ? (
        <Card size="small">
          <MembershipTierBenefits compact tier={tier} />
        </Card>
      ) : null}

      {details?.admin_override ? (
        <Alert
          type="info"
          showIcon
          title="Support override active"
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

      <Space wrap>
        <Button
          type={membership.class === "free" ? "primary" : "default"}
          onClick={() => setPurchaseOpen(true)}
        >
          {membership.class === "free"
            ? "Upgrade membership"
            : "Change membership"}
        </Button>
      </Space>

      <Divider style={{ margin: "8px 0" }} />

      <Card size="small">
        <Space
          wrap
          align="center"
          style={{ justifyContent: "space-between", width: "100%" }}
        >
          <Space orientation="vertical" size={2}>
            <Text strong>Institutional and team licenses</Text>
            <Text type="secondary">
              Claim site-license access, refresh institutional affiliation, or
              manage team and campus license seats from the Licenses page.
            </Text>
          </Space>
          <Button onClick={() => openAccountSettings({ page: "licenses" })}>
            <Icon name="key" /> Open Licenses
          </Button>
        </Space>
      </Card>

      <Divider style={{ margin: "8px 0" }} />

      <div>
        <Text strong>Features</Text>
        <div style={{ marginTop: "6px" }}>
          {featureTags.length === 0 ? (
            <Text type="secondary">No membership features configured.</Text>
          ) : (
            <Space wrap>
              {featureTags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </Space>
          )}
        </div>
      </div>

      <Collapse
        items={[
          {
            key: "membership-sources",
            label: "Why this membership?",
            children:
              candidateRows.length === 0 ? (
                <Text type="secondary">No active membership sources.</Text>
              ) : (
                <Table
                  size="small"
                  pagination={false}
                  dataSource={candidateRows}
                  columns={[
                    {
                      title: "Tier",
                      dataIndex: "tier",
                      render: (value, row) => (
                        <Space>
                          {value}
                          {row.selected && <Tag color="blue">Selected</Tag>}
                        </Space>
                      ),
                    },
                    { title: "Source", dataIndex: "source" },
                    { title: "Priority", dataIndex: "priority" },
                    {
                      title: "Expires",
                      dataIndex: "expires",
                      render: (value) =>
                        value ? <TimeAgo date={value} /> : "Never",
                    },
                  ]}
                />
              ),
          },
        ]}
      />

      <MembershipPurchaseModal
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
        onChanged={refresh}
      />
    </Space>
  );
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

function PersonalSubscriptionControls({
  membership,
  refresh,
}: {
  membership: NonNullable<
    ReturnType<typeof useMembershipSettingsData>["membership"]
  >;
  refresh: () => void;
}) {
  const subscriptionId = membership.subscription_id;
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

  if (membership.source !== "subscription" || subscriptionId == null) {
    return null;
  }

  const canceled = membership.subscription_status === "canceled";
  const refreshMembership = () => {
    window.dispatchEvent(new Event("cocalc:membership-changed"));
    refresh();
  };
  const cancel = async () => {
    setLoading(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        await cancelSubscription({
          subscription_id: subscriptionId,
          reason: "Canceled from Membership settings.",
        });
        refreshMembership();
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
        refreshMembership();
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card size="small" title="Personal membership">
      <Space orientation="vertical" style={{ width: "100%" }}>
        {error && <Alert type="error" title={error} closable />}
        <Descriptions size="small" column={1}>
          <Descriptions.Item label={canceled ? "Active until" : "Next payment"}>
            {membership.expires ? (
              <MembershipDate date={membership.expires} />
            ) : (
              <Text type="secondary">Not scheduled</Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Renewal">
            {canceled ? "Canceled" : "Automatic"}
          </Descriptions.Item>
        </Descriptions>
        {!canceled && <UseBalance minimal />}
        <Space wrap>
          {canceled ? (
            <Button loading={loading} onClick={resume}>
              Resume renewal
            </Button>
          ) : (
            <Popconfirm
              title="Cancel membership renewal?"
              description="Your current paid membership remains active until the date shown above."
              okButtonProps={{ danger: true, loading }}
              okText="Cancel renewal"
              onConfirm={cancel}
            >
              <Button danger loading={loading}>
                Cancel...
              </Button>
            </Popconfirm>
          )}
        </Space>
      </Space>
      <FreshAuthModal {...freshAuthModalProps} />
    </Card>
  );
}
