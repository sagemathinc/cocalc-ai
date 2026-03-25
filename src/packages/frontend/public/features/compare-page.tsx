/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Flex, Table, Typography } from "antd";

import { PublicSectionCard } from "@cocalc/frontend/public/ui/shell";
import { BulletList, LinkButton, featureAppPath } from "./page-components";

const { Paragraph, Text, Title } = Typography;

const ROWS = [
  {
    key: "collaboration",
    feature: "Realtime collaboration",
    cocalc:
      "Shared editing across notebooks, terminals, whiteboards, and documents.",
    alternatives:
      "Often limited to a subset of file types or handled by separate products.",
  },
  {
    key: "environment",
    feature: "Integrated environment",
    cocalc:
      "Notebooks, terminals, files, LaTeX, chat, and course workflows in one project.",
    alternatives:
      "Users stitch together separate notebook, editor, terminal, storage, and chat tools.",
  },
  {
    key: "teaching",
    feature: "Teaching workflows",
    cocalc:
      "Assignments, collection, grading, nbgrader support, and classroom-friendly sharing.",
    alternatives:
      "Usually require extra LMS glue, scripts, or additional tools.",
  },
  {
    key: "history",
    feature: "History and recovery",
    cocalc:
      "TimeTravel and file history are built into collaborative workflows.",
    alternatives:
      "Versioning often depends on Git only, snapshots, or provider-specific partial history.",
  },
  {
    key: "hosting",
    feature: "Hosted plus self-hosted",
    cocalc:
      "Hosted CoCalc, CoCalc Plus, Launchpad, and custom deployment options all share the same overall model.",
    alternatives:
      "Products often optimize for one narrow deployment mode only.",
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
          Comparing CoCalc to common alternatives
        </Title>
        <Paragraph style={{ fontSize: 18, margin: 0 }}>
          CoCalc is not just one more notebook host. The point is that it
          bundles the pieces technical teams usually have to assemble
          themselves.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          In practice, people often compare isolated slices: notebooks,
          terminals, grading, document editing, or collaborative support. CoCalc
          is strongest when those workflows need to live in one place.
        </Paragraph>
        <Flex wrap gap={12}>
          <Button type="primary" href={featureAppPath("auth/sign-up")}>
            Create account
          </Button>
          <LinkButton href={featureAppPath("features")}>
            Browse feature pages
          </LinkButton>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
      <Alert
        type="warning"
        showIcon
        message="These comparisons are intentionally high level."
        description="Products change quickly, and many are strong at the slice they focus on. The point here is to show where CoCalc's integrated model matters most."
      />
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Where CoCalc stands out
        </Title>
        <Table
          bordered
          columns={[
            {
              title: "Workflow",
              dataIndex: "feature",
              key: "feature",
              width: "22%",
            },
            {
              title: "CoCalc",
              dataIndex: "cocalc",
              key: "cocalc",
              width: "39%",
            },
            {
              title: "Typical point solution",
              dataIndex: "alternatives",
              key: "alternatives",
              width: "39%",
            },
          ]}
          dataSource={ROWS}
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
            "Technical courses where the same environment must support assignments, grading, notebooks, and support.",
            "Research or engineering teams that want notebooks, terminals, documents, and collaboration in one place.",
            "Organizations that want hosted and self-hosted options without changing the basic user model.",
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
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
