/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  BulletList,
  FeatureImage,
  featureAppPath as appPath,
  featureSupportPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Title } = Typography;

export default function ApiFeaturePage({}: { helpEmail?: string }) {
  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={2} style={{ margin: 0 }}>
                Automate and integrate CoCalc from your own systems
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc exposes documented HTTP endpoints for automation,
                provisioning, and integration workflows, so external systems do
                not have to drive the web UI to manage projects or interact with
                platform features.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This is the integration API, not the CoCalc CLI. Use it when a
                portal, service, or institution-managed workflow needs to talk
                to CoCalc directly.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <LinkButton href={appPath("docs/api/http-api")}>
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
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSection>
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
          </PublicSection>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Works with hosted and self-hosted deployments
            </Title>
            <Paragraph style={{ margin: 0 }}>
              The same HTTP API is useful whether you use hosted CoCalc.ai,
              CoCalc Launchpad, or CoCalc Rocket as part of a larger
              organization-managed workflow.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              It gives administrators and developers a stable way to automate
              routine work without depending on browser automation or fragile UI
              scripts.
            </Paragraph>
          </PublicSection>
        </Col>
      </Row>

      <PublicSection>
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
          <Button
            href={featureSupportPath({
              body: "I want to discuss CoCalc API integration. Helpful context: external system, provisioning or automation needs, product path under evaluation, and any support or deployment constraints.",
              context: "api",
              subject: "CoCalc API integration",
              title: "Ask CoCalc about API integration",
            })}
          >
            Ask about API integration
          </Button>
        </Flex>
      </PublicSection>
    </Flex>
  );
}
