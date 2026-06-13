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
import {
  PUBLIC_COLORS,
  PUBLIC_DISPLAY_FONT_FAMILY,
} from "@cocalc/frontend/public/theme";
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
const PUBLIC_PAGE_GUTTER = "max(16px, calc((100vw - 1200px) / 2))";
const PANEL_RADIUS = 8;
const HERO_SIGNALS = [
  {
    body: "Files, compute, chat, and history",
    icon: "project-outlined",
    title: "Project context",
  },
  {
    body: "Notebooks, shells, packages, and services",
    icon: "terminal",
    title: "Real Linux",
  },
  {
    body: "Codex works beside the source of truth",
    icon: "robot",
    title: "Agents in context",
  },
  {
    body: "TimeTravel, snapshots, and backups",
    icon: "history",
    title: "Recoverable work",
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
  { icon: "files", label: "Files" },
  { icon: "terminal", label: "Terminal" },
  { icon: "robot", label: "Codex" },
  { icon: "history", label: "History" },
] satisfies { icon: IconName; label: string }[];
const QUICK_START_ACTIONS = [
  {
    body: "Run Jupyter with files, terminals, chat, and history in the same project.",
    href: "features/jupyter-notebook",
    icon: "jupyter",
    label: "Notebook project",
  },
  {
    body: "Use a persistent Linux shell for packages, scripts, services, and debugging.",
    href: "features/terminal",
    icon: "terminal",
    label: "Terminal session",
  },
  {
    body: "Ask Codex from project files, terminal output, screenshots, and review notes.",
    href: "features/ai",
    icon: "robot",
    label: "Codex thread",
  },
  {
    body: "Distribute files, collect work, and grade notebooks from course projects.",
    href: "features/teaching",
    icon: "graduation-cap",
    label: "Course workspace",
  },
] satisfies {
  body: string;
  href: string;
  icon: IconName;
  label: string;
}[];

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
        background: alpha(PUBLIC_COLORS.surface, 0.88),
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.08)}`,
        padding: 24,
      }}
    >
      {children}
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
        background: PUBLIC_COLORS.surface,
        borderRadius: PANEL_RADIUS,
        objectFit: "contain",
        width: "100%",
      }}
    />
  );
}

function DecorativeButtonIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex" }}>
      <Icon name={name} />
    </span>
  );
}

function WorkspacePreview() {
  return (
    <div
      aria-label="Live CoCalc project preview"
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
              research-demo
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
          Live context
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
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))",
          marginTop: 12,
        }}
      >
        {WORKSPACE_PREVIEW_TABS.map((tab) => (
          <span
            key={tab.label}
            style={{
              alignItems: "center",
              background: alpha(PUBLIC_COLORS.surface, 0.13),
              border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.2)}`,
              borderRadius: PANEL_RADIUS,
              color: PUBLIC_COLORS.surface,
              display: "inline-flex",
              gap: 7,
              justifyContent: "center",
              minHeight: 36,
              padding: "7px 8px",
            }}
          >
            <Icon name={tab.icon} />
            <Text style={{ color: "inherit" }}>{tab.label}</Text>
          </span>
        ))}
      </div>
    </div>
  );
}

function Hero({ config }: { config?: HomeConfig }) {
  const authenticated = !!config?.is_authenticated;
  return (
    <section
      aria-label="CoCalc.ai technical workspace"
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
          alignItems: "center",
          display: "grid",
          gap: 32,
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
          width: "100%",
        }}
      >
        <div style={{ maxWidth: 720 }}>
          <Flex vertical gap={22}>
            <Eyebrow>
              <span style={{ color: PUBLIC_COLORS.accent }}>
                Persistent projects for people and AI agents
              </span>
            </Eyebrow>
            <div>
              <Title
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
                style={{
                  color: alpha(PUBLIC_COLORS.surface, 0.9),
                  fontSize: 21,
                  lineHeight: 1.45,
                  margin: "16px 0 0",
                  maxWidth: 640,
                }}
              >
                An AI-native technical workspace where notebooks, terminals,
                files, chat, and Codex agent work stay together in one durable
                project.
              </Paragraph>
            </div>
            <Flex gap={12} wrap>
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
                    Compare product paths
                  </Button>
                </>
              )}
              <Button
                ghost
                href={appPath("products/cocalc-plus")}
                icon={<DecorativeButtonIcon name="laptop" />}
                size="large"
              >
                Install CoCalc Plus
              </Button>
            </Flex>
            <div
              style={{
                display: "grid",
                gap: 10,
                gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                marginTop: 8,
                maxWidth: 680,
              }}
            >
              {HERO_SIGNALS.map((item) => (
                <div
                  key={item.title}
                  style={{
                    background: alpha(PUBLIC_COLORS.surface, 0.14),
                    border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.28)}`,
                    borderRadius: PANEL_RADIUS,
                    color: PUBLIC_COLORS.surface,
                    display: "flex",
                    gap: 12,
                    minHeight: 82,
                    padding: "12px 14px",
                  }}
                >
                  <Icon
                    name={item.icon}
                    style={{ flex: "0 0 auto", fontSize: 20, marginTop: 2 }}
                  />
                  <div>
                    <Text strong style={{ color: "inherit", display: "block" }}>
                      {item.title}
                    </Text>
                    <Text style={{ color: alpha(PUBLIC_COLORS.surface, 0.78) }}>
                      {item.body}
                    </Text>
                  </div>
                </div>
              ))}
            </div>
          </Flex>
        </div>
        <div style={{ justifySelf: "end", maxWidth: 540, width: "100%" }}>
          <WorkspacePreview />
        </div>
      </div>
    </section>
  );
}

function QuickStartSection() {
  return (
    <section
      aria-label="Common CoCalc.ai starting points"
      style={{
        background: PUBLIC_COLORS.surface,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `24px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "grid",
          gap: 18,
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
        }}
      >
        <div>
          <Eyebrow>Common starting points</Eyebrow>
          <Title level={2} style={{ fontSize: 28, margin: "8px 0 8px" }}>
            Start with the work surface you need.
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Create one project, then add notebooks, shells, Codex threads, or
            course files around the same durable state.
          </Paragraph>
        </div>
        <div
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          {QUICK_START_ACTIONS.map((action, index) => {
            const featured = index === 2;
            const accent = featured
              ? COLORS.AI_ASSISTANT_FONT
              : index === 3
                ? PUBLIC_COLORS.warning
                : PUBLIC_COLORS.brand;

            return (
              <a
                href={appPath(action.href)}
                key={action.label}
                style={{
                  alignItems: "start",
                  background: featured
                    ? PUBLIC_COLORS.warningTint
                    : PUBLIC_COLORS.surfaceMuted,
                  border: `1px solid ${
                    featured
                      ? PUBLIC_COLORS.warningBorder
                      : PUBLIC_COLORS.border
                  }`,
                  borderRadius: PANEL_RADIUS,
                  color: "inherit",
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "42px minmax(0, 1fr) 18px",
                  minHeight: 126,
                  padding: 14,
                  textDecoration: "none",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    alignItems: "center",
                    background: alpha(PUBLIC_COLORS.surface, 0.82),
                    border: `1px solid ${alpha(accent, 0.24)}`,
                    borderRadius: PANEL_RADIUS,
                    color: accent,
                    display: "flex",
                    fontSize: 20,
                    height: 42,
                    justifyContent: "center",
                    width: 42,
                  }}
                >
                  <Icon name={action.icon} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <Text strong style={{ display: "block" }}>
                    {action.label}
                  </Text>
                  <Text type="secondary">{action.body}</Text>
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    color: accent,
                    marginTop: 4,
                  }}
                >
                  <Icon name="arrow-right" />
                </span>
              </a>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function OperatingModelSection() {
  const items = [
    {
      body: "Files, compute, collaborators, chat, snapshots, and backups move as one project.",
      icon: "project-outlined",
      title: "Project first",
    },
    {
      body: "Notebooks, terminals, editors, and AI agents share the same working directory.",
      icon: "layout",
      title: "Tools together",
    },
    {
      body: "Long-running sessions and review context survive browser refreshes and handoffs.",
      icon: "clock",
      title: "Durable state",
    },
  ] satisfies { body: string; icon: IconName; title: string }[];

  return (
    <section
      style={{
        background: PUBLIC_COLORS.surface,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `22px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
        }}
      >
        {items.map((item) => (
          <Flex align="start" gap={12} key={item.title}>
            <div
              style={{
                alignItems: "center",
                background: PUBLIC_COLORS.surfaceMuted,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                color: PUBLIC_COLORS.brand,
                display: "flex",
                flex: "0 0 42px",
                fontSize: 20,
                height: 42,
                justifyContent: "center",
                width: 42,
              }}
            >
              <Icon name={item.icon} />
            </div>
            <div>
              <Title level={4} style={{ margin: "0 0 6px" }}>
                {item.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>{item.body}</Paragraph>
            </div>
          </Flex>
        ))}
      </div>
    </section>
  );
}

function ProjectLoopSection() {
  const layers = [
    {
      accent: COLORS.ANTD_LINK_BLUE_DARK,
      body: "Keep notebooks, scripts, data, LaTeX, Markdown, and environment files in the same project tree.",
      examples: ["analysis.ipynb", "src/model.py", "paper.tex"],
      icon: "files",
      title: "Source stays together",
    },
    {
      accent: PUBLIC_COLORS.success,
      body: "Run notebooks, terminals, package installs, and services against the same project files.",
      examples: ["run.term", "service.log", "requirements.txt"],
      icon: "terminal",
      title: "Execution shares state",
    },
    {
      accent: COLORS.AI_ASSISTANT_FONT,
      body: "Let Codex work where prompts, patches, screenshots, and review notes remain attached.",
      examples: ["codex thread", "patch review", "screenshots"],
      icon: "robot",
      title: "Agents read context",
    },
    {
      accent: PUBLIC_COLORS.warning,
      body: "Recover with TimeTravel, snapshots, backups, and project history when work needs inspection.",
      examples: ["TimeTravel", "snapshot", "backup"],
      icon: "disk-snapshot",
      title: "Recovery is nearby",
    },
  ] satisfies {
    accent: string;
    body: string;
    examples: string[];
    icon: IconName;
    title: string;
  }[];
  const anchors = [
    { icon: "project-outlined", label: "One project" },
    { icon: "terminal", label: "Shared runtime" },
    { icon: "history", label: "Recoverable state" },
  ] satisfies { icon: IconName; label: string }[];

  return (
    <section
      style={{
        background: PUBLIC_COLORS.surface,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `42px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Row align="middle" gutter={[32, 28]}>
        <Col lg={8} xs={24}>
          <Flex vertical gap={16}>
            <div>
              <Eyebrow>Inside one project</Eyebrow>
              <Title level={2} style={{ margin: "8px 0 10px" }}>
                See the work loop inside a project.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                A CoCalc project is the runtime envelope for source files,
                execution, collaborators, agent work, and recovery. The same
                project can be understood by artifact: what exists, what ran,
                what changed, and how to recover it.
              </Paragraph>
            </div>
            <Flex gap={10} wrap>
              {anchors.map((anchor) => (
                <span
                  key={anchor.label}
                  style={{
                    alignItems: "center",
                    background: PUBLIC_COLORS.surfaceMuted,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PANEL_RADIUS,
                    color: PUBLIC_COLORS.brand,
                    display: "inline-flex",
                    gap: 8,
                    padding: "8px 10px",
                  }}
                >
                  <Icon name={anchor.icon} />
                  <Text>{anchor.label}</Text>
                </span>
              ))}
            </Flex>
          </Flex>
        </Col>
        <Col lg={16} xs={24}>
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            }}
          >
            {layers.map((layer, index) => (
              <div
                key={layer.title}
                style={{
                  background:
                    index === 0
                      ? `linear-gradient(145deg, ${PUBLIC_COLORS.surfaceMuted} 0%, ${PUBLIC_COLORS.surface} 66%)`
                      : PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PANEL_RADIUS,
                  boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.06)}`,
                  minHeight: 250,
                  padding: 20,
                }}
              >
                <Flex vertical gap={14} style={{ height: "100%" }}>
                  <Flex align="center" justify="space-between">
                    <div
                      style={{
                        alignItems: "center",
                        background: `${layer.accent}14`,
                        border: `1px solid ${layer.accent}33`,
                        borderRadius: PANEL_RADIUS,
                        color: layer.accent,
                        display: "flex",
                        fontSize: 24,
                        height: 52,
                        justifyContent: "center",
                        width: 52,
                      }}
                    >
                      <Icon name={layer.icon} />
                    </div>
                    <Text
                      strong
                      style={{
                        color: alpha(PUBLIC_COLORS.brandDark, 0.32),
                        fontFamily: PUBLIC_DISPLAY_FONT_FAMILY,
                        fontSize: 24,
                      }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </Text>
                  </Flex>
                  <div>
                    <Title
                      level={3}
                      style={{ fontSize: 21, margin: "0 0 10px" }}
                    >
                      {layer.title}
                    </Title>
                    <Paragraph style={{ margin: 0 }}>{layer.body}</Paragraph>
                  </div>
                  <Flex gap={8} wrap style={{ marginTop: "auto" }}>
                    {layer.examples.map((example) => (
                      <Text
                        code
                        key={example}
                        style={{
                          background: `${layer.accent}10`,
                          border: `1px solid ${layer.accent}24`,
                          borderRadius: PANEL_RADIUS,
                          color: PUBLIC_COLORS.heading,
                          marginInlineEnd: 0,
                          padding: "3px 7px",
                        }}
                      >
                        {example}
                      </Text>
                    ))}
                  </Flex>
                </Flex>
              </div>
            ))}
          </div>
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
            alt="One CoCalc workspace containing Jupyter, LaTeX, terminal, chat, whiteboard, git review, backups, and collaboration"
            src="/public/landing/project-workflows.jpg"
          />
        </Col>
        <Col lg={12} xs={24}>
          <PublicSection>
            <Eyebrow>The project is the product</Eyebrow>
            <Title level={2} style={{ margin: 0 }}>
              One place for technical work that has to last.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              A project holds the working context: files, compute,
              collaborators, document history, snapshots, backups, and AI agent
              threads.
            </Paragraph>
            <PublicGrid columns={2}>
              <GlassPanel>
                <Title level={4} style={{ marginTop: 0 }}>
                  Work survives the browser
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Notebook output, terminal sessions, file history, and agent
                  context live in the project, not only in a browser tab.
                </Paragraph>
              </GlassPanel>
              <GlassPanel>
                <Title level={4} style={{ marginTop: 0 }}>
                  Everyone shares context
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  People can review notebooks, terminal work, files, chat, and
                  support notes without moving between disconnected tools.
                </Paragraph>
              </GlassPanel>
            </PublicGrid>
          </PublicSection>
        </Col>
      </Row>
    </section>
  );
}

function ProjectFlowSection() {
  const steps = [
    {
      body: "Start with a file tree, compute environment, collaborators, chat, and history in one project.",
      icon: "project-outlined",
      title: "Create a durable project",
    },
    {
      body: "Run notebooks, terminals, editors, services, and package installs against the same project files.",
      icon: "terminal",
      title: "Run the technical work",
    },
    {
      body: "Ask Codex from a project thread where prompts, patches, screenshots, and review notes stay attached.",
      icon: "robot",
      title: "Bring in an agent",
    },
    {
      body: "Use shared state, TimeTravel, snapshots, and backups when humans need to inspect or recover the work.",
      icon: "history",
      title: "Review and recover",
    },
  ] satisfies { body: string; icon: IconName; title: string }[];

  return (
    <section
      style={{
        background: `linear-gradient(135deg, ${PUBLIC_COLORS.brandTint} 0%, ${PUBLIC_COLORS.surface} 55%, ${PUBLIC_COLORS.warningTint} 100%)`,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `42px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Flex vertical gap={22}>
        <Flex align="end" justify="space-between" wrap gap={16}>
          <div style={{ maxWidth: 760 }}>
            <Eyebrow>Project workflow</Eyebrow>
            <Title level={2} style={{ margin: "8px 0 10px" }}>
              From first file to reviewed result.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              CoCalc keeps the environment, conversation, execution, and
              recovery around the project, so a human or agent can pick up work
              without reconstructing context.
            </Paragraph>
          </div>
          <Button
            href={appPath("features/ai")}
            icon={<DecorativeButtonIcon name="robot" />}
          >
            See AI workflows
          </Button>
        </Flex>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          {steps.map((step, index) => (
            <div
              key={step.title}
              style={{
                background: alpha(PUBLIC_COLORS.surface, 0.92),
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.07)}`,
                minHeight: 220,
                padding: 22,
              }}
            >
              <Flex vertical gap={16} style={{ height: "100%" }}>
                <Flex align="center" justify="space-between">
                  <div
                    style={{
                      alignItems: "center",
                      background:
                        index === 2
                          ? PUBLIC_COLORS.warningTint
                          : PUBLIC_COLORS.surfaceMuted,
                      border:
                        index === 2
                          ? `1px solid ${PUBLIC_COLORS.warningBorder}`
                          : `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: PANEL_RADIUS,
                      color:
                        index === 2
                          ? PUBLIC_COLORS.warning
                          : PUBLIC_COLORS.brand,
                      display: "flex",
                      fontSize: 24,
                      height: 52,
                      justifyContent: "center",
                      width: 52,
                    }}
                  >
                    <Icon name={step.icon} />
                  </div>
                  <Text
                    strong
                    style={{
                      color: alpha(PUBLIC_COLORS.brandDark, 0.32),
                      fontFamily: PUBLIC_DISPLAY_FONT_FAMILY,
                      fontSize: 28,
                    }}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </Text>
                </Flex>
                <div>
                  <Title level={3} style={{ fontSize: 21, margin: "0 0 10px" }}>
                    {step.title}
                  </Title>
                  <Paragraph style={{ margin: 0 }}>{step.body}</Paragraph>
                </div>
              </Flex>
            </div>
          ))}
        </div>
      </Flex>
    </section>
  );
}

function WorkflowsSection() {
  const workflowSummaries = {
    ai: "Ask Codex to work from project files, notebook state, terminal output, and review notes.",
    "jupyter-notebook":
      "Run computational notebooks with shared output, history, and nearby project tools.",
    terminal:
      "Use a browser-based Linux shell for scripts, packages, services, and debugging.",
  } satisfies Record<(typeof PRIMARY_WORKFLOWS)[number], string>;
  const workflowMeta = {
    ai: { accent: COLORS.AI_ASSISTANT_FONT, icon: "robot", label: "AI agents" },
    "jupyter-notebook": {
      accent: COLORS.RUN,
      icon: "jupyter",
      label: "Compute",
    },
    "latex-editor": {
      accent: PUBLIC_COLORS.warning,
      icon: "tex",
      label: "Writing",
    },
    teaching: {
      accent: COLORS.RUN,
      icon: "graduation-cap",
      label: "Courses",
    },
    terminal: {
      accent: COLORS.ANTD_LINK_BLUE_DARK,
      icon: "terminal",
      label: "Linux",
    },
    whiteboard: { accent: COLORS.BG_RED, icon: "layout", label: "Visual work" },
  } satisfies Record<string, { accent: string; icon: IconName; label: string }>;
  const pages = PRIMARY_WORKFLOWS.map((slug) => {
    const page = getFeaturePage(slug);
    return page == null
      ? undefined
      : { ...workflowMeta[slug], page, summary: workflowSummaries[slug] };
  }).filter((item) => item != null);

  return (
    <section>
      <Flex align="end" justify="space-between" wrap gap={16}>
        <div style={{ maxWidth: 760 }}>
          <Eyebrow>Core technical workflows</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Start where the work begins.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            Open a notebook, a shell, or an agent thread without setting up a
            separate system. Writing, teaching, whiteboards, and more stay close
            when the workflow expands.
          </Paragraph>
        </div>
        <Button href={appPath("features")}>Explore all features</Button>
      </Flex>
      <Row gutter={[18, 18]} style={{ marginTop: 26 }}>
        <Col lg={6} xs={24}>
          <div
            style={{
              background: `linear-gradient(145deg, ${PUBLIC_COLORS.surfaceMuted} 0%, ${PUBLIC_COLORS.surface} 54%, ${PUBLIC_COLORS.warningTint} 100%)`,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.08)}`,
              height: "100%",
              padding: 22,
            }}
          >
            <Flex vertical gap={18}>
              <Flex align="center" gap={12}>
                <div
                  style={{
                    alignItems: "center",
                    background: PUBLIC_COLORS.surfaceMuted,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PANEL_RADIUS,
                    color: PUBLIC_COLORS.brand,
                    display: "flex",
                    fontSize: 26,
                    height: 58,
                    justifyContent: "center",
                    width: 58,
                  }}
                >
                  <Icon name="project-outlined" />
                </div>
                <div>
                  <Text strong style={{ color: PUBLIC_COLORS.brand }}>
                    Project context
                  </Text>
                  <Paragraph style={{ margin: "3px 0 0" }}>
                    Files, people, history, and recovery travel with each
                    workflow.
                  </Paragraph>
                </div>
              </Flex>
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))",
                }}
              >
                {[
                  { icon: "files", label: "Files" },
                  { icon: "history", label: "History" },
                  { icon: "users", label: "People" },
                  { icon: "disk-snapshot", label: "Recovery" },
                ].map((item) => (
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
                      padding: "10px 12px",
                    }}
                  >
                    <Icon name={item.icon as IconName} />
                    <Text>{item.label}</Text>
                  </div>
                ))}
              </div>
            </Flex>
          </div>
        </Col>
        <Col lg={18} xs={24}>
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
                  minHeight: 178,
                  padding: 18,
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
                        fontSize: 24,
                        height: 50,
                        justifyContent: "center",
                        width: 50,
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
      bullets: ["Course projects", "Notebook grading", "Consistent lab setup"],
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
    <section>
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
        <Button href={appPath("features/compare")}>Compare CoCalc</Button>
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
      bestFor: "Managed accounts, hosted projects, and fast team starts",
      href: appPath(""),
      icon: "cloud",
      operator: "CoCalc",
      title: "CoCalc.ai",
    },
    {
      bestFor: "One person running the workspace model on their own machine",
      href: appPath("products/cocalc-plus"),
      icon: "laptop",
      operator: "Individual",
      title: "CoCalc Plus",
    },
    {
      bestFor: "A lab, class, GPU box, or small team on one public Ubuntu VM",
      href: appPath("products/cocalc-star"),
      icon: "star",
      operator: "VM owner",
      title: "CoCalc Star",
    },
    {
      bestFor: "A private deployment with lightweight customer operations",
      href: appPath("products/cocalc-launchpad"),
      icon: "servers",
      operator: "Customer",
      title: "CoCalc Launchpad",
    },
    {
      bestFor: "Production private cloud operations and multi-bay deployments",
      href: appPath("products/cocalc-rocket"),
      icon: "rocket",
      operator: "Customer cloud",
      title: "CoCalc Rocket",
    },
  ] satisfies {
    bestFor: string;
    href: string;
    icon: IconName;
    operator: string;
    title: string;
  }[];
  return (
    <section>
      <Row align="middle" gutter={[32, 32]}>
        <Col lg={10} xs={24}>
          <PublicSection>
            <Eyebrow>Choose how CoCalc runs</Eyebrow>
            <Title level={2} style={{ margin: 0 }}>
              Pick the path first. The workspace stays familiar.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              Choose how much infrastructure you want to operate: hosted, local,
              public VM, private deployment, or private cloud. The project
              workspace model stays the same.
            </Paragraph>
            <Flex gap={12} wrap>
              <Button href={appPath("products")} type="primary">
                Compare product paths
              </Button>
              <Button href={appPath("features")}>
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
                  Runtime path chooser
                </Text>
                <Text type="secondary">Choose by operator and scope</Text>
              </Flex>
              <div
                style={{
                  display: "grid",
                  gap: 10,
                }}
              >
                {options.map((option, index) => (
                  <a
                    href={option.href}
                    key={option.title}
                    style={{
                      alignItems: "center",
                      background: PUBLIC_COLORS.surface,
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: PANEL_RADIUS,
                      color: "inherit",
                      display: "grid",
                      gap: 14,
                      gridTemplateColumns: "44px minmax(0, 1fr) 18px",
                      padding: "12px 14px",
                      textDecoration: "none",
                    }}
                  >
                    <span
                      style={{
                        alignItems: "center",
                        background:
                          index === 2
                            ? PUBLIC_COLORS.warningTint
                            : PUBLIC_COLORS.surfaceMuted,
                        border:
                          index === 2
                            ? `1px solid ${PUBLIC_COLORS.warningBorder}`
                            : `1px solid ${PUBLIC_COLORS.border}`,
                        borderRadius: PANEL_RADIUS,
                        color:
                          index === 2
                            ? PUBLIC_COLORS.warning
                            : PUBLIC_COLORS.brand,
                        display: "flex",
                        fontSize: 20,
                        height: 44,
                        justifyContent: "center",
                        width: 44,
                      }}
                    >
                      <Icon name={option.icon} />
                    </span>
                    <span>
                      <Text strong style={{ display: "block" }}>
                        {option.title}
                      </Text>
                      <Text type="secondary">{option.operator}</Text>
                    </span>
                    <Text style={{ gridColumn: "2 / 4", gridRow: 2 }}>
                      {option.bestFor}
                    </Text>
                    <Icon
                      name="arrow-right"
                      style={{
                        color:
                          index === 2
                            ? PUBLIC_COLORS.warning
                            : PUBLIC_COLORS.brand,
                        gridColumn: 3,
                        gridRow: 1,
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
                    <Icon name="credit-card" />
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
                <Button href={appPath("pricing")}>Pricing and licensing</Button>
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

function DifferenceSection() {
  const items = [
    {
      body: "Use sudo, apt, Python packages, RootFS images, SSH, and services when the work needs a real system.",
      icon: "linux",
      kicker: "Real environment",
      title: "Real technical environments",
    },
    {
      body: "Run notebooks, commands, terminals, and agent turns with state that survives refreshes and disconnects.",
      icon: "history",
      kicker: "Persistent state",
      title: "Persistent execution",
    },
    {
      body: "Use snapshots, backups, TimeTravel, and project movement to recover work and reuse project state.",
      icon: "disk-snapshot",
      kicker: "Project history",
      title: "Recoverable work",
    },
    {
      body: "Review notebooks, files, terminals, chat, and support work without splitting the team across tools.",
      icon: "users",
      kicker: "Shared operations",
      title: "Team review",
    },
  ] satisfies {
    body: string;
    icon: IconName;
    kicker: string;
    title: string;
  }[];
  const evidence = [
    { icon: "linux", label: "Full Linux" },
    { icon: "history", label: "Long-running state" },
    { icon: "disk-snapshot", label: "Recoverable history" },
  ] satisfies { icon: IconName; label: string }[];
  return (
    <section
      style={{
        background: PUBLIC_COLORS.surfaceMuted,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        overflow: "hidden",
        padding: `42px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Row align="middle" gutter={[36, 36]}>
        <Col lg={9} xs={24}>
          <Flex vertical gap={22}>
            <div>
              <Eyebrow>Why CoCalc is different</Eyebrow>
              <Title level={2} style={{ margin: "8px 0 0" }}>
                More than a thin notebook tab.
              </Title>
            </div>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: 17,
                margin: 0,
              }}
            >
              CoCalc is strongest when work needs a real environment,
              long-running state, recovery, and review, not just a polished
              notebook surface.
            </Paragraph>
            <div
              aria-hidden="true"
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                padding: 18,
              }}
            >
              <Flex vertical gap={14}>
                {evidence.map((item) => (
                  <Flex align="center" gap={12} key={item.label}>
                    <div
                      style={{
                        alignItems: "center",
                        background: PUBLIC_COLORS.surfaceMuted,
                        borderRadius: 999,
                        color: PUBLIC_COLORS.brand,
                        display: "flex",
                        flex: "0 0 32px",
                        height: 32,
                        justifyContent: "center",
                        width: 32,
                      }}
                    >
                      <Icon name={item.icon} />
                    </div>
                    <Text strong>{item.label}</Text>
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
            {items.map((item) => (
              <div
                key={item.title}
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PANEL_RADIUS,
                  boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.08)}`,
                  minHeight: 190,
                  padding: 24,
                }}
              >
                <Flex align="center" justify="space-between">
                  <div
                    style={{
                      alignItems: "center",
                      background: PUBLIC_COLORS.surfaceMuted,
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: PANEL_RADIUS,
                      color: PUBLIC_COLORS.brand,
                      display: "flex",
                      fontSize: 24,
                      height: 52,
                      justifyContent: "center",
                      width: 52,
                    }}
                  >
                    <Icon name={item.icon} />
                  </div>
                </Flex>
                <Text
                  strong
                  style={{
                    color: PUBLIC_COLORS.brand,
                    display: "block",
                    fontSize: 13,
                    letterSpacing: 0,
                    marginBottom: 12,
                    marginTop: 18,
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
      body: "Free local runtime for one user.",
      button: "Install CoCalc Plus",
      href: "https://software.cocalc.ai/software/cocalc-plus/index.html",
      icon: "laptop",
      title: "CoCalc Plus",
    },
    {
      body: "Shared CoCalc on one public VM.",
      button: "Install CoCalc Star",
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
              Start with the simplest path.
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: 18,
                margin: "12px 0 0",
                maxWidth: 760,
              }}
            >
              Use CoCalc.ai, CoCalc Plus, or CoCalc Star when you want to try or
              run CoCalc without planning a private deployment. Launchpad,
              Rocket, and site licensing stay available as needs grow.
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
                    background:
                      index === 2
                        ? PUBLIC_COLORS.warningTint
                        : PUBLIC_COLORS.surfaceMuted,
                    border:
                      index === 2
                        ? `1px solid ${PUBLIC_COLORS.warningBorder}`
                        : `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PANEL_RADIUS,
                    color:
                      index === 2 ? PUBLIC_COLORS.warning : PUBLIC_COLORS.brand,
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
            Need a private deployment or site licensing? Compare product paths
            or contact us.
          </Text>
          <Flex gap={10} wrap>
            <Button href={appPath("products")}>Compare product paths</Button>
            <Button href={appPath("support")}>Support</Button>
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
      <Hero config={config} />
      <QuickStartSection />
      <OperatingModelSection />
      <ProjectLoopSection />
      <ProjectStorySection />
      <ProjectFlowSection />
      <WorkflowsSection />
      <AudienceSection />
      <ProductOptionsSection />
      <DifferenceSection />
      <NewsSection initialNews={news} />
      <BottomCallout config={config} />
    </PublicPage>
  );
}
