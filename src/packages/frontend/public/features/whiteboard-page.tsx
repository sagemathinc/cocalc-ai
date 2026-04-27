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

export default function WhiteboardFeaturePage({
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
                COMPUTATIONAL WHITEBOARD
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                An infinite collaborative canvas with code, math, and sketching
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc whiteboards combine freeform explanation with technical
                content: markdown, LaTeX, drawing tools, structured frames, and
                Jupyter code cells can all live together on the same board.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That makes them useful for teaching, brainstorming, live
                support, and technical presentations where plain slides are too
                rigid.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <Button href={appPath("features/slides")}>Slides</Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="Computational whiteboard in CoCalc"
              src="/public/features/whiteboard-sage.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Built for interactive explanation
            </Title>
            <BulletList
              items={[
                "Rich collaborative markdown with LaTeX mathematics.",
                "Sticky notes, drawing tools, icons, frames, and layout controls.",
                "Jupyter code cells with execution and widgets inside the board.",
                "Chat and collaboration next to the work instead of in a separate tool.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This combination makes the whiteboard useful for more than
              freehand sketching. It becomes a workspace for technical
              explanation.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Better than a static diagram
            </Title>
            <Paragraph style={{ margin: 0 }}>
              A computational whiteboard can combine narrative, executable code,
              mathematical notation, and annotations in one place. That is ideal
              for office hours, collaborative problem solving, design reviews,
              and technical teaching.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              It is especially useful when you want to keep the fluidity of a
              whiteboard without giving up the ability to run code or write
              precise mathematics.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Whiteboard with sticky notes and annotations"
              src="/public/features/whiteboard-post-it.png"
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
                Infinite canvas
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Organize complex ideas spatially
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Frames, overview maps, and spatial layout matter when a topic is
                too large for a single document page or slide deck.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc whiteboards let you keep several related areas in one
                board while still navigating them in a structured way.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              TimeTravel and collaboration history
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Every change is recorded, which means whiteboards are not just
              ephemeral drawing surfaces. You can inspect earlier states and
              understand how an explanation or solution evolved over time.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Closely related to slides
            </Title>
            <Paragraph style={{ margin: 0 }}>
              If you want a more presentation-focused workflow, CoCalc slides
              use many of the same ideas in a more structured, page-oriented
              format.
            </Paragraph>
            <LinkButton href={appPath("features/slides")}>
              Explore slides
            </LinkButton>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why teams use whiteboards in CoCalc
        </Title>
        <BulletList
          items={[
            "Explain ideas with text, math, sketches, and live code together.",
            "Collaborate in real time instead of passing around exported screenshots.",
            "Use one workspace for teaching, brainstorming, and technical support.",
            "Keep history and structure around what would otherwise be transient board work.",
          ]}
        />
        <Flex wrap gap={12}>
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
