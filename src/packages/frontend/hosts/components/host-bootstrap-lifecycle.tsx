import { Space, Tag, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import type {
  Host,
  HostBootstrapLifecycleItem,
  HostBootstrapLifecycleSummaryStatus,
} from "@cocalc/conat/hub/api/hosts";

type HostBootstrapLifecycleProps = {
  host: Host;
  compact?: boolean;
  detailed?: boolean;
};

function summaryTagColor(status?: HostBootstrapLifecycleSummaryStatus): string {
  if (status === "in_sync") return "green";
  if (status === "reconciling") return "blue";
  if (status === "drifted") return "orange";
  if (status === "error") return "red";
  return "default";
}

function summaryLabel(status?: string): string {
  if (status === "in_sync") return "software in sync";
  if (status === "reconciling") return "reconciling software";
  if (status === "drifted") return "software drift";
  if (status === "error") return "reconcile error";
  return "software status unknown";
}

function itemStatusColor(item: HostBootstrapLifecycleItem): string | undefined {
  if (item.status === "match" || item.status === "disabled") return "green";
  if (item.status === "drift") return "orange";
  if (item.status === "missing") return "red";
  return undefined;
}

function formatValue(
  value: string | boolean | number | null | undefined,
): string {
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (typeof value === "number") return String(value);
  if (value == null) return "n/a";
  return String(value);
}

function renderItemLine(item: HostBootstrapLifecycleItem) {
  return (
    <Space size="small" wrap>
      <Tag color={itemStatusColor(item)}>{item.label}</Tag>
      <Typography.Text type="secondary">
        desired <code>{formatValue(item.desired)}</code> · installed{" "}
        <code>{formatValue(item.installed)}</code>
      </Typography.Text>
      {item.message ? (
        <Typography.Text type="secondary">{item.message}</Typography.Text>
      ) : null}
    </Space>
  );
}

export const HostBootstrapLifecycle: React.FC<HostBootstrapLifecycleProps> = ({
  host,
  compact = false,
  detailed = false,
}) => {
  if (host.deleted || host.status === "deprovisioned") {
    return null;
  }
  const lifecycle = host.bootstrap_lifecycle;
  if (!lifecycle) return null;
  const driftItems = lifecycle.items.filter(
    (item) => item.status === "drift" || item.status === "missing",
  );
  const infoItems =
    driftItems.length > 0
      ? driftItems
      : lifecycle.items.slice(0, Math.min(3, lifecycle.items.length));

  if (!detailed) {
    return (
      <Space size={[6, 6]} wrap>
        <Tooltip title={lifecycle.summary_message}>
          <Tag color={summaryTagColor(lifecycle.summary_status)}>
            {summaryLabel(lifecycle.summary_status)}
          </Tag>
        </Tooltip>
        {lifecycle.drift_count > 0 && (
          <Tag color="orange">
            {lifecycle.drift_count} drift
            {lifecycle.drift_count === 1 ? " item" : " items"}
          </Tag>
        )}
        {!compact &&
          lifecycle.last_reconcile_result &&
          lifecycle.summary_status !== "reconciling" && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Last reconcile: {lifecycle.last_reconcile_result}
            </Typography.Text>
          )}
      </Space>
    );
  }

  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Typography.Text strong>Software lifecycle</Typography.Text>
      <Space size={[8, 8]} wrap>
        <Tag color={summaryTagColor(lifecycle.summary_status)}>
          {summaryLabel(lifecycle.summary_status)}
        </Tag>
        {lifecycle.drift_count > 0 && (
          <Tag color="orange">
            {lifecycle.drift_count} drift
            {lifecycle.drift_count === 1 ? " item" : " items"}
          </Tag>
        )}
        {lifecycle.current_operation === "reconcile" && (
          <Tag color="blue">reconcile running</Tag>
        )}
      </Space>
      {lifecycle.summary_message ? (
        <Typography.Text type="secondary">
          {lifecycle.summary_message}
        </Typography.Text>
      ) : null}
      {lifecycle.last_reconcile_finished_at &&
      lifecycle.last_reconcile_result ? (
        <Typography.Text type="secondary">
          Last reconcile: {lifecycle.last_reconcile_result} ·{" "}
          {new Date(lifecycle.last_reconcile_finished_at).toLocaleString()}
        </Typography.Text>
      ) : null}
      {lifecycle.last_error ? (
        <Typography.Text type="danger">
          Last error: {lifecycle.last_error}
        </Typography.Text>
      ) : null}
      <Space orientation="vertical" size={4} style={{ width: "100%" }}>
        {infoItems.map((item) => (
          <div key={item.key}>{renderItemLine(item)}</div>
        ))}
      </Space>
    </Space>
  );
};
