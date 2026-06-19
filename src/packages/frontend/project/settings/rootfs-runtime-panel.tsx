/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Space } from "antd";

import { Icon } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";

export function RuntimePanel({
  children,
  icon,
  subtitle,
  title,
}: {
  children: ReactNode;
  icon: string;
  subtitle: ReactNode;
  title: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 12,
        padding: 14,
        background: "white",
      }}
    >
      <Space align="start" size={10} style={{ marginBottom: 12 }}>
        <div
          style={{
            alignItems: "center",
            background: COLORS.ANTD_BG_BLUE_L,
            borderRadius: 9,
            color: COLORS.ANTD_LINK_BLUE,
            display: "flex",
            height: 34,
            justifyContent: "center",
            width: 34,
          }}
        >
          <Icon name={icon as any} />
        </div>
        <div>
          <div style={{ fontWeight: 700 }}>{title}</div>
          <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>{subtitle}</div>
        </div>
      </Space>
      {children}
    </div>
  );
}

export function RuntimeAction({
  action,
  description,
  title,
}: {
  action: ReactNode;
  description: ReactNode;
  title: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        alignItems: "center",
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 10,
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        padding: "10px 12px",
      }}
    >
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>{description}</div>
      </div>
      {action ? (
        <div style={{ flex: "0 0 auto", marginLeft: "auto", maxWidth: "100%" }}>
          {action}
        </div>
      ) : null}
    </div>
  );
}
