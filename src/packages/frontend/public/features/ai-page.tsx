/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_ELEVATION,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
} from "./page-components";
import { FeatureFinalBand, IconBadge } from "./feature-visuals";
import { FEATURE_ACCENTS } from "./feature-accents";

const { Paragraph, Text, Title } = Typography;

const AI_ACCENT = FEATURE_ACCENTS.ai;
const AI_PAGE_CSS = `
.feature-ai-hero {
  background:
    radial-gradient(circle at 88% 12%, ${alpha(AI_ACCENT, 0.12)}, transparent 34%),
    linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.brandTint} 100%);
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  overflow: hidden;
  padding: clamp(24px, 4vw, 48px);
}

.feature-ai-hero-title.ant-typography {
  font-size: clamp(38px, 5.5vw, 66px);
  letter-spacing: -0.045em;
  line-height: 1.02;
  margin: 0;
  max-width: 10.5ch;
}

.feature-ai-eyebrow {
  color: ${AI_ACCENT};
  font-size: ${PUBLIC_TYPE.eyebrow}px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.feature-ai-proof-grid {
  border-top: 1px solid ${PUBLIC_COLORS.border};
  display: grid;
  gap: 12px 20px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 30px;
  padding-top: 22px;
}

.feature-ai-proof-item {
  align-items: center;
  color: ${PUBLIC_COLORS.heading};
  display: flex;
  font-weight: 600;
  gap: 10px;
  min-width: 0;
}

.feature-ai-project-window {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  overflow: hidden;
}

.feature-ai-project-toolbar {
  align-items: center;
  background: ${PUBLIC_COLORS.surfaceMuted};
  border-bottom: 1px solid ${PUBLIC_COLORS.border};
  display: flex;
  gap: 12px;
  justify-content: space-between;
  min-height: 46px;
  padding: 10px 14px;
}

.feature-ai-window-dots {
  display: flex;
  gap: 6px;
}

.feature-ai-window-dot {
  background: ${PUBLIC_COLORS.border};
  border-radius: 50%;
  display: block;
  height: 8px;
  width: 8px;
}

.feature-ai-project-body {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  min-height: 380px;
}

.feature-ai-file-rail {
  background: ${PUBLIC_COLORS.surfaceMuted};
  border-right: 1px solid ${PUBLIC_COLORS.border};
  padding: 16px 12px;
}

.feature-ai-file-row {
  border-radius: ${PUBLIC_RADIUS.panel}px;
  color: ${PUBLIC_COLORS.mutedText};
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  overflow: hidden;
  padding: 8px 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feature-ai-file-row-active {
  background: ${alpha(AI_ACCENT, 0.09)};
  color: ${PUBLIC_COLORS.heading};
  font-weight: 600;
}

.feature-ai-thread {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
}

.feature-ai-thread-message {
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  padding: 13px 14px;
}

.feature-ai-thread-message-agent {
  background: ${PUBLIC_COLORS.infoTint};
  border-color: ${PUBLIC_COLORS.infoBorder};
}

.feature-ai-result-card {
  background: ${PUBLIC_COLORS.surfaceMuted};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  margin-top: auto;
  padding: 14px;
}

.feature-ai-result-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 12px;
}

.feature-ai-result-item {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  color: ${PUBLIC_COLORS.heading};
  font-size: 12px;
  font-weight: 600;
  padding: 9px;
  text-align: center;
}

.feature-ai-section-intro {
  max-width: 760px;
}

.feature-ai-workflow-panel {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.panel};
  padding: clamp(22px, 3vw, 34px);
}

.feature-ai-step {
  background: ${PUBLIC_COLORS.surfaceMuted};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  height: 100%;
  padding: 18px;
}

.feature-ai-step-number {
  align-items: center;
  background: ${PUBLIC_COLORS.heading};
  border-radius: 50%;
  color: ${PUBLIC_COLORS.surface};
  display: inline-flex;
  font-size: 13px;
  font-weight: 700;
  height: 30px;
  justify-content: center;
  width: 30px;
}

.feature-ai-story-card {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.card};
  height: 100%;
  padding: 22px;
}

.feature-ai-interface-shell {
  background: ${PUBLIC_COLORS.heading};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  color: ${PUBLIC_COLORS.surface};
  overflow: hidden;
  padding: clamp(24px, 4vw, 42px);
}

.feature-ai-interface-shell .ant-typography,
.feature-ai-interface-shell .ant-typography strong {
  color: ${PUBLIC_COLORS.surface};
}

.feature-ai-interface-card {
  background: ${alpha(PUBLIC_COLORS.surface, 0.09)};
  border: 1px solid ${alpha(PUBLIC_COLORS.surface, 0.2)};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  height: 100%;
  padding: 22px;
}

.feature-ai-interface-card .ant-btn-default {
  background: transparent;
  border-color: ${alpha(PUBLIC_COLORS.surface, 0.45)};
  color: ${PUBLIC_COLORS.surface};
}

.feature-ai-compute-panel {
  background: linear-gradient(120deg, ${PUBLIC_COLORS.brandTint}, ${PUBLIC_COLORS.surface});
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  overflow: hidden;
  padding: clamp(24px, 4vw, 40px);
}

.feature-ai-compute-route {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  height: 100%;
  padding: 18px;
}

.feature-ai-operating-card {
  border-left: 2px solid ${alpha(AI_ACCENT, 0.4)};
  height: 100%;
  padding: 4px 4px 4px 18px;
}

.feature-ai-related-link-label-separated::before {
  color: ${PUBLIC_COLORS.border};
  content: "|";
  margin-right: 12px;
}

@media (max-width: 900px) {
  .feature-ai-proof-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .feature-ai-hero {
    padding: 22px;
  }

  .feature-ai-hero-title.ant-typography {
    font-size: 38px;
  }

  .feature-ai-hero .ant-btn,
  .feature-ai-compute-panel .ant-btn,
  .feature-ai-interface-card .ant-btn {
    width: 100%;
  }

  .feature-ai-proof-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .feature-ai-project-body {
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
  }

  .feature-ai-file-rail {
    display: none;
  }

  .feature-ai-result-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .feature-ai-related-link-label-separated::before {
    content: "";
    margin-right: 0;
  }
}
`;

const PROOF_ITEMS = [
  { icon: "server", label: "Persistent Linux projects" },
  { icon: "jupyter", label: "Notebooks, files, and terminals" },
  { icon: "users", label: "Real-time collaboration" },
  { icon: "layout", label: "Paths to larger compute" },
] satisfies { icon: IconName; label: string }[];

const WORKFLOW_STEPS = [
  {
    body: "Open the workspace that already contains the files, environment, and collaborators.",
    title: "Start with the project",
  },
  {
    body: "Name the result and point to the notebook, file, error, image, or service that matters.",
    title: "Describe the outcome",
  },
  {
    body: "Follow the conversation and inspect the files, commands, live notebook state, and test output.",
    title: "Watch and inspect",
  },
  {
    body: "Review the result, keep it with the project, and continue with an agent or collaborator.",
    title: "Review and continue",
  },
] as const;

const USE_CASES = [
  {
    body: "Trace a notebook failure, work with the live kernel, and leave the checked result beside the code and data.",
    icon: "jupyter",
    title: "Research and data",
  },
  {
    body: "Edit code, run commands and tests, and keep logs and changes visible in the same Linux project.",
    icon: "terminal",
    title: "Software and automation",
  },
  {
    body: "Bring collaborators into the same files, conversations, terminals, notebooks, and supported file history.",
    icon: "users",
    title: "Teams and teaching",
  },
] satisfies { body: string; icon: IconName; title: string }[];

function ProjectWorkspaceMock() {
  return (
    <figure style={{ margin: 0 }}>
      <div
        aria-label="Synthetic illustration of agent work inside a CoCalc project"
        className="feature-ai-project-window"
        role="img"
      >
        <div className="feature-ai-project-toolbar">
          <Flex align="center" gap={10}>
            <span aria-hidden="true" className="feature-ai-window-dots">
              <span className="feature-ai-window-dot" />
              <span className="feature-ai-window-dot" />
              <span className="feature-ai-window-dot" />
            </span>
            <Text strong>Synthetic research project</Text>
          </Flex>
          <Text style={{ color: PUBLIC_COLORS.success }} strong>
            Result ready
          </Text>
        </div>
        <div className="feature-ai-project-body">
          <aside aria-hidden="true" className="feature-ai-file-rail">
            <Text strong style={{ fontSize: 12 }}>
              PROJECT FILES
            </Text>
            <div
              className="feature-ai-file-row feature-ai-file-row-active"
              style={{ marginTop: 10 }}
            >
              analysis.ipynb
            </div>
            <div className="feature-ai-file-row">pipeline.py</div>
            <div className="feature-ai-file-row">data/sample.csv</div>
            <div className="feature-ai-file-row">results/review.md</div>
          </aside>
          <div className="feature-ai-thread">
            <div className="feature-ai-thread-message">
              <Text strong>You</Text>
              <Paragraph style={{ margin: "5px 0 0" }}>
                Reproduce the notebook, fix the failed data check, and save a
                short review note with the result.
              </Paragraph>
            </div>
            <div className="feature-ai-thread-message feature-ai-thread-message-agent">
              <Flex align="start" gap={10}>
                <IconBadge accent={AI_ACCENT} icon="robot" size="sm" />
                <div>
                  <Text strong>Codex</Text>
                  <Paragraph style={{ margin: "5px 0 0" }}>
                    I repaired the synthetic input path, reran the notebook, and
                    saved the review in results/review.md.
                  </Paragraph>
                </div>
              </Flex>
            </div>
            <div className="feature-ai-result-card">
              <Flex align="center" justify="space-between" gap={10} wrap>
                <Text strong>Project result</Text>
                <Text style={{ color: PUBLIC_COLORS.success }} strong>
                  3 checks complete
                </Text>
              </Flex>
              <div className="feature-ai-result-grid">
                <div className="feature-ai-result-item">Notebook executed</div>
                <div className="feature-ai-result-item">Output checked</div>
                <div className="feature-ai-result-item">Review note saved</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <figcaption
        style={{
          color: PUBLIC_COLORS.mutedText,
          fontSize: 12,
          marginTop: 8,
          textAlign: "right",
        }}
      >
        Constructed product illustration with synthetic names and data.
      </figcaption>
    </figure>
  );
}

function ProofStrip() {
  return (
    <div
      aria-label="CoCalc project capabilities"
      className="feature-ai-proof-grid"
    >
      {PROOF_ITEMS.map(({ icon, label }) => (
        <div className="feature-ai-proof-item" key={label}>
          <IconBadge accent={AI_ACCENT} icon={icon} size="sm" />
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function WorkflowSection() {
  return (
    <PublicSection>
      <section
        aria-labelledby="feature-ai-workflow-title"
        className="feature-ai-workflow-panel"
        id="how-agent-work-flows"
      >
        <Flex vertical gap={24}>
          <div className="feature-ai-section-intro">
            <Text className="feature-ai-eyebrow" strong>
              Direct, inspect, and continue agent work
            </Text>
            <Title
              id="feature-ai-workflow-title"
              level={2}
              style={{ margin: "8px 0 0" }}
            >
              From request to review, the context stays together.
            </Title>
          </div>
          <Row gutter={[14, 14]}>
            {WORKFLOW_STEPS.map((step, index) => (
              <Col key={step.title} xs={24} md={12} xl={6}>
                <div className="feature-ai-step">
                  <Flex vertical gap={12}>
                    <span className="feature-ai-step-number">{index + 1}</span>
                    <Title level={4} style={{ margin: 0 }}>
                      {step.title}
                    </Title>
                    <Paragraph style={{ margin: 0 }}>{step.body}</Paragraph>
                  </Flex>
                </div>
              </Col>
            ))}
          </Row>
        </Flex>
      </section>
    </PublicSection>
  );
}

function UseCaseSection() {
  return (
    <PublicSection>
      <section aria-labelledby="feature-ai-use-cases-title">
        <Flex vertical gap={22}>
          <div className="feature-ai-section-intro">
            <Text className="feature-ai-eyebrow" strong>
              Work that becomes a durable result
            </Text>
            <Title
              id="feature-ai-use-cases-title"
              level={2}
              style={{ margin: "8px 0 0" }}
            >
              One workspace for more than a coding session.
            </Title>
            <Paragraph
              style={{ fontSize: PUBLIC_TYPE.lead, margin: "12px 0 0" }}
            >
              CoCalc brings computation, documents, applications, collaboration,
              and agent work into the same project.
            </Paragraph>
          </div>
          <Row gutter={[18, 18]}>
            {USE_CASES.map(({ body, icon, title }) => (
              <Col key={title} xs={24} md={8}>
                <article className="feature-ai-story-card">
                  <Flex vertical gap={14}>
                    <IconBadge accent={AI_ACCENT} icon={icon} />
                    <Title level={3} style={{ margin: 0 }}>
                      {title}
                    </Title>
                    <Paragraph style={{ margin: 0 }}>{body}</Paragraph>
                  </Flex>
                </article>
              </Col>
            ))}
          </Row>
        </Flex>
      </section>
    </PublicSection>
  );
}

function InterfaceSection({ showCodexDocs }: { showCodexDocs: boolean }) {
  return (
    <PublicSection>
      <section
        aria-labelledby="feature-ai-interface-title"
        className="feature-ai-interface-shell"
      >
        <Flex vertical gap={24}>
          <div className="feature-ai-section-intro">
            <Text className="feature-ai-eyebrow" strong>
              Two current ways to work
            </Text>
            <Title
              id="feature-ai-interface-title"
              level={2}
              style={{ margin: "8px 0 0" }}
            >
              Use the agent interface that fits the task.
            </Title>
            <Paragraph
              style={{ fontSize: PUBLIC_TYPE.lead, margin: "12px 0 0" }}
            >
              The project remains the shared context while each interface keeps
              its own credentials, controls, and capabilities.
            </Paragraph>
          </div>
          <Row gutter={[18, 18]}>
            <Col xs={24} md={12}>
              <article className="feature-ai-interface-card">
                <Flex vertical gap={14}>
                  <IconBadge accent={AI_ACCENT} icon="comments" />
                  <Title level={3} style={{ margin: 0 }}>
                    Integrated Codex chat
                  </Title>
                  <Paragraph style={{ margin: 0 }}>
                    Work with project files, terminals, commands, and live
                    notebook state through CoCalc's project chat.
                  </Paragraph>
                  {showCodexDocs ? (
                    <Button href={appPath("docs/ai/codex-chat")}>
                      Read the Codex guide
                    </Button>
                  ) : null}
                </Flex>
              </article>
            </Col>
            <Col xs={24} md={12}>
              <article className="feature-ai-interface-card">
                <Flex vertical gap={14}>
                  <IconBadge accent={AI_ACCENT} icon="terminal" />
                  <Title level={3} style={{ margin: 0 }}>
                    Terminal-based agents
                  </Title>
                  <Paragraph style={{ margin: 0 }}>
                    Install and run Claude Code, OpenCode, and other compatible
                    command-line agents as ordinary Linux tools in a project
                    terminal.
                  </Paragraph>
                  <Button href={appPath("features/terminal")}>
                    Explore terminal workflows
                  </Button>
                </Flex>
              </article>
            </Col>
          </Row>
        </Flex>
      </section>
    </PublicSection>
  );
}

function ComputeSection({
  showResearchCompute,
}: {
  showResearchCompute: boolean;
}) {
  return (
    <PublicSection>
      <section
        aria-labelledby="feature-ai-compute-title"
        className="feature-ai-compute-panel"
      >
        <Row align="middle" gutter={[28, 28]}>
          <Col xs={24} lg={12}>
            <Flex vertical gap={14}>
              <Text className="feature-ai-eyebrow" strong>
                Serious work needs a compute path
              </Text>
              <Title
                id="feature-ai-compute-title"
                level={2}
                style={{ margin: 0 }}
              >
                Keep the project while the compute changes.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Run project files, notebooks, terminals, and services on a
                suitable project host, or connect a notebook to an existing
                machine over SSH with a remote kernel. Availability depends on
                the deployment and account.
              </Paragraph>
              <Flex gap={12} wrap>
                {showResearchCompute ? (
                  <Button
                    type="primary"
                    href={appPath("features/research-compute")}
                  >
                    Plan research compute
                  </Button>
                ) : null}
                <Button href={appPath("features/software-environment")}>
                  Review software environments
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <Row gutter={[12, 12]}>
              <Col xs={24} sm={12}>
                <div className="feature-ai-compute-route">
                  <Flex vertical gap={12}>
                    <IconBadge accent={AI_ACCENT} icon="server" />
                    <Title level={4} style={{ margin: 0 }}>
                      Project hosts
                    </Title>
                    <Paragraph style={{ margin: 0 }}>
                      Choose CPU, RAM, GPU, storage, and access that fit the
                      workload and available host catalog.
                    </Paragraph>
                  </Flex>
                </div>
              </Col>
              <Col xs={24} sm={12}>
                <div className="feature-ai-compute-route">
                  <Flex vertical gap={12}>
                    <IconBadge accent={AI_ACCENT} icon="exchange" />
                    <Title level={4} style={{ margin: 0 }}>
                      Remote kernels
                    </Title>
                    <Paragraph style={{ margin: 0 }}>
                      Keep the notebook in CoCalc while code runs near existing
                      software or data on another machine.
                    </Paragraph>
                  </Flex>
                </div>
              </Col>
            </Row>
          </Col>
        </Row>
      </section>
    </PublicSection>
  );
}

function OperatingModelSection() {
  const models = [
    {
      body: "Managed hosted projects for individuals and teams.",
      title: "Hosted CoCalc.ai",
    },
    {
      body: "Local one-user and shared single-VM paths you operate.",
      title: "CoCalc Plus or Star",
    },
    {
      body: "Customer-operated private deployment paths for teams and institutions.",
      title: "Launchpad or Rocket",
    },
  ] as const;

  return (
    <PublicSection>
      <section aria-labelledby="feature-ai-operating-title">
        <Row gutter={[28, 24]}>
          <Col xs={24} lg={9}>
            <Text className="feature-ai-eyebrow" strong>
              A path from trial to deployment
            </Text>
            <Title
              id="feature-ai-operating-title"
              level={2}
              style={{ margin: "8px 0 0" }}
            >
              Choose who runs the workspace.
            </Title>
            <Paragraph style={{ margin: "12px 0 18px" }}>
              Start with the operating model, then evaluate the product path,
              collaboration features, support, and infrastructure it includes.
            </Paragraph>
            <Button href={appPath("products")}>
              Compare ways to run CoCalc
            </Button>
          </Col>
          <Col xs={24} lg={15}>
            <Row gutter={[16, 20]}>
              {models.map(({ body, title }) => (
                <Col key={title} xs={24} md={8}>
                  <article className="feature-ai-operating-card">
                    <Title level={4} style={{ margin: 0 }}>
                      {title}
                    </Title>
                    <Paragraph style={{ margin: "8px 0 0" }}>{body}</Paragraph>
                  </article>
                </Col>
              ))}
            </Row>
          </Col>
        </Row>
      </section>
    </PublicSection>
  );
}

export default function AIFeaturePage({
  helpEmail,
  isAuthenticated,
  product,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
  product?: string;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : featureSignUpPath("codex");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const showCodexDocs = product !== "plus";
  const showResearchCompute = product !== "plus";

  return (
    <>
      <style>{AI_PAGE_CSS}</style>
      <Flex vertical gap={42}>
        <PublicSection>
          <section
            aria-labelledby="feature-ai-hero-title"
            className="feature-ai-hero"
          >
            <Row
              className="feature-ai-hero-row"
              gutter={[36, 34]}
              align="middle"
            >
              <Col xs={24} lg={11}>
                <Flex vertical gap={18}>
                  <Text className="feature-ai-eyebrow" strong>
                    AI agents in persistent projects
                  </Text>
                  <Title
                    className="feature-ai-hero-title"
                    id="feature-ai-hero-title"
                    level={2}
                  >
                    Run AI agents where files, notebooks, compute, and teams
                    stay together.
                  </Title>
                  <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                    Use integrated Codex or terminal-based agents beside the
                    same project files, live notebooks, Linux terminals,
                    applications, and collaborators. Inspect the work as it
                    happens, keep the result, and continue from the same
                    context.
                  </Paragraph>
                  <Flex wrap gap={12}>
                    <Button size="large" type="primary" href={primaryHref}>
                      {primaryLabel}
                    </Button>
                    <Button size="large" href="#how-agent-work-flows">
                      See how it works
                    </Button>
                  </Flex>
                </Flex>
              </Col>
              <Col xs={24} lg={13}>
                <ProjectWorkspaceMock />
              </Col>
            </Row>
            <ProofStrip />
          </section>
        </PublicSection>

        <WorkflowSection />
        <UseCaseSection />
        <InterfaceSection showCodexDocs={showCodexDocs} />
        <ComputeSection showResearchCompute={showResearchCompute} />
        <OperatingModelSection />

        <PublicSection>
          <FeatureFinalBand
            action={{
              body: "Open a project when agent work should remain with the files, environment, and people who will review it.",
              href: primaryHref,
              label: primaryLabel,
              title: "Start with a persistent project",
            }}
            relatedLinks={[
              ...(showCodexDocs
                ? [
                    {
                      href: appPath("docs/ai/codex-chat"),
                      label: "Codex guide",
                    },
                  ]
                : []),
              ...(showResearchCompute
                ? [
                    {
                      href: appPath("features/research-compute"),
                      label: (
                        <span className="feature-ai-related-link-label-separated">
                          Research compute
                        </span>
                      ),
                    },
                  ]
                : []),
              {
                href: appPath("features/compare"),
                label: (
                  <span className="feature-ai-related-link-label-separated">
                    Compare with agent sandboxes
                  </span>
                ),
              },
              {
                href: appPath("products"),
                label: (
                  <span className="feature-ai-related-link-label-separated">
                    Deployment paths
                  </span>
                ),
              },
              ...(helpEmail
                ? [{ href: `mailto:${helpEmail}`, label: "Contact support" }]
                : []),
            ]}
            title="Where CoCalc earns its place"
          >
            <BulletList
              items={[
                "The work depends on files, notebooks, terminals, applications, compute, and people staying together.",
                "People need to inspect agent changes and results before continuing.",
                "The project should remain useful after one conversation ends.",
                "Review Codex activity and diffs in its project thread; use TimeTravel for supported collaborative file history.",
              ]}
            />
          </FeatureFinalBand>
        </PublicSection>
      </Flex>
    </>
  );
}
