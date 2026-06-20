/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS, PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
} from "./page-components";
import { ContextList, IconBadge, StartCard } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const CLI_DOCS_PATH = appPath("docs/cli/use-cocalc-cli");
const CLI_HERO_IMAGE = "/public/features/cocalc-cli-browser-automation.png";
const CLI_ACCENT = COLORS.GRAY_D;
const PANEL_RADIUS = 8;

function CliHeroImage() {
  return (
    <div
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={14}>
        <Flex align="center" gap={10} wrap>
          <IconBadge accent={CLI_ACCENT} icon="terminal" />
          <div>
            <Text strong>CoCalc CLI</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              typed commands for project automation
            </div>
          </div>
        </Flex>
        <img
          src={CLI_HERO_IMAGE}
          alt="CoCalc CLI browser automation example"
          width={3024}
          height={1722}
          style={{
            background: PUBLIC_COLORS.surfaceMuted,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PANEL_RADIUS,
            display: "block",
            height: "auto",
            width: "100%",
          }}
        />
      </Flex>
    </div>
  );
}

function CliFitSection() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              A stable control surface for people and agents.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Use the CLI when the work should be repeatable, inspectable, and
              easy to run from a terminal or agent thread. It is a better fit
              than browser clicks for recurring project operations.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              The HTTP API is still useful for narrow integrations. The CLI is
              the practical starting point for project, browser, documentation,
              notebook, and command workflows.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <ContextList
            accent={CLI_ACCENT}
            items={[
              {
                icon: "folder" as IconName,
                label: "Run project commands from a repeatable shell surface",
              },
              {
                icon: "jupyter" as IconName,
                label: "Execute notebooks through the live notebook API",
              },
              {
                icon: "bug" as IconName,
                label: "Inspect browser tabs and workspace state when needed",
              },
              {
                icon: "gears" as IconName,
                label: "Give agents typed actions they can run and report",
              },
            ]}
            title="CLI context"
          />
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function CliFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalLabel = isAuthenticated ? "Open projects" : "Start with the CLI";
  const supportHref = featureSupportPath({
    body: "I want to discuss CoCalc CLI automation. Helpful context: what should run, whether it starts from a project, browser session, notebook, or external script, and who needs to review the result.",
    context: "cli",
    subject: "CoCalc CLI automation",
    title: "Ask CoCalc about CLI automation",
  });

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                CoCalc CLI for project automation.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Use typed commands for projects, browser sessions, docs,
                notebooks, and recurring operational checks instead of clicking
                through the UI.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={CLI_DOCS_PATH}>CLI Docs</Button>
                <Button href={appPath("features/automations")}>
                  Project automations
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <CliHeroImage />
          </Col>
        </Row>
      </PublicSection>

      <CliFitSection />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3}>When the CLI belongs in CoCalc</Title>
            <BulletList
              items={[
                "A project command, notebook run, or browser check needs to be repeatable.",
                "A human or agent should be able to inspect the exact operation that ran.",
                "The work starts from the same project files and context collaborators use.",
                "A narrow HTTP integration is too low-level for the job you actually need.",
              ]}
            />
            <Flex wrap gap={12}>
              <Button href={appPath("features/api")}>HTTP API</Button>
              <Button href={appPath("features/terminal")}>
                Terminal workflows
              </Button>
              <Button href={supportHref}>Ask about CLI automation</Button>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <StartCard
              body="Open a project, identify the recurring action, and use the CLI when that action should be scripted, reviewed, or handed to an agent."
              href={primaryHref}
              label={finalLabel}
              title="Start from a project"
            />
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
