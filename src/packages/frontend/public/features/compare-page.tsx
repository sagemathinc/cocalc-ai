/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";

import { Button, Flex, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { builtinPolicyPath, type PublicConfig } from "../common";
import { LinkButton, featureAppPath } from "./page-components";

const { Paragraph, Text, Title } = Typography;

const PANEL_SHADOW = `0 14px 34px ${alpha(PUBLIC_COLORS.heading, 0.07)}`;

const DECISION_ROWS = [
  {
    cocalc:
      "Files, notebooks, terminals, documents, output, discussion, and TimeTravel recovery should stay with the project — the way an R&D or engineering team keeps models, data, and results reviewable together.",
    other:
      "Fine to keep separate when those artifacts already live somewhere stable.",
    question: "What needs to stay together?",
  },
  {
    cocalc:
      "Data scientists, engineers, and researchers — plus the AI agents working alongside them — need to work in one live terminal and shared kernel, with each other's cursors visible as the work happens.",
    other: "A single surface is enough when collaboration stays in one place.",
    question: "Who needs to inspect the work?",
  },
  {
    cocalc:
      "Teammates review, explain, and hand off work while it is still active.",
    other: "A lighter tool works when review only happens at the end.",
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
      "A fixed setup is fine when hosting and operations are already decided.",
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
    <tr className="cocalc-compare-row">
      <th className="cocalc-compare-row-question" scope="row">
        {question}
      </th>
      <td data-label="Choose CoCalc when">
        <Paragraph style={{ margin: 0 }}>{cocalc}</Paragraph>
      </td>
      <td data-label="Choose a lighter tool when">
        <Paragraph style={{ margin: 0 }}>{other}</Paragraph>
      </td>
    </tr>
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
    border-radius: ${PUBLIC_RADIUS.panel}px;
    box-shadow: ${PANEL_SHADOW};
    display: grid;
    gap: 24px;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
    padding: 28px;
  }

  .cocalc-compare-quick-read {
    background: ${alpha(PUBLIC_COLORS.surface, 0.78)};
    border: 1px solid ${PUBLIC_COLORS.border};
    border-radius: ${PUBLIC_RADIUS.panel}px;
    padding: 18px;
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
    border-radius: ${PUBLIC_RADIUS.panel}px;
    box-shadow: ${PANEL_SHADOW};
    overflow: hidden;
  }

  .cocalc-compare-table {
    border-collapse: collapse;
    width: 100%;
  }

  .cocalc-compare-table-caption {
    border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .cocalc-compare-table th,
  .cocalc-compare-table td {
    padding: 18px 20px;
    text-align: left;
    vertical-align: top;
  }

  .cocalc-compare-table thead th {
    background: ${alpha(PUBLIC_COLORS.brandTint, 0.5)};
    border-bottom: 1px solid ${PUBLIC_COLORS.border};
    color: ${PUBLIC_COLORS.heading};
    font-size: ${PUBLIC_TYPE.small};
  }

  .cocalc-compare-row + .cocalc-compare-row th,
  .cocalc-compare-row + .cocalc-compare-row td {
    border-top: 1px solid ${PUBLIC_COLORS.border};
  }

  .cocalc-compare-row-question {
    color: ${PUBLIC_COLORS.heading};
    font-size: 16px;
    width: 26%;
  }

  .cocalc-compare-table td {
    width: 37%;
  }

  .cocalc-compare-route-panel {
    background: ${PUBLIC_COLORS.surface};
    border: 1px solid ${PUBLIC_COLORS.border};
    border-radius: ${PUBLIC_RADIUS.panel}px;
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
    .cocalc-compare-hero {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    .cocalc-compare-table,
    .cocalc-compare-table thead,
    .cocalc-compare-table tbody,
    .cocalc-compare-table tr,
    .cocalc-compare-table th,
    .cocalc-compare-table td {
      display: block;
      width: 100%;
    }

    .cocalc-compare-table thead {
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      height: 1px;
      overflow: hidden;
      position: absolute;
      white-space: nowrap;
      width: 1px;
    }

    .cocalc-compare-table tbody tr {
      padding: 18px 20px;
    }

    .cocalc-compare-row + .cocalc-compare-row {
      border-top: 1px solid ${PUBLIC_COLORS.border};
    }

    .cocalc-compare-table tbody th,
    .cocalc-compare-table tbody td {
      padding: 0;
    }

    .cocalc-compare-row + .cocalc-compare-row th,
    .cocalc-compare-row + .cocalc-compare-row td {
      border-top: 0;
    }

    .cocalc-compare-table tbody td {
      margin-top: 10px;
    }

    .cocalc-compare-table tbody td::before {
      color: ${PUBLIC_COLORS.heading};
      content: attr(data-label);
      display: block;
      font-size: ${PUBLIC_TYPE.small};
      font-weight: 600;
      margin-bottom: 3px;
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
                color: PUBLIC_COLORS.heading,
                letterSpacing: 0,
                textTransform: "uppercase",
              }}
            >
              Evaluation guide
            </Text>
            <Title level={2} style={{ margin: 0 }}>
              When is CoCalc the right fit?
            </Title>
            <Paragraph
              style={{
                fontSize: PUBLIC_TYPE.lead,
                margin: 0,
                maxWidth: "65ch",
              }}
            >
              Evaluate CoCalc when an industry R&D, data-science, or engineering
              team needs notebooks, code, terminals, documents, outputs,
              TimeTravel history, collaborators, and AI-assisted review to stay
              together. Choose a lighter tool when one notebook, dashboard,
              editor, or report is the whole job.
            </Paragraph>
            <Flex gap={12} style={HERO_ACTION_STYLE} wrap>
              <Button type="primary" href={featureAppPath("products")}>
                Compare operating models
              </Button>
              <Button href={supportHref}>Talk with CoCalc</Button>
            </Flex>
          </Flex>
          <div className="cocalc-compare-quick-read">
            <Text strong style={{ color: PUBLIC_COLORS.heading }}>
              Quick read
            </Text>
            <ul className="cocalc-compare-list">
              <li>
                Best fit: durable, reproducible, multi-artifact projects that
                stay reviewable as collaborators come and go — review, handoff,
                and TimeTravel recovery in one place.
              </li>
              <li>
                Better elsewhere: one-off notebooks, dashboards, editors, or
                isolated reports.
              </li>
              <li>Next question: who operates the workspace?</li>
            </ul>
          </div>
        </div>
      </section>

      <PublicSection
        ariaLabel="CoCalc compare decision checklist"
        intro="Start with the shape of the work, not the names of competing tools. These questions decide whether CoCalc belongs in the evaluation before pricing, procurement, or deployment details take over."
        title="Decision checklist"
      >
        <table
          aria-describedby="cocalc-compare-table-caption"
          aria-label="CoCalc compare decision rows"
          className="cocalc-compare-checklist cocalc-compare-table"
        >
          <caption
            className="cocalc-compare-table-caption"
            id="cocalc-compare-table-caption"
          >
            Each row compares the decision question, when to choose CoCalc, and
            when a lighter tool is enough. On narrow screens, each row is shown
            as labelled stacked fields with the same column meaning.
          </caption>
          <thead>
            <tr>
              <th scope="col">Decision question</th>
              <th scope="col">Choose CoCalc when</th>
              <th scope="col">Choose a lighter tool when</th>
            </tr>
          </thead>
          <tbody>
            {DECISION_ROWS.map((row) => (
              <DecisionRow key={row.question} {...row} />
            ))}
          </tbody>
        </table>
      </PublicSection>

      <PublicSection
        ariaLabel="CoCalc compare next routes"
        intro="Follow the route that matches the question your group is trying to answer next."
        title="Where to go next"
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
