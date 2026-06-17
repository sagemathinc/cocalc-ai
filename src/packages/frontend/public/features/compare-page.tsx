/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";

import { Button, Flex, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import { builtinPolicyPath, type PublicConfig } from "../common";
import { LinkButton, featureAppPath } from "./page-components";

const { Paragraph, Text, Title } = Typography;

const PANEL_RADIUS = 8;
const PANEL_SHADOW = `0 14px 34px ${alpha(PUBLIC_COLORS.heading, 0.07)}`;

const COCALC_FITS = [
  "The project is more than one notebook, editor, terminal, or dashboard.",
  "People need to review work while it is still changing.",
  "AI agents should work from the same files, notebooks, terminals, and chat as the team.",
  "History, TimeTravel, snapshots, or backups need to stay close to the work.",
  "The operating model may change: hosted, local, single-VM, or customer-operated.",
] as const;

const FOCUSED_TOOL_FITS = [
  "A single notebook, dashboard, IDE, or reporting surface is enough.",
  "Collaboration mostly happens after the work is finished.",
  "Course administration is separate from the computational environment.",
  "Your organization wants to assemble and maintain separate open-source pieces itself.",
  "Governance, hosting, and operations are already settled around one tool.",
] as const;

const DECISION_ROWS = [
  {
    cocalc:
      "Files, notebooks, terminals, documents, output, discussion, and recovery should stay with the project.",
    other:
      "A focused tool can work when the surrounding artifacts already live somewhere stable.",
    question: "What needs to stay together?",
  },
  {
    cocalc:
      "Researchers, instructors, support staff, and AI agents need to inspect the same working state.",
    other:
      "A focused tool can work when collaboration mostly happens in one surface.",
    question: "Who needs to inspect the work?",
  },
  {
    cocalc:
      "Teammates review, explain, and hand off work while it is still active.",
    other:
      "A focused tool can work when review happens after the work is complete.",
    question: "When does collaboration happen?",
  },
  {
    cocalc:
      "Assignments, grading, lab support, or workshops need the same environment as the computation.",
    other:
      "Use an LMS or lightweight notebook host when course administration and computation can stay separate.",
    question: "Is teaching part of the workflow?",
  },
  {
    cocalc:
      "The group may need hosted use, local evaluation, a single VM, or a customer-operated deployment.",
    other:
      "A focused tool can work when the hosting and operations model is already fixed.",
    question: "Who operates it?",
  },
] as const;

const NEXT_ROUTES = [
  {
    body: "Hosted, local, single-VM, Launchpad, and Rocket.",
    href: "products",
    label: "Compare operating models",
    title: "Choosing how CoCalc runs",
  },
  {
    body: "Codex and AI assistance inside shared project context.",
    href: "features/ai",
    label: "AI workflows",
    title: "Reviewing AI-assisted work",
  },
  {
    body: "Assignments, grading, support, and shared environments.",
    href: "features/teaching",
    label: "Teaching workflows",
    title: "Planning a course or workshop",
  },
  {
    body: "Hosted plans, organizational buying, and quotes.",
    href: "pricing",
    label: "Review pricing options",
    title: "Understanding buying options",
  },
] as const;

function alpha(hexColor: string, opacity: number): string {
  const hex = hexColor.replace("#", "");
  if (hex.length !== 6) return hexColor;
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function Panel({
  accent = PUBLIC_COLORS.brand,
  children,
  className,
  muted = false,
}: {
  accent?: string;
  children: ReactNode;
  className?: string;
  muted?: boolean;
}) {
  return (
    <div
      className={className}
      style={{
        background: muted
          ? PUBLIC_COLORS.paperBackground
          : PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderTop: `4px solid ${accent}`,
        borderRadius: PANEL_RADIUS,
        boxShadow: PANEL_SHADOW,
        height: "100%",
        padding: 20,
      }}
    >
      {children}
    </div>
  );
}

function DecisionList({
  accent,
  items,
  title,
}: {
  accent: string;
  items: readonly string[];
  title: string;
}) {
  return (
    <Panel accent={accent} className="cocalc-compare-decision-panel">
      <Title level={3} style={{ margin: 0 }}>
        {title}
      </Title>
      <ul className="cocalc-compare-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </Panel>
  );
}

function DecisionRow({
  cocalc,
  other,
  question,
}: {
  cocalc: string;
  other: string;
  question: string;
}) {
  return (
    <div className="cocalc-compare-row">
      <Text strong className="cocalc-compare-row-question">
        {question}
      </Text>
      <Paragraph style={{ margin: 0 }}>{cocalc}</Paragraph>
      <Paragraph style={{ margin: 0 }}>{other}</Paragraph>
    </div>
  );
}

function RouteRow({
  body,
  href,
  label,
  title,
}: {
  body: string;
  href: string;
  label: string;
  title: string;
}) {
  return (
    <div className="cocalc-compare-route-row">
      <div>
        <Text strong>{title}</Text>
        <Paragraph style={{ margin: "4px 0 0" }}>{body}</Paragraph>
      </div>
      <LinkButton href={featureAppPath(href)}>{label}</LinkButton>
    </div>
  );
}

const COMPARE_PAGE_CSS = `
  .cocalc-compare-hero {
    background: linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.brandTint} 100%);
    border: 1px solid ${PUBLIC_COLORS.border};
    border-radius: ${PANEL_RADIUS}px;
    box-shadow: ${PANEL_SHADOW};
    display: grid;
    gap: 24px;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
    padding: 28px;
  }

  .cocalc-compare-quick-read {
    background: ${alpha(PUBLIC_COLORS.surface, 0.78)};
    border: 1px solid ${PUBLIC_COLORS.border};
    border-radius: ${PANEL_RADIUS}px;
    padding: 18px;
  }

  .cocalc-compare-split {
    display: grid;
    gap: 18px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .cocalc-compare-list {
    display: grid;
    gap: 10px;
    margin: 16px 0 0;
    padding-left: 20px;
  }

  .cocalc-compare-checklist {
    background: ${PUBLIC_COLORS.surface};
    border: 1px solid ${PUBLIC_COLORS.border};
    border-radius: ${PANEL_RADIUS}px;
    box-shadow: ${PANEL_SHADOW};
    overflow: hidden;
  }

  .cocalc-compare-row {
    display: grid;
    gap: 18px;
    grid-template-columns: 0.75fr 1fr 1fr;
    padding: 18px 20px;
  }

  .cocalc-compare-row + .cocalc-compare-row {
    border-top: 1px solid ${PUBLIC_COLORS.border};
  }

  .cocalc-compare-row-question {
    color: ${PUBLIC_COLORS.heading};
    font-size: 16px;
  }

  .cocalc-compare-route-panel {
    background: ${PUBLIC_COLORS.surface};
    border: 1px solid ${PUBLIC_COLORS.border};
    border-radius: ${PANEL_RADIUS}px;
    box-shadow: ${PANEL_SHADOW};
  }

  .cocalc-compare-route-row {
    align-items: center;
    display: grid;
    gap: 18px;
    grid-template-columns: minmax(0, 1fr) max-content;
    padding: 16px 20px;
  }

  .cocalc-compare-route-row + .cocalc-compare-route-row {
    border-top: 1px solid ${PUBLIC_COLORS.border};
  }

  @media (max-width: 900px) {
    .cocalc-compare-hero,
    .cocalc-compare-split,
    .cocalc-compare-row {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    .cocalc-compare-row {
      gap: 8px;
    }
  }

  @media (max-width: 560px) {
    .cocalc-compare-hero {
      padding: 20px;
    }

    .cocalc-compare-hero .ant-btn,
    .cocalc-compare-route-row .ant-btn {
      width: 100%;
    }

    .cocalc-compare-route-row {
      align-items: stretch;
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }
`;

const HERO_ACTION_STYLE = {
  alignItems: "flex-start",
} satisfies CSSProperties;

function compareSupportPath(): string {
  const params = new URLSearchParams({
    body: "I want to discuss whether CoCalc fits our workflow and which operating model to evaluate. Helpful context: workflow type, AI/notebook/terminal/teaching needs, expected users or projects, who would operate CoCalc, purchasing timeline, and any deployment or support constraints.",
    context: "feature-compare",
    subject: "CoCalc fit and operating model",
    title: "Talk with CoCalc about CoCalc fit",
    type: "purchase",
  });
  return `${featureAppPath("support/new")}?${params.toString()}`;
}

export default function CompareFeaturePage({
  config,
}: {
  config?: PublicConfig;
  helpEmail?: string;
}) {
  const trustHref = builtinPolicyPath(config, "trust");
  const supportHref = compareSupportPath();
  const nextRoutes = [
    ...NEXT_ROUTES,
    ...(trustHref
      ? [
          {
            body: "Published trust materials for evaluators who need security, privacy, or procurement context.",
            href: trustHref,
            label: "Review trust materials",
            title: "Trust and privacy review",
          },
        ]
      : []),
  ];

  return (
    <Flex vertical gap={30}>
      <style>{COMPARE_PAGE_CSS}</style>

      <section aria-label="Compare CoCalc fit">
        <div className="cocalc-compare-hero">
          <Flex vertical gap={16}>
            <Text
              strong
              style={{
                color: PUBLIC_COLORS.brand,
                letterSpacing: 0,
                textTransform: "uppercase",
              }}
            >
              Evaluation guide
            </Text>
            <Title level={2} style={{ margin: 0 }}>
              When is CoCalc the right fit?
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0, maxWidth: "65ch" }}>
              CoCalc is worth evaluating when the work is larger than one
              notebook, dashboard, or editor. It helps when people need to
              review active work, recover context, and choose where the
              workspace runs.
            </Paragraph>
            <Flex gap={12} style={HERO_ACTION_STYLE} wrap>
              <Button type="primary" href={featureAppPath("products")}>
                Compare operating models
              </Button>
              <Button href={featureAppPath("pricing")}>
                Pricing and licensing
              </Button>
              <Button href={supportHref}>Talk with CoCalc</Button>
            </Flex>
          </Flex>
          <div className="cocalc-compare-quick-read">
            <Text strong style={{ color: PUBLIC_COLORS.heading }}>
              Quick read
            </Text>
            <ul className="cocalc-compare-list">
              <li>Best fit: work that needs review, handoff, and recovery.</li>
              <li>Better elsewhere: one-off notebooks or isolated reports.</li>
              <li>Next question: who operates the workspace?</li>
            </ul>
          </div>
        </div>
      </section>

      <PublicSection
        ariaLabel="CoCalc compare fit"
        intro="Start with the shape of the work, not the names of competing tools."
        title="The practical split."
      >
        <div className="cocalc-compare-split">
          <DecisionList
            accent={PUBLIC_COLORS.brand}
            items={COCALC_FITS}
            title="CoCalc fits when..."
          />
          <DecisionList
            accent={COLORS.GRAY_M}
            items={FOCUSED_TOOL_FITS}
            title="A focused tool fits when..."
          />
        </div>
      </PublicSection>

      <PublicSection
        ariaLabel="CoCalc compare decision checklist"
        intro="These questions help decide whether CoCalc belongs in the evaluation before pricing, procurement, or deployment details take over."
        title="Decision checklist."
      >
        <div
          aria-label="CoCalc compare decision rows"
          className="cocalc-compare-checklist"
          role="group"
        >
          {DECISION_ROWS.map((row) => (
            <DecisionRow key={row.question} {...row} />
          ))}
        </div>
      </PublicSection>

      <PublicSection
        ariaLabel="CoCalc compare next routes"
        intro="Follow the route that matches the question your group is trying to answer next."
        title="Where to go next."
      >
        <div className="cocalc-compare-route-panel">
          {nextRoutes.map((route) => (
            <RouteRow key={route.href} {...route} />
          ))}
        </div>
      </PublicSection>
    </Flex>
  );
}
