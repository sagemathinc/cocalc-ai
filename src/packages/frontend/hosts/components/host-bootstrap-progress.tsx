import { Tooltip, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { Host } from "@cocalc/conat/hub/api/hosts";

type HostBootstrapProgressProps = {
  host: Host;
  compact?: boolean;
};

export const HostBootstrapProgress: React.FC<HostBootstrapProgressProps> = ({
  host,
  compact = false,
}) => {
  if (host.deleted || host.status === "deprovisioned") {
    return null;
  }
  const message = `${host.bootstrap?.message ?? ""}`.trim();
  const status = `${host.bootstrap?.status ?? ""}`.trim().toLowerCase();
  if (!message) return null;
  if (status === "done" && host.status === "running") {
    return null;
  }
  const text = `Bootstrap: ${message}`;
  return (
    <Tooltip title={text}>
      <Typography.Text
        type={status === "error" ? "danger" : "secondary"}
        style={compact ? { fontSize: 12 } : undefined}
      >
        {text}
      </Typography.Text>
    </Tooltip>
  );
};
