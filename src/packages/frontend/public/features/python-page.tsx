/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS, PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import {
  featureAppPath as appPath,
  featureSupportPath,
  LinkButton,
} from "./page-components";
import { IconBadge } from "./feature-visuals";

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
      aria-label="Illustration of one CoCalc Python project connecting notebooks, scripts, terminals, papers, and Codex"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
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
        </Flex>

        <Row gutter={[12, 12]}>
          {panels.map((panel) => (
            <Col key={panel.title} xs={24} sm={12}>
              <div
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 8,
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
            borderRadius: 8,
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
            <Text style={{ color: "#86efac" }}>installed packages</Text>
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
            background: PUBLIC_COLORS.surface,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: 8,
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
        borderRadius: 8,
        boxShadow: "0 12px 34px rgba(33, 49, 57, 0.07)",
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
        <Flex align="end" justify="space-between" wrap gap={16}>
          <div>
            <Title level={3} style={{ margin: 0 }}>
              The right interface at each stage
            </Title>
          </div>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.mutedText,
              margin: 0,
              maxWidth: 520,
            }}
          >
            A live notebook, a versioned module, and a rendered paper each use
            the interface that fits, while reading and writing the same files,
            packages, and results in one project.
          </Paragraph>
        </Flex>

        <div
          style={{
            background:
              "linear-gradient(145deg, #ffffff 0%, #f5fbff 58%, #fff8e8 100%)",
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: 8,
            boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
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
        borderRadius: 8,
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
            The same project can be exploratory, reproducible, teachable, and
            publishable without copying work between disconnected tools.
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
              title="Teaching and teams"
              body="Shared notebooks, side chat, and TimeTravel let a class or team work from the same Python stack."
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
    : "Start using Python on CoCalc";
  const supportHref = featureSupportPath({
    body: "I want to discuss Python workflows in CoCalc. Helpful context: notebooks, scripts, package environments, reports, teaching or research use case, expected collaborators, and whether hosted or customer-operated CoCalc matters.",
    context: "python",
    subject: "CoCalc Python workflows",
    title: "Ask CoCalc about Python workflows",
  });

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
                Explore data in a notebook, harden the stable parts into scripts
                and tests, and publish the figures in a paper — using Python in
                Jupyter, <code>.py</code> files, and terminals that share one
                runtime, packages, and collaborators.
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
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={14}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Run the same Python project where you need it
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Start hosted on CoCalc.ai, or run the same project in a setup
                your team operates — same notebooks, scripts, and Python
                environment either way.
              </Paragraph>
              <Button href={appPath("products")}>
                Compare operating models
              </Button>
              <Flex wrap gap={16}>
                <LinkButton href={appPath("features/linux")}>
                  Linux environment
                </LinkButton>
                <LinkButton href={appPath("features/terminal")}>
                  Linux terminal
                </LinkButton>
                <LinkButton href={supportHref}>
                  Ask about Python workflows
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <div
              className="cocalc-feature-final-panel"
              style={{
                background: PUBLIC_COLORS.surfaceMuted,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 8,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.12)",
                color: PUBLIC_COLORS.heading,
                padding: 26,
              }}
            >
              <Title
                level={3}
                style={{ color: PUBLIC_COLORS.heading, margin: "0 0 10px" }}
              >
                Start using Python
              </Title>
              <Paragraph style={{ color: PUBLIC_COLORS.mutedText }}>
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
