/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Modal,
  Progress,
  Row,
  Space,
  Tag,
  Typography,
  theme,
} from "antd";
import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { defineMessage } from "react-intl";

import { Loading } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { ManagedEgressHistoryButton } from "@cocalc/frontend/purchases/managed-egress-history";
import { formatManagedEgressCategory } from "@cocalc/frontend/purchases/managed-egress-recent-events";
import type {
  AIUsageStatus,
  AIUsageWindowStatus,
  MembershipUsageStatus,
} from "@cocalc/conat/hub/api/purchases";
import { humanSize } from "@cocalc/util/misc";
import { useMembershipSettingsData } from "./membership-settings-data";
import {
  extractLimit,
  formatResetAt,
  getProgressPercent,
  getProjectDefaultsItems,
  normalizeRecord,
} from "./membership-settings-format";
import type { SettingsPageDefinition } from "./settings-page";
import { getUsageLimitsItems } from "./usage-limit-items";
import { getUsageStatusAlerts } from "./usage-status-alerts";
import type { UsageStatusAlert } from "./usage-status-alerts";
import {
  getUsageStatusItems,
  type UsageStatusItem,
} from "./usage-status-items";
import { openAccountSettings } from "./settings-routing";

const { Paragraph, Text } = Typography;

const GRID_COL_PROPS = {
  xs: 24,
  lg: 12,
  xl: 8,
  xxl: 6,
} as const;

const PROJECT_AND_STORAGE_LIMIT_KEYS = new Set([
  "total_storage_soft_bytes",
  "total_storage_hard_bytes",
  "max_projects",
  "max_snapshots_per_project",
  "max_backups_per_project",
]);

const ROOTFS_LIMIT_KEYS = new Set([
  "rootfs_count",
  "rootfs_total_storage_gb",
  "rootfs_max_storage_gb",
  "rootfs_oci_images",
]);

const SHARED_COMPUTE_LIMIT_KEYS = new Set(["shared_compute_priority"]);
const DATA_TRANSFER_LIMIT_KEYS = new Set([
  "egress_5h_bytes",
  "egress_7d_bytes",
]);

type DescriptionItem = {
  key: string;
  label: string;
  value: ReactNode;
};

type DashboardCard = {
  content: ReactNode;
  key: string;
  title: string;
};

type InfoItem = DescriptionItem & {
  danger?: boolean;
  progress?: {
    caption: string;
    current: number;
    limit: number;
  };
};

type UsageWindowRow = {
  key: string;
  label: string;
  limit?: number | null;
  loading?: boolean;
  unavailable?: boolean;
  used?: number;
};

function renderSectionLabel(label: string): ReactElement {
  return <Text type="secondary">{label}</Text>;
}

export const USAGE_LIMITS_SETTINGS_PAGE = {
  component: UsageLimitsPage,
  description: defineMessage({
    id: "account.settings.overview.usage-limits",
    defaultMessage:
      "Check account usage, limits, reset windows, and near-limit warnings.",
  }),
  icon: "tachometer-alt",
  key: "usage-limits",
  label: labels.usage_limits,
} satisfies SettingsPageDefinition;

export function UsageLimitsPage() {
  return (
    <>
      <Paragraph type="secondary">
        These limits come from your current membership and license grants.{" "}
        <a
          onClick={(event) => {
            event.preventDefault();
            openAccountSettings({ page: "membership" });
          }}
        >
          Review membership details.
        </a>
      </Paragraph>
      <UsageLimitsSettingsContent />
    </>
  );
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
  return renderInfoItems({
    items: [
      {
        key: label,
        label,
        value: (
          <Space wrap>
            {entries.map(([category, bytes]) => (
              <Tag key={category}>
                {formatManagedEgressCategory(category)}: {humanSize(bytes)}
              </Tag>
            ))}
          </Space>
        ),
      },
    ],
  });
}

function renderResetTimes({
  items,
}: {
  items: Array<{
    key: string;
    label: string;
    resetAt?: Date | string;
    resetIn?: string;
  }>;
}): ReactElement | null {
  const visibleItems = items.filter((item) => item.resetAt || item.resetIn);
  if (visibleItems.length === 0) return null;
  return renderInfoItems({
    items: visibleItems.map((item) => ({
      key: item.key,
      label: item.label,
      value: (
        <>
          {item.resetAt ? formatResetAt(item.resetAt) : "Unknown"}
          {item.resetIn ? (
            <Text type="secondary">{` · in ${item.resetIn}`}</Text>
          ) : null}
        </>
      ),
    })),
  });
}

function useAIUsageStatus(): {
  error: boolean;
  loading: boolean;
  status: AIUsageStatus | null;
} {
  const [status, setStatus] = useState<AIUsageStatus | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let canceled = false;
    async function load() {
      try {
        const result =
          await webapp_client.conat_client.hub.purchases.getAIUsage();
        if (!canceled) {
          setStatus(result);
          setError(false);
        }
      } catch {
        if (!canceled) {
          setStatus(null);
          setError(true);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, []);

  return { error, loading, status };
}

function formatUsagePercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

function getUsageWindowDisplay(row: UsageWindowRow): {
  danger: boolean;
  percent: number;
  title: string;
  value: ReactNode;
} {
  if (row.loading) {
    return {
      danger: false,
      percent: 0,
      title: `${row.label} is loading.`,
      value: <Text type="secondary">Loading…</Text>,
    };
  }
  if (row.unavailable) {
    return {
      danger: false,
      percent: 0,
      title: `${row.label} is unavailable.`,
      value: <Text type="secondary">Unavailable</Text>,
    };
  }
  if (typeof row.limit !== "number" || !Number.isFinite(row.limit)) {
    return {
      danger: false,
      percent: 0,
      title: `${row.label} has no configured limit.`,
      value: <Text type="secondary">No limit</Text>,
    };
  }
  if (row.limit <= 0) {
    return {
      danger: false,
      percent: 0,
      title: `${row.label} is not included in the current membership.`,
      value: <Text type="secondary">Not included</Text>,
    };
  }
  const used =
    typeof row.used === "number" && Number.isFinite(row.used) ? row.used : 0;
  const percent = (100 * used) / row.limit;
  return {
    danger: percent >= 100,
    percent: getProgressPercent(used, row.limit),
    title: `${row.label}: ${formatUsagePercent(percent)} used.`,
    value: formatUsagePercent(percent),
  };
}

function renderUsageWindowRows(rows: UsageWindowRow[]): ReactElement {
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      {rows.map((row) => {
        const display = getUsageWindowDisplay(row);
        return (
          <div key={row.key} title={display.title}>
            <Space direction="vertical" size={0} style={{ width: "100%" }}>
              <div>
                <Text type="secondary">{row.label}: </Text>
                {display.danger ? (
                  <Text type="danger">{display.value}</Text>
                ) : (
                  <Text>{display.value}</Text>
                )}
              </div>
              <Progress
                percent={display.percent}
                showInfo={false}
                size="small"
                status={display.danger ? "exception" : "normal"}
              />
            </Space>
          </div>
        );
      })}
    </Space>
  );
}

function findAIUsageWindow(
  status: AIUsageStatus | null,
  window: AIUsageWindowStatus["window"],
): AIUsageWindowStatus | undefined {
  return status?.windows.find((item) => item.window === window);
}

function AIAndCPUUsageContent({
  aiLimit5h,
  aiLimit7d,
  cpuLimit5h,
  cpuLimit7d,
  usageStatus,
}: {
  aiLimit5h?: number;
  aiLimit7d?: number;
  cpuLimit5h?: number;
  cpuLimit7d?: number;
  usageStatus?: MembershipUsageStatus | null;
}): ReactElement {
  const aiUsage = useAIUsageStatus();
  const ai5h = findAIUsageWindow(aiUsage.status, "5h");
  const ai7d = findAIUsageWindow(aiUsage.status, "7d");

  return renderUsageWindowRows([
    {
      key: "ai_5h",
      label: "AI 5-hour usage limit",
      limit: ai5h?.limit ?? aiLimit5h,
      loading: aiUsage.loading,
      unavailable: aiUsage.error,
      used: ai5h?.used,
    },
    {
      key: "ai_7d",
      label: "AI weekly usage limit",
      limit: ai7d?.limit ?? aiLimit7d,
      loading: aiUsage.loading,
      unavailable: aiUsage.error,
      used: ai7d?.used,
    },
    {
      key: "cpu_5h",
      label: "CPU 5-hour usage limit",
      limit: cpuLimit5h,
      used: usageStatus?.managed_cpu_5h_seconds,
    },
    {
      key: "cpu_7d",
      label: "CPU weekly usage limit",
      limit: cpuLimit7d,
      used: usageStatus?.managed_cpu_7d_seconds,
    },
  ]);
}

function renderManagedEgressResetTimes(
  usageStatus?: MembershipUsageStatus | null,
): ReactElement | null {
  if (!usageStatus) return null;
  return renderResetTimes({
    items: [
      {
        key: "5h",
        label: "Managed egress 5-hour next reset",
        resetAt: usageStatus.managed_egress_5h_reset_at,
        resetIn: usageStatus.managed_egress_5h_reset_in,
      },
      {
        key: "7d",
        label: "Managed egress 7-day next reset",
        resetAt: usageStatus.managed_egress_7d_reset_at,
        resetIn: usageStatus.managed_egress_7d_reset_in,
      },
    ],
  });
}

function isRootFSStatusItem(item: UsageStatusItem): boolean {
  return item.key.startsWith("rootfs_");
}

function isSharedComputeStatusItem(item: UsageStatusItem): boolean {
  return item.key.startsWith("managed_cpu_");
}

function isDataTransferStatusItem(item: UsageStatusItem): boolean {
  return item.key.startsWith("managed_egress_");
}

function isProjectAndStorageStatusItem(item: UsageStatusItem): boolean {
  return (
    !isRootFSStatusItem(item) &&
    !isSharedComputeStatusItem(item) &&
    !isDataTransferStatusItem(item)
  );
}

function filterItemsByKeys<T extends { key: string }>(
  items: T[],
  keys: Set<string>,
): T[] {
  return items.filter((item) => keys.has(item.key));
}

function isCategorizedLimitItem(item: InfoItem): boolean {
  return (
    PROJECT_AND_STORAGE_LIMIT_KEYS.has(item.key) ||
    ROOTFS_LIMIT_KEYS.has(item.key) ||
    SHARED_COMPUTE_LIMIT_KEYS.has(item.key) ||
    DATA_TRANSFER_LIMIT_KEYS.has(item.key)
  );
}

function renderInfoItems({
  emptyLabel,
  emptyValue,
  items,
  layout = "horizontal",
}: {
  emptyLabel?: string;
  emptyValue?: string;
  items: InfoItem[];
  layout?: "horizontal" | "vertical";
}): ReactElement | null {
  if (items.length === 0) {
    if (!emptyLabel || !emptyValue) return null;
    return renderInfoItems({
      items: [
        {
          key: "empty",
          label: emptyLabel,
          value: <Text type="secondary">{emptyValue}</Text>,
        },
      ],
    });
  }
  return (
    <Descriptions colon size="small" column={1} layout={layout}>
      {items.map((item) => (
        <Descriptions.Item key={item.key} label={item.label}>
          <Space direction="vertical" size={0} style={{ width: "100%" }}>
            {item.danger ? <Text type="danger">{item.value}</Text> : item.value}
            {item.progress ? (
              <>
                <Progress
                  percent={getProgressPercent(
                    item.progress.current,
                    item.progress.limit,
                  )}
                  showInfo={false}
                  size="small"
                  status={item.danger ? "exception" : "normal"}
                />
                <Text type="secondary">{item.progress.caption}</Text>
              </>
            ) : null}
          </Space>
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}

function renderInfoSection({
  emptyValue,
  items,
  label,
}: {
  emptyValue: string;
  items: InfoItem[];
  label: string;
}): ReactElement {
  if (items.length === 0) {
    return (
      renderInfoItems({
        emptyLabel: label,
        emptyValue,
        items,
      }) ?? <></>
    );
  }
  return (
    <Space direction="vertical" size={0} style={{ width: "100%" }}>
      {renderSectionLabel(label)}
      {renderInfoItems({ items })}
    </Space>
  );
}

function AdvancedProjectStorageDetailsButton({
  limitItems,
  usageItems,
}: {
  limitItems: InfoItem[];
  usageItems: InfoItem[];
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (limitItems.length === 0 && usageItems.length === 0) return null;
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        Advanced details
      </Button>
      <Modal
        title="Advanced project storage details"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={720}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {renderInfoSection({
            emptyValue: "Unavailable",
            items: usageItems,
            label: "RootFS usage",
          })}
          {renderInfoSection({
            emptyValue: "Not configured",
            items: limitItems,
            label: "RootFS limits",
          })}
        </Space>
      </Modal>
    </>
  );
}

function renderDashboardGrid({
  cards,
  gutter,
  headerBackgroundColor,
}: {
  cards: DashboardCard[];
  gutter: [number, number];
  headerBackgroundColor: string;
}): ReactElement {
  return (
    <Row align="stretch" gutter={gutter}>
      {cards.map((card) => (
        <Col key={card.key} style={{ display: "flex" }} {...GRID_COL_PROPS}>
          <Card
            size="small"
            title={card.title}
            style={{ height: "100%", width: "100%" }}
            styles={{ header: { backgroundColor: headerBackgroundColor } }}
          >
            {card.content}
          </Card>
        </Col>
      ))}
    </Row>
  );
}

function renderAlertsGrid({
  alerts,
  gutter,
}: {
  alerts: UsageStatusAlert[];
  gutter: [number, number];
}): ReactElement | null {
  if (alerts.length === 0) return null;
  return (
    <Row align="stretch" gutter={gutter}>
      {alerts.map((alert) => (
        <Col key={alert.key} style={{ display: "flex" }} {...GRID_COL_PROPS}>
          <Alert
            showIcon
            type={alert.type}
            title={alert.title}
            style={{ height: "100%", width: "100%" }}
          />
        </Col>
      ))}
    </Row>
  );
}

function UsageLimitsSettingsContent(): ReactElement | null {
  const { account_id, details, error, loading, membership } =
    useMembershipSettingsData();
  const { token } = theme.useToken();

  if (!account_id) return null;
  if (loading) return <Loading />;
  if (error) return <Alert type="error" title={error} />;
  if (!membership) return null;

  const entitlements = normalizeRecord(membership.entitlements);
  const projectDefaults = normalizeRecord(entitlements.project_defaults);
  const aiLimits = normalizeRecord(entitlements.ai_limits);
  const usageLimits = normalizeRecord(
    membership.effective_limits ?? entitlements.usage_limits,
  );
  const aiLimit5h = extractLimit(aiLimits, ["units_5h", "limit_5h"]);
  const aiLimit7d = extractLimit(aiLimits, ["units_7d", "limit_7d"]);
  const cpuLimit5h = extractLimit(usageLimits, ["cpu_5h_seconds"]);
  const cpuLimit7d = extractLimit(usageLimits, ["cpu_7d_seconds"]);
  const projectDefaultsItems = getProjectDefaultsItems(projectDefaults);
  const usageLimitItems = getUsageLimitsItems(usageLimits);
  const usageStatusItems = getUsageStatusItems(
    details?.usage_status,
    usageLimits,
  );
  const usageStatusAlerts = getUsageStatusAlerts(details?.usage_status);
  const gridGutter: [number, number] = [token.margin, token.margin];
  const projectAndStorageLimitItems = [
    ...filterItemsByKeys(usageLimitItems, PROJECT_AND_STORAGE_LIMIT_KEYS),
    ...usageLimitItems.filter((item) => !isCategorizedLimitItem(item)),
  ];
  const rootFSLimitItems = filterItemsByKeys(
    usageLimitItems,
    ROOTFS_LIMIT_KEYS,
  );
  const sharedComputeLimitItems = filterItemsByKeys(
    usageLimitItems,
    SHARED_COMPUTE_LIMIT_KEYS,
  );
  const dataTransferLimitItems = filterItemsByKeys(
    usageLimitItems,
    DATA_TRANSFER_LIMIT_KEYS,
  );
  const projectAndStorageStatusItems = usageStatusItems.filter(
    isProjectAndStorageStatusItem,
  );
  const rootFSStatusItems = usageStatusItems.filter(isRootFSStatusItem);
  const runtimeEnvironmentItems = [
    ...sharedComputeLimitItems,
    ...projectDefaultsItems,
  ];
  const dataTransferStatusItems = usageStatusItems.filter(
    isDataTransferStatusItem,
  );

  const cards: DashboardCard[] = [
    {
      key: "ai-cpu-usage",
      title: "AI and CPU usage",
      content: (
        <AIAndCPUUsageContent
          aiLimit5h={aiLimit5h}
          aiLimit7d={aiLimit7d}
          cpuLimit5h={cpuLimit5h}
          cpuLimit7d={cpuLimit7d}
          usageStatus={details?.usage_status}
        />
      ),
    },
    {
      key: "projects-storage",
      title: "Projects and storage",
      content: (
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          {renderInfoSection({
            emptyValue: "Unavailable",
            items: projectAndStorageStatusItems,
            label: "Usage",
          })}
          {renderInfoSection({
            emptyValue: "Not configured",
            items: projectAndStorageLimitItems,
            label: "Limits",
          })}
          <AdvancedProjectStorageDetailsButton
            limitItems={rootFSLimitItems}
            usageItems={rootFSStatusItems}
          />
        </Space>
      ),
    },
    {
      key: "runtime-environment",
      title: "Runtime environment",
      content: renderInfoItems({
        emptyLabel: "Environment",
        emptyValue: "Not configured",
        items: runtimeEnvironmentItems,
      }),
    },
    {
      key: "data-transfer",
      title: "Network transfer",
      content: (
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          {renderInfoSection({
            emptyValue: "Unavailable",
            items: dataTransferStatusItems,
            label: "Usage",
          })}
          {renderInfoSection({
            emptyValue: "Not configured",
            items: dataTransferLimitItems,
            label: "Limits",
          })}
          {renderManagedEgressBreakdown(
            "Managed egress by category (5 hours)",
            details?.usage_status?.managed_egress_categories_5h_bytes,
          )}
          {renderManagedEgressBreakdown(
            "Managed egress by category (7 days)",
            details?.usage_status?.managed_egress_categories_7d_bytes,
          )}
          {renderManagedEgressResetTimes(details?.usage_status)}
          <ManagedEgressHistoryButton buttonText="History" size="small" />
        </Space>
      ),
    },
  ];

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {renderAlertsGrid({ alerts: usageStatusAlerts, gutter: gridGutter })}
      {renderDashboardGrid({
        cards,
        gutter: gridGutter,
        headerBackgroundColor: token.colorInfoBg,
      })}
    </Space>
  );
}
