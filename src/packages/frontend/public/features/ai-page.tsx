/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS, PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
  LinkButton,
} from "./page-components";
import { IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

function ThreadMock() {
  const messages = [
    {
      accent: "#2f6fda",
      body: "The test failure is in the notebook export. Please inspect the repo, patch the conversion step, and run the focused test.",
      icon: "user",
      label: "human",
    },
    {
      accent: "#7c3aed",
      body: "I found the outdated path handling, updated the file, and I am running the package test now.",
      icon: "robot",
      label: "codex",
    },
    {
      accent: "#278c83",
      body: "The same thread keeps the patch, test output, screenshots, and review notes together.",
      icon: "history",
      label: "durable thread",
    },
  ] satisfies {
    accent: string;
    body: string;
    icon: IconName;
    label: string;
  }[];

  return (
    <div
      aria-label="Illustration of a CoCalc agent thread connected to files, notebooks, and terminals"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f7f4ff 52%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#7c3aed" icon="robot" />
            <div>
              <Text strong>Agent thread</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                chat, files, notebooks, terminals, and collaborators
              </div>
            </div>
          </Flex>
        </Flex>

        <Flex vertical gap={12}>
          {messages.map((message) => (
            <div
              key={message.label}
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 8,
                padding: 14,
              }}
            >
              <Flex align="start" gap={12}>
                <IconBadge accent={message.accent} icon={message.icon} />
                <div>
                  <Text strong style={{ color: message.accent }}>
                    {message.label}
                  </Text>
                  <Paragraph style={{ margin: "4px 0 0" }}>
                    {message.body}
                  </Paragraph>
                </div>
              </Flex>
            </div>
          ))}
        </Flex>
      </Flex>
    </div>
  );
}

function ProjectContextList() {
  const items = [
    ["file", "Files and synced documents"],
    ["jupyter", "Live notebooks"],
    ["terminal", "Persistent terminals"],
    ["history", "Durable agent thread"],
  ] satisfies [IconName, string][];

  return (
    <div
      aria-label="Project context available to CoCalc agents"
      style={{
        borderLeft: `3px solid ${PUBLIC_COLORS.brand}`,
        paddingLeft: 18,
      }}
    >
      <Flex vertical gap={12}>
        {items.map(([icon, label]) => (
          <Flex align="center" gap={12} key={label}>
            <span
              style={{
                alignItems: "center",
                background: `${PUBLIC_COLORS.brand}10`,
                borderRadius: 8,
                color: PUBLIC_COLORS.brand,
                display: "inline-flex",
                flex: "0 0 auto",
                fontSize: 18,
                height: 36,
                justifyContent: "center",
                width: 36,
              }}
            >
              <Icon name={icon} />
            </span>
            <Text strong>{label}</Text>
          </Flex>
        ))}
      </Flex>
    </div>
  );
}

function WorkflowStrip() {
  const steps = [
    {
      accent: "#278c83",
      body: "Start a chat thread as a human-only conversation or invite Codex into the thread.",
      icon: "comments",
      label: "1",
      title: "Choose the thread",
    },
    {
      accent: "#2f6fda",
      body: "Paste images, code blocks, quotes, files, and exact instructions into the rich editor.",
      icon: "markdown",
      label: "2",
      title: "Give useful context",
    },
    {
      accent: "#f59e0b",
      body: "Let Codex inspect project files, work with terminals, and use CoCalc-aware tools.",
      icon: "robot",
      label: "3",
      title: "Run the turn",
    },
    {
      accent: "#7c3aed",
      body: "Review the patch, test output, and discussion in the same durable project history.",
      icon: "history",
      label: "4",
      title: "Keep the trail",
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
      <div
        className="cocalc-ai-workflow-panel"
        style={{
          background: PUBLIC_COLORS.surfaceMuted,
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: 8,
          padding: 24,
        }}
      >
        <Flex vertical gap={22}>
          <Title level={3} style={{ margin: 0 }}>
            Agent work should leave a readable project trail.
          </Title>
          <Row gutter={[14, 14]}>
            {steps.map((step) => (
              <Col key={step.label} xs={24} md={12} xl={6}>
                <div
                  style={{
                    background: PUBLIC_COLORS.surface,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: 8,
                    height: "100%",
                    padding: 18,
                  }}
                >
                  <Flex vertical gap={12}>
                    <Flex align="center" justify="space-between">
                      <IconBadge
                        accent={step.accent}
                        icon={step.icon}
                        size="md"
                      />
                      <Text
                        style={{
                          color: step.accent,
                          fontSize: PUBLIC_TYPE.subhead,
                        }}
                        strong
                      >
                        {step.label}
                      </Text>
                    </Flex>
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
      </div>
    </PublicSection>
  );
}

export default function AIFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const supportHref = featureSupportPath({
    body: "I want to discuss AI agent workflows in CoCalc. Helpful context: the kind of project, who will review agent work, notebook or terminal needs, and any deployment or policy constraints.",
    context: "ai",
    subject: "CoCalc AI workflows",
    title: "Ask CoCalc about AI workflows",
  });

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Codex where the work happens.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Use Codex next to the files, notebooks, terminals, images, and
                collaborators involved in the work.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Ask it to inspect code, debug a notebook, edit Markdown notes or
                documentation, run a focused check, or summarize changes without
                copying context into a separate tool.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={`${GUIDE_BASE}/codex-agent-chat/`}>
                  Read the Codex guide
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <ThreadMock />
          </Col>
        </Row>
      </PublicSection>

      <WorkflowStrip />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Review agent work with the people who own it.
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Because the thread lives in the project, a collaborator or
                reviewer can open it later, read the exact diff and discussion,
                and decide what to keep — without rebuilding the context the
                agent had.
              </Paragraph>
              <BulletList
                items={[
                  "A teammate picks up a long-running computation and continues it from where the agent stopped.",
                  "A reviewer checks notebook results and the diff before the change is handed on.",
                  "Mixed work — code, notebooks, and shell steps — stays together for the next person.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <ProjectContextList />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <div
          style={{
            borderTop: `1px solid ${PUBLIC_COLORS.border}`,
            paddingTop: 24,
          }}
        >
          <Row gutter={[24, 24]} align="middle">
            <Col xs={24} lg={15}>
              <Flex vertical gap={12}>
                <Title level={3} style={{ margin: 0 }}>
                  Choose the AI path that fits.
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Start with Codex when the agent should work beside the project
                  record. Use terminal workflows when the task depends on
                  another command-line agent or shell process.
                </Paragraph>
                <BulletList
                  items={[
                    "Use Codex chat when review should stay near files, notebooks, terminal output, and discussion.",
                    "Use terminal workflows when the task depends on a command-line tool or shell process.",
                    "Ask CoCalc when AI workflows are tied to courses, teams, deployment, or policy requirements.",
                  ]}
                />
              </Flex>
            </Col>
            <Col xs={24} lg={9}>
              <Flex vertical gap={10} align="start">
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={appPath("products")}>
                  Compare operating models
                </Button>
                <Flex wrap gap={16}>
                  <LinkButton href={appPath("features/terminal")}>
                    Terminal workflows
                  </LinkButton>
                  <LinkButton href={supportHref}>
                    Ask about AI workflows
                  </LinkButton>
                </Flex>
              </Flex>
            </Col>
          </Row>
        </div>
      </PublicSection>
    </Flex>
  );
}
