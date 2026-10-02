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
import { PUBLIC_SIGN_UP_LABEL } from "@cocalc/util/public-site-policy";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  LinkButton,
} from "./page-components";
import { ZoomableImage } from "./feature-info";
import { ContextList, FeatureFinalBand, StoryCard } from "./feature-visuals";

const { Paragraph, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
// The hero, highlights, sign-up label and cards come from the feature record,
// which the crawler fallback also renders (hub/servers/app/public-prerender.ts).
// The record's image is also the page's link preview.
const PAGE = getPublicFeaturePage("terminal")!;
const HIGHLIGHT_ICONS: IconName[] = ["robot", "file", "terminal", "users"];
const SECTION_STYLES: { accent: string; icon: IconName }[] = [
  { accent: UI_COLORS.link, icon: "terminal" },
  { accent: UI_COLORS.success, icon: "users" },
  { accent: UI_COLORS.keyword, icon: "robot" },
  { accent: UI_COLORS.warning, icon: "history" },
];

export default function TerminalFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  // The record's sign-up label names CoCalc.ai, so it shows on cocalc.ai only.
  const onCocalcAi = isCocalcAiLaunchpadSite(usePublicConfig());
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : featureSignUpPath("code");
  const primaryCtaLabel = isAuthenticated
    ? "Open projects"
    : (onCocalcAi && PAGE.signUpLabel) || PUBLIC_SIGN_UP_LABEL;

  return (
    <Flex vertical gap={36}>
      <PublicSection>
        <Row align="top" gutter={[44, 32]} style={{ padding: "22px 0 14px" }}>
          <Col xs={24} lg={14}>
            <Flex className="cocalc-terminal-hero" vertical gap={20}>
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
              alt="A CoCalc project terminal with the Agent button in its title bar, running a saved analysis script"
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
                Open a project, create a <code>.term</code> file, and start the
                shell in the folder for the document or notebook.
              </>
            ),
            href: primaryCtaHref,
            label: primaryCtaLabel,
            title: "Ready to use terminals in CoCalc?",
          }}
          relatedLinks={[
            { href: `${GUIDE_BASE}/terminal/`, label: "Terminal field guide" },
            { href: appPath("features/linux"), label: "Linux environment" },
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            {
              href: `${GUIDE_BASE}/software-install/`,
              label: "Software install guide",
            },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="Where the terminal earns its place"
        >
          <BulletList
            items={[
              "Use a real shell with notebooks, source files, Git, and generated output.",
              "Reach heavier compute from the same project when exploration, post-processing, and review need to stay together.",
              "Best fit when shell commands should remain visible to collaborators instead of disappearing into a private local terminal.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
