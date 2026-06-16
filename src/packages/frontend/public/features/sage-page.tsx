/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

function IconBadge({
  accent = PUBLIC_COLORS.brand,
  icon,
}: {
  accent?: string;
  icon: IconName;
}) {
  return (
    <span
      style={{
        alignItems: "center",
        background: `${accent}14`,
        border: `1px solid ${accent}33`,
        borderRadius: 8,
        color: accent,
        display: "inline-flex",
        flex: "0 0 auto",
        fontSize: 24,
        height: 52,
        justifyContent: "center",
        width: 52,
      }}
    >
      <Icon name={icon} />
    </span>
  );
}

function SageWorkspaceMock() {
  const blocks = [
    {
      accent: "#389e0d",
      body: "algebra, calculus, number theory, plotting",
      icon: "sagemath",
      title: "SageMath",
    },
    {
      accent: "#2f6fda",
      body: "notebooks, Python libraries, widgets",
      icon: "jupyter",
      title: "Jupyter",
    },
    {
      accent: "#ad6800",
      body: "SageTeX, papers, handouts, figures",
      icon: "tex",
      title: "LaTeX",
    },
    {
      accent: "#7c3aed",
      body: "terminals, databases, Codex, long jobs",
      icon: "terminal",
      title: "Research",
    },
  ] satisfies {
    accent: string;
    body: string;
    icon: IconName;
    title: string;
  }[];

  return (
    <div
      aria-label="Illustration of SageMath connected to notebooks, LaTeX, terminals, and research workflows"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f3fbf3 52%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#389e0d" icon="sagemath" />
            <div>
              <Text strong>SageMath in CoCalc</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                open mathematical software in a collaborative project
              </div>
            </div>
          </Flex>
        </Flex>

        <Row gutter={[12, 12]}>
          {blocks.map((block) => (
            <Col key={block.title} xs={24} sm={12}>
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
                  <IconBadge accent={block.accent} icon={block.icon} />
                  <div>
                    <Text strong>{block.title}</Text>
                    <div style={{ color: PUBLIC_COLORS.mutedText }}>
                      {block.body}
                    </div>
                  </div>
                </Flex>
              </div>
            </Col>
          ))}
        </Row>

        <div
          style={{
            background: "#0b1522",
            borderRadius: 8,
            color: "#dbeafe",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "rgba(255,255,255,0.08)",
              display: "flex",
              gap: 8,
              padding: "10px 14px",
            }}
          >
            {["#ff6b6b", "#ffd166", "#06d6a0"].map((color) => (
              <span
                aria-hidden="true"
                key={color}
                style={{
                  background: color,
                  borderRadius: "50%",
                  height: 10,
                  width: 10,
                }}
              />
            ))}
            <Text style={{ color: "#dbeafe", marginLeft: 8 }}>sage</Text>
          </div>
          <Flex
            vertical
            gap={8}
            style={{
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              padding: 16,
            }}
          >
            <Text style={{ color: "#bfdbfe" }}>sage: factor(x^8 - 1)</Text>
            <Text style={{ color: "#86efac" }}>
              (x - 1)*(x + 1)*(x^2 + 1)*(x^4 + 1)
            </Text>
            <Text style={{ color: "#bfdbfe" }}>
              sage: plot(sin(x^2), (x, -4, 4))
            </Text>
          </Flex>
        </div>
      </Flex>
    </div>
  );
}

function TeachingComparison() {
  const tools = [
    ["calculator", "symbolic math"],
    ["line-chart", "2D and 3D plotting"],
    ["python", "Python libraries"],
    ["graduation-cap", "course workflows"],
  ] satisfies [IconName, string][];

  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={11}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              An open computational mathematics environment for courses.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              For many undergraduate math courses, SageMath supports symbolic
              computation, calculus, linear algebra, data work, and 2D or 3D
              plotting. SageMath is free, open source, and built as a large
              Python library.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              In CoCalc, students can use Sage without local installation, and
              instructors can pair it with course projects, assignments,
              nbgrader, TimeTravel, and shared environments.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={13}>
          <div
            style={{
              background: "#fff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 8,
              boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
              padding: 22,
            }}
          >
            <Row gutter={[12, 12]}>
              {tools.map(([icon, label]) => (
                <Col key={label} xs={24} sm={12}>
                  <Flex
                    align="center"
                    gap={12}
                    style={{
                      background: "#f7fbff",
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: 8,
                      height: "100%",
                      padding: 14,
                    }}
                  >
                    <IconBadge accent="#389e0d" icon={icon} />
                    <Text strong>{label}</Text>
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

export default function SageFeaturePage({
  helpEmail,
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start using SageMath on CoCalc";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Use SageMath inside collaborative mathematics projects.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                CoCalc has long-standing roots in the SageMath community. It
                gives SageMath a collaborative project environment for
                notebooks, terminals, LaTeX documents, teaching workflows, and
                supporting files.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Use SageMath for computational mathematics while keeping the
                surrounding work close enough for students, collaborators, and
                reviewers to follow.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
                <Button href={appPath("features/teaching")}>Teaching</Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <SageWorkspaceMock />
          </Col>
        </Row>
      </PublicSection>

      <TeachingComparison />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Use Sage with the surrounding project.
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Some Sage workflows need more than an interactive worksheet:
                source files, terminal commands, generated figures, logs, and
                notes.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                A CoCalc project keeps those materials beside notebooks and
                LaTeX documents so a collaborator or instructor can inspect how
                the result was produced.
              </Paragraph>
              <BulletList
                items={[
                  "Keep Sage notebooks, source files, logs, and notes in the same project.",
                  "Use terminals for package tools, scripts, and generated outputs.",
                  "Keep longer computations, terminal output, notes, and reusable results close to the computation.",
                  "Let collaborators or Codex inspect errors with the surrounding context.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <div
              style={{
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 8,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
                padding: 22,
              }}
            >
              <Flex vertical gap={14}>
                {[
                  ["file", "Keep source files"],
                  ["terminal", "Run project commands"],
                  ["bug", "Inspect errors"],
                  ["robot", "Use Codex with context"],
                ].map(([icon, label]) => (
                  <Flex
                    align="center"
                    gap={12}
                    key={label}
                    style={{
                      background: "#f7fbff",
                      border: `1px solid ${PUBLIC_COLORS.border}`,
                      borderRadius: 8,
                      padding: 14,
                    }}
                  >
                    <IconBadge accent="#389e0d" icon={icon as IconName} />
                    <Text strong>{label}</Text>
                  </Flex>
                ))}
              </Flex>
            </div>
          </Col>
        </Row>
      </PublicSection>
      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3} style={{ margin: 0 }}>
              When SageMath belongs in CoCalc
            </Title>
            <BulletList
              items={[
                "Use SageMath in collaborative projects built around notebooks, terminals, LaTeX, and course workflows.",
                "A free, open source Python-based environment for computational math courses.",
                "Integrated SageTeX support in the collaborative LaTeX editor.",
                "A Linux project environment for Sage notebooks, source files, scripts, and research computations.",
              ]}
            />
            <Flex wrap gap={12}>
              <Button href={appPath("features/latex-editor")}>
                LaTeX editor
              </Button>
              <Button href={appPath("features/terminal")}>
                Terminal workflows
              </Button>
              <LinkButton href={`${GUIDE_BASE}/cocalc-for-latex/`}>
                SageTeX documentation
              </LinkButton>
              {helpEmail ? (
                <Button href={`mailto:${helpEmail}`}>Contact support</Button>
              ) : null}
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <div
              style={{
                background: "#10213f",
                borderRadius: 8,
                boxShadow: "0 18px 52px rgba(33, 49, 57, 0.12)",
                color: "#fff",
                padding: 26,
              }}
            >
              <Title level={4} style={{ color: "#fff", margin: "0 0 10px" }}>
                Start using SageMath
              </Title>
              <Paragraph style={{ color: "#dbeafe", margin: 0 }}>
                Open a project and use Sage in notebooks, terminals, LaTeX
                documents, courses, or long-running research jobs.
              </Paragraph>
              <Button
                href={primaryCtaHref}
                size="large"
                style={{ marginTop: 22, width: "fit-content" }}
                type="primary"
              >
                {finalCtaLabel}
              </Button>
            </div>
          </Col>
        </Row>
      </PublicSection>
    </Flex>
  );
}
