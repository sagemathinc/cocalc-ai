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

export default function SlidesFeaturePage({
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
                COMPUTATIONAL SLIDES
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Present technical work with code, math, and collaboration built
                in
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc slides bring together presentation structure, executable
                content, mathematical notation, and collaborative editing in one
                browser-based workflow.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                They are useful when a presentation needs more than static text
                and images, especially in teaching and technical communication.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <Button href={appPath("features/whiteboard")}>
                  Whiteboard
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="Computational slides in CoCalc"
              src="/public/features/slides-sage.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Slides for technical subjects
            </Title>
            <BulletList
              items={[
                "Collaborative markdown and LaTeX mathematics.",
                "Jupyter code cells and widgets inside the presentation workflow.",
                "Drawing, notes, frames, and structured slide sections.",
                "Chat and collaboration in the same project as the presentation.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This makes CoCalc slides much better suited to technical teaching
              and live explanation than a conventional slide deck disconnected
              from the rest of the workflow.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Present and edit from the same workspace
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Because the slides live inside a project, you can keep notebooks,
              code, data, and supporting notes nearby. That is especially
              helpful for teaching, live demos, and talks that evolve alongside
              technical material.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              Coauthors can also work on the same presentation in real time.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Tag
          color="blue"
          style={{
            alignSelf: "flex-start",
            background: COLORS.ANTD_BG_BLUE_L,
            color: COLORS.BLUE_D,
          }}
        >
          Structured presentations
        </Tag>
        <Title level={3} style={{ margin: 0 }}>
          A presentation workflow, not just a drawing surface
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Slides use many of the same capabilities as the whiteboard, but with
          more structure around pages and presentation flow. That makes them a
          better fit when you are preparing a talk or teaching sequence instead
          of sketching on an open canvas.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          TimeTravel and collaboration history also apply here, which makes it
          easier to evolve presentations over time without losing earlier
          versions.
        </Paragraph>
      </PublicSectionCard>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why use slides in CoCalc
        </Title>
        <BulletList
          items={[
            "Mix code, math, and explanation in one presentation workflow.",
            "Edit collaboratively with coauthors and teaching assistants.",
            "Keep the presentation next to the notebooks and files it depends on.",
            "Use a browser-native presentation tool designed for technical content.",
          ]}
        />
        <Flex wrap gap={12}>
          <Button href={appPath("features/whiteboard")}>Whiteboard</Button>
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
