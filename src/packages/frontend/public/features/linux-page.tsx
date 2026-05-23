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

function LinuxWorkspaceMock() {
  const commands = [
    "$ sudo apt-get update",
    "$ sudo apt-get install -y graphviz",
    "$ dot -V",
    "graphviz version 2.43.0",
  ];
  return (
    <div
      aria-label="Illustration of a CoCalc Linux project with sudo, apt, files, and notebooks"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 58%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={14}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#096dd9" icon="linux" />
            <div>
              <Text strong>project Ubuntu environment</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                files, root filesystem, services, and tools
              </div>
            </div>
          </Flex>
          <Flex gap={8} wrap>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              sudo
            </Tag>
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              reusable RootFS
            </Tag>
          </Flex>
        </Flex>
        <Row gutter={[14, 14]} align="stretch">
          <Col xs={24} md={15}>
            <div
              style={{
                background: "#0b1522",
                borderRadius: 20,
                color: "#dbeafe",
                height: "100%",
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
                  install.term
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
                {commands.map((command) => (
                  <Text
                    key={command}
                    style={{
                      color: command.startsWith("$") ? "#bfdbfe" : "#86efac",
                    }}
                  >
                    {command}
                  </Text>
                ))}
              </Flex>
            </div>
          </Col>
          <Col xs={24} md={9}>
            <Flex vertical gap={10} style={{ height: "100%" }}>
              {[
                ["folder", "project files"],
                ["jupyter", "notebooks"],
                ["terminal", "terminals"],
                ["history", "snapshots"],
              ].map(([icon, label]) => (
                <Flex
                  align="center"
                  gap={10}
                  key={label}
                  style={{
                    background: "#fff",
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: 14,
                    padding: "10px 12px",
                  }}
                >
                  <Icon name={icon as IconName} />
                  <Text strong>{label}</Text>
                </Flex>
              ))}
            </Flex>
          </Col>
        </Row>
      </Flex>
    </div>
  );
}

function SoftwareLayersDiagram() {
  const layers = [
    {
      body: "Notebooks, scripts, papers, data, logs, and setup notes live with the project.",
      icon: "folder",
      title: "Project files",
    },
    {
      body: "Use pip, conda, R, npm, pnpm, TeX, and language-specific package managers where the code runs.",
      icon: "python",
      title: "Language packages",
    },
    {
      body: "Use sudo and apt for Ubuntu packages, command-line tools, services, and system libraries.",
      icon: "linux",
      title: "Root filesystem",
    },
  ] satisfies { body: string; icon: IconName; title: string }[];
  return (
    <div
      style={{
        background:
          "linear-gradient(145deg, #fff 0%, #f6fbff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 26,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
        padding: 24,
      }}
    >
      <Flex vertical gap={14}>
        {layers.map((layer, index) => (
          <Flex
            align="center"
            gap={14}
            key={layer.title}
            style={{
              background: "#fff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 18,
              padding: 16,
            }}
          >
            <span
              style={{
                alignItems: "center",
                background: index === 2 ? COLORS.ANTD_BG_BLUE_L : "#fff8e8",
                borderRadius: 999,
                color: index === 2 ? COLORS.BLUE_D : "#ad6800",
                display: "inline-flex",
                flex: "0 0 auto",
                fontWeight: 800,
                height: 30,
                justifyContent: "center",
                width: 30,
              }}
            >
              {index + 1}
            </span>
            <IconBadge
              accent={
                index === 2 ? "#096dd9" : index === 1 ? "#278c83" : "#ad6800"
              }
              icon={layer.icon}
            />
            <div>
              <Text strong>{layer.title}</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>{layer.body}</div>
            </div>
          </Flex>
        ))}
      </Flex>
    </div>
  );
}

function RootFsFlow() {
  const steps = [
    ["Build", "Install packages, data, tools, and project conventions."],
    ["Snapshot", "Capture the root filesystem as a reusable image."],
    ["Share", "Use the same environment for a course, team, or template."],
    ["Upgrade", "Publish new versions instead of rebuilding by hand."],
  ];
  return (
    <div
      style={{
        background:
          "linear-gradient(135deg, rgba(16,33,63,0.97), rgba(34,92,116,0.94))",
        borderRadius: 28,
        color: "#fff",
        padding: 34,
      }}
    >
      <Title level={3} style={{ color: "#fff", margin: "0 0 18px" }}>
        RootFS images make setup reusable
      </Title>
      <Row gutter={[14, 14]}>
        {steps.map(([title, body], index) => (
          <Col key={title} xs={24} md={6}>
            <div
              style={{
                background: "rgba(255,255,255,0.1)",
                border: "1px solid rgba(255,255,255,0.16)",
                borderRadius: 20,
                height: "100%",
                padding: 18,
              }}
            >
              <Flex vertical gap={12}>
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
                <Text strong style={{ color: "#fff", fontSize: 16 }}>
                  {title}
                </Text>
                <Paragraph
                  style={{ color: "rgba(255,255,255,0.76)", margin: 0 }}
                >
                  {body}
                </Paragraph>
              </Flex>
            </div>
          </Col>
        ))}
      </Row>
    </div>
  );
}

export default function LinuxFeaturePage({
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
    : "Start using CoCalc Linux";

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Tag
                color="blue"
                style={{
                  alignSelf: "flex-start",
                  background: COLORS.ANTD_BG_BLUE_L,
                  color: COLORS.BLUE_D,
                }}
              >
                Real project Linux
              </Tag>
              <Title level={2} style={{ margin: 0 }}>
                A Linux workspace you can actually administer.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                CoCalc-AI projects are Ubuntu environments where you can use
                terminals, notebooks, editors, services, and <code>sudo</code>
                in the browser. Install software, edit configuration, run
                servers, and keep the whole environment with the project.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This is a major shift from older locked-down hosted notebooks:
                students and collaborators can work in a real Linux system
                without needing to own or risk a local machine.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={`${GUIDE_BASE}/software-install/`}>
                  Software install guide
                </LinkButton>
                <Button href={appPath("features/terminal")}>
                  Terminal details
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <LinuxWorkspaceMock />
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#096dd9" icon="linux" title="Use sudo">
            Install system packages, update configuration, and work with the
            root filesystem of the project environment when the task requires
            it.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard
            accent="#278c83"
            icon="users"
            title="Share the environment"
          >
            Collaborators see the same files, packages, terminals, notebooks,
            services, and setup decisions inside the project.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#ad6800" icon="history" title="Recover and reuse">
            Snapshots, backups, and RootFS images make experimentation and
            teaching setup much less fragile.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Learn and use Linux without risking your own machine
              </Title>
              <Paragraph style={{ margin: 0 }}>
                A student can learn <code>apt</code>, shells, compilers,
                services, permissions, Python environments, and Git without
                turning their laptop into the course experiment. A researcher
                can try a system install without corrupting their daily driver.
              </Paragraph>
              <BulletList
                items={[
                  <>
                    Use <code>sudo apt-get update</code> and{" "}
                    <code>sudo apt-get install</code> for system packages.
                  </>,
                  "Install language packages where the notebook or script actually runs.",
                  "Take a snapshot before risky system-level changes.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <SoftwareLayersDiagram />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <div
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 26,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                padding: 24,
              }}
            >
              <pre
                style={{
                  background: "#0b1522",
                  borderRadius: 18,
                  color: "#dbeafe",
                  margin: 0,
                  overflowX: "auto",
                  padding: 18,
                }}
              >
                <code>{`sudo apt-get update
sudo apt-get install -y graphviz
dot -V

python -m pip install networkx
python - <<'PY'
import graphviz, networkx
print("ready")
PY`}</code>
              </pre>
            </div>
          </Col>
          <Col xs={24} lg={11}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Install, verify, and document what changed
              </Title>
              <Paragraph style={{ margin: 0 }}>
                The useful workflow is not “make the error disappear.” It is
                diagnose, install narrowly, verify directly, and leave a short
                note or setup script that the next collaborator can understand.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Codex is especially good at this kind of Linux work: it can read
                the exact error, choose the right layer, run the command, and
                check that the package or binary is really available.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <RootFsFlow />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Build course and team environments once
            </Title>
            <Paragraph style={{ margin: 0 }}>
              RootFS images let an instructor, team lead, or site admin turn a
              configured Linux environment into something reusable. Install the
              right packages, include data or tools, publish a version, then use
              it as the base for many projects.
            </Paragraph>
            <BulletList
              items={[
                "Give every student the same packages and data from the start.",
                "Use a known-good template across a research group.",
                "Publish upgraded images instead of repeating manual setup.",
              ]}
            />
            <Button href={`${GUIDE_BASE}/rootfs-management/`}>
              RootFS guide
            </Button>
          </PublicSection>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Linux is shared project infrastructure
            </Title>
            <Paragraph style={{ margin: 0 }}>
              The shell, notebooks, LaTeX builds, local services, app previews,
              SSH workflows, project secrets, snapshots, and backups all live
              around the same Linux environment.
            </Paragraph>
            <BulletList
              items={[
                "Run databases and local services beside notebooks.",
                "Use terminals and SSH workflows from the browser.",
                "Let Codex inspect files and terminal context while it helps.",
              ]}
            />
          </PublicSection>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={14}>
            <Title level={3} style={{ margin: 0 }}>
              A Linux environment is the foundation for the rest of CoCalc
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Notebooks, LaTeX, course workflows, coding agents, terminals, and
              local services become more useful because they sit on top of a
              real project-local Linux system rather than a fixed single-purpose
              UI.
            </Paragraph>
            <Flex wrap gap={12}>
              <Button href={appPath("features/terminal")}>
                Linux terminal
              </Button>
              <Button href={appPath("features/jupyter-notebook")}>
                Jupyter notebooks
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
                borderRadius: 24,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.12)",
                color: "#fff",
                padding: 26,
              }}
            >
              <Title level={4} style={{ color: "#fff", margin: "0 0 10px" }}>
                Start using CoCalc
              </Title>
              <Paragraph style={{ color: "rgba(255,255,255,0.78)" }}>
                Open a project, launch a terminal, and install the software your
                work actually needs.
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
