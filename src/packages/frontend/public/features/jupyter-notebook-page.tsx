/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState, type ReactNode } from "react";

import { Button, Col, Flex, Modal, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
const PANEL_RADIUS = 8;

function IconBadge({
  accent = PUBLIC_COLORS.brand,
  icon,
}: {
  accent?: string;
  icon: IconName;
}) {
  return (
    <span
      style={{
        alignItems: "center",
        background: `${accent}14`,
        border: `1px solid ${accent}33`,
        borderRadius: PANEL_RADIUS,
        color: accent,
        display: "inline-flex",
        flex: "0 0 auto",
        fontSize: 24,
        height: 52,
        justifyContent: "center",
        width: 52,
      }}
    >
      <Icon name={icon} />
    </span>
  );
}

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
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: "0 14px 40px rgba(33, 49, 57, 0.07)",
        height: "100%",
        padding: 22,
      }}
    >
      <Flex vertical gap={14}>
        <IconBadge accent={accent} icon={icon} />
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        <Paragraph style={{ margin: 0 }}>{children}</Paragraph>
      </Flex>
    </div>
  );
}

function ActionCard({
  accent = PUBLIC_COLORS.brand,
  action,
  body,
  icon,
  title,
}: {
  accent?: string;
  action: ReactNode;
  body: ReactNode;
  icon: IconName;
  title: string;
}) {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        height: "100%",
        padding: 20,
      }}
    >
      <Flex vertical gap={12} style={{ height: "100%" }}>
        <IconBadge accent={accent} icon={icon} />
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        <Paragraph style={{ flex: 1, margin: 0 }}>{body}</Paragraph>
        <div>{action}</div>
      </Flex>
    </div>
  );
}

function NotebookMock() {
  const cells = [
    {
      input: "df = load_experiment('spectral-gap')",
      output: "42,180 rows loaded",
    },
    {
      input: "plot_gap_distribution(df)",
      output: "interactive widget + figure",
    },
    {
      input: "fit = model(df); fit.summary()",
      output: "R^2 = 0.94",
    },
  ];
  return (
    <div
      aria-label="Illustration of a CoCalc Jupyter notebook inside a project"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
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
            background: "#0b1f47",
            borderRadius: PANEL_RADIUS,
            color: "#dbeafe",
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
            {["#ff6b6b", "#ffd166", "#06d6a0"].map((color) => (
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
            <Text style={{ color: "#dbeafe", marginLeft: 8 }}>
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
                  borderRadius: PANEL_RADIUS,
                  padding: 12,
                }}
              >
                <Text style={{ color: "#93c5fd" }}>[{index + 1}]</Text>{" "}
                <code style={{ color: "#f8fafc" }}>{cell.input}</code>
                <div
                  style={{
                    background: "rgba(255,255,255,0.1)",
                    borderRadius: PANEL_RADIUS,
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
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
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
        <pre
          style={{
            background: "#10213f",
            borderRadius: PANEL_RADIUS,
            color: "#dbeafe",
            margin: 0,
            overflowX: "auto",
            padding: 18,
          }}
        >
          <code>{`cocalc project jupyter cells --path analysis.ipynb
cocalc project jupyter run --path analysis.ipynb --cell-index 3
cocalc project jupyter exec --path analysis.ipynb --stdin`}</code>
        </pre>
        <Row gutter={[10, 10]}>
          {["inspect cells", "run focused code", "summarize output"].map(
            (label) => (
              <Col key={label} xs={24} sm={8}>
                <div
                  style={{
                    background: `${COLORS.AI_ASSISTANT_FONT}12`,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PANEL_RADIUS,
                    padding: "8px 10px",
                    width: "100%",
                  }}
                >
                  <Text strong style={{ color: COLORS.AI_ASSISTANT_FONT }}>
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
  const supportHref = featureSupportPath({
    body: "I want to discuss Jupyter notebook workflows in CoCalc. Helpful context: research, teaching, or team use case; expected collaborators; notebook size or runtime needs; and whether AI assistance, course workflows, or private deployment matters.",
    context: "jupyter-notebook",
    subject: "CoCalc Jupyter notebook workflows",
    title: "Ask CoCalc about Jupyter notebook workflows",
  });

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
                  color: COLORS.BLUE_D,
                  fontSize: 12,
                  letterSpacing: 0,
                  textTransform: "uppercase",
                }}
              >
                Jupyter notebooks
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Jupyter notebooks for work that needs to keep going
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                Run standard notebooks in CoCalc when analysis depends on data
                files, packages, collaborators, review history, or a course
                workflow.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                For research groups, classes, and technical teams, the notebook
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

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <StoryCard icon="stopwatch" title="Keep runs alive">
            Start a long cell, disconnect, and return to the captured output.
            The browser tab is not the source of truth for execution.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard accent="#389e0d" icon="users" title="Work together live">
            Multiple people can edit, discuss, and inspect the same notebook.
            Collaboration stays in the document instead of becoming a
            screen-share workaround.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent="#7c3aed"
            icon="history"
            title="Review and recover changes"
          >
            Notebook edits are recorded with authorship, so teams can recover
            work, review results, and understand how an analysis evolved.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                When the notebook depends on more than cells
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Notebooks are often the visible part of a larger analysis.
                CoCalc keeps the surrounding work close enough that a reader,
                collaborator, or instructor can understand what produced a
                result.
              </Paragraph>
              <BulletList
                items={[
                  "Use terminal and Linux tools without moving the notebook elsewhere.",
                  "Keep data files, scripts, figures, and paper drafts near the computation.",
                  "Bring collaborators or instructors into the same working state.",
                ]}
              />
              <Flex wrap gap={12}>
                <Button href={appPath("features/terminal")}>
                  Terminal workflows
                </Button>
                <Button href={appPath("features/linux")}>
                  Linux environment
                </Button>
                <Button href={appPath("features/latex-editor")}>
                  LaTeX papers
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <div
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                padding: 22,
              }}
            >
              <Flex vertical gap={12}>
                {[
                  [
                    "A run takes hours",
                    "Close the browser and return to the backend session.",
                  ],
                  [
                    "A collaborator joins",
                    "They see the current notebook and surrounding files.",
                  ],
                  ["A result needs review", "TimeTravel keeps the edit trail."],
                ].map(([left, right]) => (
                  <div
                    key={left}
                    style={{
                      background: PUBLIC_COLORS.surfaceMuted,
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: PANEL_RADIUS,
                      padding: 14,
                    }}
                  >
                    <Text strong>{left}</Text>
                    <Paragraph
                      style={{
                        color: PUBLIC_COLORS.mutedText,
                        margin: "4px 0 0",
                      }}
                    >
                      {right}
                    </Paragraph>
                  </div>
                ))}
              </Flex>
            </div>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Flex vertical gap={18}>
          <Row gutter={[16, 16]}>
            <Col xs={24}>
              <Title level={3} style={{ margin: 0 }}>
                Where to go from here
              </Title>
              <Paragraph style={{ margin: "8px 0 0", maxWidth: 760 }}>
                Use these routes when the notebook has become part of a broader
                workflow.
              </Paragraph>
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12} xl={6}>
              <ActionCard
                accent="#d46b08"
                action={
                  <Button onClick={() => setShowAgentDetails(true)}>
                    See agent details
                  </Button>
                }
                body="Ask Codex to inspect cells, run focused checks, and summarize output while people keep the review context visible."
                icon="robot"
                title="Bring Codex into a live notebook"
              />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <ActionCard
                accent="#389e0d"
                action={
                  <Button href={appPath("features/whiteboard")}>
                    Whiteboard workflows
                  </Button>
                }
                body="Use a canvas when notebook cells, diagrams, and explanations need relationships instead of one vertical list."
                icon="layout"
                title="Turn notebook work into a visual flow"
              />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <ActionCard
                accent="#7c3aed"
                action={
                  <Button href={appPath("features/teaching")}>
                    Teaching workflows
                  </Button>
                }
                body="Distribute, collect, grade, and support notebook assignments while keeping computation in student projects."
                icon="users"
                title="Teach with notebook assignments"
              />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <ActionCard
                action={
                  <LinkButton href={`${GUIDE_BASE}/cocalc-for-jupyter/`}>
                    Jupyter compatibility guide
                  </LinkButton>
                }
                body="Keep `.ipynb`, JupyterLab, widgets, and standard notebook workflows available beside CoCalc collaboration."
                icon="jupyter"
                title="Check Jupyter compatibility"
              />
            </Col>
          </Row>
        </Flex>
      </PublicSection>
      <Modal
        footer={null}
        onCancel={() => setShowAgentDetails(false)}
        open={showAgentDetails}
        title="How Codex works with live notebooks"
        width={760}
      >
        <Flex vertical gap={18}>
          <Paragraph style={{ fontSize: 16, margin: 0 }}>
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
            <Button href={supportHref}>Ask about Jupyter workflows</Button>
          </Flex>
        </Flex>
      </Modal>
    </Flex>
  );
}
