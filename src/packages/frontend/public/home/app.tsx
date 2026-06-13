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
`;
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
const HERO_OUTCOMES = [
  {
    body: "The notebook, terminal, source files, and agent notes stay in the same project.",
    icon: "project-outlined",
    title: "Shared context",
  },
  {
    body: "Commands, logs, screenshots, and test output remain close to the proposed change.",
    icon: "check-circle",
    title: "Visible validation",
  },
  {
    body: "TimeTravel, snapshots, and backups make prior project state inspectable.",
    icon: "disk-snapshot",
    title: "Recoverable state",
  },
] satisfies { body: string; icon: IconName; title: string }[];
const HERO_HANDOFF_ITEMS = [
  {
    accent: COLORS.RUN,
    body: "Start from notebooks, scripts, data, terminals, and conversation in one project.",
    href: "features/jupyter-notebook",
    icon: "files",
    label: "Shared context",
    title: "Gather the work",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Open a Codex thread where the files, output, and prior decisions are already nearby.",
    href: "features/ai",
    icon: "robot",
    label: "Agent turn",
    title: "Ask for the change",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Review patches, terminal output, screenshots, and recovery points before moving on.",
    href: "features/compare",
    icon: "history",
    label: "Human review",
    title: "Keep the trail",
  },
] satisfies {
  accent: string;
  body: string;
  href: string;
  icon: IconName;
  label: string;
  title: string;
}[];
const PROJECT_STATE_MAP_ITEMS = [
  {
    accent: PUBLIC_COLORS.brand,
    body: "Notebooks, source files, data, documents, and environment files give the work a shared source of truth.",
    href: "features/compare",
    icon: "files",
    label: "Inputs",
    title: "Project files",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Terminals, package installs, services, logs, and notebook output show what actually ran.",
    href: "features/terminal",
    icon: "terminal",
    label: "Runtime",
    title: "Execution record",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Codex prompts, patches, screenshots, and reviewer notes stay beside the files they refer to.",
    href: "features/ai",
    icon: "robot",
    label: "Agent context",
    title: "Codex trail",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "TimeTravel, snapshots, backups, and project history keep previous state close enough to inspect.",
    href: "features/compare",
    icon: "disk-snapshot",
    label: "Recovery",
    title: "Prior state",
  },
] satisfies {
  accent: string;
  body: string;
  href: string;
  icon: IconName;
  label: string;
  title: string;
}[];
const WORKSPACE_BREADTH_ITEMS = [
  {
    body: "Source files, scripts, and reviews",
    href: "features/compare",
    icon: "code-outlined",
    title: "Code and scripts",
  },
  {
    body: "Computational notebooks with output nearby",
    href: "features/jupyter-notebook",
    icon: "jupyter",
    title: "Notebooks",
  },
  {
    body: "LaTeX, Markdown, whiteboards, and notes",
    href: "features/latex-editor",
    icon: "tex",
    title: "Documents",
  },
  {
    body: "Terminals, files, packages, and services",
    href: "features/terminal",
    icon: "terminal",
    title: "Linux compute",
  },
  {
    body: "Codex threads beside project state",
    href: "features/ai",
    icon: "robot",
    title: "AI agents",
  },
  {
    body: "Collaboration, TimeTravel, and recovery paths",
    href: "features/compare",
    icon: "history",
    title: "Review history",
  },
] satisfies {
  body: string;
  href: string;
  icon: IconName;
  title: string;
}[];
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
const WORKSPACE_PREVIEW_TRAIL = [
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    detail: "Patch against src/model.py",
    icon: "robot",
    label: "Codex proposed",
  },
  {
    accent: PUBLIC_COLORS.success,
    detail: "pytest passed in run.term",
    icon: "check-circle",
    label: "Validation",
  },
  {
    accent: PUBLIC_COLORS.warning,
    detail: "Snapshot ready before merge",
    icon: "disk-snapshot",
    label: "Recovery",
  },
] satisfies {
  accent: string;
  detail: string;
  icon: IconName;
  label: string;
}[];
const WORKSPACE_PREVIEW_HANDOFF = [
  {
    accent: COLORS.RUN,
    detail: "Notebook output and source files stay together.",
    icon: "jupyter",
    label: "Notebook state",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    detail: "Codex reads the same project context.",
    icon: "robot",
    label: "Agent request",
  },
  {
    accent: PUBLIC_COLORS.success,
    detail: "Terminal result and reviewer notes are visible.",
    icon: "clipboard-check",
    label: "Review notes",
  },
] satisfies {
  accent: string;
  detail: string;
  icon: IconName;
  label: string;
}[];
const WORKSPACE_PREVIEW_TABS = [
  {
    href: "features/compare",
    icon: "files",
    label: "Files",
    title: "File tree",
  },
  {
    href: "features/terminal",
    icon: "terminal",
    label: "Run",
    title: "Linux terminal",
  },
  {
    href: "features/ai",
    icon: "robot",
    label: "Ask",
    title: "Agent turn",
  },
  {
    href: "features/compare",
    icon: "history",
    label: "Review",
    title: "History trail",
  },
] satisfies { href: string; icon: IconName; label: string; title: string }[];
const WORKFLOW_CONTEXT_ITEMS = [
  { icon: "files", label: "Files" },
  { icon: "history", label: "History" },
  { icon: "users", label: "People" },
  { icon: "disk-snapshot", label: "Recovery" },
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
const PROJECT_PACKAGE_ITEMS = [
  {
    accent: PUBLIC_COLORS.brand,
    body: "Notebooks, editors, documents, whiteboards, and chat open around one project tree.",
    href: "features/compare",
    icon: "files",
    items: ["Files", "Documents", "Project chat"],
    title: "Files and tools",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Terminals, package installs, scripts, services, and notebooks use the same working directory.",
    href: "features/terminal",
    icon: "terminal",
    items: ["Linux shell", "Packages", "Services"],
    title: "Linux runtime",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Codex threads, prompts, patches, screenshots, and collaborator decisions stay attached.",
    href: "features/ai",
    icon: "robot",
    items: ["Codex", "Reviews", "Support notes"],
    title: "People and agents",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "TimeTravel, snapshots, backups, and product paths keep work inspectable and movable.",
    href: "features/compare",
    icon: "disk-snapshot",
    items: ["TimeTravel", "Snapshots", "Backups"],
    title: "Recovery and operations",
  },
] satisfies {
  accent: string;
  body: string;
  href: string;
  icon: IconName;
  items: string[];
  title: string;
}[];
const PROJECT_RECIPE_ITEMS = [
  {
    accent: COLORS.RUN,
    body: "Keep the notebook, data files, package installs, plots, and review notes together.",
    href: "features/jupyter-notebook",
    icon: "jupyter",
    steps: [
      "Upload data and open a notebook.",
      "Run packages and scripts beside the same files.",
      "Save outputs, comments, and recovery history.",
    ],
    title: "Analyze data",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Use a persistent shell with source files, logs, services, and fixes in one project.",
    href: "features/terminal",
    icon: "terminal",
    steps: [
      "Open a terminal in the project tree.",
      "Install packages, run services, and inspect logs.",
      "Keep the debug trail with the changed files.",
    ],
    title: "Debug a service",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Ask Codex from the project where code, output, screenshots, and decisions live.",
    href: "features/ai",
    icon: "robot",
    steps: [
      "Describe the change with the files nearby.",
      "Review patches against terminal output.",
      "Leave notes for the next human or agent turn.",
    ],
    title: "Ship a patch",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Give students one browser-based place for files, notebooks, Linux, grading, and help.",
    href: "features/teaching",
    icon: "graduation-cap",
    steps: [
      "Create course and student projects.",
      "Distribute notebooks and supporting files.",
      "Collect, grade, and support from project context.",
    ],
    title: "Run a lab",
  },
] satisfies {
  accent: string;
  body: string;
  href: string;
  icon: IconName;
  steps: string[];
  title: string;
}[];
const BOUNDARY_LINK_ITEMS = [
  {
    accent: PUBLIC_COLORS.brand,
    body: "Use the trust policy for current public trust references.",
    href: "policies/trust",
    icon: "lock-outlined",
    title: "Trust policy",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Use the Plus page for local-runtime install and data-flow context.",
    href: "products/cocalc-plus",
    icon: "laptop",
    title: "CoCalc Plus details",
  },
  {
    accent: PUBLIC_COLORS.success,
    body: "Use support when rollout, onboarding, or account-specific questions need a person.",
    href: "support",
    icon: "question-circle",
    title: "Support path",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Use the product comparison for hosted, local, and customer-operated paths.",
    href: "products",
    icon: "servers",
    title: "Deployment comparison",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Use support for hosted transition questions instead of relying on homepage copy.",
    href: "support",
    icon: "sync-alt",
    title: "Hosted transition questions",
  },
] satisfies {
  accent: string;
  body: string;
  href: string;
  icon: IconName;
  title: string;
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
          background: alpha(PUBLIC_COLORS.surface, 0.92),
          border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.3)}`,
          borderRadius: PANEL_RADIUS,
          color: PUBLIC_COLORS.heading,
          marginTop: 12,
          padding: 12,
        }}
      >
        <Flex align="center" justify="space-between" wrap gap={8}>
          <Text strong style={{ color: PUBLIC_COLORS.heading }}>
            Handoff queue
          </Text>
          <Text type="secondary">Work moves with context</Text>
        </Flex>
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
            marginTop: 10,
          }}
        >
          {WORKSPACE_PREVIEW_HANDOFF.map((item) => (
            <Flex align="start" gap={8} key={item.label}>
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: alpha(item.accent, 0.1),
                  border: `1px solid ${alpha(item.accent, 0.24)}`,
                  borderRadius: PANEL_RADIUS,
                  color: item.accent,
                  display: "flex",
                  flex: "0 0 28px",
                  height: 28,
                  justifyContent: "center",
                  marginTop: 1,
                  width: 28,
                }}
              >
                <Icon name={item.icon} />
              </span>
              <span style={{ minWidth: 0 }}>
                <Text strong style={{ display: "block" }}>
                  {item.label}
                </Text>
                <Text type="secondary">{item.detail}</Text>
              </span>
            </Flex>
          ))}
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
        <a
          href={appPath(projectHref)}
          style={{
            alignItems: "center",
            background: alpha(PUBLIC_COLORS.surface, 0.16),
            border: `1px solid ${alpha(PUBLIC_COLORS.accent, 0.3)}`,
            borderRadius: PANEL_RADIUS,
            color: PUBLIC_COLORS.surface,
            display: "inline-flex",
            gap: 7,
            justifyContent: "center",
            minHeight: 36,
            padding: "7px 8px",
            textDecoration: "none",
          }}
        >
          <DecorativeButtonIcon name="project-outlined" />
          <Text style={{ color: "inherit" }}>{projectLabel}</Text>
        </a>
        {WORKSPACE_PREVIEW_TABS.map((tab) => (
          <a
            href={appPath(tab.href)}
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
            </span>
          </a>
        ))}
      </div>
      <div
        style={{
          background: alpha(PUBLIC_COLORS.brandDark, 0.42),
          border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.2)}`,
          borderRadius: PANEL_RADIUS,
          marginTop: 12,
          padding: 12,
        }}
      >
        <Flex align="center" justify="space-between" wrap gap={8}>
          <Text strong style={{ color: PUBLIC_COLORS.surface }}>
            Current trail
          </Text>
          <Text style={{ color: alpha(PUBLIC_COLORS.surface, 0.68) }}>
            Prompt to reviewed state
          </Text>
        </Flex>
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
            marginTop: 10,
          }}
        >
          {WORKSPACE_PREVIEW_TRAIL.map((item) => (
            <Flex align="start" gap={8} key={item.label}>
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: alpha(item.accent, 0.18),
                  border: `1px solid ${alpha(item.accent, 0.34)}`,
                  borderRadius: PANEL_RADIUS,
                  color: item.accent,
                  display: "flex",
                  flex: "0 0 28px",
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
                  style={{ color: PUBLIC_COLORS.surface, display: "block" }}
                >
                  {item.label}
                </Text>
                <Text style={{ color: alpha(PUBLIC_COLORS.surface, 0.72) }}>
                  {item.detail}
                </Text>
              </span>
            </Flex>
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
                A technical workspace where the notebook, shell, source tree,
                chat, and Codex thread stay in the same recoverable project.
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
              <Button
                ghost
                href={appPath("products/cocalc-plus")}
                icon={<DecorativeButtonIcon name="laptop" />}
                size="large"
              >
                Install CoCalc Plus
              </Button>
              <Button
                ghost
                href={supportPurchasePath(
                  "Site license",
                  "I want to discuss a CoCalc site license.",
                )}
                icon={<DecorativeButtonIcon name="bank" />}
                size="large"
              >
                Discuss site licensing
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
          <WorkspacePreview authenticated={authenticated} />
        </div>
      </div>
    </section>
  );
}

function HeroHandoffStrip({ config }: { config?: HomeConfig }) {
  const authenticated = !!config?.is_authenticated;
  const entryPoints = [
    {
      accent: PUBLIC_COLORS.brand,
      action: authenticated ? "Open hosted projects" : "Start hosted project",
      body: "Managed projects for notebooks, terminals, files, collaborators, and Codex without operating infrastructure.",
      href: authenticated ? "projects" : "auth/sign-up",
      icon: "cloud",
      label: "Hosted",
      title: "CoCalc.ai",
    },
    {
      accent: COLORS.ANTD_LINK_BLUE_DARK,
      action: "Review local runtime",
      body: "A local single-user path when the workspace should run on your own computer.",
      href: "products/cocalc-plus",
      icon: "laptop",
      label: "Local",
      title: "CoCalc Plus",
    },
    {
      accent: PUBLIC_COLORS.warning,
      action: "Compare deployment paths",
      body: "Hosted, local, Launchpad, Rocket, and licensing paths when the operator boundary matters.",
      href: "products",
      icon: "servers",
      label: "Organization",
      title: "Deployment options",
    },
  ] satisfies {
    accent: string;
    action: string;
    body: string;
    href: string;
    icon: IconName;
    label: string;
    title: string;
  }[];

  return (
    <section
      aria-label="CoCalc.ai project handoff path"
      style={{
        background: PUBLIC_COLORS.surface,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `22px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Flex vertical gap={18}>
        <div
          style={{
            alignItems: "stretch",
            display: "grid",
            gap: 12,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
          }}
        >
          {entryPoints.map((item) => (
            <a
              href={appPath(item.href)}
              key={item.title}
              style={{
                alignItems: "start",
                background:
                  item.title === "Deployment options"
                    ? PUBLIC_COLORS.warningTint
                    : PUBLIC_COLORS.surfaceMuted,
                border: `1px solid ${alpha(item.accent, 0.24)}`,
                borderRadius: PANEL_RADIUS,
                color: "inherit",
                display: "grid",
                gap: 12,
                gridTemplateColumns: "44px minmax(0, 1fr)",
                minHeight: 136,
                padding: 15,
                textDecoration: "none",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: alpha(PUBLIC_COLORS.surface, 0.86),
                  border: `1px solid ${alpha(item.accent, 0.26)}`,
                  borderRadius: PANEL_RADIUS,
                  color: item.accent,
                  display: "flex",
                  fontSize: 21,
                  height: 44,
                  justifyContent: "center",
                  width: 44,
                }}
              >
                <Icon name={item.icon} />
              </span>
              <span style={{ minWidth: 0 }}>
                <Text
                  strong
                  style={{
                    color: item.accent,
                    display: "block",
                    fontSize: 12,
                    letterSpacing: 0,
                    textTransform: "uppercase",
                  }}
                >
                  {item.label}
                </Text>
                <Title level={3} style={{ fontSize: 19, margin: "4px 0 6px" }}>
                  {item.title}
                </Title>
                <Text type="secondary">{item.body}</Text>
                <Text
                  strong
                  style={{
                    alignItems: "center",
                    color: item.accent,
                    display: "inline-flex",
                    gap: 6,
                    marginTop: 10,
                  }}
                >
                  {item.action}
                  <Icon name="arrow-right" />
                </Text>
              </span>
            </a>
          ))}
        </div>
        <div
          style={{
            alignItems: "center",
            display: "grid",
            gap: 18,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
          }}
        >
          <div>
            <Eyebrow>Project handoff path</Eyebrow>
            <Title level={2} style={{ fontSize: 24, margin: "6px 0 0" }}>
              Move from context to agent work without leaving the project.
            </Title>
          </div>
          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            }}
          >
            {HERO_HANDOFF_ITEMS.map((item, index) => (
              <a
                href={appPath(item.href)}
                key={item.title}
                style={{
                  alignItems: "start",
                  background:
                    index === 1
                      ? PUBLIC_COLORS.warningTint
                      : PUBLIC_COLORS.surfaceMuted,
                  border: `1px solid ${
                    index === 1
                      ? PUBLIC_COLORS.warningBorder
                      : alpha(item.accent, 0.22)
                  }`,
                  borderRadius: PANEL_RADIUS,
                  color: "inherit",
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "42px minmax(0, 1fr)",
                  minHeight: 134,
                  padding: 14,
                  textDecoration: "none",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    alignItems: "center",
                    background: alpha(PUBLIC_COLORS.surface, 0.84),
                    border: `1px solid ${alpha(item.accent, 0.26)}`,
                    borderRadius: PANEL_RADIUS,
                    color: item.accent,
                    display: "flex",
                    fontSize: 20,
                    height: 42,
                    justifyContent: "center",
                    width: 42,
                  }}
                >
                  <Icon name={item.icon} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <Text
                    strong
                    style={{
                      color: item.accent,
                      display: "block",
                      fontSize: 12,
                      letterSpacing: 0,
                      textTransform: "uppercase",
                    }}
                  >
                    {item.label}
                  </Text>
                  <Text strong style={{ display: "block", marginTop: 4 }}>
                    {item.title}
                  </Text>
                  <Text type="secondary">{item.body}</Text>
                </span>
              </a>
            ))}
          </div>
        </div>
      </Flex>
    </section>
  );
}

function ProofStripSection() {
  return (
    <section
      aria-label="CoCalc.ai workspace breadth"
      style={{
        background: PUBLIC_COLORS.surface,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `18px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "grid",
          gap: 16,
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
        }}
      >
        <div>
          <Eyebrow>Workspace breadth</Eyebrow>
          <Title level={2} style={{ fontSize: 24, margin: "6px 0 0" }}>
            One project context for the work that technical teams pass around.
          </Title>
        </div>
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          }}
        >
          {WORKSPACE_BREADTH_ITEMS.map((item) => (
            <a
              href={appPath(item.href)}
              key={item.title}
              style={{
                alignItems: "start",
                background: PUBLIC_COLORS.surfaceMuted,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                color: "inherit",
                display: "grid",
                gap: 10,
                gridTemplateColumns: "34px minmax(0, 1fr)",
                minHeight: 88,
                padding: "11px 12px",
                textDecoration: "none",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: alpha(PUBLIC_COLORS.surface, 0.82),
                  border: `1px solid ${alpha(PUBLIC_COLORS.brand, 0.2)}`,
                  borderRadius: PANEL_RADIUS,
                  color: PUBLIC_COLORS.brand,
                  display: "flex",
                  fontSize: 17,
                  height: 34,
                  justifyContent: "center",
                  width: 34,
                }}
              >
                <Icon name={item.icon} />
              </span>
              <span style={{ minWidth: 0 }}>
                <Text strong style={{ display: "block" }}>
                  {item.title}
                </Text>
                <Text type="secondary">{item.body}</Text>
              </span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProjectStateMapSection() {
  return (
    <section
      aria-label="CoCalc.ai project state map"
      style={{
        background: `linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.brandTint} 58%, ${PUBLIC_COLORS.surface} 100%)`,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `38px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Row align="middle" gutter={[30, 24]}>
        <Col lg={8} xs={24}>
          <Flex vertical gap={16}>
            <div>
              <Eyebrow>Project state map</Eyebrow>
              <Title level={2} style={{ margin: "8px 0 10px" }}>
                Show what a teammate or agent can inspect.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                CoCalc projects keep the artifacts of technical work in one
                place, so the next person or Codex turn can read the files,
                runtime output, decisions, and recovery points together.
              </Paragraph>
            </div>
            <Flex gap={12} wrap>
              <Button
                href={appPath("features")}
                icon={<DecorativeButtonIcon name="overview" />}
                type="primary"
              >
                Explore shared features
              </Button>
              <Button
                href={appPath("features/ai")}
                icon={<DecorativeButtonIcon name="robot" />}
              >
                See AI workflows
              </Button>
            </Flex>
          </Flex>
        </Col>
        <Col lg={16} xs={24}>
          <div
            aria-label="Project state checkpoints"
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            }}
          >
            {PROJECT_STATE_MAP_ITEMS.map((item, index) => (
              <a
                href={appPath(item.href)}
                key={item.title}
                style={{
                  background:
                    index === 2
                      ? PUBLIC_COLORS.warningTint
                      : alpha(PUBLIC_COLORS.surface, 0.94),
                  border: `1px solid ${
                    index === 2
                      ? PUBLIC_COLORS.warningBorder
                      : alpha(item.accent, 0.24)
                  }`,
                  borderRadius: PANEL_RADIUS,
                  boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.06)}`,
                  color: "inherit",
                  display: "grid",
                  gap: 14,
                  gridTemplateColumns: "50px minmax(0, 1fr)",
                  minHeight: 176,
                  padding: 18,
                  textDecoration: "none",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    alignItems: "center",
                    background: alpha(PUBLIC_COLORS.surface, 0.84),
                    border: `1px solid ${alpha(item.accent, 0.28)}`,
                    borderRadius: PANEL_RADIUS,
                    color: item.accent,
                    display: "flex",
                    fontSize: 22,
                    height: 50,
                    justifyContent: "center",
                    width: 50,
                  }}
                >
                  <Icon name={item.icon} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <Tag
                    style={{
                      background: alpha(item.accent, 0.1),
                      borderColor: alpha(item.accent, 0.28),
                      color: item.accent,
                      marginInlineEnd: 0,
                    }}
                  >
                    {item.label}
                  </Tag>
                  <Title
                    level={3}
                    style={{ fontSize: 20, margin: "10px 0 8px" }}
                  >
                    {item.title}
                  </Title>
                  <Text type="secondary">{item.body}</Text>
                </span>
              </a>
            ))}
          </div>
        </Col>
      </Row>
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

function StarterRecipesSection({ config }: { config?: HomeConfig }) {
  const projectHref = config?.is_authenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const projectLabel = config?.is_authenticated
    ? "Open projects"
    : "Start a project";

  return (
    <section
      aria-label="CoCalc.ai starter project recipes"
      style={{
        background: `linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.brandTint} 58%, ${PUBLIC_COLORS.warningTint} 100%)`,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `36px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Flex vertical gap={22}>
        <Flex align="end" justify="space-between" wrap gap={16}>
          <div style={{ maxWidth: 780 }}>
            <Eyebrow>Starter project recipes</Eyebrow>
            <Title level={2} style={{ margin: "8px 0 10px" }}>
              Pick a starter recipe, then grow the project.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              CoCalc projects do not force an early choice between notebook,
              terminal, course, or agent workflows. Start with the first job,
              then add the surrounding tools as the work gets real.
            </Paragraph>
          </div>
          <Button
            href={projectHref}
            icon={<DecorativeButtonIcon name="project-outlined" />}
            type="primary"
          >
            {projectLabel}
          </Button>
        </Flex>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          }}
        >
          {PROJECT_RECIPE_ITEMS.map((recipe) => (
            <a
              href={appPath(recipe.href)}
              key={recipe.title}
              style={{
                background: alpha(PUBLIC_COLORS.surface, 0.92),
                border: `1px solid ${alpha(recipe.accent, 0.24)}`,
                borderRadius: PANEL_RADIUS,
                boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.06)}`,
                color: "inherit",
                display: "block",
                minHeight: 286,
                padding: 20,
                textDecoration: "none",
              }}
            >
              <Flex vertical gap={15} style={{ height: "100%" }}>
                <Flex align="center" justify="space-between" gap={12}>
                  <span
                    aria-hidden="true"
                    style={{
                      alignItems: "center",
                      background: alpha(recipe.accent, 0.1),
                      border: `1px solid ${alpha(recipe.accent, 0.28)}`,
                      borderRadius: PANEL_RADIUS,
                      color: recipe.accent,
                      display: "flex",
                      flex: "0 0 52px",
                      fontSize: 24,
                      height: 52,
                      justifyContent: "center",
                      width: 52,
                    }}
                  >
                    <Icon name={recipe.icon} />
                  </span>
                  <Icon
                    name="arrow-right"
                    style={{ color: recipe.accent, fontSize: 18 }}
                  />
                </Flex>
                <div>
                  <Title level={3} style={{ fontSize: 22, margin: "0 0 8px" }}>
                    {recipe.title}
                  </Title>
                  <Paragraph style={{ margin: 0 }}>{recipe.body}</Paragraph>
                </div>
                <div
                  style={{
                    display: "grid",
                    gap: 8,
                    marginTop: "auto",
                  }}
                >
                  {recipe.steps.map((step, index) => (
                    <Flex align="start" gap={8} key={step}>
                      <Text
                        strong
                        style={{
                          color: recipe.accent,
                          flex: "0 0 22px",
                          fontFamily: PUBLIC_DISPLAY_FONT_FAMILY,
                        }}
                      >
                        {index + 1}
                      </Text>
                      <Text>{step}</Text>
                    </Flex>
                  ))}
                </div>
              </Flex>
            </a>
          ))}
        </div>
      </Flex>
    </section>
  );
}

function ProjectPackageSection() {
  return (
    <section
      aria-label="What every CoCalc project includes"
      style={{
        background: `linear-gradient(135deg, ${PUBLIC_COLORS.brandTint} 0%, ${PUBLIC_COLORS.surface} 58%, ${PUBLIC_COLORS.warningTint} 100%)`,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `38px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Flex vertical gap={22}>
        <Flex align="end" justify="space-between" wrap gap={16}>
          <div style={{ maxWidth: 760 }}>
            <Eyebrow>What travels with a project</Eyebrow>
            <Title level={2} style={{ margin: "8px 0 10px" }}>
              Every project brings the workspace with it.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              CoCalc keeps technical work packaged around the project instead of
              spreading context across separate notebook, terminal, chat,
              recovery, and deployment systems.
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
            gap: 14,
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          }}
        >
          {PROJECT_PACKAGE_ITEMS.map((item) => (
            <a
              href={appPath(item.href)}
              key={item.title}
              style={{
                background: alpha(PUBLIC_COLORS.surface, 0.9),
                border: `1px solid ${alpha(item.accent, 0.24)}`,
                borderRadius: PANEL_RADIUS,
                boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.06)}`,
                color: "inherit",
                display: "block",
                minHeight: 248,
                padding: 20,
                textDecoration: "none",
              }}
            >
              <Flex vertical gap={14} style={{ height: "100%" }}>
                <Flex align="center" justify="space-between">
                  <div
                    style={{
                      alignItems: "center",
                      background: alpha(item.accent, 0.1),
                      border: `1px solid ${alpha(item.accent, 0.28)}`,
                      borderRadius: PANEL_RADIUS,
                      color: item.accent,
                      display: "flex",
                      fontSize: 24,
                      height: 52,
                      justifyContent: "center",
                      width: 52,
                    }}
                  >
                    <Icon name={item.icon} />
                  </div>
                  <Icon
                    name="arrow-right"
                    style={{ color: item.accent, fontSize: 18 }}
                  />
                </Flex>
                <div>
                  <Title level={3} style={{ fontSize: 21, margin: "0 0 10px" }}>
                    {item.title}
                  </Title>
                  <Paragraph style={{ margin: 0 }}>{item.body}</Paragraph>
                </div>
                <Flex gap={8} wrap style={{ marginTop: "auto" }}>
                  {item.items.map((label) => (
                    <Text
                      key={label}
                      style={{
                        background: alpha(item.accent, 0.08),
                        border: `1px solid ${alpha(item.accent, 0.18)}`,
                        borderRadius: PANEL_RADIUS,
                        color: PUBLIC_COLORS.heading,
                        padding: "4px 8px",
                      }}
                    >
                      {label}
                    </Text>
                  ))}
                </Flex>
              </Flex>
            </a>
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
    <section aria-label="CoCalc.ai core workflows">
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
      bestFor: "Managed accounts, hosted projects, and team access",
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
      bestFor: "A private deployment with lightweight customer operations",
      href: appPath("products/cocalc-launchpad"),
      icon: "servers",
      operator: "Customer",
      title: "CoCalc Launchpad",
    },
    {
      bestFor:
        "Enterprise private deployment planning with customer-operated infrastructure boundaries",
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
              <Button href={appPath("products")} type="primary">
                Compare deployment options
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

function BoundaryRoutingSection() {
  return (
    <section
      aria-label="Homepage boundary and detail routes"
      style={{
        background: PUBLIC_COLORS.surfaceMuted,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `34px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Row align="middle" gutter={[32, 24]}>
        <Col lg={8} xs={24}>
          <Flex vertical gap={14}>
            <Eyebrow>Boundaries and detail pages</Eyebrow>
            <Title level={2} style={{ margin: 0 }}>
              Keep the operating boundaries visible.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              Hosted, local, and customer-operated paths differ in operator
              responsibility, data flow, and support path. Use the detail pages
              for the current terms instead of treating the homepage as the
              contract.
            </Paragraph>
          </Flex>
        </Col>
        <Col lg={16} xs={24}>
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            }}
          >
            {BOUNDARY_LINK_ITEMS.map((item) => (
              <a
                href={appPath(item.href)}
                key={item.title}
                style={{
                  alignItems: "start",
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${alpha(item.accent, 0.24)}`,
                  borderRadius: PANEL_RADIUS,
                  color: "inherit",
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "42px minmax(0, 1fr) 18px",
                  minHeight: 128,
                  padding: 16,
                  textDecoration: "none",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    alignItems: "center",
                    background: alpha(item.accent, 0.09),
                    border: `1px solid ${alpha(item.accent, 0.24)}`,
                    borderRadius: PANEL_RADIUS,
                    color: item.accent,
                    display: "flex",
                    fontSize: 20,
                    height: 42,
                    justifyContent: "center",
                    width: 42,
                  }}
                >
                  <Icon name={item.icon} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <Text strong style={{ display: "block" }}>
                    {item.title}
                  </Text>
                  <Text type="secondary">{item.body}</Text>
                </span>
                <Icon
                  name="arrow-right"
                  style={{
                    color: item.accent,
                    fontSize: 16,
                    marginTop: 3,
                  }}
                />
              </a>
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
    <section aria-label="CoCalc.ai recent news">
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
      body: "Local runtime for one user.",
      button: "Install CoCalc Plus",
      href: "https://software.cocalc.ai/software/cocalc-plus/index.html",
      icon: "laptop",
      title: "CoCalc Plus",
    },
    {
      body: "Hosted, local, or customer-operated private paths.",
      button: "Compare deployment options",
      href: appPath("products"),
      icon: "servers",
      title: "Deployment options",
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
              Use CoCalc.ai or CoCalc Plus when you want a direct self-service
              path. Compare deployment options and site licensing when
              organizational control, procurement, or private operation becomes
              the next question.
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
            Need a private deployment or site licensing? Compare operating
            models or ask sales about organizational rollout.
          </Text>
          <Flex gap={10} wrap>
            <Button href={appPath("products")}>
              Compare deployment options
            </Button>
            <Button
              href={supportPurchasePath(
                "Site license",
                "I want to discuss a CoCalc site license.",
              )}
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
      <HeroHandoffStrip config={config} />
      <ProofStripSection />
      <ProjectStateMapSection />
      <QuickStartSection />
      <StarterRecipesSection config={config} />
      <ProjectPackageSection />
      <WorkflowsSection />
      <AudienceSection />
      <ProductOptionsSection />
      <BoundaryRoutingSection />
      <NewsSection initialNews={news} />
      <BottomCallout config={config} />
    </PublicPage>
  );
}
