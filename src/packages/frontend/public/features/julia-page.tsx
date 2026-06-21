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
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
} from "./page-components";
import { FEATURE_ACCENTS } from "./feature-accents";
import { ContextList, IconBadge, StartCard } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

function JuliaProjectMock() {
  const blocks = [
    ["jupyter", "Jupyter", "collaborative notebooks"],
    ["terminal", "Terminal", "julia --project"],
    ["file", "Source", "src/Model.jl"],
    ["layout", "Pluto", "reactive notebooks"],
  ] satisfies [IconName, string, string][];

  return (
    <div
      aria-label="Illustration of Julia workflows in a CoCalc project"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f7f4ff 52%, #f4fff8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent={FEATURE_ACCENTS.julia} icon="julia" />
            <div>
              <Text strong>Julia project</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                notebooks, packages, source files, terminals, and Pluto
              </div>
            </div>
          </Flex>
        </Flex>

        <Row gutter={[12, 12]}>
          {blocks.map(([icon, title, body]) => (
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
                  <IconBadge accent={FEATURE_ACCENTS.julia} icon={icon} />
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

function JuliaProjectFit() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              Keep Julia close to the rest of the research.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Julia's own editors and notebook tools are the right choice when
              the work is mainly Julia. CoCalc earns its place when Julia is one
              part of a larger research or engineering project, so collaborators
              and reviewers work from the same files, environment, TimeTravel
              history, and live notebook state.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That fits shared package environments, models that mix Julia with
              Python or R, and team review with real-time editing and visible
              cursors — with teaching courses a natural extension, not the only
              use.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <ContextList
            accent={FEATURE_ACCENTS.julia}
            items={[
              { icon: "jupyter", label: "Collaborative Jupyter notebooks" },
              { icon: "layout", label: "Pluto for reactive notebooks" },
              {
                icon: "history",
                label: "TimeTravel for source and notebook history",
              },
              {
                icon: "terminal",
                label: "Julia packages and scripts in a shell",
              },
              {
                icon: "python",
                label: "Mix with Python, R, and shell tools",
              },
            ]}
            title="Project context"
          />
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function JuliaFeaturePage({
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
    body: "I want to discuss Julia workflows in CoCalc. Helpful context: notebooks, Pluto, source files, package environments, teaching or research use case, expected collaborators, and whether hosted or customer-operated CoCalc matters.",
    context: "julia",
    subject: "CoCalc Julia workflows",
    title: "Ask CoCalc about Julia workflows",
  });

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Julia for Pluto, Jupyter, and shared modeling projects.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Model, run simulations, and review results with your lab or
                team while Julia notebooks, Pluto sessions, source files, and
                terminals stay together.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                The package environment stays reproducible, so a teammate can
                instantiate it and continue the work — a fit for research groups
                and mixed-language technical projects.
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
            <JuliaProjectMock />
          </Col>
        </Row>
      </PublicSection>

      <JuliaProjectFit />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3}>When Julia belongs in CoCalc</Title>
            <BulletList
              items={[
                "Use Jupyter, Pluto, source files, and terminal workflows together.",
                "Share a Julia environment with students or collaborators.",
                "Keep Julia work near data, reports, Python, R, and Linux tools.",
                "Best fit when collaboration and project context matter as much as the language.",
              ]}
            />
            <Flex wrap gap={12}>
              <Button href={appPath("features/linux")}>
                Linux environment
              </Button>
              <Button href={appPath("features/teaching")}>Teaching</Button>
              <Button href={appPath("products")}>
                Compare operating models
              </Button>
              <Button href={supportHref}>Ask about Julia workflows</Button>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <StartCard
              body="Open a project and use Julia in notebooks, terminals, Pluto, source files, or teaching workflows."
              href={primaryHref}
              label={primaryLabel}
              title="Start in a project"
            />
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
