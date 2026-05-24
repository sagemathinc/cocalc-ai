/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";

import { BookOutlined, SearchOutlined, ToolOutlined } from "@ant-design/icons";
import {
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Input,
  Row,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  appPath,
  getSiteName,
  MarkdownSection,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { PUBLIC_COLORS } from "../theme";
import {
  docsPath,
  getDocsEntry,
  searchDocsEntries,
  type DocsEntry,
} from "./data";
import type { PublicDocsRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

interface PublicDocsAppProps {
  config?: PublicConfig;
  initialRoute: PublicDocsRoute;
}

function DocsCard({ entry }: { entry: DocsEntry }) {
  return (
    <Col lg={8} md={12} xs={24}>
      <a
        href={appPath(docsPath(entry.slug))}
        style={{ color: "inherit", textDecoration: "none" }}
      >
        <Card hoverable style={{ height: "100%" }}>
          <Flex gap="middle" vertical>
            <Space>
              <BookOutlined />
              <Text type="secondary">{entry.category}</Text>
            </Space>
            <Title level={3} style={{ margin: 0 }}>
              {entry.title}
            </Title>
            <Paragraph style={{ margin: 0 }}>{entry.summary}</Paragraph>
            <Space wrap>
              {entry.audiences.map((audience) => (
                <Tag key={audience}>{audience}</Tag>
              ))}
            </Space>
          </Flex>
        </Card>
      </a>
    </Col>
  );
}

function DocsIndex({ config }: { config?: PublicConfig }) {
  const siteName = getSiteName(config);
  const [query, setQuery] = useState("");
  const entries = useMemo(() => searchDocsEntries(query), [query]);

  useEffect(() => {
    document.title = `Documentation - ${siteName}`;
  }, [siteName]);

  return (
    <PublicSectionShell active="docs" config={config}>
      <section>
        <Flex gap="large" vertical>
          <div>
            <Text
              strong
              style={{ color: PUBLIC_COLORS.brand, textTransform: "uppercase" }}
            >
              CoCalc-ai documentation
            </Text>
            <Title style={{ marginBottom: 12, marginTop: 10 }}>
              Current docs for this CoCalc instance.
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0, maxWidth: "72ch" }}>
              These docs are served by CoCalc-ai itself, so they can evolve with
              the product, link to the current UI, and become source material
              for agents answering questions inside your workspace.
            </Paragraph>
          </div>
          <Input
            allowClear
            aria-label="Search documentation"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search docs"
            prefix={<SearchOutlined />}
            size="large"
            style={{ maxWidth: 520 }}
            value={query}
          />
          <Row gutter={[18, 18]}>
            {entries.map((entry) => (
              <DocsCard entry={entry} key={entry.id} />
            ))}
          </Row>
          {entries.length === 0 ? (
            <Empty description="No documentation pages match that search." />
          ) : null}
        </Flex>
      </section>
    </PublicSectionShell>
  );
}

function DocsActions({ entry }: { entry: DocsEntry }) {
  if (!entry.actions?.length) return null;
  return (
    <Card>
      <Flex gap="middle" vertical>
        <Space>
          <ToolOutlined />
          <Text strong>Deep actions</Text>
        </Space>
        <Paragraph style={{ margin: 0 }}>
          These stable ids are the bridge from documentation to the product UI.
          The browser-session action layer can use them to open precise panels
          from Codex or from future in-app docs controls.
        </Paragraph>
        <Space wrap>
          {entry.actions.map((action) => (
            <Button
              data-cocalc-action-id={action.id}
              disabled
              key={action.id}
              title={action.description}
            >
              {action.label}
            </Button>
          ))}
        </Space>
        <Space wrap>
          {entry.actions.map((action) => (
            <Tag key={action.id}>{action.id}</Tag>
          ))}
        </Space>
      </Flex>
    </Card>
  );
}

function DocsDetail({
  config,
  entry,
}: {
  config?: PublicConfig;
  entry: DocsEntry;
}) {
  const siteName = getSiteName(config);

  useEffect(() => {
    document.title = `${entry.title} - Documentation - ${siteName}`;
  }, [entry.title, siteName]);

  return (
    <PublicSectionShell active="docs" config={config}>
      <section>
        <Flex gap="large" vertical>
          <Card>
            <Flex gap="middle" vertical>
              <Space wrap>
                <Tag color="blue">{entry.category}</Tag>
                <Tag>{entry.status}</Tag>
                <Text type="secondary">Reviewed {entry.lastReviewed}</Text>
              </Space>
              <Title style={{ margin: 0 }}>{entry.title}</Title>
              <Paragraph style={{ fontSize: 18, margin: 0 }}>
                {entry.summary}
              </Paragraph>
              <Space wrap>
                {entry.audiences.map((audience) => (
                  <Tag key={audience}>{audience}</Tag>
                ))}
              </Space>
            </Flex>
          </Card>
          <DocsActions entry={entry} />
          <MarkdownSection value={entry.body} />
        </Flex>
      </section>
    </PublicSectionShell>
  );
}

function DocsNotFound({ config }: { config?: PublicConfig }) {
  const siteName = getSiteName(config);

  useEffect(() => {
    document.title = `Documentation page not found - ${siteName}`;
  }, [siteName]);

  return (
    <PublicSectionShell
      active="docs"
      config={config}
      title="Docs page not found"
    >
      <Empty description="That documentation page does not exist yet." />
      <Button href={appPath("docs")} type="primary">
        Browse docs
      </Button>
    </PublicSectionShell>
  );
}

export default function PublicDocsApp({
  config,
  initialRoute,
}: PublicDocsAppProps) {
  if (initialRoute.view === "docs-index") {
    return <DocsIndex config={config} />;
  }

  const entry = getDocsEntry(initialRoute.slug);
  if (entry == null) {
    return <DocsNotFound config={config} />;
  }
  return <DocsDetail config={config} entry={entry} />;
}
