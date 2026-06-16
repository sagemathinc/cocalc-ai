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
      body: "I found the stale path handling, updated the file, and I am running the package test now.",
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
      aria-label="Illustration of a CoCalc Codex chat thread connected to files, notebooks, and terminals"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f7f4ff 52%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#7c3aed" icon="robot" />
            <div>
              <Text strong>Codex thread</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                chat, files, notebooks, terminals, and collaborators
              </div>
            </div>
          </Flex>
          <Flex gap={8} wrap>
            <Tag color="purple" style={{ marginInlineEnd: 0 }}>
              OpenAI
            </Tag>
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              collaborative
            </Tag>
          </Flex>
        </Flex>

        <Flex vertical gap={12}>
          {messages.map((message) => (
            <div
              key={message.label}
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 18,
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

        <Row gutter={[10, 10]}>
          {[
            ["markdown", "rich prompts"],
            ["image", "images"],
            ["terminal", "terminal"],
            ["file", "files"],
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
    <section
      style={{
        background: "#0b1522",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 26,
        color: "#dbeafe",
        minWidth: 0,
        padding: 24,
      }}
    >
      <Flex vertical gap={22}>
        <div>
          <Tag
            style={{
              background: "rgba(255,255,255,0.08)",
              borderColor: "rgba(255,255,255,0.18)",
              color: "#dbeafe",
              marginBottom: 12,
            }}
          >
            Codex workflow
          </Tag>
          <Title level={3} style={{ color: "#fff", margin: 0 }}>
            Agent work should leave a readable project trail.
          </Title>
        </div>
        <Row gutter={[14, 14]}>
          {steps.map((step) => (
            <Col key={step.label} xs={24} md={12} xl={6}>
              <div
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 20,
                  height: "100%",
                  padding: 18,
                }}
              >
                <Flex vertical gap={12}>
                  <Flex align="center" justify="space-between">
                    <span
                      style={{
                        alignItems: "center",
                        background: "rgba(255,255,255,0.1)",
                        border: "1px solid rgba(255,255,255,0.16)",
                        borderRadius: 16,
                        display: "inline-flex",
                        fontSize: 24,
                        height: 52,
                        justifyContent: "center",
                        width: 52,
                      }}
                    >
                      <Icon name={step.icon} />
                    </span>
                    <Text style={{ color: "#93c5fd", fontSize: 24 }} strong>
                      {step.label}
                    </Text>
                  </Flex>
                  <Title level={4} style={{ color: "#fff", margin: 0 }}>
                    {step.title}
                  </Title>
                  <Paragraph style={{ color: "#cbd5e1", margin: 0 }}>
                    {step.body}
                  </Paragraph>
                </Flex>
              </div>
            </Col>
          ))}
        </Row>
      </Flex>
    </section>
  );
}

function CredentialPanel() {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 24,
        boxShadow: "0 16px 44px rgba(33, 49, 57, 0.07)",
        padding: 22,
      }}
    >
      <Flex vertical gap={14}>
        <Flex align="center" gap={12}>
          <IconBadge accent="#7c3aed" icon="key" />
          <div>
            <Text strong>Built-in provider support</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              OpenAI API keys and OpenAI subscription plans
            </div>
          </div>
        </Flex>
        <Paragraph style={{ margin: 0 }}>
          Use an OpenAI API key, an OpenAI subscription plan where supported, or
          a shared project/site configuration. Human <code>@mentions</code>{" "}
          notify collaborators; they do not invoke AI models.
        </Paragraph>
      </Flex>
    </div>
  );
}

function TerminalAgentPanel() {
  return (
    <div
      style={{
        background: "#0b1522",
        borderRadius: 24,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.12)",
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
          padding: "12px 14px",
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
        <Text style={{ color: "#dbeafe", marginLeft: 8 }}>
          persistent terminal
        </Text>
      </div>
      <Flex
        vertical
        gap={8}
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          padding: 18,
        }}
      >
        <Text style={{ color: "#bfdbfe" }}>
          $ npm install -g @anthropic-ai/claude-code
        </Text>
        <Text style={{ color: "#86efac" }}>installed command-line agent</Text>
        <Text style={{ color: "#bfdbfe" }}>$ claude</Text>
        <Text style={{ color: "#f8fafc" }}>
          runs like any Linux terminal program
        </Text>
      </Flex>
    </div>
  );
}

export default function AIFeaturePage({
  helpEmail,
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
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Tag
                style={{
                  alignSelf: "flex-start",
                  background: "#f3e8ff",
                  borderColor: "#d8b4fe",
                  color: "#6d28d9",
                }}
              >
                Codex in CoCalc
              </Tag>
              <Title level={2} style={{ margin: 0 }}>
                Codex chat where project work happens.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                Use Codex from a project chat thread, next to the files,
                notebooks, terminals, images, and collaborators involved in the
                work.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Ask it to inspect code, debug a notebook, edit documentation,
                run a focused check, or summarize changes without copying
                context into a separate tool.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={`${GUIDE_BASE}/codex-agent-chat/`}>
                  Read the Codex chat guide
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <ThreadMock />
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#7c3aed" icon="robot" title="Codex in chat">
            Start a thread for human discussion or Codex assistance, with the
            same project files nearby for review.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#2f6fda" icon="markdown" title="Rich prompts">
            The chat editor handles Markdown, code blocks, images, quotes, and
            longer instructions, so the request can carry the context an agent
            actually needs.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard
            accent="#278c83"
            icon="users"
            title="Collaborative by default"
          >
            A Codex thread can be reviewed by teammates in the project. The
            discussion, patch, screenshots, and follow-up questions stay
            together.
          </StoryCard>
        </Col>
      </Row>

      <WorkflowStrip />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Tag
                color="blue"
                style={{
                  alignSelf: "flex-start",
                  background: COLORS.ANTD_BG_BLUE_L,
                  color: COLORS.BLUE_D,
                }}
              >
                Project-native tools
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Let Codex work with the live project, not just a pasted prompt.
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc gives Codex project-scoped guidance and tool access for
                the environment it is working in. It can use terminal sessions,
                read and edit synchronized documents, work with live notebooks,
                and report back in the same durable thread.
              </Paragraph>
              <BulletList
                items={[
                  "Ask Codex to diagnose a failing command and run the focused check.",
                  "Have it edit files while you review the exact diff and discussion.",
                  "Use images and screenshots as part of the prompt when visual context matters.",
                  "Keep long-running turns durable across browser refreshes and project restarts.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <div
              style={{
                background:
                  "linear-gradient(145deg, #ffffff 0%, #f4f9ff 58%, #fff8e8 100%)",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 28,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                padding: 20,
              }}
            >
              <Flex vertical gap={14}>
                {[
                  ["file", "Files and synced documents"],
                  ["jupyter", "Live notebooks"],
                  ["terminal", "Persistent terminals"],
                  ["history", "Durable chat history"],
                ].map(([icon, label]) => (
                  <Flex
                    align="center"
                    gap={12}
                    key={label}
                    style={{
                      background: "#fff",
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: 16,
                      padding: 14,
                    }}
                  >
                    <IconBadge accent="#7c3aed" icon={icon as IconName} />
                    <Text strong>{label}</Text>
                  </Flex>
                ))}
              </Flex>
            </div>
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <CredentialPanel />
        </Col>
        <Col xs={24} lg={12}>
          <div
            style={{
              background: "#fff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 24,
              boxShadow: "0 16px 44px rgba(33, 49, 57, 0.07)",
              height: "100%",
              padding: 22,
            }}
          >
            <Title level={3} style={{ margin: 0 }}>
              Other agents can still run in terminals.
            </Title>
            <Paragraph style={{ margin: "12px 0 0" }}>
              CoCalc projects are real Linux environments with persistent
              terminals. Command-line agents such as Claude Code, OpenCode, or
              similar tools can be installed and run there like ordinary Linux
              programs. They run as terminal tools rather than CoCalc-managed AI
              integrations.
            </Paragraph>
          </div>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <TerminalAgentPanel />
          </Col>
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                A sandbox for agent work, with humans nearby.
              </Title>
              <Paragraph style={{ margin: 0 }}>
                The broader CoCalc story is a collaborative project sandbox:
                files, terminals, notebooks, chat, backups, snapshots, and
                collaborators in one place. Codex is the native chat-based agent
                path; terminals leave room for any normal command-line workflow
                your project needs.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button href={appPath("features/terminal")}>
                  Terminal workflows
                </Button>
                <Button href={appPath("features/linux")}>
                  Linux environment
                </Button>
                {helpEmail ? (
                  <Button href={`mailto:${helpEmail}`}>Contact support</Button>
                ) : null}
              </Flex>
              <LinkButton href={`${GUIDE_BASE}/agent-sandbox-cloud/`}>
                Read the agent sandbox guide
              </LinkButton>
            </Flex>
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
