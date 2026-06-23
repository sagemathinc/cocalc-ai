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
import { ContextList, FeatureFinalBand, IconBadge } from "./feature-visuals";
import { FEATURE_ACCENTS } from "./feature-accents";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
const AI_ACCENT = FEATURE_ACCENTS.ai;
const AI_PAGE_CSS = `
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

.feature-ai-context-panel {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.card};
  height: 100%;
  padding: 22px;
}
`;

function ThreadMock() {
  const messages = [
    {
      body: "The test failure is in the notebook export. Please inspect the repo, patch the conversion step, and run the focused test.",
      icon: "user",
      label: "human",
    },
    {
      body: "I found the outdated path handling, updated the file, and I am running the package test now.",
      icon: "robot",
      label: "codex",
    },
    {
      body: "The same thread keeps the patch, test output, screenshots, and review notes together.",
      icon: "history",
      label: "durable thread",
    },
  ] satisfies {
    body: string;
    icon: IconName;
    label: string;
  }[];

  return (
    <div
      aria-label="Illustration of a CoCalc agent thread connected to files, notebooks, and terminals"
      className="feature-ai-thread-panel"
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent={AI_ACCENT} icon="robot" />
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
            <div className="feature-ai-thread-message" key={message.label}>
              <Flex align="start" gap={12}>
                <IconBadge accent={AI_ACCENT} icon={message.icon} />
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

function ProjectContextPanel() {
  const items = [
    { icon: "file", label: "Files and synced documents" },
    { icon: "jupyter", label: "Live notebooks" },
    { icon: "terminal", label: "Persistent terminals" },
    { icon: "history", label: "Durable agent thread" },
  ] satisfies { icon: IconName; label: string }[];

  return (
    <div className="feature-ai-context-panel">
      <ContextList accent={AI_ACCENT} items={items} title="Project context" />
    </div>
  );
}

function WorkflowStrip() {
  const steps = [
    {
      body: "Start a chat thread as a human-only conversation or invite Codex into the thread.",
      icon: "comments",
      label: "1",
      title: "Choose the thread",
    },
    {
      body: "Paste images, code blocks, quotes, files, and exact instructions into the rich editor.",
      icon: "markdown",
      label: "2",
      title: "Give useful context",
    },
    {
      body: "Let Codex inspect project files, work with terminals, and use CoCalc-aware tools.",
      icon: "robot",
      label: "3",
      title: "Run the turn",
    },
    {
      body: "Review the patch, test output, and discussion in the same durable project history.",
      icon: "history",
      label: "4",
      title: "Keep the trail",
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
            Agent work should leave a readable project trail.
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
                  Ask it to inspect code, debug a notebook, edit Markdown notes
                  or documentation, run a focused check, or summarize changes
                  without copying context into a separate tool.
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
          <Row gutter={[24, 24]} align="middle">
            <Col xs={24} lg={12}>
              <Flex vertical gap={12}>
                <Title level={3} style={{ margin: 0 }}>
                  Review agent work with the people who own it.
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Because the thread lives in the project, a collaborator or
                  reviewer can open it later, read the exact diff and
                  discussion, and decide what to keep — without rebuilding the
                  context the agent had. When notebooks are involved, that
                  review can happen in the same collaborative notebook state,
                  with visible cursors and shared kernel sessions.
                </Paragraph>
                <BulletList
                  items={[
                    "A teammate picks up a long-running computation and continues it from where the agent stopped.",
                    "A reviewer checks notebook results, TimeTravel history, and the diff before the change is handed on.",
                    "Mixed work — code, notebooks, and shell steps — stays together for the next person.",
                  ]}
                />
              </Flex>
            </Col>
            <Col xs={24} lg={12} style={{ display: "flex" }}>
              <ProjectContextPanel />
            </Col>
          </Row>
        </PublicSection>

        <PublicSection>
          <FeatureFinalBand
            action={{
              body: "Open a project and keep the agent thread, files, checks, and review trail with the work it touched.",
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
                href: appPath("products"),
                label: "Compare operating models",
              },
            ]}
            title="When AI work belongs in CoCalc"
          >
            <BulletList
              items={[
                "Codex should inspect files, notebooks, terminals, images, and discussion in one place.",
                "A collaborator needs the patch, checks, screenshots, and rationale close enough to review.",
                "A shell-based agent or command-line workflow should leave output in the same project record.",
                "People need to continue the work later and decide what to keep.",
              ]}
            />
          </FeatureFinalBand>
        </PublicSection>
      </Flex>
    </>
  );
}
