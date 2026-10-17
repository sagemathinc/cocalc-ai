/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import {
  getPublicFeaturePage,
  PUBLIC_API_HTTP_INTEGRATIONS,
  PUBLIC_CLI_COMPUTER_COMMANDS,
  PUBLIC_CLI_IN_PROJECTS,
  PUBLIC_CLI_INSTALL_COMMAND,
  PUBLIC_CLI_INSTALL_STEP,
  PUBLIC_CLI_INSTALL_TITLE,
  PUBLIC_CLI_INSTALL_WINDOWS,
  PUBLIC_CLI_ON_YOUR_COMPUTER,
  PUBLIC_CLI_START_AUTOMATING,
} from "@cocalc/util/public-feature-pages";
import { PUBLIC_PRODUCTS_PAGE_LINK } from "@cocalc/util/public-products-content";
import { CANONICAL_PUBLIC_SITE_ORIGIN } from "@cocalc/util/public-site-policy";
import {
  BulletList,
  CodeBlock,
  FeatureImage,
  featureAppPath as appPath,
  featureSupportPath,
} from "./page-components";

const { Paragraph, Title } = Typography;

const PAGE = getPublicFeaturePage("api")!;

// A real, documented call (POST /api/v2/exec): basic auth with an API key as the
// username, run a command in a project, get stdout/stderr/exit_code back.
const EXEC_EXAMPLE = [
  `curl -u "$COCALC_API_KEY:" \\`,
  `  https://cocalc.ai/api/v2/exec \\`,
  `  -H 'Content-Type: application/json' \\`,
  `  -d '{"project_id": "...", "command": "python3", "args": ["analysis.py"], "err_on_exit": false}'`,
].join("\n");

export default function ApiFeaturePage({ helpEmail }: { helpEmail?: string }) {
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
                {PAGE.tagline}
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                {PUBLIC_CLI_IN_PROJECTS} {PUBLIC_CLI_ON_YOUR_COMPUTER}
              </Paragraph>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                {PUBLIC_API_HTTP_INTEGRATIONS}
              </Paragraph>
              <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
                Your use of CoCalc.ai through the CLI is covered by the{" "}
                <a href={`${CANONICAL_PUBLIC_SITE_ORIGIN}/policies/terms`}>
                  CoCalc.ai Terms of Service
                </a>
                , including their{" "}
                <a
                  href={`${CANONICAL_PUBLIC_SITE_ORIGIN}/policies/terms#api-terms`}
                >
                  API Terms
                </a>
                .
              </Paragraph>
              <Flex wrap gap={12}>
                <Button
                  type="primary"
                  href="https://cocalc.ai/docs/cli/use-cocalc-cli"
                >
                  CLI documentation
                </Button>
                <Button href="https://cocalc.ai/docs/api/http-api">
                  API documentation
                </Button>
                <Button href={supportHref}>Ask about API integration</Button>
                {helpEmail ? (
                  <Button href={`mailto:${helpEmail}`}>Contact support</Button>
                ) : null}
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

      {/* As the crawler fallback renders it, with CoCalc.ai's installer on
          every site. */}
      <PublicSection ariaLabel={PUBLIC_CLI_INSTALL_TITLE}>
        <Title level={3} style={{ margin: 0 }}>
          {PUBLIC_CLI_INSTALL_TITLE}
        </Title>
        <Paragraph style={{ margin: 0 }}>{PUBLIC_CLI_INSTALL_STEP}</Paragraph>
        <CodeBlock
          ariaLabel="Install command"
          code={PUBLIC_CLI_INSTALL_COMMAND}
        />
        <Paragraph style={{ margin: 0 }}>
          {PUBLIC_CLI_INSTALL_WINDOWS}
        </Paragraph>
        {PUBLIC_CLI_COMPUTER_COMMANDS.map(({ code, text }) => (
          <Paragraph key={code} style={{ margin: 0 }}>
            <code>{code}</code> {text}
          </Paragraph>
        ))}
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSection>
            <Title level={3} style={{ margin: 0 }}>
              What you can automate
            </Title>
            <BulletList
              items={[
                "Call a documented HTTP endpoint from an external service.",
                "Run a command in an allowed project and inspect its returned output and exit status.",
                "Save complete result files and environment records for later review.",
                "Use CLI notebook and scheduling commands when the workflow needs those richer interfaces.",
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
              Replace the project id and use an existing analysis.py in that
              project. The key needs project:exec and that project in its
              allowlist. With err_on_exit disabled, a completed command returns
              stdout, stderr, and its exit code; inspect API error responses
              too. Timeout and output limits still apply. Save complete results
              to project files instead of relying on returned output as an
              archive.
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
                <Button href={appPath(PUBLIC_PRODUCTS_PAGE_LINK.href)}>
                  {PUBLIC_PRODUCTS_PAGE_LINK.label}
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <div
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                padding: 24,
              }}
            >
              <Title level={3} style={{ margin: "0 0 10px" }}>
                Start automating
              </Title>
              <Paragraph style={{ margin: 0 }}>
                {PUBLIC_CLI_START_AUTOMATING}
              </Paragraph>
            </div>
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
