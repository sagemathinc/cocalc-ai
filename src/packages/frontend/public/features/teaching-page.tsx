/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSupportPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
const PANEL_RADIUS = 8;
const PANEL_SHADOW = `0 14px 34px ${alpha(PUBLIC_COLORS.heading, 0.07)}`;
const COURSE_ACCENT = COLORS.RUN;

function alpha(hexColor: string, opacity: number): string {
  const hex = hexColor.replace("#", "");
  if (hex.length !== 6) return hexColor;
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

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
        borderRadius: PANEL_RADIUS,
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
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: PANEL_SHADOW,
        height: "100%",
        padding: 22,
      }}
    >
      <Flex vertical gap={14}>
        <IconBadge accent={accent} icon={icon} />
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        <Paragraph style={{ margin: 0 }}>{children}</Paragraph>
      </Flex>
    </div>
  );
}

function CourseDashboardMock() {
  const students = [
    ["Maya", "active", COURSE_ACCENT],
    ["Alex", "working", PUBLIC_COLORS.brand],
    ["Priya", "active", COURSE_ACCENT],
    ["Jordan", "needs help", PUBLIC_COLORS.warning],
    ["Liam", "offline", PUBLIC_COLORS.mutedText],
    ["Diego", "collected", COLORS.AI_ASSISTANT_FONT],
  ];
  return (
    <div
      aria-label="Illustration of a CoCalc course workspace connected to student projects"
      style={{
        background: `linear-gradient(145deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.surfaceMuted} 55%, ${PUBLIC_COLORS.warningTint} 100%)`,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: `0 24px 70px ${alpha(PUBLIC_COLORS.heading, 0.12)}`,
        padding: 20,
      }}
    >
      <Flex vertical gap={14}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent={COURSE_ACCENT} icon="graduation-cap" />
            <div>
              <Text strong>Course</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                students, assignments, projects, and grading
              </div>
            </div>
          </Flex>
        </Flex>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={11}>
            <div
              style={{
                background: PUBLIC_COLORS.heading,
                borderRadius: PANEL_RADIUS,
                color: PUBLIC_COLORS.footerText,
                minHeight: 270,
                padding: 16,
              }}
            >
              <Flex vertical gap={12}>
                <Text style={{ color: PUBLIC_COLORS.footerText }}>
                  Assignments
                </Text>
                {[
                  ["Lab 4: PDEs", "Assign"],
                  ["HW 3: Dynamics", "Collect"],
                  ["Project proposal", "Grade"],
                ].map(([name, status]) => (
                  <Flex
                    align="center"
                    justify="space-between"
                    key={name}
                    style={{
                      background: alpha(PUBLIC_COLORS.surface, 0.09),
                      borderRadius: PANEL_RADIUS,
                      padding: "10px 12px",
                    }}
                  >
                    <Text style={{ color: PUBLIC_COLORS.surface }}>{name}</Text>
                    <Text strong style={{ color: PUBLIC_COLORS.footerText }}>
                      {status}
                    </Text>
                  </Flex>
                ))}
                <div
                  style={{
                    background: alpha(PUBLIC_COLORS.surface, 0.11),
                    borderRadius: PANEL_RADIUS,
                    color: PUBLIC_COLORS.footerText,
                    padding: "10px 12px",
                  }}
                >
                  nbgrader queue ready
                </div>
              </Flex>
            </div>
          </Col>
          <Col xs={24} md={13}>
            <div
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                minHeight: 270,
                padding: 14,
              }}
            >
              <Flex vertical gap={12}>
                <Flex align="center" gap={8}>
                  <Icon name="users" style={{ color: COURSE_ACCENT }} />
                  <Text strong>Student projects</Text>
                </Flex>
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  }}
                >
                  {students.map(([name, status, accent]) => (
                    <div
                      key={name}
                      style={{
                        background: PUBLIC_COLORS.surfaceMuted,
                        border: `1px solid ${PUBLIC_COLORS.border}`,
                        borderRadius: PANEL_RADIUS,
                        padding: 12,
                      }}
                    >
                      <Flex align="center" gap={8}>
                        <span
                          style={{
                            background: accent,
                            borderRadius: 999,
                            height: 10,
                            width: 10,
                          }}
                        />
                        <Text strong>{name}</Text>
                      </Flex>
                      <div
                        style={{
                          color: PUBLIC_COLORS.mutedText,
                          fontSize: 13,
                          marginTop: 4,
                        }}
                      >
                        {status}
                      </div>
                    </div>
                  ))}
                </div>
                <Text style={{ color: PUBLIC_COLORS.mutedText }}>
                  Help, history, and snapshots stay close to each student
                  project.
                </Text>
              </Flex>
            </div>
          </Col>
        </Row>
      </Flex>
    </div>
  );
}

function WorkflowDiagram() {
  const steps = [
    ["Instructor project", "Build materials", "folder"],
    ["Assign", "Copy to projects", "arrow-right"],
    ["Student projects", "Work live", "users"],
    ["Collect", "Bring work back", "cloud-download"],
    ["Grade", "nbgrader or review", "check-square"],
  ] as const;
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: `0 18px 52px ${alpha(PUBLIC_COLORS.heading, 0.08)}`,
        padding: 22,
      }}
    >
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
        }}
      >
        {steps.map(([title, caption, icon], index) => (
          <div
            key={title}
            style={{
              background:
                index === 0
                  ? PUBLIC_COLORS.warningTint
                  : PUBLIC_COLORS.surfaceMuted,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              minHeight: 150,
              padding: 14,
            }}
          >
            <Flex vertical gap={10}>
              <IconBadge
                accent={
                  index === 0 ? PUBLIC_COLORS.warning : PUBLIC_COLORS.brand
                }
                icon={icon}
              />
              <Text strong>{title}</Text>
              <Text style={{ color: PUBLIC_COLORS.mutedText }}>{caption}</Text>
            </Flex>
          </div>
        ))}
      </div>
    </div>
  );
}

function CourseBoundaryPanel() {
  const rows = [
    [
      "Keep in your LMS",
      "Rosters, calendars, announcements, and institution-wide communication.",
      PUBLIC_COLORS.mutedText,
    ],
    [
      "Use CoCalc for technical coursework",
      "Student projects, notebook and file assignments, grading, help, shared environments, and recovery.",
      COURSE_ACCENT,
    ],
    [
      "Use a notebook hub when",
      "A shared kernel service for mostly independent notebooks is enough.",
      PUBLIC_COLORS.brand,
    ],
  ];
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        padding: 22,
      }}
    >
      <Flex vertical gap={14}>
        {rows.map(([label, description, accent]) => (
          <div
            key={label}
            style={{
              borderLeft: `3px solid ${accent}`,
              paddingLeft: 14,
            }}
          >
            <Text strong style={{ display: "block" }}>
              {label}
            </Text>
            <Text style={{ color: PUBLIC_COLORS.mutedText, display: "block" }}>
              {description}
            </Text>
          </div>
        ))}
      </Flex>
    </div>
  );
}

export default function TeachingFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start on CoCalc.ai";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Use hosted CoCalc.ai";
  const supportHref = featureSupportPath({
    body: "I want to discuss CoCalc for technical course workflows. Helpful context: course size, notebook or terminal needs, grading workflow, LMS relationship, shared environment requirements, and whether hosted CoCalc.ai or another operating model matters.",
    context: "teaching",
    subject: "CoCalc technical course workflows",
    title: "Ask CoCalc about teaching workflows",
  });

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Text
                strong
                style={{
                  alignSelf: "flex-start",
                  color: COURSE_ACCENT,
                  fontSize: 12,
                  letterSpacing: 0,
                  textTransform: "uppercase",
                }}
              >
                Technical course workspace
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Teach where students compute, write, and collaborate
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc works beside the campus LMS as the place where students
                use notebooks, code, terminals, files, feedback, and recovery.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Keep rosters, calendars, announcements, and institution-wide
                communication in the LMS. Bring assignments into CoCalc when
                they need a real computing environment and instructor visibility
                into student work.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <Button href={`${GUIDE_BASE}/teaching/`}>Teaching guide</Button>
                <LinkButton href={appPath("products")}>
                  Compare product paths
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <CourseDashboardMock />
          </Col>
        </Row>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <StoryCard
            accent={COURSE_ACCENT}
            icon="users"
            title="Give each student a project"
          >
            Each student works in an isolated project for files, notebooks,
            terminals, output, feedback, and recovery.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent={PUBLIC_COLORS.brand}
            icon="folder"
            title="Hand out and collect work"
          >
            Distribute a folder to every student project, collect it back, grade
            it, and return feedback without upload friction.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent={PUBLIC_COLORS.warning}
            icon="cube"
            title="Keep the environment consistent"
          >
            Give a class the same course software stack, data, and tools without
            asking every student to configure a laptop.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Keep administration in the LMS. Run coursework in CoCalc.
              </Title>
              <Paragraph style={{ margin: 0 }}>
                The boundary should be obvious to instructors, students, and
                academic IT: the LMS coordinates the course, while CoCalc hosts
                the technical assignments and student working state.
              </Paragraph>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <CourseBoundaryPanel />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Run the assignment loop in student projects
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Instructor projects distribute materials, student projects hold
                the work, and collection brings submissions back without a
                separate upload cycle.
              </Paragraph>
              <BulletList
                items={[
                  "Hand out notebooks, scripts, data, LaTeX, and folders.",
                  "Collect and return work with feedback in the same project structure.",
                  "Use nbgrader, manual review, or peer grading when that fits the course.",
                  "Use project history when instructors or TAs need to understand how work evolved.",
                ]}
              />
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <WorkflowDiagram />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Flex vertical gap={12} style={{ maxWidth: 860 }}>
          <Title level={3} style={{ margin: 0 }}>
            Reduce setup and support friction
          </Title>
          <Paragraph style={{ margin: 0 }}>
            When everyone works in managed student projects, instructors can
            focus on the course instead of laptop configuration, missing files,
            or hard-to-reproduce student environments.
          </Paragraph>
          <BulletList
            items={[
              "Start students in a browser with the course software and data already available.",
              "Open a student project to inspect the same files, notebooks, and terminal state.",
              "Use snapshots and backups as a safety net around project work.",
            ]}
          />
          <Flex wrap gap={12}>
            <LinkButton href={`${GUIDE_BASE}/teaching/`}>
              Teaching guide
            </LinkButton>
            <Button href={`${GUIDE_BASE}/rootfs-management/`}>
              Environment guide
            </Button>
            <Button href={appPath("features/jupyter-notebook")}>
              Jupyter notebooks
            </Button>
          </Flex>
        </Flex>
      </PublicSection>

      <div style={{ marginBottom: 44 }}>
        <PublicSection>
          <Row gutter={[20, 20]} align="middle">
            <Col xs={24} lg={15}>
              <Title level={3} style={{ margin: 0 }}>
                Choose the teaching path that fits
              </Title>
              <Paragraph style={{ margin: "8px 0 0" }}>
                Start hosted for a course on CoCalc.ai, compare product paths
                when your institution needs a different operating model, or
                contact CoCalc to discuss larger teaching workflows.
              </Paragraph>
            </Col>
            <Col xs={24} lg={9}>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {finalCtaLabel}
                </Button>
                <Button href={appPath("products")}>
                  Compare product paths
                </Button>
                <Button href={supportHref}>Ask about teaching workflows</Button>
              </Flex>
            </Col>
          </Row>
        </PublicSection>
      </div>
    </Flex>
  );
}
