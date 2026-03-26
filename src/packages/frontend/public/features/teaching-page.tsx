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

export default function TeachingFeaturePage({
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
                TEACHING AND COURSES
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Run a technical course on shared infrastructure instead of
                troubleshooting everyone&apos;s laptop
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc gives instructors an online computer lab with course
                management, collaborative help, notebook grading, and the same
                software environment for every student.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                The point is not just that students can open a notebook in the
                browser. It is that distribution, collection, grading, support,
                and live troubleshooting happen in the same system.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <LinkButton href="https://doc.cocalc.com/teaching-instructors.html">
                  Teaching documentation
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="CoCalc course assignment management"
              src="/public/features/cocalc-course-assignments-2019.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              An entire computer lab in the cloud
            </Title>
            <BulletList
              items={[
                "Every student works inside a consistent online workspace.",
                "Instructors and TAs can jump directly into student files when help is needed.",
                "TimeTravel and project activity make it possible to understand how students got to a result, not only what they submitted.",
                "Integrated chat keeps questions and answers close to the actual work.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This changes office hours and lab support dramatically because the
              student and instructor are looking at the same live environment.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              No software setup on student machines
            </Title>
            <BulletList
              items={[
                "Everyone gets the same software stack from the start.",
                "Jupyter, terminals, Python, R, Julia, SageMath, LaTeX, and more are already in the environment.",
                "Instructors avoid the recurring cost of fixing installation drift across dozens or hundreds of laptops.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This is one of the main reasons CoCalc works well for technical
              courses: it eliminates the slowest and most frustrating part of
              getting started.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Diagram of course workflows in CoCalc"
              src="/public/features/cocalc-teaching.png"
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
                Assignment workflow
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Distribute, collect, grade, and return work
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc includes course-management tools that keep track of
                assignments and student work across the full teaching cycle.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Instead of building a workflow out of loosely connected tools,
                you can manage notebooks, code, documents, and grading in the
                same environment where students are already working.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="nbgrader workflow in CoCalc"
              src="/public/features/cocalc-jupyter-nbgrader-overview.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Notebook grading and nbgrader support
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc supports grading workflows for notebook-based assignments,
              including automatic checks, hidden tests, and the broader
              instructor tooling needed around them.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That makes notebook teaching practical at scale rather than a
              collection of manual ad hoc steps.
            </Paragraph>
            <LinkButton href="https://doc.cocalc.com/teaching-nbgrader.html">
              nbgrader documentation
            </LinkButton>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Help students in context
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Because instructors and TAs can enter the same project, help does
              not require a separate screen-share workflow. You can see the same
              file, terminal, notebook, and history that the student sees.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              This is useful for debugging, grading disputes, support during
              labs, and understanding whether a student is stuck because of the
              math, the code, or the environment.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Built for technical courses, not just generic LMS uploads
        </Title>
        <Paragraph style={{ margin: 0 }}>
          CoCalc is strongest when a course needs executable notebooks,
          command-line tools, documents, collaborative help, and a consistent
          technical environment all at once. That is a different problem from a
          generic learning-management system, and it is why the teaching
          workflow has remained a core part of the product.
        </Paragraph>
        <Flex wrap gap={12}>
          <Button href={appPath("features/jupyter-notebook")}>
            Jupyter notebooks
          </Button>
          <Button href={appPath("features/terminal")}>Linux terminal</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
