/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo, useState } from "react";

import {
  BookOutlined,
  SearchOutlined,
  ToolOutlined,
  ArrowLeftOutlined,
} from "@ant-design/icons";
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
  searchDocsEntries,
  type DocsAction,
  type DocsEntry,
} from "@cocalc/docs";
import Markdown from "@cocalc/frontend/markdown/component";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text, Title } = Typography;

export type DocsBrowserAction = DocsAction & {
  available?: boolean;
  implemented?: boolean;
  reason?: string;
};

export function DocsMarkdown({ value }: { value: string }) {
  return <Markdown value={value} />;
}

export function DocsCard({
  entry,
  href,
  onSelect,
}: {
  entry: DocsEntry;
  href?: string;
  onSelect?: (entry: DocsEntry) => void;
}) {
  const content = (
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
  );

  if (href != null) {
    return (
      <a href={href} style={{ color: "inherit", textDecoration: "none" }}>
        {content}
      </a>
    );
  }

  return (
    <button
      onClick={() => onSelect?.(entry)}
      style={{
        background: "transparent",
        border: 0,
        color: "inherit",
        cursor: "pointer",
        display: "block",
        margin: 0,
        padding: 0,
        textAlign: "left",
        width: "100%",
      }}
      type="button"
    >
      {content}
    </button>
  );
}

export function DocsIndexContent({
  linkForEntry,
  onSelectEntry,
}: {
  linkForEntry?: (entry: DocsEntry) => string;
  onSelectEntry?: (entry: DocsEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const entries = useMemo(() => searchDocsEntries(query), [query]);

  return (
    <Flex gap="large" vertical>
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
          <Col key={entry.id} lg={8} md={12} xs={24}>
            <DocsCard
              entry={entry}
              href={linkForEntry?.(entry)}
              onSelect={onSelectEntry}
            />
          </Col>
        ))}
      </Row>
      {entries.length === 0 ? (
        <Empty description="No documentation pages match that search." />
      ) : null}
    </Flex>
  );
}

function actionState(action: DocsBrowserAction): {
  buttonText: string;
  disabled: boolean;
  tagText: string;
} {
  if (!action.executable) {
    return { buttonText: action.label, disabled: true, tagText: "planned" };
  }
  if (action.implemented === false) {
    return {
      buttonText: action.label,
      disabled: true,
      tagText: "not wired yet",
    };
  }
  if (action.available === false) {
    return {
      buttonText: action.label,
      disabled: true,
      tagText: action.reason ?? "not available",
    };
  }
  return { buttonText: action.label, disabled: false, tagText: "open in app" };
}

export function DocsActions({
  actions,
  onRunAction,
}: {
  actions?: DocsBrowserAction[];
  onRunAction?: (action: DocsBrowserAction) => void | Promise<void>;
}) {
  if (!actions?.length) return null;

  return (
    <Card>
      <Flex gap="middle" vertical>
        <Space>
          <ToolOutlined />
          <Text strong>Open this in CoCalc</Text>
        </Space>
        <Paragraph style={{ margin: 0 }}>
          Docs actions are stable UI destinations. In the app they can open the
          relevant panel directly; for agents they provide precise action ids.
        </Paragraph>
        <Space wrap>
          {actions.map((action) => {
            const state = actionState(action);
            return (
              <Button
                data-cocalc-action-id={action.id}
                disabled={state.disabled || onRunAction == null}
                key={action.id}
                onClick={() => void onRunAction?.(action)}
                title={action.reason ?? action.description}
                type={
                  !state.disabled && onRunAction != null ? "primary" : "default"
                }
              >
                {state.buttonText}
              </Button>
            );
          })}
        </Space>
        <Space wrap>
          {actions.map((action) => {
            const state = actionState(action);
            return (
              <Tag
                color={
                  !state.disabled && onRunAction != null ? "green" : undefined
                }
                key={action.id}
              >
                <span>{action.id}</span>{" "}
                <Text type="secondary">{state.tagText}</Text>
              </Tag>
            );
          })}
        </Space>
      </Flex>
    </Card>
  );
}

export function DocsDetailContent({
  actionAvailability,
  entry,
  onBack,
  onRunAction,
}: {
  actionAvailability?: Map<string, DocsBrowserAction>;
  entry: DocsEntry;
  onBack?: () => void;
  onRunAction?: (action: DocsBrowserAction) => void | Promise<void>;
}) {
  const actions = entry.actions?.map((action) => ({
    ...action,
    ...actionAvailability?.get(action.id),
  }));

  return (
    <Flex gap="large" vertical>
      {onBack != null ? (
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={onBack}
          style={{ width: "fit-content" }}
        >
          All docs
        </Button>
      ) : null}
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
      <DocsActions actions={actions} onRunAction={onRunAction} />
      <Card>
        <DocsMarkdown value={entry.body} />
      </Card>
    </Flex>
  );
}

export function DocsBrowser({
  actionAvailability,
  initialEntry,
  onRunAction,
}: {
  actionAvailability?: DocsBrowserAction[];
  initialEntry?: DocsEntry;
  onRunAction?: (action: DocsBrowserAction) => void | Promise<void>;
}) {
  const [selectedEntry, setSelectedEntry] = useState<DocsEntry | undefined>(
    initialEntry,
  );
  const actionMap = useMemo(
    () =>
      new Map<string, DocsBrowserAction>(
        actionAvailability?.map((action) => [action.id, action]) ?? [],
      ),
    [actionAvailability],
  );

  if (selectedEntry != null) {
    return (
      <DocsDetailContent
        actionAvailability={actionMap}
        entry={selectedEntry}
        onBack={() => setSelectedEntry(undefined)}
        onRunAction={onRunAction}
      />
    );
  }

  return <DocsIndexContent onSelectEntry={setSelectedEntry} />;
}

export const DOCS_BROWSER_PAGE_STYLE: React.CSSProperties = {
  margin: "0 auto",
  maxWidth: 1200,
  padding: "24px",
};

export const DOCS_BROWSER_FLYOUT_STYLE: React.CSSProperties = {
  padding: "0 18px 24px 0",
};

export const DOCS_BROWSER_MUTED_TITLE_STYLE: React.CSSProperties = {
  color: COLORS.GRAY_M,
  fontSize: 13,
  letterSpacing: 0,
  textTransform: "uppercase",
};
