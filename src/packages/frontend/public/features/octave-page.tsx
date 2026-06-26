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

function OctaveProjectMock() {
  return (
    <div
      aria-label="Illustration of Octave scripts, notebooks, and terminal workflows in CoCalc"
      role="img"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #fff7f1 52%, #f4f9ff 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
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
          <Tag color="volcano" style={{ marginInlineEnd: 0 }}>
            MATLAB-style workflows
          </Tag>
        </Flex>

        <Row gutter={[12, 12]}>
          {[
            ["file", "solver.m", "source file"],
            ["jupyter", "analysis.ipynb", "interactive notebook"],
            ["line-chart", "figure.png", "plot output"],
            ["graduation-cap", "assignment", "course project"],
          ].map(([icon, title, body]) => (
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
                  <IconBadge accent="#d4380d" icon={icon as IconName} />
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
          title="octave"
          rows={[
            "$ octave solver.m",
            "converged in 14 iterations",
            "$ open figure.png",
            "opened output in the project",
          ]}
        />
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
            <Tag
              color="blue"
              style={{
                alignSelf: "flex-start",
                background: COLORS.ANTD_BG_BLUE_L,
                color: COLORS.BLUE_D,
              }}
            >
              Numerical computing
            </Tag>
            <Title level={3} style={{ margin: 0 }}>
              A browser-based path for MATLAB-style teaching and scripts.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              GNU Octave is useful when you want a free MATLAB-style numerical
              environment for assignments, examples, and lightweight research
              workflows. CoCalc gives it the surrounding project workspace:
              files, terminals, notebooks, history, chat, and course tools.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              It is not a replacement for every MATLAB workflow. It is a
              practical way to run Octave online when setup consistency and
              collaboration matter.
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
                ["jupyter", "Explore interactively in notebooks"],
                ["file", "Edit .m files in the project"],
                ["terminal", "Run Octave commands and scripts"],
                ["history", "Recover earlier versions with project history"],
              ].map(([icon, label]) => (
                <Flex
                  align="center"
                  gap={12}
                  key={label}
                  style={{
                    background: "#fff7f1",
                    border: "1px solid #ffbb96",
                    borderRadius: 16,
                    padding: 14,
                  }}
                >
                  <IconBadge accent="#d4380d" icon={icon as IconName} />
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

export default function OctaveFeaturePage({
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
  const finalLabel = isAuthenticated ? "Open projects" : "Start using Octave";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Tag color="volcano" style={{ alignSelf: "flex-start" }}>
                Octave online
              </Tag>
              <Title level={2} style={{ margin: 0 }}>
                Run Octave in notebooks, scripts, and terminals.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                CoCalc supports GNU Octave as part of a real project
                environment: edit <code>.m</code> files, run Octave in a
                terminal, use notebook workflows, share files, and teach from a
                common setup.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That makes Octave useful for numerical courses and lightweight
                MATLAB-style work without asking every student or collaborator
                to maintain a local install.
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

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#d4380d" icon="jupyter" title="Notebooks">
            Use Octave interactively when examples, plots, and explanations
            benefit from a notebook format.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#ad6800" icon="file" title=".m files">
            Keep scripts, functions, data, generated figures, and notes in the
            same shared project.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#278c83" icon="graduation-cap" title="Teaching">
            Give students a known Octave environment with course files,
            assignment distribution, collection, and project history.
          </StoryCard>
        </Col>
      </Row>

      <OctaveFlow />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3}>
              Why use Octave on CoCalc
            </Title>
            <BulletList
              items={[
                "Use notebook and terminal Octave workflows in one project.",
                "Teach numerical computing without local installation friction.",
                "Keep .m files, plots, data, and explanations together.",
                "Use collaboration, chat, history, and course tooling around Octave.",
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
              body="Open a project and use Octave in notebooks, terminals, scripts, or teaching workflows."
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
