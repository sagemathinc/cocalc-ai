/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Col, Empty, Flex, Row, Tag, Typography } from "antd";

import {
  PublicHero,
  PublicPageRoot,
  PublicSectionCard,
} from "@cocalc/frontend/public/ui/shell";
import PublicTopNav from "@cocalc/frontend/public/ui/top-nav";
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

const { Paragraph, Text, Title } = Typography;

interface FeaturesConfig {
  help_email?: string;
  is_authenticated?: boolean;
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

function titleForRoute(route: PublicFeaturesRoute, siteName: string): string {
  if (route.view === "detail" && route.slug) {
    return `${getFeaturePage(route.slug)?.title ?? "Features"} – ${siteName}`;
  }
  return `${siteName} features`;
}

function FeaturesIndex({ siteName }: { siteName: string }) {
  const pages = getFeatureIndexPages();
  return (
    <>
      <Paragraph style={{ margin: "24px 0 0", maxWidth: "70ch" }}>
        Explore the core capabilities of {siteName}, from collaborative
        notebooks and terminals to AI-assisted workflows, teaching tools, and
        technical writing. Each page highlights how these workflows connect to
        the same projects, files, and collaboration features inside the main
        app.
      </Paragraph>
      <Row gutter={[16, 16]} style={{ marginTop: 8 }}>
        {pages.map((page) => (
          <Col key={page.slug} xs={24} md={12} xl={8}>
            <PublicSectionCard>
              <FeatureImage alt={page.title} src={page.image} />
              <Text strong type="secondary">
                FEATURE
              </Text>
              <Title level={3} style={{ margin: 0 }}>
                {page.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>{page.summary}</Paragraph>
              <div>
                <Button
                  type="link"
                  href={featurePath(page.slug)}
                  style={{ paddingInline: 0 }}
                >
                  Open page
                </Button>
              </div>
            </PublicSectionCard>
          </Col>
        ))}
      </Row>
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
      <PublicSectionCard>
        <Empty description="Feature page not found" />
        <div>
          <Button type="link" href={featurePath()} style={{ paddingInline: 0 }}>
            Back to features
          </Button>
        </div>
      </PublicSectionCard>
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
      <PublicSectionCard>
        <FeatureImage alt={page.title} src={page.image} />
        <Text strong type="secondary">
          FEATURE
        </Text>
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
      </PublicSectionCard>
      {(page.sections ?? []).map((section) => (
        <PublicSectionCard key={section.title}>
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
        </PublicSectionCard>
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

  return (
    <PublicPageRoot>
      <PublicTopNav
        active="features"
        isAuthenticated={!!config?.is_authenticated}
        siteName={siteName}
      />
      <PublicHero
        eyebrow="FEATURES"
        title={
          initialRoute.view === "detail" && initialRoute.slug
            ? (getFeaturePage(initialRoute.slug)?.title ?? "Features")
            : `${siteName} features`
        }
        subtitle={
          initialRoute.view === "detail" && initialRoute.slug
            ? getFeaturePage(initialRoute.slug)?.tagline
            : "Standalone feature landing pages for the main CoCalc workflows."
        }
        actions={
          initialRoute.view === "detail" ? (
            <Flex wrap gap={8}>
              <Tag color="blue">AntD public UI</Tag>
              <Tag>Next-free routing</Tag>
            </Flex>
          ) : null
        }
      />
      <div style={{ marginTop: 24 }}>
        {initialRoute.view === "detail" && initialRoute.slug ? (
          <FeatureDetail
            helpEmail={config?.help_email}
            slug={initialRoute.slug}
          />
        ) : (
          <FeaturesIndex siteName={siteName} />
        )}
      </div>
    </PublicPageRoot>
  );
}
