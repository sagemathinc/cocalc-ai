/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Card, Typography } from "antd";
import type { CSSProperties, ReactNode } from "react";

import { Icon, IconName } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const { Text, Title } = Typography;

interface Props {
  id: string;
  icon: IconName;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  danger?: boolean;
  style?: CSSProperties;
}

export function ProjectSettingsSectionCard({
  id,
  icon,
  title,
  description,
  children,
  danger,
  style,
}: Props) {
  return (
    <section id={id} style={{ scrollMarginTop: 24, ...style }}>
      <Card
        style={{
          borderColor: danger ? UI_COLORS.danger : undefined,
          boxShadow: `0 8px 28px ${UI_COLORS.shadow}`,
        }}
        styles={{ body: { padding: 20 } }}
      >
        <div style={{ marginBottom: 16 }}>
          <Title
            level={3}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: 0,
              color: danger ? UI_COLORS.danger : UI_COLORS.text,
            }}
          >
            <Icon name={icon} /> {title}
          </Title>
          {description && (
            <Text type="secondary" style={{ display: "block", marginTop: 6 }}>
              {description}
            </Text>
          )}
        </div>
        {children}
      </Card>
    </section>
  );
}
