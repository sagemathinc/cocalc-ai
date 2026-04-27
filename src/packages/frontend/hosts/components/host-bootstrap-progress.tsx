import { Space, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { HostErrorDetails } from "./host-error-details";

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
  const fullText = `Bootstrap: ${message}`;
  const errorLabel = "Bootstrap failed";
  if (compact && status === "error") {
    return (
      <Space size={6} wrap>
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {errorLabel}
        </Typography.Text>
        <HostErrorDetails
          variant="popover"
          title="Bootstrap error"
          message={fullText}
          buttonLabel="Details"
        />
      </Space>
    );
  }
  if (status === "error") {
    return (
      <Space orientation="vertical" size={4} style={{ width: "100%" }}>
        <Typography.Text type="danger">{errorLabel}</Typography.Text>
        <HostErrorDetails message={fullText} maxHeight={220} />
      </Space>
    );
  }
  return (
    <Typography.Text
      type="secondary"
      style={compact ? { fontSize: 12 } : undefined}
    >
      {fullText}
    </Typography.Text>
  );
};
