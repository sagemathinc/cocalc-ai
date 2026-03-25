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
  LinkButton,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

export default function OctaveFeaturePage({
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
                GNU OCTAVE
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Run Octave online in notebooks, terminals, or a graphical
                desktop
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc supports Octave through collaborative notebooks,
                terminals, and X11-based graphical workflows.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That makes Octave practical for teaching and exploratory work,
                especially when you want a browser-based alternative to local
                MATLAB-style setups.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="Octave in Jupyter on CoCalc"
              src="/public/features/cocalc-octave-jupyter-20200511.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Flexible Octave workflows
            </Title>
            <BulletList
              items={[
                "Collaborative notebook workflows with remote kernels.",
                "Terminal-based Octave usage next to edited source files.",
                "Graphical Octave workflows via X11 when a GUI is the better fit.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              Different Octave tasks need different interfaces, and CoCalc lets
              them all live in the same project.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Benefits of working online
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Students and collaborators can start with a known Octave setup,
              avoid local installation friction, and keep files and history in
              the shared project.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That is useful for teaching and for lightweight numerical work
              where a common browser-accessible environment is more practical
              than a lab full of local installs.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Octave in a terminal on CoCalc"
              src="/public/features/cocalc-octave-terminal-20200511.png"
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
                Terminal workflows
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Edit Octave files and run them side by side
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc&apos;s editor and terminal combination works well for
                `.m`-file based workflows, with TimeTravel and shared project
                history available around the files.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That is helpful for teaching, debugging, and collaborative
                numerical work.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Octave GUI running through X11"
              src="/public/features/cocalc-octave-x11-20200511.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              GUI workflows through X11
            </Title>
            <Paragraph style={{ margin: 0 }}>
              When you need a more graphical Octave workflow, CoCalc&apos;s X11
              support can expose traditional GUI applications in the browser.
            </Paragraph>
            <LinkButton href={appPath("features/x11")}>X11 desktop</LinkButton>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Interactive Octave graphics in an X11 terminal"
              src="/public/features/octave-x11-terminal.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Interactive graphics when needed
            </Title>
            <Paragraph style={{ margin: 0 }}>
              X11 terminal workflows can also make interactive graphical Octave
              sessions possible from within the same remote project.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That extends what you can do beyond a plain shell or notebook.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why use Octave on CoCalc
        </Title>
        <BulletList
          items={[
            "Notebook, terminal, and X11 workflows in one project.",
            "Lower setup friction for teaching and collaboration.",
            "A practical browser-based path for numerical computing work.",
            "Shared files, history, and chat around Octave workflows.",
          ]}
        />
        <Flex wrap gap={12}>
          <Button href={appPath("features/linux")}>Linux environment</Button>
          <Button href={appPath("features/teaching")}>Teaching</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
