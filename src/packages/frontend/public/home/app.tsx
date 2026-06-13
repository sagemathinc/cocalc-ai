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

  @media (max-width: 960px) {
    .cocalc-public-home-hero-inner {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    .cocalc-public-home-hero-snapshot {
      justify-self: start !important;
      max-width: 640px !important;
    }
  }

  @media (max-width: 520px) {
    .cocalc-public-home-hero-trail-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }

    .cocalc-public-home-hero-snapshot-grid {
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }

  @media (max-width: 840px) {
    .cocalc-public-home-audience-header {
      display: none !important;
    }

    .cocalc-public-home-audience-row {
      grid-template-columns: 44px minmax(0, 1fr) 18px !important;
    }

    .cocalc-public-home-audience-row-context,
    .cocalc-public-home-audience-row-use {
      grid-column: 1 / -1 !important;
    }

    .cocalc-public-home-audience-row-next {
      grid-column: 1 / 3 !important;
      justify-self: start !important;
    }

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
const HERO_CONTEXT_SIGNALS = [
  {
    body: "Source, notebooks, data",
    href: "features/compare",
    icon: "files",
    label: "Files",
  },
  {
    body: "Shells, packages, services",
    href: "features/terminal",
    icon: "terminal",
    label: "Runtime",
  },
  {
    body: "Agent prompts and patches",
    href: "features/ai",
    icon: "robot",
    label: "Codex",
  },
  {
    body: "Snapshots and TimeTravel",
    href: "features/compare",
    icon: "history",
    label: "Review",
  },
] satisfies { body: string; href: string; icon: IconName; label: string }[];
const HERO_ROUTE_CHOICES = [
  {
    accent: PUBLIC_COLORS.accent,
    body: "Create the project that holds files, notebooks, terminals, and Codex work.",
    href: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? appPath("projects") : appPath("auth/sign-up"),
    icon: "project-outlined",
    label: "Workspace",
    title: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? "Open projects" : "Start a workspace",
  },
  {
    accent: COLORS.RUN,
    body: "Find notebook, terminal, AI, teaching, writing, and comparison paths.",
    href: () => appPath("features"),
    icon: "overview",
    label: "Workflows",
    title: () => "Explore workflows",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Choose hosted service, local runtime, or customer-operated CoCalc.",
    href: () => appPath("products"),
    icon: "servers",
    label: "Deployment",
    title: () => "Compare deployments",
  },
] satisfies {
  accent: string;
  body: string;
  href: (opts: { authenticated: boolean }) => string;
  icon: IconName;
  label: string;
  title: (opts: { authenticated: boolean }) => string;
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
const HERO_WORKSPACE_SIGNALS = [
  {
    accent: COLORS.RUN,
    detail: "analysis.ipynb",
    icon: "jupyter",
    label: "Notebook output",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    detail: "run.term",
    icon: "terminal",
    label: "Terminal state",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    detail: "codex.patch",
    icon: "robot",
    label: "Codex patch",
  },
  {
    accent: PUBLIC_COLORS.warning,
    detail: "snapshot ready",
    icon: "history",
    label: "History checkpoint",
  },
] satisfies {
  accent: string;
  detail: string;
  icon: IconName;
  label: string;
}[];
const HERO_WORKSPACE_TRAIL = [
  {
    accent: COLORS.BLUE_D,
    detail: "Files",
    icon: "files",
    label: "Capture",
  },
  {
    accent: COLORS.RUN,
    detail: "Runtime",
    icon: "terminal",
    label: "Run",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    detail: "Agent work",
    icon: "robot",
    label: "Ask",
  },
  {
    accent: PUBLIC_COLORS.warning,
    detail: "History",
    icon: "history",
    label: "Review",
  },
] satisfies {
  accent: string;
  detail: string;
  icon: IconName;
  label: string;
}[];
const WORKSPACE_PREVIEW_CONTINUITY = [
  {
    accent: COLORS.BLUE_D,
    detail:
      "Files, notebooks, data, prompts, and notes stay in one inspectable project.",
    icon: "files",
    label: "Project context",
  },
  {
    accent: COLORS.RUN,
    detail:
      "Notebook output and terminal sessions remain near the code that produced them.",
    icon: "terminal",
    label: "Execution trail",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    detail:
      "Chat, Codex turns, and review notes preserve why changes were made.",
    icon: "robot",
    label: "Decision trail",
  },
  {
    accent: PUBLIC_COLORS.warning,
    detail:
      "Snapshots and TimeTravel keep earlier states available when work changes.",
    icon: "history",
    label: "Recovery trail",
  },
] satisfies {
  accent: string;
  detail: string;
  icon: IconName;
  label: string;
}[];
const WORKSPACE_PREVIEW_FLOW = [
  {
    accent: COLORS.BLUE_D,
    detail: "Notebooks, code, data, and notes enter the project.",
    href: "features/compare",
    icon: "files",
    label: "Capture",
  },
  {
    accent: COLORS.RUN,
    detail: "Shells and notebooks work against the same files.",
    href: "features/terminal",
    icon: "terminal",
    label: "Run",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    detail: "Codex can use the project record when helping.",
    href: "features/ai",
    icon: "robot",
    label: "Ask",
  },
  {
    accent: PUBLIC_COLORS.warning,
    detail: "Output, snapshots, and TimeTravel keep review nearby.",
    href: "features/compare",
    icon: "history",
    label: "Review",
  },
] satisfies {
  accent: string;
  detail: string;
  href: string;
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
const NEXT_ACTION_ROUTES = [
  {
    accent: COLORS.RUN,
    action: "Open notebook workflow",
    body: "Open Jupyter in a project so output, files, terminals, and notes stay nearby.",
    context: "Output, files, and notes",
    href: "features/jupyter-notebook",
    icon: "jupyter",
    signal: "Compute",
    title: "Notebook or data file",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    action: "Use terminal workflow",
    body: "Use a browser terminal for scripts, packages, services, and project logs.",
    context: "Commands, logs, and services",
    href: "features/terminal",
    icon: "terminal",
    signal: "Runtime",
    title: "Shell command or service",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    action: "See Codex workflow",
    body: "Ask Codex from the project so prompts, patches, tests, and review notes remain attached.",
    context: "Prompts, patches, and tests",
    href: "features/ai",
    icon: "robot",
    signal: "Codex",
    title: "Change request",
  },
  {
    accent: PUBLIC_COLORS.warning,
    action: "Compare options",
    body: "Compare hosted, local, and customer-operated paths after the workspace model is clear.",
    context: "Runtime choice and support notes",
    href: "products",
    icon: "servers",
    signal: "Operation",
    title: "Team operating question",
  },
] satisfies {
  accent: string;
  action: string;
  body: string;
  context: string;
  href: string;
  icon: IconName;
  signal: string;
  title: string;
}[];
const WORK_INPUT_ROUTES = [
  {
    accent: COLORS.RUN,
    body: "Use Jupyter when the first item is an .ipynb file, data table, or computation that should keep output beside the source.",
    href: "features/jupyter-notebook",
    icon: "jupyter",
    label: "Notebook",
    route: "Run the notebook",
    title: "Notebook or data table",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Use a terminal when the work starts from a command, package install, service, or log that belongs with project files.",
    href: "features/terminal",
    icon: "terminal",
    label: "Shell",
    route: "Open terminal workflow",
    title: "Command or service",
  },
  {
    accent: PUBLIC_COLORS.success,
    body: "Use the Python path when scripts, modules, plots, or scientific packages are the center of the project.",
    href: "features/python",
    icon: "python",
    label: "Code",
    route: "Review Python support",
    title: "Script or source tree",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Use the LaTeX path when papers, notes, handouts, or technical writing need the same project history and collaboration.",
    href: "features/latex-editor",
    icon: "file-code",
    label: "Writing",
    route: "Open LaTeX workflow",
    title: "Paper or handout",
  },
] satisfies {
  accent: string;
  body: string;
  href: string;
  icon: IconName;
  label: string;
  route: string;
  title: string;
}[];
const LANDING_ROUTE_MAP = [
  {
    accent: COLORS.BLUE_D,
    body: "Create or open a project when the immediate need is a place for notebooks, files, terminals, and agent work.",
    continuity: "Files, output, and review history stay with the project.",
    href: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? appPath("projects") : appPath("auth/sign-up"),
    icon: "project-outlined",
    label: "Project first",
    next: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? "Open projects" : "Create a workspace",
    prompt: "I have work to put somewhere",
    title: "Start a workspace",
  },
  {
    accent: COLORS.RUN,
    body: "Use the feature pages when you are choosing between notebooks, terminal sessions, AI agents, teaching, or writing tools.",
    continuity: "Each surface opens around the same project context.",
    href: () => appPath("features"),
    icon: "overview",
    label: "Workflow first",
    next: () => "Explore workflows",
    prompt: "I need the right work surface",
    title: "Pick a work surface",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Use product pages when the main question is hosted service, one-user local runtime, or customer-operated deployment.",
    continuity: "The operating boundary stays explicit before detail pages.",
    href: () => appPath("products"),
    icon: "servers",
    label: "Operations first",
    next: () => "Choose operating path",
    prompt: "I need to decide where it runs",
    title: "Decide where CoCalc runs",
  },
] satisfies {
  accent: string;
  body: string;
  continuity: string;
  href: (opts: { authenticated: boolean }) => string;
  icon: IconName;
  label: string;
  next: (opts: { authenticated: boolean }) => string;
  prompt: string;
  title: string;
}[];
const LANDING_DECISION_FLOW = [
  {
    accent: COLORS.BLUE_D,
    body: "Create or open the project that will hold files, output, terminals, and notes.",
    href: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? appPath("projects") : appPath("auth/sign-up"),
    icon: "project-outlined",
    label: "Place",
    title: "Where does the work live?",
  },
  {
    accent: COLORS.RUN,
    body: "Choose the notebook, terminal, AI, teaching, or writing surface that fits the task.",
    href: () => appPath("features"),
    icon: "overview",
    label: "Surface",
    title: "What opens it?",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Compare hosted, local, and customer-operated paths before choosing the runtime boundary.",
    href: () => appPath("products"),
    icon: "servers",
    label: "Boundary",
    title: "Who runs it?",
  },
] satisfies {
  accent: string;
  body: string;
  href: (opts: { authenticated: boolean }) => string;
  icon: IconName;
  label: string;
  title: string;
}[];
const LANDING_WORKSPACE_LOOP = [
  {
    accent: COLORS.BLUE_D,
    body: "Put notebooks, source, data, and notes in the project first.",
    href: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? appPath("projects") : appPath("auth/sign-up"),
    icon: "project-outlined",
    label: "Place",
    title: "Open the workspace",
  },
  {
    accent: COLORS.RUN,
    body: "Choose the notebook, terminal, AI, teaching, or writing surface from there.",
    href: () => appPath("features"),
    icon: "overview",
    label: "Surface",
    title: "Pick the tool",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Keep prompts, code changes, commands, and output attached to the same record.",
    href: () => appPath("features/ai"),
    icon: "robot",
    label: "Context",
    title: "Work with the record",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Use snapshots, file history, and comparison views when the work changes.",
    href: () => appPath("features/compare"),
    icon: "history",
    label: "Review",
    title: "Check what changed",
  },
] satisfies {
  accent: string;
  body: string;
  href: (opts: { authenticated: boolean }) => string;
  icon: IconName;
  label: string;
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

function HeroContextStrip() {
  return (
    <div
      aria-label="CoCalc.ai workspace context cues"
      role="group"
      style={{
        background: alpha(PUBLIC_COLORS.brandDark, 0.42),
        border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.22)}`,
        borderRadius: PANEL_RADIUS,
        maxWidth: 740,
        padding: 12,
      }}
    >
      <Text
        strong
        style={{
          color: PUBLIC_COLORS.surface,
          display: "block",
          marginBottom: 9,
        }}
      >
        Project context kept together
      </Text>
      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))",
        }}
      >
        {HERO_CONTEXT_SIGNALS.map((item) => (
          <a
            href={appPath(item.href)}
            key={item.label}
            style={{
              alignItems: "start",
              background: alpha(PUBLIC_COLORS.surface, 0.12),
              border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.2)}`,
              borderRadius: PANEL_RADIUS,
              color: PUBLIC_COLORS.surface,
              display: "grid",
              gap: 8,
              gridTemplateColumns: "26px minmax(0, 1fr) 14px",
              minHeight: 62,
              padding: "9px 10px",
              textDecoration: "none",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                alignItems: "center",
                color: PUBLIC_COLORS.accent,
                display: "flex",
                height: 26,
                justifyContent: "center",
                width: 26,
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
                {item.label}
              </Text>
              <Text
                style={{
                  color: alpha(PUBLIC_COLORS.surface, 0.68),
                  display: "block",
                  fontSize: 12,
                }}
              >
                {item.body}
              </Text>
            </span>
            <Icon
              name="arrow-right"
              style={{
                alignSelf: "center",
                color: alpha(PUBLIC_COLORS.surface, 0.64),
                fontSize: 12,
              }}
            />
          </a>
        ))}
      </div>
    </div>
  );
}

function HeroRouteChooser({ authenticated }: { authenticated: boolean }) {
  return (
    <div
      aria-label="CoCalc.ai hero route chooser"
      role="group"
      style={{
        background: alpha(PUBLIC_COLORS.brandDark, 0.5),
        border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.24)}`,
        borderRadius: PANEL_RADIUS,
        maxWidth: 740,
        padding: 12,
      }}
    >
      <Flex align="baseline" justify="space-between" wrap gap={8}>
        <Text strong style={{ color: PUBLIC_COLORS.surface }}>
          Choose your starting point
        </Text>
        <Text
          style={{
            color: alpha(PUBLIC_COLORS.surface, 0.7),
            fontSize: 12,
          }}
        >
          Workspace, workflow, or deployment.
        </Text>
      </Flex>
      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 176px), 1fr))",
          marginTop: 10,
        }}
      >
        {HERO_ROUTE_CHOICES.map((choice) => (
          <a
            href={choice.href({ authenticated })}
            key={choice.label}
            style={{
              alignItems: "start",
              background: alpha(PUBLIC_COLORS.surface, 0.12),
              border: `1px solid ${alpha(choice.accent, 0.36)}`,
              borderRadius: PANEL_RADIUS,
              color: PUBLIC_COLORS.surface,
              display: "grid",
              gap: 9,
              gridTemplateColumns: "32px minmax(0, 1fr) 14px",
              minHeight: 112,
              padding: 11,
              textDecoration: "none",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                alignItems: "center",
                background: alpha(choice.accent, 0.14),
                border: `1px solid ${alpha(choice.accent, 0.3)}`,
                borderRadius: PANEL_RADIUS,
                color: choice.accent,
                display: "flex",
                fontSize: 16,
                height: 32,
                justifyContent: "center",
                width: 32,
              }}
            >
              <Icon name={choice.icon} />
            </span>
            <span style={{ minWidth: 0 }}>
              <Text
                strong
                style={{
                  color: choice.accent,
                  display: "block",
                  fontSize: 12,
                  textTransform: "uppercase",
                }}
              >
                {choice.label}
              </Text>
              <Text strong style={{ color: "inherit", display: "block" }}>
                {choice.title({ authenticated })}
              </Text>
              <Text
                style={{
                  color: alpha(PUBLIC_COLORS.surface, 0.68),
                  display: "block",
                  marginTop: 4,
                }}
              >
                {choice.body}
              </Text>
            </span>
            <Icon
              name="arrow-right"
              style={{
                alignSelf: "center",
                color: alpha(PUBLIC_COLORS.surface, 0.58),
                fontSize: 12,
              }}
            />
          </a>
        ))}
      </div>
    </div>
  );
}

function HeroWorkspaceSnapshot({ authenticated }: { authenticated: boolean }) {
  return (
    <aside
      aria-label="CoCalc.ai project context snapshot"
      className="cocalc-public-home-hero-snapshot"
      style={{
        alignSelf: "center",
        background: alpha(PUBLIC_COLORS.brandDark, 0.5),
        border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.28)}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: `0 24px 60px ${alpha(PUBLIC_COLORS.brandDark, 0.28)}`,
        color: PUBLIC_COLORS.surface,
        justifySelf: "end",
        maxWidth: 430,
        padding: 16,
        width: "100%",
      }}
    >
      <Flex align="center" justify="space-between" gap={12} wrap>
        <Flex align="center" gap={10}>
          <span
            aria-hidden="true"
            style={{
              alignItems: "center",
              background: alpha(PUBLIC_COLORS.accent, 0.14),
              border: `1px solid ${alpha(PUBLIC_COLORS.accent, 0.32)}`,
              borderRadius: PANEL_RADIUS,
              color: PUBLIC_COLORS.accent,
              display: "flex",
              flex: "0 0 40px",
              fontSize: 19,
              height: 40,
              justifyContent: "center",
              width: 40,
            }}
          >
            <Icon name="project-outlined" />
          </span>
          <span>
            <Text strong style={{ color: "inherit", display: "block" }}>
              Project context snapshot
            </Text>
            <Text
              style={{
                color: alpha(PUBLIC_COLORS.surface, 0.7),
                display: "block",
              }}
            >
              Shared state in one workspace
            </Text>
          </span>
        </Flex>
        <Tag
          style={{
            background: alpha(PUBLIC_COLORS.surface, 0.12),
            borderColor: alpha(PUBLIC_COLORS.surface, 0.26),
            color: PUBLIC_COLORS.surface,
            marginInlineEnd: 0,
          }}
        >
          Persistent
        </Tag>
      </Flex>
      <div
        aria-label="CoCalc.ai hero workspace trail"
        role="group"
        style={{
          background: alpha(PUBLIC_COLORS.surface, 0.1),
          border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.2)}`,
          borderRadius: PANEL_RADIUS,
          marginTop: 14,
          padding: 12,
        }}
      >
        <Flex align="baseline" justify="space-between" wrap gap={8}>
          <Text strong style={{ color: PUBLIC_COLORS.surface }}>
            Workspace trail
          </Text>
          <Text
            style={{
              color: alpha(PUBLIC_COLORS.surface, 0.68),
              fontSize: 12,
            }}
          >
            Files, runtime, agent work, review.
          </Text>
        </Flex>
        <div
          className="cocalc-public-home-hero-trail-grid"
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            marginTop: 10,
          }}
        >
          {HERO_WORKSPACE_TRAIL.map((step, index) => (
            <div
              key={step.label}
              style={{
                background: alpha(step.accent, 0.14),
                border: `1px solid ${alpha(step.accent, 0.36)}`,
                borderRadius: PANEL_RADIUS,
                minHeight: 72,
                padding: 8,
              }}
            >
              <Flex align="center" gap={6}>
                <span
                  aria-hidden="true"
                  style={{
                    alignItems: "center",
                    background: alpha(PUBLIC_COLORS.surface, 0.11),
                    borderRadius: PANEL_RADIUS,
                    color: step.accent,
                    display: "flex",
                    flex: "0 0 22px",
                    height: 22,
                    justifyContent: "center",
                    width: 22,
                  }}
                >
                  <Icon name={step.icon} />
                </span>
                <Text
                  strong
                  style={{
                    color: PUBLIC_COLORS.surface,
                    fontSize: 11,
                    lineHeight: 1,
                  }}
                >
                  {index + 1}
                </Text>
              </Flex>
              <Text
                strong
                style={{
                  color: PUBLIC_COLORS.surface,
                  display: "block",
                  marginTop: 7,
                }}
              >
                {step.label}
              </Text>
              <Text
                style={{
                  color: alpha(PUBLIC_COLORS.surface, 0.66),
                  display: "block",
                  fontSize: 12,
                }}
              >
                {step.detail}
              </Text>
            </div>
          ))}
        </div>
      </div>
      <div
        className="cocalc-public-home-hero-snapshot-grid"
        style={{
          display: "grid",
          gap: 9,
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          marginTop: 15,
        }}
      >
        {HERO_WORKSPACE_SIGNALS.map((signal) => (
          <div
            key={signal.label}
            style={{
              alignItems: "start",
              background: alpha(PUBLIC_COLORS.surface, 0.12),
              border: `1px solid ${alpha(signal.accent, 0.38)}`,
              borderRadius: PANEL_RADIUS,
              display: "grid",
              gap: 8,
              gridTemplateColumns: "30px minmax(0, 1fr)",
              minHeight: 72,
              padding: 10,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                alignItems: "center",
                background: alpha(signal.accent, 0.14),
                border: `1px solid ${alpha(signal.accent, 0.28)}`,
                borderRadius: PANEL_RADIUS,
                color: signal.accent,
                display: "flex",
                height: 30,
                justifyContent: "center",
                width: 30,
              }}
            >
              <Icon name={signal.icon} />
            </span>
            <span style={{ minWidth: 0 }}>
              <Text
                strong
                style={{ color: PUBLIC_COLORS.surface, display: "block" }}
              >
                {signal.label}
              </Text>
              <Text
                style={{
                  color: alpha(PUBLIC_COLORS.surface, 0.66),
                  display: "block",
                  fontSize: 12,
                }}
              >
                {signal.detail}
              </Text>
            </span>
          </div>
        ))}
      </div>
      <Button
        block
        ghost
        href={appPath(authenticated ? "projects" : "auth/sign-up")}
        icon={<DecorativeButtonIcon name="rocket" />}
        style={{ marginTop: 14 }}
      >
        {authenticated ? "Open your workspace" : "Create a workspace"}
      </Button>
    </aside>
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
        aria-label="CoCalc.ai project work sequence"
        role="group"
        style={{
          background: alpha(PUBLIC_COLORS.surface, 0.1),
          border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.2)}`,
          borderRadius: PANEL_RADIUS,
          marginTop: 14,
          padding: 14,
        }}
      >
        <Flex align="baseline" justify="space-between" wrap gap={8}>
          <Text strong style={{ color: PUBLIC_COLORS.surface }}>
            Project work sequence
          </Text>
          <Text
            style={{
              color: alpha(PUBLIC_COLORS.surface, 0.68),
              fontSize: 12,
            }}
          >
            Files to review
          </Text>
        </Flex>
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 138px), 1fr))",
            marginTop: 10,
          }}
        >
          {WORKSPACE_PREVIEW_FLOW.map((item, index) => (
            <a
              href={appPath(item.href)}
              key={item.label}
              style={{
                alignItems: "start",
                background: alpha(PUBLIC_COLORS.brandDark, 0.24),
                border: `1px solid ${alpha(item.accent, 0.36)}`,
                borderRadius: PANEL_RADIUS,
                color: PUBLIC_COLORS.surface,
                display: "grid",
                gap: 8,
                gridTemplateColumns: "30px minmax(0, 1fr) 14px",
                minHeight: 112,
                padding: 10,
                textDecoration: "none",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: `${item.accent}1f`,
                  border: `1px solid ${item.accent}42`,
                  borderRadius: PANEL_RADIUS,
                  color: item.accent,
                  display: "flex",
                  flexDirection: "column",
                  fontSize: 14,
                  gap: 2,
                  height: 48,
                  justifyContent: "center",
                  width: 30,
                }}
              >
                <Icon name={item.icon} />
                <Text
                  strong
                  style={{
                    color: "inherit",
                    fontSize: 10,
                    lineHeight: 1,
                  }}
                >
                  {index + 1}
                </Text>
              </span>
              <span style={{ minWidth: 0 }}>
                <Text strong style={{ color: "inherit", display: "block" }}>
                  {item.label}
                </Text>
                <Text
                  style={{
                    color: alpha(PUBLIC_COLORS.surface, 0.68),
                    display: "block",
                    marginTop: 5,
                  }}
                >
                  {item.detail}
                </Text>
              </span>
              <Icon
                name="arrow-right"
                style={{
                  alignSelf: "center",
                  color: alpha(PUBLIC_COLORS.surface, 0.58),
                  fontSize: 12,
                }}
              />
            </a>
          ))}
        </div>
      </div>
      <div
        aria-label="CoCalc.ai continuity cues"
        role="group"
        style={{
          background: alpha(PUBLIC_COLORS.brandDark, 0.36),
          border: `1px solid ${alpha(PUBLIC_COLORS.surface, 0.2)}`,
          borderRadius: PANEL_RADIUS,
          marginTop: 14,
          padding: 14,
        }}
      >
        <Flex align="baseline" justify="space-between" wrap gap={8}>
          <Text strong style={{ color: PUBLIC_COLORS.surface }}>
            Continuity cues
          </Text>
          <Text
            style={{
              color: alpha(PUBLIC_COLORS.surface, 0.68),
              fontSize: 12,
            }}
          >
            What carries forward
          </Text>
        </Flex>
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 164px), 1fr))",
            marginTop: 10,
          }}
        >
          {WORKSPACE_PREVIEW_CONTINUITY.map((item) => (
            <div
              key={item.label}
              style={{
                alignItems: "start",
                background: alpha(PUBLIC_COLORS.surface, 0.08),
                border: `1px solid ${alpha(item.accent, 0.32)}`,
                borderRadius: PANEL_RADIUS,
                color: PUBLIC_COLORS.surface,
                display: "grid",
                gap: 8,
                gridTemplateColumns: "28px minmax(0, 1fr)",
                minHeight: 118,
                padding: 10,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: `${item.accent}1f`,
                  border: `1px solid ${item.accent}42`,
                  borderRadius: PANEL_RADIUS,
                  color: item.accent,
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
                <Text strong style={{ color: "inherit", display: "block" }}>
                  {item.label}
                </Text>
                <Text
                  style={{
                    color: alpha(PUBLIC_COLORS.surface, 0.68),
                    display: "block",
                    marginTop: 4,
                  }}
                >
                  {item.detail}
                </Text>
              </span>
            </div>
          ))}
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
        className="cocalc-public-home-hero-inner"
        style={{
          alignItems: "center",
          display: "grid",
          gap: 32,
          gridTemplateColumns: "minmax(0, 760px) minmax(320px, 430px)",
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
                  icon={<DecorativeButtonIcon name="servers" />}
                  size="large"
                >
                  Compare deployment options
                </Button>
              </>
            )}
          </Flex>
          <HeroRouteChooser authenticated={authenticated} />
          <HeroContextStrip />
        </Flex>
        <HeroWorkspaceSnapshot authenticated={authenticated} />
      </div>
    </section>
  );
}

function LandingRouteMapSection({ authenticated }: { authenticated: boolean }) {
  return (
    <section
      aria-label="CoCalc.ai landing route map"
      style={{
        background: PUBLIC_COLORS.surface,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `22px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Flex align="start" justify="space-between" gap={18} wrap>
        <div style={{ maxWidth: 430 }}>
          <Eyebrow>Find the right entry point</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 8px" }}>
            Route by what you need next.
          </Title>
          <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
            Choose by the question in front of you: where the work should live,
            which surface should open it, or who should operate the workspace.
            Each route keeps the project model visible.
          </Paragraph>
        </div>
        <div
          aria-label="CoCalc.ai first decision flow"
          role="group"
          style={{
            display: "grid",
            flex: "1 1 620px",
            gap: 8,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 190px), 1fr))",
          }}
        >
          {LANDING_DECISION_FLOW.map((item, index) => (
            <a
              href={item.href({ authenticated })}
              key={item.label}
              style={{
                alignItems: "start",
                background: PUBLIC_COLORS.surfaceMuted,
                border: `1px solid ${alpha(item.accent, 0.22)}`,
                borderRadius: PANEL_RADIUS,
                color: "inherit",
                display: "grid",
                gap: 10,
                gridTemplateColumns: "34px minmax(0, 1fr)",
                minHeight: 116,
                padding: 12,
                textDecoration: "none",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: alpha(item.accent, 0.08),
                  border: `1px solid ${alpha(item.accent, 0.2)}`,
                  borderRadius: PANEL_RADIUS,
                  color: item.accent,
                  display: "flex",
                  flexDirection: "column",
                  fontSize: 15,
                  gap: 2,
                  height: 46,
                  justifyContent: "center",
                  width: 34,
                }}
              >
                <Icon name={item.icon} />
                <Text
                  strong
                  style={{ color: "inherit", fontSize: 10, lineHeight: 1 }}
                >
                  {index + 1}
                </Text>
              </span>
              <span style={{ minWidth: 0 }}>
                <Text
                  strong
                  style={{
                    color: item.accent,
                    display: "block",
                    fontSize: 12,
                    textTransform: "uppercase",
                  }}
                >
                  {item.label}
                </Text>
                <Text strong style={{ display: "block", marginTop: 2 }}>
                  {item.title}
                </Text>
                <Text type="secondary">{item.body}</Text>
              </span>
            </a>
          ))}
        </div>
        <div
          aria-label="CoCalc.ai primary landing routes"
          role="group"
          style={{
            display: "grid",
            flex: "1 1 620px",
            gap: 10,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 230px), 1fr))",
          }}
        >
          {LANDING_ROUTE_MAP.map((route) => (
            <a
              href={route.href({ authenticated })}
              key={route.title}
              style={{
                alignItems: "start",
                background: alpha(route.accent, 0.06),
                border: `1px solid ${alpha(route.accent, 0.22)}`,
                borderRadius: PANEL_RADIUS,
                color: "inherit",
                display: "grid",
                gap: 10,
                gridTemplateColumns: "38px minmax(0, 1fr) 16px",
                minHeight: 138,
                padding: 14,
                textDecoration: "none",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: alpha(route.accent, 0.08),
                  border: `1px solid ${alpha(route.accent, 0.22)}`,
                  borderRadius: PANEL_RADIUS,
                  color: route.accent,
                  display: "flex",
                  fontSize: 18,
                  height: 38,
                  justifyContent: "center",
                  width: 38,
                }}
              >
                <Icon name={route.icon} />
              </span>
              <span style={{ minWidth: 0 }}>
                <Text
                  strong
                  style={{
                    color: route.accent,
                    display: "block",
                    fontSize: 12,
                    textTransform: "uppercase",
                  }}
                >
                  {route.label}
                </Text>
                <Text
                  style={{
                    color: PUBLIC_COLORS.mutedText,
                    display: "block",
                    fontSize: 13,
                    marginTop: 2,
                  }}
                >
                  {route.prompt}
                </Text>
                <Title level={3} style={{ fontSize: 21, margin: "4px 0 6px" }}>
                  {route.title}
                </Title>
                <Text type="secondary">{route.body}</Text>
                <Text
                  style={{
                    color: PUBLIC_COLORS.mutedText,
                    display: "block",
                    fontSize: 13,
                    marginTop: 8,
                  }}
                >
                  {route.continuity}
                </Text>
                <Text
                  strong
                  style={{
                    color: route.accent,
                    display: "block",
                    marginTop: 10,
                  }}
                >
                  {route.next({ authenticated })}
                </Text>
              </span>
              <Icon
                name="arrow-right"
                style={{
                  color: route.accent,
                  marginTop: 4,
                }}
              />
            </a>
          ))}
        </div>
        <div
          aria-label="CoCalc.ai workspace route loop"
          role="group"
          style={{
            background: PUBLIC_COLORS.surfaceMuted,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PANEL_RADIUS,
            flex: "1 1 100%",
            padding: 14,
          }}
        >
          <Flex align="baseline" justify="space-between" wrap gap={8}>
            <Text strong style={{ color: PUBLIC_COLORS.heading }}>
              Workspace loop
            </Text>
            <Text style={{ color: PUBLIC_COLORS.mutedText, fontSize: 12 }}>
              Place, surface, context, review.
            </Text>
          </Flex>
          <div
            style={{
              display: "grid",
              gap: 8,
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, 190px), 1fr))",
              marginTop: 10,
            }}
          >
            {LANDING_WORKSPACE_LOOP.map((step, index) => (
              <a
                href={step.href({ authenticated })}
                key={step.label}
                style={{
                  alignItems: "start",
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${alpha(step.accent, 0.24)}`,
                  borderRadius: PANEL_RADIUS,
                  color: "inherit",
                  display: "grid",
                  gap: 9,
                  gridTemplateColumns: "32px minmax(0, 1fr)",
                  minHeight: 126,
                  padding: 12,
                  textDecoration: "none",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    alignItems: "center",
                    background: alpha(step.accent, 0.08),
                    border: `1px solid ${alpha(step.accent, 0.22)}`,
                    borderRadius: PANEL_RADIUS,
                    color: step.accent,
                    display: "flex",
                    flexDirection: "column",
                    fontSize: 14,
                    gap: 2,
                    height: 44,
                    justifyContent: "center",
                    width: 32,
                  }}
                >
                  <Icon name={step.icon} />
                  <Text
                    strong
                    style={{ color: "inherit", fontSize: 10, lineHeight: 1 }}
                  >
                    {index + 1}
                  </Text>
                </span>
                <span style={{ minWidth: 0 }}>
                  <Text
                    strong
                    style={{
                      color: step.accent,
                      display: "block",
                      fontSize: 12,
                      textTransform: "uppercase",
                    }}
                  >
                    {step.label}
                  </Text>
                  <Text strong style={{ display: "block", marginTop: 2 }}>
                    {step.title}
                  </Text>
                  <Text type="secondary">{step.body}</Text>
                </span>
              </a>
            ))}
          </div>
        </div>
      </Flex>
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

function WorkInputSection() {
  return (
    <section
      aria-label="CoCalc.ai work input routes"
      style={{
        background: PUBLIC_COLORS.surface,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `28px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Flex align="end" justify="space-between" wrap gap={16}>
        <div style={{ maxWidth: 760 }}>
          <Eyebrow>Start from the material</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Open the work where it already belongs.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            CoCalc routes the first file, command, script, or document into the
            same persistent project, so surrounding context stays available as
            the work changes.
          </Paragraph>
        </div>
        <Button
          href={appPath("features")}
          icon={<DecorativeButtonIcon name="overview" />}
        >
          Browse feature routes
        </Button>
      </Flex>
      <div
        aria-label="CoCalc.ai material route cards"
        role="group"
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
          marginTop: 22,
        }}
      >
        {WORK_INPUT_ROUTES.map((route) => (
          <a
            href={appPath(route.href)}
            key={route.title}
            style={{
              background: alpha(route.accent, 0.05),
              border: `1px solid ${alpha(route.accent, 0.22)}`,
              borderRadius: PANEL_RADIUS,
              color: "inherit",
              display: "grid",
              gap: 12,
              gridTemplateColumns: "42px minmax(0, 1fr)",
              minHeight: 186,
              padding: 16,
              textDecoration: "none",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                alignItems: "center",
                background: alpha(route.accent, 0.08),
                border: `1px solid ${alpha(route.accent, 0.24)}`,
                borderRadius: PANEL_RADIUS,
                color: route.accent,
                display: "flex",
                fontSize: 20,
                height: 42,
                justifyContent: "center",
                width: 42,
              }}
            >
              <Icon name={route.icon} />
            </span>
            <span style={{ minWidth: 0 }}>
              <Tag
                style={{
                  background: alpha(route.accent, 0.08),
                  borderColor: alpha(route.accent, 0.22),
                  color: route.accent,
                  marginBottom: 10,
                  marginInlineEnd: 0,
                }}
              >
                {route.label}
              </Tag>
              <Title level={3} style={{ fontSize: 22, margin: "0 0 8px" }}>
                {route.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>{route.body}</Paragraph>
              <Text
                strong
                style={{
                  color: route.accent,
                  display: "inline-flex",
                  gap: 8,
                  marginTop: 14,
                }}
              >
                {route.route}
                <Icon name="arrow-right" />
              </Text>
            </span>
          </a>
        ))}
      </div>
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
            aria-label="CoCalc.ai core workflow cards"
            role="group"
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

function NextActionSection() {
  return (
    <section
      aria-label="CoCalc.ai next action routes"
      style={{
        background: PUBLIC_COLORS.surfaceMuted,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `30px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Flex align="end" justify="space-between" wrap gap={16}>
        <div style={{ maxWidth: 760 }}>
          <Eyebrow>Choose the next action</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Start from the artifact in front of you.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            A project can begin with a notebook, a shell command, a change
            request, or an operating question. Route the first step to the page
            that explains that surface.
          </Paragraph>
        </div>
        <Button
          href={appPath("features")}
          icon={<DecorativeButtonIcon name="overview" />}
        >
          Explore all features
        </Button>
      </Flex>
      <div
        aria-label="CoCalc.ai next action cards"
        role="group"
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
          marginTop: 22,
        }}
      >
        {NEXT_ACTION_ROUTES.map((route) => (
          <a
            href={appPath(route.href)}
            key={route.title}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${alpha(route.accent, 0.24)}`,
              borderRadius: PANEL_RADIUS,
              color: "inherit",
              display: "flex",
              flexDirection: "column",
              minHeight: 196,
              padding: 16,
              textDecoration: "none",
            }}
          >
            <Flex align="center" justify="space-between" gap={12}>
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: alpha(route.accent, 0.08),
                  border: `1px solid ${alpha(route.accent, 0.2)}`,
                  borderRadius: PANEL_RADIUS,
                  color: route.accent,
                  display: "flex",
                  flex: "0 0 42px",
                  fontSize: 20,
                  height: 42,
                  justifyContent: "center",
                  width: 42,
                }}
              >
                <Icon name={route.icon} />
              </span>
              <Tag
                style={{
                  background: alpha(route.accent, 0.08),
                  borderColor: alpha(route.accent, 0.22),
                  color: route.accent,
                  marginInlineEnd: 0,
                }}
              >
                {route.signal}
              </Tag>
            </Flex>
            <Title level={3} style={{ fontSize: 22, margin: "14px 0 8px" }}>
              {route.title}
            </Title>
            <Paragraph style={{ margin: 0 }}>{route.body}</Paragraph>
            <Flex
              align="start"
              gap={8}
              style={{
                borderTop: `1px solid ${alpha(route.accent, 0.18)}`,
                marginTop: 14,
                paddingTop: 12,
              }}
            >
              <Icon
                aria-hidden="true"
                name="clipboard-check"
                style={{
                  color: route.accent,
                  flex: "0 0 auto",
                  marginTop: 3,
                }}
              />
              <span style={{ minWidth: 0 }}>
                <Text
                  strong
                  style={{
                    color: route.accent,
                    display: "block",
                    fontSize: 12,
                    textTransform: "uppercase",
                  }}
                >
                  Project carry-forward
                </Text>
                <Text type="secondary">{route.context}</Text>
              </span>
            </Flex>
            <Text
              strong
              style={{
                color: route.accent,
                display: "inline-flex",
                gap: 8,
                marginTop: "auto",
                paddingTop: 16,
              }}
            >
              {route.action}
              <Icon name="arrow-right" />
            </Text>
          </a>
        ))}
      </div>
    </section>
  );
}

function AudienceSection() {
  const audiences = [
    {
      accent: COLORS.ANTD_LINK_BLUE_DARK,
      body: "Debug, review, and ship from a project where source, services, notebooks, and Codex threads share context.",
      bullets: [
        "Shared debugging",
        "Agent-assisted patches",
        "Durable project history",
      ],
      href: appPath("features/ai"),
      icon: "code-outlined",
      signals: [
        { icon: "files", label: "Source", value: "Files and config" },
        { icon: "terminal", label: "Runtime", value: "Services and tests" },
        { icon: "robot", label: "Codex", value: "Patches and review" },
      ],
      nextStep: "See AI workflows",
      title: "Engineering teams",
    },
    {
      accent: PUBLIC_COLORS.success,
      body: "Keep computational environments, notebook output, data files, and collaborator decisions inspectable later.",
      bullets: [
        "Long-running sessions",
        "Snapshots and backups",
        "Shared notebooks",
      ],
      href: appPath("features/jupyter-notebook"),
      icon: "experiment",
      signals: [
        { icon: "jupyter", label: "Notebooks", value: "Output and notes" },
        { icon: "database", label: "Data", value: "Project files" },
        { icon: "history", label: "Record", value: "Snapshots" },
      ],
      nextStep: "Open notebooks",
      title: "Research labs",
    },
    {
      accent: PUBLIC_COLORS.warning,
      body: "Run classes and workshops with one browser environment for assignments, notebooks, Linux, grading, and support.",
      bullets: [
        "Course projects",
        "Notebook grading",
        "Shared course environment",
      ],
      href: appPath("features/teaching"),
      icon: "graduation-cap",
      signals: [
        { icon: "graduation-cap", label: "Coursework", value: "Assignments" },
        { icon: "users", label: "Class", value: "Student projects" },
        { icon: "jupyter", label: "Review", value: "Notebook grading" },
      ],
      nextStep: "Explore teaching",
      title: "Technical courses",
    },
  ] satisfies {
    accent: string;
    body: string;
    bullets: string[];
    href: string;
    icon: IconName;
    nextStep: string;
    signals: { icon: IconName; label: string; value: string }[];
    title: string;
  }[];

  return (
    <section aria-label="CoCalc.ai audience paths">
      <Flex align="end" justify="space-between" wrap gap={16}>
        <div style={{ maxWidth: 780 }}>
          <Eyebrow>Who CoCalc is for</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Route by the work your group does.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            CoCalc is a fit when real compute, persistent project state,
            collaboration, and review need to stay in one place instead of a
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
        aria-label="CoCalc.ai audience route rows"
        role="group"
        style={{
          background: PUBLIC_COLORS.surface,
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: PANEL_RADIUS,
          boxShadow: `0 14px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.06)}`,
          marginTop: 26,
          overflow: "hidden",
        }}
      >
        <div
          aria-hidden="true"
          className="cocalc-public-home-audience-header"
          style={{
            background: PUBLIC_COLORS.surfaceMuted,
            color: PUBLIC_COLORS.brand,
            display: "grid",
            fontSize: 12,
            fontWeight: 600,
            gap: 14,
            gridTemplateColumns:
              "minmax(240px, 1fr) minmax(220px, 1fr) minmax(220px, 0.95fr) minmax(120px, 0.45fr) 18px",
            padding: "12px 16px",
            textTransform: "uppercase",
          }}
        >
          <Text style={{ color: "inherit", fontSize: "inherit" }}>
            Audience
          </Text>
          <Text style={{ color: "inherit", fontSize: "inherit" }}>
            Project context
          </Text>
          <Text style={{ color: "inherit", fontSize: "inherit" }}>
            Common use
          </Text>
          <Text style={{ color: "inherit", fontSize: "inherit" }}>
            Next step
          </Text>
          <span />
        </div>
        {audiences.map((audience) => (
          <a
            className="cocalc-public-home-audience-row"
            href={audience.href}
            key={audience.title}
            style={{
              borderTop: `1px solid ${PUBLIC_COLORS.border}`,
              color: "inherit",
              display: "grid",
              gap: 14,
              gridTemplateColumns:
                "minmax(240px, 1fr) minmax(220px, 1fr) minmax(220px, 0.95fr) minmax(120px, 0.45fr) 18px",
              minHeight: 118,
              padding: 16,
              textDecoration: "none",
            }}
          >
            <div
              style={{
                alignItems: "start",
                display: "grid",
                gap: 12,
                gridTemplateColumns: "44px minmax(0, 1fr)",
                minWidth: 0,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: `${audience.accent}14`,
                  border: `1px solid ${audience.accent}33`,
                  borderRadius: PANEL_RADIUS,
                  color: audience.accent,
                  display: "flex",
                  fontSize: 22,
                  height: 44,
                  justifyContent: "center",
                  width: 44,
                }}
              >
                <Icon name={audience.icon} />
              </span>
              <span style={{ minWidth: 0 }}>
                <Title level={3} style={{ fontSize: 22, margin: "0 0 6px" }}>
                  {audience.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>{audience.body}</Paragraph>
              </span>
            </div>
            <div
              aria-label={`${audience.title} project context cues`}
              className="cocalc-public-home-audience-row-context"
              role="group"
              style={{
                alignSelf: "center",
                display: "grid",
                gap: 8,
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 138px), 1fr))",
              }}
            >
              {audience.signals.map((signal) => (
                <span
                  key={signal.label}
                  style={{
                    alignItems: "start",
                    background: `${audience.accent}0d`,
                    border: `1px solid ${audience.accent}24`,
                    borderRadius: PANEL_RADIUS,
                    display: "grid",
                    gap: 7,
                    gridTemplateColumns: "20px minmax(0, 1fr)",
                    minHeight: 54,
                    padding: "8px 9px",
                  }}
                >
                  <Icon
                    name={signal.icon}
                    style={{
                      color: audience.accent,
                      marginTop: 2,
                    }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <Text strong style={{ display: "block" }}>
                      {signal.label}
                    </Text>
                    <Text type="secondary">{signal.value}</Text>
                  </span>
                </span>
              ))}
            </div>
            <div
              className="cocalc-public-home-audience-row-use"
              style={{
                alignSelf: "center",
                display: "grid",
                gap: 8,
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
            <Text
              className="cocalc-public-home-audience-row-next"
              strong
              style={{
                alignSelf: "center",
                color: audience.accent,
                justifySelf: "start",
              }}
            >
              {audience.nextStep}
            </Text>
            <Icon
              name="arrow-right"
              style={{
                alignSelf: "center",
                color: audience.accent,
                justifySelf: "end",
              }}
            />
          </a>
        ))}
      </div>
    </section>
  );
}

function ProductOptionsSection() {
  const options = [
    {
      accent: PUBLIC_COLORS.brand,
      bestFor: "Managed accounts, hosted projects, and team access",
      cues: ["Managed service", "Hosted projects"],
      href: appPath(""),
      icon: "cloud",
      nextStep: "Start hosted",
      operator: "Run by CoCalc",
      route: "Hosted service",
      title: "CoCalc.ai",
    },
    {
      accent: PUBLIC_COLORS.success,
      bestFor: "One person running CoCalc on their own Linux or Mac machine",
      cues: ["One-user local", "Browser workspace"],
      href: appPath("products/cocalc-plus"),
      icon: "laptop",
      nextStep: "Install locally",
      operator: "Run by you",
      route: "Local runtime",
      title: "CoCalc Plus",
    },
    {
      accent: PUBLIC_COLORS.warning,
      bestFor: "A lightweight private deployment with customer control",
      cues: ["Private team", "Customer operated"],
      href: appPath("products/cocalc-launchpad"),
      icon: "servers",
      nextStep: "Review Launchpad",
      operator: "Run by your team",
      route: "Private deployment",
      title: "CoCalc Launchpad",
    },
    {
      accent: COLORS.ANTD_LINK_BLUE_DARK,
      bestFor:
        "Private cloud planning with customer-operated infrastructure boundaries",
      cues: ["Infrastructure plan", "CoCalc guidance"],
      href: appPath("products/cocalc-rocket"),
      icon: "rocket",
      nextStep: "Plan Rocket",
      operator: "Customer-operated with CoCalc guidance",
      route: "Private cloud",
      title: "CoCalc Rocket",
    },
  ] satisfies {
    accent: string;
    bestFor: string;
    cues: string[];
    href: string;
    icon: IconName;
    nextStep: string;
    operator: string;
    route: string;
    title: string;
  }[];
  const routeShortcuts = [
    {
      accent: COLORS.BLUE_D,
      body: "CoCalc runs the service; teams use hosted projects.",
      href: appPath(""),
      icon: "cloud",
      label: "Hosted",
      title: "Managed CoCalc.ai",
    },
    {
      accent: COLORS.RUN,
      body: "Run CoCalc Plus on your own Linux or Mac machine.",
      href: appPath("products/cocalc-plus"),
      icon: "laptop",
      label: "Local",
      title: "One-user local",
    },
    {
      accent: COLORS.AI_ASSISTANT_FONT,
      body: "Compare Launchpad and Rocket for customer-operated paths.",
      href: appPath("products"),
      icon: "servers",
      label: "Private",
      title: "Customer-operated",
    },
  ] satisfies {
    accent: string;
    body: string;
    href: string;
    icon: IconName;
    label: string;
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
                aria-label="CoCalc.ai operating boundary shortcuts"
                role="group"
                style={{
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(100%, 168px), 1fr))",
                }}
              >
                {routeShortcuts.map((shortcut) => (
                  <a
                    href={shortcut.href}
                    key={shortcut.label}
                    style={{
                      background: PUBLIC_COLORS.surface,
                      border: `1px solid ${alpha(shortcut.accent, 0.24)}`,
                      borderRadius: PANEL_RADIUS,
                      color: "inherit",
                      display: "grid",
                      gap: 9,
                      gridTemplateColumns: "32px minmax(0, 1fr)",
                      minHeight: 116,
                      padding: 12,
                      textDecoration: "none",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        alignItems: "center",
                        background: `${shortcut.accent}14`,
                        border: `1px solid ${shortcut.accent}33`,
                        borderRadius: PANEL_RADIUS,
                        color: shortcut.accent,
                        display: "flex",
                        height: 32,
                        justifyContent: "center",
                        width: 32,
                      }}
                    >
                      <Icon name={shortcut.icon} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <Text
                        strong
                        style={{
                          color: shortcut.accent,
                          display: "block",
                          fontSize: 12,
                          textTransform: "uppercase",
                        }}
                      >
                        {shortcut.label}
                      </Text>
                      <Text strong style={{ display: "block" }}>
                        {shortcut.title}
                      </Text>
                      <Text type="secondary">{shortcut.body}</Text>
                    </span>
                  </a>
                ))}
              </div>
              <div
                aria-label="CoCalc.ai deployment path cards"
                role="group"
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
                {options.map((option) => (
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
                          background: alpha(option.accent, 0.08),
                          border: `1px solid ${alpha(option.accent, 0.22)}`,
                          borderRadius: PANEL_RADIUS,
                          color: option.accent,
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
                        <Flex gap={6} style={{ marginTop: 6 }} wrap>
                          {option.cues.map((cue) => (
                            <Tag
                              key={cue}
                              style={{
                                background: alpha(option.accent, 0.08),
                                borderColor: alpha(option.accent, 0.22),
                                color: option.accent,
                                marginInlineEnd: 0,
                              }}
                            >
                              {cue}
                            </Tag>
                          ))}
                        </Flex>
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
                          color: option.accent,
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
                        color: option.accent,
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

function DetailRoutesSection() {
  const routes = [
    {
      body: "Use the policy page for trust and compliance references.",
      href: appPath("policies/trust"),
      icon: "lock",
      label: "Trust policy",
    },
    {
      body: "Review local-runtime details on the CoCalc Plus page.",
      href: appPath("products/cocalc-plus"),
      icon: "laptop",
      label: "CoCalc Plus details",
    },
    {
      body: "Compare hosted, local, and customer-operated paths.",
      href: appPath("products"),
      icon: "servers",
      label: "Deployment comparison",
    },
    {
      body: "Use support for scope, onboarding, or account questions.",
      href: appPath("support"),
      icon: "support",
      label: "Support",
    },
    {
      body: "Ask about hosted-service transition planning.",
      href: supportPurchasePath(
        "Hosted transition",
        "I have a question about hosted CoCalc service transition planning.",
      ),
      icon: "question-circle",
      label: "Hosted transition questions",
    },
  ] satisfies {
    body: string;
    href: string;
    icon: IconName;
    label: string;
  }[];

  return (
    <section
      aria-label="CoCalc.ai controlled detail routes"
      style={{
        background: PUBLIC_COLORS.surfaceMuted,
        borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `1px solid ${PUBLIC_COLORS.border}`,
        marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
        padding: `28px ${PUBLIC_PAGE_GUTTER}`,
      }}
    >
      <Flex align="start" justify="space-between" wrap gap={16}>
        <div style={{ maxWidth: 660 }}>
          <Eyebrow>Detail routes</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Use detail pages for boundary questions.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            Boundaries differ by deployment path. Keep trust, support, Plus,
            deployment, and hosted-service questions on their controlled routes.
          </Paragraph>
        </div>
      </Flex>
      <div
        aria-label="CoCalc.ai boundary detail route links"
        role="group"
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          marginTop: 20,
        }}
      >
        {routes.map((route) => (
          <a
            href={route.href}
            key={route.label}
            style={{
              alignItems: "start",
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              color: "inherit",
              display: "grid",
              gap: 10,
              gridTemplateColumns: "34px minmax(0, 1fr)",
              minHeight: 104,
              padding: 14,
              textDecoration: "none",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                alignItems: "center",
                background: alpha(PUBLIC_COLORS.brand, 0.08),
                border: `1px solid ${alpha(PUBLIC_COLORS.brand, 0.2)}`,
                borderRadius: PANEL_RADIUS,
                color: PUBLIC_COLORS.brand,
                display: "flex",
                height: 34,
                justifyContent: "center",
                width: 34,
              }}
            >
              <Icon name={route.icon} />
            </span>
            <span style={{ minWidth: 0 }}>
              <Text strong style={{ display: "block" }}>
                {route.label}
              </Text>
              <Text type="secondary">{route.body}</Text>
            </span>
          </a>
        ))}
      </div>
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
  const deploymentPaths = [
    {
      accent: PUBLIC_COLORS.brand,
      body: "Managed hosted workspace for accounts, projects, and teams.",
      button: config?.is_authenticated ? "Open projects" : "Start on CoCalc.ai",
      href: config?.is_authenticated
        ? appPath("projects")
        : appPath("auth/sign-up"),
      icon: "cloud",
      route: "Hosted",
      title: "CoCalc.ai",
    },
    {
      accent: PUBLIC_COLORS.success,
      body: "Local runtime for one user on Linux or Mac.",
      button: "Install CoCalc Plus",
      href: "https://software.cocalc.ai/software/cocalc-plus/index.html",
      icon: "laptop",
      route: "Local",
      title: "CoCalc Plus",
    },
    {
      accent: PUBLIC_COLORS.warning,
      body: "Compare hosted, local, and customer-operated paths before choosing a runtime boundary.",
      button: "Compare deployment options",
      href: appPath("products"),
      icon: "servers",
      route: "Deployment",
      title: "Deployment comparison",
    },
  ] satisfies {
    accent: string;
    body: string;
    button: string;
    href: string;
    icon: IconName;
    route: string;
    title: string;
  }[];
  const siteLicenseHref = supportPurchasePath(
    "Site license",
    "I want to discuss a CoCalc site license.",
  );

  return (
    <section
      aria-label="CoCalc.ai final calls to action"
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
            <Eyebrow>Start here</Eyebrow>
            <Title level={2} style={{ margin: "8px 0 0" }}>
              Choose a hosted, local, or private path.
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: 18,
                margin: "12px 0 0",
                maxWidth: 760,
              }}
            >
              Start hosted, install CoCalc Plus, or compare deployment options.
              Use site licensing for procurement, governance, support, and
              rollout once the operating path is clear.
            </Paragraph>
          </Col>
        </Row>
        <div
          aria-label="CoCalc.ai final deployment path actions"
          role="group"
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
          }}
        >
          {deploymentPaths.map((path, index) => (
            <div
              key={path.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${alpha(path.accent, 0.24)}`,
                borderRadius: PANEL_RADIUS,
                display: "flex",
                flexDirection: "column",
                minHeight: 190,
                padding: 18,
              }}
            >
              <Flex align="start" gap={12} style={{ marginBottom: 14 }}>
                <div
                  style={{
                    alignItems: "center",
                    background: alpha(path.accent, 0.08),
                    border: `1px solid ${alpha(path.accent, 0.22)}`,
                    borderRadius: PANEL_RADIUS,
                    color: path.accent,
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
                <div style={{ minWidth: 0 }}>
                  <Tag
                    style={{
                      background: alpha(path.accent, 0.08),
                      borderColor: alpha(path.accent, 0.22),
                      color: path.accent,
                      marginBottom: 8,
                      marginInlineEnd: 0,
                    }}
                  >
                    {path.route}
                  </Tag>
                  <Title level={4} style={{ margin: "0 0 6px" }}>
                    {path.title}
                  </Title>
                </div>
              </Flex>
              <Paragraph style={{ margin: 0 }}>{path.body}</Paragraph>
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
        <div
          style={{
            background: alpha(PUBLIC_COLORS.surface, 0.82),
            border: `1px solid ${PUBLIC_COLORS.warningBorder}`,
            borderRadius: PANEL_RADIUS,
            padding: 18,
          }}
        >
          <Flex align="center" gap={16} justify="space-between" wrap>
            <Flex align="start" gap={12} style={{ maxWidth: 760 }}>
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: PUBLIC_COLORS.warningTint,
                  border: `1px solid ${PUBLIC_COLORS.warningBorder}`,
                  borderRadius: PANEL_RADIUS,
                  color: PUBLIC_COLORS.warning,
                  display: "flex",
                  flex: "0 0 44px",
                  fontSize: 20,
                  height: 44,
                  justifyContent: "center",
                  width: 44,
                }}
              >
                <Icon name="bank" />
              </span>
              <span>
                <Text strong style={{ display: "block" }}>
                  Site licensing is the organizational wrapper.
                </Text>
                <Text type="secondary">
                  Use it for procurement, governance, support, rollout, and
                  broader deployment rights after the runtime path is clear.
                </Text>
              </span>
            </Flex>
            <Flex gap={10} wrap>
              <Button
                href={siteLicenseHref}
                icon={<DecorativeButtonIcon name="bank" />}
              >
                Discuss site licensing
              </Button>
            </Flex>
          </Flex>
        </div>
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
      <LandingRouteMapSection authenticated={!!config?.is_authenticated} />
      <WorkspaceContextSection authenticated={!!config?.is_authenticated} />
      <WorkInputSection />
      <WorkflowsSection />
      <NextActionSection />
      <AudienceSection />
      <ProductOptionsSection />
      <DetailRoutesSection />
      <NewsSection initialNews={news} />
      <BottomCallout config={config} />
    </PublicPage>
  );
}
