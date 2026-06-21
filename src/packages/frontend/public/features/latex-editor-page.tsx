/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_COLORS,
  PUBLIC_DARK,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
  LinkButton,
} from "./page-components";
import { IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

function LatexEditorMock() {
  return (
    <div
      aria-label="Illustration of a CoCalc LaTeX editor with source, PDF preview, build log, and project files"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={14}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#ad6800" icon="tex" />
            <div>
              <Text strong>paper.tex</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                source, PDF, figures, and build log
              </div>
            </div>
          </Flex>
        </Flex>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={12}>
            <div
              style={{
                background: PUBLIC_DARK.codeSurface,
                borderRadius: PUBLIC_RADIUS.panel,
                color: PUBLIC_DARK.mockText,
                minHeight: 280,
                padding: 16,
              }}
            >
              <Flex vertical gap={12}>
                <Text style={{ color: "#93c5fd" }}>paper.tex</Text>
                <code style={{ color: "#f8fafc", whiteSpace: "pre-wrap" }}>
                  {`\\section{Spectral gap}
The experiment in Figure~\\ref{fig:gap}
shows concentration after normalization.

\\input{tables/summary.tex}`}
                </code>
                <div
                  style={{
                    background: "rgba(255,255,255,0.1)",
                    borderRadius: 12,
                    color: "#bbf7d0",
                    padding: "9px 10px",
                  }}
                >
                  Build log ready
                </div>
              </Flex>
            </div>
          </Col>
          <Col xs={24} md={12}>
            <div
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                minHeight: 280,
                padding: 18,
              }}
            >
              <Flex vertical gap={14}>
                <Flex align="center" gap={10}>
                  <Icon name="file-pdf" style={{ color: "#d4380d" }} />
                  <Text strong>paper.pdf</Text>
                </Flex>
                <div
                  style={{
                    background: "#f8fafc",
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PUBLIC_RADIUS.panel,
                    minHeight: 180,
                    padding: 16,
                  }}
                >
                  <Title level={5} style={{ margin: "0 0 10px" }}>
                    Spectral gap
                  </Title>
                  <Paragraph style={{ margin: 0 }}>
                    The normalized operator has a stable gap across the sampled
                    family...
                  </Paragraph>
                  <div
                    style={{
                      background: `linear-gradient(90deg, ${PUBLIC_DARK.mockText} 0%, #bbf7d0 100%)`,
                      borderRadius: 999,
                      height: 12,
                      marginTop: 22,
                      width: "78%",
                    }}
                  />
                </div>
              </Flex>
            </div>
          </Col>
        </Row>
        <Row gutter={[10, 10]}>
          {[
            ["users", "Coauthors"],
            ["history", "TimeTravel"],
            ["robot", "Codex"],
            ["jupyter", "Notebook output"],
          ].map(([icon, label]) => (
            <Col key={label} xs={12} sm={6}>
              <Flex
                align="center"
                gap={8}
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PUBLIC_RADIUS.panel,
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

function PaperProjectContext() {
  return (
    <div
      aria-label="Project context that stays with a LaTeX paper in CoCalc"
      style={{
        borderLeft: `3px solid ${PUBLIC_COLORS.brandSubtle}`,
        paddingLeft: 18,
      }}
    >
      <Flex vertical gap={10}>
        <Text strong>What stays with the paper</Text>
        <BulletList
          items={[
            "source, bibliography, generated tables, and figures",
            "notebooks, scripts, terminals, and package state",
            "review notes, project history, chat, and collaborator context",
          ]}
        />
      </Flex>
    </div>
  );
}

function ComputationWritingLoop() {
  return (
    <div
      className="cocalc-latex-computation-list"
      style={{
        borderLeft: `3px solid ${PUBLIC_COLORS.brandSubtle}`,
        paddingLeft: 18,
      }}
    >
      <Flex vertical gap={10}>
        <Text strong>A practical writing loop</Text>
        <BulletList
          items={[
            "Regenerate a table, figure, or result in the same project.",
            "Rebuild the PDF without separating the paper from its evidence.",
            "Let collaborators review the claim, source, and computation together.",
          ]}
        />
      </Flex>
    </div>
  );
}

export default function LatexEditorFeaturePage({
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
    : "Start writing LaTeX on CoCalc";

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Write the paper where the code, figures, and review live
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                CoCalc gives you the expected online LaTeX workflow: source, PDF
                preview, builds, collaboration, and history. It pays off most
                when the paper depends on code, figures, and collaborators who
                need to see how a result was produced.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Keep the draft, bibliography, figures, notebooks, terminal
                commands, AI review thread, TimeTravel history, and
                collaborators in one durable project.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={`${GUIDE_BASE}/cocalc-for-latex/`}>
                  Read the LaTeX guide
                </LinkButton>
                <LinkButton href={`${GUIDE_BASE}/paper-polishing/`}>
                  Paper polishing workflow
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <LatexEditorMock />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[28, 28]} align="top">
          <Col xs={24} lg={15}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Keep the working tree together
              </Title>
              <Paragraph style={{ margin: 0 }}>
                A mathematical or scientific paper usually has more structure
                than the final PDF shows: `.tex` files, bibliography entries,
                figures, scripts, notebooks, generated tables, and discussions.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc makes that whole working tree collaborative. The LaTeX
                editor is one part of a project that also contains terminals,
                Jupyter, Python, Sage, R, chat, TimeTravel, and Codex.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
                <Button href={appPath("features/terminal")}>
                  Terminal workflows
                </Button>
                <Button href={appPath("features/ai")}>AI workflows</Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={9}>
            <PaperProjectContext />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={14}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Use computation as part of the writing process
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc is a strong fit when figures or tables come from code.
                Regenerate evidence in a notebook or script, rebuild the PDF,
                and keep the source of the result close to the paragraph that
                cites it.
              </Paragraph>
              <Button
                href={appPath("features/ai")}
                style={{ width: "fit-content" }}
              >
                AI assistance
              </Button>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ComputationWritingLoop />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Choose the writing environment around the real task
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Dedicated hosted LaTeX editors are a natural choice when the
                main task is collaborative paper editing. Local TeX editors are
                excellent when keyboard-driven local craft is the priority.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc is useful when the paper depends on computation, project
                files, command-line tools, collaborators, history, and agent
                help.
              </Paragraph>
              <LinkButton href={`${GUIDE_BASE}/cocalc-for-latex/`}>
                Read the LaTeX guide
              </LinkButton>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {finalCtaLabel}
                </Button>
                <Button
                  href={featureSupportPath({
                    body: "I want to discuss LaTeX workflows in CoCalc. Helpful context: paper, course, or research-group use case; need for computation-backed figures or tables; collaborators; and current writing tools.",
                    context: "latex-editor",
                    subject: "CoCalc LaTeX workflows",
                    title: "Ask CoCalc about LaTeX workflows",
                  })}
                >
                  Ask about LaTeX workflows
                </Button>
                <Button href={appPath("products")}>
                  Compare operating models
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <div
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                padding: 24,
              }}
            >
              <Flex vertical gap={12}>
                {[
                  ["Hosted paper collaboration", "Dedicated LaTeX editor"],
                  ["Local editor craft", "Local TeX editor"],
                  ["Paper as technical project", "CoCalc"],
                ].map(([task, fit]) => (
                  <div
                    key={task}
                    style={{
                      background:
                        fit === "CoCalc"
                          ? PUBLIC_COLORS.surfaceMuted
                          : PUBLIC_COLORS.surface,
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: PUBLIC_RADIUS.panel,
                      display: "grid",
                      gap: 10,
                      gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                      padding: 12,
                    }}
                  >
                    <Text>{task}</Text>
                    <Text strong>{fit}</Text>
                  </div>
                ))}
              </Flex>
            </div>
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
