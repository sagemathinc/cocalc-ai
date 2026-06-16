/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  featureAppPath as appPath,
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
        <Row gutter={[10, 10]}>
          {[
            ["history", "TimeTravel"],
            ["users", "Realtime"],
            ["robot", "Codex"],
            ["terminal", "Terminal"],
          ].map(([icon, label]) => (
            <Col key={label} xs={12} sm={6}>
              <Flex
                align="center"
                gap={8}
                style={{
                  background: "#fff",
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PANEL_RADIUS,
                  padding: "9px 10px",
                }}
              >
                <Icon name={icon as IconName} />
                <Text strong>{label}</Text>
              </Flex>
            </Col>
          ))}
        </Row>
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

function ProjectOrbit() {
  const items = [
    ["jupyter", "Notebook"],
    ["database", "Data"],
    ["terminal", "Terminal"],
    ["tex", "Paper"],
    ["history", "TimeTravel"],
    ["robot", "Codex"],
  ] as const;
  return (
    <div
      style={{
        background:
          "radial-gradient(circle at center, #eef5ff 0%, #ffffff 46%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
        padding: 24,
      }}
    >
      <div
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        }}
      >
        {items.map(([icon, label], index) => (
          <Flex
            align="center"
            gap={10}
            key={label}
            style={{
              background: index === 0 ? COLORS.ANTD_BG_BLUE_L : "#fff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              minHeight: 80,
              padding: 14,
            }}
          >
            <IconBadge
              accent={index === 0 ? "#f37726" : PUBLIC_COLORS.brand}
              icon={icon}
            />
            <Text strong>{label}</Text>
          </Flex>
        ))}
      </div>
    </div>
  );
}

function WhiteboardDiagram() {
  const nodes = [
    { icon: "database" as const, label: "data", x: "8%", y: "18%" },
    { icon: "jupyter" as const, label: "clean", x: "37%", y: "10%" },
    { icon: "jupyter" as const, label: "model", x: "62%", y: "38%" },
    { icon: "slides" as const, label: "explain", x: "28%", y: "65%" },
    { icon: "tex" as const, label: "paper", x: "70%", y: "70%" },
  ];
  return (
    <div
      style={{
        background: "#fbfdff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        minHeight: 320,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <svg
        aria-hidden="true"
        height="100%"
        preserveAspectRatio="none"
        style={{ inset: 0, position: "absolute", width: "100%" }}
        viewBox="0 0 100 100"
      >
        <path
          d="M20 28 C33 18, 38 25, 47 22 C56 24, 60 35, 66 47"
          fill="none"
          stroke="#8bb8ff"
          strokeDasharray="4 4"
          strokeWidth="1.5"
        />
        <path
          d="M48 26 C40 42, 37 55, 38 69"
          fill="none"
          stroke="#8bb8ff"
          strokeDasharray="4 4"
          strokeWidth="1.5"
        />
        <path
          d="M69 51 C78 58, 80 67, 78 76"
          fill="none"
          stroke="#8bb8ff"
          strokeDasharray="4 4"
          strokeWidth="1.5"
        />
      </svg>
      {nodes.map((node) => (
        <Flex
          align="center"
          gap={8}
          key={node.label}
          style={{
            background: "#fff",
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PANEL_RADIUS,
            boxShadow: "0 10px 28px rgba(33, 49, 57, 0.08)",
            left: node.x,
            padding: "10px 12px",
            position: "absolute",
            top: node.y,
          }}
        >
          <Icon name={node.icon} style={{ color: PUBLIC_COLORS.brand }} />
          <Text strong>{node.label}</Text>
        </Flex>
      ))}
    </div>
  );
}

export default function JupyterNotebookFeaturePage({
  helpEmail,
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
    : "Start using Jupyter on CoCalc";

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
                Notebooks that keep running, collaborating, and remembering
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc keeps standard Jupyter notebooks in a project where
                execution, files, collaborators, history, and assistance stay
                together.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Use it when notebooks need to outlive the first experiment:
                research computations, teaching material, shared analysis, or
                reports that depend on surrounding files and tools.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <Button href={`${GUIDE_BASE}/jupyter-notebooks/`}>
                  Read the Jupyter guide
                </Button>
                <LinkButton href={`${GUIDE_BASE}/cocalc-for-jupyter/`}>
                  Compare notebook tools
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <NotebookMock />
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} xl={6}>
          <StoryCard icon="stopwatch" title="Durable execution">
            Start a cell, close your browser, and come back later. The backend
            owns execution and captures output instead of treating the browser
            tab as the source of truth.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#389e0d" icon="users" title="Realtime teamwork">
            Multiple people can edit, discuss, and inspect the same notebook
            session. Collaboration is part of the document, not a screen-share
            workaround.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#7c3aed" icon="history" title="TimeTravel">
            Notebook edits are recorded at high resolution with authorship, so
            you can recover, review, and understand how work evolved.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#d46b08" icon="robot" title="Agent-ready">
            Codex can use CoCalc&apos;s notebook API to inspect cells, run code,
            and reason from live output instead of only reading an `.ipynb` file
            on disk.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <ProjectOrbit />
          </Col>
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Keep the notebook next to the data, shell, paper, and agent
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Many notebooks do not live alone. They depend on data files,
                packages, scripts, figures, papers, discussions, and sometimes a
                long-running computation.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc wraps the notebook in a full project, so the same place
                contains the filesystem, terminals, Linux environment,
                TimeTravel history, collaborators, and Codex chat needed to make
                progress.
              </Paragraph>
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
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                The browser is a view, not the fragile runtime
              </Title>
              <Paragraph style={{ margin: 0 }}>
                In many notebook systems, a browser refresh can feel dangerous
                when a cell is running or output is streaming. CoCalc&apos;s
                model keeps notebook execution and output capture on the
                backend, independent of the visible browser tab.
              </Paragraph>
              <BulletList
                items={[
                  "Long-running cells can continue while you disconnect.",
                  "Output is captured and synchronized when you return.",
                  "Large notebooks render efficiently by focusing work on visible content.",
                  "Standard Jupyter widgets and visualization libraries remain part of the workflow.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <div
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                padding: 24,
              }}
            >
              <Flex vertical gap={14}>
                {[
                  ["Browser closes", "Execution continues"],
                  ["Project restarts", "Output is recoverable"],
                  ["Collaborator joins", "State synchronizes"],
                ].map(([left, right]) => (
                  <div
                    key={left}
                    style={{
                      alignItems: "center",
                      background: PUBLIC_COLORS.surfaceMuted,
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: PANEL_RADIUS,
                      display: "grid",
                      gap: 12,
                      gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                      padding: 14,
                    }}
                  >
                    <Text strong>{left}</Text>
                    <Text style={{ color: PUBLIC_COLORS.mutedText }}>
                      {right}
                    </Text>
                  </div>
                ))}
              </Flex>
            </div>
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Flex vertical gap={12}>
              <IconBadge accent="#7c3aed" icon="history" />
              <Title level={3} style={{ margin: 0 }}>
                TimeTravel is notebook memory
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc records notebook changes as you type, with authorship
                attached. That gives notebooks a practical recovery and review
                story even when the work is exploratory.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                For notebooks, this is designed to keep long-term edit history
                without turning every intermediate output update into noise.
              </Paragraph>
              <LinkButton href={`${GUIDE_BASE}/jupyter-notebooks/`}>
                Learn about TimeTravel
              </LinkButton>
            </Flex>
          </PublicSection>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Flex vertical gap={12}>
              <IconBadge accent="#389e0d" icon="users" />
              <Title level={3} style={{ margin: 0 }}>
                Collaboration includes markdown, widgets, and discussion
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Notebooks are realtime collaborative documents. Multiple people
                can edit code and rich markdown, see current output, and discuss
                the work in nearby chat.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                WYSIWYG markdown editing makes explanatory cells feel like
                writing, while the notebook still follows standard Jupyter
                conventions.
              </Paragraph>
              <LinkButton href={`${GUIDE_BASE}/jupyter-notebooks/`}>
                Jupyter documentation
              </LinkButton>
            </Flex>
          </PublicSection>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <LiveStateDiagram />
          </Col>
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Let the agent work with the notebook you actually have open
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Saving an `.ipynb` file is not the same as understanding the
                live session. CoCalc gives Codex project-scoped notebook
                commands, so it can inspect current cells, start focused runs,
                and reason from actual output.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That changes the practical workflow: ask Codex to debug a cell,
                summarize a result, update a downstream table, or write the next
                analysis step while still keeping the work reviewable.
              </Paragraph>
              <div>
                <Button href={appPath("features/ai")}>AI workflows</Button>
              </div>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Put notebook cells on a whiteboard when the idea is a graph
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Some computational work is not naturally a single vertical list.
                CoCalc whiteboards can include Jupyter cells in a directed graph
                and run them in order, alongside diagrams, notes, and teaching
                sketches.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This is useful for pipelines, dependency diagrams, lecture
                explanations, and explorations where the structure matters as
                much as the individual cells.
              </Paragraph>
              <div>
                <Button href={appPath("features/whiteboard")}>
                  Whiteboard workflows
                </Button>
              </div>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <WhiteboardDiagram />
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Teaching workflows are built around notebooks
            </Title>
            <BulletList
              items={[
                "Distribute notebooks to student projects and collect work back.",
                "Use nbgrader workflows for autograding and manual review.",
                "Keep TAs, instructors, students, assignments, and environments in one system.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              Notebook infrastructure matters most when there are many users and
              many copies of the same assignment. CoCalc&apos;s course tools are
              designed for that setting.
            </Paragraph>
            <div>
              <Button href={appPath("features/teaching")}>
                Teaching workflows
              </Button>
            </div>
          </PublicSection>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Compatible with the Jupyter ecosystem
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc&apos;s notebook UI stays close to standard Jupyter
              conventions and the `.ipynb` format. You can also run standard
              JupyterLab or Jupyter Classic servers from a CoCalc project when
              you need that extension stack.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              Use CoCalc notebooks when collaboration, history, agents, and
              project workflow matter most; drop into classic Jupyter interfaces
              when compatibility is the priority.
            </Paragraph>
            <Flex wrap gap={12}>
              <LinkButton href={`${GUIDE_BASE}/cocalc-for-jupyter/`}>
                Jupyter comparison guide
              </LinkButton>
            </Flex>
          </PublicSection>
        </Col>
      </Row>

      <div style={{ marginBottom: 44 }}>
        <PublicSection>
          <Row gutter={[20, 20]} align="middle">
            <Col xs={24} lg={15}>
              <Title level={3} style={{ margin: 0 }}>
                When notebooks become shared work
              </Title>
              <Paragraph style={{ margin: "8px 0 0" }}>
                Quick notebook tools are excellent for quick notebook tasks.
                CoCalc is for the moment when the notebook needs collaborators,
                an environment, a filesystem, terminals, history, agents,
                courses, or a long-running computation around it.
              </Paragraph>
            </Col>
            <Col xs={24} lg={9}>
              <Flex wrap gap={12} justify="end">
                <Button type="primary" href={primaryCtaHref}>
                  {finalCtaLabel}
                </Button>
                {helpEmail ? (
                  <Button href={`mailto:${helpEmail}`}>Contact support</Button>
                ) : null}
              </Flex>
            </Col>
          </Row>
        </PublicSection>
      </div>
    </Flex>
  );
}
