import { Typography } from "antd";
import type { Host } from "@cocalc/conat/hub/api/hosts";

function formatProjectStatus(host: Host, compact: boolean): string | null {
  const status = host.backup_status;
  const assigned = status?.total ?? host.projects;
  const provisioned = status?.provisioned;
  const running = status?.running;
  const hasCounts =
    assigned != null || provisioned != null || running != null;
  if (!hasCounts) return null;
  const assignedVal = assigned ?? 0;
  const provisionedVal = provisioned ?? 0;
  const runningVal = running ?? 0;
  if (assignedVal === 0 && provisionedVal === 0 && runningVal === 0) {
    return null;
  }
  if (compact) {
    return `Projects ${assignedVal} assigned · ${provisionedVal} provisioned · ${runningVal} running`;
  }
  return `Projects: ${assignedVal} assigned · ${provisionedVal} provisioned · ${runningVal} running`;
}

export function HostProjectStatus({
  host,
  compact = false,
  fontSize = 11,
}: {
  host: Host;
  compact?: boolean;
  fontSize?: number;
}) {
  const label = formatProjectStatus(host, compact);
  if (!label) return null;
  return (
    <Typography.Text type="secondary" style={{ fontSize }}>
      {label}
    </Typography.Text>
  );
}
