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
                Every CoCalc project is a full Linux system: Ubuntu-based, with
                root access, a persistent home directory, snapshots, SSH, and
                web services. Everything is already installed and running
                online, ready from the first sign-in.
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
                { icon: "wrench", label: "Passwordless sudo, apt installs" },
                {
                  icon: "history",
                  label: "Snapshots as often as every 15 min",
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
          Every project is a Linux machine
        </FeatureInfoHeading>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_BLUE}
          anchor="a-environment"
          icon="linux"
          title="A real Ubuntu-based system, not a restricted shell"
        >
          <Paragraph>
            New projects start on an Ubuntu-based image with{" "}
            <strong>a complete userland</strong>: bash, git, curl, and the
            package ecosystem of a normal Ubuntu machine behind them. Compilers
            and build tools like the gcc toolchain are one{" "}
            <code>apt-get install</code> away when you want to compile C or C++.
            Open a <a href={appPath("features/terminal")}>terminal</a> and it
            behaves like the Linux you know, because it is. That also makes it a
            safe place to practice Linux commands without risking your own
            machine.
          </Paragraph>
          <Paragraph>
            The system itself is switchable: pick{" "}
            <strong>a ready-made software environment</strong> with Python,
            SageMath, R, Julia, or TeX Live preinstalled, or bring your own OCI
            image. The base system is shared and read-only, so even a large
            scientific stack costs you nothing in storage.
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
            You are not locked out of your own system.{" "}
            <strong>Passwordless sudo</strong> works in every project, so{" "}
            <code>sudo apt-get install</code> succeeds just like on your own
            machine. Experiments cannot damage your computer, and they are
            confined to that one project: if something goes wrong, restore a
            backup or start a fresh project, and your other projects are
            unaffected.
          </Paragraph>
          <Paragraph>
            System-level installs land in a <strong>per-project overlay</strong>{" "}
            on top of the read-only base image: they survive restarts, are
            captured in snapshots and backups, and move with the project. The
            same goes for <code>pip</code>, <code>npm</code>, R, and Julia
            packages in your home directory.
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
              code={`sudo apt-get update
sudo apt-get install -y graphviz
dot -V
# graphviz version reported

python -m pip install graphviz networkx
python - <<'PY'
import graphviz, networkx
print("ready")
PY

mkdir -p /tmp/cocalc-svc
cd /tmp/cocalc-svc
echo ok > index.html
python -m http.server 8000 &
SERVER_PID=$!
curl --fail http://127.0.0.1:8000/
kill $SERVER_PID`}
            />
          }
          title="Install at any layer, and fix problems with Codex"
        >
          <Paragraph>
            There is no single right place to install software; use{" "}
            <strong>any layer that fits the use case</strong>: system packages
            via apt, language packages where the code runs, or a per-repository
            setup such as a uv environment defined in a Git repo, which stays in
            that repo. When an install fails, the{" "}
            <a href={appPath("features/ai")}>Codex coding agent</a> runs in the
            same project: it reads the exact error, suggests or applies the fix,
            and you decide what runs.
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
          title="Snapshots every 15 minutes, backups off the host"
        >
          <Paragraph>
            Rolling <strong>snapshots of your files</strong> are taken
            automatically, as often as every 15 minutes, with daily, weekly, and
            monthly tiers you can configure. You can also take one manually at
            any moment, which is worth doing right before a risky change. Browse
            snapshots as a read-only <code>.snapshots</code> folder, search
            them, and restore a single file or the whole project; a safety
            snapshot is taken before every restore.
          </Paragraph>
          <Paragraph>
            Separate <strong>backups are stored off the project host</strong>,
            so your work also survives problems with the machine itself. On top
            of that, TimeTravel records the full edit history of every document
            you edit in CoCalc.
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
            Start a development server on any port and the project's Apps panel{" "}
            <strong>lists it as a detected running HTTP app</strong>: turn it
            into an app entry with one click and open it through a project URL,
            proxied behind your login with websocket support. That covers Flask
            and Node dev servers, dashboards, documentation previews, and
            anything else that speaks HTTP.
          </Paragraph>
          <Paragraph>
            An app can also be <strong>defined up front</strong>, with its
            command and port, so CoCalc starts it and wakes it when someone
            opens the URL. The Apps panel launches JupyterLab, VS Code, Pluto,
            and an R IDE the same way. Managed app URLs remain private to
            project collaborators; deploy production or anonymous applications
            to a dedicated hosting provider.
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
            Every project runs an SSH server. Add your public key and{" "}
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
            hosts with CUDA-ready images, and keep your files, software, and
            history.
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
              user: every layer is available, and a coding agent like Codex
              helps pick the right one and runs the install with you.
            </Paragraph>
            <LinuxInstallLayersGrid />
          </FeatureFinalBand>
        </div>
      </PublicSection>
    </Flex>
  );
}
