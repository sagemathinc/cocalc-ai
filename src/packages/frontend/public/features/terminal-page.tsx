/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

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
import {
  ContextList,
  FeatureFinalBand,
  IconBadge,
  StoryCard,
  TerminalMock,
} from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

function TerminalEvidencePanel() {
  return (
    <div
      aria-label="Illustration of a CoCalc terminal beside project files"
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
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start using CoCalc terminals";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="top">
          <Col xs={24} lg={14}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                A Linux terminal that lives in your project.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                A real Linux shell that survives disconnects and shares one live
                stream.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Open the <code>.term</code> file and the same shell context
                comes back.
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
          <Col xs={24} lg={10}>
            <ContextList
              accent="#096dd9"
              items={[
                { icon: "file", label: ".term files sit beside the work" },
                { icon: "users", label: "One live stream for collaborators" },
                { icon: "layout", label: "Split panes for logs and REPLs" },
                { icon: "robot", label: "Codex can inspect project context" },
              ]}
              title="Project context"
            />
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <StoryCard icon="file" title="Each terminal opens in its own folder.">
            Open <code>research/runs/run.term</code> and the shell starts in{" "}
            <code>research/runs/</code>. Open the <code>.term</code> file and
            the same shell context comes back with the files it reads or writes.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent="#278c83"
            icon="users"
            title="One session stays visible"
          >
            Collaborators can reconnect to the same terminal stream instead of
            chasing screenshots, pasted logs, or a private shell on one person's
            laptop.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent="#ad6800"
            icon="history"
            title="Output remains reviewable"
          >
            Split panes, preserved scrollback, and TimeTravel on generated files
            keep command output close enough to inspect during the next handoff.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <TerminalEvidencePanel />
          </Col>
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Put the shell beside the work it changes
              </Title>
              <Paragraph style={{ margin: 0 }}>
                A terminal is useful in CoCalc because it is not separate from
                the project. The shell sits near notebooks, source files, logs,
                generated outputs, notes, and chat, so a teammate can review
                what happened before continuing.
              </Paragraph>
              <BulletList
                items={[
                  "Run scripts beside the files they read or create.",
                  "Keep logs, generated outputs, and notes in the same project.",
                  "Let Codex inspect terminal context instead of guessing from a final error.",
                ]}
              />
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="top">
          <Col xs={24} lg={12}>
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
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
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
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: (
              <>
                Open a project, create a <code>.term</code> file, and put the
                shell next to the document or notebook it supports.
              </>
            ),
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Ready to use terminals in CoCalc?",
          }}
          relatedLinks={[
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
              "Use a real shell beside notebooks, LaTeX, files, Git, chat, project secrets, snapshots, backups, and app servers.",
              "Reach heavier compute from the same project when exploration, post-processing, and review need to stay together.",
              "Best fit when shell commands should remain visible to collaborators instead of disappearing into a private local terminal.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
