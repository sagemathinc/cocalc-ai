/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { BulletList, featureAppPath as appPath } from "./page-components";
import { ContextList, IconBadge, StartCard } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

function MoreLanguagesProjectMock() {
  const blocks = [
    ["file-code", "Compiled code", "C, C++, Fortran, Rust, Go"],
    ["terminal", "Scripting and shell", "Bash, Perl, Ruby, CLI tools"],
    ["code", "JVM and web", "Java, JavaScript, TypeScript"],
    ["database", "Data workflows", "SQL, data files, pipelines"],
  ] satisfies [IconName, string, string][];

  return (
    <div
      aria-label="Illustration of additional language workflows in a CoCalc project"
      style={{
        background:
          "linear-gradient(145deg, #ffffff 0%, #f5f9ff 54%, #f7faf7 100%)",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.lg,
        padding: 20,
      }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" gap={10} wrap>
          <IconBadge accent="#4b5563" icon="code" />
          <div>
            <Text strong>Project language stack</Text>
            <div style={{ color: PUBLIC_COLORS.mutedText }}>
              editors, terminals, scripts, notebooks, and shared files
            </div>
          </div>
        </Flex>

        <Row gutter={[12, 12]}>
          {blocks.map(([icon, title, body]) => (
            <Col key={title} xs={24} sm={12}>
              <div
                style={{
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: PUBLIC_RADIUS.panel,
                  height: "100%",
                  padding: 14,
                }}
              >
                <Flex align="center" gap={12}>
                  <IconBadge accent="#4b5563" icon={icon} size="sm" />
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

function MoreLanguagesFit() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            <Title level={3} style={{ margin: 0 }}>
              Use the language that fits the project.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              The headline feature cards cover the most common public pages, but
              CoCalc projects are ordinary collaborative Linux workspaces. That
              makes room for compiled languages, JVM and web stacks, shell
              scripts, SQL/data tools, command-line tools, and supporting code
              that does not need its own top-level feature page.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              Keep the source, generated output, notes, and review context
              together so collaborators can see how the work was run; when the
              work moves into notebooks or project documents, visible cursors
              and, for notebooks, shared kernel sessions keep review in the same
              place.
            </Paragraph>
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <ContextList
            accent="#4b5563"
            items={[
              {
                icon: "terminal",
                label: "Run compilers, scripts, and command-line tools",
              },
              {
                icon: "file-code",
                label: "Edit source files beside notebooks and reports",
              },
              {
                icon: "jupyter",
                label: "Connect outputs back to notebook workflows",
              },
              {
                icon: "users",
                label:
                  "Share live notebooks and project files with collaborators",
              },
            ]}
            title="Project context"
          />
        </Col>
      </Row>
    </PublicSection>
  );
}

export default function MoreLanguagesFeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : appPath("auth/sign-up");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalLabel = isAuthenticated ? "Open projects" : "Start a project";

  return (
    <Flex vertical gap={22}>
      <PublicSection>
        <Row gutter={[28, 28]} align="middle">
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Use many other languages from the same project.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Work with C, C++, Fortran, Rust, Go, Java, Bash, SQL,
                JavaScript, TypeScript, and many other tools in the same place
                as notebooks, files, terminals, and collaborators.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc is a good fit when the language is part of a broader
                technical workflow: source files, command-line runs, generated
                output, notes, and review all stay in one project.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <Button href={appPath("features/terminal")}>
                  Terminal workflows
                </Button>
                <Button href={appPath("features/linux")}>
                  Linux environment
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <MoreLanguagesProjectMock />
          </Col>
        </Row>
      </PublicSection>

      <MoreLanguagesFit />

      <PublicSection>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={13}>
            <Title level={3}>When another language belongs in CoCalc</Title>
            <BulletList
              items={[
                "A course or workshop needs one shared setup for scripts, compilers, and examples.",
                "A research project mixes notebooks with compiled code or shell tools.",
                "Generated output needs to stay near the source files and explanation.",
                "Collaborators need to inspect and rerun the same project workflow.",
              ]}
            />
            <Flex wrap gap={12}>
              <Button href={appPath("features/jupyter-notebook")}>
                Jupyter notebooks
              </Button>
              <Button href={appPath("features/teaching")}>Teaching</Button>
              <Button href={appPath("products")}>
                Compare operating models
              </Button>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <StartCard
              body="Open a project and use the language tools that fit your source files, scripts, notebooks, and collaborators."
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
