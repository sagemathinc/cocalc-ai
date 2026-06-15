/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type CSSProperties, type ReactNode, useEffect } from "react";

import { Button, Flex, Tag, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  getPublicMarketingConfig,
  getPublicMarketingSiteName,
  type PublicConfig,
} from "@cocalc/frontend/public/config";
import { PublicPage } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

interface HomeConfig extends PublicConfig {
  site_description?: string;
}

const HERO_IMAGE_URL = "/public/landing/home-hero.jpg";
const WORKFLOW_IMAGE_URL = "/public/landing/project-workflows.jpg";
const PUBLIC_PAGE_GUTTER = "max(16px, calc((100vw - 1200px) / 2))";
const PANEL_RADIUS = 8;
const PLUS_DOWNLOAD_URL =
  "https://software.cocalc.ai/software/cocalc-plus/index.html";

const HOME_PAGE_CSS = `
  .cocalc-public-home {
    color: ${PUBLIC_COLORS.text};
  }

  .cocalc-public-home a {
    transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
  }

  .cocalc-public-home > section {
    scroll-margin-top: 76px;
  }

  .cocalc-public-home-card-link:hover {
    border-color: ${PUBLIC_COLORS.linkHover} !important;
    box-shadow: 0 18px 44px ${alpha(PUBLIC_COLORS.brandDark, 0.1)} !important;
    transform: translateY(-1px);
  }

  .cocalc-public-home-hero-image,
  .cocalc-public-home-workflow-image {
    max-width: 100%;
  }

  @media (max-width: 920px) {
    .cocalc-public-home-hero,
    .cocalc-public-home-project,
    .cocalc-public-home-products,
    .cocalc-public-home-difference,
    .cocalc-public-home-workflow-layout,
    .cocalc-public-home-path {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    .cocalc-public-home-hero-title {
      font-size: 42px !important;
      line-height: 1.08 !important;
    }

    .cocalc-public-home-hero-image {
      order: 2;
    }

    .cocalc-public-home-product-grid,
    .cocalc-public-home-audience-grid,
    .cocalc-public-home-path-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }
  }

  @media (max-width: 1120px) {
    .cocalc-public-home-workflow-layout {
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }

  @media (max-width: 560px) {
    .cocalc-public-home {
      gap: 28px !important;
    }

    .cocalc-public-home-hero-title {
      font-size: 34px !important;
    }

    .cocalc-public-home-actions .ant-btn,
    .cocalc-public-home-final-links .ant-btn {
      width: 100%;
    }

    .cocalc-public-home-feature-grid,
    .cocalc-public-home-project-card-grid,
    .cocalc-public-home-audience-grid,
    .cocalc-public-home-product-grid,
    .cocalc-public-home-difference-grid,
    .cocalc-public-home-path-grid {
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }
`;

const PROJECT_FACTS = [
  {
    body: "Source files, outputs, notes, and decisions stay tied to the project instead of disappearing across separate places.",
    title: "Context survives handoff",
  },
  {
    body: "History and shared artifacts make human and AI-assisted changes easier to inspect before the next person builds on them.",
    title: "Review stays close",
  },
  {
    body: "Snapshots, backups, and project history help teams resume useful work instead of piecing context back together.",
    title: "Recovery remains practical",
  },
] as const;

const WORKFLOW_FEATURES = [
  {
    accent: COLORS.RUN,
    href: "features/jupyter-notebook",
    icon: "jupyter",
    summary:
      "Run standard Jupyter notebooks in shared project context with synchronized output, history, and course workflows nearby.",
    title: "Jupyter Notebooks",
  },
  {
    accent: PUBLIC_COLORS.warning,
    href: "features/latex-editor",
    icon: "tex",
    summary:
      "Write papers and technical documents with collaboration, build output, history, and project files close by.",
    title: "LaTeX Editor",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    href: "features/terminal",
    icon: "terminal",
    summary:
      "Use Linux terminals in the same workspace as notebooks, documents, files, and shared project history.",
    title: "Linux Terminal",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    href: "features/ai",
    icon: "robot",
    summary:
      "Ask Codex to help with files, notebooks, terminals, and documents while humans keep review context in the same workspace.",
    title: "Codex Agent Chat",
  },
  {
    accent: PUBLIC_COLORS.success,
    href: "features/teaching",
    icon: "graduation-cap",
    summary:
      "Run technical courses and workshops with shared files, notebooks, grading workflows, and collaborative support built into the workspace.",
    title: "Teaching a Course",
  },
  {
    accent: COLORS.ANTD_RED,
    href: "features/whiteboard",
    icon: "slides",
    summary:
      "Sketch ideas, formulas, and notebook-backed explanations on a collaborative canvas that lives with the project.",
    title: "Whiteboard",
  },
] satisfies Array<{
  accent: string;
  href: string;
  icon: IconName;
  summary: string;
  title: string;
}>;

const AUDIENCE_ROUTES = [
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Give teams a common place for experiments, code, papers, outputs, and AI-assisted changes they can inspect together.",
    button: "Explore workflows",
    href: "features/compare",
    icon: "project-outlined",
    title: "Research and engineering teams",
  },
  {
    accent: COLORS.RUN,
    body: "Organize assignments, grading, shared environments, and student support around the technical project work.",
    button: "Course workflows",
    href: "features/teaching",
    icon: "graduation-cap",
    title: "Technical courses and workshops",
  },
  {
    accent: COLORS.GRAY_D,
    body: "Separate everyday hosted use from local evaluation, single-VM appliance, and customer-operated deployment decisions.",
    button: "Compare product paths",
    href: "products",
    icon: "servers",
    title: "IT and platform teams",
  },
] satisfies Array<{
  accent: string;
  body: string;
  button: string;
  href: string;
  icon: IconName;
  title: string;
}>;

const PROJECT_MODEL_ITEMS = [
  { icon: "files", label: "Code and files" },
  { icon: "jupyter", label: "Notebooks" },
  { icon: "tex", label: "Documents" },
  { icon: "history", label: "History" },
] satisfies Array<{ icon: IconName; label: string }>;

const PRODUCT_OPTIONS = [
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Managed hosted workspace for individuals and teams that do not want to run infrastructure.",
    icon: "cloud",
    label: "Hosted",
    title: "CoCalc.ai",
  },
  {
    accent: COLORS.RUN,
    body: "Free source-available local runtime for self-directed technical work and evaluation.",
    icon: "laptop",
    label: "Local",
    title: "CoCalc Plus",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Single-VM appliance for a shared CoCalc instance on a public Ubuntu VM or local Lima VM.",
    icon: "star",
    label: "One VM",
    title: "CoCalc Star",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Lightweight customer-operated private deployment for pilots, labs, workshops, and small teams.",
    icon: "servers",
    label: "Private",
    title: "CoCalc Launchpad",
  },
  {
    accent: COLORS.GRAY_D,
    body: "Enterprise private-cloud path for institutions and organizations with broader deployment requirements.",
    icon: "rocket",
    label: "Enterprise",
    title: "CoCalc Rocket",
  },
] satisfies Array<{
  accent: string;
  body: string;
  icon: IconName;
  label: string;
  title: string;
}>;

const DIFFERENCE_SIGNALS = [
  { icon: "files", label: "Shared context" },
  { icon: "users", label: "Collaboration" },
  { icon: "history", label: "Review history" },
  { icon: "disk-snapshot", label: "Recovery paths" },
] satisfies Array<{ icon: IconName; label: string }>;

const DIFFERENTIATORS = [
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Keep the main artifacts of computational work near the discussions, outputs, and decisions they produce.",
    eyebrow: "Project continuity",
    icon: "project-outlined",
    title: "Project-centered workflow",
  },
  {
    accent: COLORS.RUN,
    body: "Human and AI changes are easier to inspect and discuss before another person depends on them.",
    eyebrow: "Inspect before handoff",
    icon: "search",
    title: "Inspection before handoff",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "History, shared files, TimeTravel, snapshots, and backups give teams paths back to useful work.",
    eyebrow: "Keep moving",
    icon: "history",
    title: "Practical recovery",
  },
  {
    accent: COLORS.GRAY_M,
    body: "Start hosted, evaluate locally, use a single appliance VM, or plan a customer-operated private environment.",
    eyebrow: "Choose where it runs",
    icon: "cloud",
    title: "Deployment path choice",
  },
] satisfies Array<{
  accent: string;
  body: string;
  eyebrow: string;
  icon: IconName;
  title: string;
}>;

const PATH_OPTIONS = [
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Use the managed hosted workspace when your team wants CoCalc without operating infrastructure.",
    button: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? "Open projects" : "Start on CoCalc.ai",
    href: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? appPath("projects") : appPath("auth/sign-up"),
    icon: "cloud",
    title: "Hosted CoCalc",
  },
  {
    accent: COLORS.RUN,
    body: "Install the free local runtime for self-directed work, demos, and evaluation.",
    button: () => "Download CoCalc Plus",
    href: () => PLUS_DOWNLOAD_URL,
    icon: "laptop",
    title: "CoCalc Plus",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Explore the single-VM appliance for a shared CoCalc instance on a public Ubuntu VM or local Lima VM.",
    button: () => "Explore CoCalc Star",
    href: () => appPath("products/cocalc-star"),
    icon: "star",
    title: "CoCalc Star",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Compare hosted, local, appliance, and private deployment paths before choosing.",
    button: () => "Compare paths",
    href: () => appPath("products"),
    icon: "servers",
    title: "Deployment options",
  },
  {
    accent: COLORS.GRAY_D,
    body: "Talk with CoCalc when governance, procurement, onboarding, support, or broader deployment rights matter.",
    button: () => "Pricing and licensing",
    href: () => appPath("pricing"),
    icon: "solution",
    title: "Site licensing",
  },
] satisfies Array<{
  accent: string;
  body: string;
  button: (opts: { authenticated: boolean }) => string;
  href: (opts: { authenticated: boolean }) => string;
  icon: IconName;
  title: string;
}>;

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

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <Text
      strong
      style={{
        color: PUBLIC_COLORS.link,
        display: "block",
        fontSize: 12,
        letterSpacing: 0,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

function IconTile({
  accent,
  icon,
  size = 42,
}: {
  accent: string;
  icon: IconName;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        alignItems: "center",
        background: alpha(accent, 0.1),
        border: `1px solid ${alpha(accent, 0.22)}`,
        borderRadius: PANEL_RADIUS,
        color: accent,
        display: "inline-flex",
        flex: `0 0 ${size}px`,
        fontSize: Math.max(16, Math.round(size * 0.45)),
        height: size,
        justifyContent: "center",
        width: size,
      }}
    >
      <Icon name={icon} />
    </span>
  );
}

function DecorativeButtonIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex" }}>
      <Icon name={name} />
    </span>
  );
}

function DecorativeInlineIcon({
  name,
  style,
}: {
  name: IconName;
  style?: CSSProperties;
}) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", ...style }}>
      <Icon name={name} />
    </span>
  );
}

function SectionIntro({
  eyebrow,
  title,
  body,
  action,
}: {
  action?: ReactNode;
  body?: ReactNode;
  eyebrow: ReactNode;
  title: ReactNode;
}) {
  return (
    <Flex align="end" justify="space-between" wrap gap={16}>
      <div style={{ maxWidth: 760 }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <Title level={2} style={{ margin: "8px 0 10px" }}>
          {title}
        </Title>
        {body == null ? null : (
          <Paragraph style={{ fontSize: 18, margin: 0 }}>{body}</Paragraph>
        )}
      </div>
      {action}
    </Flex>
  );
}

function Hero({
  authenticated,
  siteName,
}: {
  authenticated: boolean;
  siteName: string;
}) {
  return (
    <section
      aria-label={`${siteName} hero`}
      className="cocalc-public-home-hero"
      style={{
        alignItems: "center",
        display: "grid",
        gap: 42,
        gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 1fr)",
        padding: "32px 0 12px",
      }}
    >
      <Flex vertical gap={20}>
        <Eyebrow>AI-native technical workspace</Eyebrow>
        <div>
          <Title
            className="cocalc-public-home-hero-title"
            level={1}
            style={{
              color: PUBLIC_COLORS.heading,
              fontSize: 58,
              letterSpacing: 0,
              lineHeight: 1.02,
              margin: 0,
              maxWidth: 620,
            }}
          >
            Shared projects for research, teaching, and technical teams
          </Title>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.mutedText,
              fontSize: 19,
              lineHeight: 1.5,
              margin: "20px 0 0",
              maxWidth: 590,
            }}
          >
            CoCalc keeps collaboration, AI assistance, history, and recovery
            tied to the project, so groups can review, hand off, and continue
            work without rebuilding context.
          </Paragraph>
        </div>
        <Flex className="cocalc-public-home-actions" gap={12} wrap>
          <Button
            href={appPath(authenticated ? "projects" : "auth/sign-up")}
            icon={
              <DecorativeButtonIcon
                name={authenticated ? "project-outlined" : "rocket"}
              />
            }
            size="large"
            type="primary"
          >
            {authenticated ? "Open projects" : "Start on CoCalc.ai"}
          </Button>
          <Button href={appPath("products")} size="large">
            Compare product paths
          </Button>
        </Flex>
      </Flex>
      <img
        alt="CoCalc-AI collaborative project overview"
        className="cocalc-public-home-hero-image"
        decoding="async"
        src={HERO_IMAGE_URL}
        style={{
          aspectRatio: "1672 / 941",
          display: "block",
          objectFit: "contain",
          width: "100%",
        }}
      />
    </section>
  );
}

function ProjectSection() {
  return (
    <section
      aria-label="Project continuity"
      className="cocalc-public-home-project"
      style={{
        alignItems: "start",
        display: "grid",
        gap: 28,
        gridTemplateColumns: "minmax(0, 0.72fr) minmax(0, 1.28fr)",
        padding: "16px 0 10px",
      }}
    >
      <div>
        <Eyebrow>Project continuity</Eyebrow>
        <Title level={2} style={{ margin: "8px 0 10px" }}>
          Keep the record with the work.
        </Title>
        <Paragraph style={{ fontSize: 18, margin: 0 }}>
          A result is easier to trust, teach, hand off, or extend when the
          source, discussion, history, environment, and decisions are still
          nearby. CoCalc organizes that continuity around the project so teams
          can review, recover, and continue without reconstructing context.
        </Paragraph>
      </div>
      <div
        className="cocalc-public-home-project-card-grid"
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        }}
      >
        {PROJECT_FACTS.map((fact) => (
          <div
            key={fact.title}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 12px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.05)}`,
              minHeight: 170,
              padding: 20,
            }}
          >
            <Title level={4} style={{ margin: "0 0 10px" }}>
              {fact.title}
            </Title>
            <Paragraph style={{ margin: 0 }}>{fact.body}</Paragraph>
          </div>
        ))}
      </div>
    </section>
  );
}

function AudienceRoutesSection() {
  return (
    <section aria-label="Who CoCalc helps" style={{ padding: "10px 0 24px" }}>
      <SectionIntro
        eyebrow="Who it helps"
        title="Built for research, courses, and platform teams."
        body="Start with the path that matches how your group works."
      />
      <div
        className="cocalc-public-home-audience-grid"
        style={{
          display: "grid",
          gap: 18,
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          marginTop: 24,
        }}
      >
        {AUDIENCE_ROUTES.map((route) => (
          <div
            key={route.title}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${alpha(route.accent, 0.18)}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 12px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.05)}`,
              minHeight: 220,
              padding: 22,
            }}
          >
            <Flex vertical gap={16}>
              <IconTile accent={route.accent} icon={route.icon} />
              <div>
                <Title level={4} style={{ margin: "0 0 8px" }}>
                  {route.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>{route.body}</Paragraph>
              </div>
              <Button href={appPath(route.href)}>{route.button}</Button>
            </Flex>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkflowsSection() {
  return (
    <section aria-label="Core workflows" style={{ padding: "28px 0" }}>
      <SectionIntro
        action={<Button href={appPath("features")}>All features</Button>}
        body="Open notebooks, writing, terminals, agents, courses, and visual collaboration without moving work into a separate product."
        eyebrow="Core workflows"
        title="Work where the project already lives."
      />
      <div
        className="cocalc-public-home-workflow-layout"
        style={{
          alignItems: "stretch",
          display: "grid",
          gap: 18,
          gridTemplateColumns: "400px minmax(0, 1fr)",
          marginTop: 26,
        }}
      >
        <Flex vertical gap={16}>
          <img
            alt="One CoCalc workspace containing many workflows"
            className="cocalc-public-home-workflow-image"
            decoding="async"
            loading="eager"
            src={WORKFLOW_IMAGE_URL}
            style={{
              aspectRatio: "16 / 9",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 12px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.06)}`,
              display: "block",
              objectFit: "contain",
              width: "100%",
            }}
          />
          <aside
            aria-label="One CoCalc project model"
            style={{
              background: `linear-gradient(180deg, ${PUBLIC_COLORS.surfaceMuted} 0%, ${PUBLIC_COLORS.warningTint} 100%)`,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 18px 44px ${alpha(PUBLIC_COLORS.brandDark, 0.07)}`,
              padding: 18,
            }}
          >
            <Flex vertical gap={14}>
              <Flex align="center" gap={12}>
                <IconTile accent={PUBLIC_COLORS.link} icon="project-outlined" />
                <span>
                  <Text strong style={{ color: PUBLIC_COLORS.link }}>
                    Project context
                  </Text>
                  <Text style={{ display: "block" }} type="secondary">
                    People, tools, and AI use the same materials.
                  </Text>
                </span>
              </Flex>
              {PROJECT_MODEL_ITEMS.map((item) => (
                <div
                  key={item.label}
                  style={{
                    alignItems: "center",
                    background: PUBLIC_COLORS.surface,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PANEL_RADIUS,
                    display: "grid",
                    gap: 10,
                    gridTemplateColumns: "24px minmax(0, 1fr)",
                    minHeight: 42,
                    padding: "9px 10px",
                  }}
                >
                  <Icon
                    name={item.icon}
                    style={{ color: PUBLIC_COLORS.link, fontSize: 15 }}
                  />
                  <Text>{item.label}</Text>
                </div>
              ))}
            </Flex>
          </aside>
        </Flex>
        <div
          aria-label="CoCalc workflow feature cards"
          className="cocalc-public-home-feature-grid"
          role="group"
          style={{
            display: "grid",
            gap: 18,
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          }}
        >
          {WORKFLOW_FEATURES.map((feature) => (
            <a
              className="cocalc-public-home-card-link"
              href={appPath(feature.href)}
              key={feature.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                boxShadow: `0 10px 30px ${alpha(PUBLIC_COLORS.brandDark, 0.05)}`,
                color: "inherit",
                minHeight: 190,
                padding: 18,
                textDecoration: "none",
              }}
            >
              <Flex vertical gap={14}>
                <Flex align="center" justify="space-between">
                  <IconTile accent={feature.accent} icon={feature.icon} />
                  <DecorativeInlineIcon
                    name="arrow-right"
                    style={{ color: feature.accent, fontSize: 16 }}
                  />
                </Flex>
                <div>
                  <Title level={4} style={{ margin: "0 0 8px" }}>
                    {feature.title}
                  </Title>
                  <Paragraph style={{ margin: 0 }}>{feature.summary}</Paragraph>
                </div>
              </Flex>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProductsSection() {
  return (
    <section
      aria-label="Ways to run CoCalc"
      className="cocalc-public-home-products"
      style={{
        alignItems: "stretch",
        display: "grid",
        gap: 22,
        gridTemplateColumns: "minmax(0, 1fr)",
        padding: "36px 0",
      }}
    >
      <Flex vertical gap={16}>
        <div>
          <Eyebrow>Ways to run CoCalc</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Choose the operating model that fits your team.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            Start hosted on CoCalc.ai, evaluate locally with CoCalc Plus, run
            one shared VM with CoCalc Star, or choose Launchpad or Rocket when
            your organization needs a customer-operated environment.
          </Paragraph>
        </div>
        <Flex gap={10} wrap>
          <Button href={appPath("products")} type="primary">
            Compare product paths
          </Button>
          <Button href={appPath("pricing")}>Pricing and licensing</Button>
        </Flex>
      </Flex>
      <div
        style={{
          background: PUBLIC_COLORS.surface,
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: PANEL_RADIUS,
          boxShadow: `0 18px 44px ${alpha(PUBLIC_COLORS.brandDark, 0.07)}`,
          padding: 20,
        }}
      >
        <div
          className="cocalc-public-home-product-grid"
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          }}
        >
          {PRODUCT_OPTIONS.map((option) => (
            <div
              key={option.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${alpha(option.accent, 0.18)}`,
                borderRadius: PANEL_RADIUS,
                minHeight: 225,
                padding: 16,
              }}
            >
              <Flex vertical gap={12}>
                <Flex align="center" justify="space-between">
                  <IconTile accent={option.accent} icon={option.icon} />
                  <DecorativeInlineIcon
                    name="arrow-right"
                    style={{ color: alpha(option.accent, 0.68) }}
                  />
                </Flex>
                <Tag
                  style={{
                    alignSelf: "flex-start",
                    background: alpha(option.accent, 0.08),
                    borderColor: alpha(option.accent, 0.2),
                    color: option.accent,
                    marginInlineEnd: 0,
                  }}
                >
                  {option.label}
                </Tag>
                <div>
                  <Title level={4} style={{ margin: "0 0 8px" }}>
                    {option.title}
                  </Title>
                  <Paragraph style={{ margin: 0 }}>{option.body}</Paragraph>
                </div>
              </Flex>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DifferenceSection() {
  return (
    <section
      aria-label="Why CoCalc is different"
      className="cocalc-public-home-difference"
      style={{
        background: `linear-gradient(135deg, ${PUBLIC_COLORS.surfaceMuted} 0%, ${PUBLIC_COLORS.surface} 100%)`,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        display: "grid",
        gap: 34,
        gridTemplateColumns: "minmax(0, 0.7fr) minmax(0, 1.3fr)",
        margin: "16px 0",
        padding: 36,
      }}
    >
      <Flex vertical gap={18}>
        <div>
          <Eyebrow>Why CoCalc is different</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            A workspace built around the project.
          </Title>
          <Paragraph style={{ margin: 0 }}>
            A project is more than a place to store files. CoCalc gives it
            enough structure to hold collaboration, history, recovery, and
            operating choices alongside the work people need to understand.
          </Paragraph>
        </div>
        <div
          style={{
            background: PUBLIC_COLORS.surface,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PANEL_RADIUS,
            display: "grid",
            gap: 10,
            padding: 14,
          }}
        >
          {DIFFERENCE_SIGNALS.map((signal) => (
            <Flex align="center" gap={10} key={signal.label}>
              <IconTile
                accent={PUBLIC_COLORS.link}
                icon={signal.icon}
                size={28}
              />
              <Text strong>{signal.label}</Text>
            </Flex>
          ))}
        </div>
      </Flex>
      <div
        className="cocalc-public-home-difference-grid"
        style={{
          display: "grid",
          gap: 18,
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        }}
      >
        {DIFFERENTIATORS.map((item) => (
          <div
            key={item.title}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              minHeight: 240,
              padding: 22,
            }}
          >
            <Flex vertical gap={14}>
              <Flex align="center" justify="space-between">
                <IconTile accent={item.accent} icon={item.icon} />
                <DecorativeInlineIcon
                  name="arrow-right"
                  style={{ color: alpha(item.accent, 0.55) }}
                />
              </Flex>
              <div>
                <Text
                  strong
                  style={{
                    color: item.accent,
                    display: "block",
                    fontSize: 12,
                    textTransform: "uppercase",
                  }}
                >
                  {item.eyebrow}
                </Text>
                <Title level={4} style={{ margin: "8px 0" }}>
                  {item.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>{item.body}</Paragraph>
              </div>
            </Flex>
          </div>
        ))}
      </div>
    </section>
  );
}

function PathSection({ authenticated }: { authenticated: boolean }) {
  return (
    <section
      aria-label="Choose your path"
      style={{
        background: `linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.warningTint} 100%)`,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        margin: "16px 0 0",
        padding: 36,
      }}
    >
      <div
        className="cocalc-public-home-path"
        style={{
          maxWidth: 780,
        }}
      >
        <Eyebrow>Choose your path</Eyebrow>
        <Title level={2} style={{ margin: "8px 0 10px" }}>
          Pick the next step that matches your situation.
        </Title>
        <Paragraph style={{ fontSize: 17, margin: 0, maxWidth: 760 }}>
          Start on hosted CoCalc.ai for a managed workspace, install Plus for
          local evaluation, use Star for one shared VM, compare Launchpad or
          Rocket for private deployment, or review licensing when procurement,
          governance, or support are part of the decision.
        </Paragraph>
      </div>
      <div
        className="cocalc-public-home-path-grid"
        style={{
          display: "grid",
          gap: 18,
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          marginTop: 26,
        }}
      >
        {PATH_OPTIONS.map((option) => (
          <div
            key={option.title}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 16px 42px ${alpha(PUBLIC_COLORS.brandDark, 0.06)}`,
              minHeight: 245,
              padding: 22,
            }}
          >
            <Flex vertical gap={16}>
              <IconTile accent={option.accent} icon={option.icon} size={48} />
              <div>
                <Title level={4} style={{ margin: "0 0 10px" }}>
                  {option.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>{option.body}</Paragraph>
              </div>
              <Button href={option.href({ authenticated })} type="primary">
                {option.button({ authenticated })}
              </Button>
            </Flex>
          </div>
        ))}
      </div>
      <Flex
        align="center"
        className="cocalc-public-home-final-links"
        justify="space-between"
        style={{ marginTop: 22 }}
        wrap
        gap={12}
      >
        <Text type="secondary">
          Still narrowing it down? Compare product paths, review pricing, or
          contact support.
        </Text>
        <Flex gap={8} wrap>
          <Button href={appPath("products")}>Compare product paths</Button>
          <Button href={appPath("pricing")}>Pricing</Button>
          <Button href={appPath("support")}>Support</Button>
        </Flex>
      </Flex>
    </section>
  );
}

export default function PublicHomeApp({ config }: { config?: HomeConfig }) {
  const marketingConfig = getPublicMarketingConfig(config) as
    | HomeConfig
    | undefined;
  const siteName = getPublicMarketingSiteName(config);
  const authenticated = !!config?.is_authenticated;

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = siteName;
  }, [siteName]);

  return (
    <PublicPage active="home" config={marketingConfig}>
      <style>{HOME_PAGE_CSS}</style>
      <div
        className="cocalc-public-home"
        style={{
          display: "grid",
          gap: 34,
          marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
          paddingInline: PUBLIC_PAGE_GUTTER,
        }}
      >
        <Hero authenticated={authenticated} siteName={siteName} />
        <AudienceRoutesSection />
        <WorkflowsSection />
        <ProductsSection />
        <DifferenceSection />
        <ProjectSection />
        <PathSection authenticated={authenticated} />
      </div>
    </PublicPage>
  );
}
