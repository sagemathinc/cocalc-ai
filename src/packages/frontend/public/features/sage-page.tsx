/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

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

function StoryCard({
  accent = PUBLIC_COLORS.brand,
  children,
  icon,
  title,
}: {
  accent?: string;
  children: ReactNode;
  icon: IconName;
  title: string;
}) {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        boxShadow: "0 14px 40px rgba(33, 49, 57, 0.07)",
        height: "100%",
        padding: 22,
      }}
    >
      <Flex vertical gap={14}>
        <IconBadge accent={accent} icon={icon} />
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
          {children}
        </Paragraph>
      </Flex>
    </div>
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
              A free, open alternative for computational mathematics courses.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              For many undergraduate math courses, SageMath fills the same broad
              role as Mathematica, Maple, or MATLAB: symbolic computation,
              calculus, linear algebra, data work, and 2D or 3D plotting. The
              difference is that SageMath is free, open source, and built as a
              large Python library.
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

function ResearchFlow() {
  const steps = [
    {
      body: "Run Sage computations on a dedicated project host, including spot instances when cost matters.",
      icon: "server",
      title: "Dedicated compute",
    },
    {
      body: "Use terminals, scheduled automation, Codex, and restart-aware scripts to keep long jobs productive.",
      icon: "sync-alt",
      title: "Keep jobs moving",
    },
    {
      body: "Install a database or write structured outputs so partial results survive crashes and restarts.",
      icon: "database",
      title: "Track results",
    },
  ] satisfies { body: string; icon: IconName; title: string }[];

  return (
    <section
      style={{
        background: "#0b1522",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        color: "#dbeafe",
        minWidth: 0,
        padding: 24,
      }}
    >
      <Flex vertical gap={22}>
        <div>
          <Title level={3} style={{ color: "#fff", margin: 0 }}>
            SageMath can be more than an interactive calculator.
          </Title>
          <Paragraph style={{ color: "#cbd5e1", margin: "8px 0 0" }}>
            CoCalc-AI makes Sage development and long-running mathematics
            research computations practical in a project, instead of forcing the
            work onto a laptop or a one-off server.
          </Paragraph>
        </div>
        <Row gutter={[14, 14]}>
          {steps.map((step) => (
            <Col key={step.title} xs={24} lg={8}>
              <div
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  height: "100%",
                  padding: 18,
                }}
              >
                <Flex vertical gap={12}>
                  <span
                    style={{
                      alignItems: "center",
                      background: "rgba(255,255,255,0.1)",
                      border: "1px solid rgba(255,255,255,0.16)",
                      borderRadius: 8,
                      display: "inline-flex",
                      fontSize: 24,
                      height: 52,
                      justifyContent: "center",
                      width: 52,
                    }}
                  >
                    <Icon name={step.icon} />
                  </span>
                  <Title level={4} style={{ color: "#fff", margin: 0 }}>
                    {step.title}
                  </Title>
                  <Paragraph style={{ color: "#cbd5e1", margin: 0 }}>
                    {step.body}
                  </Paragraph>
                </Flex>
              </div>
            </Col>
          ))}
        </Row>
      </Flex>
    </section>
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
                Use SageMath where its history and future meet.
              </Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                SageMath was started in 2004 by William Stein, a mathematician
                and college professor who later became the lead developer and
                CEO behind CoCalc. CoCalc is not just another place that happens
                to run Sage; it grew out of the same mathematical computing
                community.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Today, SageMath is a broad community project and a major open
                source Python-based system for computational mathematics, while
                CoCalc provides the collaborative projects, notebooks,
                terminals, LaTeX, teaching tools, and compute infrastructure
                around it.
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

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <StoryCard accent="#389e0d" icon="sagemath" title="Open mathematics">
            Sage combines algebra, number theory, calculus, plotting,
            combinatorics, numerical work, and much more through a Python-first
            interface.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#2f6fda" icon="jupyter" title="Notebook first">
            Use Sage in Jupyter notebooks with durable execution, collaboration,
            widgets, TimeTravel, and the rest of the CoCalc project close by.
          </StoryCard>
        </Col>
        <Col xs={24} lg={8}>
          <StoryCard accent="#ad6800" icon="tex" title="SageTeX included">
            Put Sage computations directly into LaTeX documents, so examples,
            tables, and figures can be regenerated instead of pasted by hand.
          </StoryCard>
        </Col>
      </Row>

      <TeachingComparison />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Build, test, and develop Sage from source.
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc-AI projects are fast enough and flexible enough for Sage
                development itself: clone the Sage source, install build
                dependencies, compile, run tests, and use terminals or Codex to
                manage the messy details.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That was not a realistic workflow in the older CoCalc.com
                environment. In the current container-based CoCalc-AI model, a
                project can be a practical Linux development environment.
              </Paragraph>
              <BulletList
                items={[
                  "Use sudo and normal Linux package managers for build dependencies.",
                  "Keep source, build logs, test output, and notes in the same project.",
                  "Collaborate with another developer or ask Codex to inspect failures.",
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
                  ["github", "Clone Sage source"],
                  ["terminal", "Build in a project terminal"],
                  ["bug", "Run targeted tests"],
                  ["robot", "Use Codex for build failures"],
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

      <ResearchFlow />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3} style={{ margin: 0 }}>
              When SageMath belongs in CoCalc
            </Title>
            <BulletList
              items={[
                "Credible SageMath support from the team and history behind CoCalc.",
                "A free, open source Python-based alternative for computational math courses.",
                "Integrated SageTeX support in the collaborative LaTeX editor.",
                "A real Linux project environment for Sage development and research computations.",
              ]}
            />
            <Flex wrap gap={12}>
              <Button href={appPath("features/latex-editor")}>
                LaTeX editor
              </Button>
              <Button href={appPath("features/terminal")}>
                Terminal workflows
              </Button>
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
        <LinkButton href={`${GUIDE_BASE}/cocalc-for-latex/`}>
          SageTeX documentation
        </LinkButton>
      </PublicSection>
    </Flex>
  );
}
