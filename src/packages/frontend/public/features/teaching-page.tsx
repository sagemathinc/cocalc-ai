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
                  nbgrader: 26 notebooks ready
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

function CourseFitDiagram() {
  const rows = [
    ["LMS", "rosters, calendars, announcements, institutional shell"],
    ["Notebook hub", "kernels, notebooks, autograding, compute"],
    [
      "CoCalc",
      "student projects, assignments, files, terminals, TimeTravel, shared environments",
    ],
  ];
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: `0 18px 52px ${alpha(PUBLIC_COLORS.heading, 0.08)}`,
        padding: 24,
      }}
    >
      <Flex vertical gap={12}>
        {rows.map(([label, description], index) => (
          <div
            key={label}
            style={{
              background:
                index === 2
                  ? alpha(PUBLIC_COLORS.brand, 0.08)
                  : PUBLIC_COLORS.surfaceMuted,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              display: "grid",
              gap: 10,
              gridTemplateColumns: "120px minmax(0, 1fr)",
              padding: "12px 14px",
            }}
          >
            <Text strong>{label}</Text>
            <Text style={{ color: PUBLIC_COLORS.mutedText }}>
              {description}
            </Text>
          </div>
        ))}
      </Flex>
    </div>
  );
}

export default function TeachingFeaturePage({
  helpEmail,
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
                CoCalc complements the campus LMS by keeping notebooks,
                terminals, code, data, LaTeX, assignments, grading, history, and
                help inside student projects.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Use your LMS for rosters, calendars, announcements, and
                institution-wide communication. Use CoCalc for the project
                workspace where technical course work happens.
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
        <Col xs={24} md={12} xl={6}>
          <StoryCard
            accent={COURSE_ACCENT}
            icon="users"
            title="Student projects"
          >
            Each student works in an isolated project with files, notebooks,
            terminals, outputs, collaborators, and history.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard
            accent={PUBLIC_COLORS.brand}
            icon="folder"
            title="Assign and collect"
          >
            Distribute a folder to every student project, collect it back, grade
            it, and return feedback without upload friction.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard
            accent={COLORS.AI_ASSISTANT_FONT}
            icon="history"
            title="Review history"
          >
            See how students got to a result, recover accidental damage, and
            make recovery easier.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard
            accent={PUBLIC_COLORS.warning}
            icon="cube"
            title="Shared environment"
          >
            Give a class the same course software stack, data, and tools without
            asking every student to configure a laptop.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <CourseFitDiagram />
          </Col>
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Pair CoCalc with the systems your institution already uses
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Canvas, Moodle, and similar systems are good at rosters,
                calendars, announcements, and institution-wide communication.
                Notebook hubs are good at running notebooks and kernels.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc becomes the course workspace when instructors need
                assignments, help, grading, files, and compute to stay close to
                student projects.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Assign, collect, grade, return
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Students do not need to package files and submit them through a
                separate upload form. The instructor assigns course materials to
                student projects and collects the work back into the course
                project.
              </Paragraph>
              <BulletList
                items={[
                  "Hand out notebooks, scripts, data, LaTeX, and folders.",
                  "Collect student work without depending on manual uploads.",
                  "Return graded files and feedback to each student project.",
                  "Use peer grading when students should review each other.",
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
        <Flex vertical gap={18}>
          <div>
            <Title level={3} style={{ margin: "0 0 8px" }}>
              Grade in the same workspace students used
            </Title>
            <Paragraph style={{ margin: 0, maxWidth: 760 }}>
              Course files, notebook output, comments, and project history stay
              close enough for instructors and TAs to review work without
              reconstructing each student environment.
            </Paragraph>
          </div>
          <Row gutter={[16, 16]}>
            {[
              [
                "Manual review",
                "Open collected work, leave comments, edit feedback, and return graded files.",
                "edit",
                PUBLIC_COLORS.brand,
              ],
              [
                "nbgrader",
                "Use notebook grading workflows with output limits, timeouts, and hidden-test policy.",
                "jupyter",
                COLORS.RUN,
              ],
              [
                "Peer grading",
                "Redistribute collected work when students should review each other with instructor guidelines.",
                "users",
                COLORS.AI_ASSISTANT_FONT,
              ],
              [
                "Project history",
                "Use TimeTravel and activity to understand how work evolved.",
                "history",
                PUBLIC_COLORS.warning,
              ],
            ].map(([title, description, icon, accent]) => (
              <Col key={title} xs={24} md={12} xl={6}>
                <StoryCard
                  accent={accent as string}
                  icon={icon as IconName}
                  title={title}
                >
                  {description}
                </StoryCard>
              </Col>
            ))}
          </Row>
        </Flex>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Flex vertical gap={12}>
              <IconBadge accent={PUBLIC_COLORS.brand} icon="jupyter" />
              <Title level={3} style={{ margin: 0 }}>
                Notebook teaching works with nbgrader
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc supports notebook-based grading workflows, including
                automatic checks, hidden-test policy, output limits, and
                timeouts.
              </Paragraph>
              <LinkButton href={`${GUIDE_BASE}/teaching/`}>
                nbgrader documentation
              </LinkButton>
            </Flex>
          </PublicSection>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Flex vertical gap={12}>
              <IconBadge accent={COURSE_ACCENT} icon="terminal" />
              <Title level={3} style={{ margin: 0 }}>
                Help students in context
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Instructors and TAs can open a student project, inspect the same
                files, notebooks, terminals, and history, and use side chat to
                answer questions close to the work.
              </Paragraph>
              <Button href={appPath("features/terminal")}>
                Terminal workflows
              </Button>
            </Flex>
          </PublicSection>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Reduce local setup friction
              </Title>
              <Paragraph style={{ margin: 0 }}>
                For browser-based courses, instructors can give students a
                shared workspace without asking every student to assemble the
                same software stack locally.
              </Paragraph>
              <LinkButton href={`${GUIDE_BASE}/teaching/`}>
                Teaching guide
              </LinkButton>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Share a reusable course environment
              </Title>
              <Paragraph style={{ margin: 0 }}>
                A shared course environment can give every student the same
                libraries, tools, and data. Instructors can also use snapshots
                and backups as a safety net around project work.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button href={`${GUIDE_BASE}/rootfs-management/`}>
                  Environment guide
                </Button>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
              </Flex>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <div style={{ marginBottom: 44 }}>
        <PublicSection>
          <Row gutter={[20, 20]} align="middle">
            <Col xs={24} lg={15}>
              <Title level={3} style={{ margin: 0 }}>
                For courses that need a shared workspace
              </Title>
              <Paragraph style={{ margin: "8px 0 0" }}>
                If students need notebooks, terminals, data, LaTeX, shared
                environments, realtime help, grading, and recoverable history,
                CoCalc keeps those pieces in one teaching workspace.
              </Paragraph>
            </Col>
            <Col xs={24} lg={9}>
              <Flex wrap gap={12} justify="end">
                <Button type="primary" href={primaryCtaHref}>
                  {finalCtaLabel}
                </Button>
                <Button href={appPath("products")}>
                  Compare product paths
                </Button>
                {helpEmail ? (
                  <Button href={`mailto:${helpEmail}`}>Talk with CoCalc</Button>
                ) : null}
              </Flex>
            </Col>
          </Row>
        </PublicSection>
      </div>
    </Flex>
  );
}
