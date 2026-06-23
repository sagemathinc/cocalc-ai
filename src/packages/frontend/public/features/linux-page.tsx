/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  CodeBlock,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";
import { FEATURE_ACCENTS } from "./feature-accents";
import { ContextList, FeatureFinalBand } from "./feature-visuals";

const { Paragraph, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

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
                Diagnose setup problems, install the missing pieces, and leave a
                trail the next person can check.
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
                { icon: "linux", label: "Ubuntu project environment" },
                { icon: "terminal", label: "sudo and apt package installs" },
                { icon: "code", label: "Language package managers" },
                { icon: "history", label: "Snapshots before risky changes" },
              ]}
              title="Project Linux"
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Install at the right layer, verify, and document what changed
              </Title>
              <Paragraph style={{ margin: 0 }}>
                The useful workflow is not "make the error disappear." Diagnose,
                install only what is needed, verify directly, and leave a short
                note or setup script. A shell-capable agent like Codex can help
                read the exact error and suggest a check, but you decide what
                runs, and the work stays in the project where your team can see,
                adjust, and document it.
              </Paragraph>
              <BulletList
                items={[
                  <>
                    Use <code>sudo apt-get update</code> and{" "}
                    <code>sudo apt-get install</code> for OS libraries and
                    command-line tools.
                  </>,
                  "Use pip, conda, R, Julia, Octave, npm, pnpm, TeX, or language-specific package managers where the code runs.",
                  "Take a snapshot before risky changes and record the setup command that made the environment work.",
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
# graphviz version reported

python -m pip install networkx
python - <<'PY'
import graphviz, networkx
print("ready")
PY`}
            />
          </Col>
        </Row>
      </PublicSection>

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
              href: `${GUIDE_BASE}/rootfs-management/`,
              label: "Environment image guide",
            },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="Choose the Linux path that fits"
        >
          <Paragraph style={{ margin: 0 }}>
            Reusable environment images let a team lead, lab admin, or
            instructor turn a configured Linux environment into a base for many
            projects instead of repeating setup by hand.
          </Paragraph>
          <ContextList
            accent={FEATURE_ACCENTS.linuxSecondary}
            items={[
              { icon: "copy", label: "Start projects from a template" },
              { icon: "database", label: "Include data and tools" },
              { icon: "upload", label: "Publish upgraded versions" },
              { icon: "file", label: "Record upgrade notes" },
            ]}
            title="Reusable environments"
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
