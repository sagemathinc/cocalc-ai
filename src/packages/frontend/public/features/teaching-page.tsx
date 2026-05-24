/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

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
        borderRadius: 16,
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
        borderRadius: 22,
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
        <Paragraph style={{ margin: 0 }}>{children}</Paragraph>
      </Flex>
    </div>
  );
}

function CourseDashboardMock() {
  const students = [
    ["Maya", "active", "#389e0d"],
    ["Alex", "working", PUBLIC_COLORS.brand],
    ["Priya", "active", "#389e0d"],
    ["Jordan", "needs help", "#d48806"],
    ["Liam", "offline", PUBLIC_COLORS.mutedText],
    ["Diego", "collected", "#7c3aed"],
  ];
  return (
    <div
      aria-label="Illustration of a CoCalc course dashboard connected to student projects"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f4f9ff 55%, #fff8e8 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
        boxShadow: "0 24px 70px rgba(33, 49, 57, 0.12)",
        padding: 20,
      }}
    >
      <Flex vertical gap={14}>
        <Flex align="center" justify="space-between" wrap gap={10}>
          <Flex align="center" gap={10}>
            <IconBadge accent="#389e0d" icon="graduation-cap" />
            <div>
              <Text strong>Course</Text>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                students, assignments, projects, and grading
              </div>
            </div>
          </Flex>
          <Flex gap={8} wrap>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              live projects
            </Tag>
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              shared course file
            </Tag>
          </Flex>
        </Flex>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={11}>
            <div
              style={{
                background: "#10213f",
                borderRadius: 18,
                color: "#dbeafe",
                minHeight: 270,
                padding: 16,
              }}
            >
              <Flex vertical gap={12}>
                <Text style={{ color: "#93c5fd" }}>Assignments</Text>
                {[
                  ["Lab 4: PDEs", "Assign", "blue"],
                  ["HW 3: Dynamics", "Collect", "green"],
                  ["Project proposal", "Grade", "purple"],
                ].map(([name, status, color]) => (
                  <Flex
                    align="center"
                    justify="space-between"
                    key={name}
                    style={{
                      background: "rgba(255,255,255,0.09)",
                      borderRadius: 12,
                      padding: "10px 12px",
                    }}
                  >
                    <Text style={{ color: "#f8fafc" }}>{name}</Text>
                    <Tag color={color} style={{ marginInlineEnd: 0 }}>
                      {status}
                    </Tag>
                  </Flex>
                ))}
                <div
                  style={{
                    background: "rgba(255,255,255,0.11)",
                    borderRadius: 12,
                    color: "#bbf7d0",
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
                background: "#fff",
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 18,
                minHeight: 270,
                padding: 14,
              }}
            >
              <Flex vertical gap={12}>
                <Flex align="center" gap={8}>
                  <Icon name="users" style={{ color: "#389e0d" }} />
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
                        background: "#f8fafc",
                        border: `1px solid ${PUBLIC_COLORS.border}`,
                        borderRadius: 14,
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
                <Flex gap={8} wrap>
                  <Tag style={{ marginInlineEnd: 0 }}>side chat</Tag>
                  <Tag style={{ marginInlineEnd: 0 }}>TimeTravel</Tag>
                  <Tag style={{ marginInlineEnd: 0 }}>snapshots</Tag>
                </Flex>
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
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 28,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
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
              background: index === 0 ? "#fff7e6" : "#f8fafc",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 18,
              minHeight: 150,
              padding: 14,
            }}
          >
            <Flex vertical gap={10}>
              <IconBadge
                accent={index === 0 ? "#ad6800" : PUBLIC_COLORS.brand}
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

function PositioningDiagram() {
  const rows = [
    ["LMS", "rosters, calendars, announcements, institutional shell"],
    ["Notebook hub", "kernels, notebooks, autograding, compute"],
    [
      "CoCalc",
      "live student projects, assignments, files, terminals, TimeTravel, rootfs",
    ],
  ];
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 26,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.08)",
        padding: 24,
      }}
    >
      <Flex vertical gap={12}>
        {rows.map(([label, description], index) => (
          <Flex align="center" gap={12} key={label} wrap>
            <Tag
              color={index === 2 ? "blue" : undefined}
              style={{ marginInlineEnd: 0, minWidth: 118 }}
            >
              {label}
            </Tag>
            <Icon name="arrow-right" style={{ color: PUBLIC_COLORS.brand }} />
            <Text style={{ color: PUBLIC_COLORS.mutedText }}>
              {description}
            </Text>
          </Flex>
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
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start teaching with CoCalc";

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Tag
                color="green"
                style={{ alignSelf: "flex-start", marginInlineEnd: 0 }}
              >
                Live computational classroom
              </Tag>
              <Title level={2} style={{ margin: 0 }}>
                Teach in the same environment where students work
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc is strongest when a course is more than files in an LMS:
                notebooks, terminals, code, data, LaTeX, assignments, grading,
                history, and help all happen in live student projects.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Use your LMS for the institution-facing course shell if that is
                what your school expects. Use CoCalc when the course work itself
                needs a real collaborative compute environment.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <Button href={`${GUIDE_BASE}/teaching/`}>
                  Read the teaching guide
                </Button>
                <LinkButton href={`${GUIDE_BASE}/teaching/`}>
                  Instructor manual
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
          <StoryCard accent="#389e0d" icon="users" title="Student projects">
            Each student works in an isolated project with files, notebooks,
            terminals, outputs, collaborators, and history.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#1677ff" icon="folder" title="Assign and collect">
            Distribute a folder to every student project, collect it back, grade
            it, and return feedback without upload friction.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#7c3aed" icon="history" title="TimeTravel">
            See how students got to a result, recover accidental damage, and
            make learning safer.
          </StoryCard>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StoryCard accent="#d48806" icon="cube" title="Course RootFS">
            Give a class the same managed software stack, data, and tools from
            the first minute.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={12}>
            <PositioningDiagram />
          </Col>
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Tag
                color="blue"
                style={{ alignSelf: "flex-start", marginInlineEnd: 0 }}
              >
                Where CoCalc fits
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Pair CoCalc with the systems your institution already uses
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Canvas, Moodle, and similar systems are good at rosters,
                calendars, announcements, and institution-wide communication.
                Notebook hubs are good at running notebooks.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc becomes the teaching center when instructors need to work
                inside the same live technical environment as students.
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
        <div
          style={{
            background: "linear-gradient(135deg, #10213f 0%, #225c74 100%)",
            borderRadius: 30,
            color: "#fff",
            padding: 40,
          }}
        >
          <Title level={3} style={{ color: "#fff", margin: 0 }}>
            Grade in the same environment students used
          </Title>
          <Row gutter={[16, 16]}>
            {[
              [
                "Manual review",
                "Open collected work, leave comments, edit feedback, and return graded files.",
              ],
              [
                "nbgrader",
                "Autograde Jupyter notebooks with configurable timeouts, output limits, and hidden-test policy.",
              ],
              [
                "Peer grading",
                "Randomly redistribute collected work so students can grade each other with instructor guidelines.",
              ],
              [
                "History",
                "Use TimeTravel and activity to understand how work evolved.",
              ],
            ].map(([title, description], index) => (
              <Col key={title} xs={24} md={12} xl={6}>
                <div
                  style={{
                    background: "rgba(255,255,255,0.1)",
                    border: "1px solid rgba(255,255,255,0.16)",
                    borderRadius: 20,
                    height: "100%",
                    padding: 18,
                  }}
                >
                  <div
                    style={{
                      alignItems: "center",
                      background: "#f0ad2e",
                      borderRadius: 999,
                      color: "#10213f",
                      display: "inline-flex",
                      fontWeight: 900,
                      height: 28,
                      justifyContent: "center",
                      marginBottom: 16,
                      width: 28,
                    }}
                  >
                    {index + 1}
                  </div>
                  <Title
                    level={4}
                    style={{ color: "#fff", margin: "0 0 10px" }}
                  >
                    {title}
                  </Title>
                  <Paragraph
                    style={{ color: "rgba(255,255,255,0.78)", margin: 0 }}
                  >
                    {description}
                  </Paragraph>
                </div>
              </Col>
            ))}
          </Row>
        </div>
      </PublicSection>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSection>
            <Flex vertical gap={12}>
              <IconBadge accent="#1677ff" icon="jupyter" />
              <Title level={3} style={{ margin: 0 }}>
                Notebook teaching works with nbgrader
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc supports notebook-based grading workflows including
                automatic checks, hidden-test policy, output limits, timeouts,
                and choosing where autograding runs.
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
              <IconBadge accent="#389e0d" icon="terminal" />
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
              <Tag
                color="gold"
                style={{ alignSelf: "flex-start", marginInlineEnd: 0 }}
              >
                Real instructor feedback
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                The setup story matters
              </Title>
              <Paragraph style={{ fontSize: 19, margin: 0 }}>
                &ldquo;Students don&apos;t need to install any software at
                all.&rdquo;
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Kiran Kedlaya, Department of Mathematics, UC San Diego
              </Paragraph>
              <LinkButton href="https://cocalc.com/testimonials">
                Read more testimonials
              </LinkButton>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                Make the environment part of the course
              </Title>
              <Paragraph style={{ margin: 0 }}>
                A course RootFS can give every student the same software stack,
                libraries, tools, and data. Instructors can also use snapshots
                and backups as a safety net around project work.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button href={`${GUIDE_BASE}/rootfs-management/`}>
                  RootFS guide
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
                Choose CoCalc when the course work is live and technical
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
                {helpEmail ? (
                  <Button href={`mailto:${helpEmail}`}>Contact support</Button>
                ) : null}
              </Flex>
            </Col>
          </Row>
        </PublicSection>
      </div>
    </Flex>
  );
}
