/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";

import { App as AntdApp, Card, ConfigProvider, Layout, Typography } from "antd";
import { COLORS } from "@cocalc/util/theme";

const { Content } = Layout;
const { Paragraph, Text, Title } = Typography;

const PAGE_STYLE: CSSProperties = {
  minHeight: "100%",
  background: COLORS.GRAY_LLL,
} as const;

const CONTENT_STYLE: CSSProperties = {
  width: "min(1120px, 100%)",
  margin: "0 auto",
  padding: "32px 16px 56px",
} as const;

interface PublicPageRootProps {
  children: ReactNode;
  width?: CSSProperties["width"];
}

export function PublicPageRoot({ children, width }: PublicPageRootProps) {
  return (
    <ConfigProvider
      theme={{
        token: {
          borderRadius: 16,
          colorBgLayout: COLORS.GRAY_LLL,
          colorPrimary: COLORS.BLUE_D,
          colorText: COLORS.GRAY_D,
          colorTextSecondary: COLORS.GRAY_M,
        },
      }}
    >
      <AntdApp>
        <Layout style={PAGE_STYLE}>
          <Content
            style={{
              ...CONTENT_STYLE,
              width: width ?? CONTENT_STYLE.width,
            }}
          >
            {children}
          </Content>
        </Layout>
      </AntdApp>
    </ConfigProvider>
  );
}

interface PublicHeroProps {
  actions?: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  title: ReactNode;
}

export function PublicHero({
  actions,
  eyebrow,
  subtitle,
  title,
}: PublicHeroProps) {
  return (
    <Card
      variant="outlined"
      styles={{
        body: {
          display: "grid",
          gap: 14,
          boxShadow: "0 20px 40px rgba(0, 0, 0, 0.08)",
          padding: 28,
        },
      }}
    >
      {eyebrow ? <Text strong>{eyebrow}</Text> : null}
      <Title level={1} style={{ margin: 0 }}>
        {title}
      </Title>
      {subtitle ? (
        <Paragraph style={{ margin: 0, maxWidth: "70ch" }}>
          {subtitle}
        </Paragraph>
      ) : null}
      {actions}
    </Card>
  );
}

interface PublicSectionCardProps {
  children: ReactNode;
}

export function PublicSectionCard({ children }: PublicSectionCardProps) {
  return (
    <Card
      variant="outlined"
      styles={{
        body: {
          display: "grid",
          gap: 12,
        },
      }}
    >
      {children}
    </Card>
  );
}
