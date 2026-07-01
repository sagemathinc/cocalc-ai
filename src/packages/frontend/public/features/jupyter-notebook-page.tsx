/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { CodeBlock } from "@cocalc/frontend/public/common";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";
import {
  ContextList,
  FeatureFinalBand,
  IconBadge,
  StoryCard,
  TerminalMock,
} from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

function NotebookEvidencePanel() {
  return (
    <div
      aria-label="Illustration of a CoCalc Jupyter notebook beside project files"
      role="img"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 58%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
        width: "100%",
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" gap={10}>
          <IconBadge accent="#f37726" icon="jupyter" />
          <div>
            <Text strong>analysis.ipynb</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              notebook, data, packages, scripts, and outputs stay together
            </div>
          </div>
        </Flex>
        <TerminalMock
          title="CoCalc notebook"
          rows={[
            "[1] df = load_experiment('spectral-gap')",
            "data loaded",
            "[2] plot_gap_distribution(df)",
            "interactive widget + figure",
            "[3] fit = model(df); fit.summary()",
            "model summary ready",
          ]}
        />
      </Flex>
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
    : "Start using Jupyter in CoCalc";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="top">
          <Col xs={24} lg={14}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Jupyter notebooks for work that needs to keep going
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Keep live notebooks reviewable while collaborators and Codex
                inspect real session state.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={`${GUIDE_BASE}/jupyter-notebooks/`}>
                  Read the Jupyter guide
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ContextList
              accent="#f37726"
              items={[
                { icon: "server", label: "Kernel sessions stay inspectable" },
                { icon: "database", label: "Cell commands target real output" },
              ]}
              title="Notebook context"
            />
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
        <Row
          align="stretch"
          className="cocalc-jupyter-evidence-row"
          gutter={[24, 24]}
        >
          <Col xs={24} lg={12} style={{ display: "flex" }}>
            <NotebookEvidencePanel />
          </Col>
          <Col xs={24} lg={12} style={{ display: "flex" }}>
            <div
              className="cocalc-jupyter-balance-panel"
              style={{
                alignItems: "center",
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                boxShadow: PUBLIC_ELEVATION.media,
                display: "flex",
                height: "100%",
                minHeight: 240,
                padding: 24,
                width: "100%",
              }}
            >
              <Flex vertical gap={12}>
                <Title level={3} style={{ margin: 0 }}>
                  When the notebook depends on more than cells
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Notebooks are often the visible part of a larger analysis.
                  CoCalc keeps terminal and Linux tools, collaborators, and
                  review history close enough to understand what produced a
                  result.
                </Paragraph>
              </Flex>
            </div>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Let people and Codex inspect live notebook state
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Saving an <code>.ipynb</code> file is not the same as
                understanding the current session. CoCalc gives Codex
                project-scoped notebook commands, so focused runs can start from
                actual cells, outputs, and errors, then summarize real output
                instead of guessing from a saved file.
              </Paragraph>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <CodeBlock
              ariaLabel="Project-scoped Jupyter commands"
              code={`cocalc project jupyter cells --path analysis.ipynb
cocalc project jupyter run --path analysis.ipynb --cell-index 3
cocalc project jupyter exec --path analysis.ipynb --stdin`}
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a hosted notebook on CoCalc.ai and bring your team into the same workspace.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Ready to use Jupyter in CoCalc?",
          }}
          relatedLinks={[
            {
              href: `${GUIDE_BASE}/cocalc-for-jupyter/`,
              label: "Compatibility guide",
            },
            { href: appPath("features/terminal"), label: "Terminal workflows" },
            { href: appPath("features/linux"), label: "Linux environment" },
            { href: appPath("features/whiteboard"), label: "Whiteboards" },
            { href: appPath("products"), label: "Compare operating models" },
            ...(helpEmail
              ? [{ href: `mailto:${helpEmail}`, label: "Contact support" }]
              : []),
          ]}
          title="Choose the notebook path that fits"
        >
          <BulletList
            items={[
              "Use CoCalc.ai when notebooks need hosted kernels, terminals, and review history.",
              "Use teaching workflows when notebooks become assignments in student projects.",
              "Use whiteboards when notebook cells need a directed graph beside diagrams or explanations.",
              "Compare operating models when procurement, licensing, or deployment control matters.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
