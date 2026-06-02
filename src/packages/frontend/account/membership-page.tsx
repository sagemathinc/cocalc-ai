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
  Space,
  Tag,
  Table,
  Typography,
} from "antd";
import { useState } from "react";
import { defineMessage } from "react-intl";

import { Icon, Loading } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { labels } from "@cocalc/frontend/i18n";
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
      ? "Subscription"
      : membership.source === "grant"
        ? "Granted"
        : membership.source === "admin"
          ? "Admin assigned"
          : "Free";
  const expiresLabel =
    membership.source === "subscription" ? "Current period ends" : "Expires";
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
        {membership.subscription_id != null && (
          <Descriptions.Item label="Subscription id">
            {membership.subscription_id}
          </Descriptions.Item>
        )}
        {membership.expires && (
          <Descriptions.Item label={expiresLabel}>
            <TimeAgo date={membership.expires} />
          </Descriptions.Item>
        )}
      </Descriptions>

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
                <Text type="secondary">
                  No active subscriptions or admin assignments.
                </Text>
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
                    {
                      title: "Subscription id",
                      dataIndex: "subscription_id",
                      render: (value) => value ?? "-",
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
