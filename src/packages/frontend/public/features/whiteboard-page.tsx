/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
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

function WhiteboardMock() {
  const inputs = [
    ["markdown", "Markdown note", "Proof idea + checklist", "#d4380d"],
    ["tex", "LaTeX math", "∫ sin(x²) dx", "#2f6fda"],
    ["jupyter", "Jupyter cell", "run after prerequisites", "#389e0d"],
    ["layout", "Connected page", "lecture page 2", "#d4380d"],
  ] satisfies [IconName, string, string, string][];

  return (
    <div
      aria-label="Illustration of a CoCalc whiteboard with markdown, math, and Jupyter cells"
      style={{
        background: `linear-gradient(145deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.surfaceMuted} 54%, ${PUBLIC_COLORS.brandTint} 100%)`,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
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
        </Flex>

        <Row gutter={[12, 12]}>
          {inputs.map(([icon, title, body, accent]) => (
            <Col key={title} xs={24} sm={12}>
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
                  <IconBadge accent={accent} icon={icon} />
                  <div>
                    <Text strong>{title}</Text>
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

function GraphNode({
  accent,
  highlight,
  icon,
  label,
}: {
  accent: string;
  icon: IconName;
  label: string;
}) {
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.compact,
        padding: 12,
      }}
    >
      <Flex vertical gap={8} align="center">
        <IconBadge accent={accent} icon={icon} />
        <Text strong>{label}</Text>
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
                "Connect Jupyter cells so the board runs them in dependency order, not file order.",
                "Lay out branching analyses that are not a single linear column.",
                "Keep each cell's code, output, and the math that explains it together in one frame.",
              ]}
            />
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <div
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PUBLIC_RADIUS.panel,
              boxShadow: PUBLIC_ELEVATION.panel,
              padding: 18,
            }}
          >
            <Flex align="center" gap={8} justify="center" wrap>
              <GraphNode accent="#2f6fda" icon="jupyter" label="data" />
              <Icon
                name="arrow-right"
                style={{ color: PUBLIC_COLORS.warning }}
              />
              <GraphNode accent="#2f6fda" icon="jupyter" label="clean" />
              <Icon
                name="arrow-right"
                style={{ color: PUBLIC_COLORS.warning }}
              />
              <Flex vertical gap={12}>
                <GraphNode accent="#2f6fda" icon="jupyter" label="fit" />
                <GraphNode accent="#ad6800" icon="line-chart" label="plot" />
              </Flex>
            </Flex>
          </div>
        </Col>
      </Row>
    </PublicSection>
  );
}

function SlideDeckSection() {
  return (
    <PublicSection ariaLabel="Slide deck workflows">
      <Flex vertical gap={12} style={{ maxWidth: 820 }}>
        <Title level={3} style={{ margin: 0 }}>
          Move board work into a slide deck when it is ready.
        </Title>
        <Paragraph style={{ margin: 0 }}>
          For ordered presentations, use the dedicated slide decks workflow. It
          keeps slide-sized pages close to the same editable math, diagrams,
          Jupyter cells, files, and explanations without repeating the full deck
          workflow here.
        </Paragraph>
        <Flex wrap gap={12}>
          <Button href={appPath("features/slides")}>
            More about slide decks
          </Button>
          <Button href={appPath("features/teaching")}>Teaching</Button>
        </Flex>
      </Flex>
    </PublicSection>
  );
}

export default function WhiteboardFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Whiteboards and slides that keep the code, math, and
                explanations together — in one durable, reviewable project.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Work through the problem together, then replay every change with
                TimeTravel.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={appPath("features/slides")}>Slide decks</Button>
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

      <div id="slide-decks">
        <SlideDeckSection />
      </div>

      <ExecutionGraph />

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project and create a board or slide deck for technical diagrams, lecture notes, research sketches, presentations, or computational workflows.",
            href: primaryHref,
            label: primaryLabel,
            title: "Start with a board or deck",
          }}
          relatedLinks={[
            { href: appPath("features/slides"), label: "Slide decks" },
            { href: appPath("features/teaching"), label: "Teaching" },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="When a board or deck belongs in CoCalc"
        >
          <BulletList
            items={[
              "Choose a board when a research or engineering team needs to work through a method, not just store the final result.",
              "Review a collaborator's work in place with TimeTravel — replay how the board evolved and recover earlier versions, with the code, output, and math all there to inspect.",
              "Run office hours or a live support session on a shared board everyone can edit.",
              "Choose a deck when the explanation needs an ordered presentation path, not a static export.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
