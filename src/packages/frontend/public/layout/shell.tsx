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
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PublicConfigProvider,
  type PublicConfig,
} from "@cocalc/frontend/public/config";
import { COLORS } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import PublicTopNav, { type PublicTopNavActiveKey } from "./top-nav";

const { Content, Footer, Header } = Layout;
const { Paragraph, Title } = Typography;

const PUBLIC_DISPLAY_FONT_FAMILY =
  '"Space Grotesk", "Helvetica Neue", Arial, sans-serif';
const PUBLIC_DISPLAY_FONT_URL = joinUrlPath(
  appBasePath,
  "public/fonts/space-grotesk/SpaceGrotesk-wght.woff2",
);
const PUBLIC_DISPLAY_FONT_CSS = `
  @font-face {
    font-family: "Space Grotesk";
    src: url("${PUBLIC_DISPLAY_FONT_URL}") format("woff2");
    font-style: normal;
    font-weight: 300 700;
    font-display: swap;
  }

  .cocalc-public-page h1,
  .cocalc-public-page h2,
  .cocalc-public-page h3,
  .cocalc-public-page h4,
  .cocalc-public-page .ant-card-head-title {
    font-family: ${PUBLIC_DISPLAY_FONT_FAMILY};
    letter-spacing: -0.02em;
  }
`;

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
          <style>{PUBLIC_DISPLAY_FONT_CSS}</style>
          <Layout
            className="cocalc-public-page"
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
  subtitle?: ReactNode;
  title: ReactNode;
}

export function PublicHero({ actions, subtitle, title }: PublicHeroProps) {
  return (
    <PublicSection>
      <Title level={1} style={{ margin: 0 }}>
        {title}
      </Title>
      {subtitle ? (
        <Paragraph style={{ margin: 0, maxWidth: "70ch" }}>
          {subtitle}
        </Paragraph>
      ) : null}
      {actions}
    </PublicSection>
  );
}

interface PublicSectionProps {
  children: ReactNode;
  intro?: ReactNode;
  title?: ReactNode;
}

export function PublicSection({ children, intro, title }: PublicSectionProps) {
  return (
    <section style={{ minWidth: 0 }}>
      <Flex vertical gap="small">
        {title != null ? (
          <Title level={2} style={{ margin: 0 }}>
            {title}
          </Title>
        ) : null}
        {intro != null ? (
          <Paragraph style={{ margin: 0, maxWidth: "70ch" }}>{intro}</Paragraph>
        ) : null}
        {children}
      </Flex>
    </section>
  );
}

interface PublicCardProps {
  children: ReactNode;
  href: string;
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
      <Card
        hoverable
        style={{ height: "100%" }}
        title={title}
        variant="outlined"
      >
        {children}
      </Card>
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
