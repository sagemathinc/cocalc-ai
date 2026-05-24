/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import { BulletList, featureAppPath as appPath } from "./page-components";
import {
  IconBadge,
  StartCard,
  StoryCard,
  TerminalMock,
} from "./feature-visuals";

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
        borderRadius: 28,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#9558b2" icon="julia" />
            <div>
              <Text strong>Julia project</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                notebooks, packages, source files, terminals, and Pluto
              </div>
            </div>
          </Flex>
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
            technical computing
          </Tag>
        </Flex>

        <Row gutter={[12, 12]}>
          {blocks.map(([icon, title, body]) => (
            <Col key={title} xs={24} sm={12}>
              <div
                style={{
                  background: "#fff",
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 18,
                  height: "100%",
                  padding: 14,
                }}
              >
                <Flex align="center" gap={12}>
                  <IconBadge accent="#9558b2" icon={icon} />
                  <div>
                    <Text strong>{title}</Text>
                    <div style={{ color: PUBLIC_COLORS.mutedText }}>{body}</div>
                  </div>
                </Flex>
              </div>
            </Col>
          ))}
        </Row>

        <TerminalMock
          title="julia"
          rows={[
            "$ julia --project",
            "(@v1) pkg> instantiate",
            'julia> include("src/Model.jl")',
            "results written to output/",
          ]}
        />
      </Flex>
    </div>
  );
}

function JuliaPositioning() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Tag
              color="blue"
              style={{
                alignSelf: "flex-start",
                background: COLORS.ANTD_BG_BLUE_L,
                color: COLORS.BLUE_D,
              }}
            >
              Positioning
            </Tag>
            <Title level={3} style={{ margin: 0 }}>
              Julia works best in CoCalc when the project matters.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Julia has strong native tools and notebook ecosystems. CoCalc is
              useful when the Julia work needs a collaborative project around
              it: notebooks, source files, package environments, terminals,
              teaching workflows, and supporting Python, R, or shell scripts.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              Use Jupyter for collaborative notebooks, terminals for normal
              Julia package and script work, and Pluto when reactive notebooks
              are the right fit.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <div
            style={{
              background: "#fff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 26,
              boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
              padding: 22,
            }}
          >
            <Flex vertical gap={12}>
              {[
                ["jupyter", "Collaborative Jupyter notebooks"],
                ["layout", "Pluto for reactive notebooks"],
                ["terminal", "Julia packages and scripts in a shell"],
                ["graduation-cap", "Shared environments for courses"],
              ].map(([icon, label]) => (
                <Flex
                  align="center"
                  gap={12}
                  key={label}
                  style={{
                    background: "#faf7ff",
                    border: "1px solid #d3adf7",
                    borderRadius: 16,
                    padding: 14,
                  }}
                >
                  <IconBadge accent="#9558b2" icon={icon as IconName} />
                  <Text strong>{label}</Text>
                </Flex>
              ))}
            </Flex>
          </div>
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function JuliaFeaturePage({
  helpEmail,
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalLabel = isAuthenticated ? "Open projects" : "Start using Julia";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Tag color="purple" style={{ alignSelf: "flex-start" }}>
                Julia in a shared project
              </Tag>
              <Title level={2} style={{ margin: 0 }}>
                Use Julia in notebooks, terminals, Pluto, and source files.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                CoCalc supports Julia as part of the same collaborative project
                environment as your files, notebooks, terminals, teaching
                workflows, and Codex conversations.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                It is a good fit for classes, research groups, and
                mixed-language technical projects where Julia should live
                alongside the rest of the computational work.
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

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#9558b2" icon="jupyter" title="Jupyter notebooks">
            Use Julia kernels in CoCalc notebooks with collaboration, project
            files, TimeTravel, and course workflows around them.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#278c83" icon="terminal" title="Normal Julia">
            Use terminals for package environments, <code>julia --project</code>
            , scripts, tests, and command-line workflows.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#ad6800" icon="layout" title="Pluto available">
            Launch Pluto from a project when reactive Julia notebooks are a
            better fit than classic Jupyter.
          </StoryCard>
        </Col>
      </Row>

      <JuliaPositioning />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3}>Why use Julia on CoCalc</Title>
            <BulletList
              items={[
                "Use Jupyter, Pluto, source files, and terminal workflows together.",
                "Share a Julia environment with students or collaborators.",
                "Keep Julia work near data, reports, Python, R, and Linux tools.",
                "Use CoCalc when collaboration and project context matter as much as the language.",
              ]}
            />
            <Flex wrap gap={12}>
              <Button href={appPath("features/linux")}>
                Linux environment
              </Button>
              <Button href={appPath("features/teaching")}>Teaching</Button>
              {helpEmail ? (
                <Button href={`mailto:${helpEmail}`}>Contact support</Button>
              ) : null}
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <StartCard
              body="Open a project and use Julia in notebooks, terminals, Pluto, source files, or teaching workflows."
              href={primaryHref}
              label={finalLabel}
              title="Start in a project"
            />
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
