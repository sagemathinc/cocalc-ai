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
            <Text strong>Open the file, land in its folder</Text>
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
    ["Researcher", "#278c83"],
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

export default function TerminalFeaturePage({
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
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
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

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                A .term file gives the shell an address
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Open <code>research/runs/run.term</code> and the shell starts in{" "}
                <code>research/runs/</code>. Reopen that file later and the same
                terminal context — working directory and history — comes back
                for a collaborator, reviewer, or agent.
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
                shared sizing, side chat, and controls for inactive viewers when
                another browser is holding the session too small.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

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
                <>
                  Use the <code>open</code> command to pop files into the
                  browser workspace.
                </>,
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
              Choose the terminal path that fits
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
              <Button
                href={featureSupportPath({
                  body: "I want to discuss CoCalc terminal workflows. Helpful context: who will use shared terminals, expected software or service needs, and whether this is for research, teaching, or an organizational deployment.",
                  context: "terminal",
                  subject: "CoCalc terminal workflows",
                  title: "Ask CoCalc about terminal workflows",
                })}
              >
                Ask about terminal workflows
              </Button>
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
                level={4}
                style={{ color: PUBLIC_COLORS.heading, margin: "0 0 10px" }}
              >
                Ready to use terminals in CoCalc?
              </Title>
              <Paragraph style={{ color: PUBLIC_COLORS.mutedText }}>
                Open a project, create a <code>.term</code> file, and put the
                shell next to the document or notebook it supports.
              </Paragraph>
              <Flex vertical gap={10} align="start">
                <Button type="primary" href={primaryCtaHref}>
                  {finalCtaLabel}
                </Button>
                <Button href={appPath("products")}>
                  Compare operating models
                </Button>
              </Flex>
            </div>
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
