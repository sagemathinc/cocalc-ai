/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type CSSProperties, type ReactNode, useEffect } from "react";

import { Button, Flex, Tag, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getSiteName, type PublicConfig } from "@cocalc/frontend/public/config";
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
    .cocalc-public-home-product-grid,
    .cocalc-public-home-difference-grid,
    .cocalc-public-home-path-grid {
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }
`;

const HERO_TAGS = [
  "Minimal free tier",
  "Standard trial planned",
  "Free CoCalc Plus",
  "Self-host with Star",
] as const;

const PROJECT_FACTS = [
  {
    body: "Notebook execution, agent turns, terminal sessions, document history, and files are backend state, not fragile browser state.",
    title: "Work survives the browser",
  },
  {
    body: "Multiple people can share notebooks, terminals, files, chat, and review workflows in the same project.",
    title: "Collaboration is everywhere",
  },
] as const;

const WORKFLOW_FEATURES = [
  {
    accent: COLORS.RUN,
    href: "features/jupyter-notebook",
    icon: "jupyter",
    label: "Compute",
    summary:
      "Run Jupyter notebooks directly in the browser with collaboration, synchronized output, time travel, and course workflows built in.",
    title: "Jupyter Notebooks",
  },
  {
    accent: PUBLIC_COLORS.warning,
    href: "features/latex-editor",
    icon: "tex",
    label: "Writing",
    summary:
      "Edit LaTeX in the browser with synchronized collaboration, build output, history, and the rest of the CoCalc project environment close by.",
    title: "LaTeX Editor",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    href: "features/terminal",
    icon: "terminal",
    label: "Linux",
    summary:
      "Work in a shared Linux shell, keep tools and files near your notebooks and documents, and avoid local environment drift.",
    title: "Linux Terminal",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    href: "features/ai",
    icon: "robot",
    label: "Agent help",
    summary:
      "Work with Codex inside collaborative chat threads that stay close to project files, notebooks, terminals, images, and review context.",
    title: "Codex Agent Chat",
  },
  {
    accent: PUBLIC_COLORS.success,
    href: "features/teaching",
    icon: "graduation-cap",
    label: "Courses",
    summary:
      "Organize assignments, distribute files, collect work, and grade notebooks or other project files with a workflow built for technical classes.",
    title: "Teaching a Course",
  },
  {
    accent: COLORS.ANTD_RED,
    href: "features/whiteboard",
    icon: "slides",
    label: "Visual work",
    summary:
      "Use an infinite collaborative canvas with markdown, KaTeX, Jupyter cells, multiple pages, and a transparent JSONL document format.",
    title: "Whiteboard",
  },
] satisfies Array<{
  accent: string;
  href: string;
  icon: IconName;
  label: string;
  summary: string;
  title: string;
}>;

const PROJECT_MODEL_ITEMS = [
  { icon: "files", label: "Files" },
  { icon: "history", label: "TimeTravel" },
  { icon: "users", label: "People" },
  { icon: "disk-snapshot", label: "Recovery" },
] satisfies Array<{ icon: IconName; label: string }>;

const PRODUCT_OPTIONS = [
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Use CoCalc in the public cloud with a minimal free tier and a path to standard plans.",
    icon: "cloud",
    label: "Hosted",
    title: "Hosted CoCalc",
  },
  {
    accent: COLORS.RUN,
    body: "Install the free single-user app on your own Linux or Mac computer.",
    icon: "laptop",
    label: "Local",
    title: "CoCalc Plus",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Paste one command on a public Ubuntu VM and get a shared HTTPS CoCalc appliance.",
    icon: "star",
    label: "Self-hosted",
    title: "CoCalc Star",
  },
  {
    accent: COLORS.GRAY_D,
    body: "Use Launchpad or Rocket for operator-managed deployments, custom hosts, and production scale.",
    icon: "servers",
    label: "Operators",
    title: "Launchpad + Rocket",
  },
] satisfies Array<{
  accent: string;
  body: string;
  icon: IconName;
  label: string;
  title: string;
}>;

const PRODUCT_MODEL_ITEMS = [
  "Files",
  "Notebooks",
  "Terminals",
  "Chat",
  "Agents",
] as const;

const DIFFERENCE_SIGNALS = [
  { icon: "jupyter", label: "Notebook output" },
  { icon: "files", label: "Linux filesystem" },
  { icon: "users", label: "Team activity" },
  { icon: "disk-snapshot", label: "Snapshots and backups" },
] satisfies Array<{ icon: IconName; label: string }>;

const DIFFERENTIATORS = [
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Run cells, commands, terminals, and agent turns without tying the useful state to one browser tab.",
    eyebrow: "State survives",
    icon: "clock",
    title: "Durable execution",
  },
  {
    accent: COLORS.RUN,
    body: "Use sudo, apt, Python packages, RootFS images, SSH, and project snapshots instead of pretending technical work has no environment.",
    eyebrow: "Real environment",
    icon: "linux",
    title: "Real Linux projects",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Chat, notebooks, terminals, files, whiteboards, git review, and support workflows are designed for more than one person.",
    eyebrow: "Shared by default",
    icon: "users",
    title: "Realtime collaboration",
  },
  {
    accent: COLORS.GRAY_M,
    body: "Snapshots, backups, TimeTravel, project movement, and RootFS versions make project state recoverable and reusable.",
    eyebrow: "Recoverable work",
    icon: "database",
    title: "Operational safety",
  },
] satisfies Array<{
  accent: string;
  body: string;
  eyebrow: string;
  icon: IconName;
  title: string;
}>;

const PATH_TAGS = ["Notebooks", "Terminals", "Agents", "TimeTravel"] as const;

const PATH_OPTIONS = [
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Use the public CoCalc site with the minimal free tier, then move up to a standard plan when you need more.",
    button: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? "Open projects" : "Create account",
    href: ({ authenticated }: { authenticated: boolean }) =>
      authenticated ? appPath("projects") : appPath("auth/sign-up"),
    icon: "cloud",
    title: "Hosted CoCalc",
  },
  {
    accent: COLORS.RUN,
    body: "Install the free single-user CoCalc app on your own Linux or Mac computer.",
    button: () => "Download CoCalc Plus",
    href: () => PLUS_DOWNLOAD_URL,
    icon: "laptop",
    title: "CoCalc Plus",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Run a shared CoCalc appliance on a public Ubuntu VM with automatic HTTPS.",
    button: () => "Install CoCalc Star",
    href: () => appPath("products/cocalc-star"),
    icon: "star",
    title: "CoCalc Star",
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
  body: ReactNode;
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
        <Paragraph style={{ fontSize: 18, margin: 0 }}>{body}</Paragraph>
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
        gridTemplateColumns: "minmax(0, 0.9fr) minmax(320px, 1.1fr)",
        padding: "32px 0 12px",
      }}
    >
      <Flex vertical gap={20}>
        <Eyebrow>Collaborative computational projects</Eyebrow>
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
            AI-Native Technical Workspace for Humans and Agents
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
            {siteName} brings notebooks, terminals, files, LaTeX, chat,
            whiteboards, snapshots, backups, and Codex agent threads into one
            collaborative Linux project.
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
            {authenticated ? "Open projects" : "Start free"}
          </Button>
          <Button href={appPath("pricing")} size="large">
            See plans
          </Button>
          <Button href={appPath("products/cocalc-plus")} size="large">
            Get CoCalc Plus
          </Button>
        </Flex>
        <Flex gap={8} wrap>
          {HERO_TAGS.map((tag) => (
            <Tag
              key={tag}
              style={{
                background: PUBLIC_COLORS.brandSubtle,
                borderColor: alpha(PUBLIC_COLORS.link, 0.16),
                color: PUBLIC_COLORS.link,
                marginInlineEnd: 0,
              }}
            >
              {tag}
            </Tag>
          ))}
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
      aria-label="The project is the product"
      className="cocalc-public-home-project"
      style={{
        alignItems: "center",
        display: "grid",
        gap: 34,
        gridTemplateColumns: "minmax(320px, 0.9fr) minmax(0, 1fr)",
        padding: "24px 0",
      }}
    >
      <img
        alt="One CoCalc project containing many workflows"
        className="cocalc-public-home-workflow-image"
        decoding="async"
        loading="lazy"
        src={WORKFLOW_IMAGE_URL}
        style={{
          aspectRatio: "16 / 9",
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: PANEL_RADIUS,
          boxShadow: `0 18px 45px ${alpha(PUBLIC_COLORS.brandDark, 0.08)}`,
          display: "block",
          objectFit: "cover",
          width: "100%",
        }}
      />
      <Flex vertical gap={18}>
        <div>
          <Eyebrow>The project is the product</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            One durable place for technical work.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            CoCalc is not just a notebook host or a terminal in a tab. A project
            is a persistent workspace with files, compute, document history,
            collaborators, chat, AI agents, snapshots, and backups.
          </Paragraph>
        </div>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          {PROJECT_FACTS.map((fact) => (
            <div
              key={fact.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                boxShadow: `0 18px 44px ${alpha(PUBLIC_COLORS.brandDark, 0.07)}`,
                minHeight: 154,
                padding: 22,
              }}
            >
              <Title level={4} style={{ margin: "0 0 10px" }}>
                {fact.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>{fact.body}</Paragraph>
            </div>
          ))}
        </div>
      </Flex>
    </section>
  );
}

function WorkflowsSection() {
  return (
    <section aria-label="Core workflows" style={{ padding: "28px 0" }}>
      <SectionIntro
        action={<Button href={appPath("features")}>All features</Button>}
        body="CoCalc keeps notebooks, papers, terminals, agents, classes, and visual thinking inside one shared project instead of scattering them across disconnected tools."
        eyebrow="Core workflows"
        title="Use the tools you already understand, together."
      />
      <div
        className="cocalc-public-home-workflow-layout"
        style={{
          alignItems: "stretch",
          display: "grid",
          gap: 18,
          gridTemplateColumns: "250px minmax(0, 1fr)",
          marginTop: 26,
        }}
      >
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
                  One project
                </Text>
                <Text style={{ display: "block" }} type="secondary">
                  Shared files, compute, history, and collaboration.
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
                minHeight: 210,
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
                <Tag
                  style={{
                    alignSelf: "flex-start",
                    background: alpha(feature.accent, 0.08),
                    borderColor: alpha(feature.accent, 0.2),
                    color: feature.accent,
                    marginInlineEnd: 0,
                  }}
                >
                  {feature.label}
                </Tag>
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
        alignItems: "center",
        display: "grid",
        gap: 34,
        gridTemplateColumns: "minmax(0, 0.8fr) minmax(360px, 1.2fr)",
        padding: "36px 0",
      }}
    >
      <Flex vertical gap={16}>
        <div>
          <Eyebrow>Ways to run CoCalc</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Hosted, local, self-hosted, or enterprise scale.
          </Title>
          <Paragraph style={{ fontSize: 18, margin: 0 }}>
            Use the public cloud, install the free single-user CoCalc Plus app,
            run your own public VM with CoCalc Star, or step up to Launchpad and
            Rocket for operator-managed deployments.
          </Paragraph>
        </div>
        <Flex gap={10} wrap>
          <Button href={appPath("products")} type="primary">
            Compare products
          </Button>
          <Button href={appPath("products/cocalc-star")}>CoCalc Star</Button>
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
        <Flex align="center" justify="space-between" wrap gap={12}>
          <Text strong style={{ color: PUBLIC_COLORS.link }}>
            Same CoCalc workspace model
          </Text>
          <Flex gap={6} wrap>
            {PRODUCT_MODEL_ITEMS.map((item) => (
              <Tag
                key={item}
                style={{
                  background: PUBLIC_COLORS.brandSubtle,
                  borderColor: alpha(PUBLIC_COLORS.link, 0.14),
                  color: PUBLIC_COLORS.link,
                  marginInlineEnd: 0,
                }}
              >
                {item}
              </Tag>
            ))}
          </Flex>
        </Flex>
        <div
          className="cocalc-public-home-product-grid"
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            marginTop: 18,
          }}
        >
          {PRODUCT_OPTIONS.map((option) => (
            <div
              key={option.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${alpha(option.accent, 0.18)}`,
                borderRadius: PANEL_RADIUS,
                minHeight: 230,
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
        <Flex align="center" gap={8} style={{ marginTop: 16 }}>
          <Text type="secondary">Individual</Text>
          <span
            aria-hidden="true"
            style={{
              background: `linear-gradient(90deg, ${COLORS.ANTD_LINK_BLUE_DARK}, ${PUBLIC_COLORS.success}, ${PUBLIC_COLORS.warning})`,
              borderRadius: PANEL_RADIUS,
              display: "block",
              flex: 1,
              height: 4,
            }}
          />
          <Text type="secondary">Organization</Text>
        </Flex>
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
            Built for real computational work, not only polished demos.
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc treats a project as a durable technical environment: files,
            running work, collaboration, history, and recovery all belong
            together.
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
          alignItems: "end",
          display: "grid",
          gap: 22,
          gridTemplateColumns: "minmax(0, 1fr) auto",
        }}
      >
        <div>
          <Eyebrow>Choose your path</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Start using CoCalc
          </Title>
          <Paragraph style={{ fontSize: 17, margin: 0, maxWidth: 760 }}>
            Start hosted, install the free local app, or run your own CoCalc
            site. The workspace model stays familiar across all three.
          </Paragraph>
        </div>
        <Flex gap={6} wrap>
          {PATH_TAGS.map((tag) => (
            <Tag
              key={tag}
              style={{
                background: PUBLIC_COLORS.surface,
                borderColor: PUBLIC_COLORS.border,
                color:
                  tag === "Terminals"
                    ? PUBLIC_COLORS.success
                    : tag === "Agents"
                      ? PUBLIC_COLORS.warning
                      : PUBLIC_COLORS.link,
                marginInlineEnd: 0,
              }}
            >
              {tag}
            </Tag>
          ))}
        </Flex>
      </div>
      <div
        className="cocalc-public-home-path-grid"
        style={{
          display: "grid",
          gap: 18,
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
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
          Want help choosing? Compare products or contact support.
        </Text>
        <Flex gap={8} wrap>
          <Button href={appPath("products")}>Compare products</Button>
          <Button href={appPath("guides")}>Guides</Button>
          <Button href={appPath("support")}>Support</Button>
        </Flex>
      </Flex>
    </section>
  );
}

export default function PublicHomeApp({ config }: { config?: HomeConfig }) {
  const siteName = getSiteName(config);
  const authenticated = !!config?.is_authenticated;

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = siteName;
  }, [siteName]);

  return (
    <PublicPage active="home" config={config}>
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
        <ProjectSection />
        <WorkflowsSection />
        <ProductsSection />
        <DifferenceSection />
        <PathSection authenticated={authenticated} />
      </div>
    </PublicPage>
  );
}
