/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect, useState } from "react";

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getFeaturePage } from "@cocalc/frontend/public/features/catalog";
import {
  PublicCard,
  PublicGrid,
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { SITE_NAME } from "@cocalc/util/theme";
import { slugURL } from "@cocalc/util/news";
import type { NewsItem } from "@cocalc/util/types/news";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

interface HomeConfig {
  help_email?: string;
  index_tagline?: string;
  is_authenticated?: boolean;
  logo_square?: string;
  organization_name?: string;
  organization_url?: string;
  site_description?: string;
  site_name?: string;
  splash_image?: string;
}

const PRIMARY_WORKFLOWS = [
  "jupyter-notebook",
  "latex-editor",
  "terminal",
  "ai",
  "teaching",
  "whiteboard",
] as const;

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

async function loadNews(): Promise<NewsItem[] | undefined> {
  try {
    const resp = await fetch(joinUrlPath(appBasePath, "api/v2/news/list"));
    const payload = await resp.json();
    return Array.isArray(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function formatNewsDate(value?: number | Date): string {
  if (value == null) return "";
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
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

function truncate(text: string, max = 180): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <Text
      strong
      style={{
        color: PUBLIC_COLORS.brand,
        fontSize: 13,
        letterSpacing: 0,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

function GlassPanel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: "rgba(255, 255, 255, 0.72)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 24,
        boxShadow: "0 22px 70px rgba(33, 49, 57, 0.10)",
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}

function HeroImage() {
  return (
    <div
      style={{
        aspectRatio: "16 / 9",
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      <img
        alt="CoCalc-AI workspace with notebook, terminal, Codex chat, files, snapshots, and RootFS panels"
        src="/public/landing/home-hero.jpg"
        style={{
          height: "100%",
          objectFit: "cover",
          transform: "scale(1.1)",
          transformOrigin: "center top",
          width: "100%",
        }}
      />
    </div>
  );
}

function HomeInfographic({ alt, src }: { alt: string; src: string }) {
  return (
    <img
      alt={alt}
      src={src}
      style={{
        aspectRatio: "16 / 9",
        background: "#fff",
        borderRadius: 14,
        objectFit: "contain",
        width: "100%",
      }}
    />
  );
}

function Hero({ config, siteName }: { config?: HomeConfig; siteName: string }) {
  const authenticated = !!config?.is_authenticated;
  return (
    <section>
      <Row align="middle" gutter={[40, 40]}>
        <Col lg={10} xs={24}>
          <Flex vertical gap={22}>
            <Eyebrow>Collaborative computational projects</Eyebrow>
            <Title
              level={1}
              style={{
                fontSize: 54,
                letterSpacing: 0,
                lineHeight: 1,
                margin: 0,
              }}
            >
              A durable workspace for humans and agents.
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: 20,
                lineHeight: 1.45,
                margin: 0,
              }}
            >
              {siteName} brings notebooks, terminals, files, LaTeX, chat,
              whiteboards, snapshots, backups, and Codex agent threads into one
              collaborative Linux project.
            </Paragraph>
            <Flex gap={12} wrap>
              {authenticated ? (
                <>
                  <Button
                    href={appPath("projects")}
                    size="large"
                    type="primary"
                  >
                    Open projects
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
                    Start free
                  </Button>
                  <Button href={appPath("pricing")} size="large">
                    See plans
                  </Button>
                </>
              )}
              <Button href={appPath("products/cocalc-plus")} size="large">
                Get CoCalc Plus
              </Button>
            </Flex>
            <Flex gap={8} wrap>
              {[
                "Minimal free tier",
                "Standard trial planned",
                "Free CoCalc Plus",
                "Self-host with Launchpad",
              ].map((item) => (
                <Tag key={item} color="blue" style={{ marginInlineEnd: 0 }}>
                  {item}
                </Tag>
              ))}
            </Flex>
          </Flex>
        </Col>
        <Col lg={14} xs={24}>
          <HeroImage />
        </Col>
      </Row>
    </section>
  );
}

function ProjectStorySection() {
  return (
    <section>
      <Row align="middle" gutter={[32, 32]}>
        <Col lg={12} xs={24}>
          <HomeInfographic
            alt="One CoCalc project containing Jupyter, LaTeX, terminal, chat, whiteboard, git review, backups, and collaboration"
            src="/public/landing/project-workflows.jpg"
          />
        </Col>
        <Col lg={12} xs={24}>
          <PublicSection>
            <Eyebrow>The project is the product</Eyebrow>
            <Title level={2} style={{ margin: 0 }}>
              One durable place for technical work.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              CoCalc is not just a notebook host or a terminal in a tab. A
              project is a persistent workspace with files, compute, document
              history, collaborators, chat, AI agents, snapshots, and backups.
            </Paragraph>
            <PublicGrid columns={2}>
              <GlassPanel>
                <Title level={4} style={{ marginTop: 0 }}>
                  Work survives the browser
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Notebook execution, agent turns, terminal sessions, document
                  history, and files are backend state, not fragile browser
                  state.
                </Paragraph>
              </GlassPanel>
              <GlassPanel>
                <Title level={4} style={{ marginTop: 0 }}>
                  Collaboration is everywhere
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Multiple people can share notebooks, terminals, files, chat,
                  and review workflows in the same project.
                </Paragraph>
              </GlassPanel>
            </PublicGrid>
          </PublicSection>
        </Col>
      </Row>
    </section>
  );
}

function WorkflowsSection() {
  const pages = PRIMARY_WORKFLOWS.map((slug) => getFeaturePage(slug)).filter(
    Boolean,
  );
  return (
    <section>
      <Flex align="baseline" justify="space-between" wrap gap={12}>
        <div>
          <Eyebrow>Core workflows</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 0" }}>
            Use the tools you already understand, together.
          </Title>
        </div>
        <Button href={appPath("features")}>All features</Button>
      </Flex>
      <PublicGrid columns={3}>
        {pages.map((page) =>
          page ? (
            <PublicCard
              href={appPath(`features/${page.slug}`)}
              key={page.slug}
              title={page.title}
            >
              <Paragraph style={{ margin: 0 }}>{page.summary}</Paragraph>
            </PublicCard>
          ) : null,
        )}
      </PublicGrid>
    </section>
  );
}

function ProductOptionsSection() {
  return (
    <section>
      <Row align="middle" gutter={[32, 32]}>
        <Col lg={10} xs={24}>
          <PublicSection>
            <Eyebrow>Ways to run CoCalc</Eyebrow>
            <Title level={2} style={{ margin: 0 }}>
              Hosted, local, self-hosted, or enterprise scale.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              Use the public cloud, install the free single-user CoCalc Plus
              app, run a small self-hosted Launchpad site, or step up to Rocket
              for larger deployments.
            </Paragraph>
            <Flex gap={12} wrap>
              <Button href={appPath("products")} type="primary">
                Compare products
              </Button>
              <Button
                href="https://software.cocalc.ai/software/cocalc-launchpad/index.html"
                rel="noreferrer"
                target="_blank"
              >
                Launchpad
              </Button>
            </Flex>
          </PublicSection>
        </Col>
        <Col lg={14} xs={24}>
          <HomeInfographic
            alt="CoCalc product options: Hosted CoCalc, CoCalc Plus, Launchpad, and Rocket"
            src="/public/landing/product-options.jpg"
          />
        </Col>
      </Row>
    </section>
  );
}

function DifferenceSection() {
  const items = [
    {
      body: "Run cells, commands, terminals, and agent turns without tying the useful state to one browser tab.",
      kicker: "State survives",
      title: "Durable execution",
    },
    {
      body: "Use sudo, apt, Python packages, RootFS images, SSH, and project snapshots instead of pretending technical work has no environment.",
      kicker: "Real environment",
      title: "Real Linux projects",
    },
    {
      body: "Chat, notebooks, terminals, files, whiteboards, git review, and support workflows are designed for more than one person.",
      kicker: "Shared by default",
      title: "Realtime collaboration",
    },
    {
      body: "Snapshots, backups, TimeTravel, project movement, and RootFS versions make project state recoverable and reusable.",
      kicker: "Recoverable work",
      title: "Operational safety",
    },
  ];
  return (
    <section
      style={{
        background: "#f7fbff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
        overflow: "hidden",
        padding: "40px 42px",
      }}
    >
      <Row align="middle" gutter={[36, 36]}>
        <Col lg={9} xs={24}>
          <Flex vertical gap={22}>
            <div>
              <Eyebrow>Why CoCalc is different</Eyebrow>
              <Title level={2} style={{ margin: "8px 0 0" }}>
                Built for real computational work, not only polished demos.
              </Title>
            </div>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: 17,
                margin: 0,
              }}
            >
              CoCalc treats a project as a durable technical environment: files,
              running work, collaboration, history, and recovery all belong
              together.
            </Paragraph>
            <div
              aria-hidden="true"
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 22,
                padding: 18,
              }}
            >
              <Flex vertical gap={14}>
                {[
                  "Notebook output",
                  "Linux filesystem",
                  "Team activity",
                  "Snapshots and backups",
                ].map((label, index) => (
                  <Flex align="center" gap={12} key={label}>
                    <div
                      style={{
                        alignItems: "center",
                        background:
                          index === 0 ? PUBLIC_COLORS.brand : "#eef5ff",
                        borderRadius: 999,
                        color: index === 0 ? "#fff" : PUBLIC_COLORS.brand,
                        display: "flex",
                        flex: "0 0 32px",
                        fontSize: 13,
                        fontWeight: 700,
                        height: 32,
                        justifyContent: "center",
                        width: 32,
                      }}
                    >
                      {index + 1}
                    </div>
                    <Text strong>{label}</Text>
                  </Flex>
                ))}
              </Flex>
            </div>
          </Flex>
        </Col>
        <Col lg={15} xs={24}>
          <div
            style={{
              display: "grid",
              gap: 18,
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            }}
          >
            {items.map((item, index) => (
              <div
                key={item.title}
                style={{
                  background: "#fff",
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 22,
                  boxShadow: "0 18px 44px rgba(33, 49, 57, 0.08)",
                  minHeight: 190,
                  padding: 24,
                  transform:
                    index === 1 || index === 2 ? "translateY(18px)" : undefined,
                }}
              >
                <Text
                  strong
                  style={{
                    color: PUBLIC_COLORS.brand,
                    display: "block",
                    fontSize: 13,
                    letterSpacing: 0,
                    marginBottom: 12,
                    textTransform: "uppercase",
                  }}
                >
                  {item.kicker}
                </Text>
                <Title level={3} style={{ margin: "0 0 12px" }}>
                  {item.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>{item.body}</Paragraph>
              </div>
            ))}
          </div>
        </Col>
      </Row>
    </section>
  );
}

function NewsSection({ initialNews }: { initialNews?: NewsItem[] }) {
  const news = (initialNews ?? []).slice(0, 3);
  if (news.length === 0) return null;

  return (
    <section>
      <Flex align="baseline" justify="space-between" wrap gap={12}>
        <Title level={2} style={{ margin: 0 }}>
          Recent News
        </Title>
        <Button href={appPath("news")}>All news</Button>
      </Flex>
      <PublicGrid columns={3}>
        {news.map((item) => (
          <PublicCard
            href={appPath(slugURL(item))}
            key={`${item.id}`}
            title={item.title}
          >
            <Flex wrap gap={8}>
              <Tag color="blue">{item.channel}</Tag>
              <Text type="secondary">{formatNewsDate(item.date)}</Text>
            </Flex>
            <Paragraph style={{ margin: "12px 0 0" }}>
              {truncate(stripMarkdown(item.text))}
            </Paragraph>
          </PublicCard>
        ))}
      </PublicGrid>
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
    <section>
      <PublicSection>
        <Row align="middle" gutter={[24, 24]}>
          <Col md={15} xs={24}>
            <Title level={2} style={{ margin: 0 }}>
              {config?.organization_name
                ? `Hosted by ${config.organization_name}`
                : `Start using ${siteName}`}
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              {config?.organization_name && config?.organization_url ? (
                <>
                  This deployment is operated by{" "}
                  <a href={config.organization_url}>
                    {config.organization_name}
                  </a>
                  . Use the public pages to understand the platform, then move
                  into the app when you are ready.
                </>
              ) : (
                <>
                  Create a hosted account, install CoCalc Plus for free, or run
                  your own CoCalc site with Launchpad.
                </>
              )}
            </Paragraph>
          </Col>
          <Col md={9} xs={24}>
            <Flex gap={12} justify="end" wrap>
              {config?.is_authenticated ? (
                <Button href={appPath("projects")} type="primary">
                  Projects
                </Button>
              ) : (
                <>
                  <Button href={appPath("auth/sign-up")} type="primary">
                    Sign up
                  </Button>
                  <Button href={appPath("auth/sign-in")}>Sign in</Button>
                </>
              )}
              <Button href={appPath("support")}>Support</Button>
            </Flex>
          </Col>
        </Row>
      </PublicSection>
    </section>
  );
}

export default function PublicHomeApp({ config }: { config?: HomeConfig }) {
  const siteName = config?.site_name ?? SITE_NAME;
  const [news, setNews] = useState<NewsItem[]>();

  useEffect(() => {
    document.title = siteName;
  }, [siteName]);

  useEffect(() => {
    let canceled = false;
    void loadNews().then((items) => {
      if (!canceled) setNews(items ?? []);
    });
    return () => {
      canceled = true;
    };
  }, []);

  return (
    <PublicPage active="home" config={config}>
      <Hero config={config} siteName={siteName} />
      <ProjectStorySection />
      <WorkflowsSection />
      <ProductOptionsSection />
      <DifferenceSection />
      <NewsSection initialNews={news} />
      <BottomCallout config={config} siteName={siteName} />
    </PublicPage>
  );
}
