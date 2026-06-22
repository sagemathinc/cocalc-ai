/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
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
import { ContextList, FeatureFinalBand, IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

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
      aria-label="Illustration of one CoCalc Python project connecting notebooks, scripts, terminals, papers, and review context"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
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
                same files, runtime, collaborators, and review context
              </div>
            </div>
          </Flex>
        </Flex>

        <Row gutter={[12, 12]}>
          {panels.map((panel) => (
            <Col key={panel.title} xs={24} sm={12}>
              <div
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PUBLIC_RADIUS.panel,
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
      </Flex>
    </div>
  );
}

function WorkflowNode({
  accent,
  body,
  icon,
  label,
  title,
}: {
  accent: string;
  body: string;
  icon: IconName;
  label: string;
  title: string;
}) {
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.code,
        height: "100%",
        padding: 18,
      }}
    >
      <Flex vertical gap={12}>
        <Flex align="center" justify="space-between" gap={12}>
          <IconBadge accent={accent} icon={icon} />
          <Text
            strong
            style={{
              color: PUBLIC_COLORS.heading,
              fontSize: PUBLIC_TYPE.caption,
            }}
          >
            {label}
          </Text>
        </Flex>
        <div>
          <Title level={3} style={{ margin: "0 0 6px" }}>
            {title}
          </Title>
          <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
            {body}
          </Paragraph>
        </div>
      </Flex>
    </div>
  );
}

function PythonWorkflowMap() {
  const top = [
    {
      accent: "#2f6fda",
      body: "Explore data, plots, widgets, and rough ideas in the live notebook.",
      icon: "jupyter",
      label: "analysis.ipynb",
      title: "Notebook",
    },
    {
      accent: "#278c83",
      body: "Move stable code into modules, scripts, tests, and reusable functions.",
      icon: "python",
      label: "model.py",
      title: "Script",
    },
    {
      accent: "#ad6800",
      body: "Use generated figures, tables, and checked results in writing.",
      icon: "tex",
      label: "paper.tex",
      title: "Paper",
    },
  ] satisfies {
    accent: string;
    body: string;
    icon: IconName;
    label: string;
    title: string;
  }[];

  return (
    <PublicSection>
      <Flex vertical gap={22}>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                The right interface at each stage
              </Title>
              <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
                A live notebook, a versioned module, and a rendered paper each
                use the interface that fits, while reading and writing the same
                files, packages, and results in one project.
              </Paragraph>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <ContextList
              accent="#2f6fda"
              items={[
                { icon: "jupyter", label: "Explore in notebooks" },
                { icon: "python", label: "Promote stable code to scripts" },
                { icon: "terminal", label: "Install packages in the project" },
                {
                  icon: "tex",
                  label: "Use generated figures in papers",
                },
                {
                  icon: "history",
                  label: "Review with shared files and history",
                },
              ]}
              title="Project context"
            />
          </Col>
        </Row>

        <div
          style={{
            background:
              "linear-gradient(145deg, #ffffff 0%, #f5fbff 58%, #fff8e8 100%)",
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PUBLIC_RADIUS.panel,
            boxShadow: PUBLIC_ELEVATION.panel,
            padding: 22,
          }}
        >
          <Flex vertical gap={16}>
            <Row gutter={[14, 14]} align="stretch">
              {top.map((node) => (
                <Col key={node.title} xs={24} lg={8}>
                  <Flex align="center" gap={12} style={{ height: "100%" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <WorkflowNode {...node} />
                    </div>
                  </Flex>
                </Col>
              ))}
            </Row>
          </Flex>
        </div>
      </Flex>
    </PublicSection>
  );
}

function CompactUseCard({
  accent,
  body,
  icon,
  title,
}: {
  accent: string;
  body: ReactNode;
  icon: IconName;
  title: string;
}) {
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        height: "100%",
        padding: 20,
      }}
    >
      <Flex vertical gap={12}>
        <IconBadge accent={accent} icon={icon} />
        <Title level={3} style={{ margin: 0 }}>
          {title}
        </Title>
        <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
          {body}
        </Paragraph>
      </Flex>
    </div>
  );
}

function PythonUseCases() {
  return (
    <PublicSection>
      <Flex vertical gap={18}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Where this workflow pays off
          </Title>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.mutedText,
              margin: "8px 0 0",
              maxWidth: "72ch",
            }}
          >
            The same project stays exploratory, reproducible, and publishable —
            without copying work between disconnected tools.
          </Paragraph>
        </div>
        <Row gutter={[14, 14]}>
          <Col xs={24} lg={8}>
            <CompactUseCard
              accent="#ad6800"
              icon="tex"
              title="Reproducible analysis and papers"
              body="Develop the analysis in a notebook, then drop the generated figure straight into a LaTeX or markdown write-up in the same workspace."
            />
          </Col>
          <Col xs={24} lg={8}>
            <CompactUseCard
              accent="#2f6fda"
              icon="terminal"
              title="Package-heavy work"
              body={
                <>
                  Use <code>sudo</code>, <code>apt</code>, <code>uv</code>, and{" "}
                  <code>pip</code> in a virtual environment, right where the
                  code runs.
                </>
              }
            />
          </Col>
          <Col xs={24} lg={8}>
            <CompactUseCard
              accent="#389e0d"
              icon="graduation-cap"
              title="Teams and teaching"
              body="Shared notebooks, visible cursors, side chat, and TimeTravel let a team or a class work from the same Python stack."
            />
          </Col>
        </Row>
      </Flex>
    </PublicSection>
  );
}
export default function PythonFeaturePage({
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
    : "Start using Python";

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Python that moves from notebook to script to paper.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                One runtime, packages, and collaborators stay shared from first
                cell to final figure.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={`${GUIDE_BASE}/python-workflow/`}>
                  Python workflow guide
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <PythonProjectMock />
          </Col>
        </Row>
      </PublicSection>

      <PythonWorkflowMap />

      <PythonUseCases />

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project, start with a notebook or script, and keep the Python environment with the rest of your work.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Start using Python",
          }}
          relatedLinks={[
            { href: appPath("features/linux"), label: "Linux environment" },
            {
              href: appPath("features/terminal"),
              label: "Terminal workflows",
            },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="Run the same Python project where you need it"
        >
          <BulletList
            items={[
              "Start hosted on CoCalc.ai or run the same project in a setup your team operates.",
              "Keep notebooks, scripts, packages, generated figures, and write-ups in one project.",
              "Move from exploratory notebooks to reusable modules without copying the work elsewhere.",
              "Use the same project context for collaborators, review, and follow-up work.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
