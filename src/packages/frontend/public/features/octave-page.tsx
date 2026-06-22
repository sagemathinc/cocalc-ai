/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { BulletList, featureAppPath as appPath } from "./page-components";
import { ContextList, FeatureFinalBand, IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

function OctaveProjectMock() {
  const projectItems = [
    ["solver.m", "source file"],
    ["analysis.ipynb", "interactive notebook"],
    ["terminal run", "plots and output"],
  ] as const;

  return (
    <div
      aria-label="Illustration of Octave scripts, notebooks, and terminal workflows in CoCalc"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #fff7f1 52%, #f4f9ff 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#d4380d" icon="octave" />
            <div>
              <Text strong>Octave project</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                notebooks, .m files, plots, terminal runs, and teaching context
              </div>
            </div>
          </Flex>
        </Flex>

        <Flex wrap gap={10}>
          {projectItems.map(([title, body]) => (
            <div
              key={title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                flex: "1 1 160px",
                padding: "10px 12px",
              }}
            >
              <Text strong>{title}</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>{body}</div>
            </div>
          ))}
        </Flex>
      </Flex>
    </div>
  );
}

function OctaveFlow() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              Run reproducible Octave work without local setup drift.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Everyone opens the same reproducible project: notebooks,{" "}
              <code>.m</code> files, plots, data, packages, and TimeTravel
              history stay with the work instead of drifting across laptops.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <ContextList
            accent="#d4380d"
            items={[
              {
                icon: "users",
                label: "Collaborators open the same environment",
              },
              {
                icon: "history",
                label: "Reopen earlier versions with TimeTravel",
              },
              {
                icon: "jupyter",
                label: "Use notebooks with real-time collaboration",
              },
            ]}
            title="Project context"
          />
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function OctaveFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalLabel = isAuthenticated ? "Open projects" : "Start using Octave";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Run GNU Octave with notebooks, .m files, and shared numerical
                work.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                The numerical work lives in one durable project — no local
                installs to maintain.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
                <Button href={appPath("features/terminal")}>
                  Terminal workflows
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <OctaveProjectMock />
          </Col>
        </Row>
      </PublicSection>

      <OctaveFlow />

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project and use Octave in notebooks, terminals, scripts, or teaching workflows.",
            href: primaryHref,
            label: finalLabel,
            title: "Start in a project",
          }}
          relatedLinks={[
            { href: appPath("features/linux"), label: "Linux environment" },
            { href: appPath("features/teaching"), label: "Teaching" },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="When Octave belongs in CoCalc"
        >
          <BulletList
            items={[
              "Numerical research and prototyping that benefits from shared files and history.",
              "Work that mixes Octave with notebooks, data, and write-ups in one project.",
              "A team that opens each other's Octave work and reviews it together.",
              "A numerical course where students share one consistent environment.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
