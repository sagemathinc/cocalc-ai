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
  CodeBlock,
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
const MIDDLE_SECTION_SPACER_STYLE = { marginTop: 12 } as const;

function LinuxEvidencePanel() {
  return (
    <div
      aria-label="Illustration of a CoCalc Linux project with sudo, apt, files, and notebooks"
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
        <Flex align="center" gap={10}>
          <IconBadge accent="#096dd9" icon="linux" />
          <div>
            <Text strong>project Ubuntu environment</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              files, system packages, services, and tools
            </div>
          </div>
        </Flex>
        <TerminalMock
          title="install.term"
          rows={[
            "$ sudo apt-get update",
            "$ sudo apt-get install -y graphviz",
            "$ dot -V",
            "graphviz version reported",
          ]}
        />
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
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="top">
          <Col xs={24} lg={14}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                A Linux workspace you can actually administer.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Install software, run services, and keep the environment
                reproducible with the project.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Teammates see how it was set up and return to a known-good
                state.
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
          <Col xs={24} lg={10}>
            <ContextList
              accent="#096dd9"
              items={[
                { icon: "linux", label: "Ubuntu project environment" },
                { icon: "terminal", label: "sudo and apt package installs" },
                { icon: "server", label: "Services run beside files" },
                { icon: "history", label: "Snapshots mark known-good states" },
              ]}
              title="Project Linux"
            />
          </Col>
        </Row>
      </PublicSection>

      <Row className="cocalc-linux-story-row" gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <StoryCard icon="linux" title="Administer Ubuntu packages">
            Use apt for command-line tools, system libraries, compilers, and
            services in the same project where notebooks and scripts run.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent="#278c83"
            icon="server"
            title="Run services beside the work"
          >
            Start a local web app, database helper, or background process from
            the project terminal and keep its files, logs, and notes nearby.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent="#ad6800"
            icon="history"
            title="Return to known-good states"
          >
            Take snapshots before risky changes, keep setup notes with the
            files, and make it clear what changed before the next handoff.
          </StoryCard>
        </Col>
      </Row>

      <div style={MIDDLE_SECTION_SPACER_STYLE}>
        <PublicSection>
          <Row gutter={[24, 24]} align="middle">
            <Col xs={24} lg={12}>
              <LinuxEvidencePanel />
            </Col>
            <Col xs={24} lg={12}>
              <Flex vertical gap={12}>
                <Title level={3} style={{ margin: 0 }}>
                  Install, verify, and document what changed
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  The useful workflow is not "make the error disappear." It is
                  diagnose, install only what is needed, verify directly, and
                  leave a short note or setup script that the next collaborator
                  can understand.
                </Paragraph>
                <Paragraph style={{ margin: 0 }}>
                  A shell-capable agent like Codex can help read the exact
                  error, suggest the right layer, and propose a command or
                  verification check. You decide what runs, and the work stays
                  in the project where your team can see, adjust, and document
                  it.
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
          </Row>
        </PublicSection>
      </div>

      <div style={MIDDLE_SECTION_SPACER_STYLE}>
        <PublicSection>
          <Row gutter={[24, 24]} align="middle">
            <Col xs={24} lg={12}>
              <Flex vertical gap={12}>
                <Title level={3} style={{ margin: 0 }}>
                  Work at the right software layer
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Not every dependency belongs in the same place. Keep Ubuntu
                  packages, language packages, scripts, and verification
                  commands visible in the project so collaborators know which
                  layer fixed the problem.
                </Paragraph>
                <BulletList
                  items={[
                    "Use apt when a notebook needs an operating-system library or command-line tool.",
                    "Use pip, conda, R, Julia, Octave, npm, pnpm, TeX, or language-specific package managers where the code runs.",
                    "Keep logs and setup scripts beside the files they support.",
                  ]}
                />
              </Flex>
            </Col>
            <Col xs={24} lg={12}>
              <CodeBlock
                ariaLabel="Linux package installation and verification commands"
                code={`sudo apt-get update
sudo apt-get install -y graphviz
dot -V

python -m pip install networkx
python - <<'PY'
import graphviz, networkx
print("ready")
PY`}
              />
            </Col>
          </Row>
        </PublicSection>
      </div>

      <div style={MIDDLE_SECTION_SPACER_STYLE}>
        <PublicSection>
          <Row gutter={[24, 24]} align="top">
            <Col xs={24} lg={13}>
              <Flex vertical gap={12}>
                <Title level={3} style={{ margin: 0 }}>
                  Build course and team environments once
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Reusable environment images let a team lead, lab admin, or
                  instructor turn a configured Linux environment into a base for
                  many projects. Install the right packages, include data or
                  tools, and publish upgraded versions instead of repeating
                  setup by hand.
                </Paragraph>
                <BulletList
                  items={[
                    "Give every student the same packages and data from the start.",
                    "Use a known-good template across a research group.",
                    "Publish upgraded images instead of repeating manual setup.",
                  ]}
                />
              </Flex>
            </Col>
            <Col xs={24} lg={11}>
              <ContextList
                accent="#278c83"
                items={[
                  { icon: "copy", label: "Start projects from a template" },
                  { icon: "database", label: "Include data and tools" },
                  { icon: "upload", label: "Publish upgraded versions" },
                  { icon: "file", label: "Keep setup notes nearby" },
                ]}
                title="Reusable environments"
              />
            </Col>
          </Row>
        </PublicSection>
      </div>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project, launch a terminal, and install the software your work actually needs.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Ready to use Linux in CoCalc?",
          }}
          relatedLinks={[
            { href: appPath("features/terminal"), label: "Linux terminal" },
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            {
              href: `${GUIDE_BASE}/software-install/`,
              label: "Software install guide",
            },
            {
              href: `${GUIDE_BASE}/rootfs-management/`,
              label: "Environment image guide",
            },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="Choose the Linux path that fits"
        >
          <BulletList
            items={[
              "Use project Linux when notebooks, LaTeX, local services, terminals, and setup notes need one environment.",
              "Use reusable images when courses or teams need the same packages and data from the start.",
              "Compare operating models when procurement, licensing, or deployment control matters.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
