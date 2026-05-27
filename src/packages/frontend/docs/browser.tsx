/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ArrowRightOutlined,
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
  Segmented,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  type DocsAccess,
  listDocsEntries,
  searchDocsEntries,
  type DocsAction,
  type DocsEntry,
} from "@cocalc/docs";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { COLORS } from "@cocalc/util/theme";
import type {
  DocsPrivateEntrySummary,
  DocsPrivateFilter,
} from "./private-state/types";

const { Paragraph, Text, Title } = Typography;

type DocsBrowserLayout = "page" | "flyout";
const DOCS_FONT_SIZE_STORAGE_KEY = "cocalc-docs-font-size";
const DOCS_BROWSER_CARD_STYLE = { fontSize: "inherit" };
const DOCS_BROWSER_CARD_BODY_STYLE = { fontSize: "inherit" };
const DOCS_BROWSER_CATEGORY_CARD_STYLE = {
  ...DOCS_BROWSER_CARD_STYLE,
  height: "100%",
  maxHeight: 500,
  overflow: "auto",
};
export const DOCS_FONT_SIZE_MIN = 10;
export const DOCS_FONT_SIZE_MAX = 32;
export const DOCS_FONT_SIZE_STEP = 1;

export type DocsBrowserAction = DocsAction & {
  available?: boolean;
  implemented?: boolean;
  reason?: string;
};

export type DocsPrivateIndexState = {
  enabled: boolean;
  filter: DocsPrivateFilter;
  summaries: Record<string, DocsPrivateEntrySummary>;
  toolbar?: React.ReactNode;
  onFilterChange: (filter: DocsPrivateFilter) => void;
};

export type DocsPrivateDetailState = {
  renderPanel: (entry: DocsEntry) => React.ReactNode;
};

type DocsLinearNavigationState = {
  count: number;
  currentIndex: number;
  entry: DocsEntry;
  next?: DocsEntry;
  nextChapter?: DocsEntry;
  onSelectEntry: (entry: DocsEntry) => void;
  previous?: DocsEntry;
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

function groupDocsEntriesByCategory(entries: DocsEntry[]): {
  category: string;
  entries: DocsEntry[];
}[] {
  const grouped = new Map<string, DocsEntry[]>();
  for (const entry of entries) {
    const categoryEntries = grouped.get(entry.category) ?? [];
    categoryEntries.push(entry);
    grouped.set(entry.category, categoryEntries);
  }
  return Array.from(grouped.entries()).map(([category, categoryEntries]) => ({
    category,
    entries: categoryEntries,
  }));
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
      <div
        className="cocalc-docs-font-scope"
        data-testid="docs-font-scope"
        style={{ fontSize }}
      >
        {children}
      </div>
    </div>
  );
}

export function DocsMarkdown({ value }: { value: string }) {
  return (
    <div data-testid="docs-markdown">
      <StaticMarkdown value={value} />
    </div>
  );
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
          flex: "0 0 125px",
          objectFit: isIcon ? "contain" : "cover",
          width: 125,
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
  privateNoteMatched,
  privateSummary,
}: {
  entry: DocsEntry;
  href?: string;
  layout?: DocsBrowserLayout;
  onSelect?: (entry: DocsEntry) => void;
  privateNoteMatched?: boolean;
  privateSummary?: DocsPrivateEntrySummary;
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
            {privateSummary?.starred ? <Tag color="gold">Starred</Tag> : null}
            {privateSummary?.lastViewedAt ? (
              <Tag color="green">Viewed</Tag>
            ) : null}
            {(privateSummary?.noteCount ?? 0) > 0 ? (
              <Tag>
                {privateNoteMatched
                  ? "matched your private notes"
                  : `${privateSummary?.noteCount} note${
                      privateSummary?.noteCount === 1 ? "" : "s"
                    }`}
              </Tag>
            ) : null}
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
    <div style={DOCS_BROWSER_PAGE_ITEM_STYLE}>
      <Flex align="start" gap={12}>
        <DocsEntryImage entry={entry} mode="flyout-card" />
        <Flex gap={7} style={{ minWidth: 0 }} vertical>
          <Space size={6} wrap>
            <BookOutlined style={{ color: COLORS.BLUE }} />
            <Text type="secondary" style={{ fontSize: "0.88em" }}>
              {entry.category}
            </Text>
          </Space>
          <Text strong style={{ fontSize: "1.08em", lineHeight: 1.25 }}>
            {entry.title}
          </Text>
          <Text style={{ color: COLORS.GRAY_M, lineHeight: 1.38 }}>
            {entry.summary}
          </Text>
          <Space size={[4, 4]} wrap>
            {entry.audiences.slice(0, 4).map((audience) => (
              <Tag key={audience} style={{ marginInlineEnd: 0 }}>
                {audience}
              </Tag>
            ))}
            {privateSummary?.starred ? <Tag color="gold">Starred</Tag> : null}
            {privateSummary?.lastViewedAt ? (
              <Tag color="green">Viewed</Tag>
            ) : null}
            {(privateSummary?.noteCount ?? 0) > 0 ? (
              <Tag>
                {privateNoteMatched
                  ? "matched your private notes"
                  : `${privateSummary?.noteCount} note${
                      privateSummary?.noteCount === 1 ? "" : "s"
                    }`}
              </Tag>
            ) : null}
          </Space>
        </Flex>
      </Flex>
    </div>
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
  docsAccess,
  layout = "page",
  linkForEntry,
  onSelectEntry,
  privateState,
}: {
  docsAccess?: DocsAccess;
  layout?: DocsBrowserLayout;
  linkForEntry?: (entry: DocsEntry) => string;
  onSelectEntry?: (entry: DocsEntry) => void;
  privateState?: DocsPrivateIndexState;
}) {
  const [query, setQuery] = useState("");
  const queryIsEmpty = query.trim().length === 0;
  const allEntries = useMemo(() => listDocsEntries(docsAccess), [docsAccess]);
  const entries = useMemo(() => {
    const trimQuery = query.trim().toLowerCase();
    const baseEntries = queryIsEmpty
      ? allEntries
      : searchDocsEntries(query, Number.POSITIVE_INFINITY, docsAccess);
    const publicIds = new Set(baseEntries.map((entry) => entry.id));
    const noteMatchedIds = new Set<string>();
    if (trimQuery && privateState?.enabled) {
      for (const [entryId, summary] of Object.entries(privateState.summaries)) {
        if (summary.noteText.toLowerCase().includes(trimQuery)) {
          noteMatchedIds.add(entryId);
        }
      }
    }
    const combined = queryIsEmpty
      ? baseEntries
      : [
          ...baseEntries,
          ...allEntries.filter(
            (entry) => noteMatchedIds.has(entry.id) && !publicIds.has(entry.id),
          ),
        ];
    return combined.filter((entry) => {
      const summary = privateState?.summaries[entry.id];
      switch (privateState?.filter ?? "all") {
        case "starred":
          return Boolean(summary?.starred);
        case "unstarred":
          return !summary?.starred;
        case "notes":
          return (summary?.noteCount ?? 0) > 0;
        default:
          return true;
      }
    });
  }, [allEntries, docsAccess, privateState, query, queryIsEmpty]);
  const groupedEntries = useMemo(
    () => groupDocsEntriesByCategory(entries),
    [entries],
  );
  const privateNoteMatched = (entry: DocsEntry) => {
    const trimQuery = query.trim().toLowerCase();
    if (!trimQuery) return false;
    return Boolean(
      privateState?.summaries[entry.id]?.noteText
        .toLowerCase()
        .includes(trimQuery),
    );
  };

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
      {privateState?.enabled ? (
        <Flex
          align={layout === "flyout" ? "stretch" : "center"}
          gap="small"
          justify="space-between"
          vertical={layout === "flyout"}
          wrap
        >
          <Segmented
            onChange={(value) =>
              privateState.onFilterChange(value as DocsPrivateFilter)
            }
            options={[
              { label: "All", value: "all" },
              { label: "Starred", value: "starred" },
              { label: "Unstarred", value: "unstarred" },
              { label: "With notes", value: "notes" },
            ]}
            size="small"
            value={privateState.filter}
          />
          {privateState.toolbar}
        </Flex>
      ) : null}
      {queryIsEmpty ? (
        <Flex gap={layout === "flyout" ? "middle" : "large"} vertical>
          <Space align="baseline" wrap>
            <Title level={layout === "flyout" ? 4 : 2} style={{ margin: 0 }}>
              All documentation pages
            </Title>
            <Text type="secondary">
              {entries.length} page{entries.length === 1 ? "" : "s"} in{" "}
              {groupedEntries.length} categor
              {groupedEntries.length === 1 ? "y" : "ies"}
            </Text>
          </Space>
          <Row gutter={[16, 16]}>
            {groupedEntries.map(({ category, entries: categoryEntries }) => (
              <Col
                key={category}
                lg={layout === "flyout" ? 24 : 8}
                md={12}
                xs={24}
              >
                <Card
                  size="small"
                  style={DOCS_BROWSER_CATEGORY_CARD_STYLE}
                  styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
                  title={
                    <Space>
                      <BookOutlined />
                      <span>{category}</span>
                      <Text type="secondary">({categoryEntries.length})</Text>
                    </Space>
                  }
                >
                  <Flex gap={8} vertical>
                    {categoryEntries.map((entry) => (
                      <DocsCard
                        entry={entry}
                        key={entry.id}
                        href={linkForEntry?.(entry)}
                        onSelect={onSelectEntry}
                        privateNoteMatched={privateNoteMatched(entry)}
                        privateSummary={privateState?.summaries[entry.id]}
                      />
                    ))}
                  </Flex>
                </Card>
              </Col>
            ))}
          </Row>
        </Flex>
      ) : layout === "flyout" ? (
        <Flex gap={10} vertical>
          {entries.map((entry) => (
            <DocsCard
              entry={entry}
              key={entry.id}
              layout={layout}
              href={linkForEntry?.(entry)}
              onSelect={onSelectEntry}
              privateNoteMatched={privateNoteMatched(entry)}
              privateSummary={privateState?.summaries[entry.id]}
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
                privateNoteMatched={privateNoteMatched(entry)}
                privateSummary={privateState?.summaries[entry.id]}
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

  return (
    <Card
      style={DOCS_BROWSER_CARD_STYLE}
      styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
    >
      {content}
    </Card>
  );
}

function DocsLinearNavigation({
  layout = "page",
  navigation,
}: {
  layout?: DocsBrowserLayout;
  navigation?: DocsLinearNavigationState;
}) {
  if (navigation == null || navigation.count <= 1) return null;

  const isFlyout = layout === "flyout";
  const nextEntry = navigation.next ?? navigation.nextChapter;
  const nextLabel = navigation.next ? "Next" : "Next Chapter";
  const content = (
    <Flex
      align={isFlyout ? "stretch" : "center"}
      gap="small"
      justify="space-between"
      vertical={isFlyout}
      wrap
    >
      <Space size={[6, 4]} wrap>
        <BookOutlined style={{ color: COLORS.BLUE }} />
        <Text type="secondary">
          Page {navigation.currentIndex + 1} of {navigation.count} in{" "}
          {navigation.entry.category}
        </Text>
      </Space>
      <Space.Compact block={isFlyout}>
        <Button
          disabled={navigation.previous == null}
          icon={<ArrowLeftOutlined />}
          onClick={() => {
            if (navigation.previous != null) {
              navigation.onSelectEntry(navigation.previous);
            }
          }}
          size={isFlyout ? "small" : "middle"}
          title={
            navigation.previous != null
              ? `Previous: ${navigation.previous.title}`
              : "This is the first page in this section"
          }
        >
          Previous
        </Button>
        <Button
          disabled={nextEntry == null}
          icon={<ArrowRightOutlined />}
          iconPlacement="end"
          onClick={() => {
            if (nextEntry != null) {
              navigation.onSelectEntry(nextEntry);
            }
          }}
          size={isFlyout ? "small" : "middle"}
          title={
            nextEntry != null
              ? `${nextLabel}: ${nextEntry.title}`
              : "This is the last page"
          }
          type="primary"
        >
          {nextLabel}
        </Button>
      </Space.Compact>
    </Flex>
  );

  if (isFlyout) {
    return <div style={DOCS_BROWSER_FLYOUT_ACTIONS_STYLE}>{content}</div>;
  }

  return (
    <Card
      size="small"
      style={DOCS_BROWSER_CARD_STYLE}
      styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
    >
      {content}
    </Card>
  );
}

export function DocsDetailContent({
  actionAvailability,
  entry,
  linearNavigation,
  layout = "page",
  onBack,
  onRunAction,
  privateState,
}: {
  actionAvailability?: Map<string, DocsBrowserAction>;
  entry: DocsEntry;
  linearNavigation?: DocsLinearNavigationState;
  layout?: DocsBrowserLayout;
  onBack?: () => void;
  onRunAction?: (action: DocsBrowserAction) => void | Promise<void>;
  privateState?: DocsPrivateDetailState;
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
        <DocsLinearNavigation layout={layout} navigation={linearNavigation} />
        {privateState?.renderPanel(entry)}
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
      <Card
        style={DOCS_BROWSER_CARD_STYLE}
        styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
      >
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
      <DocsLinearNavigation layout={layout} navigation={linearNavigation} />
      {privateState?.renderPanel(entry)}
      <DocsActions
        actions={actions}
        layout={layout}
        onRunAction={onRunAction}
      />
      <Card
        style={DOCS_BROWSER_CARD_STYLE}
        styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
      >
        <DocsMarkdown value={entry.body} />
      </Card>
      <DocsLinearNavigation layout={layout} navigation={linearNavigation} />
    </Flex>
  );
}

export function DocsBrowser({
  actionAvailability,
  docsAccess,
  initialEntry,
  layout = "page",
  onRunAction,
  onSelectedEntryChange,
  privateDetailState,
  privateIndexState,
}: {
  actionAvailability?: DocsBrowserAction[];
  docsAccess?: DocsAccess;
  initialEntry?: DocsEntry;
  layout?: DocsBrowserLayout;
  onRunAction?: (action: DocsBrowserAction) => void | Promise<void>;
  onSelectedEntryChange?: (entry?: DocsEntry) => void;
  privateDetailState?: DocsPrivateDetailState;
  privateIndexState?: DocsPrivateIndexState;
}) {
  const [selectedEntry, setSelectedEntry] = useState<DocsEntry | undefined>(
    initialEntry,
  );
  useEffect(() => {
    setSelectedEntry(initialEntry);
  }, [initialEntry]);
  const actionMap = useMemo(
    () =>
      new Map<string, DocsBrowserAction>(
        actionAvailability?.map((action) => [action.id, action]) ?? [],
      ),
    [actionAvailability],
  );
  const allEntries = useMemo(() => listDocsEntries(docsAccess), [docsAccess]);
  const selectEntry = useCallback(
    (entry?: DocsEntry) => {
      setSelectedEntry(entry);
      onSelectedEntryChange?.(entry);
    },
    [onSelectedEntryChange],
  );

  if (selectedEntry != null) {
    const selectedGlobalIndex = allEntries.findIndex(
      (entry) => entry.id === selectedEntry.id,
    );
    const categoryEntries = allEntries.filter(
      (entry) => entry.category === selectedEntry.category,
    );
    const currentIndex = categoryEntries.findIndex(
      (entry) => entry.id === selectedEntry.id,
    );
    const linearNavigation =
      currentIndex >= 0
        ? {
            count: categoryEntries.length,
            currentIndex,
            entry: selectedEntry,
            next: categoryEntries[currentIndex + 1],
            nextChapter: allEntries
              .slice(selectedGlobalIndex + 1)
              .find((entry) => entry.category !== selectedEntry.category),
            onSelectEntry: selectEntry,
            previous: categoryEntries[currentIndex - 1],
          }
        : undefined;
    return (
      <DocsDetailContent
        actionAvailability={actionMap}
        entry={selectedEntry}
        linearNavigation={linearNavigation}
        layout={layout}
        onBack={() => selectEntry(undefined)}
        onRunAction={onRunAction}
        privateState={privateDetailState}
      />
    );
  }

  return (
    <DocsIndexContent
      docsAccess={docsAccess}
      layout={layout}
      onSelectEntry={selectEntry}
      privateState={privateIndexState}
    />
  );
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

const DOCS_BROWSER_PAGE_ITEM_STYLE: React.CSSProperties = {
  ...DOCS_BROWSER_FLYOUT_ITEM_STYLE,
  boxShadow: "none",
  padding: 10,
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
