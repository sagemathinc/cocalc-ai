/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_ELEVATION,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  type PublicFeaturePage,
  publicFeatureHref,
} from "@cocalc/util/public-feature-pages";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Title } = Typography;

const COMPUTE_ACCENT = UI_COLORS.success;
const COMPUTE_PAGE_CSS = `
.feature-compute-hero {
  background:
    radial-gradient(circle at 88% 12%, ${alpha(COMPUTE_ACCENT, 0.13)}, transparent 34%),
    linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.brandTint} 100%);
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  overflow: hidden;
  padding: clamp(24px, 4vw, 48px);
}

.feature-compute-hero-title.ant-typography {
  font-size: clamp(38px, 5vw, 58px);
  letter-spacing: -0.045em;
  line-height: 1.03;
  margin: 0;
  max-width: 17ch;
}

.feature-compute-route-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.feature-compute-route-card {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  border-top: 3px solid ${alpha(COMPUTE_ACCENT, 0.75)};
  box-shadow: ${PUBLIC_ELEVATION.card};
  height: 100%;
  padding: 22px;
}

.feature-compute-details summary {
  color: ${PUBLIC_COLORS.link};
  cursor: pointer;
  font-weight: 600;
}

.feature-compute-details[open] summary {
  margin-bottom: 12px;
}

@media (max-width: 900px) {
  .feature-compute-route-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .feature-compute-hero {
    padding: 22px 18px;
  }

  .feature-compute-hero-title.ant-typography {
    font-size: clamp(34px, 12vw, 48px);
    max-width: 10.5ch;
  }

  .feature-compute-hero .ant-btn {
    width: 100%;
  }
}
`;

export default function ResearchComputeFeaturePage({
  helpEmail,
  isAuthenticated,
  page,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
  // The feature record for this site (getPublicFeaturePage with the site's
  // config), which the crawler fallback also renders
  // (hub/servers/app/public-prerender.ts). The hero, the two options, and the
  // sizing section with its collapsed technical details come from it. Its two
  // sections are, in order, the options, with the cost line on cocalc.ai, and
  // the sizing section, whose link is also the hero's documentation button.
  page: PublicFeaturePage;
}) {
  const [options, sizing] = page.sections!;
  const docsLink = sizing.links![0];
  const primaryCta = (
    <Button
      href={isAuthenticated ? appPath("hosts") : featureSignUpPath("code")}
      size="large"
      type="primary"
    >
      {isAuthenticated
        ? "Open project hosts"
        : (page.signUpLabel ?? "Start using CoCalc")}
    </Button>
  );

  return (
    <Flex vertical gap={56}>
      <style>{COMPUTE_PAGE_CSS}</style>

      <section
        aria-labelledby="feature-compute-hero-title"
        className="feature-compute-hero"
      >
        <Flex vertical gap={22}>
          <Title
            className="feature-compute-hero-title"
            id="feature-compute-hero-title"
            level={2}
          >
            {page.tagline}
          </Title>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.mutedText,
              fontSize: PUBLIC_TYPE.lead,
              lineHeight: 1.6,
              margin: 0,
              maxWidth: 650,
            }}
          >
            {page.summary}
          </Paragraph>
          <Flex gap={12} wrap>
            {primaryCta}
            <Button
              href={publicFeatureHref(docsLink.href, appBasePath)}
              size="large"
            >
              {docsLink.label}
            </Button>
          </Flex>
        </Flex>
      </section>

      <PublicSection>
        <Flex vertical gap={24}>
          <div style={{ maxWidth: 780 }}>
            <Title level={2} style={{ margin: "0 0 10px" }}>
              {options.title}
            </Title>
            {(options.paragraphs ?? []).map((paragraph) => (
              <Paragraph
                key={paragraph}
                style={{
                  color: PUBLIC_COLORS.mutedText,
                  fontSize: PUBLIC_TYPE.lead,
                  margin: 0,
                }}
              >
                {paragraph}
              </Paragraph>
            ))}
          </div>
          <div className="feature-compute-route-grid">
            {(options.cards ?? []).map((card) => (
              <div className="feature-compute-route-card" key={card.title}>
                <Flex vertical gap={14} style={{ height: "100%" }}>
                  <Title level={3} style={{ margin: 0 }}>
                    {card.title}
                  </Title>
                  <Paragraph
                    style={{
                      color: PUBLIC_COLORS.mutedText,
                      flex: 1,
                      margin: 0,
                    }}
                  >
                    {card.body}
                  </Paragraph>
                  {card.link ? (
                    <LinkButton
                      href={publicFeatureHref(card.link.href, appBasePath)}
                    >
                      {card.link.label}
                    </LinkButton>
                  ) : null}
                </Flex>
              </div>
            ))}
          </div>
        </Flex>
      </PublicSection>

      <PublicSection>
        <Flex vertical gap={16} style={{ maxWidth: 860 }}>
          <Title level={2} style={{ margin: 0 }}>
            {sizing.title}
          </Title>
          {(sizing.paragraphs ?? []).map((paragraph) => (
            <Paragraph
              key={paragraph}
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: PUBLIC_TYPE.lead,
                margin: 0,
              }}
            >
              {paragraph}
            </Paragraph>
          ))}
          <details className="feature-compute-details">
            <summary>{sizing.detailsLabel}</summary>
            <BulletList items={sizing.bullets ?? []} />
          </details>
          <Flex align="center" gap={16} style={{ marginTop: 8 }} wrap>
            {primaryCta}
            {(sizing.links ?? []).map((link) => (
              <LinkButton
                href={publicFeatureHref(link.href, appBasePath)}
                key={link.href}
              >
                {link.label}
              </LinkButton>
            ))}
            {helpEmail ? (
              <LinkButton href={`mailto:${helpEmail}`}>
                Contact CoCalc
              </LinkButton>
            ) : null}
          </Flex>
        </Flex>
      </PublicSection>
    </Flex>
  );
}
