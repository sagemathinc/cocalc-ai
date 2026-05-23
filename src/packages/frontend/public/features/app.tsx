/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Col, Empty, Flex, Row, Tag, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import {
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { SITE_NAME } from "@cocalc/util/theme";
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
import SlidesFeaturePage from "./slides-page";
import TeachingFeaturePage from "./teaching-page";
import TerminalFeaturePage from "./terminal-page";
import WhiteboardFeaturePage from "./whiteboard-page";
import X11FeaturePage from "./x11-page";

const { Paragraph, Text, Title } = Typography;

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
    accent: "#2f6fda",
    description:
      "Notebooks, papers, whiteboards, slides, and technical writing in one collaborative project.",
    icon: "jupyter",
    slugs: ["jupyter-notebook", "latex-editor", "whiteboard", "slides"],
    title: "Documents",
  },
  {
    accent: "#096dd9",
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
      "x11",
    ],
    title: "Compute",
  },
  {
    accent: "#7c3aed",
    description:
      "Codex and AI assistance where files, notebooks, terminals, and chat already live.",
    icon: "robot",
    slugs: ["ai", "compare", "api"],
    title: "AI and automation",
  },
  {
    accent: "#389e0d",
    description:
      "Course workflows, grading, shared environments, and collaborative help for technical classes.",
    icon: "graduation-cap",
    slugs: ["teaching"],
    title: "Teaching",
  },
] as const;

const FEATURE_META = {
  ai: { accent: "#7c3aed", icon: "robot", label: "Agents" },
  api: { accent: "#096dd9", icon: "api", label: "API" },
  compare: { accent: "#2f6fda", icon: "swap", label: "Positioning" },
  "jupyter-notebook": {
    accent: "#2f6fda",
    icon: "jupyter",
    label: "Notebook",
  },
  julia: { accent: "#9558b2", icon: "julia", label: "Language" },
  "latex-editor": { accent: "#ad6800", icon: "tex", label: "Writing" },
  linux: { accent: "#096dd9", icon: "linux", label: "Environment" },
  octave: { accent: "#d4380d", icon: "octave", label: "Language" },
  python: { accent: "#2f6fda", icon: "python", label: "Language" },
  "r-statistical-software": { accent: "#386cb0", icon: "r", label: "Stats" },
  sage: { accent: "#389e0d", icon: "sagemath", label: "Math" },
  slides: { accent: "#d46b08", icon: "slides", label: "Present" },
  teaching: { accent: "#389e0d", icon: "graduation-cap", label: "Courses" },
  terminal: { accent: "#096dd9", icon: "terminal", label: "Shell" },
  whiteboard: { accent: "#d4380d", icon: "layout", label: "Canvas" },
  x11: { accent: "#455a64", icon: "desktop", label: "Desktop" },
} satisfies Record<string, { accent: string; icon: IconName; label: string }>;

function featureMeta(slug: string) {
  return (
    FEATURE_META[slug as keyof typeof FEATURE_META] ?? {
      accent: PUBLIC_COLORS.brand,
      icon: "star",
      label: "Feature",
    }
  );
}

function titleForRoute(route: PublicFeaturesRoute, siteName: string): string {
  if (route.view === "detail" && route.slug) {
    return `${getFeaturePage(route.slug)?.title ?? "Features"} – ${siteName}`;
  }
  return `${siteName} Features`;
}

function FeatureLinkCard({ page }: { page: FeaturePage }) {
  const meta = featureMeta(page.slug);
  return (
    <a
      href={featurePath(page.slug)}
      style={{
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 22,
        boxShadow: "0 14px 38px rgba(33, 49, 57, 0.07)",
        color: "inherit",
        display: "block",
        height: "100%",
        minHeight: 188,
        padding: 20,
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
              borderRadius: 16,
              color: meta.accent,
              display: "flex",
              fontSize: 24,
              height: 50,
              justifyContent: "center",
              width: 50,
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
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 24,
        boxShadow: "0 16px 44px rgba(33, 49, 57, 0.07)",
        padding: 24,
      }}
    >
      <Flex gap={14}>
        <div
          style={{
            alignItems: "center",
            background: "#eef5ff",
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: 16,
            color: PUBLIC_COLORS.brand,
            display: "flex",
            flex: "0 0 auto",
            fontSize: 24,
            height: 52,
            justifyContent: "center",
            width: 52,
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
              background:
                "linear-gradient(145deg, #ffffff 0%, #f7fbff 58%, #fff8e8 100%)",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 28,
              boxShadow: "0 16px 44px rgba(33, 49, 57, 0.07)",
              padding: 24,
            }}
          >
            <Flex vertical gap={16}>
              <div
                style={{
                  alignItems: "center",
                  background: `${group.accent}14`,
                  border: `1px solid ${group.accent}33`,
                  borderRadius: 18,
                  color: group.accent,
                  display: "flex",
                  fontSize: 28,
                  height: 58,
                  justifyContent: "center",
                  width: 58,
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

      <section>
        <Row gutter={[18, 18]}>
          <Col lg={8} xs={24}>
            <div
              style={{
                background:
                  "linear-gradient(145deg, #f4f9ff 0%, #ffffff 58%, #fff8e8 100%)",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 28,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                height: "100%",
                padding: 26,
              }}
            >
              <Flex vertical gap={18}>
                <Flex align="center" gap={14}>
                  <div
                    style={{
                      alignItems: "center",
                      background: "#e9f2ff",
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: 18,
                      color: PUBLIC_COLORS.brand,
                      display: "flex",
                      fontSize: 28,
                      height: 60,
                      justifyContent: "center",
                      width: 60,
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
                  backups, and collaborators stay together.
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
              click away.
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
                  background: "#fff",
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 18,
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
                    borderRadius: 12,
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

  const CustomPage =
    FEATURE_DETAIL_COMPONENTS[slug as keyof typeof FEATURE_DETAIL_COMPONENTS];
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
          isAuthenticated={!!config?.is_authenticated}
          slug={initialRoute.slug}
        />
      ) : (
        <FeaturesIndex siteName={siteName} />
      )}
    </PublicPage>
  );
}
