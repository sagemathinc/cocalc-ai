/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useState } from "react";

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
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text, Title } = Typography;

type DocsBrowserLayout = "page" | "flyout";
const DOCS_FONT_SIZE_STORAGE_KEY = "cocalc-docs-font-size";
export const DOCS_FONT_SIZE_MIN = 10;
export const DOCS_FONT_SIZE_MAX = 32;
export const DOCS_FONT_SIZE_STEP = 1;

export type DocsBrowserAction = DocsAction & {
  available?: boolean;
  implemented?: boolean;
  reason?: string;
};

function clampDocsFontSize(value: number): number {
  if (!Number.isFinite(value)) return 14;
  return Math.max(
    DOCS_FONT_SIZE_MIN,
    Math.min(DOCS_FONT_SIZE_MAX, Math.round(value)),
  );
}

function readStoredDocsFontSize(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(DOCS_FONT_SIZE_STORAGE_KEY);
  if (!raw) return undefined;
  return clampDocsFontSize(Number(raw));
}

function writeStoredDocsFontSize(value: number, defaultFontSize: number): void {
  if (typeof window === "undefined") return;
  if (value === clampDocsFontSize(defaultFontSize)) {
    window.localStorage.removeItem(DOCS_FONT_SIZE_STORAGE_KEY);
  } else {
    window.localStorage.setItem(DOCS_FONT_SIZE_STORAGE_KEY, `${value}`);
  }
}

export function useDocsFontSize(defaultFontSize = 14) {
  const defaultSize = clampDocsFontSize(defaultFontSize);
  const [fontSize, setFontSizeState] = useState(
    () => readStoredDocsFontSize() ?? defaultSize,
  );

  useEffect(() => {
    if (readStoredDocsFontSize() == null) {
      setFontSizeState(defaultSize);
    }
  }, [defaultSize]);

  const setFontSize = useCallback(
    (value: number) => {
      const next = clampDocsFontSize(value);
      writeStoredDocsFontSize(next, defaultSize);
      setFontSizeState(next);
    },
    [defaultSize],
  );

  const resetFontSize = useCallback(() => {
    writeStoredDocsFontSize(defaultSize, defaultSize);
    setFontSizeState(defaultSize);
  }, [defaultSize]);

  return {
    fontSize,
    setFontSize,
    resetFontSize,
    increaseFontSize: () => setFontSize(fontSize + DOCS_FONT_SIZE_STEP),
    decreaseFontSize: () => setFontSize(fontSize - DOCS_FONT_SIZE_STEP),
    canIncreaseFontSize: fontSize < DOCS_FONT_SIZE_MAX,
    canDecreaseFontSize: fontSize > DOCS_FONT_SIZE_MIN,
  };
}

export function DocsFontSizeFrame({
  children,
  defaultFontSize = 14,
  layout = "page",
}: {
  children: React.ReactNode;
  defaultFontSize?: number;
  layout?: DocsBrowserLayout;
}) {
  const {
    canDecreaseFontSize,
    canIncreaseFontSize,
    decreaseFontSize,
    fontSize,
    increaseFontSize,
    resetFontSize,
  } = useDocsFontSize(defaultFontSize);

  return (
    <div style={{ position: "relative" }}>
      <Flex
        justify="end"
        style={{
          marginBottom: layout === "flyout" ? 8 : 12,
          position: "relative",
          zIndex: 1,
        }}
      >
        <Space.Compact
          size="small"
          style={{
            background: "white",
            borderRadius: 6,
            boxShadow: "0 1px 4px rgba(15, 23, 42, 0.12)",
          }}
        >
          <Button
            aria-label="Decrease docs font size"
            disabled={!canDecreaseFontSize}
            onClick={decreaseFontSize}
            title="Decrease docs font size"
          >
            A-
          </Button>
          <Button
            aria-label="Reset docs font size"
            onClick={resetFontSize}
            title="Reset docs font size"
          >
            {fontSize}px
          </Button>
          <Button
            aria-label="Increase docs font size"
            disabled={!canIncreaseFontSize}
            onClick={increaseFontSize}
            title="Increase docs font size"
          >
            A+
          </Button>
        </Space.Compact>
      </Flex>
      <div className="cocalc-docs-font-scope" style={{ fontSize }}>
        {children}
      </div>
    </div>
  );
}

export function DocsMarkdown({ value }: { value: string }) {
  return <StaticMarkdown value={value} />;
}

function DocsEntryImage({
  entry,
  mode,
}: {
  entry: DocsEntry;
  mode: "card" | "detail" | "flyout-card" | "flyout-detail";
}) {
  if (entry.image == null) return null;

  const src =
    mode === "card" || mode === "flyout-card"
      ? (entry.image.thumbnailSrc ?? entry.image.src)
      : entry.image.src;
  const isIcon = entry.image.presentation === "icon";

  if (mode === "flyout-card") {
    return (
      <img
        alt=""
        src={src}
        style={{
          aspectRatio: isIcon ? "1 / 1" : "4 / 3",
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: 7,
          flex: "0 0 76px",
          objectFit: isIcon ? "contain" : "cover",
          width: 76,
        }}
      />
    );
  }

  if (isIcon) {
    const maxWidth =
      mode === "flyout-detail" ? 144 : mode === "detail" ? 220 : 160;
    return (
      <img
        alt={entry.image.alt}
        src={src}
        style={{
          aspectRatio: "1 / 1",
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: mode === "flyout-detail" ? 8 : 10,
          display: "block",
          margin: "0 auto",
          maxWidth,
          objectFit: "contain",
          width: "100%",
        }}
      />
    );
  }

  return (
    <img
      alt={entry.image.alt}
      src={src}
      style={{
        aspectRatio: "16 / 9",
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: mode === "flyout-detail" ? 8 : 10,
        display: "block",
        objectFit: "cover",
        width: "100%",
      }}
    />
  );
}

export function DocsCard({
  entry,
  href,
  layout = "page",
  onSelect,
}: {
  entry: DocsEntry;
  href?: string;
  layout?: DocsBrowserLayout;
  onSelect?: (entry: DocsEntry) => void;
}) {
  if (layout === "flyout") {
    const content = (
      <Flex align="start" gap={10}>
        <DocsEntryImage entry={entry} mode="flyout-card" />
        <Flex gap={6} style={{ minWidth: 0 }} vertical>
          <Space size={6} wrap>
            <BookOutlined style={{ color: COLORS.BLUE }} />
            <Text type="secondary" style={{ fontSize: "0.86em" }}>
              {entry.category}
            </Text>
          </Space>
          <Text strong style={{ fontSize: "1.07em", lineHeight: 1.25 }}>
            {entry.title}
          </Text>
          <Text
            style={{
              color: COLORS.GRAY_M,
              fontSize: "0.93em",
              lineHeight: 1.35,
            }}
          >
            {entry.summary}
          </Text>
          <Space size={[4, 4]} wrap>
            {entry.audiences.slice(0, 3).map((audience) => (
              <Tag key={audience} style={{ marginInlineEnd: 0 }}>
                {audience}
              </Tag>
            ))}
          </Space>
        </Flex>
      </Flex>
    );

    if (href != null) {
      return (
        <a href={href} style={{ color: "inherit", textDecoration: "none" }}>
          <div style={DOCS_BROWSER_FLYOUT_ITEM_STYLE}>{content}</div>
        </a>
      );
    }

    return (
      <button
        onClick={() => onSelect?.(entry)}
        style={{
          ...DOCS_BROWSER_FLYOUT_ITEM_STYLE,
          cursor: "pointer",
          textAlign: "left",
          width: "100%",
        }}
        type="button"
      >
        {content}
      </button>
    );
  }

  const content = (
    <Card hoverable style={{ height: "100%" }}>
      <Flex gap="middle" vertical>
        <DocsEntryImage entry={entry} mode="card" />
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
  layout = "page",
  linkForEntry,
  onSelectEntry,
}: {
  layout?: DocsBrowserLayout;
  linkForEntry?: (entry: DocsEntry) => string;
  onSelectEntry?: (entry: DocsEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const entries = useMemo(() => searchDocsEntries(query), [query]);

  return (
    <Flex gap={layout === "flyout" ? "middle" : "large"} vertical>
      <Input
        allowClear
        aria-label="Search documentation"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search docs"
        prefix={<SearchOutlined />}
        size={layout === "flyout" ? "middle" : "large"}
        style={{ maxWidth: layout === "flyout" ? undefined : 520 }}
        value={query}
      />
      {layout === "flyout" ? (
        <Flex gap={10} vertical>
          {entries.map((entry) => (
            <DocsCard
              entry={entry}
              key={entry.id}
              layout={layout}
              href={linkForEntry?.(entry)}
              onSelect={onSelectEntry}
            />
          ))}
        </Flex>
      ) : (
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
      )}
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
  layout = "page",
  onRunAction,
}: {
  actions?: DocsBrowserAction[];
  layout?: DocsBrowserLayout;
  onRunAction?: (action: DocsBrowserAction) => void | Promise<void>;
}) {
  if (!actions?.length) return null;

  const content = (
    <Flex gap={layout === "flyout" ? "small" : "middle"} vertical>
      <Space>
        <ToolOutlined />
        <Text strong>Open this in CoCalc</Text>
      </Space>
      {layout === "page" ? (
        <Paragraph style={{ margin: 0 }}>
          Docs actions are stable UI destinations. In the app they can open the
          relevant panel directly; for agents they provide precise action ids.
        </Paragraph>
      ) : null}
      <Space orientation={layout === "flyout" ? "vertical" : "horizontal"} wrap>
        {actions.map((action) => {
          const state = actionState(action);
          return (
            <Button
              block={layout === "flyout"}
              data-cocalc-action-id={action.id}
              disabled={state.disabled || onRunAction == null}
              key={action.id}
              onClick={() => void onRunAction?.(action)}
              size={layout === "flyout" ? "small" : "middle"}
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
      {layout === "page" ? (
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
      ) : null}
    </Flex>
  );

  if (layout === "flyout") {
    return <div style={DOCS_BROWSER_FLYOUT_ACTIONS_STYLE}>{content}</div>;
  }

  return <Card>{content}</Card>;
}

export function DocsDetailContent({
  actionAvailability,
  entry,
  layout = "page",
  onBack,
  onRunAction,
}: {
  actionAvailability?: Map<string, DocsBrowserAction>;
  entry: DocsEntry;
  layout?: DocsBrowserLayout;
  onBack?: () => void;
  onRunAction?: (action: DocsBrowserAction) => void | Promise<void>;
}) {
  const actions = entry.actions?.map((action) => ({
    ...action,
    ...actionAvailability?.get(action.id),
  }));

  if (layout === "flyout") {
    return (
      <Flex gap="middle" vertical>
        {onBack != null ? (
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={onBack}
            size="small"
            style={{ width: "fit-content" }}
          >
            All docs
          </Button>
        ) : null}
        <Flex gap="small" vertical>
          <Space size={[4, 4]} wrap>
            <Tag color="blue">{entry.category}</Tag>
            <Tag>{entry.status}</Tag>
          </Space>
          <Title level={3} style={{ margin: 0 }}>
            {entry.title}
          </Title>
          <Text style={{ color: COLORS.GRAY_M, lineHeight: 1.4 }}>
            {entry.summary}
          </Text>
        </Flex>
        <DocsEntryImage entry={entry} mode="flyout-detail" />
        <DocsActions
          actions={actions}
          layout={layout}
          onRunAction={onRunAction}
        />
        <div style={DOCS_BROWSER_FLYOUT_MARKDOWN_STYLE}>
          <DocsMarkdown value={entry.body} />
        </div>
      </Flex>
    );
  }

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
        <Row align="middle" gutter={[24, 24]}>
          <Col lg={entry.image == null ? 24 : 14} xs={24}>
            <Flex gap="middle" vertical>
              <Space wrap>
                <Tag color="blue">{entry.category}</Tag>
                <Tag>{entry.status}</Tag>
                <Text type="secondary">Reviewed {entry.lastReviewed}</Text>
              </Space>
              <Title style={{ margin: 0 }}>{entry.title}</Title>
              <Paragraph style={{ fontSize: "1.125em", margin: 0 }}>
                {entry.summary}
              </Paragraph>
              <Space wrap>
                {entry.audiences.map((audience) => (
                  <Tag key={audience}>{audience}</Tag>
                ))}
              </Space>
            </Flex>
          </Col>
          {entry.image != null ? (
            <Col lg={10} xs={24}>
              <DocsEntryImage entry={entry} mode="detail" />
            </Col>
          ) : null}
        </Row>
      </Card>
      <DocsActions
        actions={actions}
        layout={layout}
        onRunAction={onRunAction}
      />
      <Card>
        <DocsMarkdown value={entry.body} />
      </Card>
    </Flex>
  );
}

export function DocsBrowser({
  actionAvailability,
  initialEntry,
  layout = "page",
  onRunAction,
}: {
  actionAvailability?: DocsBrowserAction[];
  initialEntry?: DocsEntry;
  layout?: DocsBrowserLayout;
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
        layout={layout}
        onBack={() => setSelectedEntry(undefined)}
        onRunAction={onRunAction}
      />
    );
  }

  return <DocsIndexContent layout={layout} onSelectEntry={setSelectedEntry} />;
}

export const DOCS_BROWSER_PAGE_STYLE: React.CSSProperties = {
  margin: "0 auto",
  maxWidth: 1200,
  padding: "24px",
};

export const DOCS_BROWSER_FLYOUT_STYLE: React.CSSProperties = {
  padding: "0 14px 24px 0",
};

export const DOCS_BROWSER_MUTED_TITLE_STYLE: React.CSSProperties = {
  color: COLORS.GRAY_M,
  fontSize: "0.93em",
  letterSpacing: 0,
  textTransform: "uppercase",
};

const DOCS_BROWSER_FLYOUT_ITEM_STYLE: React.CSSProperties = {
  background: "#fff",
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: 8,
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
  color: "inherit",
  display: "block",
  margin: 0,
  padding: "12px 12px 10px",
};

const DOCS_BROWSER_FLYOUT_ACTIONS_STYLE: React.CSSProperties = {
  background: COLORS.ANTD_BG_BLUE_L,
  border: `1px solid ${COLORS.BLUE_LLL}`,
  borderRadius: 8,
  padding: 12,
};

const DOCS_BROWSER_FLYOUT_MARKDOWN_STYLE: React.CSSProperties = {
  background: "#fff",
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: 8,
  padding: "4px 12px",
};
