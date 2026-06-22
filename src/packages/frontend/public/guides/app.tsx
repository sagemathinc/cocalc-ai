/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Flex, Tag, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import {
  appPath,
  getSiteName,
  type PublicConfig,
  PublicSectionShell,
} from "@cocalc/frontend/public/common";
import {
  PublicCard,
  PublicGrid,
  PublicHero,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { FIELD_GUIDES_URL } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;

const GUIDE_BASE = FIELD_GUIDES_URL.replace(/\/$/, "");

function guidePath(slug: string): string {
  return `${GUIDE_BASE}/${slug}/`;
}

const GUIDE_CARDS = [
  {
    body: "Notebook-centered workflows, long-running computation, kernels, collaboration, and practical project organization.",
    href: guidePath("cocalc-for-jupyter"),
    icon: "jupyter",
    tag: "Compute",
    title: "Jupyter workflows",
  },
  {
    body: "Use CoCalc terminals, install software, manage files from the shell, and connect command-line work to the browser UI.",
    href: guidePath("terminal"),
    icon: "terminal",
    tag: "Linux",
    title: "Terminal workflows",
  },
  {
    body: "Run courses with shared projects, assignments, grading workflows, and durable technical collaboration.",
    href: guidePath("teaching"),
    icon: "graduation-cap",
    tag: "Courses",
    title: "Teaching with CoCalc",
  },
  {
    body: "Write, compile, and collaborate on technical documents with LaTeX inside the same project as code and data.",
    href: guidePath("cocalc-for-latex"),
    icon: "tex",
    tag: "Writing",
    title: "LaTeX projects",
  },
  {
    body: "Use Codex agent chat in a real project workspace with files, terminals, notebooks, and persistent context.",
    href: guidePath("codex-agent-chat"),
    icon: "robot",
    tag: "AI",
    title: "Codex agent chat",
  },
  {
    body: "Understand project images and reusable project environments when you need a controlled software stack.",
    href: guidePath("rootfs-management"),
    icon: "servers",
    tag: "Environment",
    title: "Project images",
  },
] satisfies {
  body: string;
  href: string;
  icon: IconName;
  tag: string;
  title: string;
}[];

function GuideCard({
  body,
  href,
  icon,
  tag,
  title,
}: (typeof GUIDE_CARDS)[number]) {
  return (
    <PublicCard href={href} rel="noreferrer" target="_blank" title={title}>
      <Flex vertical gap="middle">
        <Flex align="center" justify="space-between">
          <div
            style={{
              alignItems: "center",
              background: "#eef5ff",
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: 14,
              color: PUBLIC_COLORS.brand,
              display: "flex",
              fontSize: 24,
              height: 50,
              justifyContent: "center",
              width: 50,
            }}
          >
            <Icon name={icon} />
          </div>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            {tag}
          </Tag>
        </Flex>
        <Paragraph style={{ margin: 0 }}>{body}</Paragraph>
        <Text style={{ color: PUBLIC_COLORS.link }}>
          Open guide <Icon name="external-link" />
        </Text>
      </Flex>
    </PublicCard>
  );
}

export default function PublicGuidesApp({ config }: { config?: PublicConfig }) {
  const siteName = getSiteName(config);
  const title = `Guides - ${siteName}`;

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
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
            Workflow-oriented guides are maintained as a companion site. The
            versioned docs stay here, with URLs and behavior tied to this CoCalc
            instance.
          </>
        }
        title="Guides"
      />
      <PublicGrid columns={3}>
        {GUIDE_CARDS.map((card) => (
          <GuideCard key={card.href} {...card} />
        ))}
      </PublicGrid>
      <PublicSection
        intro="Use guides when you want a narrative path through a workflow. Use docs when you need versioned product help, exact UI actions, or Codex-readable documentation for this site."
        title="Guides and docs work together"
      >
        <Flex gap={12} wrap>
          <Button href={appPath("docs")} type="primary">
            Open docs
          </Button>
          <Button href={appPath("support")}>Get support</Button>
        </Flex>
      </PublicSection>
    </PublicSectionShell>
  );
}
