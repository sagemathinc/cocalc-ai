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
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";
import { IconBadge } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";
const COURSE_ACCENT = COLORS.RUN;

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
        borderRadius: PUBLIC_RADIUS.panel,
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
                Students run real assignments in a shared computing environment
                that instructors can see into, give feedback on, and recover
                with TimeTravel, while notebooks, code, and data stay in the
                same project.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                It works beside your existing LMS, so course coordination stays
                where it already lives while the technical work moves into
                student projects.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <Button href={`${GUIDE_BASE}/teaching/`}>Teaching guide</Button>
                <LinkButton href={appPath("products")}>
                  Compare operating models
                </LinkButton>
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

      <div style={{ marginBottom: 44 }}>
        <PublicSection>
          <Row
            className="cocalc-teaching-final-plan"
            gutter={[28, 24]}
            align="top"
          >
            <Col xs={24} lg={13}>
              <Title level={3} style={{ margin: 0 }}>
                Choose the teaching path that fits
              </Title>
              <Paragraph style={{ margin: "8px 0 0" }}>
                Start hosted for a course on CoCalc.ai. Use the guides when
                planning assignments or shared course software. Compare
                operating models or talk to CoCalc when procurement, licensing,
                or deployment questions matter.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {finalCtaLabel}
                </Button>
                <Button href={appPath("products")}>
                  Compare operating models
                </Button>
              </Flex>
            </Col>
            <Col xs={24} lg={11}>
              <Flex
                vertical
                gap={10}
                style={{
                  borderLeft: `3px solid ${PUBLIC_COLORS.brandSubtle}`,
                  paddingLeft: 18,
                }}
              >
                <Text strong>Useful planning guides</Text>
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
            </Col>
          </Row>
        </PublicSection>
      </div>
    </Flex>
  );
}
