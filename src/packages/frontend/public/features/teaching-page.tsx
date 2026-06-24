/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { FEATURE_ACCENTS } from "./feature-accents";
import { BulletList, featureAppPath as appPath } from "./page-components";
import { FeatureFinalBand, IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
const COURSE_ACCENT = FEATURE_ACCENTS.teaching;

function CourseDashboardMock() {
  const students = [
    ["Maya", "active", COURSE_ACCENT],
    ["Alex", "working", PUBLIC_COLORS.brand],
    ["Priya", "active", COURSE_ACCENT],
    ["Jordan", "needs help", PUBLIC_COLORS.warning],
    ["Liam", "offline", PUBLIC_COLORS.mutedText],
    ["Diego", "collected", PUBLIC_COLORS.info],
  ];
  return (
    <div
      aria-label="Illustration of a CoCalc course workspace connected to student projects"
      role="img"
      style={{
        background: `linear-gradient(145deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.surfaceMuted} 55%, ${PUBLIC_COLORS.warningTint} 100%)`,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
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
              className="cocalc-teaching-assignment-panel"
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                color: PUBLIC_COLORS.heading,
                minHeight: 270,
                padding: 16,
              }}
            >
              <Flex vertical gap={12}>
                <Text style={{ color: PUBLIC_COLORS.heading }}>
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
                      background: PUBLIC_COLORS.surface,
                      border: `1px solid ${alpha(PUBLIC_COLORS.brand, 0.12)}`,
                      borderRadius: PUBLIC_RADIUS.panel,
                      padding: "10px 12px",
                    }}
                  >
                    <Text
                      style={{
                        color: PUBLIC_COLORS.heading,
                        flex: "1 1 auto",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {name}
                    </Text>
                    <Text
                      strong
                      style={{
                        color: PUBLIC_COLORS.heading,
                        flex: "0 0 auto",
                        marginLeft: 8,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {status}
                    </Text>
                  </Flex>
                ))}
                <div
                  style={{
                    background: PUBLIC_COLORS.warningTint,
                    border: `1px solid ${alpha(PUBLIC_COLORS.warning, 0.18)}`,
                    borderRadius: PUBLIC_RADIUS.panel,
                    color: PUBLIC_COLORS.heading,
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
                borderRadius: PUBLIC_RADIUS.panel,
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
                        borderRadius: PUBLIC_RADIUS.panel,
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
        borderRadius: PUBLIC_RADIUS.panel,
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
              borderRadius: PUBLIC_RADIUS.panel,
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

export default function TeachingFeaturePage({
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
    : "Start a course in CoCalc";

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
                  color: PUBLIC_COLORS.heading,
                  fontSize: PUBLIC_TYPE.eyebrow,
                  letterSpacing: 0,
                  textTransform: "uppercase",
                }}
              >
                Technical course workspace
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Teach where students compute, write, and collaborate
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Run coursework in shared projects while the LMS keeps rosters
                and calendars.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <Button href={`${GUIDE_BASE}/teaching/`}>Teaching guide</Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <CourseDashboardMock />
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
                  "Use TimeTravel when instructors or TAs need to understand how student work evolved.",
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
        <FeatureFinalBand
          action={{
            body: "Create an account, start the technical coursework in projects, and use the guides when planning assignments or shared environments.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Start with course projects",
          }}
          relatedLinks={[
            { href: `${GUIDE_BASE}/teaching/`, label: "Teaching guide" },
            {
              href: `${GUIDE_BASE}/rootfs-management/`,
              label: "Environment guide",
            },
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            { href: appPath("products"), label: "Compare operating models" },
          ]}
          title="When technical coursework belongs in CoCalc"
        >
          <BulletList
            items={[
              "A notebook hub is enough for standalone notebooks; CoCalc earns its place when assignments need files, terminals, feedback, and history together in each student project.",
              "Keep the LMS responsible for rosters, calendars, announcements, and course-wide communication.",
              "Keep feedback, grading, TimeTravel history, and help close to each student project.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
