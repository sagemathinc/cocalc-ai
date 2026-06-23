/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_DARK,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
  PUBLIC_WEIGHT,
} from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  featureAppPath as appPath,
  featureSupportPath,
} from "./page-components";
import { IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const CLI_DOCS_PATH = appPath("docs/cli/use-cocalc-cli");
const CLI_ACCENT = COLORS.GRAY_D;

const CLI_WORKFLOW_LINES = [
  { kind: "command", text: "$ cocalc browser files --project-id PROJECT_ID" },
  { kind: "output", text: "open files:" },
  { kind: "output", text: "  analysis.ipynb" },
  { kind: "output", text: "  notes/review.md" },
  { kind: "spacer", text: "" },
  {
    kind: "command",
    text: "$ cocalc project jupyter exec --path analysis.ipynb --stdin",
  },
  { kind: "output", text: "run_id: report-refresh" },
  { kind: "output", text: "status: finished" },
  { kind: "output", text: "output: figures/summary.png" },
] as const;

function HeroPoint({ children }: { children: ReactNode }) {
  return (
    <Flex align="center" gap={8}>
      <Icon
        name="check"
        style={{
          color: CLI_ACCENT,
          flex: "0 0 auto",
          fontSize: 14,
        }}
      />
      <Text strong>{children}</Text>
    </Flex>
  );
}

function CliHeroWorkflow() {
  return (
    <div
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={14}>
        <Flex align="center" gap={10} wrap>
          <IconBadge accent={CLI_ACCENT} icon="terminal" />
          <div>
            <Text strong>CoCalc CLI</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              project commands for notebook and browser checks
            </div>
          </div>
        </Flex>
        <div
          aria-label="CoCalc CLI project workflow example"
          role="img"
          style={{
            background: PUBLIC_DARK.terminalSurface,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PUBLIC_RADIUS.panel,
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.08)",
            color: PUBLIC_DARK.mockText,
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
            fontSize: 14,
            lineHeight: 1.6,
            overflow: "hidden",
          }}
        >
          <Flex
            align="center"
            gap={8}
            style={{
              background: "rgba(255, 255, 255, 0.06)",
              borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
              color: PUBLIC_DARK.mockTextDim,
              padding: "10px 14px",
            }}
          >
            <Icon name="terminal" style={{ fontSize: 14 }} />
            <span>reviewable notebook workflow</span>
          </Flex>
          <div style={{ padding: "16px 18px" }}>
            {CLI_WORKFLOW_LINES.map((line, index) =>
              line.kind === "spacer" ? (
                <div key={index} aria-hidden="true" style={{ height: 8 }} />
              ) : (
                <div
                  key={`${line.kind}-${line.text}`}
                  style={{
                    color:
                      line.kind === "command"
                        ? PUBLIC_DARK.dotAmber
                        : PUBLIC_DARK.mockText,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {line.text}
                </div>
              ),
            )}
          </div>
        </div>
      </Flex>
    </div>
  );
}

function CliFitSection() {
  const signals = [
    {
      body: "List open files, tabs, and notebook state before an automated step changes anything.",
      step: "Step 1",
      title: "Read project context",
    },
    {
      body: "Execute notebook or browser checks through the CLI instead of UI scripting.",
      step: "Step 2",
      title: "Run notebook and browser checks",
    },
    {
      body: "Leave run IDs, files, and generated outputs where collaborators can inspect them.",
      step: "Step 3",
      title: "Return reviewable output",
    },
  ];

  return (
    <PublicSection>
      <Flex vertical gap={16}>
        <Flex vertical gap={8} style={{ maxWidth: 780 }}>
          <Title level={3} style={{ margin: 0 }}>
            Keep automated work attached to the project.
          </Title>
          <Paragraph style={{ margin: 0 }}>
            When a script or shell-capable agent needs project context, the CLI
            gives it one documented command path. Results stay in CoCalc
            alongside the notebooks, files, and terminal evidence people need to
            review.
          </Paragraph>
        </Flex>
        <Row className="cocalc-cli-workflow-flow" gutter={[16, 16]}>
          {signals.map(({ body, step, title }) => (
            <Col key={title} xs={24} md={8}>
              <Flex
                vertical
                gap={8}
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderLeft: `3px solid ${CLI_ACCENT}`,
                  borderRadius: PUBLIC_RADIUS.panel,
                  height: "100%",
                  padding: "16px 18px",
                }}
              >
                <Text
                  style={{
                    color: CLI_ACCENT,
                    fontSize: 12,
                    fontWeight: PUBLIC_WEIGHT.bold,
                    letterSpacing: 0,
                    textTransform: "uppercase",
                  }}
                >
                  {step}
                </Text>
                <Text strong>{title}</Text>
                <Paragraph
                  style={{
                    color: PUBLIC_COLORS.mutedText,
                    margin: "2px 0 0",
                  }}
                >
                  {body}
                </Paragraph>
              </Flex>
            </Col>
          ))}
        </Row>
      </Flex>
    </PublicSection>
  );
}

function CliSurfaceChoice({
  body,
  href,
  icon,
  label,
  title,
}: {
  body: ReactNode;
  href: string;
  icon: IconName;
  label: string;
  title: string;
}) {
  return (
    <Col xs={24} md={8}>
      <Flex
        vertical
        gap={12}
        style={{
          background: PUBLIC_COLORS.surface,
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: PUBLIC_RADIUS.panel,
          height: "100%",
          padding: 18,
        }}
      >
        <Flex align="center" gap={10}>
          <IconBadge accent={CLI_ACCENT} icon={icon} size="sm" />
          <Text strong>{title}</Text>
        </Flex>
        <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
          {body}
        </Paragraph>
        <Button href={href} style={{ alignSelf: "flex-start" }}>
          {label}
        </Button>
      </Flex>
    </Col>
  );
}

export default function CliFeaturePage({}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const supportHref = featureSupportPath({
    body: "I want to discuss using the CoCalc CLI for project-aware automation. Helpful context: what should run, whether it starts from a project, browser session, notebook, or external script, and who needs to review the result.",
    context: "cli",
    subject: "CoCalc CLI automation",
    title: "Ask CoCalc about CLI automation",
  });

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Run project work from the command line.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Use the CoCalc CLI when scripts or shell-capable agents need
                project-aware notebook, browser, and file checks.
              </Paragraph>
              <Flex vertical gap={8}>
                <HeroPoint>
                  Call it from scripts or agents that can run shell commands.
                </HeroPoint>
                <HeroPoint>
                  Work against a specific CoCalc project, not a detached local
                  copy.
                </HeroPoint>
                <HeroPoint>
                  Leave outputs where collaborators can review them.
                </HeroPoint>
              </Flex>
              <Flex wrap gap={12}>
                <Button type="primary" href={CLI_DOCS_PATH}>
                  CLI Docs
                </Button>
                <Button href={appPath("features/automations")}>
                  Project automations
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <CliHeroWorkflow />
          </Col>
        </Row>
      </PublicSection>

      <CliFitSection />

      <PublicSection>
        <Flex vertical gap={16}>
          <Flex vertical gap={8} style={{ maxWidth: 780 }}>
            <Title level={3} style={{ margin: 0 }}>
              Choose the right connection surface.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Use the CLI for explicit project commands, automations for
              repeatable runs, and the API for product integrations.
            </Paragraph>
          </Flex>
          <Row gutter={[16, 16]}>
            <CliSurfaceChoice
              body="For people, scripts, or shell-capable agents that need an explicit project command."
              href={CLI_DOCS_PATH}
              icon="terminal"
              label="CLI Docs"
              title="CLI"
            />
            <CliSurfaceChoice
              body="For notebooks, scripts, or reports that should run on a schedule or project event."
              href={appPath("features/automations")}
              icon="sync"
              label="Project automations"
              title="Automations"
            />
            <CliSurfaceChoice
              body="For services that need a programmatic integration with CoCalc."
              href={appPath("features/api")}
              icon="code"
              label="HTTP API"
              title="API"
            />
          </Row>
          <Flex wrap gap={12}>
            <Button href={appPath("features/terminal")}>
              Terminal workflows
            </Button>
            <Button href={supportHref}>Ask about CLI automation</Button>
          </Flex>
        </Flex>
      </PublicSection>
    </Flex>
  );
}
