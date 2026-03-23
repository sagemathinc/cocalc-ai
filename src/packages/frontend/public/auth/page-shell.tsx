import type { ReactNode } from "react";
import { Card, Typography } from "antd";

import { React } from "@cocalc/frontend/app-framework";
import { COLORS } from "@cocalc/util/theme";

const PAGE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100%",
  padding: "40px 16px",
  background: COLORS.GRAY_LLL,
} as const;

const CARD_STYLE: React.CSSProperties = {
  width: "min(480px, 96vw)",
  borderRadius: "12px",
  border: `1px solid ${COLORS.GRAY_LL}`,
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.08)",
} as const;

const TITLE_STYLE: React.CSSProperties = {
  marginBottom: "12px",
} as const;

interface PublicAuthPageShellProps {
  children: ReactNode;
  subtitle?: ReactNode;
  title: ReactNode;
}

export default function PublicAuthPageShell({
  children,
  subtitle,
  title,
}: PublicAuthPageShellProps) {
  return (
    <div style={PAGE_STYLE}>
      <Card style={CARD_STYLE} bodyStyle={{ padding: "32px" }}>
        <Typography.Title level={3} style={TITLE_STYLE}>
          {title}
        </Typography.Title>
        {subtitle ? (
          <Typography.Text type="secondary">{subtitle}</Typography.Text>
        ) : null}
        <div style={{ marginTop: "24px" }}>{children}</div>
      </Card>
    </div>
  );
}
