/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { useEffect } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import {
  appPath,
  CodeBlock,
  getPublicMarketingSiteName,
  PublicNextStep,
  type PublicConfig,
  PublicSectionShell,
} from "@cocalc/frontend/public/common";
import { IconBadge } from "@cocalc/frontend/public/features/feature-visuals";
import {
  PublicHero,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_COLORS,
  PUBLIC_ELEVATION,
  PUBLIC_RADIUS,
} from "@cocalc/frontend/public/theme";
import { FIELD_GUIDES_URL } from "@cocalc/util/theme";
import type { PublicGuidesRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = FIELD_GUIDES_URL.replace(/\/$/, "");

const GUIDES_PAGE_CSS = `
.cocalc-guide-link {
  color: inherit;
  display: grid;
  gap: 12px;
  grid-template-columns: auto minmax(0, 1fr);
  text-decoration: none;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    box-shadow 120ms ease;
}

.cocalc-guide-link-featured {
  background: ${PUBLIC_COLORS.surfaceMuted};
  border: 1px solid ${PUBLIC_COLORS.brandSubtle};
  border-radius: 8px;
  height: 100%;
  padding: 18px;
}

.cocalc-guide-link-compact {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  min-height: 68px;
  padding: 8px 10px;
}

.cocalc-guide-link:hover {
  background: ${PUBLIC_COLORS.surface};
  border-color: ${PUBLIC_COLORS.border};
  box-shadow: ${PUBLIC_ELEVATION.hover};
  color: inherit;
}

@media (max-width: 767px) {
  .cocalc-guide-link-featured {
    padding: 14px;
  }

  .cocalc-guide-link-compact {
    min-height: auto;
    padding: 10px 0;
  }
}
`;

function guidePath(slug: string): string {
  return `${GUIDE_BASE}/${slug}/`;
}

const FEATURED_GUIDES = [
  {
    body: "Use Codex agent chat beside project files, notebooks, terminals, screenshots, patches, and review notes.",
    href: guidePath("codex-agent-chat"),
    icon: "robot",
    title: "Codex agent chat",
  },
  {
    body: "Keep durable execution, output, collaboration, TimeTravel, and review close to the notebook.",
    href: guidePath("jupyter-notebooks"),
    icon: "jupyter",
    title: "Jupyter notebooks",
  },
  {
    body: "Use .term files, shared terminal streams, side chat, Linux tools, and agent-aware command-line work.",
    href: guidePath("terminal"),
    icon: "terminal",
    title: "Terminal workflows",
  },
] satisfies GuideCardSpec[];

const GUIDE_GROUPS = [
  {
    guides: [
      {
        body: "Polish a paper with LaTeX, notebooks, figures, collaborators, Codex, and project history.",
        href: guidePath("paper-polishing"),
        icon: "file-pdf",
        title: "From notebook to paper",
      },
      {
        body: "Choose and use CoCalc for LaTeX projects that depend on figures, code, review, and collaborators.",
        href: guidePath("cocalc-for-latex"),
        icon: "tex",
        title: "LaTeX projects",
      },
      {
        body: "Move from notebook exploration to scripts, packages, debugging, and figures in papers.",
        href: guidePath("python-workflow"),
        icon: "python",
        title: "Python in CoCalc",
      },
      {
        body: "Manage messy computation with logs, retries, partial outputs, summaries, and recovery.",
        href: guidePath("research-computation"),
        icon: "line-chart",
        title: "Research runs",
      },
    ],
    intro:
      "Papers, notebooks, code-backed figures, and long-running research work.",
    title: "Research and writing",
  },
  {
    guides: [
      {
        body: "Create a CoCalc AI project with the RStudio and Jupyter image, then launch RStudio Server from the project.",
        href: appPath("guides/rstudio-project"),
        icon: "r",
        title: "RStudio project setup",
      },
      {
        body: "Install packages and make a project environment work from the terminal.",
        href: guidePath("software-install"),
        icon: "download",
        title: "Installing software",
      },
      {
        body: "Use GitHub issues, pull requests, releases, and reviews from a CoCalc project.",
        href: guidePath("github-workflow"),
        icon: "github",
        title: "GitHub workflow",
      },
      {
        body: "Inspect agent commits, ask line-level questions, and keep code review accountable.",
        href: guidePath("git-review-workflow"),
        icon: "git",
        title: "Reviewing agent commits",
      },
      {
        body: "Prepare reusable software environments for courses, teams, sites, and demonstrations.",
        href: guidePath("rootfs-management"),
        icon: "servers",
        title: "Reusable runtime images",
      },
    ],
    intro:
      "Software setup, Git workflows, agent review, and repeatable project environments.",
    title: "Runtime and code",
  },
  {
    guides: [
      {
        body: "Install a self-contained one-user CoCalc for a laptop, workstation, or SSH machine.",
        href: guidePath("cocalc-plus"),
        icon: "laptop",
        title: "CoCalc Plus",
      },
      {
        body: "Understand the small-team self-hosting path and when a larger private deployment is a better fit.",
        href: guidePath("self-hosting"),
        icon: "server",
        title: "Self-hosting CoCalc",
      },
      {
        body: "Use a durable CoCalc project where people and agents work together over time.",
        href: guidePath("agent-sandbox-cloud"),
        icon: "robot",
        title: "Durable collaborative projects",
      },
      {
        body: "Learn how project workspaces, compute hosts, and storage fit together.",
        href: guidePath("how-cocalc-works"),
        icon: "sitemap",
        title: "How CoCalc works",
      },
      {
        body: "Use live student projects, assignments, grading workflows, TimeTravel, and shared environments.",
        href: guidePath("teaching"),
        icon: "graduation-cap",
        title: "Teaching with CoCalc",
      },
    ],
    intro:
      "Self-hosting, local evaluation, durable collaborative projects, and architecture.",
    title: "Operating paths",
  },
] satisfies {
  guides: GuideCardSpec[];
  intro: string;
  title: string;
}[];

interface GuideCardSpec {
  body: string;
  href: string;
  icon: IconName;
  title: string;
}

function GuideLink({
  body,
  featured,
  href,
  icon,
  title,
}: GuideCardSpec & { featured?: boolean }) {
  const external = /^https?:\/\//.test(href);

  return (
    <a
      className={`cocalc-guide-link ${
        featured ? "cocalc-guide-link-featured" : "cocalc-guide-link-compact"
      }`}
      href={href}
      rel={external ? "noreferrer" : undefined}
      target={external ? "_blank" : undefined}
    >
      <IconBadge icon={icon} size={featured ? "md" : "sm"} />
      <span>
        <Text strong style={{ display: "block" }}>
          {title}
        </Text>
        <Text type="secondary" style={{ display: "block", marginTop: 4 }}>
          {body}
        </Text>
      </span>
    </a>
  );
}

function GuideDirectory() {
  return (
    <PublicSection>
      <div
        style={{
          background: PUBLIC_COLORS.surface,
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: PUBLIC_RADIUS.panel,
          padding: 24,
        }}
      >
        <Flex vertical gap={24}>
          <Row gutter={[24, 24]}>
            <Col xs={24} lg={7}>
              <Flex vertical gap={10}>
                <Title level={2} style={{ margin: 0 }}>
                  Find the guide by task
                </Title>
                <Paragraph
                  style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}
                >
                  Pick the task that matches the work in front of you. The full
                  guide library has the longer illustrated walkthroughs.
                </Paragraph>
                <Flex gap={10} wrap>
                  <Button
                    href={FIELD_GUIDES_URL}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open all guides
                  </Button>
                  <Button href={appPath("docs")}>Browse docs</Button>
                </Flex>
              </Flex>
            </Col>
            <Col xs={24} lg={17}>
              <Row gutter={[12, 12]}>
                {FEATURED_GUIDES.map((guide) => (
                  <Col key={guide.href} xs={24} md={8}>
                    <GuideLink {...guide} featured />
                  </Col>
                ))}
              </Row>
            </Col>
          </Row>

          <div
            style={{
              borderTop: `1px solid ${PUBLIC_COLORS.border}`,
              paddingTop: 24,
            }}
          >
            <Flex vertical gap={24}>
              {GUIDE_GROUPS.map((group) => (
                <section key={group.title}>
                  <Row gutter={[18, 14]}>
                    <Col xs={24} lg={7}>
                      <Title level={3} style={{ margin: 0 }}>
                        {group.title}
                      </Title>
                      <Paragraph
                        style={{
                          color: PUBLIC_COLORS.mutedText,
                          margin: "8px 0 0",
                        }}
                      >
                        {group.intro}
                      </Paragraph>
                    </Col>
                    <Col xs={24} lg={17}>
                      <Row gutter={[12, 12]}>
                        {group.guides.map((guide) => (
                          <Col key={guide.href} xs={24} md={12}>
                            <GuideLink {...guide} />
                          </Col>
                        ))}
                      </Row>
                    </Col>
                  </Row>
                </section>
              ))}
            </Flex>
          </div>
        </Flex>
      </div>
    </PublicSection>
  );
}

const RSTUDIO_SETUP_STEPS = [
  {
    body: "Open CoCalc AI, sign in, and start from the Projects page. This is where new projects are created and existing projects are reopened.",
    title: "Open the Projects page",
  },
  {
    body: "Use the Create Project button in the upper-left area of the projects list. The dialog shows project limits, running projects, and available storage before the project is created.",
    title: "Create a new project",
  },
  {
    body: 'Give the project a clear name, such as "R project" or the name of the analysis. A descriptive name makes the project easier to find later.',
    title: "Name the project",
  },
  {
    body: "Choose the RStudio and Jupyter software image. That image gives the project an R-centered workspace while keeping notebooks and standard CoCalc project tools available.",
    title: "Select the RStudio and Jupyter image",
  },
  {
    body: "Open the project and wait for the project runtime to start. A new project begins with an empty file system, ready for scripts, notebooks, data files, and reports.",
    title: "Open and start the project",
  },
  {
    body: "Use the R image or server control in the project interface to launch RStudio Server. When the server is ready, RStudio opens inside the CoCalc project context.",
    title: "Launch RStudio Server",
  },
] satisfies { body: string; title: string }[];

const RSTUDIO_CONTEXT_CARDS = [
  {
    body: "The selected software image controls the starting runtime. It can include RStudio, Jupyter, terminals, LaTeX, and libraries for the kind of work the project needs.",
    icon: "r",
    title: "Image first",
  },
  {
    body: "Project files stay together: R scripts, notebooks, data, rendered output, and notes all live in one collaborative workspace.",
    icon: "files",
    title: "Shared files",
  },
  {
    body: "When extra packages or OS libraries are needed, install them from R or from a terminal inside the project environment.",
    icon: "terminal",
    title: "Custom setup",
  },
] satisfies { body: string; icon: IconName; title: string }[];

function GuidePanel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.sm,
        height: "100%",
        padding: 18,
      }}
    >
      {children}
    </div>
  );
}

function RStudioContextCard({
  body,
  icon,
  title,
}: (typeof RSTUDIO_CONTEXT_CARDS)[number]) {
  return (
    <GuidePanel>
      <Flex vertical gap={12}>
        <IconBadge icon={icon} />
        <Text strong>{title}</Text>
        <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
          {body}
        </Paragraph>
      </Flex>
    </GuidePanel>
  );
}

function RStudioSetupSteps() {
  return (
    <PublicSection>
      <Flex vertical gap={18}>
        <Title level={2} style={{ margin: 0 }}>
          Create the project
        </Title>
        <Row gutter={[16, 16]}>
          {RSTUDIO_SETUP_STEPS.map((step, index) => (
            <Col key={step.title} xs={24} md={12}>
              <GuidePanel>
                <Flex gap={14} align="flex-start">
                  <div
                    aria-hidden
                    style={{
                      alignItems: "center",
                      background: PUBLIC_COLORS.brandTint,
                      border: `1px solid ${PUBLIC_COLORS.brandSubtle}`,
                      borderRadius: 8,
                      color: PUBLIC_COLORS.brand,
                      display: "flex",
                      flex: "0 0 34px",
                      fontWeight: 700,
                      height: 34,
                      justifyContent: "center",
                      width: 34,
                    }}
                  >
                    {index + 1}
                  </div>
                  <Flex vertical gap={6}>
                    <Text strong>{step.title}</Text>
                    <Paragraph
                      style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}
                    >
                      {step.body}
                    </Paragraph>
                  </Flex>
                </Flex>
              </GuidePanel>
            </Col>
          ))}
        </Row>
      </Flex>
    </PublicSection>
  );
}

function RStudioEnvironmentNotes() {
  return (
    <PublicSection>
      <Row gutter={[24, 24]} align="top">
        <Col xs={24} lg={11}>
          <Flex vertical gap={12}>
            <Title level={2} style={{ margin: 0 }}>
              Customize the environment when the project needs more
            </Title>
            <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
              CoCalc AI projects run from selected software images. The public
              repository documents how project root filesystem images are
              resolved, started, and paired with writable overlays so runtime
              changes can persist with the project.
            </Paragraph>
            <Flex gap={10} wrap>
              <Button href={appPath("rootfs")}>Browse runtime images</Button>
              <Button
                href="https://github.com/sagemathinc/cocalc-ai/blob/main/docs/project-rootfs.md"
                rel="noreferrer"
                target="_blank"
              >
                Read rootfs notes
              </Button>
            </Flex>
          </Flex>
        </Col>
        <Col xs={24} lg={13}>
          <GuidePanel>
            <Flex vertical gap={16}>
              <div>
                <Text strong>
                  Install R packages from RStudio or an R shell.
                </Text>
                <CodeBlock
                  ariaLabel="R command for installing an R package"
                  code={'install.packages("tidyverse")'}
                  language="r"
                />
              </div>
              <div>
                <Text strong>
                  Install system libraries from a project terminal when needed.
                </Text>
                <CodeBlock
                  ariaLabel="Shell commands for installing a system package"
                  code={`sudo apt-get update
sudo apt-get install -y libcurl4-openssl-dev`}
                  language="bash"
                />
              </div>
            </Flex>
          </GuidePanel>
        </Col>
      </Row>
    </PublicSection>
  );
}

function RStudioProjectGuidePage({
  authenticated,
}: {
  authenticated?: boolean;
}) {
  return (
    <>
      <PublicHero
        actions={
          <Flex gap={12} wrap>
            <Button
              href={appPath(authenticated ? "projects" : "auth/sign-up")}
              type="primary"
            >
              {authenticated ? "Open projects" : "Create account"}
            </Button>
            <Button href={appPath("guides")}>Back to guides</Button>
          </Flex>
        }
        subtitle={
          <>
            Start a fresh CoCalc AI project, choose the RStudio and Jupyter
            image, and launch RStudio Server inside the project.
          </>
        }
        title="Create a CoCalc AI project with RStudio"
      />

      <PublicSection>
        <Row gutter={[16, 16]}>
          {RSTUDIO_CONTEXT_CARDS.map((card) => (
            <Col key={card.title} xs={24} md={8}>
              <RStudioContextCard {...card} />
            </Col>
          ))}
        </Row>
      </PublicSection>

      <RStudioSetupSteps />
      <RStudioEnvironmentNotes />

      <PublicNextStep
        authenticated={authenticated}
        heading="Ready to keep working in the project?"
      />
    </>
  );
}

export default function PublicGuidesApp({
  config,
  initialRoute,
}: {
  config?: PublicConfig;
  initialRoute: PublicGuidesRoute;
}) {
  const siteName = getPublicMarketingSiteName(config);
  const title =
    initialRoute.view === "rstudio-project"
      ? `Create an RStudio project - ${siteName}`
      : `Guides - ${siteName}`;

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <>
      <style>{GUIDES_PAGE_CSS}</style>
      <PublicSectionShell active="guides" config={config}>
        {initialRoute.view === "rstudio-project" ? (
          <RStudioProjectGuidePage authenticated={!!config?.is_authenticated} />
        ) : (
          <>
            <PublicHero
              actions={
                <Flex gap={12} wrap>
                  <Button
                    href={FIELD_GUIDES_URL}
                    rel="noreferrer"
                    target="_blank"
                    type="primary"
                  >
                    Open all guides
                  </Button>
                  <Button href={appPath("docs")}>Browse docs</Button>
                </Flex>
              }
              subtitle={
                <>
                  Plan setup, notebooks, terminals, code review, and deployment
                  paths around durable CoCalc projects.
                </>
              }
              title="Guides"
            />
            <GuideDirectory />
            <PublicNextStep authenticated={!!config?.is_authenticated} />
          </>
        )}
      </PublicSectionShell>
    </>
  );
}
