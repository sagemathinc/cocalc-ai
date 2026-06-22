/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_DARK,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { BulletList, featureAppPath as appPath } from "./page-components";
import { ContextList, FeatureFinalBand, IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

function SageWorkspaceMock() {
  const blocks = [
    {
      accent: "#389e0d",
      body: "algebra, calculus, number theory, plotting",
      icon: "sagemath",
      title: "SageMath",
    },
    {
      accent: "#2f6fda",
      body: "notebooks, Python libraries, widgets",
      icon: "jupyter",
      title: "Jupyter",
    },
    {
      accent: "#ad6800",
      body: "SageTeX, papers, handouts, figures",
      icon: "tex",
      title: "LaTeX",
    },
    {
      accent: "#7c3aed",
      body: "terminals, databases, Codex, long jobs",
      icon: "terminal",
      title: "Research",
    },
  ] satisfies {
    accent: string;
    body: string;
    icon: IconName;
    title: string;
  }[];

  return (
    <div
      aria-label="Illustration of SageMath connected to notebooks, LaTeX, terminals, and research workflows"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f3fbf3 52%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#389e0d" icon="sagemath" />
            <div>
              <Text strong>SageMath in CoCalc</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                open mathematical software in a collaborative project
              </div>
            </div>
          </Flex>
        </Flex>

        <Row gutter={[12, 12]}>
          {blocks.map((block) => (
            <Col key={block.title} xs={24} sm={12}>
              <div
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PUBLIC_RADIUS.panel,
                  height: "100%",
                  padding: 14,
                }}
              >
                <Flex align="center" gap={12}>
                  <IconBadge accent={block.accent} icon={block.icon} />
                  <div>
                    <Text strong>{block.title}</Text>
                    <div style={{ color: PUBLIC_COLORS.mutedText }}>
                      {block.body}
                    </div>
                  </div>
                </Flex>
              </div>
            </Col>
          ))}
        </Row>

        <div
          style={{
            background: PUBLIC_DARK.terminalSurface,
            borderRadius: PUBLIC_RADIUS.panel,
            color: PUBLIC_DARK.mockText,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "rgba(255,255,255,0.08)",
              display: "flex",
              gap: 8,
              padding: "10px 14px",
            }}
          >
            {[
              PUBLIC_DARK.dotRed,
              PUBLIC_DARK.dotAmber,
              PUBLIC_DARK.dotGreen,
            ].map((color) => (
              <span
                aria-hidden="true"
                key={color}
                style={{
                  background: color,
                  borderRadius: "50%",
                  height: 10,
                  width: 10,
                }}
              />
            ))}
            <Text style={{ color: PUBLIC_DARK.mockText, marginLeft: 8 }}>
              sage
            </Text>
          </div>
          <Flex
            vertical
            gap={8}
            style={{
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              padding: 16,
            }}
          >
            <Text style={{ color: PUBLIC_DARK.mockTextDim }}>
              sage: factor(x^8 - 1)
            </Text>
            <Text style={{ color: PUBLIC_DARK.mockTextAlt }}>
              (x - 1)*(x + 1)*(x^2 + 1)*(x^4 + 1)
            </Text>
            <Text style={{ color: PUBLIC_DARK.mockTextDim }}>
              sage: plot(sin(x^2), (x, -4, 4))
            </Text>
          </Flex>
        </div>
      </Flex>
    </div>
  );
}

function TeachingComparison() {
  const tools = [
    ["calculator", "symbolic math"],
    ["line-chart", "2D and 3D plotting"],
    ["python", "Python libraries"],
    ["graduation-cap", "course workflows"],
  ] satisfies [IconName, string][];

  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={11}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              An open computational mathematics environment for courses.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              SageMath covers symbolic computation, calculus, linear algebra,
              data work, and 2D or 3D plotting as a free, open-source Python
              library. CoCalc pairs it with course projects, assignments,
              nbgrader, TimeTravel, and shared environments.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={13}>
          <ContextList
            accent="#389e0d"
            items={tools.map(([icon, label]) => ({ icon, label }))}
            title="Course context"
          />
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function SageFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start using SageMath";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Use SageMath inside collaborative mathematics projects.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Built by the team behind SageMath — notebooks, LaTeX, and
                terminals together in one project.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Use SageMath for computational mathematics while collaborators,
                reviewers, and students follow the surrounding work in real
                time.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
                <Button href={appPath("features/teaching")}>Teaching</Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <SageWorkspaceMock />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Use Sage with the surrounding project.
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Some Sage workflows need source files, terminal commands,
                generated figures, logs, and notes beside the notebook so the
                setup can be picked up later.
              </Paragraph>
              <BulletList
                items={[
                  "Keep Sage notebooks, source files, logs, generated figures, and notes together.",
                  "Review notebook computations with visible cursors and shared kernel sessions.",
                  "Run package tools, scripts, generated outputs, and long jobs from the project terminal.",
                  "Let a collaborator or Codex inspect an error with the surrounding context.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <ContextList
              accent="#389e0d"
              items={[
                { icon: "file", label: "Keep source files" },
                { icon: "terminal", label: "Run project commands" },
                { icon: "bug", label: "Inspect errors" },
                { icon: "robot", label: "Use Codex with context" },
              ]}
              title="Project context"
            />
          </Col>
        </Row>
      </PublicSection>

      <TeachingComparison />

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project and use Sage in notebooks, terminals, LaTeX documents, courses, or long-running research jobs.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Start using SageMath",
          }}
          relatedLinks={[
            { href: appPath("features/latex-editor"), label: "LaTeX editor" },
            {
              href: appPath("features/terminal"),
              label: "Terminal workflows",
            },
            {
              href: appPath("products"),
              label: "Compare operating models",
            },
          ]}
          title="When SageMath belongs in CoCalc."
        >
          <BulletList
            items={[
              "When the math is one part of a larger research or engineering project, not a standalone worksheet.",
              "When a paper or handout needs Sage output rendered inline, with SageTeX in the collaborative LaTeX editor.",
              "When several people need to run, review, or continue the same computation from one shared project.",
              "When a course needs a shared environment students can use without installing anything.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
