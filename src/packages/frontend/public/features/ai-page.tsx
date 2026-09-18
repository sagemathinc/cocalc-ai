/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { getPublicAIContent } from "@cocalc/util/public-ai-content";
import { publicFeatureHref } from "@cocalc/util/public-feature-pages";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS, PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import {
  featureAppPath as appPath,
  featureSignUpPath,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;
const AI_PAGE_CSS = `
.feature-ai-hero { padding: clamp(24px, 5vw, 56px) 0 12px; max-width: 850px; }
.cocalc-public-page .feature-ai-hero-title.ant-typography {
  font-size: clamp(38px, 5vw, 62px); font-weight: 500;
  letter-spacing: -0.035em; line-height: 1.08; margin: 0; max-width: 23ch;
}
.feature-ai-eyebrow { color: ${PUBLIC_COLORS.link}; font-size: ${PUBLIC_TYPE.eyebrow}px;
  letter-spacing: .08em; text-transform: uppercase; }
.feature-ai-project-card { border-top: 2px solid ${PUBLIC_COLORS.border};
  height: 100%; padding: 24px 0 0; display: flex; flex-direction: column; gap: 16px; }
.feature-ai-project-card .ant-btn { align-self: flex-start; margin-top: auto;
  white-space: normal; height: auto; text-align: left; padding-left: 0; }
.feature-ai-review { border-block: 1px solid ${PUBLIC_COLORS.border};
  padding: clamp(28px, 4vw, 44px) 0; }
.feature-ai-step-number { color: ${PUBLIC_COLORS.link}; font-size: 14px; font-weight: 700; }
.feature-ai-start { background: ${PUBLIC_COLORS.surfaceMuted};
  border: 1px solid ${PUBLIC_COLORS.border}; padding: clamp(24px, 4vw, 40px); }
`;

export default function AIFeaturePage({
  helpEmail,
  isAuthenticated,
  product,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
  product?: string;
}) {
  const content = getPublicAIContent(product);
  const plus = product === "plus";
  const primaryHref = plus
    ? appPath("products/cocalc-plus#install-cocalc-plus")
    : isAuthenticated
      ? appPath("projects")
      : featureSignUpPath("codex");
  const primaryLabel = plus
    ? "Explore CoCalc Plus"
    : isAuthenticated
      ? "Open projects"
      : "Create account";
  const href = (path: string) => publicFeatureHref(path, appBasePath);

  return (
    <>
      <style>{AI_PAGE_CSS}</style>
      <Flex vertical gap={56}>
        <PublicSection>
          <section
            aria-labelledby="feature-ai-hero-title"
            className="feature-ai-hero"
          >
            <Flex vertical gap={22}>
              <Text className="feature-ai-eyebrow" strong>
                {content.hero.eyebrow}
              </Text>
              <Title
                level={2}
                id="feature-ai-hero-title"
                className="feature-ai-hero-title"
              >
                {content.hero.title}
              </Title>
              <Paragraph
                style={{
                  fontSize: PUBLIC_TYPE.lead,
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                {content.hero.description}
              </Paragraph>
              <Flex wrap gap={12}>
                <Button size="large" type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button size="large" href="#professional-projects" type="text">
                  Explore project ideas
                </Button>
              </Flex>
            </Flex>
          </section>
        </PublicSection>
        <PublicSection>
          <section
            id="professional-projects"
            aria-labelledby="feature-ai-projects-title"
          >
            <Title level={2} id="feature-ai-projects-title">
              {content.projects.title}
            </Title>
            <Paragraph>{content.projects.description}</Paragraph>
            <Row gutter={[32, 28]}>
              {content.projects.cards.map((card) => (
                <Col key={card.title} xs={24} md={8}>
                  <article className="feature-ai-project-card">
                    <Title level={3} style={{ margin: 0 }}>
                      {card.title}
                    </Title>
                    <Paragraph style={{ margin: 0 }}>
                      {card.description}
                    </Paragraph>
                    <Button type="link" href={href(card.link.href)}>
                      {card.link.label}
                    </Button>
                  </article>
                </Col>
              ))}
            </Row>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                margin: "26px 0 0",
                fontSize: 14,
              }}
            >
              {content.projects.guideNote}
            </Paragraph>
          </section>
        </PublicSection>
        <PublicSection>
          <section
            id="how-agent-work-flows"
            aria-labelledby="feature-ai-workflow-title"
            className="feature-ai-review"
          >
            <Title level={2} id="feature-ai-workflow-title">
              {content.workflow.title}
            </Title>
            <Row gutter={[32, 24]}>
              {content.workflow.steps.map((step, i) => (
                <Col key={step.title} xs={24} md={8}>
                  <Text className="feature-ai-step-number">
                    {String(i + 1).padStart(2, "0")}
                  </Text>
                  <Title level={3} style={{ margin: "10px 0" }}>
                    {step.title}
                  </Title>
                  <Paragraph style={{ margin: 0 }}>
                    {step.description}
                  </Paragraph>
                </Col>
              ))}
            </Row>
          </section>
        </PublicSection>
        <PublicSection>
          <Row gutter={[48, 28]}>
            <Col xs={24} md={12}>
              <section aria-labelledby="feature-ai-review-title">
                <Title level={2} id="feature-ai-review-title">
                  {content.review.title}
                </Title>
                <Paragraph>{content.review.description}</Paragraph>
                <Button href={href(content.review.link.href)}>
                  {content.review.link.label}
                </Button>
              </section>
            </Col>
            <Col xs={24} md={12}>
              <section aria-labelledby="feature-ai-setup-title">
                <Title level={2} id="feature-ai-setup-title">
                  {content.setup.title}
                </Title>
                <Paragraph>{content.setup.description}</Paragraph>
                <Flex gap={12} wrap>
                  {content.setup.links.map((link) => (
                    <Button key={link.href} href={href(link.href)}>
                      {link.label}
                    </Button>
                  ))}
                </Flex>
              </section>
            </Col>
          </Row>
        </PublicSection>
        <PublicSection>
          <section aria-labelledby="feature-ai-compute-title">
            <Row gutter={[36, 20]} align="middle">
              <Col xs={24} md={14}>
                <Title level={2} id="feature-ai-compute-title">
                  {content.compute.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {content.compute.description}
                </Paragraph>
              </Col>
              <Col xs={24} md={10}>
                <Flex gap={12} wrap>
                  {content.compute.links.map((link) => (
                    <Button key={link.href} href={href(link.href)}>
                      {link.label}
                    </Button>
                  ))}
                </Flex>
              </Col>
            </Row>
          </section>
        </PublicSection>
        <PublicSection>
          <section
            className="feature-ai-start"
            aria-labelledby="feature-ai-start-title"
          >
            <Title level={2} id="feature-ai-start-title">
              {content.closing.title}
            </Title>
            <Paragraph>{content.closing.description}</Paragraph>
            <Flex gap={12} wrap>
              <Button size="large" type="primary" href={primaryHref}>
                {primaryLabel}
              </Button>
              {helpEmail && (
                <Button href={`mailto:${helpEmail}`}>Contact CoCalc</Button>
              )}
            </Flex>
          </section>
        </PublicSection>
      </Flex>
    </>
  );
}
