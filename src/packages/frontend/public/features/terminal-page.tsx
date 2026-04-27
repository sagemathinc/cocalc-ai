/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import { PublicSectionCard } from "@cocalc/frontend/public/layout/shell";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  FeatureImage,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

export default function TerminalFeaturePage({
  helpEmail,
}: {
  helpEmail?: string;
}) {
  return (
    <Flex vertical gap={18}>
      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Text strong type="secondary">
                ONLINE LINUX TERMINAL
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                A real Linux shell inside every project
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                Use a collaborative Linux terminal directly in the browser, next
                to your notebooks, editors, documents, and chat. You get a
                practical remote shell without turning every student or
                collaborator into their own system administrator.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This is one of CoCalc&apos;s core advantages: the terminal is
                not a disconnected extra. It lives in the same project as the
                files and services it operates on.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <LinkButton href="https://doc.cocalc.com/terminal.html">
                  Terminal documentation
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="Linux terminal running in CoCalc"
              src="/public/features/terminal.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Realtime collaboration in the shell
            </Title>
            <BulletList
              items={[
                "Open the same terminal with collaborators and watch the same session update live.",
                "Pair on installations, debugging, and command-line workflows without screen sharing.",
                "Keep a side chat nearby for questions, pasted output, and coordination.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This is especially useful in teaching, mentoring, and support
              sessions, where someone else can drop into the exact shell you are
              using instead of trying to reconstruct it from screenshots.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Two users collaborating in a shared terminal"
              src="/public/features/cocalc-terminal-collab.gif"
            />
            <Title level={3} style={{ margin: 0 }}>
              Shared view, shared context
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Because the terminal lives inside the project, the same files,
              notebooks, environment, and running services are immediately
              available to everyone with access.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Editing a shell script and running it in a terminal"
              src="/public/features/cocalc-shell-script-run.png"
            />
          </Col>
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Tag
                color="blue"
                style={{
                  alignSelf: "flex-start",
                  background: COLORS.ANTD_BG_BLUE_L,
                  color: COLORS.BLUE_D,
                }}
              >
                Script and automation workflows
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Edit and run scripts side by side
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc&apos;s editors and frame layout make it easy to keep a
                shell next to the files you are editing. Write a Python, Bash,
                R, or Julia script in one pane and run it in the terminal in the
                next.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That keeps the basic edit-run-debug loop tight, without asking
                users to manage a separate local machine just to execute code.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Popular software available in CoCalc terminals"
              src="/public/features/terminal-software.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Broad software stack
            </Title>
            <Paragraph style={{ margin: 0 }}>
              The terminal is useful because it comes with a large technical
              software base already in place: shells, editors, compilers,
              interpreters, Git, and language-specific tooling for scientific
              and engineering work.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              And if the default stack is not enough, the broader CoCalc/Linux
              workflow now increasingly supports installing and reusing custom
              environments instead of treating the server image as fixed.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Practical reasons teams use it
            </Title>
            <BulletList
              items={[
                "Keep long-running commands on the remote project instead of tying them to one laptop.",
                "Use the same shell environment in teaching and support that students or collaborators see.",
                "Run command-line tooling next to notebooks, LaTeX, APIs, and local web services.",
                "Avoid local setup drift across a team.",
              ]}
            />
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Terminal workflows connect to the rest of CoCalc
        </Title>
        <Paragraph style={{ margin: 0 }}>
          The terminal is only part of the story. It becomes far more useful
          because it lives next to Jupyter notebooks, file editors, chat, course
          workflows, and app servers. That combination is why CoCalc can act
          like a real technical workspace instead of just a browser shell.
        </Paragraph>
        <Flex wrap gap={12}>
          <Button href={appPath("features/linux")}>Linux environment</Button>
          <Button href={appPath("features/jupyter-notebook")}>
            Jupyter notebooks
          </Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
