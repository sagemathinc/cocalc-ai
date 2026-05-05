/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";

import { Card } from "antd";

import { COLORS } from "@cocalc/util/theme";

const PAGE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100%",
  padding: "40px 16px",
  background: COLORS.GRAY_LLL,
} as const;

interface PublicAuthPageShellProps {
  cardWidth?: CSSProperties["width"];
  children: ReactNode;
  subtitle?: ReactNode;
}

export default function PublicAuthPageShell({
  cardWidth,
  children,
  subtitle,
}: PublicAuthPageShellProps) {
  return (
    <div style={PAGE_STYLE}>
      <Card
        variant="outlined"
        style={{
          width: cardWidth ?? "min(480px, 96vw)",
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.08)",
        }}
        styles={{
          body: {
            display: "grid",
            gap: 12,
            padding: 32,
          },
        }}
      >
        {subtitle ? (
          <div style={{ margin: 0, color: COLORS.GRAY, fontSize: "15px" }}>
            {subtitle}
          </div>
        ) : null}
        <div>{children}</div>
      </Card>
    </div>
  );
}
