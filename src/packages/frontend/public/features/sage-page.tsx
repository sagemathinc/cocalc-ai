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

export default function SageFeaturePage({ helpEmail }: { helpEmail?: string }) {
  return (
    <Flex vertical gap={18}>
      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Text strong type="secondary">
                SAGEMATH
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Use SageMath online in the environment built by the same team
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc has deep SageMath support across notebooks, terminals,
                teaching workflows, and technical documents.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That makes it practical both for research and for teaching
                courses where asking everyone to build and maintain Sage locally
                is a significant burden.
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
              alt="SageMath in a Jupyter notebook"
              src="/public/features/sagemath-jupyter.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Why SageMath fits naturally in CoCalc
            </Title>
            <BulletList
              items={[
                "Notebook workflows for exploratory mathematics and teaching.",
                "Terminal workflows for `.sage` files and command-line use.",
                "Document workflows through SageTeX and LaTeX integration.",
                "Course tooling and nbgrader support around Sage-based assignments.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              The value is not only that Sage runs remotely. It is that the rest
              of the collaborative environment is already built around it.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Lower setup cost for classes and collaborators
            </Title>
            <Paragraph style={{ margin: 0 }}>
              SageMath is powerful, but it is also large and not always
              straightforward to install or maintain locally. CoCalc removes
              that friction while keeping files private, persistent, and shared
              inside projects.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That is especially helpful in courses where students should focus
              on the mathematics rather than on local package management.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="SageTeX inside a LaTeX document"
              src="/public/features/cocalc-sagemath-sagetex.png"
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
                Document workflows
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                SageMath in LaTeX via SageTeX
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc&apos;s LaTeX environment makes it practical to embed
                SageMath computations directly into technical documents.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That avoids the brittle workflow of manually copying results out
                of a worksheet and into a paper or handout.
              </Paragraph>
              <LinkButton href="https://doc.cocalc.com/latex.html#sage">
                SageTeX documentation
              </LinkButton>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="SageMath with nbgrader"
              src="/public/features/sage-nbgrader.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Teach SageMath with course tooling
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc&apos;s course management system and nbgrader workflows work
              well with SageMath notebooks, which is important for graded
              technical assignments and interactive lab work.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That means SageMath can be part of a real teaching workflow, not
              just a standalone compute tool.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Use SageMath the way your project needs
            </Title>
            <Paragraph style={{ margin: 0 }}>
              You can work in notebooks, the terminal, or documents depending on
              the task. CoCalc is strong here because these are not separate
              products glued together afterward.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              Collaboration, chat, history, and support workflows remain
              available whichever interface you use.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why use SageMath on CoCalc
        </Title>
        <BulletList
          items={[
            "Lower setup friction for students and collaborators.",
            "Strong notebook, terminal, teaching, and LaTeX integration.",
            "A remote environment with collaboration and history built in.",
            "A SageMath workflow maintained by the same team that built CoCalc.",
          ]}
        />
        <Flex wrap gap={12}>
          <Button href={appPath("features/latex-editor")}>LaTeX editor</Button>
          <Button href={appPath("features/teaching")}>Teaching</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
