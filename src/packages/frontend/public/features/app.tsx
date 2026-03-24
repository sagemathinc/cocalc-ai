/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Col, Empty, Flex, Row, Tag, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PublicHero,
  PublicPageRoot,
  PublicSectionCard,
} from "@cocalc/frontend/public/ui/shell";
import { SITE_NAME } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import { getFeatureIndexPages, getFeaturePage } from "./catalog";
import JupyterNotebookFeaturePage from "./jupyter-notebook-page";
import type { PublicFeaturesRoute } from "./routes";
import { featurePath } from "./routes";

const { Paragraph, Text, Title } = Typography;

interface FeaturesConfig {
  help_email?: string;
  site_name?: string;
}

interface PublicFeaturesAppProps {
  config?: FeaturesConfig;
  initialRoute: PublicFeaturesRoute;
}

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function titleForRoute(route: PublicFeaturesRoute, siteName: string): string {
  if (route.view === "detail" && route.slug) {
    return `${getFeaturePage(route.slug)?.title ?? "Features"} – ${siteName}`;
  }
  return `${siteName} features`;
}

function FeatureImage({ alt, src }: { alt: string; src?: string }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      style={{
        width: "100%",
        aspectRatio: "16 / 9",
        objectFit: "cover",
        borderRadius: 12,
      }}
    />
  );
}

function FeaturesIndex({ siteName }: { siteName: string }) {
  const pages = getFeatureIndexPages();
  return (
    <>
      <Paragraph style={{ margin: "24px 0 0", maxWidth: "70ch" }}>
        These pages are the standalone, Next-free public feature overviews for{" "}
        {siteName}. The content stays lightweight for now, but the UI is back on
        the AntD design system instead of ad hoc styling.
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

  if (slug === "jupyter-notebook") {
    return <JupyterNotebookFeaturePage helpEmail={helpEmail} />;
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
            : "Standalone feature landing pages served without Next.js."
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
