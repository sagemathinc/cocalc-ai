/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
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
} from "./page-components";
import {
  FeatureFinalBand,
  IconBadge,
  StoryCard,
  TerminalMock,
} from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
const TERMINAL_CONTEXT_ITEMS = [
  { icon: "file", label: ".term files reopen in their folder" },
  { icon: "users", label: "One live stream for collaborators" },
  { icon: "layout", label: "Sessions survive disconnects" },
  { icon: "robot", label: "Codex can inspect project context" },
] satisfies { icon: IconName; label: string }[];

function TerminalContextGrid() {
  return (
    <div
      className="cocalc-terminal-context-grid cocalc-feature-context-list"
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      }}
    >
      {TERMINAL_CONTEXT_ITEMS.map(({ icon, label }) => (
        <div
          className="cocalc-terminal-context-card"
          key={label}
          style={{
            background: PUBLIC_COLORS.surface,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PUBLIC_RADIUS.panel,
            boxShadow: PUBLIC_ELEVATION.card,
            minHeight: 112,
            padding: 16,
          }}
        >
          <Flex vertical gap={10}>
            <Icon
              name={icon}
              style={{ color: "#096dd9", flex: "0 0 auto", fontSize: 20 }}
            />
            <Text strong>{label}</Text>
          </Flex>
        </div>
      ))}
    </div>
  );
}

function TerminalEvidencePanel() {
  return (
    <div
      aria-label="Illustration of a CoCalc terminal beside project files"
      role="img"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 58%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#096dd9" icon="terminal" />
            <div>
              <Text strong>research/runs/run.term</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                shell, generated files, notes, and history stay together
              </div>
            </div>
          </Flex>
        </Flex>
        <TerminalMock
          title="CoCalc terminal"
          rows={[
            "$ pwd",
            "/home/user/research/runs",
            "$ python run.py",
            "Results written to output/results.csv",
            "$ open notes.md",
          ]}
        />
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
  const finalCtaLabel = isAuthenticated ? "Open projects" : "Create account";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Flex className="cocalc-terminal-hero" vertical gap={16}>
          <Title level={2} style={{ margin: 0, maxWidth: 760 }}>
            A Linux terminal that lives in your project.
          </Title>
          <Paragraph
            style={{ fontSize: PUBLIC_TYPE.lead, margin: 0, maxWidth: 720 }}
          >
            A real Linux shell that reconnects with project files, outputs, and
            history.
          </Paragraph>
        </Flex>
      </PublicSection>

      <PublicSection>
        <Row
          align="stretch"
          className="cocalc-terminal-evidence-layout"
          gutter={[18, 18]}
        >
          <Col
            className="cocalc-terminal-evidence-column"
            lg={15}
            xs={24}
          >
            <TerminalEvidencePanel />
          </Col>
          <Col
            className="cocalc-terminal-context-column"
            lg={9}
            xs={24}
          >
            <TerminalContextGrid />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Flex vertical gap={12} style={{ maxWidth: 1180 }}>
          <Title level={3} style={{ margin: 0 }}>
            Put the shell beside the work it changes
          </Title>
          <Row
            align="top"
            className="cocalc-terminal-story-layout"
            gutter={[32, 18]}
          >
            <Col
              className="cocalc-terminal-story-card-column"
              lg={9}
              xs={24}
            >
              <StoryCard
                icon="file"
                title="Each terminal opens in its own folder."
              >
                Open <code>research/runs/run.term</code> and the shell starts
                in <code>research/runs/</code>. Open the <code>.term</code>{" "}
                file and the same shell context comes back with the files it
                reads or writes.
              </StoryCard>
            </Col>
            <Col
              className="cocalc-terminal-story-copy-column"
              lg={15}
              xs={24}
            >
              <Flex vertical gap={12}>
                <Paragraph style={{ margin: 0 }}>
                  A terminal is useful in CoCalc because it is not separate from
                  the project. The shell sits near notebooks, source files,
                  logs, generated outputs, notes, and chat, so a teammate can
                  review what happened before continuing.
                </Paragraph>
                <Paragraph style={{ margin: 0 }}>
                  CoCalc terminals are durable like tmux and collaborative like
                  the rest of the workspace, with side chat beside the session.
                  Preserved scrollback and TimeTravel on generated files keep
                  command output close enough to inspect during the next
                  handoff.
                </Paragraph>
                <BulletList
                  items={[
                    "Run scripts against the files they read or create.",
                    "Use split panes for logs and a REPL.",
                    "Let Codex inspect terminal context instead of guessing from a final error.",
                  ]}
                />
              </Flex>
            </Col>
          </Row>
        </Flex>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: (
              <>
                Open a project, create a <code>.term</code> file, and start the
                shell in the folder for the document or notebook.
              </>
            ),
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Ready to use terminals in CoCalc?",
          }}
          relatedLinks={[
            { href: `${GUIDE_BASE}/terminal/`, label: "Terminal field guide" },
            { href: appPath("features/linux"), label: "Linux environment" },
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            {
              href: `${GUIDE_BASE}/software-install/`,
              label: "Software install guide",
            },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="Where the terminal earns its place"
        >
          <BulletList
            items={[
              "Use a real shell with notebooks, source files, Git, and generated output.",
              "Reach heavier compute from the same project when exploration, post-processing, and review need to stay together.",
              "Best fit when shell commands should remain visible to collaborators instead of disappearing into a private local terminal.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
