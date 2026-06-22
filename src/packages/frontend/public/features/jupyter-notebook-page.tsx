/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState, type ReactNode } from "react";

import { Button, Col, Flex, Modal, Row, Typography } from "antd";

import { type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_DARK,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  CodeBlock,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";
import { IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

function StoryCard({
  accent = PUBLIC_COLORS.brand,
  children,
  icon,
  title,
}: {
  accent?: string;
  children: ReactNode;
  icon: IconName;
  title: string;
}) {
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.media,
        height: "100%",
        padding: 22,
      }}
    >
      <Flex vertical gap={14}>
        <IconBadge accent={accent} icon={icon} />
        <Title level={3} style={{ margin: 0 }}>
          {title}
        </Title>
        <Paragraph style={{ margin: 0 }}>{children}</Paragraph>
      </Flex>
    </div>
  );
}

function NotebookMock() {
  const cells = [
    {
      input: "df = load_experiment('spectral-gap')",
      output: "data loaded",
    },
    {
      input: "plot_gap_distribution(df)",
      output: "interactive widget + figure",
    },
    {
      input: "fit = model(df); fit.summary()",
      output: "model summary ready",
    },
  ];
  return (
    <div
      aria-label="Illustration of a CoCalc Jupyter notebook inside a project"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={14}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#f37726" icon="jupyter" />
            <div>
              <Text strong>analysis.ipynb</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                live backend session
              </div>
            </div>
          </Flex>
        </Flex>
        <div
          style={{
            background: PUBLIC_DARK.deepSurface,
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
              padding: "12px 14px",
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
              CoCalc Notebook
            </Text>
          </div>
          <Flex vertical gap={12} style={{ padding: 16 }}>
            {cells.map((cell, index) => (
              <div
                key={cell.input}
                style={{
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: PUBLIC_RADIUS.panel,
                  padding: 12,
                }}
              >
                <Text style={{ color: "#93c5fd" }}>[{index + 1}]</Text>{" "}
                <code style={{ color: "#f8fafc" }}>{cell.input}</code>
                <div
                  style={{
                    background: "rgba(255,255,255,0.1)",
                    borderRadius: PUBLIC_RADIUS.panel,
                    color: "#bbf7d0",
                    marginTop: 10,
                    padding: "8px 10px",
                  }}
                >
                  {cell.output}
                </div>
              </div>
            ))}
          </Flex>
        </div>
      </Flex>
    </div>
  );
}

function LiveStateDiagram() {
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.panel,
        padding: 24,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" gap={12}>
          <IconBadge accent="#7c3aed" icon="robot" />
          <div>
            <Text strong>Codex sees the current notebook state</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              Cells, outputs, errors, and runs stay visible to the agent.
            </div>
          </div>
        </Flex>
        <CodeBlock
          ariaLabel="Project-scoped Jupyter commands"
          code={`cocalc project jupyter cells --path analysis.ipynb
cocalc project jupyter run --path analysis.ipynb --cell-index 3
cocalc project jupyter exec --path analysis.ipynb --stdin`}
        />
        <Row gutter={[10, 10]}>
          {["inspect cells", "run focused code", "summarize output"].map(
            (label) => (
              <Col key={label} xs={24} sm={8}>
                <div
                  style={{
                    background: `${COLORS.AI_ASSISTANT_FONT}12`,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PUBLIC_RADIUS.panel,
                    padding: "8px 10px",
                    width: "100%",
                  }}
                >
                  <Text strong style={{ color: PUBLIC_COLORS.heading }}>
                    {label}
                  </Text>
                </div>
              </Col>
            ),
          )}
        </Row>
      </Flex>
    </div>
  );
}

export default function JupyterNotebookFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const [showAgentDetails, setShowAgentDetails] = useState(false);
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start using Jupyter in CoCalc";

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Text
                strong
                style={{
                  alignSelf: "flex-start",
                  color: PUBLIC_COLORS.heading,
                  fontSize: PUBLIC_TYPE.eyebrow,
                  letterSpacing: 0,
                  textTransform: "uppercase",
                }}
              >
                Jupyter notebooks
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Jupyter notebooks for work that needs to keep going
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Run standard notebooks in CoCalc when analysis depends on data
                files, packages, collaborators, or a course workflow.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                For industry R&D, data-science, and research teams, the notebook
                stays connected to the surrounding files and execution state
                instead of living as an isolated browser session.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <Button href={`${GUIDE_BASE}/jupyter-notebooks/`}>
                  Read the Jupyter guide
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <NotebookMock />
          </Col>
        </Row>
      </PublicSection>

      <Row className="cocalc-jupyter-story-row" gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <StoryCard icon="stopwatch" title="Keep runs alive">
            Start a long cell, disconnect, and return to the captured output.
            CoCalc keeps the run and output available for review when you
            reconnect.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard accent="#389e0d" icon="users" title="Work together live">
            Multiple people can edit with visible cursors, discuss the work, and
            share kernel sessions in the same notebook. Collaboration stays in
            the document instead of becoming a screen-share workaround.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent="#7c3aed"
            icon="history"
            title="Review and recover changes"
          >
            TimeTravel records notebook edits with authorship, so teams can
            recover work, review results, and understand how an analysis
            evolved.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Flex vertical gap={12} style={{ maxWidth: 860 }}>
          <Title level={3} style={{ margin: 0 }}>
            When the notebook depends on more than cells
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Notebooks are often the visible part of a larger analysis. CoCalc
            keeps the surrounding work close enough that a reader, collaborator,
            or instructor can understand what produced a result.
          </Paragraph>
          <BulletList
            items={[
              "Use terminal and Linux tools without moving the notebook elsewhere.",
              "Keep data files, scripts, figures, and paper drafts near the computation.",
              "Bring collaborators or instructors into the same working state, with visible cursors and shared kernel sessions.",
            ]}
          />
          <Flex wrap gap={12}>
            <Button href={appPath("features/terminal")}>
              Terminal workflows
            </Button>
            <Button href={appPath("features/linux")}>Linux environment</Button>
            <Button href={appPath("features/latex-editor")}>
              LaTeX papers
            </Button>
          </Flex>
        </Flex>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Choose the notebook path that fits
              </Title>
              <Paragraph style={{ margin: 0 }}>
                The same notebooks stay portable — pick the path that matches
                how your team needs to run them.
              </Paragraph>
              <BulletList
                items={[
                  "Use CoCalc.ai for hosted notebooks with shared files and terminals.",
                  "Use teaching workflows when notebooks become assignments in student projects.",
                  "Compare operating models when procurement, licensing, or deployment control matters.",
                ]}
              />
              <Flex wrap gap={12}>
                <Button
                  type="link"
                  onClick={() => setShowAgentDetails(true)}
                  style={{ minHeight: 24, paddingInline: 0 }}
                >
                  See agent details
                </Button>
                <LinkButton href={appPath("features/teaching")}>
                  Teaching workflows
                </LinkButton>
                <LinkButton href={`${GUIDE_BASE}/cocalc-for-jupyter/`}>
                  Compatibility guide
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <Flex
              className="cocalc-feature-final-panel"
              vertical
              gap={14}
              style={{
                background: PUBLIC_COLORS.surfaceMuted,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                boxShadow: PUBLIC_ELEVATION.panelStrong,
                color: PUBLIC_COLORS.heading,
                padding: 26,
              }}
            >
              <Title
                level={3}
                style={{ color: PUBLIC_COLORS.heading, margin: 0 }}
              >
                Ready to use Jupyter in CoCalc?
              </Title>
              <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
                Open a hosted notebook on CoCalc.ai and bring your team into the
                same workspace.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {finalCtaLabel}
                </Button>
                <Button href={appPath("products")}>
                  Compare operating models
                </Button>
              </Flex>
            </Flex>
          </Col>
        </Row>
      </PublicSection>
      <Modal
        footer={null}
        onCancel={() => setShowAgentDetails(false)}
        open={showAgentDetails}
        title="How Codex works with live notebooks"
        width={760}
      >
        <Flex vertical gap={18}>
          <Paragraph style={{ fontSize: PUBLIC_TYPE.body, margin: 0 }}>
            Saving an `.ipynb` file is not the same as understanding the live
            session. CoCalc gives Codex project-scoped notebook commands, so it
            can inspect cells, start focused runs, and reason from actual
            output.
          </Paragraph>
          <LiveStateDiagram />
          <Flex wrap gap={12}>
            <Button type="primary" href={appPath("features/ai")}>
              AI workflows
            </Button>
          </Flex>
        </Flex>
      </Modal>
    </Flex>
  );
}
