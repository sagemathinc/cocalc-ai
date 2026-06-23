/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import {
  BulletList,
  CodeBlock,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";
import {
  ContextList,
  FeatureFinalBand,
  IconBadge,
  StoryCard,
} from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  border: 0,
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  height: 1,
  overflow: "hidden",
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
};

const FIT_BUTTON_STYLE: CSSProperties = { width: "fit-content" };
const LEAD_STYLE: CSSProperties = {
  fontSize: PUBLIC_TYPE.lead,
  margin: 0,
};
const MUTED_TEXT_STYLE: CSSProperties = { color: PUBLIC_COLORS.mutedText };
const NO_MARGIN_STYLE: CSSProperties = { margin: 0 };

const FIT_DECISION_ROWS = [
  ["Hosted paper collaboration", "Dedicated LaTeX editor"],
  ["Local editor craft", "Local TeX editor"],
  ["Paper as technical project", "CoCalc"],
] as const;

function LatexEvidencePanel() {
  return (
    <div
      aria-label="Illustration of a CoCalc LaTeX project with source, PDF preview, and build log"
      role="img"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 58%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex aria-hidden="true" vertical gap={16}>
        <Flex align="center" gap={10}>
          <IconBadge accent="#ad6800" icon="tex" />
          <div>
            <Text strong>paper.tex</Text>
            <div style={MUTED_TEXT_STYLE}>
              source, PDF, figures, and build log
            </div>
          </div>
        </Flex>
        <Row gutter={[14, 14]} align="stretch">
          <Col xs={24} md={13}>
            <CodeBlock
              ariaLabel="LaTeX source with generated table input"
              code={`\\section{Spectral gap}
The experiment in Figure~\\ref{fig:gap}
shows concentration after normalization.

\\input{tables/summary.tex}`}
            />
          </Col>
          <Col xs={24} md={11}>
            <div
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                height: "100%",
                padding: 16,
              }}
            >
              <Flex vertical gap={12}>
                <Text strong>paper.pdf</Text>
                <Paragraph style={NO_MARGIN_STYLE}>
                  The normalized operator has a stable gap across the sampled
                  family...
                </Paragraph>
                <Text type="success">Build log ready</Text>
              </Flex>
            </div>
          </Col>
        </Row>
      </Flex>
    </div>
  );
}

function LatexFitTable() {
  return (
    <table
      aria-describedby="cocalc-latex-fit-table-caption"
      aria-label="LaTeX environment fit decisions"
      style={{
        borderCollapse: "separate",
        borderSpacing: "0 10px",
        width: "100%",
      }}
    >
      <caption
        id="cocalc-latex-fit-table-caption"
        style={VISUALLY_HIDDEN_STYLE}
      >
        Each row compares a writing task with the environment that best fits it.
      </caption>
      <thead>
        <tr>
          <th scope="col" style={VISUALLY_HIDDEN_STYLE}>
            Writing task
          </th>
          <th scope="col" style={VISUALLY_HIDDEN_STYLE}>
            Best fit
          </th>
        </tr>
      </thead>
      <tbody>
        {FIT_DECISION_ROWS.map(([task, fit]) => {
          const isCocalc = fit === "CoCalc";
          const background = isCocalc
            ? PUBLIC_COLORS.surfaceMuted
            : PUBLIC_COLORS.surface;
          const cellStyle: CSSProperties = {
            background,
            borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
            borderTop: `1px solid ${PUBLIC_COLORS.border}`,
            padding: 12,
            textAlign: "left",
          };

          return (
            <tr key={task}>
              <th
                scope="row"
                style={{
                  ...cellStyle,
                  borderLeft: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: `${PUBLIC_RADIUS.panel}px 0 0 ${PUBLIC_RADIUS.panel}px`,
                  fontWeight: 400,
                }}
              >
                <Text>{task}</Text>
              </th>
              <td
                style={{
                  ...cellStyle,
                  borderLeft: 0,
                  borderRadius: `0 ${PUBLIC_RADIUS.panel}px ${PUBLIC_RADIUS.panel}px 0`,
                  borderRight: `1px solid ${PUBLIC_COLORS.border}`,
                }}
              >
                <Text strong>{fit}</Text>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="top">
          <Col xs={24} lg={14}>
            <Flex vertical gap={14}>
              <Title level={2} style={NO_MARGIN_STYLE}>
                Write the paper where the code, figures, and review live
              </Title>
              <Paragraph style={LEAD_STYLE}>
                Coauthors edit in real time, with builds and full history in one
                project.
              </Paragraph>
              <Paragraph style={NO_MARGIN_STYLE}>
                The evidence behind every claim stays with the paper,
                reproducible later.
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
          <Col xs={24} lg={10}>
            <ContextList
              accent="#ad6800"
              items={[
                { icon: "file-code", label: "Source and PDF output together" },
                { icon: "users", label: "Visible cursors for coauthors" },
                { icon: "history", label: "TimeTravel for draft recovery" },
                { icon: "sagemath", label: "SageTeX and computed figures" },
              ]}
              title="Paper context"
            />
          </Col>
        </Row>
      </PublicSection>

      <Row className="cocalc-latex-story-row" gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <StoryCard icon="users" title="Edit with coauthors live">
            Write in the same project with visible cursors, discussion, source
            files, figures, bibliography, and build output close enough to
            review.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent="#ad6800"
            icon="file-pdf"
            title="Build the PDF beside evidence"
          >
            Keep generated tables, figures, notebooks, scripts, and terminal
            output next to the source that cites them.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent="#7c3aed"
            icon="history"
            title="Review draft history"
          >
            TimeTravel keeps edits reviewable, so a collaborator can inspect
            what changed before continuing the paper.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <LatexEvidencePanel />
          </Col>
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={NO_MARGIN_STYLE}>
                Keep the working tree together
              </Title>
              <Paragraph style={NO_MARGIN_STYLE}>
                A mathematical or scientific paper usually has more structure
                than the final PDF shows: <code>.tex</code> files, bibliography
                entries, figures, scripts, notebooks, generated tables, and
                discussions.
              </Paragraph>
              <Paragraph style={NO_MARGIN_STYLE}>
                CoCalc makes that working tree collaborative. Coauthors can
                edit, discuss, and review those assets without splitting the
                paper workflow across separate tools.
              </Paragraph>
              <ContextList
                accent="#ad6800"
                items={[
                  {
                    icon: "file",
                    label: "source, bibliography, figures, and build logs",
                  },
                  {
                    icon: "jupyter",
                    label: "notebooks, scripts, terminals, and package state",
                  },
                  {
                    icon: "comment",
                    label: "review notes, chat, and collaborator context",
                  },
                ]}
                title="What stays with the paper"
              />
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={NO_MARGIN_STYLE}>
                Use computation as part of the writing process
              </Title>
              <Paragraph style={NO_MARGIN_STYLE}>
                CoCalc is a strong fit when figures or tables come from code.
                Regenerate evidence in a notebook, script, or SageTeX step,
                rebuild the PDF, and check the result while the draft is still
                open.
              </Paragraph>
              <Button href={appPath("features/ai")} style={FIT_BUTTON_STYLE}>
                AI assistance
              </Button>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <div className="cocalc-latex-computation-list">
              <ContextList
                accent="#278c83"
                items={[
                  {
                    icon: "refresh",
                    label: "Regenerate a table, figure, or result",
                  },
                  {
                    icon: "file-pdf",
                    label: "Rebuild the PDF beside its evidence",
                  },
                  {
                    icon: "users",
                    label: "Review the claim, source, and computation together",
                  },
                ]}
                title="A practical writing loop"
              />
            </div>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={NO_MARGIN_STYLE}>
                Choose the writing environment around the real task
              </Title>
              <Paragraph style={NO_MARGIN_STYLE}>
                Dedicated hosted LaTeX editors are a natural choice when the
                main task is collaborative paper editing. Local TeX editors are
                excellent when keyboard-driven local craft is the priority.
              </Paragraph>
              <Paragraph style={NO_MARGIN_STYLE}>
                CoCalc is useful when the paper depends on computation, project
                files, command-line tools, collaborators, history, and agent
                help.
              </Paragraph>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <LatexFitTable />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project, create a .tex file, and keep the paper beside the work that supports it.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Ready to write LaTeX in CoCalc?",
          }}
          relatedLinks={[
            {
              href: `${GUIDE_BASE}/cocalc-for-latex/`,
              label: "LaTeX guide",
            },
            {
              href: `${GUIDE_BASE}/paper-polishing/`,
              label: "Paper polishing workflow",
            },
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            { href: appPath("features/terminal"), label: "Terminal workflows" },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="Where LaTeX belongs in the project"
        >
          <BulletList
            items={[
              "This workflow fits papers that depend on code, generated figures, notebooks, terminals, and review history.",
              "Use SageTeX when computation belongs directly in the LaTeX build.",
              "Keep coauthors, source, PDF output, project files, and TimeTravel in one workspace.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
