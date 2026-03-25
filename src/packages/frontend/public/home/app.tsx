/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Card, Col, Flex, Row, Tag, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getFeatureIndexPages } from "@cocalc/frontend/public/features/catalog";
import {
  PublicHero,
  PublicPageRoot,
  PublicSectionCard,
} from "@cocalc/frontend/public/ui/shell";
import PublicTopNav from "@cocalc/frontend/public/ui/top-nav";
import { SITE_NAME } from "@cocalc/util/theme";
import { slugURL } from "@cocalc/util/news";
import type { NewsItem } from "@cocalc/util/types/news";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

interface HomeConfig {
  help_email?: string;
  is_authenticated?: boolean;
  organization_name?: string;
  organization_url?: string;
  site_description?: string;
  site_name?: string;
}

export default function PublicHomeApp({
  config,
  initialNews,
}: {
  config?: HomeConfig;
  initialNews?: NewsItem[];
}) {
  const siteName = config?.site_name ?? SITE_NAME;
  const features = getFeatureIndexPages().slice(0, 6);
  const news = (initialNews ?? []).slice(0, 3);

  useEffect(() => {
    document.title = siteName;
  }, [siteName]);

  return (
    <PublicPageRoot>
      <PublicTopNav
        active="home"
        isAuthenticated={!!config?.is_authenticated}
        siteName={siteName}
      />
      <PublicHero
        eyebrow="COLLABORATIVE TECHNICAL COMPUTING"
        title={siteName}
        subtitle={
          config?.site_description ??
          "Run Jupyter notebooks, Linux terminals, documents, and coding agents in one collaborative online workspace."
        }
        actions={
          <Flex wrap gap={12}>
            <Button href={appPath("auth/sign-up")} size="large" type="primary">
              Create account
            </Button>
            <Button href={appPath("features")} size="large">
              Explore features
            </Button>
            <Button href={appPath("support")} size="large">
              Contact support
            </Button>
          </Flex>
        }
      />
      <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
        <Col xs={24} xl={15}>
          <Card
            variant="outlined"
            styles={{ body: { padding: 18 } }}
            style={{ boxShadow: "0 18px 40px rgba(0, 0, 0, 0.08)" }}
          >
            <img
              alt={`${siteName} workspace screenshot`}
              src="/public/features/cocalc-jupyter2-20170508.png"
              style={{
                width: "100%",
                display: "block",
                borderRadius: 12,
                objectFit: "cover",
              }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Flex vertical gap={16}>
            <PublicSectionCard>
              <Title level={3} style={{ margin: 0 }}>
                One environment, not a stack of disconnected tools
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Keep notebooks, terminals, LaTeX, slides, whiteboards, support,
                and coding agents in the same project instead of stitching
                together separate services.
              </Paragraph>
            </PublicSectionCard>
            <PublicSectionCard>
              <Title level={3} style={{ margin: 0 }}>
                Good defaults for launchpad mode
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Public pages, auth, support, news, and policies now work without
                Next.js, which keeps launchpad deployments simpler and more
                uniform.
              </Paragraph>
            </PublicSectionCard>
          </Flex>
        </Col>
      </Row>

      <section style={{ marginTop: 32 }}>
        <Flex align="baseline" justify="space-between" wrap gap={12}>
          <Title level={2} style={{ margin: 0 }}>
            Popular Features
          </Title>
          <Button
            href={appPath("features")}
            type="link"
            style={{ paddingInline: 0 }}
          >
            All features
          </Button>
        </Flex>
        <Row gutter={[16, 16]} style={{ marginTop: 8 }}>
          {features.map((feature) => (
            <Col key={feature.slug} xs={24} md={12} xl={8}>
              <PublicSectionCard>
                {feature.image ? (
                  <img
                    alt={feature.title}
                    src={feature.image}
                    style={{
                      width: "100%",
                      aspectRatio: "16 / 9",
                      objectFit: "cover",
                      borderRadius: 12,
                    }}
                  />
                ) : null}
                <Text strong type="secondary">
                  FEATURE
                </Text>
                <Title level={3} style={{ margin: 0 }}>
                  {feature.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>{feature.summary}</Paragraph>
                <div>
                  <Button
                    href={appPath(`features/${feature.slug}`)}
                    type="link"
                    style={{ paddingInline: 0 }}
                  >
                    Open page
                  </Button>
                </div>
              </PublicSectionCard>
            </Col>
          ))}
        </Row>
      </section>

      <section style={{ marginTop: 32 }}>
        <Flex align="baseline" justify="space-between" wrap gap={12}>
          <Title level={2} style={{ margin: 0 }}>
            Recent News
          </Title>
          <Flex wrap gap={8}>
            <Button href={appPath("news")} type="default">
              News
            </Button>
            <Button
              href={appPath("news/rss.xml")}
              type="link"
              style={{ paddingInline: 0 }}
            >
              RSS
            </Button>
          </Flex>
        </Flex>
        <Row gutter={[16, 16]} style={{ marginTop: 8 }}>
          {news.map((item) => (
            <Col key={`${item.id}`} xs={24} md={12} xl={8}>
              <PublicSectionCard>
                <Flex wrap gap={8}>
                  <Tag color="blue">{item.channel}</Tag>
                  <Text type="secondary">{formatNewsDate(item.date)}</Text>
                </Flex>
                <Title level={3} style={{ margin: 0 }}>
                  {item.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {truncate(stripMarkdown(item.text), 180)}
                </Paragraph>
                <div>
                  <Button
                    href={appPath(slugURL(item))}
                    type="link"
                    style={{ paddingInline: 0 }}
                  >
                    Read more
                  </Button>
                </div>
              </PublicSectionCard>
            </Col>
          ))}
        </Row>
      </section>

      <section style={{ marginTop: 32 }}>
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            {config?.organization_name
              ? `Hosted by ${config.organization_name}`
              : `About ${siteName}`}
          </Title>
          <Paragraph style={{ margin: 0 }}>
            {config?.organization_name && config?.organization_url ? (
              <>
                This deployment is operated by{" "}
                <a href={config.organization_url}>{config.organization_name}</a>
                .
              </>
            ) : (
              <>
                Use the public pages above to explore the platform, then sign in
                to move into projects and workspaces.
              </>
            )}
          </Paragraph>
          <Flex wrap gap={12}>
            <Button href={appPath("about")}>About</Button>
            <Button href={appPath("policies")}>Policies</Button>
            <Button href={appPath("support")}>Support</Button>
          </Flex>
        </PublicSectionCard>
      </section>
    </PublicPageRoot>
  );
}

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function formatNewsDate(value?: number | Date): string {
  if (value == null) return "";
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function stripMarkdown(text?: string): string {
  return `${text ?? ""}`
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max = 260): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
