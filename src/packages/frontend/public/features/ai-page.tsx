/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { BulletList, featureAppPath as appPath } from "./page-components";
import { FeatureFinalBand, IconBadge } from "./feature-visuals";
import { FEATURE_ACCENTS } from "./feature-accents";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
const AI_ACCENT = FEATURE_ACCENTS.ai;
const AI_PAGE_CSS = `
.feature-ai-hero-row {
  align-items: center;
}

.feature-ai-thread-panel {
  background: ${PUBLIC_COLORS.surfaceMuted};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.panel};
  padding: 20px;
}

.feature-ai-thread-message {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.card};
  padding: 14px;
}

.feature-ai-thread-note {
  background: ${PUBLIC_COLORS.infoTint};
  border-style: dashed;
  box-shadow: none;
  padding: 12px;
}

.feature-ai-related-link-label-separated::before {
  color: ${PUBLIC_COLORS.border};
  content: "|";
  margin-right: 12px;
}

@media (max-width: 560px) {
  .feature-ai-related-link-label-separated::before {
    content: "";
    margin-right: 0;
  }
}

`;

function ThreadMock() {
  const messages = [
    {
      body: "The notebook export test is failing. Please inspect the conversion step and run the focused test.",
      icon: "user",
      label: "human",
    },
    {
      body: "I found the outdated path handling, updated the file, and I am running the package test now.",
      icon: "robot",
      label: "codex",
    },
    {
      body: "The thread keeps the proposed change and result together.",
      icon: "history",
      label: "review thread",
      variant: "note",
    },
  ] satisfies {
    body: string;
    icon: IconName;
    label: string;
    variant?: "note";
  }[];

  return (
    <div
      aria-label="Illustration of a CoCalc agent thread in a project"
      className="feature-ai-thread-panel"
      role="img"
    >
      <Flex aria-hidden="true" vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent={AI_ACCENT} icon="robot" />
            <div>
              <Text strong>Agent thread</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                conversation and project context
              </div>
            </div>
          </Flex>
        </Flex>

        <Flex vertical gap={12}>
          {messages.map((message) => (
            <div
              className={
                message.variant === "note"
                  ? "feature-ai-thread-message feature-ai-thread-note"
                  : "feature-ai-thread-message"
              }
              key={message.label}
            >
              <Flex align="start" gap={12}>
                <IconBadge
                  accent={AI_ACCENT}
                  icon={message.icon}
                  size={message.variant === "note" ? "sm" : "lg"}
                />
                <div>
                  <Text strong style={{ color: PUBLIC_COLORS.heading }}>
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

function WorkflowStrip() {
  const steps = [
    {
      body: "Start a conversation, then invite Codex when the turn needs code.",
      icon: "comments",
      label: "1",
      title: "Choose the thread",
    },
    {
      body: "Paste the specific file, error, image, or instruction the turn needs.",
      icon: "markdown",
      label: "2",
      title: "Give useful context",
    },
    {
      body: "Let Codex inspect the project and use CoCalc-aware tools.",
      icon: "robot",
      label: "3",
      title: "Run the turn",
    },
    {
      body: "Review the patch, test output, and discussion before keeping the change.",
      icon: "history",
      label: "4",
      title: "Review the result",
    },
  ] satisfies {
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
          borderRadius: PUBLIC_RADIUS.panel,
          padding: 24,
        }}
      >
        <Flex vertical gap={22}>
          <Title level={3} style={{ margin: 0 }}>
            Run an agent turn in order.
          </Title>
          <Row gutter={[14, 14]}>
            {steps.map((step) => (
              <Col key={step.label} xs={24} md={12} xl={6}>
                <div
                  style={{
                    background: PUBLIC_COLORS.surface,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PUBLIC_RADIUS.panel,
                    height: "100%",
                    padding: 18,
                  }}
                >
                  <Flex vertical gap={12}>
                    <Flex align="center" justify="space-between">
                      <IconBadge
                        accent={AI_ACCENT}
                        icon={step.icon}
                        size="md"
                      />
                      <Text
                        style={{
                          color: PUBLIC_COLORS.heading,
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

  return (
    <>
      <style>{AI_PAGE_CSS}</style>
      <Flex vertical gap={22}>
        <PublicSection>
          <Row className="feature-ai-hero-row" gutter={[28, 28]} align="middle">
            <Col xs={24} lg={11}>
              <Flex vertical gap={14}>
                <Title level={2} style={{ margin: 0 }}>
                  Codex where the work happens.
                </Title>
                <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                  Ask Codex to edit Markdown, code, or notebooks without leaving
                  the project.
                </Paragraph>
                <Flex wrap gap={12}>
                  <Button
                    type="primary"
                    href={`${GUIDE_BASE}/codex-agent-chat/`}
                  >
                    Read the Codex guide
                  </Button>
                  <Button href={primaryHref}>{primaryLabel}</Button>
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
          <FeatureFinalBand
            action={{
              body: "Open a project when the agent thread should stay with the work it changes.",
              href: primaryHref,
              label: primaryLabel,
              title: "Start in a project",
            }}
            relatedLinks={[
              {
                href: appPath("features/terminal"),
                label: "Terminal workflows",
              },
              {
                href: appPath("features/jupyter-notebook"),
                label: (
                  <span className="feature-ai-related-link-label-separated">
                    Jupyter notebooks
                  </span>
                ),
              },
              {
                href: appPath("products"),
                label: (
                  <span className="feature-ai-related-link-label-separated">
                    Compare operating models
                  </span>
                ),
              },
            ]}
            title="When AI work belongs in CoCalc"
          >
            <BulletList
              items={[
                "Bring Codex in when the turn depends on surrounding project context.",
                "Keep review in CoCalc when people need context before accepting a change.",
                "Use shell-based agents when command output belongs with the project.",
                "Use TimeTravel when a teammate needs to inspect how an agent changed a file.",
              ]}
            />
          </FeatureFinalBand>
        </PublicSection>
      </Flex>
    </>
  );
}
