/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Col, Flex, Row, Table, Typography } from "antd";

import { PublicSectionCard } from "@cocalc/frontend/public/layout/shell";
import { BulletList, LinkButton, featureAppPath } from "./page-components";

const { Paragraph, Text, Title } = Typography;

const COMPARISON_GROUPS = [
  {
    bestAt:
      "Quick notebook startup, lightweight sharing, and easy access to hosted compute.",
    cocalc:
      "Choose CoCalc when the notebook is only one part of the workflow and you also need terminals, files, LaTeX, course management, shared history, or self-hosted options.",
    key: "colab",
    title: "Google Colab and quick notebook hosts",
  },
  {
    bestAt:
      "Warehouse-connected analytics, dashboards, and SQL-heavy collaborative data work.",
    cocalc:
      "Choose CoCalc when the center of gravity is a technical project rather than a BI or data-app surface: notebooks, Linux tools, reproducible documents, teaching, and broader engineering workflows.",
    key: "analytics",
    title: "Deepnote and analytics-first notebook platforms",
  },
  {
    bestAt:
      "Building-block flexibility for organizations that want to assemble and operate their own notebook stack.",
    cocalc:
      "Choose CoCalc when you want the integrated product instead of stitching together Jupyter interfaces, terminals, collaboration, support, grading, and user-facing operations yourself.",
    key: "jupyter-stack",
    title: "JupyterHub, JupyterLab, and VS Code notebook workflows",
  },
  {
    bestAt:
      "IDE-first application development, app shipping, and product-style coding workflows.",
    cocalc:
      "Choose CoCalc when the team also needs notebook-native work, technical teaching, mathematical documents, or shared Linux/project workflows beyond a single app editor.",
    key: "ide",
    title: "Replit and other IDE-first coding platforms",
  },
];

const DECISION_ROWS = [
  {
    cocalc:
      "The whole technical project: notebooks, terminals, files, documents, whiteboards, support, and AI work in one shared place.",
    key: "unit",
    question: "What is the unit of work?",
    typical:
      "A single notebook, dashboard, editor, or app builder is the center, and the rest lives elsewhere.",
  },
  {
    cocalc:
      "Realtime collaboration spans notebooks, terminals, documents, whiteboards, and chat, backed by Patchflow.",
    key: "collab",
    question: "How broad is collaboration?",
    typical:
      "Collaboration is strongest in one surface, while adjacent tools are separate or less synchronized.",
  },
  {
    cocalc:
      "Courses, assignments, collection, grading, and student support live in the same environment as the technical work.",
    key: "teaching",
    question: "How important is teaching or structured support?",
    typical:
      "Teaching, LMS integration, or support workflows often require separate systems and operational glue.",
  },
  {
    cocalc:
      "The same user model can start hosted and later move to CoCalc Plus, Launchpad, or custom deployment.",
    key: "deployment",
    question: "Do deployment options matter?",
    typical:
      "The product is optimized around a single hosted or self-assembled deployment model.",
  },
  {
    cocalc:
      "Agent workflows increasingly live inside the same collaborative project, especially with Codex integration, so the model can help with real files, notebooks, terminals, and chat context.",
    key: "agents",
    question: "How agent-native is the AI story?",
    typical:
      "AI may be useful, but it often behaves more like a sidecar prompt box, autocomplete layer, or isolated assistant tied to one surface.",
  },
  {
    cocalc:
      "You can keep shell tools, documents, slides, and notebooks close together instead of splitting work across services.",
    key: "breadth",
    question: "How broad is the technical workflow?",
    typical:
      "The product is excellent at its slice, but you still need other tools for the rest of the workflow.",
  },
];

export default function CompareFeaturePage({
  helpEmail,
}: {
  helpEmail?: string;
}) {
  return (
    <Flex vertical gap={18}>
      <PublicSectionCard>
        <Text strong type="secondary">
          COMPARISON
        </Text>
        <Title level={2} style={{ margin: 0 }}>
          Compare CoCalc by workflow, not by one checkbox
        </Title>
        <Paragraph style={{ fontSize: 18, margin: 0 }}>
          CoCalc is strongest when your team needs more than a notebook host,
          more than an IDE, and more than a dashboard surface. It is built for
          technical work that spills across notebooks, terminals, documents,
          teaching, and collaboration.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          The most useful comparison is not feature-counting. It is asking
          whether you want one integrated technical workspace, or a narrower
          product that is excellent at one slice and expects the rest of the
          workflow to live elsewhere.
        </Paragraph>
        <Flex wrap gap={12}>
          <Button type="primary" href={featureAppPath("auth/sign-up")}>
            Create account
          </Button>
          <LinkButton href={featureAppPath("features/jupyter-notebook")}>
            Jupyter notebooks
          </LinkButton>
          <LinkButton href={featureAppPath("features/teaching")}>
            Teaching workflows
          </LinkButton>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
      <Alert
        type="warning"
        showIcon
        title="These comparisons are intentionally high level."
        description="Products evolve quickly, and many competitors are excellent at the workflow they target. The point here is to clarify where CoCalc's integrated model is a better fit."
      />
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          AI agents now change the comparison
        </Title>
        <Paragraph style={{ margin: 0 }}>
          A lot of products now have some version of AI help. What matters is
          whether that help is just a prompt box next to your work, or whether
          it can participate in the real workspace where the files, notebooks,
          shell commands, and conversations already live.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          CoCalc AI&apos;s current direction is increasingly agent-first,
          especially around Codex. The goal is not only to answer questions, but
          to help inspect code, patch files, reason about failures, and move
          technical work forward inside the same collaborative environment as
          the rest of the team.
        </Paragraph>
        <BulletList
          items={[
            "Use agents in the same chats and projects where the actual work is happening.",
            "Keep notebooks, terminals, files, screenshots, and collaborators near the model instead of reconstructing context elsewhere.",
            "Treat AI as part of the workflow for debugging, migration, support, and technical writing, not only as answer generation.",
          ]}
        />
        <Flex wrap gap={12}>
          <LinkButton href={featureAppPath("features/ai")}>
            AI agents
          </LinkButton>
          <LinkButton href="https://github.com/sagemathinc/patchflow">
            Patchflow
          </LinkButton>
        </Flex>
      </PublicSectionCard>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Pick CoCalc if you want
            </Title>
            <BulletList
              items={[
                "One place for notebooks, Linux tools, files, technical documents, whiteboards, and collaboration.",
                "Realtime editing that extends beyond notebook cells, backed by Patchflow.",
                "Coding agents that work inside the shared workspace instead of only in a detached prompt box.",
                "A product that works for classes, research groups, and engineering teams without assembling a stack.",
                "Hosted and self-hosted deployment options that still feel like the same product.",
              ]}
            />
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Another tool may fit better if you mainly want
            </Title>
            <BulletList
              items={[
                "A lightweight hosted notebook with quick access to compute and sharing.",
                "An analytics-first environment centered on SQL, dashboards, and data-source integrations.",
                "A do-it-yourself Jupyter stack where building blocks matter more than integrated product behavior.",
                "An IDE-first app-building workflow where notebooks and teaching are secondary.",
              ]}
            />
          </PublicSectionCard>
        </Col>
      </Row>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          How CoCalc compares by category
        </Title>
        <Row gutter={[16, 16]}>
          {COMPARISON_GROUPS.map((group) => (
            <Col key={group.key} xs={24} md={12}>
              <PublicSectionCard>
                <Title level={4} style={{ margin: 0 }}>
                  {group.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  <Text strong>Usually best at: </Text>
                  {group.bestAt}
                </Paragraph>
                <Paragraph style={{ margin: 0 }}>
                  <Text strong>Why people still choose CoCalc: </Text>
                  {group.cocalc}
                </Paragraph>
              </PublicSectionCard>
            </Col>
          ))}
        </Row>
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Questions technical teams usually care about
        </Title>
        <Table
          bordered
          columns={[
            {
              dataIndex: "question",
              key: "question",
              title: "Question",
              width: "22%",
            },
            {
              dataIndex: "cocalc",
              key: "cocalc",
              title: "If you choose CoCalc",
              width: "39%",
            },
            {
              dataIndex: "typical",
              key: "typical",
              title: "If you choose a narrower point solution",
              width: "39%",
            },
          ]}
          dataSource={DECISION_ROWS}
          pagination={false}
          rowKey="key"
          size="middle"
        />
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Best fit
        </Title>
        <BulletList
          items={[
            "Technical courses where notebooks, grading, student support, and shared infrastructure all need to work together.",
            "Research or engineering teams that want notebooks, terminals, and technical documents in the same collaborative environment.",
            "Organizations that may start hosted and later want CoCalc Plus, Launchpad, or a custom deployment without changing the user model.",
          ]}
        />
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Related feature pages
        </Title>
        <Flex wrap gap={12}>
          <LinkButton href={featureAppPath("features/jupyter-notebook")}>
            Jupyter notebooks
          </LinkButton>
          <LinkButton href={featureAppPath("features/terminal")}>
            Linux terminal
          </LinkButton>
          <LinkButton href={featureAppPath("features/teaching")}>
            Teaching a course
          </LinkButton>
          <LinkButton href={featureAppPath("features/latex-editor")}>
            LaTeX editor
          </LinkButton>
          <LinkButton href={featureAppPath("features/ai")}>
            AI agents
          </LinkButton>
          <LinkButton href="https://github.com/sagemathinc/patchflow">
            Patchflow
          </LinkButton>
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
