/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { BulletList, featureAppPath as appPath } from "./page-components";
import { FeatureFinalBand, IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

export function SlideDeckMock() {
  const slides = [
    ["markdown", "1", "Problem", "markdown + math"],
    ["jupyter", "2", "Computation", "Jupyter cell"],
    ["line-chart", "3", "Result", "plot + explanation"],
    ["users", "4", "Discussion", "questions"],
  ] satisfies [IconName, string, string, string][];

  return (
    <div
      aria-label="Illustration of CoCalc slides as slide-sized whiteboard pages"
      style={{
        background: `linear-gradient(145deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.surfaceMuted} 56%, ${PUBLIC_COLORS.brandTint} 100%)`,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#d46b08" icon="slides" />
            <div>
              <Text strong>talk.slides</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                a sequence of slide-sized whiteboards
              </div>
            </div>
          </Flex>
        </Flex>

        <Row gutter={[12, 12]}>
          {slides.map(([icon, number, title, body]) => (
            <Col key={number} xs={24} sm={12}>
              <div
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PUBLIC_RADIUS.panel,
                  boxShadow: PUBLIC_ELEVATION.card,
                  height: "100%",
                  padding: 14,
                }}
              >
                <Flex align="center" gap={12}>
                  <IconBadge accent="#d46b08" icon={icon} />
                  <div>
                    <Flex align="center" gap={8} wrap>
                      <Text strong>{title}</Text>
                      <Text style={{ color: PUBLIC_COLORS.mutedText }} strong>
                        {number}
                      </Text>
                    </Flex>
                    <div style={{ color: PUBLIC_COLORS.mutedText }}>{body}</div>
                  </div>
                </Flex>
              </div>
            </Col>
          ))}
        </Row>
      </Flex>
    </div>
  );
}

function SlideFlow() {
  const steps = [
    ["layout", "Choose slide size"],
    ["markdown", "Write the story"],
    ["jupyter", "Add code or math"],
    ["slides", "Present"],
  ] satisfies [IconName, string][];

  return (
    <PublicSection>
      <Flex vertical gap={18}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            How a deck comes together
          </Title>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.mutedText,
              margin: "8px 0 0",
              maxWidth: "72ch",
            }}
          >
            Build a deck in a few steps: choose a slide size, write the story in
            markdown and math, add Jupyter cells, diagrams, or drawings, then
            present from the same project.
          </Paragraph>
        </div>
        <div
          style={{
            background: PUBLIC_COLORS.surface,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PUBLIC_RADIUS.panel,
            boxShadow: PUBLIC_ELEVATION.panel,
            padding: 22,
          }}
        >
          <Row gutter={[12, 12]} align="middle">
            {steps.map(([icon, label]) => (
              <Col key={label} xs={24} sm={12} lg={6}>
                <Flex align="center" gap={12}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Flex
                      align="center"
                      gap={12}
                      style={{
                        background: PUBLIC_COLORS.surfaceMuted,
                        border: `1px solid ${PUBLIC_COLORS.border}`,
                        borderRadius: PUBLIC_RADIUS.panel,
                        height: "100%",
                        padding: 14,
                      }}
                    >
                      <IconBadge accent="#d46b08" icon={icon} />
                      <Text strong>{label}</Text>
                    </Flex>
                  </div>
                </Flex>
              </Col>
            ))}
          </Row>
        </div>
      </Flex>
    </PublicSection>
  );
}

export default function SlidesFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalLabel = isAuthenticated ? "Open projects" : "Start making slides";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Present from the same canvas where technical ideas are built.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Live, editable slides you can run as you present — never a
                static export.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={appPath("features/whiteboard")}>
                  Whiteboards and slides overview
                </Button>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <SlideDeckMock />
          </Col>
        </Row>
      </PublicSection>

      <SlideFlow />

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project and create a slide deck for a technical presentation.",
            href: primaryHref,
            label: finalLabel,
            title: "Start with a deck",
          }}
          relatedLinks={[
            {
              href: appPath("features/whiteboard"),
              label: "Whiteboards and slides overview",
            },
            { href: appPath("features/teaching"), label: "Teaching" },
            {
              href: appPath("products"),
              label: "Compare operating models",
            },
          ]}
          title="When slides belong in CoCalc"
        >
          <BulletList
            items={[
              "Present technical walkthroughs from the same editable canvas where the material was built.",
              "Keep slides close to notebooks, files, data, and terminal work.",
              "Use math, diagrams, markdown, and code in technical talks.",
              "Collaborate on the deck and keep TimeTravel history around it.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
