/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS, PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  featureAppPath as appPath,
  featureSupportPath,
} from "./page-components";
import { IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const CLI_DOCS_PATH = appPath("docs/cli/use-cocalc-cli");
const CLI_HERO_IMAGE = "/public/features/cocalc-cli-browser-automation.png";
const CLI_ACCENT = COLORS.GRAY_D;
const PANEL_RADIUS = 8;

function HeroPoint({ children }: { children: ReactNode }) {
  return (
    <Flex align="center" gap={8}>
      <Icon
        name="check"
        style={{
          color: CLI_ACCENT,
          flex: "0 0 auto",
          fontSize: 14,
        }}
      />
      <Text strong>{children}</Text>
    </Flex>
  );
}

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
  const signals = [
    {
      body: "Let a script or AI assistant ask what is open, what files exist, and what state matters.",
      icon: "terminal" as IconName,
      title: "Expose project context",
    },
    {
      body: "Run a command, notebook action, or browser check without asking the external tool to drive the UI.",
      icon: "jupyter" as IconName,
      title: "Run concrete actions",
    },
    {
      body: "Check open files, tabs, and workspace state when a live CoCalc session matters.",
      icon: "bug" as IconName,
      title: "Inspect browser state",
    },
    {
      body: "Keep the exact operation visible so people can review what an external tool did.",
      icon: "gears" as IconName,
      title: "Hand work back for review",
    },
  ];

  return (
    <PublicSection>
      <Row gutter={[28, 28]} align="top">
        <Col xs={24} lg={10}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              A practical bridge for external tools.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              External assistants and scripts should not have to drive the
              CoCalc interface by hand. The CLI gives them a clear way to act on
              project files, notebooks, browser state, and documentation.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That matters for agent workflows: the work stays in CoCalc, while
              the external system gets a typed surface it can run and report.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={14}>
          <div
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: "0 14px 42px rgba(33, 49, 57, 0.07)",
              padding: 22,
            }}
          >
            <Row gutter={[16, 16]}>
              {signals.map(({ body, icon, title }) => (
                <Col key={title} xs={24} md={12}>
                  <Flex align="flex-start" gap={12} style={{ height: "100%" }}>
                    <IconBadge accent={CLI_ACCENT} icon={icon} size="sm" />
                    <div>
                      <Text strong>{title}</Text>
                      <Paragraph
                        style={{
                          color: PUBLIC_COLORS.mutedText,
                          margin: "4px 0 0",
                        }}
                      >
                        {body}
                      </Paragraph>
                    </div>
                  </Flex>
                </Col>
              ))}
            </Row>
          </div>
        </Col>
      </Row>
    </PublicSection>
  );
}

function CliSurfaceChoice({
  body,
  href,
  icon,
  label,
  title,
}: {
  body: ReactNode;
  href: string;
  icon: IconName;
  label: string;
  title: string;
}) {
  return (
    <Col xs={24} md={8}>
      <Flex
        vertical
        gap={12}
        style={{
          background: PUBLIC_COLORS.surface,
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: PANEL_RADIUS,
          height: "100%",
          padding: 18,
        }}
      >
        <Flex align="center" gap={10}>
          <IconBadge accent={CLI_ACCENT} icon={icon} size="sm" />
          <Text strong>{title}</Text>
        </Flex>
        <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
          {body}
        </Paragraph>
        <Button href={href} style={{ alignSelf: "flex-start" }}>
          {label}
        </Button>
      </Flex>
    </Col>
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
                Connect external tools and agents to CoCalc projects.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Give scripts and AI assistants a typed way to inspect project
                context, run notebook or browser checks, and return work that
                people can review.
              </Paragraph>
              <Flex vertical gap={8}>
                <HeroPoint>
                  Connect external assistants without moving work out of CoCalc.
                </HeroPoint>
                <HeroPoint>
                  Act on project files, notebooks, browser state, and docs.
                </HeroPoint>
                <HeroPoint>Keep actions explicit and reviewable.</HeroPoint>
              </Flex>
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
        <Flex vertical gap={16}>
          <Flex vertical gap={8} style={{ maxWidth: 780 }}>
            <Title level={3} style={{ margin: 0 }}>
              Choose the right way to connect.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              The CLI fits best when an external tool needs to work with an
              existing project. Automations and the API solve different parts of
              the same system.
            </Paragraph>
          </Flex>
          <Row gutter={[16, 16]}>
            <CliSurfaceChoice
              body="Best when a person, script, or external assistant needs an explicit project command."
              href={CLI_DOCS_PATH}
              icon="terminal"
              label="Read docs"
              title="CLI"
            />
            <CliSurfaceChoice
              body="Best when the same notebook, script, or report should run on a schedule or project event."
              href={appPath("features/automations")}
              icon="sync"
              label="Project automations"
              title="Automations"
            />
            <CliSurfaceChoice
              body="Best when another product or service needs a deeper programmatic integration with CoCalc."
              href={appPath("features/api")}
              icon="code"
              label="HTTP API"
              title="API"
            />
          </Row>
          <Flex wrap gap={12}>
            <Button href={appPath("features/terminal")}>
              Terminal workflows
            </Button>
            <Button href={supportHref}>Ask about CLI automation</Button>
          </Flex>
        </Flex>
      </PublicSection>
    </Flex>
  );
}
