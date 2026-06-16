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
  LinkButton,
} from "./page-components";
import {
  IconBadge,
  StartCard,
  StoryCard,
  TerminalMock,
} from "./feature-visuals";

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
        borderRadius: 8,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
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
                  background: "#fff",
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 8,
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

        <TerminalMock
          title="R terminal"
          rows={[
            "$ Rscript analysis.R",
            "wrote figures/model-diagnostics.pdf",
            "$ quarto render report.qmd",
            "created report.html",
          ]}
        />
      </Flex>
    </div>
  );
}

function PositioningBand() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              CoCalc is not trying to be RStudio.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              RStudio and the Posit ecosystem are the dominant dedicated R
              environment, and many R users should use them. CoCalc is useful
              when R is part of a broader collaborative project: notebooks,
              terminals, Python, LaTeX, teaching, Linux setup, files, and Codex
              context all live together.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That makes CoCalc a good fit for courses, mixed-language
              computational work, and reproducible reports that need project
              infrastructure around R rather than only an R IDE.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <div
            style={{
              background: "#fff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 8,
              boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
              padding: 22,
            }}
          >
            <Flex vertical gap={12}>
              {[
                ["r", "Use R where it fits"],
                ["python", "Mix with Python or shell tools"],
                ["tex", "Publish with LaTeX, Rmd, Qmd, or Knitr"],
                ["graduation-cap", "Teach in shared project environments"],
              ].map(([icon, label]) => (
                <Flex
                  align="center"
                  gap={12}
                  key={label}
                  style={{
                    background: "#f7fbff",
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: 8,
                    padding: 14,
                  }}
                >
                  <IconBadge accent="#386cb0" icon={icon as IconName} />
                  <Text strong>{label}</Text>
                </Flex>
              ))}
            </Flex>
          </div>
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function RStatisticalSoftwareFeaturePage({
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
  const finalLabel = isAuthenticated ? "Open projects" : "Start using R";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Use R when statistics is part of a larger workflow.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                CoCalc supports R through Jupyter notebooks, terminals, scripts,
                RMarkdown-style documents, Quarto-style workflows, Knitr, LaTeX,
                shared files, and course projects.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                It is useful when R analysis needs to live beside other
                technical work: Python, shell commands, generated reports,
                teaching infrastructure, and collaborative review.
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

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#386cb0" icon="jupyter" title="R notebooks">
            Use R in collaborative Jupyter notebooks when interactive analysis
            and teaching benefit from shared browser notebooks.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#278c83" icon="terminal" title="R in the shell">
            Run <code>R</code>, <code>Rscript</code>, package installs, command
            pipelines, and reproducible jobs in a real Linux terminal.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#ad6800" icon="markdown" title="Reports">
            Keep Rmd, Qmd, Knitr, LaTeX, generated figures, and supporting data
            together in the project.
          </StoryCard>
        </Col>
      </Row>

      <PositioningBand />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3}>When R belongs in CoCalc</Title>
            <BulletList
              items={[
                "Use notebooks, terminals, scripts, and reproducible document workflows in one place.",
                "Share an R environment with collaborators or students without local setup drift.",
                "Keep R near Python, Linux tools, LaTeX, Git, and project chat.",
                "Best fit when project context matters more than a dedicated R IDE.",
              ]}
            />
            <Flex wrap gap={12}>
              <Button href={appPath("features/python")}>Python</Button>
              <Button href={appPath("features/teaching")}>Teaching</Button>
              {helpEmail ? (
                <Button href={`mailto:${helpEmail}`}>Contact support</Button>
              ) : null}
            </Flex>
            <LinkButton href={appPath("features/linux")}>
              Linux environment
            </LinkButton>
          </Col>
          <Col xs={24} lg={11}>
            <StartCard
              body="Open a project and use R in notebooks, terminals, reports, or teaching workflows."
              href={primaryHref}
              label={finalLabel}
              title="Start in a project"
            />
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
