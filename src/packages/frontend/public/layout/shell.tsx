/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Children,
  isValidElement,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";

import {
  App as AntdApp,
  Button,
  Card,
  Col,
  ConfigProvider,
  Flex,
  Layout,
  Row,
  Space,
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
import {
  PUBLIC_COLORS,
  PUBLIC_DISPLAY_FONT_FAMILY,
} from "@cocalc/frontend/public/theme";
import { COMPANY_NAME } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import PublicTopNav, { type PublicTopNavActiveKey } from "./top-nav";

const { Content, Footer, Header, Sider } = Layout;
const { Paragraph, Text, Title } = Typography;
const PUBLIC_FONT_SIZE_STORAGE_KEY = "cocalc-public-font-size";
const PUBLIC_FONT_SIZE_DEFAULT = 16;
const PUBLIC_FONT_SIZE_MIN = 14;
const PUBLIC_FONT_SIZE_MAX = 24;

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
    color: ${PUBLIC_COLORS.accent} !important;
  }

  .cocalc-public-font-controls {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 1100;
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14);
    border-radius: 8px;
    overflow: hidden;
  }

  .cocalc-public-card.ant-card {
    border-color: ${PUBLIC_COLORS.border};
  }

  .cocalc-public-card.ant-card-hoverable:hover {
    border-color: ${PUBLIC_COLORS.brandSubtle};
  }

  .cocalc-public-card .ant-card-head {
    border-bottom-color: ${PUBLIC_COLORS.border};
  }

  .cocalc-public-card .ant-card-head-title {
    color: ${PUBLIC_COLORS.heading};
  }

  .cocalc-public-sider.ant-layout-sider {
    background: transparent;
    max-height: calc(100vh - var(--cocalc-public-anchor-offset));
    overflow: auto;
    overscroll-behavior: contain;
    position: sticky;
    top: var(--cocalc-public-anchor-offset);
  }

  @media print {
    .cocalc-public-header,
    .cocalc-public-footer-band,
    .cocalc-public-sider,
    .cocalc-public-font-controls {
      display: none !important;
    }

    .cocalc-public-main-band,
    .cocalc-public-content {
      background: white !important;
      padding: 0 !important;
    }
  }
`;

const PAGE_BAND_STYLE = {
  paddingInline: "max(16px, calc((100vw - 1200px) / 2))",
  width: "100%",
} as const;

function clampPublicFontSize(value: number): number {
  if (!Number.isFinite(value)) return PUBLIC_FONT_SIZE_DEFAULT;
  return Math.min(
    PUBLIC_FONT_SIZE_MAX,
    Math.max(PUBLIC_FONT_SIZE_MIN, Math.round(value)),
  );
}

function loadPublicFontSize(): number {
  if (typeof window === "undefined") return PUBLIC_FONT_SIZE_DEFAULT;
  const raw = window.localStorage.getItem(PUBLIC_FONT_SIZE_STORAGE_KEY);
  if (!raw) return PUBLIC_FONT_SIZE_DEFAULT;
  return clampPublicFontSize(Number(raw));
}

function savePublicFontSize(size: number): void {
  if (typeof window === "undefined") return;
  if (size === PUBLIC_FONT_SIZE_DEFAULT) {
    window.localStorage.removeItem(PUBLIC_FONT_SIZE_STORAGE_KEY);
  } else {
    window.localStorage.setItem(PUBLIC_FONT_SIZE_STORAGE_KEY, `${size}`);
  }
}

function PublicFontSizeControls({
  fontSize,
  setFontSize,
}: {
  fontSize: number;
  setFontSize: (size: number) => void;
}) {
  const decrease = () => setFontSize(clampPublicFontSize(fontSize - 1));
  const increase = () => setFontSize(clampPublicFontSize(fontSize + 1));
  const reset = () => setFontSize(PUBLIC_FONT_SIZE_DEFAULT);

  return (
    <Space.Compact
      className="cocalc-public-font-controls"
      size="small"
      style={{ background: "white" }}
    >
      <Button
        aria-label="Decrease public page font size"
        disabled={fontSize <= PUBLIC_FONT_SIZE_MIN}
        onClick={decrease}
        title="Decrease font size"
      >
        A-
      </Button>
      <Button aria-label="Reset public page font size" onClick={reset}>
        {fontSize}px
      </Button>
      <Button
        aria-label="Increase public page font size"
        disabled={fontSize >= PUBLIC_FONT_SIZE_MAX}
        onClick={increase}
        title="Increase font size"
      >
        A+
      </Button>
    </Space.Compact>
  );
}

interface FooterLinkSpec {
  href: string;
  label: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
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
  if (config?.cookie_banner_enabled) {
    companyLinks.push({
      href: "#cookie-preferences",
      label: "Cookies",
      onClick: (event) => {
        event.preventDefault();
        void Promise.all([
          import("@cocalc/frontend/cookie-consent/init"),
          import("@cocalc/frontend/cookie-consent"),
        ]).then(([{ initCookieConsent }, { showPreferences }]) => {
          initCookieConsent({
            enabled: true,
            textMarkdown: config.cookie_banner_text,
          });
          showPreferences();
        });
      },
    });
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
          href: appPath("docs"),
          label: "Documentation",
        },
        {
          href: appPath("guides"),
          label: "Guides",
        },
        { href: appPath("support"), label: "Support" },
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
          color: PUBLIC_COLORS.footerText,
          margin: 0,
          maxWidth: "34ch",
        }}
      >
        Collaborative computation, teaching, and technical work in one
        browser-based workspace.
      </Paragraph>
      {defaultBrand ? (
        <Text style={{ color: PUBLIC_COLORS.footerText }}>
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
      onClick={link.onClick}
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
                color: PUBLIC_COLORS.footerHeading,
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
  sider?: ReactNode;
  siderLabel?: string;
  title?: ReactNode;
}

export function PublicPage({
  active,
  beforeTitle,
  children,
  config,
  sider,
  siderLabel,
  title,
}: PublicPageProps) {
  const { token } = theme.useToken();
  const [publicFontSize, setPublicFontSizeState] = useState(
    PUBLIC_FONT_SIZE_DEFAULT,
  );
  const [siderHiddenByBreakpoint, setSiderHiddenByBreakpoint] = useState(false);
  const publicPageStyle = {
    "--cocalc-public-anchor-offset": `${token.Layout?.headerHeight ?? 64}px`,
    "--cocalc-public-font-size": `${publicFontSize}px`,
    fontSize: "var(--cocalc-public-font-size)",
    minHeight: "100vh",
  } as CSSProperties;

  useEffect(() => {
    setPublicFontSizeState(loadPublicFontSize());
  }, []);

  const setPublicFontSize = (size: number) => {
    const next = clampPublicFontSize(size);
    setPublicFontSizeState(next);
    savePublicFontSize(next);
  };

  return (
    <ConfigProvider
      theme={{
        token: {
          borderRadius: 16,
          colorBgLayout: PUBLIC_COLORS.pageBackground,
          colorBorder: PUBLIC_COLORS.border,
          colorBorderSecondary: PUBLIC_COLORS.border,
          colorInfo: PUBLIC_COLORS.brand,
          colorLink: PUBLIC_COLORS.link,
          colorLinkActive: PUBLIC_COLORS.brandActive,
          colorLinkHover: PUBLIC_COLORS.linkHover,
          colorPrimary: PUBLIC_COLORS.brand,
          colorPrimaryActive: PUBLIC_COLORS.brandActive,
          colorPrimaryHover: PUBLIC_COLORS.linkHover,
          colorText: PUBLIC_COLORS.text,
          colorTextHeading: PUBLIC_COLORS.heading,
          colorTextSecondary: PUBLIC_COLORS.mutedText,
          fontSize: publicFontSize,
        },
      }}
    >
      <PublicConfigProvider config={config}>
        <AntdApp>
          <style>{PUBLIC_PAGE_CSS}</style>
          <Layout className="cocalc-public-page" style={publicPageStyle}>
            <Header
              className="cocalc-public-header"
              style={{
                ...PAGE_BAND_STYLE,
                background: PUBLIC_COLORS.brandTint,
                position: "sticky",
                top: 0,
                zIndex: token.zIndexPopupBase,
              }}
            >
              <PublicTopNav active={active} />
            </Header>
            <Layout
              className="cocalc-public-main-band"
              hasSider={sider != null}
              style={{
                ...PAGE_BAND_STYLE,
                columnGap:
                  sider != null && !siderHiddenByBreakpoint
                    ? token.paddingSM
                    : undefined,
                paddingBottom: token.paddingXL,
              }}
            >
              {sider != null ? (
                <Sider
                  aria-label={siderLabel}
                  breakpoint="md"
                  className="cocalc-public-sider"
                  collapsedWidth={0}
                  onBreakpoint={setSiderHiddenByBreakpoint}
                  style={{
                    paddingInlineEnd: token.paddingSM,
                  }}
                  trigger={null}
                >
                  {sider}
                </Sider>
              ) : null}
              <Content className="cocalc-public-content">
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
                <Flex vertical gap="large">
                  {children}
                </Flex>
              </Content>
            </Layout>
            <Footer
              className="cocalc-public-footer-band"
              style={{
                ...PAGE_BAND_STYLE,
                background: PUBLIC_COLORS.footerBackground,
                color: token.colorWhite,
              }}
            >
              <PublicFooter config={config} />
            </Footer>
            <PublicFontSizeControls
              fontSize={publicFontSize}
              setFontSize={setPublicFontSize}
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
      <Flex vertical gap="middle">
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
        className="cocalc-public-card"
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
