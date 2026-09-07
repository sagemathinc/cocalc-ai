/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Badge, Card, Typography } from "antd";
import type { ReactNode } from "react";

import { Icon, IconName } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const { Text } = Typography;

export interface ProjectSettingsNavItem {
  id: string;
  icon: IconName;
  label: ReactNode;
  warning?: boolean;
  danger?: boolean;
}

export function ProjectSettingsSectionNav({
  items,
}: {
  items: ProjectSettingsNavItem[];
}) {
  return (
    <Card
      size="small"
      style={{
        position: "sticky",
        top: 16,
        border: `1px solid ${UI_COLORS.border}`,
        boxShadow: `0 8px 28px ${UI_COLORS.shadow}`,
      }}
      styles={{ body: { padding: 8 } }}
    >
      <Text
        type="secondary"
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.8,
          padding: "6px 8px 10px",
          textTransform: "uppercase",
        }}
      >
        Settings
      </Text>
      <nav aria-label="Project settings sections">
        {items.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            style={{
              alignItems: "center",
              borderRadius: 8,
              color: item.danger ? UI_COLORS.danger : UI_COLORS.text,
              display: "flex",
              gap: 9,
              marginBottom: 2,
              padding: "9px 8px",
              textDecoration: "none",
            }}
          >
            <Icon name={item.icon} />
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.warning && <Badge status="warning" />}
          </a>
        ))}
      </nav>
    </Card>
  );
}
