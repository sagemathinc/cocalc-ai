/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  FeatureImage,
  featureAppPath as appPath,
  featureSupportPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Title } = Typography;

export default function ApiFeaturePage({}: { helpEmail?: string }) {
  const supportHref = featureSupportPath({
    body: "I want to discuss CoCalc API integration. Helpful context: external system, provisioning or automation needs, product path under evaluation, and any support or deployment constraints.",
    context: "api",
    subject: "CoCalc API integration",
    title: "Ask CoCalc about API integration",
  });

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
                <Button type="primary" href={appPath("docs/api/http-api")}>
                  API documentation
                </Button>
                <Button href={supportHref}>Ask about API integration</Button>
                <LinkButton href={appPath("auth/sign-up")}>
                  Create account
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
                "Build external services that need a documented programmatic interface to CoCalc.",
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
              It gives administrators and developers a documented way to
              automate routine work without depending on browser automation or
              fragile UI scripts.
            </Paragraph>
          </PublicSection>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Programmatic control instead of UI automation
              </Title>
              <Paragraph style={{ margin: 0 }}>
                The API gives integrations a documented route for project and
                platform work instead of browser scripting. It is most relevant
                when CoCalc is part of a portal, managed deployment, or
                organization-operated workflow.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("docs/api/http-api")}>
                  API documentation
                </Button>
                <Button href={supportHref}>Ask about API integration</Button>
                <Button href={appPath("products")}>
                  Compare operating models
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <div
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 8,
                padding: 24,
              }}
            >
              <Title level={4} style={{ margin: "0 0 10px" }}>
                Ready to plan an integration?
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Start with the HTTP API docs, then talk with CoCalc if your
                integration depends on provisioning, product path, deployment
                boundary, or support expectations.
              </Paragraph>
            </div>
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
