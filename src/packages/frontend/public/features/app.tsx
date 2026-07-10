/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Fragment, useEffect } from "react";

import { Button, Col, Empty, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import type { PublicPolicyPages } from "@cocalc/frontend/public/config";
import {
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { COLORS, SITE_NAME } from "@cocalc/util/theme";
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
import { FeatureImage, featureAppPath as appPath } from "./page-components";
import RStatisticalSoftwareFeaturePage from "./r-statistical-software-page";
import type { PublicFeaturesRoute } from "./routes";
import { featurePath } from "./routes";
import SageFeaturePage from "./sage-page";
import PythonFeaturePage from "./python-page";
import { FEATURE_ACCENTS } from "./feature-accents";
import SlidesFeaturePage from "./slides-page";
import TeachingFeaturePage from "./teaching-page";
import TerminalFeaturePage from "./terminal-page";
import WhiteboardFeaturePage from "./whiteboard-page";

const { Paragraph, Text, Title } = Typography;

interface FeaturesConfig {
  help_email?: string;
  is_authenticated?: boolean;
  logo_square?: string;
  policy_pages?: PublicPolicyPages;
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
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    description:
      "Find shell and Linux environments for work that needs a real runtime.",
    icon: "terminal",
    slugs: ["terminal", "linux"],
    title: "Runtime",
    variant: "cards",
  },
  {
    accent: COLORS.BLUE_D,
    description:
      "Create notebooks, papers, boards, slide decks, and project notes.",
    icon: "jupyter",
    slugs: ["jupyter-notebook", "latex-editor", "whiteboard", "slides"],
    title: "Documents",
    variant: "cards",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    description:
      "Use Codex inside CoCalc projects or drive CoCalc from scripts and pipelines with the API.",
    icon: "robot",
    slugs: ["ai", "api", "compare"],
    title: "AI workflows",
    variant: "cards",
  },
  {
    accent: COLORS.RUN,
    description:
      "Use the language your work needs for analysis, modeling, and reproducible research.",
    icon: "python",
    slugs: ["python", "r-statistical-software", "julia", "sage", "octave"],
    title: "Languages",
    variant: "list",
  },
] as const;

const FEATURE_META = {
  ai: { accent: FEATURE_ACCENTS.ai, icon: "robot" },
  api: { accent: COLORS.ANTD_LINK_BLUE_DARK, icon: "api" },
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
  octave: { accent: COLORS.FG_RED, icon: "octave" },
  python: { accent: COLORS.BLUE_D, icon: "python" },
  "r-statistical-software": {
    accent: COLORS.BLUE_DD,
    icon: "r",
  },
  sage: { accent: COLORS.RUN, icon: "sagemath" },
  slides: { accent: COLORS.BG_WARNING, icon: "slides" },
  teaching: { accent: FEATURE_ACCENTS.teaching, icon: "graduation-cap" },
  terminal: {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    icon: "terminal",
  },
  whiteboard: { accent: COLORS.FG_RED, icon: "layout" },
} satisfies Record<string, { accent: string; icon: IconName }>;

const FEATURE_PANEL_SHADOW = `0 14px 34px ${alpha(
  PUBLIC_COLORS.heading,
  0.07,
)}`;

const FEATURE_INDEX_CSS = `
  .cocalc-feature-index-hero {
    padding: 32px 0 12px;
  }

  .cocalc-feature-index-title {
    font-size: 58px !important;
    line-height: 1.02 !important;
    max-width: 900px;
    text-wrap: balance;
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

  .cocalc-feature-teaching-callout {
    padding-bottom: 28px;
  }

  @media (max-width: 920px) {
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

    .cocalc-feature-teaching-callout {
      padding-bottom: 20px;
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

function titleForRoute(route: PublicFeaturesRoute, siteName: string): string {
  if (route.view === "detail" && route.slug) {
    return `${getFeaturePage(route.slug)?.title ?? "Features"} – ${siteName}`;
  }
  return `${siteName} Features`;
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
        borderRadius: PUBLIC_RADIUS.panel,
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
        <Flex align="center" className="cocalc-feature-card-icon-row">
          <div
            className={`cocalc-feature-card-icon cocalc-feature-card-icon-${card.slug}`}
            style={{
              alignItems: "center",
              background: `${meta.accent}14`,
              border: `1px solid ${meta.accent}33`,
              borderRadius: PUBLIC_RADIUS.panel,
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
          <Title
            className="cocalc-feature-link-card-title"
            level={3}
            style={{
              fontSize: PUBLIC_TYPE.subhead,
              lineHeight: 1.22,
              margin: "0 0 8px",
            }}
          >
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
        borderRadius: PUBLIC_RADIUS.panel,
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
        className={`cocalc-feature-list-icon cocalc-feature-list-icon-${card.slug}`}
        style={{
          alignItems: "center",
          alignSelf: "center",
          background: `${meta.accent}14`,
          border: `1px solid ${meta.accent}33`,
          borderRadius: PUBLIC_RADIUS.panel,
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
        <Title
          level={3}
          style={{
            fontSize: PUBLIC_TYPE.body,
            lineHeight: 1.3,
            margin: "0 0 4px",
          }}
        >
          {card.title}
        </Title>
        <Text
          className="cocalc-feature-list-summary"
          style={{ color: PUBLIC_COLORS.text }}
        >
          {card.summary}
        </Text>
      </span>
    </a>
  );
}

function getFeatureIndexCard(
  slug: string,
  pages: FeaturePage[],
): FeatureIndexCard | undefined {
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
      <Row
        align="middle"
        className="cocalc-feature-group-row"
        gutter={[18, 18]}
      >
        <Col
          className="cocalc-feature-group-label-column"
          lg={5}
          style={{ alignItems: "center", display: "flex" }}
          xs={24}
        >
          <div
            className="cocalc-feature-group-label"
            style={{
              borderLeft: `3px solid ${group.accent}`,
              padding: "4px 4px 4px 18px",
              width: "100%",
            }}
          >
            <Flex vertical gap={12}>
              <div
                style={{
                  alignItems: "center",
                  background: `${group.accent}10`,
                  borderRadius: PUBLIC_RADIUS.panel,
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
              </div>
            </Flex>
          </div>
        </Col>
        <Col lg={19} xs={24}>
          {useList ? (
            <div className="cocalc-feature-link-list">
              {groupCards.map((card) => (
                <FeatureListLink key={card.slug} card={card} />
              ))}
            </div>
          ) : (
            <div
              className="cocalc-feature-card-grid"
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
  const teachingPage = getFeaturePage("teaching");
  return (
    <section
      aria-label="Teaching and course workflows"
      className="cocalc-feature-teaching-callout"
    >
      <Row align="middle" gutter={[18, 18]}>
        <Col className="cocalc-feature-teaching-label-column" lg={5} xs={24}>
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
                  borderRadius: PUBLIC_RADIUS.panel,
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
                  Run courses with shared projects for assignments, grading,
                  live help, and reproducible technical work.
                </Paragraph>
              </div>
            </Flex>
          </div>
        </Col>
        <Col className="cocalc-feature-teaching-card-column" lg={19} xs={24}>
          <a
            className="cocalc-feature-link-card"
            href={featurePath("teaching")}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PUBLIC_RADIUS.panel,
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
                  borderRadius: PUBLIC_RADIUS.panel,
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
                <Title level={3} style={{ margin: "0 0 8px" }}>
                  {teachingPage?.title ?? "Teaching"}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {teachingPage?.summary ??
                    "Use CoCalc for assignments, shared environments, grading, and live help while students learn with the tools they will keep using."}
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
              color: PUBLIC_COLORS.heading,
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
              }}
            >
              Collaborate using your favorite software and AI agents.
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
              Keep your notebooks, code, and history all together in one
              project.
            </Paragraph>
          </div>
        </Flex>
      </section>

      {FEATURE_GROUPS.map((group) => (
        <Fragment key={group.title}>
          <FeatureGroupSection group={group} pages={pages} />
          {group.title === "Languages" ? <TeachingWorkflowCallout /> : null}
        </Fragment>
      ))}
    </>
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

  if (slug === "compare") {
    return <CompareFeaturePage config={config} />;
  }

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

export default function PublicFeaturesApp({
  config,
  initialRoute,
}: PublicFeaturesAppProps) {
  const siteName = config?.site_name ?? SITE_NAME;
  const title = titleForRoute(initialRoute, siteName);

  useEffect(() => {
    document.title = title;
  }, [title]);

  const feature = initialRoute.slug
    ? getFeaturePage(initialRoute.slug)
    : undefined;

  return (
    <PublicPage
      active="features"
      config={config}
      title={
        initialRoute.view === "index"
          ? undefined
          : (feature?.title ?? "Features")
      }
    >
      {initialRoute.view === "detail" && initialRoute.slug ? (
        <FeatureDetail
          config={config}
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
