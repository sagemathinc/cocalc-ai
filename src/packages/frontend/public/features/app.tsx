/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Fragment, useEffect } from "react";

import { Button, Col, Empty, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import {
  getPublicMarketingConfig,
  type PublicConfig,
} from "@cocalc/frontend/public/config";
import {
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import AIFeaturePage from "./ai-page";
import ApiFeaturePage from "./api-page";
import AutomationsFeaturePage from "./automations-page";
import CliFeaturePage from "./cli-page";
import { FEATURE_ACCENTS } from "./feature-accents";
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
import MoreLanguagesFeaturePage from "./more-languages-page";
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

interface FeaturesConfig extends PublicConfig {}

interface PublicFeaturesAppProps {
  config?: FeaturesConfig;
  initialRoute: PublicFeaturesRoute;
}

const FEATURE_DETAIL_COMPONENTS = {
  ai: AIFeaturePage,
  api: ApiFeaturePage,
  automations: AutomationsFeaturePage,
  cli: CliFeaturePage,
  compare: CompareFeaturePage,
  "jupyter-notebook": JupyterNotebookFeaturePage,
  julia: JuliaFeaturePage,
  "latex-editor": LatexEditorFeaturePage,
  linux: LinuxFeaturePage,
  "more-languages": MoreLanguagesFeaturePage,
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
    accent: COLORS.AI_ASSISTANT_FONT,
    description:
      "Use Codex inside CoCalc projects, automate recurring project work, or drive CoCalc from scripts and pipelines.",
    icon: "robot",
    slugs: ["ai", "automations", "cli"],
    title: "AI workflows",
    variant: "cards",
  },
  {
    accent: COLORS.BLUE_D,
    description:
      "Find notebooks, papers, boards, slide decks, and project notes.",
    icon: "jupyter",
    links: [
      {
        href: appPath("docs/files/markdown"),
        label: "Project notes and Markdown",
      },
    ],
    slugs: ["jupyter-notebook", "latex-editor", "whiteboard"],
    title: "Notebooks and writing",
    variant: "cards",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    description:
      "Find shell, Linux, and dedicated hosted capacity for work that needs a real runtime.",
    icon: "terminal",
    slugs: ["terminal", "linux", "project-hosts"],
    title: "Runtime",
    variant: "cards",
  },
  {
    accent: COLORS.RUN,
    description:
      "Jump directly to the language or math environment you need for notebooks, scripts, courses, or research.",
    icon: "python",
    slugs: [
      "python",
      "r-statistical-software",
      "julia",
      "sage",
      "octave",
      "more-languages",
    ],
    title: "Languages",
    variant: "list",
  },
] as const;

const FEATURE_META = {
  ai: { accent: COLORS.AI_ASSISTANT_FONT, icon: "robot" },
  api: { accent: COLORS.ANTD_LINK_BLUE_DARK, icon: "api" },
  automations: { accent: FEATURE_ACCENTS.automations, icon: "sync" },
  cli: { accent: COLORS.GRAY_D, icon: "terminal" },
  compare: { accent: COLORS.BLUE_D, icon: "swap" },
  "jupyter-notebook": {
    accent: COLORS.BLUE_D,
    icon: "jupyter",
  },
  julia: { accent: FEATURE_ACCENTS.julia, icon: "julia" },
  "latex-editor": { accent: COLORS.YELL_D, icon: "tex" },
  linux: {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    icon: "linux",
  },
  "more-languages": { accent: COLORS.GRAY_D, icon: "code" },
  octave: { accent: COLORS.FG_RED, icon: "octave" },
  python: { accent: COLORS.BLUE_D, icon: "python" },
  "project-hosts": { accent: COLORS.ANTD_LINK_BLUE_DARK, icon: "server" },
  "r-statistical-software": {
    accent: COLORS.BLUE_DD,
    icon: "r",
  },
  sage: { accent: COLORS.RUN, icon: "sagemath" },
  slides: { accent: COLORS.BG_WARNING, icon: "slides" },
  teaching: { accent: COLORS.RUN, icon: "graduation-cap" },
  terminal: {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    icon: "terminal",
  },
  whiteboard: { accent: COLORS.FG_RED, icon: "layout" },
} satisfies Record<string, { accent: string; icon: IconName }>;

// Index-specific cards for entries whose public tile should differ from the
// detail-page metadata, plus intentional docs-only surfaces.
const FEATURE_INDEX_CARD_OVERRIDES = {
  cli: {
    href: featurePath("cli"),
    slug: "cli",
    summary:
      "Use the CoCalc CLI for technical automation, browser scripting, and operational workflows that need a command-line surface.",
    title: "CoCalc CLI",
  },
  "project-hosts": {
    href: appPath("docs/hosts/project-hosts"),
    slug: "project-hosts",
    summary:
      "Use dedicated hosted compute for projects that need isolated or larger capacity.",
    title: "Dedicated Compute",
  },
  "more-languages": {
    href: featurePath("more-languages"),
    slug: "more-languages",
    summary:
      "Use C, C++, Fortran, Rust, Go, Java, Bash, SQL, JavaScript, TypeScript, and many other tools through terminals, scripts, and project software.",
    title: "More",
  },
} satisfies Record<
  string,
  { href: string; slug: string; summary: string; title: string }
>;

const FEATURE_PANEL_RADIUS = 8;

const FEATURE_PANEL_SHADOW = `0 14px 34px ${alpha(
  PUBLIC_COLORS.heading,
  0.07,
)}`;

const FEATURE_INDEX_CSS = `
  .cocalc-feature-index-hero {
    align-items: center;
    display: grid;
    gap: 42px;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 1fr);
    padding: 32px 0 12px;
  }

  .cocalc-feature-index-title {
    font-size: 58px !important;
    line-height: 1.02 !important;
  }

  .cocalc-feature-link-card,
  .cocalc-feature-list-link {
    cursor: pointer;
    transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
  }

  .cocalc-feature-link-card:hover,
  .cocalc-feature-list-link:hover {
    border-color: ${PUBLIC_COLORS.linkHover} !important;
    box-shadow: 0 18px 44px ${alpha(PUBLIC_COLORS.brandDark, 0.1)} !important;
    transform: translateY(-1px);
  }

  .cocalc-feature-link-card:focus-visible,
  .cocalc-feature-list-link:focus-visible {
    outline: 2px solid ${PUBLIC_COLORS.linkHover};
    outline-offset: 3px;
  }

  .cocalc-feature-link-list {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  }

  @media (max-width: 920px) {
    .cocalc-feature-index-hero {
      grid-template-columns: minmax(0, 1fr);
    }

    .cocalc-feature-index-title {
      font-size: 42px !important;
      line-height: 1.08 !important;
    }
  }

  @media (max-width: 560px) {
    .cocalc-feature-index-hero {
      gap: 28px;
      padding: 20px 0 4px;
    }

    .cocalc-feature-index-title {
      font-size: 34px !important;
    }

    .cocalc-feature-link-card {
      min-height: 0 !important;
      padding: 14px !important;
    }

    .cocalc-feature-list-link {
      min-height: 82px !important;
      padding: 12px !important;
    }

    .cocalc-feature-link-list {
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }
`;

function featureMeta(slug: string) {
  return (
    FEATURE_META[slug as keyof typeof FEATURE_META] ?? {
      accent: PUBLIC_COLORS.brand,
      icon: "star",
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

type FeatureIndexCard = {
  href: string;
  slug: string;
  summary: string;
  title: string;
};

function FeatureLinkCard({ card }: { card: FeatureIndexCard }) {
  const meta = featureMeta(card.slug);
  return (
    <a
      className="cocalc-feature-link-card"
      href={card.href}
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
        <Flex className="cocalc-feature-card-icon-row" align="center">
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
        </Flex>
        <div>
          <Title level={4} style={{ margin: "0 0 8px" }}>
            {card.title}
          </Title>
          <Paragraph style={{ margin: 0 }}>{card.summary}</Paragraph>
        </div>
      </Flex>
    </a>
  );
}

function FeatureListLink({ card }: { card: FeatureIndexCard }) {
  const meta = featureMeta(card.slug);
  return (
    <a
      className="cocalc-feature-list-link"
      href={card.href}
      style={{
        alignItems: "start",
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: FEATURE_PANEL_RADIUS,
        boxShadow: FEATURE_PANEL_SHADOW,
        color: "inherit",
        display: "grid",
        gap: 12,
        gridTemplateColumns: "40px minmax(0, 1fr)",
        minHeight: 96,
        padding: 14,
        textDecoration: "none",
      }}
    >
      <span
        style={{
          alignItems: "center",
          background: `${meta.accent}14`,
          border: `1px solid ${meta.accent}33`,
          borderRadius: FEATURE_PANEL_RADIUS,
          color: meta.accent,
          display: "flex",
          fontSize: 19,
          height: 40,
          justifyContent: "center",
          width: 40,
        }}
      >
        <Icon name={meta.icon} />
      </span>
      <span>
        <Text strong style={{ display: "block", marginBottom: 4 }}>
          {card.title}
        </Text>
        <Text type="secondary">{card.summary}</Text>
      </span>
    </a>
  );
}

function getFeatureIndexCard(
  slug: string,
  pages: FeaturePage[],
): FeatureIndexCard | undefined {
  const cardOverride =
    FEATURE_INDEX_CARD_OVERRIDES[
      slug as keyof typeof FEATURE_INDEX_CARD_OVERRIDES
    ];
  if (cardOverride != null) {
    return cardOverride;
  }
  const page = pages.find((candidate) => candidate.slug === slug);
  if (!page) return undefined;
  return {
    href: featurePath(page.slug),
    slug: page.slug,
    summary: page.summary,
    title: page.title,
  };
}

function FeatureGroupSection({
  group,
  pages,
}: {
  group: (typeof FEATURE_GROUPS)[number];
  pages: FeaturePage[];
}) {
  const groupCards = group.slugs
    .map((slug) => getFeatureIndexCard(slug, pages))
    .filter((card) => card != null);
  if (!groupCards.length) return null;
  const useList = group.variant === "list";

  return (
    <section>
      <Row gutter={[18, 18]}>
        <Col lg={6} xs={24}>
          <div
            className="cocalc-feature-group-label"
            style={{
              borderLeft: `3px solid ${group.accent}`,
              padding: "4px 4px 4px 18px",
            }}
          >
            <Flex vertical gap={12}>
              <div
                style={{
                  alignItems: "center",
                  background: `${group.accent}10`,
                  borderRadius: FEATURE_PANEL_RADIUS,
                  color: group.accent,
                  display: "flex",
                  fontSize: 22,
                  height: 44,
                  justifyContent: "center",
                  width: 44,
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
                {"links" in group && group.links?.length ? (
                  <Flex vertical gap={6} style={{ marginTop: 10 }}>
                    {group.links.map((link) => (
                      <a
                        href={link.href}
                        key={link.href}
                        style={{
                          color: PUBLIC_COLORS.link,
                          fontWeight: 600,
                          textDecoration: "none",
                        }}
                      >
                        {link.label}
                      </a>
                    ))}
                  </Flex>
                ) : null}
              </div>
            </Flex>
          </div>
        </Col>
        <Col lg={18} xs={24}>
          {useList ? (
            <div className="cocalc-feature-link-list">
              {groupCards.map((card) => (
                <FeatureListLink key={card.slug} card={card} />
              ))}
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              }}
            >
              {groupCards.map((card) => (
                <FeatureLinkCard key={card.slug} card={card} />
              ))}
            </div>
          )}
        </Col>
      </Row>
    </section>
  );
}

function TeachingWorkflowCallout() {
  const meta = featureMeta("teaching");
  return (
    <section aria-label="Teaching and course workflows">
      <Row align="middle" gutter={[18, 18]}>
        <Col lg={6} xs={24}>
          <div
            style={{
              borderLeft: `3px solid ${meta.accent}`,
              padding: "4px 4px 4px 18px",
            }}
          >
            <Flex vertical gap={12}>
              <div
                style={{
                  alignItems: "center",
                  background: `${meta.accent}10`,
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
              <div>
                <Title level={2} style={{ margin: "0 0 8px" }}>
                  Teaching
                </Title>
                <Paragraph
                  style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}
                >
                  A route for instructors and workshop teams who need the same
                  technical tools in a guided setting.
                </Paragraph>
              </div>
            </Flex>
          </div>
        </Col>
        <Col lg={18} xs={24}>
          <a
            className="cocalc-feature-link-card"
            href={featurePath("teaching")}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: FEATURE_PANEL_RADIUS,
              boxShadow: FEATURE_PANEL_SHADOW,
              color: "inherit",
              display: "block",
              padding: 18,
              textDecoration: "none",
            }}
          >
            <Flex align="start" gap={14}>
              <span
                style={{
                  alignItems: "center",
                  background: `${meta.accent}14`,
                  border: `1px solid ${meta.accent}33`,
                  borderRadius: FEATURE_PANEL_RADIUS,
                  color: meta.accent,
                  display: "flex",
                  flex: "0 0 auto",
                  fontSize: 22,
                  height: 44,
                  justifyContent: "center",
                  width: 44,
                }}
              >
                <Icon name={meta.icon} />
              </span>
              <span>
                <Title level={4} style={{ margin: "0 0 8px" }}>
                  Technical courses and labs
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Use CoCalc for assignments, shared environments, grading, and
                  live help when students or workshop participants learn with
                  the same technical tools they will keep using.
                </Paragraph>
              </span>
            </Flex>
          </a>
        </Col>
      </Row>
    </section>
  );
}

function FeaturesIndex() {
  const pages = getOrderedFeatureIndexPages();
  return (
    <>
      <style>{FEATURE_INDEX_CSS}</style>
      <section
        aria-label="CoCalc feature overview"
        className="cocalc-feature-index-hero"
      >
        <Flex vertical gap={20}>
          <Text
            strong
            style={{
              color: PUBLIC_COLORS.brand,
              fontSize: PUBLIC_TYPE.eyebrow,
              letterSpacing: 0,
              textTransform: "uppercase",
            }}
          >
            CoCalc workflows
          </Text>
          <div>
            <Title
              className="cocalc-feature-index-title"
              level={1}
              style={{
                letterSpacing: 0,
                margin: 0,
                maxWidth: 640,
              }}
            >
              Choose the workflow your team needs
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: PUBLIC_TYPE.lead,
                lineHeight: 1.5,
                margin: "20px 0 0",
                maxWidth: 600,
              }}
            >
              For research, engineering, and technical teams. Each page shows
              one workflow — AI-assisted work, notebooks, runtime environments,
              language stacks, or teaching — with a concrete example and a
              route-specific next step.
            </Paragraph>
          </div>
        </Flex>
      </section>

      {FEATURE_GROUPS.map((group) => (
        <Fragment key={group.title}>
          <FeatureGroupSection group={group} pages={pages} />
          {group.title === "Runtime" ? <TeachingWorkflowCallout /> : null}
        </Fragment>
      ))}
    </>
  );
}

function FeatureDetailNavigation({ page }: { page: FeaturePage }) {
  return (
    <section
      aria-label="Feature page navigation"
      style={{
        paddingBlock: 4,
      }}
    >
      <Flex align="center" gap={8} wrap>
        <Button type="link" href={featurePath()} style={{ paddingInline: 0 }}>
          Features
        </Button>
        <Text type="secondary">/</Text>
        <Text strong>{page.title}</Text>
      </Flex>
    </section>
  );
}

function FeatureProductPathLinks({ currentSlug }: { currentSlug: string }) {
  if (
    [
      "ai",
      "automations",
      "cli",
      "compare",
      "jupyter-notebook",
      "api",
      "julia",
      "latex-editor",
      "linux",
      "more-languages",
      "octave",
      "python",
      "r-statistical-software",
      "sage",
      "slides",
      "teaching",
      "terminal",
      "whiteboard",
    ].includes(currentSlug)
  ) {
    return null;
  }

  return (
    <PublicSection ariaLabel="Feature operating model next steps">
      <div
        className="cocalc-feature-product-paths"
        style={{
          background: PUBLIC_COLORS.surface,
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: 8,
          padding: 24,
        }}
      >
        <Row align="middle" gutter={[20, 20]}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={8}>
              <Title level={3} style={{ margin: 0 }}>
                Decide how CoCalc should run
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Once the workflow fit is clear, compare hosted CoCalc.ai, local
                CoCalc Plus, single-VM CoCalc Star, and customer-operated
                Launchpad or Rocket deployments.
              </Paragraph>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <Flex vertical gap={8} align="start">
              <Flex gap={12} wrap>
                <Button href={appPath("products")} type="primary">
                  Compare operating models
                </Button>
                <Button href={appPath("pricing")}>Pricing and licensing</Button>
              </Flex>
              <Flex gap={16} wrap>
                <LinkButton href={featurePath("compare")}>
                  Compare CoCalc fit
                </LinkButton>
                <LinkButton href={featurePath()}>
                  Browse feature workflows
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
        </Row>
      </div>
    </PublicSection>
  );
}

function FeatureDetailContent({
  config,
  helpEmail,
  isAuthenticated,
  page,
  slug,
}: {
  config?: FeaturesConfig;
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
  if (slug === "automations") {
    return (
      <AutomationsFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "cli") {
    return (
      <CliFeaturePage helpEmail={helpEmail} isAuthenticated={isAuthenticated} />
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
  if (slug === "more-languages") {
    return (
      <MoreLanguagesFeaturePage
        helpEmail={helpEmail}
        isAuthenticated={isAuthenticated}
      />
    );
  }
  if (slug === "compare") {
    return <CompareFeaturePage config={config} helpEmail={helpEmail} />;
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
        <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
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
  config,
  helpEmail,
  isAuthenticated,
  slug,
}: {
  config?: FeaturesConfig;
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
        config={config}
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
      hideTitleVisually={initialRoute.view === "detail"}
      title={
        initialRoute.view === "index"
          ? undefined
          : (feature?.title ?? "Features")
      }
    >
      {initialRoute.view === "detail" && initialRoute.slug ? (
        <FeatureDetail
          config={marketingConfig}
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
