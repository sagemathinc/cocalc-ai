/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect, useState } from "react";

import { Button, Flex, Modal, Tag, Typography } from "antd";

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
    .cocalc-public-home-products,
    .cocalc-public-home-difference,
    .cocalc-public-home-workflow-layout {
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
    .cocalc-public-home-audience-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }
  }

  @media (max-width: 1120px) {
    .cocalc-public-home-final-layout,
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
    .cocalc-public-home-final-actions .ant-btn {
      width: 100%;
    }

    .cocalc-public-home-feature-grid,
    .cocalc-public-home-audience-grid,
    .cocalc-public-home-product-grid,
    .cocalc-public-home-difference-grid,
    .cocalc-public-home-modal-grid,
    .cocalc-public-home-final-actions {
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
    body: "Give teams one place to inspect experiments, code, papers, outputs, and AI-assisted changes.",
    button: "Explore workflows",
    href: "features/compare",
    icon: "project-outlined",
    title: "Research and engineering teams",
  },
  {
    accent: COLORS.RUN,
    body: "Organize assignments, grading, shared environments, and student support around project work.",
    button: "Course workflows",
    href: "features/teaching",
    icon: "graduation-cap",
    title: "Technical courses and workshops",
  },
  {
    accent: COLORS.GRAY_D,
    body: "Compare hosted use, local evaluation, a single-VM appliance, and customer-operated deployment options.",
    button: "Compare operating models",
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
    href: "auth/sign-up",
    icon: "cloud",
    label: "Hosted",
    title: "CoCalc.ai",
  },
  {
    accent: COLORS.RUN,
    body: "Free source-available local runtime for self-directed technical work and evaluation.",
    href: "products/cocalc-plus",
    icon: "laptop",
    label: "Local",
    title: "CoCalc Plus",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Single-VM appliance for a shared CoCalc instance on a public Ubuntu VM or local Lima VM.",
    href: "products/cocalc-star",
    icon: "star",
    label: "One VM",
    title: "CoCalc Star",
  },
  {
    accent: PUBLIC_COLORS.warning,
    body: "Lightweight customer-operated private deployment for pilots, labs, workshops, and small teams.",
    href: "products/cocalc-launchpad",
    icon: "servers",
    label: "Private",
    title: "CoCalc Launchpad",
  },
  {
    accent: COLORS.GRAY_D,
    body: "Enterprise private-cloud path for institutions and organizations with broader deployment requirements.",
    href: "products/cocalc-rocket",
    icon: "rocket",
    label: "Enterprise",
    title: "CoCalc Rocket",
  },
] satisfies Array<{
  accent: string;
  body: string;
  href: string;
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
    ctaHref: "features/compare",
    ctaLabel: "Compare CoCalc",
    details: PROJECT_FACTS,
    eyebrow: "Project continuity",
    icon: "project-outlined",
    modalBody:
      "CoCalc projects keep the working record close to the files, outputs, notes, and decisions people need to understand later.",
    title: "Project-centered workflow",
  },
  {
    accent: COLORS.RUN,
    body: "Review live collaboration and AI-assisted changes in the project before teammates build on them.",
    ctaHref: "features/ai",
    ctaLabel: "Explore AI workflows",
    details: [
      {
        body: "Realtime editing, chat, and shared outputs let people inspect work together before handoff.",
        title: "Review together",
      },
      {
        body: "Codex edits, test output, screenshots, and discussion stay close enough for teammates to inspect.",
        title: "Inspect exact changes",
      },
      {
        body: "Teams can keep reasoning, patches, outputs, and follow-up questions close to the work.",
        title: "Keep evidence together",
      },
    ],
    eyebrow: "Review together",
    icon: "search",
    modalBody:
      "CoCalc keeps human collaboration, AI-assisted changes, files, notebooks, terminals, outputs, and discussion close enough for people to inspect the work before relying on it.",
    title: "Inspection before handoff",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "History, TimeTravel, snapshots, and backups help teams understand changes and return to useful states.",
    ctaHref: "features/jupyter-notebook",
    ctaLabel: "See TimeTravel in notebooks",
    details: [
      {
        body: "Project history and TimeTravel help teams understand how work changed over time.",
        title: "Trace what changed",
      },
      {
        body: "Snapshots and backups give teams practical ways to resume from known project states.",
        title: "Recover useful states",
      },
      {
        body: "Shared files, notes, and outputs keep recovery grounded in the project record.",
        title: "Resume with context",
      },
    ],
    eyebrow: "Keep moving",
    icon: "history",
    modalBody:
      "Recovery works best when history, snapshots, backups, and the surrounding project context stay close enough for teams to continue.",
    title: "Practical recovery",
  },
  {
    accent: COLORS.GRAY_M,
    body: "Start hosted, evaluate locally, use a single appliance VM, or plan a customer-operated private environment.",
    ctaHref: "products",
    ctaLabel: "Compare operating models",
    details: [
      {
        body: "Use CoCalc.ai when the team wants a managed hosted workspace without operating infrastructure.",
        title: "Hosted workspace",
      },
      {
        body: "Use Plus or Star when local evaluation or a bounded single-VM appliance is the right fit.",
        title: "Local or single-VM",
      },
      {
        body: "Use Launchpad or Rocket when the organization needs a customer-operated private environment.",
        title: "Private deployment",
      },
    ],
    eyebrow: "Choose where it runs",
    icon: "cloud",
    modalBody:
      "The product paths are operating models, not a progression. The right choice depends on hosting, governance, support, and deployment needs.",
    title: "Operating model choice",
  },
] satisfies Array<{
  accent: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
  details: ReadonlyArray<{
    body: string;
    title: string;
  }>;
  eyebrow: string;
  icon: IconName;
  modalBody: string;
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
            Your tools, AI agents, and team — together in one project.
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
            CoCalc gives teams one shared place to work, review changes, and
            keep going without rebuilding context.
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
            Compare operating models
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

function AudienceRoutesSection() {
  return (
    <section aria-label="Who CoCalc helps" style={{ padding: "10px 0 24px" }}>
      <SectionIntro
        eyebrow="Who it helps"
        title="Built for research, teaching, and technical teams."
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
          <a
            className="cocalc-public-home-card-link cocalc-public-home-audience-card"
            href={appPath(route.href)}
            key={route.title}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${alpha(route.accent, 0.18)}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 12px 34px ${alpha(PUBLIC_COLORS.brandDark, 0.05)}`,
              color: "inherit",
              display: "grid",
              gap: 16,
              gridTemplateRows: "44px minmax(96px, 1fr) auto",
              minHeight: 220,
              padding: 22,
              textDecoration: "none",
            }}
          >
            <IconTile accent={route.accent} icon={route.icon} />
            <div>
              <Title level={4} style={{ margin: "0 0 8px" }}>
                {route.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>{route.body}</Paragraph>
            </div>
            <Text
              className="cocalc-public-home-audience-action"
              strong
              style={{
                alignItems: "center",
                color: PUBLIC_COLORS.link,
                display: "inline-flex",
                gap: 6,
              }}
            >
              {route.button}
            </Text>
          </a>
        ))}
      </div>
    </section>
  );
}

function WorkflowsSection() {
  return (
    <section aria-label="Core workflows" style={{ padding: "28px 0" }}>
      <SectionIntro
        action={
          <Button href={appPath("features")}>Browse feature workflows</Button>
        }
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
                <IconTile accent={feature.accent} icon={feature.icon} />
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
            Compare operating models
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
            <a
              className="cocalc-public-home-card-link"
              href={appPath(option.href)}
              key={option.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${alpha(option.accent, 0.18)}`,
                borderRadius: PANEL_RADIUS,
                color: "inherit",
                display: "block",
                minHeight: 225,
                padding: 16,
                textDecoration: "none",
              }}
            >
              <Flex vertical gap={12}>
                <IconTile accent={option.accent} icon={option.icon} />
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
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function DifferenceSection() {
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const activeItem =
    DIFFERENTIATORS.find((item) => item.title === activeTitle) ?? null;

  return (
    <>
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
            <button
              aria-haspopup="dialog"
              className="cocalc-public-home-card-link cocalc-public-home-difference-card"
              key={item.title}
              onClick={() => setActiveTitle(item.title)}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                color: "inherit",
                cursor: "pointer",
                minHeight: 240,
                padding: 22,
                textAlign: "left",
              }}
              type="button"
            >
              <Flex vertical gap={14}>
                <IconTile accent={item.accent} icon={item.icon} />
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
                <Text strong style={{ color: PUBLIC_COLORS.link }}>
                  View details
                </Text>
              </Flex>
            </button>
          ))}
        </div>
      </section>
      <Modal
        footer={null}
        onCancel={() => setActiveTitle(null)}
        open={activeItem != null}
        title={activeItem?.title}
        width={720}
      >
        {activeItem == null ? null : (
          <Flex vertical gap={18}>
            <Paragraph style={{ fontSize: 16, margin: 0 }}>
              {activeItem.modalBody}
            </Paragraph>
            <div
              className="cocalc-public-home-modal-grid"
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              }}
            >
              {activeItem.details.map((detail) => (
                <div
                  key={detail.title}
                  style={{
                    background: PUBLIC_COLORS.surfaceMuted,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PANEL_RADIUS,
                    padding: 14,
                  }}
                >
                  <Text strong>{detail.title}</Text>
                  <Paragraph style={{ margin: "8px 0 0" }}>
                    {detail.body}
                  </Paragraph>
                </div>
              ))}
            </div>
            <Button href={appPath(activeItem.ctaHref)} type="primary">
              {activeItem.ctaLabel}
            </Button>
          </Flex>
        )}
      </Modal>
    </>
  );
}

function PathSection({ authenticated }: { authenticated: boolean }) {
  return (
    <section
      aria-label="Next step"
      style={{
        background: `linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.warningTint} 100%)`,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        margin: "16px 0 0",
        padding: 36,
      }}
    >
      <div
        className="cocalc-public-home-final-layout"
        style={{
          alignItems: "center",
          display: "grid",
          gap: 24,
          gridTemplateColumns: "minmax(0, 1fr) auto",
        }}
      >
        <div>
          <Eyebrow>Next step</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Ready to choose how CoCalc fits?
          </Title>
          <Paragraph style={{ fontSize: 17, margin: 0, maxWidth: 760 }}>
            Start with the hosted workspace, compare the operating models, or
            contact CoCalc when licensing, procurement, support, or private
            deployment are part of the decision.
          </Paragraph>
        </div>
        <div
          className="cocalc-public-home-final-actions"
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(3, max-content)",
          }}
        >
          <Button
            href={authenticated ? appPath("projects") : appPath("auth/sign-up")}
            type="primary"
          >
            {authenticated ? "Open projects" : "Start on CoCalc.ai"}
          </Button>
          <Button href={appPath("products")}>Compare operating models</Button>
          <Button href={appPath("support")}>Talk with CoCalc</Button>
        </div>
      </div>
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
        <PathSection authenticated={authenticated} />
      </div>
    </PublicPage>
  );
}
