/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Col, Empty, Flex, Row, Tag, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { getPublicMarketingConfig } from "@cocalc/frontend/public/config";
import {
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import AIFeaturePage from "./ai-page";
import ApiFeaturePage from "./api-page";
import {
  getFeatureIndexPages,
  getFeaturePage,
  type FeaturePage,
} from "./catalog";
import CompareFeaturePage from "./compare-page";
import JupyterNotebookFeaturePage from "./jupyter-notebook-page";
import JuliaFeaturePage from "./julia-page";
import LatexEditorFeaturePage from "./latex-editor-page";
import LinuxFeaturePage from "./linux-page";
import OctaveFeaturePage from "./octave-page";
import {
  FeatureImage,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";
import RStatisticalSoftwareFeaturePage from "./r-statistical-software-page";
import type { PublicFeaturesRoute } from "./routes";
import { featurePath } from "./routes";
import SageFeaturePage from "./sage-page";
import PythonFeaturePage from "./python-page";
import SlidesFeaturePage from "./slides-page";
import TeachingFeaturePage from "./teaching-page";
import TerminalFeaturePage from "./terminal-page";
import WhiteboardFeaturePage from "./whiteboard-page";

const { Paragraph, Text, Title } = Typography;

interface FeaturesConfig {
  cocalc_product?: string;
  help_email?: string;
  is_launchpad?: boolean;
  is_authenticated?: boolean;
  logo_square?: string;
  site_name?: string;
}

interface PublicFeaturesAppProps {
  config?: FeaturesConfig;
  initialRoute: PublicFeaturesRoute;
}

const FEATURE_DETAIL_COMPONENTS = {
  ai: AIFeaturePage,
  api: ApiFeaturePage,
  compare: CompareFeaturePage,
  "jupyter-notebook": JupyterNotebookFeaturePage,
  julia: JuliaFeaturePage,
  "latex-editor": LatexEditorFeaturePage,
  linux: LinuxFeaturePage,
  octave: OctaveFeaturePage,
  python: PythonFeaturePage,
  "r-statistical-software": RStatisticalSoftwareFeaturePage,
  sage: SageFeaturePage,
  slides: SlidesFeaturePage,
  teaching: TeachingFeaturePage,
  terminal: TerminalFeaturePage,
  whiteboard: WhiteboardFeaturePage,
} as const;

const FEATURE_INDEX_PRIORITY = [
  "ai",
  "jupyter-notebook",
  "latex-editor",
  "terminal",
  "linux",
  "whiteboard",
  "teaching",
  "compare",
] as const;

const FEATURE_GROUPS = [
  {
    accent: COLORS.BLUE_D,
    description:
      "Notebooks, papers, whiteboards, slides, and technical writing in one collaborative project.",
    icon: "jupyter",
    slugs: ["jupyter-notebook", "latex-editor", "whiteboard", "slides"],
    title: "Documents",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    description:
      "A real Linux environment with terminals, language stacks, graphical apps, and installable software.",
    icon: "terminal",
    slugs: [
      "terminal",
      "linux",
      "python",
      "r-statistical-software",
      "julia",
      "sage",
      "octave",
    ],
    title: "Compute",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    description:
      "Codex and AI assistance where files, notebooks, terminals, and chat already live.",
    icon: "robot",
    slugs: ["ai", "compare", "api"],
    title: "AI and automation",
  },
  {
    accent: COLORS.RUN,
    description:
      "Course workflows, grading, shared environments, and collaborative help for technical classes.",
    icon: "graduation-cap",
    slugs: ["teaching"],
    title: "Teaching",
  },
] as const;

const FEATURE_META = {
  ai: { accent: COLORS.AI_ASSISTANT_FONT, icon: "robot", label: "Agents" },
  api: { accent: COLORS.ANTD_LINK_BLUE_DARK, icon: "api", label: "API" },
  compare: { accent: COLORS.BLUE_D, icon: "swap", label: "Positioning" },
  "jupyter-notebook": {
    accent: COLORS.BLUE_D,
    icon: "jupyter",
    label: "Notebook",
  },
  julia: { accent: COLORS.BRWN, icon: "julia", label: "Language" },
  "latex-editor": { accent: COLORS.YELL_D, icon: "tex", label: "Writing" },
  linux: {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    icon: "linux",
    label: "Environment",
  },
  octave: { accent: COLORS.FG_RED, icon: "octave", label: "Language" },
  python: { accent: COLORS.BLUE_D, icon: "python", label: "Language" },
  "r-statistical-software": {
    accent: COLORS.BLUE_DD,
    icon: "r",
    label: "Stats",
  },
  sage: { accent: COLORS.RUN, icon: "sagemath", label: "Math" },
  slides: { accent: COLORS.BG_WARNING, icon: "slides", label: "Present" },
  teaching: { accent: COLORS.RUN, icon: "graduation-cap", label: "Courses" },
  terminal: {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    icon: "terminal",
    label: "Shell",
  },
  whiteboard: { accent: COLORS.FG_RED, icon: "layout", label: "Canvas" },
} satisfies Record<string, { accent: string; icon: IconName; label: string }>;

const FEATURE_STARTERS = [
  {
    body: "Notebook-first computation with files, output, and review history nearby.",
    icon: "jupyter",
    slug: "jupyter-notebook",
    title: "Notebooks",
  },
  {
    body: "A browser Linux shell for scripts, packages, services, and debugging.",
    icon: "terminal",
    slug: "terminal",
    title: "Terminals",
  },
  {
    body: "Codex agent work in the same project context your team uses.",
    icon: "robot",
    slug: "ai",
    title: "AI agents",
  },
  {
    body: "Files, collaborators, snapshots, and product paths as one workspace model.",
    icon: "project-outlined",
    slug: "compare",
    title: "Projects",
  },
] satisfies {
  body: string;
  icon: IconName;
  slug: string;
  title: string;
}[];

const FEATURE_PANEL_RADIUS = 8;

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

const FEATURE_PANEL_SHADOW = `0 14px 34px ${alpha(
  PUBLIC_COLORS.heading,
  0.07,
)}`;

function featureMeta(slug: string) {
  return (
    FEATURE_META[slug as keyof typeof FEATURE_META] ?? {
      accent: PUBLIC_COLORS.brand,
      icon: "star",
      label: "Feature",
    }
  );
}

function titleForRoute(route: PublicFeaturesRoute): string {
  if (route.view === "detail" && route.slug) {
    return `${getFeaturePage(route.slug)?.title ?? "Features"} – CoCalc`;
  }
  return "CoCalc Features";
}

function getOrderedFeatureIndexPages(): FeaturePage[] {
  const priorities = new Map<string, number>(
    FEATURE_INDEX_PRIORITY.map((slug, index) => [slug, index]),
  );
  return getFeatureIndexPages()
    .map((page, index) => ({ index, page }))
    .sort((a, b) => {
      const aPriority = priorities.get(a.page.slug);
      const bPriority = priorities.get(b.page.slug);
      if (aPriority != null || bPriority != null) {
        return (aPriority ?? 100) - (bPriority ?? 100);
      }
      return a.index - b.index;
    })
    .map(({ page }) => page);
}

function getAdjacentFeaturePages(currentSlug: string): {
  next?: FeaturePage;
  previous?: FeaturePage;
} {
  const pages = getOrderedFeatureIndexPages();
  const currentIndex = pages.findIndex((page) => page.slug === currentSlug);
  if (currentIndex < 0) return {};
  return {
    next: pages[currentIndex + 1],
    previous: pages[currentIndex - 1],
  };
}

function ButtonIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex" }}>
      <Icon name={name} />
    </span>
  );
}

function FeatureLinkCard({ page }: { page: FeaturePage }) {
  const meta = featureMeta(page.slug);
  return (
    <a
      href={featurePath(page.slug)}
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: FEATURE_PANEL_RADIUS,
        boxShadow: FEATURE_PANEL_SHADOW,
        color: "inherit",
        display: "block",
        height: "100%",
        minHeight: 168,
        padding: 18,
        textDecoration: "none",
      }}
    >
      <Flex vertical gap={12}>
        <Flex align="center" justify="space-between">
          <div
            style={{
              alignItems: "center",
              background: `${meta.accent}14`,
              border: `1px solid ${meta.accent}33`,
              borderRadius: FEATURE_PANEL_RADIUS,
              color: meta.accent,
              display: "flex",
              fontSize: 22,
              height: 44,
              justifyContent: "center",
              width: 44,
            }}
          >
            <Icon name={meta.icon} />
          </div>
          <Icon name="arrow-right" style={{ color: meta.accent }} />
        </Flex>
        <Tag
          style={{
            alignSelf: "flex-start",
            background: `${meta.accent}12`,
            borderColor: `${meta.accent}2e`,
            color: meta.accent,
            marginInlineEnd: 0,
          }}
        >
          {meta.label}
        </Tag>
        <div>
          <Title level={4} style={{ margin: "0 0 8px" }}>
            {page.title}
          </Title>
          <Paragraph style={{ margin: 0 }}>{page.summary}</Paragraph>
        </div>
      </Flex>
    </a>
  );
}

function CapabilityCard({
  body,
  icon,
  title,
}: {
  body: string;
  icon: IconName;
  title: string;
}) {
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: FEATURE_PANEL_RADIUS,
        boxShadow: FEATURE_PANEL_SHADOW,
        height: "100%",
        padding: 20,
      }}
    >
      <Flex gap={14}>
        <div
          style={{
            alignItems: "center",
            background: PUBLIC_COLORS.surfaceMuted,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: FEATURE_PANEL_RADIUS,
            color: PUBLIC_COLORS.brand,
            display: "flex",
            flex: "0 0 auto",
            fontSize: 24,
            height: 48,
            justifyContent: "center",
            width: 48,
          }}
        >
          <Icon name={icon} />
        </div>
        <div>
          <Title level={3} style={{ margin: "0 0 8px" }}>
            {title}
          </Title>
          <Paragraph style={{ margin: 0 }}>{body}</Paragraph>
        </div>
      </Flex>
    </div>
  );
}

function FeatureGroupSection({
  group,
  pages,
}: {
  group: (typeof FEATURE_GROUPS)[number];
  pages: FeaturePage[];
}) {
  const groupPages = group.slugs
    .map((slug) => pages.find((page) => page.slug === slug))
    .filter((page) => page != null);
  if (!groupPages.length) return null;

  return (
    <section>
      <Row gutter={[18, 18]}>
        <Col lg={6} xs={24}>
          <div
            style={{
              background: `linear-gradient(145deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.surfaceMuted} 100%)`,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: FEATURE_PANEL_RADIUS,
              boxShadow: FEATURE_PANEL_SHADOW,
              padding: 24,
            }}
          >
            <Flex vertical gap={16}>
              <div
                style={{
                  alignItems: "center",
                  background: `${group.accent}14`,
                  border: `1px solid ${group.accent}33`,
                  borderRadius: FEATURE_PANEL_RADIUS,
                  color: group.accent,
                  display: "flex",
                  fontSize: 26,
                  height: 52,
                  justifyContent: "center",
                  width: 52,
                }}
              >
                <Icon name={group.icon} />
              </div>
              <div>
                <Title level={2} style={{ margin: "0 0 8px" }}>
                  {group.title}
                </Title>
                <Paragraph
                  style={{
                    color: PUBLIC_COLORS.mutedText,
                    margin: 0,
                  }}
                >
                  {group.description}
                </Paragraph>
              </div>
              <div
                aria-hidden="true"
                style={{
                  background: `linear-gradient(180deg, ${group.accent}66 0%, ${group.accent}12 100%)`,
                  borderRadius: 999,
                  height: 90,
                  width: 4,
                }}
              />
            </Flex>
          </div>
        </Col>
        <Col lg={18} xs={24}>
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            }}
          >
            {groupPages.map((page) => (
              <FeatureLinkCard key={page.slug} page={page} />
            ))}
          </div>
        </Col>
      </Row>
    </section>
  );
}

function FeaturesIndex() {
  const pages = getOrderedFeatureIndexPages();
  return (
    <>
      <section>
        <Row align="middle" gutter={[36, 36]}>
          <Col lg={11} xs={24}>
            <Flex vertical gap={20}>
              <Tag color="blue" style={{ width: "fit-content" }}>
                Feature map
              </Tag>
              <Title
                level={1}
                style={{
                  fontSize: 64,
                  letterSpacing: 0,
                  lineHeight: 0.92,
                  margin: 0,
                }}
              >
                The CoCalc workspace model.
              </Title>
              <Paragraph
                style={{
                  color: PUBLIC_COLORS.mutedText,
                  fontSize: 21,
                  margin: 0,
                }}
              >
                CoCalc features make the most sense as one project workspace:
                documents, compute, AI agents, teaching, and operations share
                the same files, collaborators, history, and environment.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button href={featurePath("compare")} type="primary">
                  Compare workspace model
                </Button>
                <Button href={appPath("products")}>
                  Compare product paths
                </Button>
                <Button href={appPath("pricing")}>Pricing and licensing</Button>
              </Flex>
            </Flex>
          </Col>
          <Col lg={13} xs={24}>
            <FeatureImage
              alt="CoCalc feature map with documents, compute, AI, teaching, and platform categories"
              src="/public/landing/feature-map.jpg"
            />
          </Col>
        </Row>
      </section>

      <section aria-label="CoCalc feature starting points">
        <Flex align="end" justify="space-between" wrap gap={14}>
          <div>
            <Text
              strong
              style={{
                color: PUBLIC_COLORS.brand,
                display: "block",
                fontSize: 12,
                textTransform: "uppercase",
              }}
            >
              Start with
            </Text>
            <Title level={2} style={{ margin: "8px 0 0" }}>
              Choose the workflow you recognize.
            </Title>
          </div>
          <Button href={featurePath("compare")}>Open comparison</Button>
        </Flex>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            marginTop: 18,
          }}
        >
          {FEATURE_STARTERS.map((starter) => {
            const meta = featureMeta(starter.slug);
            return (
              <a
                href={featurePath(starter.slug)}
                key={starter.slug}
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: FEATURE_PANEL_RADIUS,
                  color: "inherit",
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "42px minmax(0, 1fr)",
                  minHeight: 124,
                  padding: 16,
                  textDecoration: "none",
                }}
              >
                <span
                  style={{
                    alignItems: "center",
                    background: `${meta.accent}12`,
                    border: `1px solid ${meta.accent}2e`,
                    borderRadius: FEATURE_PANEL_RADIUS,
                    color: meta.accent,
                    display: "flex",
                    fontSize: 20,
                    height: 42,
                    justifyContent: "center",
                    width: 42,
                  }}
                >
                  <Icon name={starter.icon} />
                </span>
                <span>
                  <Text strong style={{ display: "block" }}>
                    {starter.title}
                  </Text>
                  <Text type="secondary">{starter.body}</Text>
                </span>
              </a>
            );
          })}
        </div>
      </section>

      <section>
        <Row gutter={[18, 18]}>
          <Col lg={8} xs={24}>
            <div
              style={{
                background: `linear-gradient(145deg, ${PUBLIC_COLORS.surfaceMuted} 0%, ${PUBLIC_COLORS.surface} 100%)`,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: FEATURE_PANEL_RADIUS,
                boxShadow: FEATURE_PANEL_SHADOW,
                height: "100%",
                padding: 22,
              }}
            >
              <Flex vertical gap={18}>
                <Flex align="center" gap={14}>
                  <div
                    style={{
                      alignItems: "center",
                      background: PUBLIC_COLORS.surfaceMuted,
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: FEATURE_PANEL_RADIUS,
                      color: PUBLIC_COLORS.brand,
                      display: "flex",
                      fontSize: 24,
                      height: 50,
                      justifyContent: "center",
                      width: 50,
                    }}
                  >
                    <Icon name="project-outlined" />
                  </div>
                  <div>
                    <Text strong style={{ color: PUBLIC_COLORS.brand }}>
                      One project
                    </Text>
                    <Title level={3} style={{ margin: "4px 0 0" }}>
                      The shared unit of work.
                    </Title>
                  </div>
                </Flex>
                <Paragraph style={{ margin: 0 }}>
                  Files, compute, documents, chat, agents, history, snapshots,
                  backups, and collaborators stay together across product paths.
                </Paragraph>
                <Flex gap={8} wrap>
                  {["Files", "Runtime", "History", "People", "Agents"].map(
                    (label) => (
                      <Tag
                        key={label}
                        color="blue"
                        style={{ marginInlineEnd: 0 }}
                      >
                        {label}
                      </Tag>
                    ),
                  )}
                </Flex>
              </Flex>
            </div>
          </Col>
          <Col lg={8} xs={24}>
            <CapabilityCard
              body="CoCalc projects keep files, notebooks, terminals, chat, agents, snapshots, backups, and history together instead of splitting work across unrelated tools."
              icon="history"
              title="Durable collaborative projects"
            />
          </Col>
          <Col lg={8} xs={24}>
            <CapabilityCard
              body="Codex can work in the same project context as humans: reading files, using terminals, interacting with notebooks, writing documents, and participating in durable chat threads."
              icon="robot"
              title="Agent-aware by design"
            />
          </Col>
        </Row>
      </section>

      {FEATURE_GROUPS.map((group) => (
        <FeatureGroupSection group={group} key={group.title} pages={pages} />
      ))}

      <section>
        <Flex align="end" justify="space-between" wrap gap={14}>
          <div>
            <Title level={2} style={{ margin: 0 }}>
              Full feature index
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                margin: "8px 0 0",
                maxWidth: "70ch",
              }}
            >
              Prefer the alphabetical view? Every feature page is still one
              click away. Product paths and pricing explain where the shared
              workspace should run.
            </Paragraph>
          </div>
        </Flex>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            marginTop: 18,
          }}
        >
          {pages.map((page) => {
            const meta = featureMeta(page.slug);
            return (
              <a
                href={featurePath(page.slug)}
                key={page.slug}
                style={{
                  alignItems: "center",
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: FEATURE_PANEL_RADIUS,
                  color: "inherit",
                  display: "flex",
                  gap: 12,
                  padding: "12px 14px",
                  textDecoration: "none",
                }}
              >
                <span
                  style={{
                    alignItems: "center",
                    background: `${meta.accent}12`,
                    borderRadius: FEATURE_PANEL_RADIUS,
                    color: meta.accent,
                    display: "flex",
                    flex: "0 0 auto",
                    height: 36,
                    justifyContent: "center",
                    width: 36,
                  }}
                >
                  <Icon name={meta.icon} />
                </span>
                <Text strong>{page.title}</Text>
              </a>
            );
          })}
        </div>
      </section>
    </>
  );
}

function FeatureDetailNavigation({ page }: { page: FeaturePage }) {
  const { next, previous } = getAdjacentFeaturePages(page.slug);
  const meta = featureMeta(page.slug);

  return (
    <section
      aria-label="Feature page navigation"
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        padding: 16,
      }}
    >
      <Flex align="center" justify="space-between" wrap gap={14}>
        <Flex align="center" gap={12} wrap>
          <span
            aria-hidden="true"
            style={{
              alignItems: "center",
              background: `${meta.accent}12`,
              border: `1px solid ${meta.accent}2e`,
              borderRadius: 8,
              color: meta.accent,
              display: "inline-flex",
              fontSize: 20,
              height: 42,
              justifyContent: "center",
              width: 42,
            }}
          >
            <Icon name={meta.icon} />
          </span>
          <span>
            <Text
              strong
              style={{
                color: PUBLIC_COLORS.brand,
                display: "block",
                fontSize: 12,
                letterSpacing: 0,
                textTransform: "uppercase",
              }}
            >
              Feature detail
            </Text>
            <Text strong>{page.title}</Text>
          </span>
        </Flex>
        <Flex wrap gap={10}>
          <Button href={featurePath()} icon={<ButtonIcon name="overview" />}>
            All features
          </Button>
          {previous ? (
            <Button
              href={featurePath(previous.slug)}
              icon={<ButtonIcon name="arrow-left" />}
            >
              Previous: {previous.title}
            </Button>
          ) : null}
          {next ? (
            <Button
              href={featurePath(next.slug)}
              icon={<ButtonIcon name="arrow-right" />}
              type="primary"
            >
              Next: {next.title}
            </Button>
          ) : null}
        </Flex>
      </Flex>
    </section>
  );
}

function FeatureProductPathLinks({ currentSlug }: { currentSlug: string }) {
  const { next, previous } = getAdjacentFeaturePages(currentSlug);

  return (
    <PublicSection>
      <Title level={3} style={{ margin: 0 }}>
        Choose how CoCalc should run for you.
      </Title>
      <Paragraph style={{ margin: 0 }}>
        These feature pages describe shared workspace capabilities. Next, choose
        hosted CoCalc.ai, local CoCalc Plus, single-VM CoCalc Star, or a
        customer-operated private deployment with Launchpad or Rocket.
      </Paragraph>
      <Flex wrap gap={12}>
        <Button href={appPath("products")} type="primary">
          Choose product path
        </Button>
        <Button href={appPath("pricing")}>Pricing and licensing</Button>
        {currentSlug !== "compare" ? (
          <LinkButton href={featurePath("compare")}>
            Compare workspace model
          </LinkButton>
        ) : null}
        <LinkButton href={featurePath()}>Feature map</LinkButton>
      </Flex>
      {previous || next ? (
        <Flex wrap gap={12}>
          {previous ? (
            <LinkButton href={featurePath(previous.slug)}>
              Previous feature: {previous.title}
            </LinkButton>
          ) : null}
          {next ? (
            <LinkButton href={featurePath(next.slug)}>
              Next feature: {next.title}
            </LinkButton>
          ) : null}
        </Flex>
      ) : null}
    </PublicSection>
  );
}

function FeatureDetailContent({
  helpEmail,
  isAuthenticated,
  page,
  slug,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
  page: FeaturePage;
  slug: string;
}) {
  const CustomPage =
    FEATURE_DETAIL_COMPONENTS[slug as keyof typeof FEATURE_DETAIL_COMPONENTS];

  if (slug === "ai") {
    return (
      <AIFeaturePage helpEmail={helpEmail} isAuthenticated={isAuthenticated} />
    );
  }
  if (slug === "jupyter-notebook") {
    return (
      <JupyterNotebookFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "latex-editor") {
    return (
      <LatexEditorFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "teaching") {
    return (
      <TeachingFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "terminal") {
    return (
      <TerminalFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "linux") {
    return (
      <LinuxFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "python") {
    return (
      <PythonFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "sage") {
    return (
      <SageFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "whiteboard") {
    return (
      <WhiteboardFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "slides") {
    return (
      <SlidesFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "r-statistical-software") {
    return (
      <RStatisticalSoftwareFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "octave") {
    return (
      <OctaveFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "julia") {
    return (
      <JuliaFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (CustomPage) {
    return <CustomPage helpEmail={helpEmail} />;
  }

  return (
    <Flex vertical gap={18}>
      <div>
        <Button type="link" href={featurePath()} style={{ paddingInline: 0 }}>
          Back to features
        </Button>
      </div>
      <PublicSection>
        <FeatureImage alt={page.title} src={page.image} />
        <Title level={2} style={{ margin: 0 }}>
          {page.title}
        </Title>
        <Paragraph style={{ fontSize: 18, margin: 0 }}>
          {page.tagline}
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>{page.summary}</Paragraph>
        <Flex wrap gap={12}>
          {page.docsUrl ? (
            <Button
              type="link"
              href={page.docsUrl}
              style={{ paddingInline: 0 }}
            >
              Documentation
            </Button>
          ) : null}
          <Button type="primary" href={appPath("auth/sign-up")}>
            Create account
          </Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSection>
      {(page.sections ?? []).map((section) => (
        <PublicSection key={section.title}>
          <Title level={3} style={{ margin: 0 }}>
            {section.title}
          </Title>
          {(section.paragraphs ?? []).map((paragraph) => (
            <Paragraph key={paragraph} style={{ margin: 0 }}>
              {paragraph}
            </Paragraph>
          ))}
          {section.bullets?.length ? (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {section.bullets.map((bullet) => (
                <li key={bullet} style={{ marginBottom: 6 }}>
                  {bullet}
                </li>
              ))}
            </ul>
          ) : null}
          {section.links?.length ? (
            <Flex wrap gap={12}>
              {section.links.map((link) => (
                <Button
                  key={link.href}
                  type="link"
                  href={link.href}
                  style={{ paddingInline: 0 }}
                >
                  {link.label}
                </Button>
              ))}
            </Flex>
          ) : null}
        </PublicSection>
      ))}
    </Flex>
  );
}

function FeatureDetail({
  helpEmail,
  isAuthenticated,
  slug,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
  slug: string;
}) {
  const page = getFeaturePage(slug);
  if (!page) {
    return (
      <PublicSection>
        <Empty description="Feature page not found" />
        <div>
          <Button type="link" href={featurePath()} style={{ paddingInline: 0 }}>
            Back to features
          </Button>
        </div>
      </PublicSection>
    );
  }

  return (
    <>
      <FeatureDetailNavigation page={page} />
      <FeatureDetailContent
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
        page={page}
        slug={page.slug}
      />
      <FeatureProductPathLinks currentSlug={page.slug} />
    </>
  );
}

export default function PublicFeaturesApp({
  config,
  initialRoute,
}: PublicFeaturesAppProps) {
  const marketingConfig = getPublicMarketingConfig(config);
  const title = titleForRoute(initialRoute);

  useEffect(() => {
    document.title = title;
  }, [title]);

  const feature = initialRoute.slug
    ? getFeaturePage(initialRoute.slug)
    : undefined;

  return (
    <PublicPage
      active="features"
      config={marketingConfig}
      title={
        initialRoute.view === "index"
          ? undefined
          : (feature?.title ?? "Features")
      }
    >
      {initialRoute.view === "detail" && initialRoute.slug ? (
        <FeatureDetail
          helpEmail={config?.help_email}
          isAuthenticated={!!config?.is_authenticated}
          slug={initialRoute.slug}
        />
      ) : (
        <FeaturesIndex />
      )}
    </PublicPage>
  );
}
