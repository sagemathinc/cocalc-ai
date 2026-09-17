/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";
import { getDocsEntry } from "@cocalc/docs";

import type { IconName } from "@cocalc/frontend/components/icon";
import {
  appPath,
  getPublicDocsAccess,
  getPublicMarketingSiteName,
  PublicNextStep,
  type PublicConfig,
  PublicSectionShell,
} from "@cocalc/frontend/public/common";
import { IconBadge } from "@cocalc/frontend/public/features/feature-visuals";
import {
  PublicHero,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_FEATURED_GUIDES,
  PUBLIC_GUIDE_GROUPS,
} from "@cocalc/util/public-guides";
import { PUBLIC_COLORS, PUBLIC_ELEVATION } from "@cocalc/frontend/public/theme";
import { FIELD_GUIDES_URL } from "@cocalc/util/theme";

const { Paragraph, Text, Title } = Typography;

const GUIDES_PAGE_CSS = `
.cocalc-guide-link {
  color: inherit;
  display: grid;
  gap: 12px;
  grid-template-columns: auto minmax(0, 1fr);
  text-decoration: none;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    box-shadow 120ms ease;
}

.cocalc-guide-link-featured {
  background: ${PUBLIC_COLORS.surfaceMuted};
  border: 1px solid ${PUBLIC_COLORS.brandSubtle};
  border-radius: 8px;
  height: 100%;
  padding: 18px;
}

.cocalc-guide-link-compact {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  min-height: 68px;
  padding: 8px 10px;
}

.cocalc-guide-link:hover {
  background: ${PUBLIC_COLORS.surface};
  border-color: ${PUBLIC_COLORS.border};
  box-shadow: ${PUBLIC_ELEVATION.hover};
  color: inherit;
}

@media (max-width: 767px) {
  .cocalc-guide-link-featured {
    padding: 14px;
  }

  .cocalc-guide-link-compact {
    min-height: auto;
    padding: 10px 0;
  }
}
`;

interface GuideCardSpec {
  body: string;
  href: string;
  icon: IconName;
  title: string;
}

function GuideLink({
  body,
  featured,
  href,
  icon,
  title,
}: GuideCardSpec & { featured?: boolean }) {
  const external = /^https?:\/\//.test(href);
  const resolvedHref = external ? href : appPath(href);

  return (
    <a
      className={`cocalc-guide-link ${
        featured ? "cocalc-guide-link-featured" : "cocalc-guide-link-compact"
      }`}
      href={resolvedHref}
      rel={external ? "noreferrer" : undefined}
      target={external ? "_blank" : undefined}
    >
      <IconBadge icon={icon} size={featured ? "md" : "sm"} />
      <span>
        <Text strong style={{ display: "block" }}>
          {title}
        </Text>
        <Text type="secondary" style={{ display: "block", marginTop: 4 }}>
          {body}
        </Text>
      </span>
    </a>
  );
}

function GuideDirectory({ config }: { config?: PublicConfig }) {
  const docsAccess = getPublicDocsAccess(config);
  const visible = ({ href }: { href: string }) =>
    !href.startsWith("/docs/") || getDocsEntry(href, docsAccess) != null;

  return (
    <PublicSection>
      <div
        style={{
          background: PUBLIC_COLORS.surface,
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: 14,
          padding: 24,
        }}
      >
        <Flex vertical gap={24}>
          <Row gutter={[24, 24]}>
            <Col xs={24} lg={7}>
              <Flex vertical gap={10}>
                <Title level={2} style={{ margin: 0 }}>
                  Find the guide by task
                </Title>
                <Paragraph
                  style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}
                >
                  Pick the task that matches the work in front of you. The full
                  guide library has the longer illustrated walkthroughs.
                </Paragraph>
                <Flex gap={10} wrap>
                  <Button
                    href={FIELD_GUIDES_URL}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open all guides
                  </Button>
                  <Button href={appPath("docs")}>Browse docs</Button>
                </Flex>
              </Flex>
            </Col>
            <Col xs={24} lg={17}>
              <Row gutter={[12, 12]}>
                {PUBLIC_FEATURED_GUIDES.filter(visible).map((guide) => (
                  <Col key={guide.href} xs={24} md={8}>
                    <GuideLink {...guide} featured />
                  </Col>
                ))}
              </Row>
            </Col>
          </Row>

          <div
            style={{
              borderTop: `1px solid ${PUBLIC_COLORS.border}`,
              paddingTop: 24,
            }}
          >
            <Flex vertical gap={24}>
              {PUBLIC_GUIDE_GROUPS.map((group) => (
                <section key={group.title}>
                  <Row gutter={[18, 14]}>
                    <Col xs={24} lg={7}>
                      <Title level={3} style={{ margin: 0 }}>
                        {group.title}
                      </Title>
                      <Paragraph
                        style={{
                          color: PUBLIC_COLORS.mutedText,
                          margin: "8px 0 0",
                        }}
                      >
                        {group.intro}
                      </Paragraph>
                    </Col>
                    <Col xs={24} lg={17}>
                      <Row gutter={[12, 12]}>
                        {group.guides.filter(visible).map((guide) => (
                          <Col key={guide.href} xs={24} md={12}>
                            <GuideLink {...guide} />
                          </Col>
                        ))}
                      </Row>
                    </Col>
                  </Row>
                </section>
              ))}
            </Flex>
          </div>
        </Flex>
      </div>
    </PublicSection>
  );
}

export default function PublicGuidesApp({ config }: { config?: PublicConfig }) {
  const siteName = getPublicMarketingSiteName(config);
  const title = `Guides - ${siteName}`;

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <>
      <style>{GUIDES_PAGE_CSS}</style>
      <PublicSectionShell active="guides" config={config}>
        <PublicHero
          actions={
            <Flex gap={12} wrap>
              <Button
                href={FIELD_GUIDES_URL}
                rel="noreferrer"
                target="_blank"
                type="primary"
              >
                Open all guides
              </Button>
              <Button href={appPath("docs")}>Browse docs</Button>
            </Flex>
          }
          subtitle={
            <>
              Plan setup, notebooks, terminals, code review, and deployment
              paths around durable CoCalc projects.
            </>
          }
          title="Guides"
        />
        <GuideDirectory config={config} />
        <PublicNextStep authenticated={!!config?.is_authenticated} />
      </PublicSectionShell>
    </>
  );
}
