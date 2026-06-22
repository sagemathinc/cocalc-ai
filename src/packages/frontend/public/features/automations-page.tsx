/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { BulletList, featureAppPath as appPath } from "./page-components";
import { FEATURE_ACCENTS } from "./feature-accents";
import { ContextList, FeatureFinalBand, IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

function AutomationFlowMock() {
  const steps = [
    ["calendar-check", "Trigger", "schedule or project event"],
    ["play-circle", "Run", "notebook, script, or command"],
    ["file-alt", "Record", "outputs stay in the project"],
    ["users", "Review", "team continues from the result"],
  ] satisfies [IconName, string, string][];

  return (
    <div
      aria-label="Illustration of an automated CoCalc project workflow"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4fbff 50%, #f8fbf4 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" gap={10} wrap>
          <IconBadge accent={FEATURE_ACCENTS.automations} icon="sync" />
          <div>
            <Text strong>Recurring project workflow</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              scheduled runs, reports, scripts, outputs, and collaborators
            </div>
          </div>
        </Flex>

        <Row gutter={[12, 12]}>
          {steps.map(([icon, title, body]) => (
            <Col key={title} xs={24} sm={12}>
              <div
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PUBLIC_RADIUS.panel,
                  height: "100%",
                  padding: 14,
                }}
              >
                <Flex align="center" gap={12}>
                  <IconBadge
                    accent={FEATURE_ACCENTS.automations}
                    icon={icon}
                    size="sm"
                  />
                  <div>
                    <Text strong>{title}</Text>
                    <div style={{ color: PUBLIC_COLORS.mutedText }}>{body}</div>
                  </div>
                </Flex>
              </div>
            </Col>
          ))}
        </Row>
      </Flex>
    </div>
  );
}

function AutomationProjectFit() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              Automate the work, not just the request.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              A useful automation in CoCalc leaves a project in a better state:
              refreshed data, rebuilt notebooks, updated reports, or generated
              files that teammates can inspect and continue from.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That is different from the HTTP API reference. The API is one way
              to drive automation; this workflow is about the recurring project
              tasks you want to make reliable.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <ContextList
            accent={FEATURE_ACCENTS.automations}
            items={[
              {
                icon: "calendar-check",
                label: "Run recurring jobs without rebuilding context",
              },
              {
                icon: "jupyter",
                label: "Execute notebooks and keep outputs reviewable",
              },
              {
                icon: "terminal",
                label: "Use scripts and shell commands in the project",
              },
              {
                icon: "robot",
                label: "Give agents and collaborators durable results",
              },
            ]}
            title="Project context"
          />
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function AutomationsFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalLabel = isAuthenticated ? "Open projects" : "Start a workflow";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Turn recurring project workflows into repeatable runs.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Schedule recurring jobs, rebuild reports, run notebooks or
                scripts, and keep the output in the same project where people
                review the work.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Project automations are most useful when work repeats: refresh a
                dataset, rerun an analysis or model, hand pipeline output back
                to collaborators, or prepare teaching material.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={appPath("features/api")}>HTTP API</Button>
                <Button href={appPath("docs/cli/use-cocalc-cli")}>
                  CoCalc CLI
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <AutomationFlowMock />
          </Col>
        </Row>
      </PublicSection>

      <AutomationProjectFit />

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project and identify the recurring job, output, and review path you want to make repeatable.",
            href: primaryHref,
            label: finalLabel,
            title: "Start from the workflow",
          }}
          relatedLinks={[
            {
              href: appPath("features/terminal"),
              label: "Terminal workflows",
            },
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="When project automation belongs in CoCalc"
        >
          <BulletList
            items={[
              "A notebook or report needs to be rebuilt on a schedule.",
              "A class or lab setup needs the same preparation every time.",
              "A scheduled analysis or model run should write its results back into a shared project the team reviews.",
              "A script should run with the same files, software, and history collaborators already use.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
