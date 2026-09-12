/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  featureAsset,
  LinkButton,
} from "./page-components";
import { FeatureInfo, FeatureInfoHeading, ZoomableImage } from "./feature-info";
import { ContextList, FeatureFinalBand } from "./feature-visuals";

const { Paragraph, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
export default function TerminalFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : featureSignUpPath("code");
  const finalCtaLabel = isAuthenticated ? "Open projects" : "Create account";

  return (
    <Flex vertical gap={36}>
      <PublicSection>
        <Row align="top" gutter={[44, 32]} style={{ padding: "22px 0 14px" }}>
          <Col xs={24} lg={14}>
            <Flex className="cocalc-terminal-hero" vertical gap={20}>
              <Title level={2} style={{ margin: 0, maxWidth: 760 }}>
                An online Linux terminal that lives in your project.
              </Title>
              <Paragraph
                style={{ fontSize: PUBLIC_TYPE.lead, margin: 0, maxWidth: 720 }}
              >
                Work in a hosted project's Linux shell from your browser, next
                to its files and collaborators. Reconnect to a live session
                while the project runtime remains running.
              </Paragraph>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ContextList
              accent="#096dd9"
              items={[
                { icon: "file", label: ".term files reopen in their folder" },
                { icon: "users", label: "Same stream for all collaborators" },
                { icon: "layout", label: "Reconnect while the runtime runs" },
                { icon: "robot", label: "Codex can inspect project context" },
              ]}
              title="Highlights"
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <div style={{ margin: "0 auto", maxWidth: 940 }}>
          <ZoomableImage
            alt="A terminal in a CoCalc project running latexmk next to the LaTeX file it compiles"
            priority
            src={featureAsset("terminal-latexmk-20260730.png")}
          />
        </div>
      </PublicSection>

      <PublicSection>
        <FeatureInfoHeading
          anchor="a-overview"
          description={
            <>
              There are many ways to use a Linux terminal online in CoCalc:
              alone, with collaborators, or together with Codex.
            </>
          }
        >
          Feature overview
        </FeatureInfoHeading>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#096dd9"
          alt="A CoCalc terminal running ordinary bash commands like find, uptime, and lscpu"
          anchor="a-real-terminal"
          icon="terminal"
          image="terminal-bash-commands-20260730.png"
          title="A full Linux terminal, no setup required"
        >
          <Paragraph>
            Open a <code>.term</code> file and you get{" "}
            <strong>a real Linux shell</strong> running in your project, not an
            emulation. Install packages, run build tools, manage Git
            repositories, and start long-running jobs from any browser.
          </Paragraph>
          <Paragraph>
            A browser disconnect does not itself terminate the backend shell.
            You can reconnect while the{" "}
            <strong>project runtime is still running</strong>. Project stops,
            restarts, failures, or a configured browser-idle timeout end running
            processes, even during a computation. Save logs and checkpoints so
            important jobs can resume.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#389e0d"
          alt="Two synchronized terminals collaborating on the same session"
          anchor="a-collaboration"
          icon="users"
          image="cocalc-terminal-collab.gif"
          title="Real-time collaboration in the shell"
        >
          <Paragraph>
            The same terminal can be opened by{" "}
            <strong>two or more people at once</strong>. All of them see the
            same live session, which adaptively resizes to a common size.
          </Paragraph>
          <Paragraph>
            Open a <strong>side chat</strong> next to the terminal to discuss
            what is happening: ideal for pair debugging, getting advice from a
            colleague, or helping a student without a screen share.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#7c3aed"
          alt="Editing a shell script side by side with a terminal running it"
          anchor="a-scripts"
          caption={
            <>
              A <code>script.sh</code> file in the editor (left) and a terminal
              running it (right): one frame, one folder.
            </>
          }
          icon="edit"
          image="cocalc-shell-script-run.png"
          title="Edit and run scripts side by side"
        >
          <Paragraph>
            CoCalc's frame editor lets you{" "}
            <strong>split a script file and a terminal</strong> into adjacent
            panes. Edit <code>.sh</code>, <code>.py</code>, <code>.r</code>, and
            other files with syntax highlighting, run them in the terminal next
            to the code, and keep a log view or a REPL in another pane.
          </Paragraph>
          <Paragraph>
            The terminal starts in the file's folder. Run{" "}
            <code>python3 script.py</code> or <code>bash script.sh</code> with
            the required interpreter and packages installed. A collaborator
            opening the same terminal can follow the live session; use output
            files when the results need to outlast it.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#ad6800"
          anchor="a-software"
          icon="server"
          title="Pick the software, install more on top"
        >
          <Paragraph>
            The software in the terminal comes from your project's{" "}
            <strong>software environment</strong>, a runtime image you pick:
            from a lean base system to full scientific stacks with Python,
            SageMath, R, Julia, TeX Live, and complete build toolchains. Switch
            the image at any time in the project settings.
          </Paragraph>
          <Paragraph>
            Need more? Use the package manager supported by the image, such as{" "}
            <code>sudo apt-get install</code> for Ubuntu system packages. Use a
            virtual environment or the selected interpreter for Python packages.
            Installs in persistent project storage survive normal restarts;
            temporary directories have a different lifetime. Command-line agents
            such as Codex can run beside the same files.
          </Paragraph>
          <Flex wrap gap={12}>
            <LinkButton href={appPath("features/software-environment")}>
              Learn about software environments
            </LinkButton>
            <LinkButton href={`${GUIDE_BASE}/software-install/`}>
              Read the software install guide
            </LinkButton>
          </Flex>
        </FeatureInfo>
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
