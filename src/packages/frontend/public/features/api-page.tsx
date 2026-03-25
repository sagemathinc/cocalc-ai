/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSectionCard } from "@cocalc/frontend/public/ui/shell";
import {
  BulletList,
  FeatureImage,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

export default function ApiFeaturePage({ helpEmail }: { helpEmail?: string }) {
  return (
    <Flex vertical gap={18}>
      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Text strong type="secondary">
                HTTP API
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Automate and integrate CoCalc from your own systems
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc exposes an HTTP API for automation, provisioning, and
                integration workflows, so external systems do not have to drive
                the web UI to manage projects or interact with platform
                features.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This is useful for hosted CoCalc, launchpad-style deployments,
                and any environment where CoCalc needs to be part of a broader
                technical stack.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <LinkButton href="https://doc.cocalc.com/api2/">
                  API documentation
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="CoCalc HTTP API documentation"
              src="/public/features/api-screenshot.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Common use cases
            </Title>
            <BulletList
              items={[
                "Provision and manage projects programmatically.",
                "Integrate CoCalc into existing portals, admin tools, or learning platforms.",
                "Automate workflows around users, support, or project lifecycle events.",
                "Build external services that need a stable programmatic interface to CoCalc.",
              ]}
            />
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Why this matters in the migration
            </Title>
            <Paragraph style={{ margin: 0 }}>
              The HTTP API is no longer tied conceptually to the old Next.js app
              layer. It is being pulled into its own package so the route layer
              can evolve independently from the public site migration.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That is the right architecture for future `/api/v2.x` and
              `/api/v3` work as well.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Programmatic control instead of UI automation
        </Title>
        <Paragraph style={{ margin: 0 }}>
          The point of the API is not only convenience. It is to provide a
          stable route for integrations so deployments do not have to script the
          browser to perform administrative or operational work.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          This is especially important for launchpad deployments and product
          integrations where CoCalc is only one component in a larger system.
        </Paragraph>
        <Flex wrap gap={12}>
          <Button href={appPath("support")}>Support</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
