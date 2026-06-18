/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
} from "./page-components";
import { ContextList, IconBadge, StartCard } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

function OctaveProjectMock() {
  return (
    <div
      aria-label="Illustration of Octave scripts, notebooks, and terminal workflows in CoCalc"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #fff7f1 52%, #f4f9ff 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
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
                  borderRadius: 8,
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
              Teach and run Octave without local setup drift.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Everyone opens the same project, so an Octave script that runs for
              one person runs the same way for the next. The environment,
              packages, and data stay with the work, not on a laptop that drifts
              out of sync.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              Project history keeps earlier states close, so a collaborator — or
              you, weeks later — can reopen a result, see how it was produced,
              and continue from it.
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
                label: "Reopen earlier versions from project history",
              },
              {
                icon: "sync",
                label: "Setup, packages, and data stay together",
              },
              {
                icon: "share-square",
                label: "Hand off the project without rebuilding it",
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
  const supportHref = featureSupportPath({
    body: "I want to discuss Octave workflows in CoCalc. Helpful context: notebooks, scripts, teaching or research use case, expected collaborators, and whether hosted or customer-operated CoCalc matters.",
    context: "octave",
    subject: "CoCalc Octave workflows",
    title: "Ask CoCalc about Octave workflows",
  });

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
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
                That makes it a practical way to run numerical courses,
                research, and prototyping — without asking every student or
                collaborator to maintain a local install.
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
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3}>When Octave belongs in CoCalc</Title>
            <BulletList
              items={[
                "A numerical course where students share one consistent environment.",
                "Numerical research and prototyping that benefits from shared files and history.",
                "Work that mixes Octave with notebooks, data, and write-ups in one project.",
                "A team that opens each other's Octave work and reviews it together.",
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
              <Button href={supportHref}>Ask about Octave workflows</Button>
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
