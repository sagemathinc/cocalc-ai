/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { CodeBlock } from "@cocalc/frontend/public/common";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { COLORS } from "@cocalc/util/theme";
import {
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  LinkButton,
} from "./page-components";
import { FEATURE_ACCENTS } from "./feature-accents";
import { FeatureInfo, FeatureInfoHeading } from "./feature-info";
import { ContextList, FeatureFinalBand } from "./feature-visuals";

const { Paragraph, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
const LINUX_INSTALL_LAYERS = [
  { icon: "linux", label: "apt for system-wide tools" },
  { icon: "python", label: "uv, pip, and conda for Python" },
  { icon: "code", label: "npm, R, Julia, and TeX managers" },
  { icon: "robot", label: "Codex picks the layer with you" },
] satisfies { icon: IconName; label: string }[];

const LINUX_FEATURE_CSS = `
  .cocalc-linux-final-band .cocalc-feature-final-panel {
    margin: 0 auto;
    max-width: 420px;
  }
`;

function LinuxInstallLayersGrid() {
  return (
    <div>
      <strong
        style={{
          color: PUBLIC_COLORS.heading,
          display: "block",
          margin: "0 0 12px",
        }}
      >
        Install layers
      </strong>
      <div
        className="cocalc-linux-reusable-grid"
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        }}
      >
        {LINUX_INSTALL_LAYERS.map(({ icon, label }) => (
          <div
            className="cocalc-linux-reusable-grid-item"
            key={label}
            style={{
              alignItems: "center",
              background: `${FEATURE_ACCENTS.linuxSecondary}0f`,
              border: `1px solid ${FEATURE_ACCENTS.linuxSecondary}26`,
              borderRadius: PUBLIC_RADIUS.panel,
              display: "flex",
              gap: 10,
              minHeight: 64,
              padding: "10px 12px",
            }}
          >
            <Icon
              name={icon}
              style={{
                color: FEATURE_ACCENTS.linuxSecondary,
                flex: "0 0 auto",
                fontSize: 17,
              }}
            />
            <strong style={{ color: PUBLIC_COLORS.heading }}>{label}</strong>
          </div>
        ))}
      </div>
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
    : featureSignUpPath("code");
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start using CoCalc Linux";

  return (
    <Flex vertical gap={36}>
      <style>{LINUX_FEATURE_CSS}</style>
      <PublicSection>
        <Row align="top" gutter={[44, 32]} style={{ padding: "22px 0 14px" }}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={20}>
              <Title level={2} style={{ margin: 0, maxWidth: 760 }}>
                A complete Linux environment in your browser.
              </Title>
              <Paragraph
                style={{ fontSize: PUBLIC_TYPE.lead, margin: 0, maxWidth: 720 }}
              >
                Hosted CoCalc projects provide a Linux environment with a
                persistent home directory, terminals, SSH, and web services.
                Choose a software image for your work, then start the project.
                Available tools and storage policies depend on that environment.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={`${GUIDE_BASE}/software-install/`}>
                  Software install guide
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ContextList
              accent={FEATURE_ACCENTS.linux}
              items={[
                { icon: "linux", label: "Ubuntu-based project environment" },
                { icon: "wrench", label: "Install tools inside the project" },
                {
                  icon: "history",
                  label: "Configurable snapshot retention",
                },
                { icon: "network-wired", label: "SSH, scp, and rsync access" },
              ]}
              title="Project Linux"
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <FeatureInfoHeading
          anchor="a-overview"
          description={
            <>
              Editors, terminals, notebooks, and web apps in a project all run
              on the same Linux system. Here is what that system gives you.
            </>
          }
        >
          Your project tools share one Linux environment
        </FeatureInfoHeading>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_BLUE}
          anchor="a-environment"
          icon="linux"
          title="An Ubuntu-based environment for your project"
        >
          <Paragraph>
            The CoCalc Basic image provides an Ubuntu-based userland with bash,
            Git, curl, and Python. On an Ubuntu-based image, use{" "}
            <code>sudo apt-get install</code> to add system libraries and build
            tools. Open a <a href={appPath("features/terminal")}>terminal</a> to
            work with them. Other images can use different package managers;
            check the selected image before copying installation commands.
          </Paragraph>
          <Paragraph>
            The system itself is switchable: pick{" "}
            <strong>a ready-made software environment</strong> with Python,
            SageMath, R, Julia, or TeX Live preinstalled. Administrators can
            also select compatible OCI images through advanced controls. Managed
            base layers are shared and read-only and do not use project disk
            quota; writable project files and installed changes do.
          </Paragraph>
          <Paragraph>
            <LinkButton href={appPath("features/software-environment")}>
              Learn about software environments
            </LinkButton>
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.RUN}
          anchor="a-root"
          icon="wrench"
          title="Root access with sudo, and installs that persist"
        >
          <Paragraph>
            On images with sudo enabled, <strong>passwordless sudo</strong> lets
            you install system packages inside a hosted project's container.
            This is access to the project environment, not administration of its
            host machine. Package availability depends on the image and its
            repositories. Save work and check your recovery points before
            changing system software.
          </Paragraph>
          <Paragraph>
            System-level installs land in a <strong>per-project overlay</strong>{" "}
            on top of the read-only base image. Together with packages in your
            persistent home directory, they survive normal restarts and are
            included in project backups and moves. Files in <code>/tmp</code>{" "}
            and host-shared <code>/scratch</code> have different lifetimes and
            are not substitutes for persistent project storage.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_PURPLE}
          anchor="a-workflow"
          icon="code"
          imageComponent={
            <CodeBlock
              ariaLabel="Linux package installation, service check, and verification commands"
              code={`# Use an Ubuntu-based image with Python 3.
sudo apt-get update
sudo apt-get install -y graphviz python3-venv
dot -V
# graphviz version reported

python3 -m venv .venv-linux-example
.venv-linux-example/bin/python -m pip install graphviz networkx
.venv-linux-example/bin/python - <<'PY'
import graphviz, networkx
print("ready")
PY

mkdir -p /tmp/cocalc-svc
cd /tmp/cocalc-svc
echo ok > index.html
python3 -m http.server 8000 --bind 127.0.0.1 &
SERVER_PID=$!
curl --fail --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8000/
kill "$SERVER_PID"`}
            />
          }
          title="Install at any layer, and fix problems with Codex"
        >
          <Paragraph>
            Choose an installation method for the selected image and
            interpreter: system packages via apt, language packages where the
            code runs, or a per-repository setup such as a uv environment
            defined in a Git repo, which stays in that repo. When an install
            fails, the <a href={appPath("features/ai")}>Codex coding agent</a>{" "}
            runs in the same project: it reads the exact error, suggests or
            applies the fix, and you decide what runs.
          </Paragraph>
          <BulletList
            items={[
              <>
                Use <code>sudo apt-get update</code> and{" "}
                <code>sudo apt-get install</code> for OS libraries and
                command-line tools.
              </>,
              "Use uv, pip, conda, R, Julia, npm, pnpm, TeX, or other language package managers where the code runs.",
            ]}
          />
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_ORANGE}
          anchor="a-snapshots"
          icon="history"
          title="Snapshots and backups with configurable retention"
        >
          <Paragraph>
            When enabled, rolling <strong>snapshots of project files</strong>{" "}
            use configurable frequent, daily, weekly, and monthly retention.
            Scheduling and storage limits can delay or prevent a snapshot, so
            check its timestamp. Browse retained snapshots in the read-only{" "}
            <code>.snapshots</code> folder and copy out a file when needed.
            Whole-project snapshot restoration stops the runtime and creates a
            safety snapshot before replacing the selected files or environment.
          </Paragraph>
          <Paragraph>
            Completed <strong>backups stored off the project host</strong>{" "}
            provide recovery points if the machine fails. Changes made after the
            latest successful backup may be lost. TimeTravel adds edit history
            for supported collaborative editors; it is not a backup of every
            filesystem change or running process.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_RED}
          anchor="a-servers"
          icon="server"
          title="Run web apps and services"
        >
          <Paragraph>
            Start an HTTP development server, then inspect the project's Apps
            panel for <strong>detected running HTTP apps</strong>. Turn a
            detected server into an app entry and open its proxied project URL.
            Some servers need a configured base path or websocket settings;
            check the app's readiness and logs if it does not open correctly.
          </Paragraph>
          <Paragraph>
            An app can also be <strong>defined up front</strong>, with its
            command and port. Enable its wake policy when requests should start
            a stopped app. Images with the corresponding software and app
            definitions offer launchers for JupyterLab, VS Code, Pluto, or an R
            IDE. Managed app URLs remain private to project collaborators;
            deploy production or anonymous applications to a dedicated hosting
            provider.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_R_BLUE}
          anchor="a-ssh"
          icon="network-wired"
          title="SSH, scp, and rsync"
        >
          <Paragraph>
            Configure SSH access to a hosted project and{" "}
            <strong>connect from your own terminal</strong>: run remote
            commands, forward ports, and copy files with <code>scp</code>,{" "}
            <code>sftp</code>, or <code>rsync</code>.
          </Paragraph>
          <Paragraph>
            Projects can also <strong>SSH into each other</strong>, which makes
            it easy to move data between projects or drive one project from
            another.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_BLUE}
          anchor="a-monitoring"
          icon="tachometer-alt"
          title="Know what the machine is doing"
        >
          <Paragraph>
            Project settings show <strong>live memory and CPU usage</strong>{" "}
            against your limits, and a process view lists every running process
            with CPU and memory trends. Warnings appear when the project gets
            close to its memory limit.
          </Paragraph>
          <Paragraph>
            Need a bigger machine?{" "}
            <strong>Move the project to a larger host</strong>, including GPU
            hosts with compatible GPU images. A move stops the runtime and
            transfers backed-up files and software. Temporary files and previous
            host-local snapshots do not move; check backup freshness,
            destination access, and the required hardware before moving
            important work.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <div className="cocalc-linux-final-band">
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
                href: appPath("features/software-environment"),
                label: "Software environments",
              },
              {
                href: `${GUIDE_BASE}/rootfs-management/`,
                label: "Environment image guide",
              },
              { href: appPath("products"), label: "Compare operating models" },
              ...(helpEmail
                ? [{ href: `mailto:${helpEmail}`, label: "Contact support" }]
                : []),
            ]}
            title="Install software the right way, on the right layer"
          >
            <Paragraph style={{ margin: 0 }}>
              System-wide with apt, per language with uv, pip, conda, npm, or
              the R, Julia, and TeX package managers, per Git repository, or per
              user: choose the tools supported by your environment. A coding
              agent like Codex can help choose a method and investigate errors.
            </Paragraph>
            <LinuxInstallLayersGrid />
          </FeatureFinalBand>
        </div>
      </PublicSection>
    </Flex>
  );
}
