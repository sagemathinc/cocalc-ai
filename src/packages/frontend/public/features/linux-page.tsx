/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_COLORS,
  PUBLIC_DARK,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
  LinkButton,
} from "./page-components";
import { IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

function LinuxWorkspaceMock() {
  const commands = [
    "$ sudo apt-get update",
    "$ sudo apt-get install -y graphviz",
    "$ dot -V",
    "graphviz version reported",
  ];
  return (
    <div
      aria-label="Illustration of a CoCalc Linux project with sudo, apt, files, and notebooks"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 58%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
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
                files, system packages, services, and tools
              </div>
            </div>
          </Flex>
        </Flex>
        <Row gutter={[14, 14]} align="stretch">
          <Col xs={24} md={15}>
            <div
              style={{
                background: PUBLIC_DARK.terminalSurface,
                borderRadius: PUBLIC_RADIUS.panel,
                color: PUBLIC_DARK.mockText,
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
                {[
                  PUBLIC_DARK.dotRed,
                  PUBLIC_DARK.dotAmber,
                  PUBLIC_DARK.dotGreen,
                ].map((color) => (
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
                <Text style={{ color: PUBLIC_DARK.mockText, marginLeft: 8 }}>
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
                      color: command.startsWith("$")
                        ? PUBLIC_DARK.mockTextDim
                        : PUBLIC_DARK.mockTextAlt,
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
                    background: PUBLIC_COLORS.surface,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PUBLIC_RADIUS.panel,
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
      title: "System packages",
    },
  ] satisfies { body: string; icon: IconName; title: string }[];
  return (
    <div
      style={{
        background:
          "linear-gradient(145deg, #fff 0%, #f6fbff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
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
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PUBLIC_RADIUS.panel,
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

export default function LinuxFeaturePage({
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
              <Title level={2} style={{ margin: 0 }}>
                A Linux workspace you can actually administer.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                CoCalc projects are Ubuntu environments where you can use
                terminals, notebooks, editors, services, and <code>sudo</code>{" "}
                in the browser. Install software, edit configuration, run
                servers, and keep the environment with the project.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                A research or engineering team can stand up a real Ubuntu
                environment for analysis, builds, and local services. Because
                the environment lives in the project, teammates can see how it
                was set up and return to a known-good state instead of
                rebuilding it.
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

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Learn and use Linux without risking your own machine
              </Title>
              <Paragraph style={{ margin: 0 }}>
                A researcher or engineer can try a system install — new packages
                with <code>apt</code>, services, or compilers — without
                corrupting their daily driver. A student can learn shells,
                permissions, Python environments, and Git without turning their
                laptop into the course experiment.
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
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                padding: 24,
              }}
            >
              <pre
                style={{
                  background: PUBLIC_DARK.terminalSurface,
                  borderRadius: PUBLIC_RADIUS.panel,
                  color: PUBLIC_DARK.mockText,
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
                diagnose, install only what is needed, verify directly, and
                leave a short note or setup script that the next collaborator
                can understand.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Codex can read the exact error, choose the right layer, run the
                command, and verify that the package or binary is available.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Build course and team environments once
        </Title>
        <Paragraph style={{ margin: 0, maxWidth: 820 }}>
          Reusable environment images let an instructor, team lead, or site
          admin turn a configured Linux environment into a base for many
          projects. Install the right packages, include data or tools, and
          publish upgraded versions instead of repeating setup by hand.
        </Paragraph>
        <BulletList
          items={[
            "Give every student the same packages and data from the start.",
            "Use a known-good template across a research group.",
            "Publish upgraded images instead of repeating manual setup.",
          ]}
        />
        <Button href={`${GUIDE_BASE}/rootfs-management/`}>
          Environment image guide
        </Button>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={14}>
            <Title level={3} style={{ margin: 0 }}>
              Choose the Linux path that fits
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
              <Button
                href={featureSupportPath({
                  body: "I want to discuss CoCalc Linux environments. Helpful context: software stack, teaching or research use case, expected users, and whether a hosted or customer-operated product path is being evaluated.",
                  context: "linux",
                  subject: "CoCalc Linux environments",
                  title: "Ask CoCalc about Linux environments",
                })}
              >
                Ask about Linux environments
              </Button>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <div
              className="cocalc-feature-final-panel"
              style={{
                background: PUBLIC_COLORS.surfaceMuted,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.12)",
                color: PUBLIC_COLORS.heading,
                padding: 26,
              }}
            >
              <Title
                level={3}
                style={{ color: PUBLIC_COLORS.heading, margin: "0 0 10px" }}
              >
                Ready to use Linux in CoCalc?
              </Title>
              <Paragraph style={{ color: PUBLIC_COLORS.mutedText }}>
                Open a project, launch a terminal, and install the software your
                work actually needs.
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
