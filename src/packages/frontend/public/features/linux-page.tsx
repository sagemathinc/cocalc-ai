/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import { PublicSectionCard } from "@cocalc/frontend/public/ui/shell";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  FeatureImage,
  featureAppPath as appPath,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

export default function LinuxFeaturePage({
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
                ONLINE LINUX ENVIRONMENT
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                A browser-based Linux workspace for real technical projects
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc projects behave like collaborative Linux environments
                with files, terminals, notebooks, databases, and web-accessible
                services in one place.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That makes Linux accessible for learning and teaching, but it is
                also practical for serious work that needs a remote environment
                without turning every collaborator into their own DevOps team.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <Button href={appPath("features/terminal")}>
                  Terminal details
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="Editing and running a shell script in CoCalc"
              src="/public/features/cocalc-shell-script-run.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Learn and use Linux without risking your own machine
            </Title>
            <BulletList
              items={[
                "Everything runs remotely inside the project instead of on a local laptop.",
                "Students and collaborators get a consistent Linux environment from the start.",
                "Mistakes are easier to recover from because the environment is managed, shared, and backed by project history.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              That is useful both for teaching Linux and for practical
              day-to-day project work where reproducibility matters.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Collaborative terminals in CoCalc"
              src="/public/features/cocalc-terminal-collab.gif"
            />
            <Title level={3} style={{ margin: 0 }}>
              Shared environment, not isolated sessions
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Collaborators can open the same project, access the same files,
              use the same services, and work in the same shell environment.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              This is why CoCalc works well for teaching, pair debugging, and
              research collaboration where the environment itself matters.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Using a bash kernel inside Jupyter"
              src="/public/features/cocalc-jupyter-bash.png"
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
                More than a terminal
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Use Linux tools through notebooks too
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc can also expose Linux workflows through Jupyter, such as
                the Bash kernel, which is useful for teaching shell commands,
                scripting, and command-driven analysis while keeping execution
                history in notebook cells.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                The same environment can mix terminals, notebooks, code editors,
                and documents in one project.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Running PostgreSQL inside a CoCalc project"
              src="/public/features/terminal-jupyter-postgresql.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Databases and services inside the project
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Projects can run databases and other services in the same
              protected environment as your terminals and notebooks, which is
              useful for teaching SQL, building prototypes, and running
              data-backed workflows.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              This is much easier when the shell, the service, and the notebook
              consuming it all live in the same place.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Why the Linux environment matters
            </Title>
            <BulletList
              items={[
                "Run scripts, compilers, databases, and project-local services together.",
                "Avoid local setup drift across a class or team.",
                "Keep notebooks, terminals, editors, and data in one workspace.",
                "Make complex technical workflows accessible from any modern browser.",
              ]}
            />
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          A Linux environment is the foundation for the rest of CoCalc
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Notebooks, LaTeX, course workflows, coding agents, and application
          servers all become more useful because they sit on top of a real
          project-local Linux environment rather than a fixed single-purpose UI.
        </Paragraph>
        <Flex wrap gap={12}>
          <Button href={appPath("features/jupyter-notebook")}>
            Jupyter notebooks
          </Button>
          <Button href={appPath("features/x11")}>Graphical desktop</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
