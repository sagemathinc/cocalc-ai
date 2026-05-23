/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Col, Empty, Flex, Row, Tag, Typography } from "antd";

import {
  PublicCard,
  PublicGrid,
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { SITE_NAME } from "@cocalc/util/theme";
import AIFeaturePage from "./ai-page";
import ApiFeaturePage from "./api-page";
import { getFeatureIndexPages, getFeaturePage } from "./catalog";
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
import SlidesFeaturePage from "./slides-page";
import TeachingFeaturePage from "./teaching-page";
import TerminalFeaturePage from "./terminal-page";
import WhiteboardFeaturePage from "./whiteboard-page";
import X11FeaturePage from "./x11-page";

const { Paragraph, Title } = Typography;

interface FeaturesConfig {
  help_email?: string;
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
  x11: X11FeaturePage,
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
    description:
      "Notebooks, papers, whiteboards, slides, and technical writing in one collaborative project.",
    slugs: ["jupyter-notebook", "latex-editor", "whiteboard", "slides"],
    title: "Documents",
  },
  {
    description:
      "A real Linux environment with terminals, language stacks, graphical apps, and installable software.",
    slugs: [
      "terminal",
      "linux",
      "python",
      "r-statistical-software",
      "julia",
      "sage",
      "octave",
      "x11",
    ],
    title: "Compute",
  },
  {
    description:
      "Codex and AI assistance where files, notebooks, terminals, and chat already live.",
    slugs: ["ai", "compare", "api"],
    title: "AI and automation",
  },
  {
    description:
      "Course workflows, grading, shared environments, and collaborative help for technical classes.",
    slugs: ["teaching"],
    title: "Teaching",
  },
] as const;

function titleForRoute(route: PublicFeaturesRoute, siteName: string): string {
  if (route.view === "detail" && route.slug) {
    return `${getFeaturePage(route.slug)?.title ?? "Features"} – ${siteName}`;
  }
  return `${siteName} Features`;
}

function FeaturesIndex({ siteName }: { siteName: string }) {
  const priorities = new Map<string, number>(
    FEATURE_INDEX_PRIORITY.map((slug, index) => [slug, index]),
  );
  const pages = getFeatureIndexPages()
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
                Everything starts in a project.
              </Title>
              <Paragraph
                style={{
                  color: PUBLIC_COLORS.mutedText,
                  fontSize: 21,
                  margin: 0,
                }}
              >
                {siteName} features make the most sense when viewed together:
                documents, compute, AI agents, teaching, and platform operations
                all share the same files, collaborators, history, and project
                environment.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button href={featurePath("jupyter-notebook")} type="primary">
                  Jupyter
                </Button>
                <Button href={featurePath("ai")}>AI agents</Button>
                <Button href={featurePath("terminal")}>Terminal</Button>
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

      <PublicGrid columns={2}>
        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            Durable collaborative projects
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc projects keep files, notebooks, terminals, chat, agents,
            snapshots, backups, and history together instead of splitting work
            across unrelated tools.
          </Paragraph>
        </PublicSection>
        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            Agent-aware by design
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Codex can work in the same project context as humans: reading files,
            using terminals, interacting with notebooks, writing documents, and
            participating in durable chat threads.
          </Paragraph>
        </PublicSection>
      </PublicGrid>

      {FEATURE_GROUPS.map((group) => (
        <section key={group.title}>
          <Flex vertical gap={8}>
            <Title level={2} style={{ margin: 0 }}>
              {group.title}
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                margin: 0,
                maxWidth: "68ch",
              }}
            >
              {group.description}
            </Paragraph>
          </Flex>
          <PublicGrid columns={3}>
            {group.slugs
              .map((slug) => pages.find((page) => page.slug === slug))
              .filter(Boolean)
              .map((page) =>
                page ? (
                  <PublicCard
                    href={featurePath(page.slug)}
                    key={page.slug}
                    title={page.title}
                  >
                    <Paragraph style={{ margin: 0 }}>{page.summary}</Paragraph>
                  </PublicCard>
                ) : null,
              )}
          </PublicGrid>
        </section>
      ))}

      <section>
        <Title level={2} style={{ margin: 0 }}>
          Full feature index
        </Title>
        <PublicGrid columns={3}>
          {pages.map((page) => (
            <PublicCard
              href={featurePath(page.slug)}
              key={page.slug}
              title={page.title}
            >
              <Paragraph style={{ margin: 0 }}>{page.summary}</Paragraph>
            </PublicCard>
          ))}
        </PublicGrid>
      </section>
    </>
  );
}

function FeatureDetail({
  helpEmail,
  slug,
}: {
  helpEmail?: string;
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

  const CustomPage =
    FEATURE_DETAIL_COMPONENTS[slug as keyof typeof FEATURE_DETAIL_COMPONENTS];
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
          helpEmail={config?.help_email}
          slug={initialRoute.slug}
        />
      ) : (
        <FeaturesIndex siteName={siteName} />
      )}
    </PublicPage>
  );
}
