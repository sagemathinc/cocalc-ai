/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import type { IconName } from "@cocalc/frontend/components/icon";
import {
  appPath,
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
  return (
    <a
      className={`cocalc-guide-link ${
        featured ? "cocalc-guide-link-featured" : "cocalc-guide-link-compact"
      }`}
      href={href}
      rel="noreferrer"
      target="_blank"
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

export default function PublicGuidesApp({ config }: { config?: PublicConfig }) {
  const siteName = getPublicMarketingSiteName(config);
  const title = `Guides - ${siteName}`;

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <>
      <style>{GUIDES_PAGE_CSS}</style>
      <PublicSectionShell active="guides" config={config}>
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
      </PublicSectionShell>
    </>
  );
}
