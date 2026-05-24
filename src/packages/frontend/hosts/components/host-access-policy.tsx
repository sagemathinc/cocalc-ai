import { Card, Space, Tag, Typography } from "antd";
import type { Host } from "@cocalc/conat/hub/api/hosts";

export function hostAccessPolicyLabel(host: Pick<Host, "tier" | "scope">) {
  if (host.tier != null) {
    return `Shared pool tier ${host.tier}`;
  }
  if (host.scope === "owned") return "Private host";
  if (host.scope === "collab") return "Delegated host";
  return "Private dedicated host";
}

export function HostAccessPolicyTags({
  host,
}: {
  host: Pick<Host, "tier" | "scope" | "access_role">;
}) {
  return (
    <Space size={[4, 4]} wrap>
      {host.tier != null ? (
        <>
          <Tag color="blue">Shared pool</Tag>
          <Tag>Tier {host.tier}</Tag>
        </>
      ) : (
        <Tag>Private</Tag>
      )}
      {host.access_role && <Tag>Your role: {host.access_role}</Tag>}
    </Space>
  );
}

export function HostAccessPolicySummary({
  host,
  compact,
}: {
  host: Pick<Host, "tier" | "scope" | "access_role">;
  compact?: boolean;
}) {
  const shared = host.tier != null;
  const detail = shared
    ? `Any user with project host tier ${host.tier} or higher may place projects here.`
    : "Only the owner and delegated users can place projects here.";

  if (compact) {
    return (
      <Space orientation="vertical" size={2}>
        <HostAccessPolicyTags host={host} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {detail}
        </Typography.Text>
      </Space>
    );
  }

  return (
    <Card size="small" title={hostAccessPolicyLabel(host)}>
      <Space orientation="vertical" size="small">
        <HostAccessPolicyTags host={host} />
        <Typography.Text type="secondary">{detail}</Typography.Text>
      </Space>
    </Card>
  );
}
