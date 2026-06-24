/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_COLORS,
  PUBLIC_ELEVATION,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
} from "./page-components";
import { ContextList, FeatureFinalBand, IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const HOST_DOCS_PATH = appPath("docs/hosts/project-hosts");
const DEDICATED_COMPUTE_ACCENT = PUBLIC_COLORS.link;

function DedicatedComputeMock() {
  const workloads = [
    ["research", "long-running notebooks and services", "jupyter"],
    ["courses", "larger class or workshop capacity", "graduation-cap"],
    ["agents", "project work with durable files", "robot"],
    ["regions", "placement, backups, and runtime policy", "server"],
  ] satisfies [string, string, IconName][];

  return (
    <div
      aria-label="Dedicated CoCalc compute capacity"
      role="img"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 58%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" gap={10} wrap>
          <IconBadge accent={DEDICATED_COMPUTE_ACCENT} icon="server" />
          <div>
            <Text strong>dedicated capacity</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              project workloads stay in the CoCalc workflow
            </div>
          </div>
        </Flex>
        <Row gutter={[12, 12]}>
          {workloads.map(([title, body, icon]) => (
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
                    accent={DEDICATED_COMPUTE_ACCENT}
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

function DedicatedComputeFit() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              More capacity without changing the project workflow.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Dedicated compute is for hosted CoCalc projects that need more
              predictable runtime placement or larger resources. The notebooks,
              terminals, files, collaboration, backups, and review workflow stay
              in CoCalc.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              Use it for heavier research work, courses, workshops, services, or
              agent runs where capacity and restart expectations matter.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <ContextList
            accent={DEDICATED_COMPUTE_ACCENT}
            items={[
              {
                icon: "line-chart",
                label: "Run larger or longer workloads with planned capacity",
              },
              {
                icon: "database",
                label: "Keep files, outputs, snapshots, and backups close",
              },
              {
                icon: "users",
                label: "Delegate capacity for teams, courses, or workshops",
              },
              {
                icon: "robot",
                label: "Give agents a durable project runtime to work in",
              },
            ]}
            title="Dedicated compute context"
          />
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function DedicatedComputeFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated ? appPath("hosts") : appPath("pricing");
  const primaryLabel = isAuthenticated
    ? "Manage dedicated compute"
    : "Review pricing";
  const supportHref = featureSupportPath({
    body: "I want to discuss dedicated CoCalc compute. Helpful context: workload type, expected users or projects, CPU/RAM/disk needs, restart expectations, region or backup requirements, and whether this is for research, teaching, agents, or services.",
    context: "project-hosts",
    subject: "CoCalc dedicated compute",
    title: "Ask CoCalc about dedicated compute",
  });

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Dedicated compute for heavier project workloads.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Move demanding CoCalc projects onto dedicated hosted capacity
                when notebooks, services, courses, or agents need more
                predictable CPU, RAM, disk, or placement.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={HOST_DOCS_PATH}>Technical setup docs</Button>
                <Button href={appPath("features/linux")}>
                  Linux environment
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <DedicatedComputeMock />
          </Col>
        </Row>
      </PublicSection>

      <DedicatedComputeFit />

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Start from the workload: who needs the capacity, what must keep running, and how much CPU, RAM, disk, and placement control it needs.",
            href: primaryHref,
            label: primaryLabel,
            title: "Plan capacity around the project",
          }}
          relatedLinks={[
            { href: appPath("products"), label: "Compare operating models" },
            { href: appPath("features/terminal"), label: "Terminal workflows" },
            {
              href: appPath("features/automations"),
              label: "Project automations",
            },
            { href: supportHref, label: "Ask about dedicated compute" },
          ]}
          title="When dedicated compute belongs in CoCalc"
        >
          <BulletList
            items={[
              "A course, workshop, or team needs predictable shared capacity.",
              "A notebook, service, or agent run needs more RAM, disk, or longer-running project capacity.",
              "The work should stay near CoCalc files, terminals, history, and collaborators.",
              "Capacity decisions matter, but the team still wants the hosted CoCalc workflow.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
