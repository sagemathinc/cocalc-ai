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
  arePublicPoliciesVisible,
  COCALC_WORDMARK_WHITE_URL,
  getExternalPoliciesUrl,
  getLogoSquare,
  getSiteName,
  PublicConfigProvider,
  type PublicConfig,
  usesDefaultCoCalcBranding,
} from "@cocalc/frontend/public/config";
import { COLORS, COMPANY_NAME, DOC_URL } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import PublicTopNav, { type PublicTopNavActiveKey } from "./top-nav";

const { Content, Footer, Header } = Layout;
const { Paragraph, Text, Title } = Typography;

const PUBLIC_DISPLAY_FONT_FAMILY =
  '"Space Grotesk", "Helvetica Neue", Arial, sans-serif';
const PUBLIC_DISPLAY_FONT_URL = joinUrlPath(
  appBasePath,
  "public/fonts/space-grotesk/SpaceGrotesk-wght.woff2",
);
const PUBLIC_PAGE_CSS = `
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

  .cocalc-public-footer a:hover {
    color: ${COLORS.YELL_L} !important;
  }
`;

const PAGE_BAND_STYLE = {
  paddingInline: "max(16px, calc((100vw - 1200px) / 2))",
  width: "100%",
} as const;

interface FooterLinkSpec {
  href: string;
  label: string;
  rel?: string;
  target?: HTMLAnchorElement["target"];
}

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function getPoliciesFooterLink(
  config?: PublicConfig,
): FooterLinkSpec | undefined {
  const externalPoliciesUrl = getExternalPoliciesUrl(config);
  if (externalPoliciesUrl) {
    return {
      href: externalPoliciesUrl,
      label: "Policies",
      rel: "noreferrer",
      target: "_blank",
    };
  }
  if (arePublicPoliciesVisible(config)) {
    return { href: appPath("policies"), label: "Policies" };
  }
}

function getFooterColumns(config?: PublicConfig) {
  const contactHref = config?.help_email?.trim()
    ? `mailto:${config.help_email.trim()}`
    : appPath("support");
  const companyLinks: FooterLinkSpec[] = [
    { href: appPath("about"), label: "About" },
    { href: contactHref, label: "Contact" },
  ];
  const policiesLink = getPoliciesFooterLink(config);
  if (policiesLink) {
    companyLinks.push(policiesLink);
  }

  return [
    {
      links: [
        { href: appPath("features"), label: "Features" },
        { href: appPath("products"), label: "Products" },
        { href: appPath("pricing"), label: "Pricing" },
      ],
      title: "Platform",
    },
    {
      links: [
        {
          href: DOC_URL,
          label: "Documentation",
          rel: "noreferrer",
          target: "_blank" as const,
        },
        { href: appPath("support"), label: "Support" },
        { href: appPath("support/status"), label: "Status" },
      ],
      title: "Resources",
    },
    {
      links: companyLinks,
      title: "Company",
    },
  ];
}

function FooterBrand({ config }: { config?: PublicConfig }) {
  const { token } = theme.useToken();
  const defaultBrand = usesDefaultCoCalcBranding(config);
  const siteName = getSiteName(config);

  return (
    <Flex vertical gap="middle">
      <a
        aria-label={`${siteName} home`}
        href={appPath("")}
        style={{
          alignItems: "center",
          color: token.colorWhite,
          display: "flex",
          flexWrap: "wrap",
          gap: token.marginXS,
          textDecoration: "none",
        }}
      >
        <img
          alt=""
          aria-hidden="true"
          src={getLogoSquare(config)}
          style={{
            display: "block",
            height: token.sizeXL,
            objectFit: "contain",
            width: token.sizeXL,
          }}
        />
        {defaultBrand ? (
          <img
            alt=""
            aria-hidden="true"
            src={COCALC_WORDMARK_WHITE_URL}
            style={{
              display: "block",
              height: token.fontSizeHeading4,
              objectFit: "contain",
              width: "auto",
            }}
          />
        ) : (
          <Text
            strong
            style={{
              color: token.colorWhite,
              fontFamily: PUBLIC_DISPLAY_FONT_FAMILY,
              fontSize: token.fontSizeHeading4,
              letterSpacing: "-0.02em",
            }}
          >
            {siteName}
          </Text>
        )}
      </a>
      <Paragraph
        style={{
          color: COLORS.BLUE_LLL,
          margin: 0,
          maxWidth: "34ch",
        }}
      >
        Collaborative computation, teaching, and technical work in one
        browser-based workspace.
      </Paragraph>
      {defaultBrand ? (
        <Text style={{ color: COLORS.BLUE_LLL }}>
          © {new Date().getFullYear()} {COMPANY_NAME}
        </Text>
      ) : null}
    </Flex>
  );
}

function FooterLink({ link }: { link: FooterLinkSpec }) {
  const { token } = theme.useToken();

  return (
    <a
      href={link.href}
      rel={link.rel}
      style={{
        color: token.colorWhite,
        display: "inline-block",
        textDecoration: "none",
      }}
      target={link.target}
    >
      {link.label}
    </a>
  );
}

function PublicFooter({ config }: { config?: PublicConfig }) {
  const { token } = theme.useToken();

  return (
    <Row
      className="cocalc-public-footer"
      gutter={[token.marginXL, token.marginXL]}
    >
      <Col lg={9} xs={24}>
        <FooterBrand config={config} />
      </Col>
      {getFooterColumns(config).map((column) => (
        <Col key={column.title} lg={5} sm={8} xs={24}>
          <Flex vertical gap="small">
            <Text
              strong
              style={{
                color: COLORS.YELL_L,
                fontFamily: PUBLIC_DISPLAY_FONT_FAMILY,
                fontSize: token.fontSizeLG,
              }}
            >
              {column.title}
            </Text>
            <nav aria-label={`${column.title} footer links`}>
              <Flex vertical gap="small">
                {column.links.map((link) => (
                  <FooterLink key={`${link.label}-${link.href}`} link={link} />
                ))}
              </Flex>
            </nav>
          </Flex>
        </Col>
      ))}
    </Row>
  );
}

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
          <style>{PUBLIC_PAGE_CSS}</style>
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
                background: COLORS.BLUE_DDD,
                color: token.colorWhite,
                paddingBlock: token.paddingXL,
              }}
            >
              <PublicFooter config={config} />
            </Footer>
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
