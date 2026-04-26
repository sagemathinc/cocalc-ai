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
import { type ReactElement, useMemo, useRef, useState } from "react";
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
  MembershipUsageStatus,
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
  usage_limits?: Record<string, unknown>;
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

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatManagedEgressCategory(category: string): string {
  if (category === "file-download") return "File downloads";
  return capitalize(category.replace(/[-_]/g, " "));
}

export interface ProjectDefaultItem {
  key: string;
  label: string;
  value: string;
}

export function getProjectDefaultsItems(
  projectDefaults: Record<string, unknown>,
): ProjectDefaultItem[] {
  return PROJECT_DEFAULT_KEYS.map((key) => {
    if (!(key in projectDefaults)) return null;
    if (key === "member_host") return null;
    const value = projectDefaults[key];
    if (key === "cpu_shares" && typeof value === "number" && value <= 0) {
      return null;
    }
    const spec = (upgrades as any).params?.[key];
    const label =
      key === "cores"
        ? "CPU priority"
        : (spec?.display ?? capitalize(key.replace(/_/g, " ")));
    const formattedValue = formatQuotaValue(key, value);
    return {
      key,
      label,
      value:
        key === "cores"
          ? `${spec?.display ?? "Shared CPU"} - ${formattedValue}`
          : formattedValue,
    };
  }).filter((item) => item != null) as ProjectDefaultItem[];
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

export interface UsageLimitItem {
  key: string;
  label: string;
  value: string;
}

export interface UsageStatusItem {
  key: string;
  label: string;
  value: string;
  danger?: boolean;
}

function getUsageLimitsItems(
  usageLimits: Record<string, unknown>,
): UsageLimitItem[] {
  const items: UsageLimitItem[] = [];
  const computePriority = usageLimits.shared_compute_priority;
  if (typeof computePriority === "number" && Number.isFinite(computePriority)) {
    items.push({
      key: "shared_compute_priority",
      label: "Shared compute priority",
      value: `${computePriority}`,
    });
  }
  const totalSoft = usageLimits.total_storage_soft_bytes;
  if (typeof totalSoft === "number" && Number.isFinite(totalSoft)) {
    items.push({
      key: "total_storage_soft_bytes",
      label: "Total account storage soft cap",
      value: formatBytes(totalSoft),
    });
  }
  const totalHard = usageLimits.total_storage_hard_bytes;
  if (typeof totalHard === "number" && Number.isFinite(totalHard)) {
    items.push({
      key: "total_storage_hard_bytes",
      label: "Total account storage hard cap",
      value: formatBytes(totalHard),
    });
  }
  const maxProjects = usageLimits.max_projects;
  if (typeof maxProjects === "number" && Number.isFinite(maxProjects)) {
    items.push({
      key: "max_projects",
      label: "Max owned projects",
      value: `${maxProjects}`,
    });
  }
  const egress5h = usageLimits.egress_5h_bytes;
  if (typeof egress5h === "number" && Number.isFinite(egress5h)) {
    items.push({
      key: "egress_5h_bytes",
      label: "Data transfer 5-hour window",
      value: formatBytes(egress5h),
    });
  }
  const egress7d = usageLimits.egress_7d_bytes;
  if (typeof egress7d === "number" && Number.isFinite(egress7d)) {
    items.push({
      key: "egress_7d_bytes",
      label: "Data transfer 7-day window",
      value: formatBytes(egress7d),
    });
  }
  const egressPolicy = usageLimits.egress_policy;
  if (typeof egressPolicy === "string" && egressPolicy.length > 0) {
    items.push({
      key: "egress_policy",
      label: "Egress policy",
      value: egressPolicy,
    });
  }
  const dedicatedHostEgressPolicy = usageLimits.dedicated_host_egress_policy;
  if (
    typeof dedicatedHostEgressPolicy === "string" &&
    dedicatedHostEgressPolicy.length > 0
  ) {
    items.push({
      key: "dedicated_host_egress_policy",
      label: "Dedicated host egress policy",
      value: dedicatedHostEgressPolicy,
    });
  }
  return items;
}

function getUsageStatusItems(
  usageStatus?: MembershipUsageStatus | null,
): UsageStatusItem[] {
  if (!usageStatus) return [];
  const items: UsageStatusItem[] = [
    {
      key: "owned_project_count",
      label: "Owned projects",
      value: `${usageStatus.owned_project_count}`,
      danger: usageStatus.over_max_projects === true,
    },
    {
      key: "total_storage_bytes",
      label: "Current total account storage",
      value: formatBytes(usageStatus.total_storage_bytes),
      danger:
        usageStatus.over_total_storage_hard === true ||
        usageStatus.over_total_storage_soft === true,
    },
  ];
  if (
    typeof usageStatus.remaining_project_slots === "number" &&
    Number.isFinite(usageStatus.remaining_project_slots)
  ) {
    items.push({
      key: "remaining_project_slots",
      label: "Remaining project slots",
      value: `${usageStatus.remaining_project_slots}`,
      danger: usageStatus.remaining_project_slots < 0,
    });
  }
  if (
    typeof usageStatus.total_storage_soft_remaining_bytes === "number" &&
    Number.isFinite(usageStatus.total_storage_soft_remaining_bytes)
  ) {
    items.push({
      key: "total_storage_soft_remaining_bytes",
      label: "Storage remaining before soft cap",
      value: formatBytes(
        Math.abs(usageStatus.total_storage_soft_remaining_bytes),
      ),
      danger: usageStatus.total_storage_soft_remaining_bytes < 0,
    });
  }
  if (
    typeof usageStatus.total_storage_hard_remaining_bytes === "number" &&
    Number.isFinite(usageStatus.total_storage_hard_remaining_bytes)
  ) {
    items.push({
      key: "total_storage_hard_remaining_bytes",
      label: "Storage remaining before hard cap",
      value: formatBytes(
        Math.abs(usageStatus.total_storage_hard_remaining_bytes),
      ),
      danger: usageStatus.total_storage_hard_remaining_bytes < 0,
    });
  }
  items.push({
    key: "sampled_project_count",
    label: "Storage sampled from projects",
    value:
      usageStatus.unsampled_project_count > 0
        ? `${usageStatus.sampled_project_count} of ${usageStatus.owned_project_count}`
        : `${usageStatus.sampled_project_count}`,
    danger: usageStatus.unsampled_project_count > 0,
  });
  if (
    typeof usageStatus.measurement_error_count === "number" &&
    usageStatus.measurement_error_count > 0
  ) {
    items.push({
      key: "measurement_error_count",
      label: "Sampling errors",
      value: `${usageStatus.measurement_error_count}`,
      danger: true,
    });
  }
  if (
    typeof usageStatus.managed_egress_5h_bytes === "number" &&
    Number.isFinite(usageStatus.managed_egress_5h_bytes)
  ) {
    items.push({
      key: "managed_egress_5h_bytes",
      label: "Managed egress used in 5 hours",
      value: formatBytes(usageStatus.managed_egress_5h_bytes),
      danger: usageStatus.over_managed_egress_5h === true,
    });
  }
  if (
    typeof usageStatus.managed_egress_7d_bytes === "number" &&
    Number.isFinite(usageStatus.managed_egress_7d_bytes)
  ) {
    items.push({
      key: "managed_egress_7d_bytes",
      label: "Managed egress used in 7 days",
      value: formatBytes(usageStatus.managed_egress_7d_bytes),
      danger: usageStatus.over_managed_egress_7d === true,
    });
  }
  return items;
}

function getUsageStatusAlerts(
  usageStatus?: MembershipUsageStatus | null,
): Array<{
  key: string;
  type: "warning" | "error";
  title: string;
}> {
  if (!usageStatus) return [];
  const alerts: Array<{
    key: string;
    type: "warning" | "error";
    title: string;
  }> = [];
  if (usageStatus.over_total_storage_hard) {
    alerts.push({
      key: "over-hard-storage",
      type: "error",
      title:
        "Your account is over the hard total storage cap. Cloning and other storage-increasing operations may be blocked until you delete data or upgrade membership.",
    });
  } else if (usageStatus.over_total_storage_soft) {
    alerts.push({
      key: "over-soft-storage",
      type: "warning",
      title:
        "Your account is over the soft total storage cap. Storage-increasing operations may be degraded or blocked until you delete data or upgrade membership.",
    });
  }
  if (usageStatus.over_max_projects) {
    alerts.push({
      key: "over-max-projects",
      type: "warning",
      title:
        "Your account is over the owned project limit. Creating new projects is blocked until you delete a project or upgrade membership.",
    });
  }
  if (
    usageStatus.unsampled_project_count > 0 ||
    (usageStatus.measurement_error_count ?? 0) > 0
  ) {
    alerts.push({
      key: "partial-usage-measurement",
      type: "warning",
      title:
        "Current storage usage is only partially sampled from your projects, so totals may temporarily be incomplete.",
    });
  }
  if (usageStatus.over_managed_egress_5h) {
    alerts.push({
      key: "over-managed-egress-5h",
      type: "error",
      title:
        "Your account is over the managed-egress 5-hour window. Metered downloads may be blocked until this window resets.",
    });
  }
  if (usageStatus.over_managed_egress_7d) {
    alerts.push({
      key: "over-managed-egress-7d",
      type: "error",
      title:
        "Your account is over the managed-egress 7-day window. Metered downloads may be blocked until this window resets.",
    });
  }
  return alerts;
}

function renderManagedEgressBreakdown(
  label: string,
  breakdown?: Record<string, number>,
): ReactElement | null {
  if (!breakdown || Object.keys(breakdown).length === 0) {
    return null;
  }
  const entries = Object.entries(breakdown).filter(
    ([, value]) =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (entries.length === 0) return null;
  return (
    <Descriptions size="small" column={1} style={{ marginTop: "6px" }}>
      <Descriptions.Item label={label}>
        <Space wrap>
          {entries.map(([category, bytes]) => (
            <Tag key={category}>
              {formatManagedEgressCategory(category)}: {formatBytes(bytes)}
            </Tag>
          ))}
        </Space>
      </Descriptions.Item>
    </Descriptions>
  );
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
        key: `${candidate.source}-${candidate.class}-${candidate.subscription_id ?? "admin"}`,
        tier: tierLabel,
        source:
          candidate.source === "subscription"
            ? "Subscription"
            : "Admin assigned",
        priority: candidate.priority,
        expires: candidate.expires,
        subscription_id: candidate.subscription_id,
        selected,
      };
    });
  }, [details, tierById]);

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
  const usageLimits = normalizeRecord(entitlements.usage_limits);
  const limit5h = extractLimit(llmLimits, ["units_5h", "limit_5h"]);
  const limit7d = extractLimit(llmLimits, ["units_7d", "limit_7d"]);
  const featureTags = Object.entries(features)
    .map(([key, value]) => formatFeatureTag(key, value))
    .filter((value): value is string => !!value);

  const projectDefaultsItems = getProjectDefaultsItems(projectDefaults);
  const usageLimitItems = getUsageLimitsItems(usageLimits);
  const usageStatusItems = getUsageStatusItems(details?.usage_status);
  const usageStatusAlerts = getUsageStatusAlerts(details?.usage_status);

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
      {error && !loading && <Alert type="error" title={error} />}
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

          {usageStatusAlerts.map((alert) => (
            <Alert key={alert.key} type={alert.type} title={alert.title} />
          ))}

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

          <div>
            <Text strong>Shared-host usage limits</Text>
            {usageLimitItems.length === 0 ? (
              <div>
                <Text type="secondary">
                  No shared-host usage limits configured.
                </Text>
              </div>
            ) : (
              <Descriptions
                size="small"
                column={1}
                style={{ marginTop: "6px" }}
              >
                {usageLimitItems.map((item) => (
                  <Descriptions.Item key={item.key} label={item.label}>
                    {item.value}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            )}
          </div>

          <div>
            <Text strong>Current shared-host usage</Text>
            {usageStatusItems.length === 0 ? (
              <div>
                <Text type="secondary">
                  Current shared-host usage is unavailable.
                </Text>
              </div>
            ) : (
              <Descriptions
                size="small"
                column={1}
                style={{ marginTop: "6px" }}
              >
                {usageStatusItems.map((item) => (
                  <Descriptions.Item key={item.key} label={item.label}>
                    {item.danger ? (
                      <Text type="danger">{item.value}</Text>
                    ) : (
                      item.value
                    )}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            )}
            {renderManagedEgressBreakdown(
              "Managed egress by category (5 hours)",
              details?.usage_status?.managed_egress_categories_5h_bytes,
            )}
            {renderManagedEgressBreakdown(
              "Managed egress by category (7 days)",
              details?.usage_status?.managed_egress_categories_7d_bytes,
            )}
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
