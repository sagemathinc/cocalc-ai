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
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import { builtinPolicyPath, type PublicConfig } from "../common";
import {
  LinkButton,
  featureAppPath,
  featureSupportPath,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

const PANEL_SHADOW = `0 14px 34px ${alpha(PUBLIC_COLORS.heading, 0.07)}`;
const COMPARE_PAGE = getPublicFeaturePage("compare")!;
const SANDBOX_OVERVIEW = COMPARE_PAGE.sections?.find(
  ({ title }) => title === "Shared project or agent sandbox?",
)!;
const SANDBOX_CHOICES = COMPARE_PAGE.sections?.filter(({ title }) =>
  title.startsWith("Choose "),
)!;
const SANDBOX_BOUNDARY = COMPARE_PAGE.sections?.find(
  ({ title }) => title === "Check the operating boundary",
)!;

const DECISION_ROWS = [
  {
    cocalc:
      "People and agents need files, notebooks, terminals, output, discussion, and review history in one shared project.",
    other:
      "The source of truth and review already live outside the execution environment.",
    question: "What needs to stay together?",
  },
  {
    cocalc:
      "Collaborators and AI agents need to inspect the same files, notebooks, terminals, and running services.",
    other:
      "People collaborate and review somewhere outside the execution environment.",
    question: "Who needs to inspect the work?",
  },
  {
    cocalc: "Review and handoff happen while the work is still active.",
    other: "Each run produces a result for later review.",
    question: "When does collaboration happen?",
  },
  {
    cocalc:
      "Courses, labs, or workshops need the same environment as the computation.",
    other:
      "The execution environment does not need course management or live help.",
    question: "Is teaching part of the workflow?",
  },
  {
    cocalc:
      "Teams need hosted, local, single-VM, and private deployment choices.",
    other:
      "Your product already owns the runtime lifecycle and infrastructure.",
    question: "Who operates it?",
  },
] as const;

const NEXT_ROUTES = [
  {
    body: "Hosted, local, single-VM, and private deployment.",
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
      <td data-label="Choose an agent sandbox when">
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

  .cocalc-compare-sandbox-grid {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .cocalc-compare-sandbox-card {
    background: ${PUBLIC_COLORS.surface};
    border: 1px solid ${PUBLIC_COLORS.border};
    border-radius: ${PUBLIC_RADIUS.panel}px;
    box-shadow: ${PANEL_SHADOW};
    padding: 20px;
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
    font-size: ${PUBLIC_TYPE.caption}px;
  }

  .cocalc-compare-row + .cocalc-compare-row th,
  .cocalc-compare-row + .cocalc-compare-row td {
    border-top: 1px solid ${PUBLIC_COLORS.border};
  }

  .cocalc-compare-row-question {
    color: ${PUBLIC_COLORS.heading};
    font-size: ${PUBLIC_TYPE.body}px;
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
      font-size: ${PUBLIC_TYPE.caption}px;
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

    .cocalc-compare-sandbox-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
`;

const HERO_ACTION_STYLE = {
  alignItems: "flex-start",
} satisfies CSSProperties;

export default function CompareFeaturePage({
  config,
}: {
  config?: PublicConfig;
  helpEmail?: string;
}) {
  const supportHref = featureSupportPath({
    body: "I want to talk with CoCalc about fit and operating model. Helpful context: workflow, collaborators, operating model, timeline, and security or privacy questions.",
    context: "compare",
    subject: "CoCalc fit evaluation",
    title: "Talk with CoCalc about fit",
  });
  const hasBuiltinTrustPage = !!builtinPolicyPath(config, "trust");
  const boundaryLinks = SANDBOX_BOUNDARY.links?.filter(
    ({ href }) =>
      config?.cocalc_product !== "plus" || !href.startsWith("/docs/"),
  );
  const nextRoutes = hasBuiltinTrustPage
    ? [
        ...NEXT_ROUTES,
        {
          body: "Security and privacy context for evaluating CoCalc.",
          href: "policies/trust",
          label: "Review trust and compliance",
          title: "Trust and compliance",
        },
      ]
    : NEXT_ROUTES;

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
              Persistent workspace or isolated execution?
            </Title>
            <Paragraph
              style={{
                fontSize: PUBLIC_TYPE.lead,
                margin: 0,
                maxWidth: "65ch",
              }}
            >
              Decide what must persist, who needs to inspect the work, and
              whether the environment is a shared workspace or an API-managed
              execution runtime.
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
                Choose CoCalc when people and agents need to keep using the same
                files, notebooks, terminals, services, and review history.
              </li>
              <li>
                Choose an agent sandbox when your product mainly needs
                API-created execution environments for individual runs.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section
        aria-label="CoCalc and AI agent sandbox comparison"
        id="agent-sandboxes"
      >
        <Flex vertical gap={18}>
          <Title level={3} style={{ margin: 0 }}>
            {SANDBOX_OVERVIEW.title}
          </Title>
          {SANDBOX_OVERVIEW.paragraphs?.map((paragraph) => (
            <Paragraph key={paragraph} style={{ margin: 0, maxWidth: "72ch" }}>
              {paragraph}
            </Paragraph>
          ))}
          <div className="cocalc-compare-sandbox-grid">
            {SANDBOX_CHOICES.map((choice) => (
              <article
                className="cocalc-compare-sandbox-card"
                key={choice.title}
              >
                <Title level={4} style={{ margin: 0 }}>
                  {choice.title}
                </Title>
                <ul className="cocalc-compare-list">
                  {choice.bullets?.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <div>
            <Title level={4} style={{ margin: "0 0 8px" }}>
              {SANDBOX_BOUNDARY.title}
            </Title>
            {SANDBOX_BOUNDARY.paragraphs?.map((paragraph) => (
              <Paragraph
                key={paragraph}
                style={{ margin: 0, maxWidth: "72ch" }}
              >
                {paragraph}
              </Paragraph>
            ))}
          </div>
          <Flex gap={12} wrap>
            {boundaryLinks?.map((link) => (
              <LinkButton
                href={featureAppPath(link.href.replace(/^\/+/, ""))}
                key={link.href}
              >
                {link.label}
              </LinkButton>
            ))}
          </Flex>
        </Flex>
      </section>

      <PublicSection ariaLabel="CoCalc compare decision checklist">
        <Title level={3} style={{ margin: 0 }}>
          Decision checklist
        </Title>
        <Paragraph style={{ margin: 0, maxWidth: "70ch" }}>
          Use the questions below to separate collaboration needs from buying
          mechanics.
        </Paragraph>
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
            when an agent sandbox is enough. On narrow screens, each row is
            shown as labelled stacked fields with the same column meaning.
          </caption>
          <thead>
            <tr>
              <th scope="col">Decision question</th>
              <th scope="col">Choose CoCalc when</th>
              <th scope="col">Choose an agent sandbox when</th>
            </tr>
          </thead>
          <tbody>
            {DECISION_ROWS.map((row) => (
              <DecisionRow key={row.question} {...row} />
            ))}
          </tbody>
        </table>
      </PublicSection>

      <PublicSection ariaLabel="CoCalc compare next routes">
        <Title level={3} style={{ margin: 0 }}>
          Where to go next
        </Title>
        <Paragraph style={{ margin: 0, maxWidth: "70ch" }}>
          Pick the next evaluation question.
        </Paragraph>
        <div className="cocalc-compare-route-panel">
          {nextRoutes.map((route) => (
            <RouteRow key={route.href} {...route} />
          ))}
        </div>
      </PublicSection>
    </Flex>
  );
}
