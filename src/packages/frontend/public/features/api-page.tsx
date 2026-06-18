/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  CodeBlock,
  FeatureImage,
  featureAppPath as appPath,
  featureSupportPath,
} from "./page-components";

const { Paragraph, Title } = Typography;

// A real, documented call (POST /api/v2/exec): basic auth with an API key as the
// username, run a command in a project, get stdout/stderr/exit_code back.
const EXEC_EXAMPLE = [
  `curl -u "$COCALC_API_KEY:" \\`,
  `  https://cocalc.ai/api/v2/exec \\`,
  `  -d '{"project_id": "...", "command": "python3", "args": ["analysis.py"]}'`,
].join("\n");

export default function ApiFeaturePage({}: { helpEmail?: string }) {
  const supportHref = featureSupportPath({
    body: "I want to discuss automating CoCalc through the API. Helpful context: the research or engineering workflow you want to automate, provisioning or scheduling needs, expected volume, and where CoCalc runs.",
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
                Drive your projects, notebooks, and terminals from your own code
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                A documented HTTP API lets your scripts, pipelines, and
                scheduled jobs create projects and run notebooks, terminals, and
                computations directly.
              </Paragraph>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                The work lands back in a persistent CoCalc project your team can
                reopen, review, and continue — hosted on CoCalc.ai or in your
                own deployment — instead of a one-off run that disappears.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("docs/api/http-api")}>
                  API documentation
                </Button>
                <Button href={supportHref}>Ask about API integration</Button>
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
              What you can automate
            </Title>
            <BulletList
              items={[
                "Create and configure project environments — for a study or a pipeline — reproducibly.",
                "Run notebooks, terminals, and computations from a script, and read the results back.",
                "Schedule recurring work — data pulls, model runs, report builds — that writes into the project.",
                "Wire CoCalc into an existing pipeline: provision, run, and collect without driving the browser.",
              ]}
            />
          </PublicSection>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              Run code, get the output back
            </Title>
            <CodeBlock ariaLabel="Example API call" code={EXEC_EXAMPLE} />
            <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
              Returns the stdout, stderr, and exit code — and the run stays in
              the project. Calls use a scoped API key; the full reference is in
              the API documentation.
            </Paragraph>
          </PublicSection>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                A documented route, not fragile UI scripts
              </Title>
              <Paragraph style={{ margin: 0 }}>
                The API gives your automation a documented way to reach projects
                and computations directly, instead of scripting the browser.
                Reach for it when CoCalc is part of a research or engineering
                pipeline that runs on its own.
              </Paragraph>
              <Flex wrap gap={12}>
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
                Start automating
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Begin with the HTTP API docs. If your automation depends on
                provisioning, scheduling, or where CoCalc runs, talk with us.
              </Paragraph>
            </div>
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
