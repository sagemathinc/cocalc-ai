/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";

import { Card } from "antd";

import { UI_COLORS } from "@cocalc/util/appearance-palette";

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
    <Card
      variant="outlined"
      style={{
        marginInline: "auto",
        width: cardWidth ?? "min(480px, 96vw)",
        maxWidth: "100%",
        minWidth: 0,
        boxShadow: `0 12px 32px ${UI_COLORS.shadow}`,
      }}
      styles={{
        body: {
          display: "grid",
          gap: 12,
          padding: 32,
          minWidth: 0,
        },
      }}
    >
      {subtitle ? (
        <div
          style={{ margin: 0, color: UI_COLORS.secondary, fontSize: "15px" }}
        >
          {subtitle}
        </div>
      ) : null}
      <div>{children}</div>
    </Card>
  );
}
