/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  isCocalcAiLaunchpadSite,
  usePublicConfig,
} from "@cocalc/frontend/public/config";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  getPublicFeaturePage,
  publicFeatureHref,
} from "@cocalc/util/public-feature-pages";
import { getPublicFeatureSignUpLabel } from "@cocalc/util/public-site-policy";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  LinkButton,
} from "./page-components";
import { ZoomableImage } from "./feature-info";
import { ContextList, FeatureFinalBand, StoryCard } from "./feature-visuals";

const { Paragraph, Title } = Typography;

// The hero, highlights, sign-up label and cards come from the feature record,
// which the crawler fallback also renders (hub/servers/app/public-prerender.ts).
// The record's image is also the page's link preview.
const PAGE = getPublicFeaturePage("web-browser")!;
const HIGHLIGHT_ICONS: IconName[] = ["global", "eye", "lock", "download"];
const SECTION_STYLES: { accent: string; icon: IconName }[] = [
  { accent: UI_COLORS.link, icon: "users" },
  { accent: UI_COLORS.success, icon: "global" },
  { accent: UI_COLORS.keyword, icon: "robot" },
  { accent: UI_COLORS.warning, icon: "lock" },
];

export default function WebBrowserFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const onCocalcAi = isCocalcAiLaunchpadSite(usePublicConfig());
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : featureSignUpPath("code");
  const primaryCtaLabel = isAuthenticated
    ? "Open projects"
    : getPublicFeatureSignUpLabel(PAGE, onCocalcAi);

  return (
    <Flex vertical gap={36}>
      <PublicSection>
        <Row align="top" gutter={[44, 32]} style={{ padding: "22px 0 14px" }}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={20}>
              <Title level={2} style={{ margin: 0, maxWidth: 760 }}>
                {PAGE.tagline}
              </Title>
              <Paragraph
                style={{ fontSize: PUBLIC_TYPE.lead, margin: 0, maxWidth: 720 }}
              >
                {PAGE.summary}
              </Paragraph>
              <div>
                <Button href={primaryCtaHref} type="primary">
                  {primaryCtaLabel}
                </Button>
              </div>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ContextList
              accent={UI_COLORS.link}
              items={(PAGE.highlights ?? []).map((label, index) => ({
                icon: HIGHLIGHT_ICONS[index % HIGHLIGHT_ICONS.length],
                label,
              }))}
              title="Highlights"
            />
          </Col>
        </Row>
      </PublicSection>

      {PAGE.image ? (
        <PublicSection>
          <div style={{ margin: "0 auto", maxWidth: 800 }}>
            <ZoomableImage
              alt="A CoCalc web browser while an agent drives it, showing an arXiv listing, a second tab, and the Take over button"
              priority
              src={publicFeatureHref(PAGE.image, appBasePath)}
            />
          </div>
        </PublicSection>
      ) : null}

      <Row gutter={[16, 16]}>
        {(PAGE.sections ?? []).map((section, index) => (
          <Col key={section.title} xs={24} md={12}>
            <StoryCard
              {...SECTION_STYLES[index % SECTION_STYLES.length]}
              title={section.title}
            >
              {(section.paragraphs ?? []).map((paragraph, i) => (
                <span
                  key={paragraph}
                  style={{ display: "block", marginTop: i > 0 ? 8 : 0 }}
                >
                  {paragraph}
                </span>
              ))}
              {(section.links ?? []).map(({ href, label }) => (
                <span key={href} style={{ display: "block", marginTop: 8 }}>
                  <LinkButton href={publicFeatureHref(href, appBasePath)}>
                    {label}
                  </LinkButton>
                </span>
              ))}
            </StoryCard>
          </Col>
        ))}
      </Row>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: (
              <>
                Open a project, create a <code>.browser</code> file, and click{" "}
                <strong>Agent</strong> to give an agent a task in it.
              </>
            ),
            href: primaryCtaHref,
            label: primaryCtaLabel,
            title: "Ready to browse with your agents?",
          }}
          relatedLinks={[
            {
              href: publicFeatureHref(
                "/docs/projects/web-browser",
                appBasePath,
              ),
              label: "Web browser documentation",
            },
            { href: appPath("features/ai"), label: "AI agents" },
            { href: appPath("features/terminal"), label: "Linux terminal" },
            { href: appPath("features/x11"), label: "Linux graphical apps" },
          ]}
          title="Where the browser earns its place"
        >
          <BulletList
            items={[
              "Let an agent do the tedious parts of the web while the sign-ins, codes, and judgment calls stay with you.",
              "Test your own web app end to end, from the same project that runs it.",
              "Keep what it finds: pages it reads, screenshots, and downloads end up in the project with the rest of the work.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
