/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

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
        borderRadius: 8,
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
        borderRadius: 8,
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

function TerminalMock() {
  const rows = [
    ["alice@project", "python run.py"],
    ["", "Running analysis..."],
    ["", "Results written to results.csv"],
    ["ben@project", "open notes.md"],
    ["codex@project", "gh pr status"],
  ];
  return (
    <div
      aria-label="Illustration of a CoCalc collaborative terminal"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 58%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={14}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#096dd9" icon="terminal" />
            <div>
              <Text strong>work.term</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                shared project terminal
              </div>
            </div>
          </Flex>
        </Flex>
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
              CoCalc Terminal
            </Text>
          </div>
          <Flex
            vertical
            gap={10}
            style={{
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              padding: 18,
            }}
          >
            {rows.map(([prompt, command], index) => (
              <div key={`${prompt}-${command}-${index}`}>
                {prompt ? (
                  <>
                    <Text style={{ color: "#86efac" }}>{prompt}</Text>
                    <Text style={{ color: "#dbeafe" }}> $ </Text>
                  </>
                ) : null}
                <Text style={{ color: prompt ? "#bfdbfe" : "#f8fafc" }}>
                  {command}
                </Text>
              </div>
            ))}
          </Flex>
        </div>
        <Row gutter={[10, 10]}>
          {[
            ["users", "one stream"],
            ["history", "durable"],
            ["robot", "agent-aware"],
            ["folder", ".term file"],
          ].map(([icon, label]) => (
            <Col key={label} xs={12} sm={6}>
              <Flex
                align="center"
                gap={8}
                style={{
                  background: "#fff",
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 8,
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

function TermFileDiagram() {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
        padding: 24,
      }}
    >
      <Flex vertical gap={18}>
        <Flex align="center" gap={12}>
          <IconBadge accent="#096dd9" icon="file" />
          <div>
            <Text strong>A .term file gives the shell an address</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              Reopen the same terminal context from the project file tree.
            </div>
          </div>
        </Flex>
        <Row align="middle" gutter={[14, 14]}>
          <Col xs={24} md={9}>
            <div
              style={{
                background: "#f7fbff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 8,
                padding: 16,
              }}
            >
              <Flex vertical gap={10}>
                <Text strong>research/</Text>
                <Text style={{ paddingLeft: 18 }}>
                  <Icon name="folder" /> runs/
                </Text>
                <Text
                  strong
                  style={{ color: PUBLIC_COLORS.brand, paddingLeft: 36 }}
                >
                  <Icon name="terminal" /> run.term
                </Text>
              </Flex>
            </div>
          </Col>
          <Col xs={24} md={15}>
            <Flex vertical gap={10}>
              {[
                ["cwd", "research/runs/"],
                ["history", "tied to the path"],
                ["reopen", "same terminal later"],
                ["agent", "list / history / write"],
              ].map(([label, value]) => (
                <Flex
                  align="center"
                  gap={10}
                  key={label}
                  style={{
                    background: "#fff8e8",
                    border: "1px solid rgba(215, 155, 43, 0.3)",
                    borderRadius: 8,
                    padding: "10px 12px",
                  }}
                >
                  <Text strong style={{ color: "#ad6800", minWidth: 64 }}>
                    {label}
                  </Text>
                  <Text>{value}</Text>
                </Flex>
              ))}
            </Flex>
          </Col>
        </Row>
      </Flex>
    </div>
  );
}

function SharedStreamDiagram() {
  const clients = [
    ["Instructor", "#278c83"],
    ["Student", "#096dd9"],
    ["Codex", "#ad6800"],
  ];
  return (
    <div
      style={{
        background:
          "linear-gradient(145deg, #fff 0%, #f6fbff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
        padding: 24,
      }}
    >
      <Flex vertical gap={18}>
        <Row gutter={[12, 12]}>
          {clients.map(([label, accent]) => (
            <Col key={label} xs={24} sm={8}>
              <div
                style={{
                  background: `${accent}10`,
                  border: `1px solid ${accent}33`,
                  borderRadius: 8,
                  padding: 14,
                  textAlign: "center",
                }}
              >
                <Text strong style={{ color: accent }}>
                  {label}
                </Text>
                <div
                  style={{
                    background: "#111827",
                    borderRadius: 10,
                    height: 46,
                    marginTop: 10,
                  }}
                />
              </div>
            </Col>
          ))}
        </Row>
        <Flex align="center" justify="center" gap={14} wrap>
          {["durable reconnect", "shared sizing", "side chat"].map((label) => (
            <Text key={label} style={{ color: PUBLIC_COLORS.mutedText }}>
              {label}
            </Text>
          ))}
        </Flex>
        <div
          style={{
            background: "#0b1522",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 8,
            color: "#dbeafe",
            padding: 18,
            textAlign: "center",
          }}
        >
          <Text strong style={{ color: "#dbeafe" }}>
            one PTY stream
          </Text>
          <div style={{ color: "#93c5fd", marginTop: 6 }}>
            live output, shared input, preserved scrollback
          </div>
        </div>
      </Flex>
    </div>
  );
}

function AgentTerminalLoop() {
  const steps = [
    {
      body: "List sessions, inspect state, and read the relevant terminal history.",
      icon: "history",
      title: "Read",
    },
    {
      body: "Use the terminal output together with project files, notebooks, and chat.",
      icon: "robot",
      title: "Reason",
    },
    {
      body: "Write carefully to a live terminal when that is the best interface.",
      icon: "terminal",
      title: "Write",
    },
    {
      body: "Continue after browser refreshes, disconnects, or handoffs.",
      icon: "users",
      title: "Continue",
    },
  ] satisfies { body: string; icon: IconName; title: string }[];
  return (
    <div
      style={{
        background:
          "linear-gradient(135deg, rgba(16,33,63,0.97), rgba(34,92,116,0.94))",
        borderRadius: 8,
        color: "#fff",
        padding: 34,
      }}
    >
      <Title level={3} style={{ color: "#fff", margin: "0 0 18px" }}>
        The terminal gives Codex a concrete loop
      </Title>
      <Row gutter={[14, 14]}>
        {steps.map((step, index) => (
          <Col key={step.title} xs={24} md={6}>
            <div
              style={{
                background: "rgba(255,255,255,0.1)",
                border: "1px solid rgba(255,255,255,0.16)",
                borderRadius: 8,
                height: "100%",
                padding: 18,
              }}
            >
              <Flex vertical gap={12}>
                <Flex align="center" gap={10}>
                  <span
                    style={{
                      alignItems: "center",
                      background: COLORS.ANTD_YELL_M,
                      borderRadius: 999,
                      color: "#10213f",
                      display: "inline-flex",
                      fontWeight: 800,
                      height: 28,
                      justifyContent: "center",
                      width: 28,
                    }}
                  >
                    {index + 1}
                  </span>
                  <Icon name={step.icon} />
                </Flex>
                <Text strong style={{ color: "#fff", fontSize: 16 }}>
                  {step.title}
                </Text>
                <Paragraph
                  style={{ color: "rgba(255,255,255,0.76)", margin: 0 }}
                >
                  {step.body}
                </Paragraph>
              </Flex>
            </div>
          </Col>
        ))}
      </Row>
    </div>
  );
}

export default function TerminalFeaturePage({
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
    : "Start using CoCalc terminals";

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                A terminal is a live project document.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                Use a real Linux shell in the browser, next to notebooks, code,
                LaTeX, data, and chat. CoCalc keeps terminal work durable,
                collaborative, and visible to the agents and people working in
                the same project.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                It is familiar xterm.js terminal behavior, but anchored in a
                project file and connected to the rest of the workspace.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={`${GUIDE_BASE}/terminal/`}>
                  Terminal field guide
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <TerminalMock />
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#096dd9" icon="terminal" title="A real shell">
            Run packages, scripts, compilers, SSH, Git, Python, Sage, R, Julia,
            and command-line tools inside the project environment.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard
            accent="#278c83"
            icon="users"
            title="Actually collaborative"
          >
            Multiple browsers and collaborators can attach to the same terminal
            stream instead of passing screenshots around.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#ad6800" icon="robot" title="Agent-aware">
            Codex can inspect terminal sessions and use the CoCalc CLI to work
            with live terminal state when the task calls for it.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                A .term file gives the shell an address
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Open <code>research/runs/run.term</code> and the shell starts in
                <code>research/runs/</code>. Reopen that file later and the
                terminal context is easy for a collaborator, instructor, or
                agent to find again.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That file anchor makes terminal work part of the project context
                instead of a private browser tab that vanishes from view.
              </Paragraph>
              <BulletList
                items={[
                  "The terminal path gives humans and agents a stable target.",
                  "The working directory follows the file location.",
                  "Terminal history is tied to the path where the session starts.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <TermFileDiagram />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <SharedStreamDiagram />
          </Col>
          <Col xs={24} lg={11}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Collaborate in one terminal stream
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc terminals are durable like tmux and collaborative like
                the rest of the workspace. Close the browser, reopen the
                project, and the session can still be there.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Shared terminals have real operational details: output pause,
                shared sizing, side chat, and controls for stale viewers when
                another browser is holding the session too small.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <AgentTerminalLoop />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Split the shell around the work
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Keep logs, a server process, a REPL, and a build command visible
              in one frame. Split horizontally or vertically, drag panes into
              place, and keep a terminal beside the editor that needs it.
            </Paragraph>
            <BulletList
              items={[
                "Edit a script and run it in the adjacent terminal.",
                "Tail logs while testing a notebook or local web app.",
                "Use the `open` command to pop files into the browser workspace.",
              ]}
            />
          </PublicSection>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Keep heavy output usable
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Some commands produce far more output than a browser should render
              one line at a time. CoCalc adapts terminal buffering and applies
              terminal backpressure so large output remains manageable without
              treating dropped text as an acceptable answer.
            </Paragraph>
            <BulletList
              items={[
                "Pause output when the scrollback is moving too fast.",
                "Preserve enough terminal history for later inspection.",
                "Let agents read the terminal context instead of guessing from a final error.",
              ]}
            />
          </PublicSection>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={14}>
            <Title level={3} style={{ margin: 0 }}>
              When a terminal should be shared
            </Title>
            <Paragraph style={{ margin: 0 }}>
              The terminal becomes more valuable because it sits beside Jupyter
              notebooks, LaTeX, files, Git, chat, project secrets, snapshots,
              backups, and app servers. Use it for the exact practical moments
              where a shell is the fastest path.
            </Paragraph>
            <Flex wrap gap={12}>
              <Button href={appPath("features/linux")}>
                Linux environment
              </Button>
              <Button href={appPath("features/jupyter-notebook")}>
                Jupyter notebooks
              </Button>
              <Button href={`${GUIDE_BASE}/software-install/`}>
                Software install guide
              </Button>
              {helpEmail ? (
                <Button href={`mailto:${helpEmail}`}>Contact support</Button>
              ) : null}
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <div
              style={{
                background: "#10213f",
                borderRadius: 8,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.12)",
                color: "#fff",
                padding: 26,
              }}
            >
              <Title level={4} style={{ color: "#fff", margin: "0 0 10px" }}>
                Start using CoCalc
              </Title>
              <Paragraph style={{ color: "rgba(255,255,255,0.78)" }}>
                Open a project, create a <code>.term</code> file, and put the
                shell next to the document or notebook it supports.
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
