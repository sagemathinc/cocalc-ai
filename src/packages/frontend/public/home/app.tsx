/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect } from "react";
import { Button, Flex, Typography } from "antd";
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  getPublicMarketingConfig,
  getPublicMarketingSiteName,
  type PublicConfig,
} from "@cocalc/frontend/public/config";
import { PublicPage } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import {
  PUBLIC_HOME_CONTENT,
  getPublicHomeContent,
  isPublicHomeLinkAvailable,
} from "@cocalc/util/public-home-content";
import { joinUrlPath } from "@cocalc/util/url-path";
import { builtinPolicyPath } from "../common";

const { Paragraph, Text, Title } = Typography;
const HERO_IMAGE_URL = appPath(PUBLIC_HOME_CONTENT.hero.example.image);
const DASHBOARD_GUIDE_URL = appPath(
  PUBLIC_HOME_CONTENT.hero.example.guide.href,
);
const PUBLIC_PAGE_GUTTER = "max(16px, calc((100vw - 1200px) / 2))";

const HOME_PAGE_CSS = `
.cocalc-public-home { color: ${PUBLIC_COLORS.text}; }
.cocalc-public-home > section { scroll-margin-top: 80px; }
.cocalc-public-home-hero-visual {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px;
  padding: clamp(16px, 3vw, 32px); background: ${PUBLIC_COLORS.surface};
  border-top: 3px solid ${PUBLIC_COLORS.accent};
}
.cocalc-public-home-hero-visual figcaption {
  display: flex; align-items: center; justify-content: space-between; gap: 24px;
}
.cocalc-public-home-hero-image { max-width: 100%; }
.cocalc-public-home-grid {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px;
  margin-top: 24px;
}
.cocalc-public-home-hosting-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cocalc-public-home-card { border-top: 1px solid ${PUBLIC_COLORS.border}; padding: 24px 0; min-width: 0; }
a.cocalc-public-home-card { color: inherit; text-decoration: none; }
a.cocalc-public-home-card:hover h3 { color: ${PUBLIC_COLORS.linkHover}; }
.cocalc-public-home a:focus-visible { outline: 3px solid ${PUBLIC_COLORS.link}; outline-offset: 5px; }
.cocalc-public-home-final { background: ${PUBLIC_COLORS.surface}; border-top: 3px solid ${PUBLIC_COLORS.accent}; padding: clamp(20px, 4vw, 40px); }
@media (max-width: 760px) {
  .cocalc-public-home-hero-visual figcaption { align-items: flex-start; flex-direction: column; }
  .cocalc-public-home-grid { grid-template-columns: minmax(0, 1fr); gap: 0; }
}
@media (max-width: 560px) {
  .cocalc-public-home-hero-title { font-size: 38px !important; }
  .cocalc-public-home-actions .ant-btn, .cocalc-public-home-final-actions .ant-btn { width: 100%; }
}
`;

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <Text
      strong
      style={{
        color: PUBLIC_COLORS.linkHover,
        display: "block",
        fontSize: 12,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}
function DecorativeButtonIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex" }}>
      <Icon name={name} />
    </span>
  );
}
function SectionIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div style={{ maxWidth: 760 }}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <Title level={2} style={{ margin: "8px 0 12px" }}>
        {title}
      </Title>
      {description && (
        <Paragraph style={{ fontSize: 18, margin: 0 }}>{description}</Paragraph>
      )}
    </div>
  );
}
function CardText({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <>
      <Title
        level={3}
        style={{ fontSize: 22, lineHeight: 1.3, margin: "0 0 10px" }}
      >
        {title}
      </Title>
      <Paragraph style={{ margin: "0 0 16px", fontSize: 17 }}>
        {description}
      </Paragraph>
    </>
  );
}
function Hero({
  content,
  authenticated,
  showDashboardGuide,
  siteName,
}: {
  content: ReturnType<typeof getPublicHomeContent>;
  authenticated: boolean;
  showDashboardGuide: boolean;
  siteName: string;
}) {
  return (
    <section
      aria-label={`${siteName} hero`}
      className="cocalc-public-home-hero"
      style={{
        display: "grid",
        gap: 36,
        padding: "48px 0 12px",
      }}
    >
      <Flex vertical gap={24} style={{ maxWidth: 1040 }}>
        <Eyebrow>{content.hero.eyebrow}</Eyebrow>
        <div>
          <Title
            className="cocalc-public-home-hero-title"
            level={1}
            style={{
              color: PUBLIC_COLORS.heading,
              fontSize: 64,
              fontWeight: 500,
              letterSpacing: "-0.04em",
              lineHeight: 1.06,
              margin: 0,
              maxWidth: 1040,
            }}
          >
            {content.hero.title}
          </Title>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.text,
              fontSize: 19,
              lineHeight: 1.65,
              margin: "24px 0 0",
              maxWidth: 620,
            }}
          >
            {content.hero.description}
          </Paragraph>
        </div>
        <Flex className="cocalc-public-home-actions" gap={12} wrap>
          <Button
            href={appPath(authenticated ? "projects" : content.hero.startHref)}
            icon={
              <DecorativeButtonIcon
                name={authenticated ? "project-outlined" : "rocket"}
              />
            }
            size="large"
            type="primary"
          >
            {authenticated
              ? content.hero.returningLabel
              : content.hero.startLabel}
          </Button>
          <Button
            href={appPath(content.hero.secondary.href)}
            size="large"
            type="text"
          >
            {content.hero.secondary.label}
          </Button>
        </Flex>
      </Flex>
      {content.showExample && (
        <figure
          className="cocalc-public-home-hero-visual"
          style={{ margin: 0 }}
        >
          <figcaption>
            <div style={{ maxWidth: 650 }}>
              <Text
                strong
                style={{ fontSize: 24, color: PUBLIC_COLORS.heading }}
              >
                {content.hero.example.title}
              </Text>
              <Paragraph style={{ margin: "8px 0 0", fontSize: 16 }}>
                {content.hero.example.description}
              </Paragraph>
            </div>
            <Flex vertical gap={8} style={{ flexShrink: 0 }}>
              {showDashboardGuide && (
                <Button href={DASHBOARD_GUIDE_URL}>
                  {content.hero.example.guide.label}
                </Button>
              )}
              <a
                href={HERO_IMAGE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {content.hero.example.fullSizeLabel}
              </a>
            </Flex>
          </figcaption>
          <img
            alt={content.hero.example.alt}
            className="cocalc-public-home-hero-image"
            decoding="async"
            width={content.hero.example.width}
            height={content.hero.example.height}
            src={HERO_IMAGE_URL}
            style={{
              aspectRatio: "1512 / 760",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 4,
              display: "block",
              height: "auto",
              objectFit: "cover",
              objectPosition: "center",
              width: "100%",
            }}
          />
        </figure>
      )}
    </section>
  );
}

export default function PublicHomeApp({ config }: { config?: PublicConfig }) {
  const siteName = getPublicMarketingSiteName(config);
  const content = getPublicHomeContent(config?.cocalc_product);
  const authenticated =
    config?.cocalc_product !== "plus" && !!config?.is_authenticated;
  const trustHref = builtinPolicyPath(config, "trust");
  const visibleLink = (href: string) =>
    isPublicHomeLinkAvailable(href, config?.cocalc_product);
  useEffect(() => {
    document.title = siteName;
  }, [siteName]);
  return (
    <PublicPage active="home" config={getPublicMarketingConfig(config)}>
      <style>{HOME_PAGE_CSS}</style>
      <div
        className="cocalc-public-home"
        style={{
          display: "grid",
          gap: 40,
          marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
          paddingInline: PUBLIC_PAGE_GUTTER,
        }}
      >
        <Hero
          content={content}
          siteName={siteName}
          authenticated={authenticated}
          showDashboardGuide={visibleLink(content.hero.example.guide.href)}
        />
        <section aria-label="Why CoCalc" style={{ padding: "28px 0" }}>
          <SectionIntro {...content.benefits} />
          <div className="cocalc-public-home-grid">
            {content.benefits.cards.map((card) => (
              <div key={card.title} className="cocalc-public-home-card">
                <CardText {...card} />
              </div>
            ))}
          </div>
          <a href={appPath(content.benefits.link.href)}>
            {content.benefits.link.label}
          </a>
        </section>
        <section aria-label="Ways to use CoCalc" style={{ padding: "20px 0" }}>
          <SectionIntro {...content.workflows} />
          <div className="cocalc-public-home-grid">
            {content.workflows.cards.map((card) => {
              const link = visibleLink(card.link.href)
                ? card.link
                : content.workflows.fallbackLink;
              return (
                <a
                  key={card.title}
                  className="cocalc-public-home-card"
                  href={appPath(link.href)}
                >
                  <CardText {...card} />
                  <Text style={{ color: PUBLIC_COLORS.link }}>
                    {link.label}
                  </Text>
                </a>
              );
            })}
          </div>
          <a href={appPath(content.workflows.link.href)}>
            {content.workflows.link.label}
          </a>
        </section>
        {content.showHosting && (
          <section
            aria-label="Choose how to run CoCalc"
            style={{ padding: "20px 0" }}
          >
            <SectionIntro {...content.hosting} />
            <div className="cocalc-public-home-grid cocalc-public-home-hosting-grid">
              {content.hosting.cards.map((card) => (
                <div key={card.title} className="cocalc-public-home-card">
                  <CardText {...card} />
                  <Flex gap={18} wrap>
                    {card.links
                      .filter((link) => visibleLink(link.href))
                      .map((link) => (
                        <a key={link.href} href={appPath(link.href)}>
                          {link.label}
                        </a>
                      ))}
                  </Flex>
                </div>
              ))}
            </div>
          </section>
        )}
        <section aria-label="Next step" className="cocalc-public-home-final">
          <SectionIntro
            eyebrow={content.closing.eyebrow}
            title={content.closing.title}
            description={
              authenticated
                ? content.closing.returningDescription
                : content.closing.description
            }
          />
          <Flex
            gap={12}
            wrap
            className="cocalc-public-home-final-actions"
            style={{ marginTop: 24 }}
          >
            <Button
              type="primary"
              href={appPath(
                authenticated ? "projects" : content.hero.startHref,
              )}
            >
              {authenticated
                ? content.hero.returningLabel
                : content.hero.startLabel}
            </Button>
            <Button href={appPath(content.closing.contact.href)}>
              {content.closing.contact.label}
            </Button>
          </Flex>
          {trustHref && (
            <Paragraph style={{ margin: "18px 0 0" }}>
              <a href={trustHref}>{content.closing.trustLabel}</a>
            </Paragraph>
          )}
        </section>
      </div>
    </PublicPage>
  );
}
