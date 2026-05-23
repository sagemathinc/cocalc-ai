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

function LatexEditorMock() {
  return (
    <div
      aria-label="Illustration of a CoCalc LaTeX editor with source, PDF preview, build log, and project files"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
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
          <Flex gap={8} wrap>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              compiled
            </Tag>
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              shared
            </Tag>
          </Flex>
        </Flex>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={12}>
            <div
              style={{
                background: "#10213f",
                borderRadius: 18,
                color: "#dbeafe",
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
                  Build: 0 errors, 2 warnings
                </div>
              </Flex>
            </div>
          </Col>
          <Col xs={24} md={12}>
            <div
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 18,
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
                    borderRadius: 14,
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
                      background:
                        "linear-gradient(90deg, #dbeafe 0%, #bbf7d0 100%)",
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
            ["jupyter", "Evidence"],
          ].map(([icon, label]) => (
            <Col key={label} xs={12} sm={6}>
              <Flex
                align="center"
                gap={8}
                style={{
                  background: "#fff",
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 14,
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

function PaperProjectDiagram() {
  const items = [
    ["tex", "paper.tex", "#ad6800"],
    ["file-pdf", "PDF build", "#d4380d"],
    ["database", "figures", PUBLIC_COLORS.brand],
    ["jupyter", "notebooks", "#f37726"],
    ["terminal", "scripts", PUBLIC_COLORS.brand],
    ["robot", "Codex", "#7c3aed"],
    ["history", "TimeTravel", "#7c3aed"],
    ["users", "coauthors", "#389e0d"],
  ] as const;
  return (
    <div
      style={{
        background:
          "radial-gradient(circle at center, #eef5ff 0%, #ffffff 48%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
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
        {items.map(([icon, label, accent], index) => (
          <Flex
            align="center"
            gap={10}
            key={label}
            style={{
              background: index === 0 ? "#fff7e6" : "#fff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 18,
              minHeight: 74,
              padding: 14,
            }}
          >
            <IconBadge accent={accent} icon={icon} />
            <Text strong>{label}</Text>
          </Flex>
        ))}
      </div>
    </div>
  );
}

function ReviewLoopDiagram() {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 26,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
        padding: 24,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" gap={12}>
          <IconBadge accent="#7c3aed" icon="robot" />
          <div>
            <Text strong>Review the paper, then build it</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              A good agent loop is narrow, testable, and reviewable.
            </div>
          </div>
        </Flex>
        <pre
          style={{
            background: "#10213f",
            borderRadius: 18,
            color: "#dbeafe",
            margin: 0,
            overflowX: "auto",
            padding: 18,
          }}
        >
          <code>{`Read paper.tex and find narrative breaks.
Do not rewrite yet.

Then build the PDF and triage warnings.`}</code>
        </pre>
        <Row gutter={[10, 10]}>
          {["structure review", "narrow patch", "PDF rebuild"].map((label) => (
            <Col key={label} xs={24} sm={8}>
              <Tag
                color="purple"
                style={{
                  borderRadius: 999,
                  marginInlineEnd: 0,
                  padding: "4px 10px",
                  width: "100%",
                }}
              >
                {label}
              </Tag>
            </Col>
          ))}
        </Row>
      </Flex>
    </div>
  );
}

function EvidenceFlowDiagram() {
  const nodes = [
    { icon: "jupyter" as const, label: "notebook", x: "7%", y: "22%" },
    { icon: "terminal" as const, label: "script", x: "33%", y: "10%" },
    { icon: "database" as const, label: "figure", x: "58%", y: "36%" },
    { icon: "tex" as const, label: "paper.tex", x: "28%", y: "66%" },
    { icon: "file-pdf" as const, label: "PDF", x: "72%", y: "68%" },
  ];
  return (
    <div
      style={{
        background: "#fbfdff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 26,
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
          d="M20 31 C36 16, 45 22, 50 18 C56 22, 60 34, 66 45"
          fill="none"
          stroke="#8bb8ff"
          strokeDasharray="4 4"
          strokeWidth="1.5"
        />
        <path
          d="M63 48 C54 62, 47 71, 42 75"
          fill="none"
          stroke="#8bb8ff"
          strokeDasharray="4 4"
          strokeWidth="1.5"
        />
        <path
          d="M48 78 C60 79, 72 79, 80 76"
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
            borderRadius: 16,
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

export default function LatexEditorFeaturePage({
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
    : "Start writing LaTeX on CoCalc";

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Tag
                color="orange"
                style={{
                  alignSelf: "flex-start",
                  background: "#fff7e6",
                  color: "#ad6800",
                  marginInlineEnd: 0,
                }}
              >
                LaTeX inside a technical project
              </Tag>
              <Title level={2} style={{ margin: 0 }}>
                Write the paper where the code, figures, and review live
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc gives you the expected online LaTeX workflow: source, PDF
                preview, builds, collaboration, and history. Its real advantage
                appears when the paper is more than `paper.tex`.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Keep the draft, bibliography, figures, notebooks, terminal
                commands, Codex review thread, TimeTravel history, and
                collaborators in one durable project.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <Button href={`${GUIDE_BASE}/cocalc-for-latex/`}>
                  Read the LaTeX guide
                </Button>
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

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#ad6800" icon="tex" title="Source and PDF">
            Edit LaTeX with synchronized preview, automatic builds, and
            build-output feedback close to the source.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#389e0d" icon="users" title="Coauthor live">
            Collaborators can edit the same files, discuss the draft, inspect
            the PDF, and work with the same project state.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#7c3aed" icon="history" title="TimeTravel">
            Fine-grained history helps recover paragraphs, inspect revisions,
            and understand how a technical document changed.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#d4380d" icon="robot" title="Codex nearby">
            Ask Codex to review structure, patch a paragraph, inspect build
            warnings, or connect notebook output to the paper.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <PaperProjectDiagram />
          </Col>
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Tag
                color="blue"
                style={{
                  alignSelf: "flex-start",
                  background: COLORS.ANTD_BG_BLUE_L,
                  color: COLORS.BLUE_D,
                  marginInlineEnd: 0,
                }}
              >
                When the paper becomes a project
              </Tag>
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
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
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
              <BulletList
                items={[
                  "Use Jupyter, Python, Sage, R, or shell scripts beside the paper.",
                  "Keep generated tables and figures in the same project.",
                  "Let collaborators inspect both the claim and the computation behind it.",
                  "Use project history and Git review to keep changes reviewable.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <EvidenceFlowDiagram />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <ReviewLoopDiagram />
          </Col>
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Tag
                color="purple"
                style={{ alignSelf: "flex-start", marginInlineEnd: 0 }}
              >
                Codex and review
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Use Codex as an editor and build assistant, not an author
              </Title>
              <Paragraph style={{ margin: 0 }}>
                For technical writing, the useful workflow is often narrow:
                review the structure, identify missing definitions, patch a
                specific paragraph, rebuild the PDF, and explain the remaining
                warnings.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This keeps the author in control while making the mechanical
                parts of polishing a paper much less tedious.
              </Paragraph>
              <Button href={appPath("features/ai")}>AI assistance</Button>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Flex vertical gap={12}>
              <IconBadge accent="#7c3aed" icon="history" />
              <Title level={3} style={{ margin: 0 }}>
                TimeTravel and backups make drafts less fragile
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Technical documents change slowly over weeks or months, often
                with several people involved. CoCalc records edit history so you
                can recover deleted text, inspect changes, and understand how a
                draft evolved.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Project backups and snapshots add another recovery layer around
                the files and generated outputs.
              </Paragraph>
              <LinkButton href="https://doc.cocalc.com/time-travel.html">
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
                Collaboration includes the surrounding files
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Coauthoring is not just editing the same `.tex` buffer. The PDF,
                figures, bibliography, terminal logs, notebooks, and chat all
                live in the same shared workspace.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That is useful for research groups, student feedback, and papers
                where the final document depends on a larger technical process.
              </Paragraph>
              <LinkButton href="https://doc.cocalc.com/latex.html">
                LaTeX documentation
              </LinkButton>
            </Flex>
          </PublicSection>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Tag
                color="blue"
                style={{ alignSelf: "flex-start", marginInlineEnd: 0 }}
              >
                Where CoCalc fits
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Choose the writing environment around the real task
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Overleaf is a natural choice when the main task is hosted
                collaborative paper editing. Local TeX editors are excellent
                when keyboard-driven local craft is the priority.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc becomes more interesting when the paper depends on
                computation, project files, command-line tools, collaborators,
                history, and agent help.
              </Paragraph>
              <LinkButton href={`${GUIDE_BASE}/cocalc-for-latex/`}>
                Read the comparison guide
              </LinkButton>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <div
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 26,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                padding: 24,
              }}
            >
              <Flex vertical gap={12}>
                {[
                  ["Hosted paper collaboration", "Overleaf"],
                  ["Local editor craft", "TeXstudio, TeXShop, VimTeX"],
                  ["Paper as technical project", "CoCalc"],
                ].map(([task, fit]) => (
                  <Flex align="center" gap={12} key={task} wrap>
                    <Tag style={{ marginInlineEnd: 0, minWidth: 210 }}>
                      {task}
                    </Tag>
                    <Icon
                      name="arrow-right"
                      style={{ color: PUBLIC_COLORS.brand }}
                    />
                    <Tag
                      color={fit === "CoCalc" ? "blue" : undefined}
                      style={{ marginInlineEnd: 0 }}
                    >
                      {fit}
                    </Tag>
                  </Flex>
                ))}
              </Flex>
            </div>
          </Col>
        </Row>
      </PublicSection>

      <div style={{ marginBottom: 44 }}>
        <PublicSection>
          <Row gutter={[20, 20]} align="middle">
            <Col xs={24} lg={15}>
              <Title level={3} style={{ margin: 0 }}>
                Choose CoCalc when the paper is part of a larger computation
              </Title>
              <Paragraph style={{ margin: "8px 0 0" }}>
                If your LaTeX project needs notebooks, data, figures, terminal
                commands, collaboration, TimeTravel, or Codex nearby, CoCalc
                keeps those pieces in one durable workspace.
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
