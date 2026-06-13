/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect, useState } from "react";

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getFeaturePage } from "@cocalc/frontend/public/features/catalog";
import {
  getPublicMarketingConfig,
  getPublicMarketingSiteName,
} from "@cocalc/frontend/public/config";
import {
  PublicCard,
  PublicGrid,
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import { slugURL } from "@cocalc/util/news";
import type { NewsItem } from "@cocalc/util/types/news";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

interface HomeConfig {
  cocalc_product?: string;
  help_email?: string;
  index_tagline?: string;
  is_launchpad?: boolean;
  is_authenticated?: boolean;
  logo_square?: string;
  organization_name?: string;
  organization_url?: string;
  site_description?: string;
  site_name?: string;
  splash_image?: string;
}

const PRIMARY_WORKFLOWS = ["jupyter-notebook", "terminal", "ai"] as const;
const HERO_IMAGE_URL = "/public/landing/home-hero.jpg";
const WORKFLOW_IMAGE_URL = "/public/landing/project-workflows.jpg";
const PUBLIC_PAGE_GUTTER = "max(16px, calc((100vw - 1200px) / 2))";
const PANEL_RADIUS = 8;
const HOME_PAGE_CSS = `
  @media (max-width: 720px) {
    .cocalc-public-home-hero {
      min-height: auto !important;
      padding-bottom: 36px !important;
      padding-top: 36px !important;
    }

    .cocalc-public-home-hero-title {
      font-size: 44px !important;
      line-height: 1.08 !important;
    }

    .cocalc-public-home-hero-copy {
      font-size: 18px !important;
    }

    .cocalc-public-home-hero-actions .ant-btn {
      justify-content: center;
      width: 100%;
    }

    .cocalc-public-home-workflow-visual {
      padding: 12px !important;
    }

  }

  @media (max-width: 840px) {
    .cocalc-public-home-product-header {
      display: none !important;
    }

    .cocalc-public-home-product-row {
      grid-template-columns: 44px minmax(0, 1fr) 18px !important;
    }

    .cocalc-public-home-product-row-path {
      grid-column: 1 / 3 !important;
    }

    .cocalc-public-home-product-row-field {
      grid-column: 1 / -1 !important;
    }

    .cocalc-public-home-product-row-next {
      grid-column: 1 / -1 !important;
      justify-self: start !important;
    }
  }
`;
const HERO_OUTCOMES = [
  {
    body: "Notebooks, terminals, files, chat, and AI stay together.",
    icon: "project-outlined",
    title: "One place to work",
  },
  {
    body: "Linux, packages, services, and notebooks run in the browser.",
    icon: "terminal",
    title: "Real compute",
  },
  {
    body: "History and snapshots keep work reviewable and recoverable.",
    icon: "disk-snapshot",
    title: "A lasting record",
  },
] satisfies { body: string; icon: IconName; title: string }[];
const WORKSPACE_PREVIEW_FILES = [
  {
    icon: "jupyter",
    meta: "Output saved",
    name: "analysis.ipynb",
  },
  {
    icon: "terminal",
    meta: "Long-running shell",
    name: "run.term",
  },
  {
    icon: "file-code",
    meta: "Patch ready",
    name: "src/model.py",
  },
] satisfies { icon: IconName; meta: string; name: string }[];
const WORKSPACE_PREVIEW_ACTIVITY = [
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    detail: "Tests, packages, and logs use the project files.",
    icon: "terminal",
    label: "Terminal",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    detail: "Prompts, patches, screenshots, and review notes stay attached.",
    icon: "robot",
    label: "Codex thread",
  },
  {
    accent: PUBLIC_COLORS.warning,
    detail: "Snapshots and TimeTravel keep recovery nearby.",
    icon: "history",
    label: "History",
  },
] satisfies {
  accent: string;
  detail: string;
  icon: IconName;
  label: string;
}[];
const WORKSPACE_PREVIEW_TABS = [
  {
    description: "Source, notebooks, data",
    href: "features/compare",
    icon: "files",
    label: "Open files",
    title: "File tree",
  },
  {
    description: "Shells and services",
    href: "features/terminal",
    icon: "terminal",
    label: "Run terminal",
    title: "Linux terminal",
  },
  {
    description: "Agent work thread",
    href: "features/ai",
    icon: "robot",
    label: "Ask Codex",
    title: "Agent turn",
  },
  {
    description: "Snapshots and TimeTravel",
    href: "features/compare",
    icon: "history",
    label: "Review history",
    title: "History trail",
  },
] satisfies {
  description: string;
  href: string;
  icon: IconName;
  label: string;
  title: string;
}[];
const WORKFLOW_CONTEXT_ITEMS = [
  { icon: "files", label: "Files" },
  { icon: "history", label: "History" },
  { icon: "users", label: "People" },
  { icon: "disk-snapshot", label: "Recovery" },
] satisfies { icon: IconName; label: string }[];
function alpha(hexColor: string, opacity: number): string {
  if (hexColor === COLORS.TOP_BAR.ACTIVE) {
    return `rgba(255, 255, 255, ${opacity})`;
  }
  const hex = hexColor.replace("#", "");
  if (hex.length !== 6) return hexColor;
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function supportPurchasePath(subject: string, body: string): string {
  const params = new URLSearchParams({
    body,
    subject,
    title: "Ask Sales",
    type: "purchase",
  });
  return `${appPath("support/new")}?${params.toString()}`;
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

function DecorativeButtonIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex" }}>
      <Icon name={name} />
    </span>
  );
}

function WorkflowVisualPanel() {
  return (
    <figure
      aria-label="CoCalc project workflow visual"
      className="cocalc-public-home-workflow-visual"
      style={{
        background: `linear-gradient(145deg, ${PUBLIC_COLORS.surfaceMuted} 0%, ${PUBLIC_COLORS.surface} 54%, ${PUBLIC_COLORS.warningTint} 100%)`,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.08)}`,
        margin: 0,
        overflow: "hidden",
        padding: 14,
      }}
    >
      <img
        alt="CoCalc project workflow map"
        decoding="async"
        loading="lazy"
        src={WORKFLOW_IMAGE_URL}
        style={{
          aspectRatio: "16 / 10",
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: PANEL_RADIUS,
          display: "block",
          objectFit: "cover",
          objectPosition: "center",
          width: "100%",
        }}
      />
      <figcaption style={{ marginTop: 14 }}>
        <Flex vertical gap={12}>
          <div>
            <Text strong style={{ color: PUBLIC_COLORS.brand }}>
              Project-centered workflow map
            </Text>
            <Paragraph style={{ margin: "4px 0 0" }}>
              The same project can hold notebooks, terminal sessions, chat,
              review context, collaborators, and recovery history.
            </Paragraph>
          </div>
          <div
            style={{
              display: "grid",
              gap: 8,
              gridTemplateColumns: "repeat(auto-fit, minmax(124px, 1fr))",
            }}
          >
            {WORKFLOW_CONTEXT_ITEMS.map((item) => (
              <div
                key={item.label}
                style={{
                  alignItems: "center",
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PANEL_RADIUS,
                  color: PUBLIC_COLORS.brand,
                  display: "flex",
                  gap: 8,
                  minHeight: 42,
                  padding: "10px 12px",
                }}
              >
                <Icon name={item.icon} />
                <Text>{item.label}</Text>
              </div>
            ))}
          </div>
          <Button
            href={appPath("features/compare")}
            icon={<DecorativeButtonIcon name="overview" />}
          >
            Map project context
          </Button>
        </Flex>
      </figcaption>
    </figure>
  );
}

function WorkspacePreview({ authenticated }: { authenticated: boolean }) {
  const projectHref = authenticated ? "projects" : "auth/sign-up";
  const projectLabel = authenticated ? "Open projects" : "Start a project";

  return (
    <div
      aria-label="CoCalc project context preview"
      role="group"
      style={{
        backdropFilter: "blur(14px)",
        background: alpha(PUBLIC_COLORS.surface, 0.18),
        border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.34)}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: `0 24px 54px ${alpha(PUBLIC_COLORS.brandDark, 0.22)}`,
        color: PUBLIC_COLORS.surface,
        padding: 16,
      }}
    >
      <Flex align="center" justify="space-between" wrap gap={10}>
        <Flex align="center" gap={10}>
          <span
            style={{
              alignItems: "center",
              background: alpha(PUBLIC_COLORS.surface, 0.16),
              border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.28)}`,
              borderRadius: PANEL_RADIUS,
              color: PUBLIC_COLORS.accent,
              display: "flex",
              flex: "0 0 42px",
              fontSize: 20,
              height: 42,
              justifyContent: "center",
              width: 42,
            }}
          >
            <Icon name="project-outlined" />
          </span>
          <span>
            <Text strong style={{ color: "inherit", display: "block" }}>
              research-workspace
            </Text>
            <Text style={{ color: alpha(PUBLIC_COLORS.surface, 0.74) }}>
              Persistent project
            </Text>
          </span>
        </Flex>
        <Tag
          style={{
            background: alpha(PUBLIC_COLORS.accent, 0.18),
            borderColor: alpha(PUBLIC_COLORS.accent, 0.45),
            color: PUBLIC_COLORS.surface,
            marginInlineEnd: 0,
          }}
        >
          Project workspace
        </Tag>
      </Flex>
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 190px), 1fr))",
          marginTop: 16,
        }}
      >
        <div
          style={{
            background: alpha(PUBLIC_COLORS.brandDark, 0.48),
            border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.2)}`,
            borderRadius: PANEL_RADIUS,
            padding: 14,
          }}
        >
          <Text
            strong
            style={{
              color: alpha(PUBLIC_COLORS.surface, 0.86),
              display: "block",
              marginBottom: 10,
            }}
          >
            Project files
          </Text>
          <Flex vertical gap={8}>
            {WORKSPACE_PREVIEW_FILES.map((file) => (
              <Flex align="center" gap={9} key={file.name}>
                <span
                  style={{
                    alignItems: "center",
                    background: alpha(PUBLIC_COLORS.surface, 0.13),
                    borderRadius: PANEL_RADIUS,
                    color: PUBLIC_COLORS.accent,
                    display: "flex",
                    flex: "0 0 30px",
                    height: 30,
                    justifyContent: "center",
                    width: 30,
                  }}
                >
                  <Icon name={file.icon} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <Text
                    style={{
                      color: PUBLIC_COLORS.surface,
                      display: "block",
                    }}
                  >
                    {file.name}
                  </Text>
                  <Text style={{ color: alpha(PUBLIC_COLORS.surface, 0.68) }}>
                    {file.meta}
                  </Text>
                </span>
              </Flex>
            ))}
          </Flex>
        </div>
        <div
          style={{
            background: alpha(PUBLIC_COLORS.surface, 0.94),
            border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.26)}`,
            borderRadius: PANEL_RADIUS,
            color: PUBLIC_COLORS.heading,
            padding: 14,
          }}
        >
          <Text
            strong
            style={{
              color: PUBLIC_COLORS.heading,
              display: "block",
              marginBottom: 10,
            }}
          >
            Shared project state
          </Text>
          <Flex vertical gap={9}>
            {WORKSPACE_PREVIEW_ACTIVITY.map((item) => (
              <Flex align="start" gap={9} key={item.label}>
                <span
                  style={{
                    alignItems: "center",
                    background: `${item.accent}14`,
                    border: `1px solid ${item.accent}33`,
                    borderRadius: PANEL_RADIUS,
                    color: item.accent,
                    display: "flex",
                    flex: "0 0 30px",
                    height: 30,
                    justifyContent: "center",
                    marginTop: 1,
                    width: 30,
                  }}
                >
                  <Icon name={item.icon} />
                </span>
                <span>
                  <Text strong style={{ display: "block" }}>
                    {item.label}
                  </Text>
                  <Text type="secondary">{item.detail}</Text>
                </span>
              </Flex>
            ))}
          </Flex>
        </div>
      </div>
      <div
        aria-label="CoCalc.ai project surface links"
        role="group"
        style={{
          marginTop: 14,
        }}
      >
        <Flex align="baseline" justify="space-between" wrap gap={8}>
          <Text strong style={{ color: PUBLIC_COLORS.surface }}>
            Open from this project
          </Text>
          <Text
            style={{
              color: alpha(PUBLIC_COLORS.surface, 0.68),
              fontSize: 12,
            }}
          >
            One context, multiple surfaces
          </Text>
        </Flex>
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 134px), 1fr))",
            marginTop: 8,
          }}
        >
          <a
            aria-label={projectLabel}
            href={appPath(projectHref)}
            style={{
              alignItems: "start",
              background: alpha(PUBLIC_COLORS.surface, 0.16),
              border: `1px solid ${alpha(PUBLIC_COLORS.accent, 0.3)}`,
              borderRadius: PANEL_RADIUS,
              color: PUBLIC_COLORS.surface,
              display: "inline-flex",
              gap: 7,
              minHeight: 62,
              padding: "9px 10px",
              textDecoration: "none",
            }}
          >
            <DecorativeButtonIcon name="project-outlined" />
            <span style={{ minWidth: 0 }}>
              <Text style={{ color: "inherit", display: "block" }}>
                {projectLabel}
              </Text>
              <Text
                style={{
                  color: alpha(PUBLIC_COLORS.surface, 0.68),
                  display: "block",
                  fontSize: 12,
                }}
              >
                New workspace
              </Text>
            </span>
          </a>
          {WORKSPACE_PREVIEW_TABS.map((tab) => (
            <a
              aria-label={tab.label}
              href={appPath(tab.href)}
              key={tab.label}
              style={{
                alignItems: "start",
                background: alpha(PUBLIC_COLORS.surface, 0.13),
                border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.2)}`,
                borderRadius: PANEL_RADIUS,
                color: PUBLIC_COLORS.surface,
                display: "inline-flex",
                gap: 7,
                minHeight: 62,
                padding: "9px 10px",
                textDecoration: "none",
              }}
            >
              <DecorativeButtonIcon name={tab.icon} />
              <span style={{ minWidth: 0 }}>
                <Text style={{ color: "inherit", display: "block" }}>
                  {tab.label}
                </Text>
                <Text
                  style={{
                    color: alpha(PUBLIC_COLORS.surface, 0.68),
                    display: "block",
                    fontSize: 12,
                  }}
                >
                  {tab.title}
                </Text>
                <Text
                  style={{
                    color: alpha(PUBLIC_COLORS.surface, 0.58),
                    display: "block",
                    fontSize: 12,
                  }}
                >
                  {tab.description}
                </Text>
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function Hero({ config }: { config?: HomeConfig }) {
  const authenticated = !!config?.is_authenticated;

  return (
    <section
      aria-label="CoCalc.ai technical workspace"
      className="cocalc-public-home-hero"
      style={{
        alignItems: "center",
        backgroundImage: `linear-gradient(90deg, ${alpha(
          PUBLIC_COLORS.brandDark,
          0.93,
        )} 0%, ${alpha(PUBLIC_COLORS.brandActive, 0.78)} 46%, ${alpha(
          PUBLIC_COLORS.brandDark,
          0.2,
        )} 100%), url("${HERO_IMAGE_URL}")`,
        backgroundPosition: "center",
        backgroundSize: "cover",
        color: PUBLIC_COLORS.surface,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        minHeight: "66vh",
        padding: `56px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <div
        style={{
          maxWidth: 760,
          width: "100%",
        }}
      >
        <Flex vertical gap={22}>
          <Eyebrow>
            <span style={{ color: PUBLIC_COLORS.accent }}>
              AI-native technical workspace
            </span>
          </Eyebrow>
          <div>
            <Title
              className="cocalc-public-home-hero-title"
              level={1}
              style={{
                color: PUBLIC_COLORS.surface,
                fontSize: 58,
                letterSpacing: 0,
                lineHeight: 1.02,
                margin: 0,
              }}
            >
              CoCalc.ai
            </Title>
            <Paragraph
              className="cocalc-public-home-hero-copy"
              style={{
                color: alpha(PUBLIC_COLORS.surface, 0.9),
                fontSize: 21,
                lineHeight: 1.45,
                margin: "16px 0 0",
                maxWidth: 640,
              }}
            >
              CoCalc.ai keeps notebooks, terminals, files, documents, chat, and
              Codex agent work together in one persistent workspace.
            </Paragraph>
          </div>
          <div
            aria-label="CoCalc.ai project outcomes"
            role="group"
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              maxWidth: 700,
            }}
          >
            {HERO_OUTCOMES.map((item) => (
              <div
                key={item.title}
                style={{
                  alignItems: "start",
                  background: alpha(PUBLIC_COLORS.brandDark, 0.34),
                  border: `1px solid ${alpha(PUBLIC_COLORS.accent, 0.3)}`,
                  borderRadius: PANEL_RADIUS,
                  display: "grid",
                  gap: 9,
                  gridTemplateColumns: "28px minmax(0, 1fr)",
                  minHeight: 102,
                  padding: "12px 13px",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    alignItems: "center",
                    background: alpha(PUBLIC_COLORS.accent, 0.14),
                    border: `1px solid ${alpha(PUBLIC_COLORS.accent, 0.28)}`,
                    borderRadius: PANEL_RADIUS,
                    color: PUBLIC_COLORS.accent,
                    display: "flex",
                    height: 28,
                    justifyContent: "center",
                    marginTop: 1,
                    width: 28,
                  }}
                >
                  <Icon name={item.icon} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <Text
                    strong
                    style={{
                      color: PUBLIC_COLORS.surface,
                      display: "block",
                    }}
                  >
                    {item.title}
                  </Text>
                  <Text
                    style={{
                      color: alpha(PUBLIC_COLORS.surface, 0.76),
                      display: "block",
                    }}
                  >
                    {item.body}
                  </Text>
                </span>
              </div>
            ))}
          </div>
          <Flex
            className="cocalc-public-home-hero-actions"
            gap={12}
            style={{ maxWidth: 740 }}
            wrap
          >
            {authenticated ? (
              <>
                <Button
                  href={appPath("projects")}
                  icon={<DecorativeButtonIcon name="project-outlined" />}
                  size="large"
                  type="primary"
                >
                  Open projects
                </Button>
                <Button
                  ghost
                  href={appPath("features")}
                  icon={<DecorativeButtonIcon name="overview" />}
                  size="large"
                >
                  Explore features
                </Button>
              </>
            ) : (
              <>
                <Button
                  href={appPath("auth/sign-up")}
                  icon={<DecorativeButtonIcon name="rocket" />}
                  size="large"
                  type="primary"
                >
                  Start on CoCalc.ai
                </Button>
                <Button
                  ghost
                  href={appPath("products")}
                  icon={<DecorativeButtonIcon name="project-outlined" />}
                  size="large"
                >
                  Compare deployment options
                </Button>
              </>
            )}
          </Flex>
        </Flex>
      </div>
    </section>
  );
}

function WorkspaceContextSection({
  authenticated,
}: {
  authenticated: boolean;
}) {
  return (
    <section
      aria-label="CoCalc.ai workspace preview"
      style={{
        background: PUBLIC_COLORS.brandDark,
        borderBottom: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.14)}`,
        borderTop: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.14)}`,
        color: PUBLIC_COLORS.surface,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `34px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Row align="middle" gutter={[28, 28]}>
        <Col lg={9} xs={24}>
          <Flex vertical gap={12}>
            <Eyebrow>
              <span style={{ color: PUBLIC_COLORS.accent }}>
                Project workspace
              </span>
            </Eyebrow>
            <Title
              level={2}
              style={{ color: PUBLIC_COLORS.surface, margin: 0 }}
            >
              The project is the unit of work.
            </Title>
            <Paragraph
              style={{
                color: alpha(PUBLIC_COLORS.surface, 0.78),
                fontSize: 18,
                margin: 0,
              }}
            >
              Files, terminals, agent turns, and review history stay close
              enough that the next person can continue from the same record.
            </Paragraph>
          </Flex>
        </Col>
        <Col lg={15} xs={24}>
          <WorkspacePreview authenticated={authenticated} />
        </Col>
      </Row>
    </section>
  );
}

function WorkflowsSection() {
  const workflowSummaries = {
    ai: "Ask Codex to work from project files, terminal output, and review notes.",
    "jupyter-notebook":
      "Run notebooks with shared output, history, and nearby project tools.",
    terminal:
      "Use browser Linux for scripts, packages, services, and debugging.",
  } satisfies Record<(typeof PRIMARY_WORKFLOWS)[number], string>;
  const workflowMeta = {
    ai: { accent: COLORS.AI_ASSISTANT_FONT, icon: "robot", label: "AI agents" },
    "jupyter-notebook": {
      accent: COLORS.RUN,
      icon: "jupyter",
      label: "Compute",
    },
    terminal: {
      accent: COLORS.ANTD_LINK_BLUE_DARK,
      icon: "terminal",
      label: "Linux",
    },
  } satisfies Record<
    (typeof PRIMARY_WORKFLOWS)[number],
    { accent: string; icon: IconName; label: string }
  >;
  const pages = PRIMARY_WORKFLOWS.map((slug) => {
    const page = getFeaturePage(slug);
    return page == null
      ? undefined
      : { ...workflowMeta[slug], page, summary: workflowSummaries[slug] };
  }).filter((item) => item != null);

  return (
    <section aria-label="CoCalc.ai core workflows">
      <Flex align="end" justify="space-between" wrap gap={16}>
        <div style={{ maxWidth: 760 }}>
          <Eyebrow>Core technical workflows</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Start where the work begins.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            Open a notebook, shell, or agent thread without moving the work into
            another system. Writing, teaching, and whiteboards stay nearby.
          </Paragraph>
        </div>
        <Button
          href={appPath("features")}
          icon={<DecorativeButtonIcon name="overview" />}
        >
          Explore all features
        </Button>
      </Flex>
      <Row gutter={[18, 18]} style={{ marginTop: 26 }}>
        <Col lg={8} xs={24}>
          <WorkflowVisualPanel />
        </Col>
        <Col lg={16} xs={24}>
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            }}
          >
            {pages.map(({ accent, icon, label, page, summary }) => (
              <a
                href={appPath(`features/${page.slug}`)}
                key={page.slug}
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PANEL_RADIUS,
                  boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.07)}`,
                  color: "inherit",
                  minHeight: 160,
                  padding: 16,
                  textDecoration: "none",
                }}
              >
                <Flex vertical gap={12}>
                  <Flex align="center" justify="space-between">
                    <div
                      style={{
                        alignItems: "center",
                        background: `${accent}14`,
                        border: `1px solid ${accent}33`,
                        borderRadius: PANEL_RADIUS,
                        color: accent,
                        display: "flex",
                        fontSize: 22,
                        height: 44,
                        justifyContent: "center",
                        width: 44,
                      }}
                    >
                      <Icon name={icon} />
                    </div>
                    <Icon name="arrow-right" style={{ color: accent }} />
                  </Flex>
                  <Tag
                    style={{
                      alignSelf: "flex-start",
                      background: `${accent}12`,
                      borderColor: `${accent}2e`,
                      color: accent,
                      marginInlineEnd: 0,
                    }}
                  >
                    {label}
                  </Tag>
                  <div>
                    <Title level={4} style={{ margin: "0 0 8px" }}>
                      {page.title}
                    </Title>
                    <Paragraph style={{ margin: 0 }}>{summary}</Paragraph>
                  </div>
                </Flex>
              </a>
            ))}
          </div>
        </Col>
      </Row>
    </section>
  );
}

function AudienceSection() {
  const audiences = [
    {
      accent: COLORS.ANTD_LINK_BLUE_DARK,
      body: "Keep source files, service terminals, notebooks, reviews, and Codex threads in the same project when a technical issue needs full context.",
      bullets: [
        "Shared debugging",
        "Agent-assisted patches",
        "Durable project history",
      ],
      href: appPath("features/ai"),
      icon: "code-outlined",
      title: "Engineering teams",
    },
    {
      accent: PUBLIC_COLORS.success,
      body: "Preserve computational environments, notebook output, data files, and collaborator decisions so research work can be inspected later.",
      bullets: [
        "Long-running sessions",
        "Snapshots and backups",
        "Shared notebooks",
      ],
      href: appPath("features/jupyter-notebook"),
      icon: "experiment",
      title: "Research labs",
    },
    {
      accent: PUBLIC_COLORS.warning,
      body: "Run courses and workshops with one browser-based environment for assignments, notebooks, Linux, grading, and student support.",
      bullets: [
        "Course projects",
        "Notebook grading",
        "Consistent lab environment",
      ],
      href: appPath("features/teaching"),
      icon: "graduation-cap",
      title: "Technical courses",
    },
  ] satisfies {
    accent: string;
    body: string;
    bullets: string[];
    href: string;
    icon: IconName;
    title: string;
  }[];

  return (
    <section aria-label="CoCalc.ai audience paths">
      <Flex align="end" justify="space-between" wrap gap={16}>
        <div style={{ maxWidth: 780 }}>
          <Eyebrow>Who CoCalc is for</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Built for technical groups.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            CoCalc works best when a group needs real compute, persistent
            project state, collaboration, and review in one place instead of a
            stack of disconnected tools.
          </Paragraph>
        </div>
        <Button
          href={appPath("features/compare")}
          icon={<DecorativeButtonIcon name="overview" />}
        >
          Compare CoCalc
        </Button>
      </Flex>
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          marginTop: 26,
        }}
      >
        {audiences.map((audience) => (
          <a
            href={audience.href}
            key={audience.title}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.07)}`,
              color: "inherit",
              display: "block",
              minHeight: 270,
              padding: 22,
              textDecoration: "none",
            }}
          >
            <Flex vertical gap={16} style={{ height: "100%" }}>
              <Flex align="center" justify="space-between">
                <div
                  style={{
                    alignItems: "center",
                    background: `${audience.accent}14`,
                    border: `1px solid ${audience.accent}33`,
                    borderRadius: PANEL_RADIUS,
                    color: audience.accent,
                    display: "flex",
                    fontSize: 24,
                    height: 52,
                    justifyContent: "center",
                    width: 52,
                  }}
                >
                  <Icon name={audience.icon} />
                </div>
                <Icon
                  name="arrow-right"
                  style={{ color: audience.accent, fontSize: 18 }}
                />
              </Flex>
              <div>
                <Title level={3} style={{ fontSize: 23, margin: "0 0 10px" }}>
                  {audience.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>{audience.body}</Paragraph>
              </div>
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  marginTop: "auto",
                }}
              >
                {audience.bullets.map((bullet) => (
                  <Flex align="center" gap={8} key={bullet}>
                    <Icon
                      name="check-circle"
                      style={{
                        color: audience.accent,
                        flex: "0 0 auto",
                      }}
                    />
                    <Text>{bullet}</Text>
                  </Flex>
                ))}
              </div>
            </Flex>
          </a>
        ))}
      </div>
    </section>
  );
}

function ProductOptionsSection() {
  const options = [
    {
      bestFor: "Managed accounts, hosted projects, and team access",
      href: appPath(""),
      icon: "cloud",
      nextStep: "Start hosted",
      operator: "Run by CoCalc",
      route: "Hosted service",
      title: "CoCalc.ai",
    },
    {
      bestFor: "One person running CoCalc on their own Linux or Mac machine",
      href: appPath("products/cocalc-plus"),
      icon: "laptop",
      nextStep: "Install locally",
      operator: "Run by you",
      route: "Local runtime",
      title: "CoCalc Plus",
    },
    {
      bestFor: "A lab, class, GPU box, agent sandbox, or small team",
      href: appPath("products/cocalc-star"),
      icon: "star",
      nextStep: "Review Star",
      operator: "Run by VM owner",
      route: "Public VM appliance",
      title: "CoCalc Star",
    },
    {
      bestFor: "A lightweight private deployment with customer control",
      href: appPath("products/cocalc-launchpad"),
      icon: "servers",
      nextStep: "Review Launchpad",
      operator: "Run by your team",
      route: "Private deployment",
      title: "CoCalc Launchpad",
    },
    {
      bestFor:
        "Private cloud planning with customer-operated infrastructure boundaries",
      href: appPath("products/cocalc-rocket"),
      icon: "rocket",
      nextStep: "Plan Rocket",
      operator: "Run with CoCalc",
      route: "Private cloud",
      title: "CoCalc Rocket",
    },
  ] satisfies {
    bestFor: string;
    href: string;
    icon: IconName;
    nextStep: string;
    operator: string;
    route: string;
    title: string;
  }[];
  return (
    <section aria-label="CoCalc.ai product options">
      <Row align="middle" gutter={[32, 32]}>
        <Col lg={10} xs={24}>
          <PublicSection ariaLabel="CoCalc.ai operating path chooser">
            <Eyebrow>Choose how CoCalc runs</Eyebrow>
            <Title level={2} style={{ margin: 0 }}>
              Pick the path first. The workspace stays familiar.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              Choose the operating model that fits the team: hosted, local, or
              customer-operated private deployment. The project workspace model
              stays the same.
            </Paragraph>
            <Flex gap={12} wrap>
              <Button
                href={appPath("products")}
                icon={<DecorativeButtonIcon name="servers" />}
                type="primary"
              >
                Compare deployment options
              </Button>
              <Button
                href={appPath("features")}
                icon={<DecorativeButtonIcon name="overview" />}
              >
                Explore shared features
              </Button>
            </Flex>
          </PublicSection>
        </Col>
        <Col lg={14} xs={24}>
          <div
            style={{
              background: `linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.surfaceMuted} 55%, ${PUBLIC_COLORS.warningTint} 100%)`,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.08)}`,
              padding: 24,
            }}
          >
            <Flex vertical gap={18}>
              <Flex align="center" justify="space-between" wrap gap={12}>
                <Text strong style={{ color: PUBLIC_COLORS.brand }}>
                  Operating path chooser
                </Text>
                <Text type="secondary">Choose who runs the workspace</Text>
              </Flex>
              <div
                style={{
                  display: "grid",
                  gap: 8,
                }}
              >
                <div
                  aria-hidden="true"
                  className="cocalc-public-home-product-header"
                  style={{
                    color: PUBLIC_COLORS.brand,
                    display: "grid",
                    fontSize: 12,
                    fontWeight: 600,
                    gap: 14,
                    gridTemplateColumns:
                      "minmax(176px, 1fr) minmax(112px, 0.62fr) minmax(220px, 1.2fr) minmax(124px, 0.56fr) 18px",
                    padding: "0 14px",
                    textTransform: "uppercase",
                  }}
                >
                  <Text style={{ color: "inherit", fontSize: "inherit" }}>
                    Deployment path
                  </Text>
                  <Text style={{ color: "inherit", fontSize: "inherit" }}>
                    Operator
                  </Text>
                  <Text style={{ color: "inherit", fontSize: "inherit" }}>
                    Best fit
                  </Text>
                  <Text style={{ color: "inherit", fontSize: "inherit" }}>
                    Next step
                  </Text>
                  <span />
                </div>
                {options.map((option, index) => (
                  <a
                    aria-label={`${option.title}: ${option.route}. ${option.operator}. ${option.bestFor}. ${option.nextStep}.`}
                    className="cocalc-public-home-product-row"
                    href={option.href}
                    key={option.title}
                    style={{
                      background: PUBLIC_COLORS.surface,
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: PANEL_RADIUS,
                      color: "inherit",
                      display: "grid",
                      gap: 14,
                      gridTemplateColumns:
                        "minmax(176px, 1fr) minmax(112px, 0.62fr) minmax(220px, 1.2fr) minmax(124px, 0.56fr) 18px",
                      minHeight: 96,
                      padding: "12px 14px",
                      textDecoration: "none",
                    }}
                  >
                    <div
                      className="cocalc-public-home-product-row-path"
                      style={{
                        alignItems: "center",
                        display: "flex",
                        gap: 12,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          alignItems: "center",
                          background:
                            index === 3
                              ? PUBLIC_COLORS.warningTint
                              : PUBLIC_COLORS.surfaceMuted,
                          border:
                            index === 3
                              ? `1px solid ${PUBLIC_COLORS.warningBorder}`
                              : `1px solid ${PUBLIC_COLORS.border}`,
                          borderRadius: PANEL_RADIUS,
                          color:
                            index === 3
                              ? PUBLIC_COLORS.warning
                              : PUBLIC_COLORS.brand,
                          display: "flex",
                          flex: "0 0 44px",
                          fontSize: 20,
                          height: 44,
                          justifyContent: "center",
                          width: 44,
                        }}
                      >
                        <Icon name={option.icon} />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <Text strong style={{ display: "block" }}>
                          {option.title}
                        </Text>
                        <Text type="secondary">{option.route}</Text>
                      </span>
                    </div>
                    <div
                      className="cocalc-public-home-product-row-detail"
                      style={{
                        display: "contents",
                      }}
                    >
                      <span className="cocalc-public-home-product-row-field">
                        <Text
                          strong
                          style={{
                            color: PUBLIC_COLORS.brand,
                            display: "block",
                            fontSize: 12,
                            textTransform: "uppercase",
                          }}
                        >
                          Operator
                        </Text>
                        <Text>{option.operator}</Text>
                      </span>
                      <span className="cocalc-public-home-product-row-field">
                        <Text
                          strong
                          style={{
                            color: PUBLIC_COLORS.brand,
                            display: "block",
                            fontSize: 12,
                            textTransform: "uppercase",
                          }}
                        >
                          Best fit
                        </Text>
                        <Text>{option.bestFor}</Text>
                      </span>
                      <Text
                        className="cocalc-public-home-product-row-next"
                        strong
                        style={{
                          alignSelf: "center",
                          color:
                            index === 3
                              ? PUBLIC_COLORS.warning
                              : PUBLIC_COLORS.brand,
                          justifySelf: "start",
                        }}
                      >
                        {option.nextStep}
                      </Text>
                    </div>
                    <Icon
                      name="arrow-right"
                      style={{
                        alignSelf: "center",
                        color:
                          index === 3
                            ? PUBLIC_COLORS.warning
                            : PUBLIC_COLORS.brand,
                        justifySelf: "end",
                      }}
                    />
                  </a>
                ))}
              </div>
              <div
                style={{
                  background: alpha(PUBLIC_COLORS.surface, 0.78),
                  border: `1px solid ${PUBLIC_COLORS.warningBorder}`,
                  borderRadius: PANEL_RADIUS,
                  padding: 16,
                }}
              >
                <Flex align="start" gap={12}>
                  <div
                    style={{
                      alignItems: "center",
                      background: PUBLIC_COLORS.warningTint,
                      border: `1px solid ${PUBLIC_COLORS.warningBorder}`,
                      borderRadius: PANEL_RADIUS,
                      color: PUBLIC_COLORS.warning,
                      display: "flex",
                      flex: "0 0 42px",
                      fontSize: 20,
                      height: 42,
                      justifyContent: "center",
                      width: 42,
                    }}
                  >
                    <Icon name="bank" />
                  </div>
                  <div>
                    <Text strong style={{ display: "block" }}>
                      Site licensing wraps the path you choose.
                    </Text>
                    <Paragraph style={{ margin: "4px 0 0" }}>
                      Use licensing for procurement, governance, support,
                      rollout, and broader deployment rights after you know
                      where CoCalc should run.
                    </Paragraph>
                  </div>
                </Flex>
              </div>
              <Flex align="center" justify="space-between" wrap gap={12}>
                <Text type="secondary">
                  Start small, then move toward private operation as control
                  requirements grow.
                </Text>
                <Button
                  href={supportPurchasePath(
                    "Site license",
                    "I want to discuss a CoCalc site license.",
                  )}
                  icon={<DecorativeButtonIcon name="bank" />}
                >
                  Discuss site licensing
                </Button>
              </Flex>
              <div
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "auto 1fr auto",
                }}
              >
                <Text type="secondary">Hosted</Text>
                <div
                  style={{
                    background: `linear-gradient(90deg, ${COLORS.BLUE_D} 0%, ${PUBLIC_COLORS.success} 50%, ${PUBLIC_COLORS.warning} 100%)`,
                    borderRadius: 999,
                    height: 4,
                  }}
                />
                <Text type="secondary">Customer-operated</Text>
              </div>
            </Flex>
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
    <section aria-label="CoCalc.ai recent news">
      <Flex align="baseline" justify="space-between" wrap gap={12}>
        <Title level={2} style={{ margin: 0 }}>
          Recent News
        </Title>
        <Button
          href={appPath("news")}
          icon={<DecorativeButtonIcon name="book" />}
        >
          All news
        </Button>
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

function BottomCallout({ config }: { config?: HomeConfig }) {
  const paths = [
    {
      body: "Hosted, managed, self-service.",
      button: config?.is_authenticated ? "Open projects" : "Start on CoCalc.ai",
      href: config?.is_authenticated
        ? appPath("projects")
        : appPath("auth/sign-up"),
      icon: "cloud",
      title: "CoCalc.ai",
    },
    {
      body: "Local runtime for one user.",
      button: "Install CoCalc Plus",
      href: "https://software.cocalc.ai/software/cocalc-plus/index.html",
      icon: "laptop",
      title: "CoCalc Plus",
    },
    {
      body: "Single public VM appliance.",
      button: "Run CoCalc Star",
      href: appPath("products/cocalc-star"),
      icon: "star",
      title: "CoCalc Star",
    },
  ] satisfies {
    body: string;
    button: string;
    href: string;
    icon: IconName;
    title: string;
  }[];
  return (
    <section
      aria-label="CoCalc.ai self-service entry points"
      style={{
        background: `linear-gradient(135deg, ${PUBLIC_COLORS.surfaceMuted} 0%, ${PUBLIC_COLORS.surface} 46%, ${PUBLIC_COLORS.warningTint} 100%)`,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        overflow: "hidden",
        padding: `34px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Flex vertical gap={22}>
        <Row align="bottom" gutter={[32, 24]}>
          <Col xs={24}>
            <Eyebrow>Self-service entry points</Eyebrow>
            <Title level={2} style={{ margin: "8px 0 0" }}>
              Start with a self-service path.
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: 18,
                margin: "12px 0 0",
                maxWidth: 760,
              }}
            >
              Use CoCalc.ai, CoCalc Plus, or CoCalc Star when you want a direct
              self-service path. Compare deployment options and site licensing
              when organizational control, procurement, or private operation
              becomes the next question.
            </Paragraph>
          </Col>
        </Row>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          }}
        >
          {paths.map((path, index) => (
            <div
              key={path.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                display: "flex",
                flexDirection: "column",
                minHeight: 160,
                padding: 18,
              }}
            >
              <Flex align="start" gap={12}>
                <div
                  style={{
                    alignItems: "center",
                    background: PUBLIC_COLORS.surfaceMuted,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PANEL_RADIUS,
                    color: PUBLIC_COLORS.brand,
                    display: "flex",
                    flex: "0 0 44px",
                    fontSize: 20,
                    height: 44,
                    justifyContent: "center",
                    width: 44,
                  }}
                >
                  <Icon name={path.icon} />
                </div>
                <div>
                  <Title level={4} style={{ margin: "0 0 6px" }}>
                    {path.title}
                  </Title>
                  <Paragraph style={{ margin: 0 }}>{path.body}</Paragraph>
                </div>
              </Flex>
              <Button
                href={path.href}
                icon={<DecorativeButtonIcon name={path.icon} />}
                rel={path.href.startsWith("http") ? "noreferrer" : undefined}
                target={path.href.startsWith("http") ? "_blank" : undefined}
                type={index === 0 ? "primary" : "default"}
                style={{ marginTop: "auto", width: "fit-content" }}
              >
                {path.button}
              </Button>
            </div>
          ))}
        </div>
        <Flex align="center" justify="space-between" wrap gap={14}>
          <Text type="secondary">
            Need private deployment beyond one VM or site licensing? Move from
            the self-service entry points to the product chooser.
          </Text>
          <Flex gap={10} wrap>
            <Button
              href={appPath("products")}
              icon={<DecorativeButtonIcon name="servers" />}
            >
              Compare deployment options
            </Button>
            <Button
              href={supportPurchasePath(
                "Site license",
                "I want to discuss a CoCalc site license.",
              )}
              icon={<DecorativeButtonIcon name="bank" />}
            >
              Discuss site licensing
            </Button>
          </Flex>
        </Flex>
      </Flex>
    </section>
  );
}

export default function PublicHomeApp({ config }: { config?: HomeConfig }) {
  const marketingConfig = getPublicMarketingConfig(config);
  const siteName = getPublicMarketingSiteName(config);
  const title = siteName === "CoCalc" ? "CoCalc.ai" : siteName;
  const [news, setNews] = useState<NewsItem[]>();

  useEffect(() => {
    document.title = title;
  }, [title]);

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
    <PublicPage active="home" config={marketingConfig}>
      <style>{HOME_PAGE_CSS}</style>
      <Hero config={config} />
      <WorkspaceContextSection authenticated={!!config?.is_authenticated} />
      <WorkflowsSection />
      <AudienceSection />
      <ProductOptionsSection />
      <NewsSection initialNews={news} />
      <BottomCallout config={config} />
    </PublicPage>
  );
}
