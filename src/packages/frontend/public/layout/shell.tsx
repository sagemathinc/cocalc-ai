/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Children, isValidElement, type ReactNode } from "react";

import {
  App as AntdApp,
  Card,
  Col,
  ConfigProvider,
  Flex,
  Layout,
  Row,
  theme,
  Typography,
} from "antd";
import {
  PublicConfigProvider,
  type PublicConfig,
} from "@cocalc/frontend/public/config";
import { COLORS } from "@cocalc/util/theme";
import PublicTopNav, { type PublicTopNavActiveKey } from "./top-nav";

const { Content, Footer, Header } = Layout;
const { Paragraph, Text, Title } = Typography;

const PAGE_BAND_STYLE = {
  paddingInline: "max(16px, calc((100vw - 1200px) / 2))",
  width: "100%",
} as const;

interface PublicPageProps {
  active?: PublicTopNavActiveKey;
  beforeTitle?: ReactNode;
  children: ReactNode;
  config?: PublicConfig;
  title?: ReactNode;
}

export function PublicPage({
  active,
  beforeTitle,
  children,
  config,
  title,
}: PublicPageProps) {
  const { token } = theme.useToken();

  return (
    <ConfigProvider
      theme={{
        token: {
          borderRadius: 16,
          colorBgLayout: COLORS.GRAY_LLL,
          colorPrimary: COLORS.BLUE_D,
          colorText: COLORS.GRAY_D,
          colorTextSecondary: COLORS.GRAY_M,
          fontSize: 16,
        },
      }}
    >
      <PublicConfigProvider config={config}>
        <AntdApp>
          <Layout
            style={{
              minHeight: "100vh",
            }}
          >
            <Header
              style={{
                ...PAGE_BAND_STYLE,
                background: COLORS.BLUE_LLLL,
                height: "auto",
                lineHeight: "normal",
                paddingBlock: token.paddingXS,
                position: "sticky",
                top: 0,
                zIndex: token.zIndexPopupBase,
              }}
            >
              <PublicTopNav active={active} />
            </Header>
            <Content
              style={{
                ...PAGE_BAND_STYLE,
                paddingBlockEnd: 56,
              }}
            >
              {beforeTitle}
              {title != null ? (
                <Title
                  level={1}
                  style={{
                    textAlign: "center",
                  }}
                >
                  {title}
                </Title>
              ) : null}
              <Flex vertical gap="middle">
                {children}
              </Flex>
            </Content>
            <Footer
              style={{
                ...PAGE_BAND_STYLE,
              }}
            />
          </Layout>
        </AntdApp>
      </PublicConfigProvider>
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

interface PublicCardProps {
  children: ReactNode;
  href?: string;
  rel?: string;
  target?: HTMLAnchorElement["target"];
  title?: ReactNode;
}

export function PublicCard({
  children,
  href,
  rel,
  target,
  title,
}: PublicCardProps) {
  const card = (
    <Card
      hoverable={href != null}
      style={href != null ? { height: "100%" } : undefined}
      title={title}
      variant="outlined"
    >
      {children}
    </Card>
  );

  if (href == null) {
    return card;
  }

  return (
    <a
      href={href}
      rel={rel}
      style={{
        color: "inherit",
        display: "block",
        height: "100%",
        textDecoration: "none",
      }}
      target={target}
    >
      {card}
    </a>
  );
}

export function PublicGrid({
  children,
  columns,
}: {
  children: ReactNode;
  columns: 2 | 3;
}) {
  const childArray = Children.toArray(children);
  const xlSpan = columns === 3 ? 8 : 12;

  return (
    <Row gutter={[16, 16]}>
      {childArray.map((child, index) => (
        <Col
          key={isValidElement(child) && child.key != null ? child.key : index}
          md={12}
          xl={xlSpan}
          xs={24}
        >
          {child}
        </Col>
      ))}
    </Row>
  );
}
