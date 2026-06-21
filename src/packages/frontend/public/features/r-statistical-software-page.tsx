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
import {
  BulletList,
  featureAppPath as appPath,
} from "./page-components";
import { ContextList, IconBadge, StartCard } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

function RWorkflowMock() {
  const pieces = [
    ["jupyter", "Notebook", "IRKernel analysis"],
    ["terminal", "Terminal", "Rscript model.R"],
    ["markdown", "Rmd / Qmd", "reproducible report"],
    ["tex", "Knitr", "LaTeX output"],
  ] satisfies [IconName, string, string][];

  return (
    <div
      aria-label="Illustration of R workflows in a CoCalc project"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 54%, #f6fff4 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#386cb0" icon="r" />
            <div>
              <Text strong>R project</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                notebooks, scripts, reports, data, and collaborators
              </div>
            </div>
          </Flex>
        </Flex>

        <Row gutter={[12, 12]}>
          {pieces.map(([icon, title, body]) => (
            <Col key={title} xs={24} sm={12}>
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
                  <IconBadge accent="#386cb0" icon={icon} />
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

function RProjectFitBand() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              Keep R close to the rest of the analysis.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              A dedicated R environment is the right tool when the work is
              mainly R editing. CoCalc earns its place when R is one part of a
              larger research or engineering project — notebooks, Python, LaTeX,
              data, and shared files in one place, so collaborators and
              reviewers work from the same state with visible cursors in
              collaborative documents.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That fits reproducible research reports, statistical work that
              mixes R with Python or shell tools, shared notebook review, and
              team handoff — with teaching courses a natural extension, not the
              only use.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <ContextList
            accent="#386cb0"
            items={[
              { icon: "r", label: "Model, analyze, and report in R" },
              { icon: "python", label: "Mix with Python or shell tools" },
              {
                icon: "tex",
                label: "Publish with LaTeX, Rmd, Qmd, or Knitr",
              },
              {
                icon: "graduation-cap",
                label: "Teach in shared project environments",
              },
              {
                icon: "jupyter",
                label: "Review notebooks with shared kernel sessions",
              },
            ]}
            title="Project context"
          />
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function RStatisticalSoftwareFeaturePage({
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
                Use R for statistics and reproducible reporting.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Fit statistical models, build reproducible reports, and share
                the analysis with your lab or team — using R in notebooks,
                scripts, and Quarto or RMarkdown documents.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
                <Button href={appPath("features/latex-editor")}>
                  LaTeX editor
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <RWorkflowMock />
          </Col>
        </Row>
      </PublicSection>

      <RProjectFitBand />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                From analysis to a shared report
              </Title>
              <BulletList
                items={[
                  "Develop the model in a notebook or script, with packages and data in the project.",
                  "Render a Quarto or RMarkdown report to HTML or PDF from the same project.",
                  "Collaborators and reviewers open the project and see the exact code, output, and history.",
                  "Re-run it later — the environment, data, and report build are still there.",
                ]}
              />
              <Flex wrap gap={12}>
                <Button href={appPath("features/python")}>Python</Button>
                <Button href={appPath("features/latex-editor")}>
                  LaTeX editor
                </Button>
                <Button href={appPath("products")}>
                  Compare operating models
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <StartCard
              body="Open a project and use R in notebooks, terminals, reports, or teaching workflows."
              href={primaryHref}
              label={primaryLabel}
              title="Start in a project"
            />
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
