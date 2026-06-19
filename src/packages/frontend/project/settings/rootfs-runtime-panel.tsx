/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

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
        boxSizing: "border-box",
        padding: 14,
        background: "white",
        maxWidth: "100%",
        minWidth: 0,
        width: "100%",
      }}
    >
      <div
        style={{
          alignItems: "flex-start",
          display: "flex",
          gap: 10,
          marginBottom: 12,
          minWidth: 0,
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: COLORS.ANTD_BG_BLUE_L,
            borderRadius: 9,
            color: COLORS.ANTD_LINK_BLUE,
            display: "flex",
            flex: "0 0 auto",
            height: 34,
            justifyContent: "center",
            width: 34,
          }}
        >
          <Icon name={icon as any} />
        </div>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{title}</div>
          <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>{subtitle}</div>
        </div>
      </div>
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
        boxSizing: "border-box",
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        minWidth: 0,
        padding: "10px 12px",
        width: "100%",
      }}
    >
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{title}</div>
        <div
          style={{
            color: COLORS.GRAY_M,
            fontSize: 12,
            overflowWrap: "anywhere",
          }}
        >
          {description}
        </div>
      </div>
      {action ? (
        <div
          style={{
            display: "flex",
            flex: "0 1 auto",
            justifyContent: "flex-end",
            marginLeft: "auto",
            maxWidth: "100%",
            minWidth: 0,
          }}
        >
          {action}
        </div>
      ) : null}
    </div>
  );
}
