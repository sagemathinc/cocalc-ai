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

export default function JuliaFeaturePage({
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
                JULIA
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Use Julia in notebooks, terminals, and project workflows
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc supports Julia across collaborative notebooks, terminals,
                and teaching workflows, with the option to launch Pluto as well
                when that better fits the task.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This makes Julia practical in the browser without giving up the
                broader project environment around the language.
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
              alt="Julia in a Jupyter notebook"
              src="/public/features/julia-jupyter.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Multiple ways to work with Julia
            </Title>
            <BulletList
              items={[
                "CoCalc's collaborative Jupyter notebooks.",
                "Terminal-based Julia workflows in the same project.",
                "Graphical or richer workflows through X11 when needed.",
                "Pluto notebooks for reactive Julia-specific work.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              The right interface depends on the task, and CoCalc gives you that
              flexibility without moving to a different platform.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Benefits of working online
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Collaborative projects, persistent files, shared environments, and
              reduced setup friction matter just as much for Julia as for other
              technical languages.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              This is particularly helpful in courses or research groups where a
              common, reusable Julia environment saves time.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Pluto notebook running on CoCalc"
              src="/public/features/pluto-plot.png"
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
                Pluto support
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Launch Pluto when reactive notebooks are the right fit
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc projects can run Pluto notebook servers, which is useful
                when you want Julia's reactive notebook model rather than a
                classical Jupyter workflow.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That gives Julia users a broader range of notebook styles while
                still keeping the work inside the same project.
              </Paragraph>
              <LinkButton href="https://doc.cocalc.com/howto/pluto.html">
                Pluto on CoCalc
              </LinkButton>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Teaching Julia with nbgrader"
              src="/public/features/julia-nbgrader.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Julia in teaching workflows
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc&apos;s course management system and nbgrader support also
              apply to Julia notebooks, which makes Julia viable in structured
              course settings rather than just in personal research projects.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Collaborative Julia code editing"
              src="/public/features/julia-code.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Collaborative code and terminal workflows
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Edit Julia files collaboratively, run code in a terminal next to
              the editor, and keep chat and project context close by.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That is useful for pair work, support, and research collaboration.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why use Julia on CoCalc
        </Title>
        <BulletList
          items={[
            "Notebook, terminal, and Pluto workflows in one project.",
            "Shared environments for classes and collaborators.",
            "Course tooling and nbgrader support around Julia.",
            "A practical browser-based setup for technical Julia work.",
          ]}
        />
        <Flex wrap gap={12}>
          <Button href={appPath("features/x11")}>Graphical desktop</Button>
          <Button href={appPath("features/teaching")}>Teaching</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
