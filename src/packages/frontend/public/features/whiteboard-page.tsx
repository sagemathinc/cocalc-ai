/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import { BulletList, featureAppPath as appPath } from "./page-components";
import { IconBadge, StartCard, StoryCard } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

function WhiteboardMock() {
  const nodes = [
    ["markdown", "Markdown note", "Proof idea + checklist"],
    ["tex", "KaTeX math", "∫ sin(x²) dx"],
    ["jupyter", "Jupyter cell", "run after prerequisites"],
    ["layout", "Frame", "lecture page 2"],
  ] satisfies [IconName, string, string][];

  return (
    <div
      aria-label="Illustration of a CoCalc whiteboard with markdown, math, and Jupyter cells"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 54%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#d4380d" icon="layout" />
            <div>
              <Text strong>whiteboard.board</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                infinite canvas, pages, math, code, and collaboration
              </div>
            </div>
          </Flex>
          <Tag color="orange" style={{ marginInlineEnd: 0 }}>
            JSONL document
          </Tag>
        </Flex>

        <div
          style={{
            background: "#fff",
            border: `1px dashed ${PUBLIC_COLORS.border}`,
            borderRadius: 22,
            minHeight: 310,
            padding: 18,
            position: "relative",
          }}
        >
          {nodes.map(([icon, title, body], index) => (
            <div
              key={title}
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 16,
                boxShadow: "0 12px 30px rgba(33, 49, 57, 0.08)",
                left: `${8 + (index % 2) * 45}%`,
                padding: 12,
                position: "absolute",
                top: `${8 + Math.floor(index / 2) * 43}%`,
                width: "44%",
              }}
            >
              <Flex align="center" gap={10}>
                <IconBadge
                  accent={index % 2 ? "#2f6fda" : "#d4380d"}
                  icon={icon}
                />
                <div>
                  <Text strong>{title}</Text>
                  <div style={{ color: PUBLIC_COLORS.mutedText }}>{body}</div>
                </div>
              </Flex>
            </div>
          ))}
          <Icon
            name="arrow-right"
            style={{
              color: "#d29c3c",
              fontSize: 30,
              left: "47%",
              position: "absolute",
              top: "45%",
            }}
          />
        </div>
      </Flex>
    </div>
  );
}

function ExecutionGraph() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Tag
              color="blue"
              style={{
                alignSelf: "flex-start",
                background: COLORS.ANTD_BG_BLUE_L,
                color: COLORS.BLUE_D,
              }}
            >
              Computational canvas
            </Tag>
            <Title level={3} style={{ margin: 0 }}>
              Put Jupyter cells in a directed graph.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              A CoCalc whiteboard is not only a drawing surface. Jupyter cells
              can live on the canvas, connect to each other, and run in graph
              order, which makes the board useful for computational diagrams,
              lecture flows, and exploratory workflows that are not naturally
              linear.
            </Paragraph>
            <BulletList
              items={[
                "Use markdown and Slate-based rich text for explanations.",
                "Write precise mathematics with KaTeX.",
                "Mix sketches, notes, frames, and executable cells.",
                "Organize large topics with an infinite canvas and multiple pages.",
              ]}
            />
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <div
            style={{
              background: "#fff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 26,
              boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
              padding: 22,
            }}
          >
            <Flex align="center" justify="space-between" gap={12}>
              {["data", "clean", "fit", "plot"].map((label, index) => (
                <Flex align="center" gap={10} key={label}>
                  <div
                    style={{
                      background: index === 3 ? "#fff7e6" : "#f7fbff",
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: 16,
                      padding: 14,
                    }}
                  >
                    <Flex vertical gap={8} align="center">
                      <IconBadge
                        accent={index === 3 ? "#ad6800" : "#2f6fda"}
                        icon={index === 3 ? "line-chart" : "jupyter"}
                      />
                      <Text strong>{label}</Text>
                    </Flex>
                  </div>
                  {index < 3 ? (
                    <Icon name="arrow-right" style={{ color: "#d29c3c" }} />
                  ) : null}
                </Flex>
              ))}
            </Flex>
          </div>
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function WhiteboardFeaturePage({
  helpEmail,
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalLabel = isAuthenticated
    ? "Open projects"
    : "Start using CoCalc whiteboards";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Tag color="orange" style={{ alignSelf: "flex-start" }}>
                Collaborative technical canvas
              </Tag>
              <Title level={2} style={{ margin: 0 }}>
                A Miro-like whiteboard rebuilt for computational work.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                CoCalc whiteboards cover the essential collaborative canvas
                workflow, but are shaped around technical material: rich
                markdown, KaTeX math, Jupyter cells, pages, frames, drawings,
                and a simple transparent JSONL document format.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                They are useful for teaching, office hours, research sketches,
                live support, and diagrams where code and math should be part of
                the board instead of pasted screenshots.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={appPath("features/slides")}>Slides</Button>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <WhiteboardMock />
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#d4380d" icon="markdown" title="Markdown native">
            Whiteboard content is based around rich markdown and Slate editing,
            so explanations stay editable, structured, and readable.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#2f6fda" icon="tex" title="Math first">
            KaTeX support makes formulas first-class board content, not blurry
            images copied from another tool.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#389e0d" icon="jupyter" title="Executable cells">
            Put Jupyter cells on the board and connect them in a graph when the
            idea is a computation rather than a static sketch.
          </StoryCard>
        </Col>
      </Row>

      <ExecutionGraph />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <StoryCard accent="#7c3aed" icon="users" title="Realtime by default">
            Collaborators can work on the same board, use side chat, and keep
            the explanation in the same project as the notebooks and files it
            references.
          </StoryCard>
        </Col>
        <Col xs={24} lg={12}>
          <StoryCard accent="#278c83" icon="file" title="Transparent format">
            The whiteboard is stored as a simple JSONL document, which keeps the
            format inspectable and friendly to project tooling.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3} style={{ margin: 0 }}>
              Why use whiteboards in CoCalc
            </Title>
            <BulletList
              items={[
                "Explain ideas with text, math, sketches, and live code together.",
                "Use an infinite canvas with multiple pages for large technical topics.",
                "Keep board work close to notebooks, terminals, files, and chat.",
                "Turn a whiteboard into slides when the same material becomes a presentation.",
              ]}
            />
            <Flex wrap gap={12}>
              <Button href={appPath("features/slides")}>Slides</Button>
              <Button href={appPath("features/teaching")}>Teaching</Button>
              {helpEmail ? (
                <Button href={`mailto:${helpEmail}`}>Contact support</Button>
              ) : null}
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <StartCard
              body="Open a project and create a board for technical diagrams, lecture notes, research sketches, or computational workflows."
              href={primaryHref}
              label={finalLabel}
              title="Start with a board"
            />
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
