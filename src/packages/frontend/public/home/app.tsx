/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect } from "react";

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getFeatureIndexPages } from "@cocalc/frontend/public/features/catalog";
import {
  FeatureImage,
  LinkButton,
} from "@cocalc/frontend/public/features/page-components";
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
  index_tagline?: string;
  is_authenticated?: boolean;
  organization_name?: string;
  organization_url?: string;
  site_description?: string;
  site_name?: string;
  splash_image?: string;
}

const VIDEO_RESOURCES = [
  {
    description: "A broad product walkthrough of how CoCalc fits together.",
    href: "https://www.youtube.com/watch?v=oDdfmkQ0Hvw",
    title: "CoCalc overview",
  },
  {
    description: "A current look at coding agents and AI-assisted workflows.",
    href: "https://www.youtube.com/watch?v=UfmjYxalyh0",
    title: "Using AI in CoCalc",
  },
  {
    description: "A direct look at JupyterLab running inside CoCalc.",
    href: "https://www.youtube.com/watch?v=LLtLFtD8qfo",
    title: "Using JupyterLab in CoCalc",
  },
] as const;

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function getHomeHighlights(): Array<{ body: ReactNode; title: string }> {
  return [
    {
      body: "Keep notebooks, terminals, LaTeX, slides, whiteboards, chat, and support inside the same project instead of spreading work across disconnected services.",
      title: "One technical workspace",
    },
    {
      body: (
        <>
          Collaborate directly in the tools people actually use for research,
          teaching, and engineering, with shared state and file history built
          in, backed by{" "}
          <a
            href="https://github.com/sagemathinc/patchflow"
            rel="noreferrer"
            target="_blank"
          >
            Patchflow
          </a>
          , the free open source software we wrote that powers CoCalc AI&apos;s
          realtime collaboration model.
        </>
      ),
      title: "Realtime collaboration",
    },
    {
      body: "Run courses, distribute assignments, collect work, and grade technical files without building your own integration stack.",
      title: "Teaching and operations",
    },
    {
      body: (
        <>
          Use hosted CoCalc,{" "}
          <a href={appPath("software/cocalc-plus")}>CoCalc Plus</a>,{" "}
          <a
            href="https://software.cocalc.ai/software/cocalc-launchpad/index.html"
            rel="noreferrer"
            target="_blank"
          >
            Launchpad
          </a>
          , and custom deployments without changing the overall user model.
        </>
      ),
      title: "Hosted and self-hosted",
    },
  ];
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

function truncate(text: string, max = 220): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function HeadlineStrip({ items }: { items: NewsItem[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 12, marginBottom: 24 }}>
      <Text strong type="secondary">
        LATEST
      </Text>
      <Flex wrap gap={12}>
        {items.map((item) => (
          <a
            key={`${item.id}`}
            href={appPath(slugURL(item))}
            style={{ textDecoration: "none" }}
          >
            <Tag
              color="blue"
              style={{ padding: "8px 12px", cursor: "pointer" }}
            >
              {item.title}
            </Tag>
          </a>
        ))}
      </Flex>
    </div>
  );
}

function HeroDetails({
  config,
  siteName,
}: {
  config?: HomeConfig;
  siteName: string;
}) {
  return (
    <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
      <Col xs={24} xl={15}>
        <PublicSectionCard>
          <FeatureImage
            alt={`${siteName} workspace screenshot`}
            src={
              config?.splash_image ??
              "/public/cocalc-screenshot-20200128-nq8.png"
            }
          />
        </PublicSectionCard>
      </Col>
      <Col xs={24} xl={9}>
        <Flex vertical gap={16}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Why teams choose {siteName}
            </Title>
            <Paragraph style={{ margin: 0 }}>
              The point is not only notebooks. It is keeping the whole technical
              workflow together: files, shell, documents, teaching, support, and
              now coding agents.
            </Paragraph>
          </PublicSectionCard>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              {config?.is_authenticated ? "Go straight to work" : "Start fast"}
            </Title>
            <Paragraph style={{ margin: 0 }}>
              {config?.is_authenticated
                ? "You are already signed in, so the public site should lead directly back into projects and settings."
                : "Create an account, explore the feature pages, or contact support before moving into the main app."}
            </Paragraph>
            <Flex wrap gap={12}>
              {config?.is_authenticated ? (
                <>
                  <Button href={appPath("projects")} type="primary">
                    Open projects
                  </Button>
                  <Button href={appPath("settings")}>Settings</Button>
                </>
              ) : (
                <>
                  <Button href={appPath("auth/sign-up")} type="primary">
                    Create account
                  </Button>
                  <Button href={appPath("support")}>Support</Button>
                </>
              )}
            </Flex>
          </PublicSectionCard>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Learn more
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Browse the public feature pages, watch product videos, or read
              recent news before diving into the app.
            </Paragraph>
            <Flex wrap gap={12}>
              <LinkButton href={appPath("features")}>All features</LinkButton>
              <LinkButton href={appPath("news")}>News</LinkButton>
              <LinkButton href={appPath("about")}>About</LinkButton>
            </Flex>
          </PublicSectionCard>
        </Flex>
      </Col>
    </Row>
  );
}

function HighlightSection({ siteName }: { siteName: string }) {
  const highlights = getHomeHighlights();
  return (
    <section style={{ marginTop: 32 }}>
      <Title level={2} style={{ margin: 0 }}>
        Why {siteName} is different
      </Title>
      <Row gutter={[16, 16]} style={{ marginTop: 8 }}>
        {highlights.map((item) => (
          <Col key={item.title} xs={24} md={12}>
            <PublicSectionCard>
              <Title level={3} style={{ margin: 0 }}>
                {item.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>{item.body}</Paragraph>
            </PublicSectionCard>
          </Col>
        ))}
      </Row>
    </section>
  );
}

function FeaturesSection({ siteName }: { siteName: string }) {
  const features = getFeatureIndexPages().slice(0, 8);
  return (
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
      <Paragraph style={{ margin: "8px 0 0", maxWidth: "70ch" }}>
        These are some of the most important workflows that already live inside
        the same {siteName} environment.
      </Paragraph>
      <Row gutter={[16, 16]} style={{ marginTop: 8 }}>
        {features.map((feature) => (
          <Col key={feature.slug} xs={24} md={12} xl={6}>
            <PublicSectionCard>
              <FeatureImage alt={feature.title} src={feature.image} />
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
  );
}

function ResourceSection() {
  return (
    <section style={{ marginTop: 32 }}>
      <Title level={2} style={{ margin: 0 }}>
        Learn by example
      </Title>
      <Row gutter={[16, 16]} style={{ marginTop: 8 }}>
        {VIDEO_RESOURCES.map((item) => (
          <Col key={item.href} xs={24} md={8}>
            <PublicSectionCard>
              <Text strong type="secondary">
                VIDEO
              </Text>
              <Title level={3} style={{ margin: 0 }}>
                {item.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>{item.description}</Paragraph>
              <Flex wrap gap={12}>
                <Button href={item.href} type="primary">
                  Watch
                </Button>
              </Flex>
            </PublicSectionCard>
          </Col>
        ))}
      </Row>
    </section>
  );
}

function NewsSection({ initialNews }: { initialNews?: NewsItem[] }) {
  const news = (initialNews ?? []).slice(0, 3);
  if (news.length === 0) return null;

  return (
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
                {truncate(stripMarkdown(item.text))}
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
  );
}

function BottomCallout({
  config,
  siteName,
}: {
  config?: HomeConfig;
  siteName: string;
}) {
  return (
    <section style={{ marginTop: 32 }}>
      <PublicSectionCard>
        <Title level={2} style={{ margin: 0 }}>
          {config?.organization_name
            ? `Hosted by ${config.organization_name}`
            : `Ready to use ${siteName}?`}
        </Title>
        <Paragraph style={{ margin: 0 }}>
          {config?.organization_name && config?.organization_url ? (
            <>
              This deployment is operated by{" "}
              <a href={config.organization_url}>{config.organization_name}</a>.
              Use the public pages to explore the platform, then move into the
              main app when you are ready.
            </>
          ) : (
            <>
              Use the public pages above to understand the platform quickly,
              then jump into projects, settings, support, or feature pages as
              needed.
            </>
          )}
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          {config?.index_tagline ??
            "CoCalc runs your Jupyter notebooks and Linux terminals with powerful resources."}
        </Paragraph>
        <Flex wrap gap={12}>
          {config?.is_authenticated ? (
            <>
              <Button href={appPath("projects")} type="primary">
                Projects
              </Button>
              <Button href={appPath("settings")}>Settings</Button>
            </>
          ) : (
            <>
              <Button href={appPath("auth/sign-up")} type="primary">
                Sign up
              </Button>
              <Button href={appPath("auth/sign-in")}>Sign in</Button>
            </>
          )}
        </Flex>
      </PublicSectionCard>
    </section>
  );
}

export default function PublicHomeApp({
  config,
  initialNews,
}: {
  config?: HomeConfig;
  initialNews?: NewsItem[];
}) {
  const siteName = config?.site_name ?? SITE_NAME;

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
      <HeadlineStrip items={(initialNews ?? []).slice(0, 3)} />
      <PublicHero
        eyebrow="COLLABORATIVE TECHNICAL COMPUTING"
        title={siteName}
        subtitle={
          config?.site_description ??
          "Run Jupyter notebooks, Linux terminals, documents, and coding agents in one collaborative online workspace."
        }
        actions={
          <Flex wrap gap={12}>
            {config?.is_authenticated ? (
              <>
                <Button href={appPath("projects")} size="large" type="primary">
                  Open projects
                </Button>
                <Button href={appPath("settings")} size="large">
                  Settings
                </Button>
                <Button href={appPath("features")} size="large">
                  Explore features
                </Button>
              </>
            ) : (
              <>
                <Button
                  href={appPath("auth/sign-up")}
                  size="large"
                  type="primary"
                >
                  Create account
                </Button>
                <Button href={appPath("features")} size="large">
                  Explore features
                </Button>
                <Button href={appPath("support")} size="large">
                  Contact support
                </Button>
              </>
            )}
          </Flex>
        }
      />
      <HeroDetails config={config} siteName={siteName} />
      <HighlightSection siteName={siteName} />
      <FeaturesSection siteName={siteName} />
      <ResourceSection />
      <NewsSection initialNews={initialNews} />
      <BottomCallout config={config} siteName={siteName} />
    </PublicPageRoot>
  );
}
