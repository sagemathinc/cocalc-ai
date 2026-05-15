/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Card, Typography } from "antd";
import type { CSSProperties, ReactNode } from "react";

import { Icon, IconName } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";

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
          borderColor: danger ? COLORS.BS_RED : undefined,
          boxShadow: "0 8px 28px rgba(15, 23, 42, 0.06)",
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
              color: danger ? COLORS.BS_RED : COLORS.GRAY_DD,
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
