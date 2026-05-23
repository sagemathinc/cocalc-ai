/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

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
        borderRadius: 16,
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
        borderRadius: 22,
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

function PythonProjectMock() {
  const panels = [
    {
      accent: "#2f6fda",
      body: "analysis.ipynb",
      icon: "jupyter",
      title: "Notebook",
    },
    {
      accent: "#278c83",
      body: "model.py",
      icon: "python",
      title: "Script",
    },
    {
      accent: "#ad6800",
      body: "run.term",
      icon: "terminal",
      title: "Terminal",
    },
    {
      accent: "#7c3aed",
      body: "paper.tex",
      icon: "tex",
      title: "Paper",
    },
  ] satisfies { accent: string; body: string; icon: IconName; title: string }[];

  return (
    <div
      aria-label="Illustration of one CoCalc Python project connecting notebooks, scripts, terminals, papers, and Codex"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#2f6fda" icon="python" />
            <div>
              <Text strong>one Python project</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                same files, runtime, collaborators, and agent context
              </div>
            </div>
          </Flex>
          <Flex gap={8} wrap>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              real Linux
            </Tag>
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              install packages
            </Tag>
          </Flex>
        </Flex>

        <Row gutter={[12, 12]}>
          {panels.map((panel) => (
            <Col key={panel.title} xs={24} sm={12}>
              <div
                style={{
                  background: "#fff",
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 18,
                  height: "100%",
                  padding: 14,
                }}
              >
                <Flex align="center" gap={12}>
                  <IconBadge accent={panel.accent} icon={panel.icon} />
                  <div>
                    <Text strong>{panel.title}</Text>
                    <div style={{ color: PUBLIC_COLORS.mutedText }}>
                      {panel.body}
                    </div>
                  </div>
                </Flex>
              </div>
            </Col>
          ))}
        </Row>

        <div
          style={{
            background: "#0b1522",
            borderRadius: 20,
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
              padding: "10px 14px",
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
            <Text style={{ color: "#dbeafe", marginLeft: 8 }}>terminal</Text>
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
            <Text style={{ color: "#bfdbfe" }}>
              $ uv venv && uv pip install numpy matplotlib
            </Text>
            <Text style={{ color: "#86efac" }}>installed 12 packages</Text>
            <Text style={{ color: "#bfdbfe" }}>$ python model.py</Text>
            <Text style={{ color: "#86efac" }}>
              wrote figures/model-fit.pdf
            </Text>
          </Flex>
        </div>

        <Flex
          align="center"
          gap={12}
          style={{
            background: "#fff",
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: 18,
            padding: 14,
          }}
        >
          <IconBadge accent="#7c3aed" icon="robot" />
          <div>
            <Text strong>Codex sees the surrounding work</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              files, notebooks, terminals, packages, errors, and notes
            </div>
          </div>
        </Flex>
      </Flex>
    </div>
  );
}

function WorkflowStrip() {
  const steps = [
    ["Explore", "Start in a notebook with data, plots, and quick checks."],
    ["Factor", "Move stable code into scripts, modules, and tests."],
    ["Run", "Use terminals for packages, jobs, Git, and automation."],
    ["Publish", "Bring results into LaTeX, markdown, reports, or classes."],
  ];
  return (
    <div
      style={{
        background:
          "linear-gradient(135deg, rgba(16,33,63,0.97), rgba(34,92,116,0.94))",
        borderRadius: 28,
        color: "#fff",
        padding: 34,
      }}
    >
      <Title level={3} style={{ color: "#fff", margin: "0 0 18px" }}>
        From notebook to script to paper
      </Title>
      <Row gutter={[14, 14]}>
        {steps.map(([title, body], index) => (
          <Col key={title} xs={24} md={6}>
            <div
              style={{
                background: "rgba(255,255,255,0.1)",
                border: "1px solid rgba(255,255,255,0.16)",
                borderRadius: 20,
                height: "100%",
                padding: 18,
              }}
            >
              <Flex vertical gap={12}>
                <span
                  style={{
                    alignItems: "center",
                    background: COLORS.ANTD_YELL_M,
                    borderRadius: 999,
                    color: "#10213f",
                    display: "inline-flex",
                    fontWeight: 800,
                    height: 28,
                    justifyContent: "center",
                    width: 28,
                  }}
                >
                  {index + 1}
                </span>
                <Text strong style={{ color: "#fff", fontSize: 16 }}>
                  {title}
                </Text>
                <Paragraph
                  style={{ color: "rgba(255,255,255,0.76)", margin: 0 }}
                >
                  {body}
                </Paragraph>
              </Flex>
            </div>
          </Col>
        ))}
      </Row>
    </div>
  );
}

function EnvironmentDiagram() {
  const layers = [
    {
      body: "Use the normal Python tools people already know.",
      icon: "python",
      title: "pip, uv, conda, venv",
    },
    {
      body: "Install native libraries, compilers, and system packages.",
      icon: "linux",
      title: "Ubuntu with sudo",
    },
    {
      body: "Share exact setup across a class, team, or future project.",
      icon: "history",
      title: "Snapshots and RootFS",
    },
  ] satisfies { body: string; icon: IconName; title: string }[];
  return (
    <div
      style={{
        background:
          "linear-gradient(145deg, #fff 0%, #f6fbff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 26,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
        padding: 24,
      }}
    >
      <Flex vertical gap={14}>
        {layers.map((layer, index) => (
          <Flex
            align="center"
            gap={14}
            key={layer.title}
            style={{
              background: "#fff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 18,
              padding: 16,
            }}
          >
            <span
              style={{
                alignItems: "center",
                background: index === 1 ? COLORS.ANTD_BG_BLUE_L : "#fff8e8",
                borderRadius: 999,
                color: index === 1 ? COLORS.BLUE_D : "#ad6800",
                display: "inline-flex",
                flex: "0 0 auto",
                fontWeight: 800,
                height: 30,
                justifyContent: "center",
                width: 30,
              }}
            >
              {index + 1}
            </span>
            <IconBadge
              accent={
                index === 1 ? "#096dd9" : index === 0 ? "#278c83" : "#ad6800"
              }
              icon={layer.icon}
            />
            <div>
              <Text strong>{layer.title}</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>{layer.body}</div>
            </div>
          </Flex>
        ))}
      </Flex>
    </div>
  );
}

export default function PythonFeaturePage({
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
    : "Start using Python on CoCalc";

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Tag
                color="blue"
                style={{
                  alignSelf: "flex-start",
                  background: COLORS.ANTD_BG_BLUE_L,
                  color: COLORS.BLUE_D,
                }}
              >
                Real collaborative Python
              </Tag>
              <Title level={2} style={{ margin: 0 }}>
                Python that moves from notebook to script to paper.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                CoCalc is not just a browser notebook. It is a real Linux
                project where Python can live in Jupyter notebooks,{" "}
                <code>.py</code> files, terminals, LaTeX workflows, package
                environments, courses, and Codex conversations at the same time.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That matters when exploratory work becomes reusable code, when a
                figure must land in a paper, or when a class needs everyone to
                share the same working Python stack.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={`${GUIDE_BASE}/python-workflow/`}>
                  Python workflow guide
                </LinkButton>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter details
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <PythonProjectMock />
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#2f6fda" icon="jupyter" title="Notebooks">
            Explore interactively in Jupyter with durable backend execution,
            collaboration, TimeTravel, widgets, and agent access to the live
            notebook state.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#278c83" icon="python" title="Scripts and modules">
            Edit <code>.py</code> files, factor notebook code into modules, run
            tests, and keep the source files next to the data and notebooks that
            use them.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#ad6800" icon="terminal" title="Terminals">
            Use a real shell for package installs, virtual environments,
            command-line tools, Git, long-running jobs, and Python REPL work.
          </StoryCard>
        </Col>
      </Row>

      <WorkflowStrip />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Real Python on real Linux
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc Python runs in a full project Linux environment. Use
                system packages, native libraries, virtual environments,
                multiple Python versions, and the same package managers you
                would use on a server or workstation.
              </Paragraph>
              <BulletList
                items={[
                  <>
                    Install Python packages with <code>pip</code>,{" "}
                    <code>uv</code>, <code>conda</code>, or project-specific
                    tools.
                  </>,
                  <>
                    Use <code>sudo apt-get install</code> for native libraries,
                    compilers, and command-line dependencies.
                  </>,
                  "Use snapshots and reusable RootFS images when an environment should be shared or recovered.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <EnvironmentDiagram />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <div
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 26,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                padding: 24,
              }}
            >
              <pre
                style={{
                  background: "#0b1522",
                  borderRadius: 18,
                  color: "#dbeafe",
                  margin: 0,
                  overflowX: "auto",
                  padding: 18,
                }}
              >
                <code>{`uv venv
uv pip install pandas matplotlib pytest
python model.py
pytest

# use the result in a paper or notebook
ls figures/model-fit.pdf`}</code>
              </pre>
            </div>
          </Col>
          <Col xs={24} lg={11}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Codex can help at the environment boundary
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Python errors often cross boundaries: a missing system library,
                a stale virtual environment, a notebook state problem, a test
                failure, or a figure path that does not match the paper. Codex
                can inspect the project files and terminal output together.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Ask it to diagnose an import error, create a virtual
                environment, pin dependencies, move notebook code into a module,
                write tests, or make a setup note that another collaborator can
                follow.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Python for teaching and teams
            </Title>
            <Paragraph style={{ margin: 0 }}>
              In a course or research group, the hard part is rarely "can Python
              run?" The hard part is making sure everyone has the same packages,
              data, notebooks, scripts, and help context.
            </Paragraph>
            <BulletList
              items={[
                "Use RootFS images to give a class or team a known-good Python stack.",
                "Collaborate in the same notebook, script, terminal, and side chat.",
                "Use TimeTravel and snapshots when experiments or assignments go sideways.",
              ]}
            />
            <Button href={appPath("features/teaching")}>
              Teaching workflows
            </Button>
          </PublicSection>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Python belongs in documents too
            </Title>
            <Paragraph style={{ margin: 0 }}>
              A project can contain the notebook that found the result, the
              script that reproduces it, the terminal commands that installed
              dependencies, and the LaTeX or markdown document that explains it.
            </Paragraph>
            <BulletList
              items={[
                "Generate figures and tables where the paper can use them.",
                "Use PythonTeX-style workflows when the project is configured for them.",
                "Keep computation, code review, and writing in one shared workspace.",
              ]}
            />
            <Button href={appPath("features/latex-editor")}>
              LaTeX workflows
            </Button>
          </PublicSection>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={14}>
            <Title level={3} style={{ margin: 0 }}>
              Use Python as part of the whole project
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc is strongest when Python is connected to the rest of the
              technical work: notebooks, scripts, terminals, papers, GitHub,
              classes, long-running jobs, and AI assistance around the same
              project state.
            </Paragraph>
            <Flex wrap gap={12}>
              <Button href={appPath("features/linux")}>
                Linux environment
              </Button>
              <Button href={appPath("features/terminal")}>
                Linux terminal
              </Button>
              {helpEmail ? (
                <Button href={`mailto:${helpEmail}`}>Contact support</Button>
              ) : null}
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <div
              style={{
                background: "#10213f",
                borderRadius: 24,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.12)",
                color: "#fff",
                padding: 26,
              }}
            >
              <Title level={4} style={{ color: "#fff", margin: "0 0 10px" }}>
                Start using CoCalc
              </Title>
              <Paragraph style={{ color: "rgba(255,255,255,0.78)" }}>
                Open a project, start with a notebook or script, and keep the
                Python environment with the rest of your work.
              </Paragraph>
              <Button type="primary" href={primaryCtaHref}>
                {finalCtaLabel}
              </Button>
            </div>
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
