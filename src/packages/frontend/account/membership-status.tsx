/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Divider,
  Space,
  Tag,
  Table,
  Typography,
} from "antd";
import { type ReactElement, useMemo, useState } from "react";
import { useIntl } from "react-intl";

import api from "@cocalc/frontend/client/api";
import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { Icon, Loading } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { useAsyncEffect, useTypedRedux } from "@cocalc/frontend/app-framework";
import { LLMUsageStatus } from "@cocalc/frontend/misc/llm-cost-estimation";
import { labels } from "@cocalc/frontend/i18n";
import { upgrades } from "@cocalc/util/upgrade-spec";
import { capitalize, round2 } from "@cocalc/util/misc";
import type {
  MembershipDetails,
  MembershipResolution,
} from "@cocalc/conat/hub/api/purchases";
import MembershipPurchaseModal from "./membership-purchase-modal";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const { Text } = Typography;

interface MembershipTier {
  id: string;
  label?: string;
  store_visible?: boolean;
  priority?: number;
  price_monthly?: number;
  price_yearly?: number;
  project_defaults?: Record<string, unknown>;
  llm_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  disabled?: boolean;
}

interface MembershipTiersResponse {
  tiers?: MembershipTier[];
}

const PROJECT_DEFAULT_KEYS = [
  "cores",
  "memory",
  "memory_request",
  "disk_quota",
  "mintime",
  "network",
  "member_host",
  "always_running",
  "cpu_shares",
] as const;

function normalizeRecord(value?: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function formatDurationHours(hours: number): string {
  if (!Number.isFinite(hours)) return "";
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} min`;
  }
  const rounded = Number.isInteger(hours) ? hours : round2(hours);
  return `${rounded} hour${rounded === 1 ? "" : "s"}`;
}

function formatQuotaValue(key: string, value: unknown): string {
  const spec = (upgrades as any).params?.[key];
  if (spec?.input_type === "checkbox") {
    return value ? "Included" : "Not included";
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(value);
  }
  const displayValue =
    spec?.display_factor != null ? value * spec.display_factor : value;
  if (key === "mintime") {
    return formatDurationHours(displayValue);
  }
  const rounded = Number.isInteger(displayValue)
    ? displayValue
    : round2(displayValue);
  const unit = spec?.display_unit ?? spec?.unit ?? "";
  return unit ? `${rounded} ${unit}` : `${rounded}`;
}

function extractLimit(
  limits: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = limits[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function formatFeatureTag(key: string, value: unknown): string | null {
  if (value == null || value === false) return null;
  const label = capitalize(key.replace(/_/g, " "));
  if (value === true) return label;
  return `${label}: ${value}`;
}

export function MembershipStatusPanel({
  showHeader = true,
}: {
  showHeader?: boolean;
}): ReactElement | null {
  const account_id = useTypedRedux("account", "account_id");
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const [membership, setMembership] = useState<MembershipResolution | null>(
    null,
  );
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [details, setDetails] = useState<MembershipDetails | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [purchaseOpen, setPurchaseOpen] = useState<boolean>(false);

  useAsyncEffect(
    async (isMounted) => {
      if (!account_id) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const [membershipResult, tiersResult, detailsResult] = await Promise.all([
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

  if (!account_id) {
    return null;
  }

  const handleChanged = () => {
    setRefreshToken((value) => value + 1);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("cocalc:membership-changed"));
    }
  };

  const tier = membership ? tierById[membership.class] : undefined;
  const tierLabel =
    tier?.label ?? (membership ? capitalize(membership.class) : "");
  const membershipSourceLabel =
    membership?.source === "subscription"
      ? "Subscription"
      : membership?.source === "admin"
        ? "Admin assigned"
        : "Free";
  const expiresLabel =
    membership?.source === "subscription" ? "Current period ends" : "Expires";
  const entitlements = normalizeRecord(membership?.entitlements);
  const projectDefaults = normalizeRecord(entitlements.project_defaults);
  const llmLimits = normalizeRecord(entitlements.llm_limits);
  const features = normalizeRecord(entitlements.features);
  const limit5h = extractLimit(llmLimits, ["units_5h", "limit_5h"]);
  const limit7d = extractLimit(llmLimits, ["units_7d", "limit_7d"]);
  const featureTags = Object.entries(features)
    .map(([key, value]) => formatFeatureTag(key, value))
    .filter((value): value is string => !!value);

  const candidateRows = useMemo(() => {
    const candidates = details?.candidates ?? [];
    return candidates.map((candidate) => {
      const selected =
        details?.selected.class === candidate.class &&
        details?.selected.source === candidate.source;
      const tierLabel = tierById[candidate.class]?.label ?? candidate.class;
      return {
        key: `${candidate.source}-${candidate.class}-${candidate.subscription_id ?? "admin"}`,
        tier: tierLabel,
        source: candidate.source === "subscription" ? "Subscription" : "Admin assigned",
        priority: candidate.priority,
        expires: candidate.expires,
        subscription_id: candidate.subscription_id,
        selected,
      };
    });
  }, [details, tierById]);

  const projectDefaultsItems = PROJECT_DEFAULT_KEYS.map((key) => {
    if (!(key in projectDefaults)) return null;
    const value = projectDefaults[key];
    const spec = (upgrades as any).params?.[key];
    const label = spec?.display ?? capitalize(key.replace(/_/g, " "));
    return {
      key,
      label,
      value: formatQuotaValue(key, value),
    };
  }).filter((item) => item != null) as Array<{
    key: string;
    label: string;
    value: string;
  }>;

  return (
    <Panel
      size="small"
      header={
        showHeader ? (
          <>
            <Icon name="user" /> Membership
          </>
        ) : undefined
      }
    >
      {loading && <Loading />}
      {error && !loading && <Alert type="error" message={error} />}
      {!loading && !error && membership && (
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

          <div>
            <Text strong>{projectLabel} defaults</Text>
            {projectDefaultsItems.length === 0 ? (
              <div>
                <Text type="secondary">
                  No {projectLabelLower} defaults configured.
                </Text>
              </div>
            ) : (
              <Descriptions
                size="small"
                column={1}
                style={{ marginTop: "6px" }}
              >
                {projectDefaultsItems.map((item) => (
                  <Descriptions.Item key={item.key} label={item.label}>
                    {item.value}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            )}
          </div>

          <div>
            <Text strong>LLM limits</Text>
            <Descriptions size="small" column={1} style={{ marginTop: "6px" }}>
              <Descriptions.Item label="5-hour window">
                {limit5h != null ? `${limit5h} units` : "No limit"}
              </Descriptions.Item>
              <Descriptions.Item label="7-day window">
                {limit7d != null ? `${limit7d} units` : "No limit"}
              </Descriptions.Item>
            </Descriptions>
            <div style={{ marginTop: "8px" }}>
              <LLMUsageStatus variant="full" showHelp={false} />
            </div>
          </div>

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
                          render: (value) => value ?? "—",
                        },
                      ]}
                    />
                  ),
              },
            ]}
          />
        </Space>
      )}
      <MembershipPurchaseModal
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
        onChanged={handleChanged}
      />
    </Panel>
  );
}
