/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
} from "./page-components";
import { IconBadge, StartCard, StoryCard } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

function SlideDeckMock() {
  const slides = [
    ["1", "Problem", "markdown + math"],
    ["2", "Computation", "Jupyter cell"],
    ["3", "Result", "plot + explanation"],
    ["4", "Discussion", "questions"],
  ];

  return (
    <div
      aria-label="Illustration of CoCalc slides as slide-sized whiteboard pages"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f7fbff 56%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
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
          {slides.map(([number, title, body]) => (
            <Col key={number} xs={24} sm={12}>
              <div
                style={{
                  aspectRatio: "16 / 9",
                  background: "#fff",
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 8,
                  boxShadow: "0 12px 30px rgba(33, 49, 57, 0.08)",
                  padding: 14,
                }}
              >
                <Flex
                  vertical
                  justify="space-between"
                  style={{ height: "100%" }}
                >
                  <Flex justify="space-between" align="center">
                    <Text strong>{title}</Text>
                    <Text style={{ color: "#d46b08" }} strong>
                      {number}
                    </Text>
                  </Flex>
                  <div
                    style={{
                      background: "#fff7e6",
                      border: "1px solid #ffd591",
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <Text>{body}</Text>
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
            Slides are structured whiteboards.
          </Title>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.mutedText,
              margin: "8px 0 0",
              maxWidth: "72ch",
            }}
          >
            CoCalc slides use the same technical canvas ideas as whiteboards,
            but organize them into a sequence of slide-sized pages with useful
            presets for talks, lectures, and demos.
          </Paragraph>
        </div>
        <div
          style={{
            background: "#fff",
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: 8,
            boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
            padding: 22,
          }}
        >
          <Row gutter={[12, 12]} align="middle">
            {steps.map(([icon, label]) => (
              <Col key={label} xs={24} lg={6}>
                <Flex align="center" gap={12}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Flex
                      align="center"
                      gap={12}
                      style={{
                        background: "#f7fbff",
                        border: `1px solid ${PUBLIC_COLORS.border}`,
                        borderRadius: 8,
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
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                CoCalc slides are a sequence of slide-sized whiteboards. They
                keep markdown, math, diagrams, Jupyter cells, drawings, and
                collaborative editing in the same project as the files and
                notebooks behind the presentation.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Use them for lectures, research talks, demos, and presentations
                that need more than static text and exported screenshots.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={appPath("features/whiteboard")}>
                  Whiteboard
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

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#d46b08" icon="slides" title="Slide-sized pages">
            Use presentation-sized canvases and presets instead of trying to
            force a huge whiteboard into a linear talk.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#2f6fda" icon="tex" title="Math and code">
            Combine equations, markdown, diagrams, and executable examples in
            the same presentation workflow.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#389e0d" icon="users" title="Collaborative talks">
            Coauthors and teaching assistants can edit the same deck in the same
            project where supporting material lives.
          </StoryCard>
        </Col>
      </Row>

      <SlideFlow />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3}>When slides belong in CoCalc</Title>
            <BulletList
              items={[
                "Build presentations from slide-sized whiteboard pages.",
                "Keep slides close to notebooks, files, data, and terminal work.",
                "Use math, diagrams, markdown, and code in technical talks.",
                "Collaborate on the deck and keep TimeTravel history around it.",
              ]}
            />
            <Flex wrap gap={12}>
              <Button href={appPath("features/whiteboard")}>Whiteboard</Button>
              <Button href={appPath("features/teaching")}>Teaching</Button>
              <Button
                href={featureSupportPath({
                  body: "I want to discuss CoCalc slides. Helpful context: lecture, research talk, demo, or course workflow; expected collaborators; and whether slides need math, diagrams, or notebook-backed material.",
                  context: "slides",
                  subject: "CoCalc slides",
                  title: "Ask CoCalc about slides",
                })}
              >
                Ask about slides
              </Button>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <StartCard
              body="Open a project and create a slide deck for a lecture, demo, or research presentation."
              href={primaryHref}
              label={finalLabel}
              title="Start with a deck"
            />
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
