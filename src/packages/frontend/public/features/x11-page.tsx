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

export default function X11FeaturePage({ helpEmail }: { helpEmail?: string }) {
  return (
    <Flex vertical gap={18}>
      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Text strong type="secondary">
                LINUX GRAPHICAL DESKTOP
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Run graphical Linux applications remotely in the browser
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc can expose a graphical Linux desktop through X11/XPRA so
                you can use applications that are not a good fit for a terminal
                or notebook alone.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This matters for specialized tools, graphical IDEs, and local
                browser testing inside the same project environment.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <LinkButton href="https://doc.cocalc.com/x11.html">
                  X11 documentation
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="Graphical X11 desktop on CoCalc"
              src="/public/features/x11-01.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Why X11 matters
            </Title>
            <BulletList
              items={[
                "Run graphical Linux applications without local installation.",
                "Keep the application in the same project as notebooks, files, and terminals.",
                "Preserve the session while the project keeps running.",
                "Let collaborators connect to the same environment when needed.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This is not the primary interface for most tasks, but it is
              extremely useful when a graphical app is the right tool.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Grid of X11 applications available on CoCalc"
              src="/public/features/x11-applications.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Access to graphical applications
            </Title>
            <Paragraph style={{ margin: 0 }}>
              X11 opens the door to graphical Linux applications that complement
              the rest of CoCalc, including IDEs, office tools, mathematical
              software, and testing workflows.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Firefox running inside a CoCalc X11 desktop"
              src="/public/features/x11-firefox.png"
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
                Local service testing
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Use a graphical browser inside the project
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Running Firefox inside the X11 desktop is useful when you want
                to connect to services that are only exposed on the project's
                own localhost or when you want to test graphical web flows
                inside the same remote environment.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This avoids awkward proxying tricks for some internal testing
                scenarios.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Swirl running inside an X11 desktop"
              src="/public/features/swirl-course.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Useful for specialized teaching tools
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Some interactive educational tools and graphical packages do not
              fit cleanly into notebooks, but they can still work well through
              the X11 desktop.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That makes X11 a valuable complement to notebook and terminal
              teaching workflows.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              How X11 fits into CoCalc
            </Title>
            <Paragraph style={{ margin: 0 }}>
              X11 is best seen as one more interface into the same project:
              notebooks, terminals, files, services, and graphical apps can all
              coexist in the same environment.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That is why it is more useful here than as a standalone remote
              desktop product.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why use X11 on CoCalc
        </Title>
        <BulletList
          items={[
            "Run graphical Linux tools in the browser when text-only workflows are not enough.",
            "Keep graphical apps in the same project as the rest of the technical work.",
            "Test local services or use specialized GUI applications remotely.",
            "Extend notebook and terminal workflows instead of replacing them.",
          ]}
        />
        <Flex wrap gap={12}>
          <Button href={appPath("features/linux")}>Linux environment</Button>
          <Button href={appPath("features/octave")}>Octave</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
