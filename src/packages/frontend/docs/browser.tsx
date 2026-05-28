/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import {
  ArrowRightOutlined,
  BookOutlined,
  CheckCircleFilled,
  DownloadOutlined,
  SearchOutlined,
  ToolOutlined,
  ArrowLeftOutlined,
  PrinterOutlined,
} from "@ant-design/icons";
import {
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Input,
  Progress,
  Row,
  Segmented,
  Select,
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
import type { Host } from "@cocalc/conat/hub/api/hosts";
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
const DOCS_BROWSER_TOC_LINK_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  cursor: "pointer",
  display: "block",
  font: "inherit",
  lineHeight: 1.35,
  margin: 0,
  padding: "2px 0",
  textAlign: "left",
  textDecoration: "none",
  width: "100%",
};

function docsBrowserTocLinkStyle(viewed: boolean): CSSProperties {
  return {
    ...DOCS_BROWSER_TOC_LINK_STYLE,
    color: viewed ? COLORS.GRAY_M : COLORS.BLUE_DOC,
  };
}
export const DOCS_FONT_SIZE_MIN = 10;
export const DOCS_FONT_SIZE_MAX = 32;
export const DOCS_FONT_SIZE_STEP = 1;

export type DocsBrowserAction = DocsAction & {
  available?: boolean;
  implemented?: boolean;
  reason?: string;
};

export type DocsBrowserActionParameters = Record<string, string | undefined>;

export type DocsPrivateIndexState = {
  enabled: boolean;
  filter: DocsPrivateFilter;
  summaries: Record<string, DocsPrivateEntrySummary>;
  toolbar?: React.ReactNode;
  onFilterChange: (filter: DocsPrivateFilter) => void;
};

export type DocsPrivateDetailState = {
  renderPanel: (entry: DocsEntry) => React.ReactNode;
  renderLearnedControl?: (entry: DocsEntry) => React.ReactNode;
};

type DocsLinearNavigationState = {
  count: number;
  currentIndex: number;
  entry: DocsEntry;
  next?: DocsEntry;
  nextChapter?: DocsEntry;
  onSelectEntry: (entry: DocsEntry) => void;
  previous?: DocsEntry;
  previousChapter?: DocsEntry;
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
  showControls = true,
}: {
  children: React.ReactNode;
  defaultFontSize?: number;
  layout?: DocsBrowserLayout;
  showControls?: boolean;
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
      {showControls ? (
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
      ) : null}
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
            {privateSummary?.learnedAt ? (
              <Tag color="green" icon={<CheckCircleFilled />}>
                Learned
              </Tag>
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
            {privateSummary?.learnedAt ? (
              <Tag color="green" icon={<CheckCircleFilled />}>
                Learned
              </Tag>
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

function DocsTocOverview({
  groupedEntries,
  layout = "page",
  linkForEntry,
  onDownloadHtml,
  onPrint,
  onSelectEntry,
  printHref,
  privateSummaries,
}: {
  groupedEntries: { category: string; entries: DocsEntry[] }[];
  layout?: DocsBrowserLayout;
  linkForEntry?: (entry: DocsEntry) => string;
  onDownloadHtml?: () => void | Promise<void>;
  onPrint?: () => void;
  onSelectEntry?: (entry: DocsEntry) => void;
  printHref?: string;
  privateSummaries?: Record<string, DocsPrivateEntrySummary>;
}) {
  if (groupedEntries.length === 0) return null;

  const allEntries = groupedEntries.flatMap(({ entries }) => entries);
  const firstUnlearnedEntry = allEntries.find(
    (entry) => privateSummaries?.[entry.id]?.learnedAt == null,
  );
  const lastLearnedEntry = allEntries
    .filter((entry) => privateSummaries?.[entry.id]?.learnedAt != null)
    .sort(
      (a, b) =>
        (privateSummaries?.[b.id]?.learnedAt ?? 0) -
        (privateSummaries?.[a.id]?.learnedAt ?? 0),
    )[0];
  const continueEntry =
    firstUnlearnedEntry ?? lastLearnedEntry ?? allEntries[0];
  const continueLabel =
    firstUnlearnedEntry != null ? "Continue learning" : "Review learned";
  const continueHref =
    continueEntry != null ? linkForEntry?.(continueEntry) : undefined;

  return (
    <Card
      size="small"
      style={DOCS_BROWSER_CARD_STYLE}
      styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
      title={
        <Flex align="center" gap="small" justify="space-between" wrap>
          <Space>
            <BookOutlined />
            <span>Table of contents</span>
          </Space>
          <Space wrap>
            {continueEntry != null ? (
              <Button
                href={continueHref}
                onClick={
                  continueHref == null
                    ? () => onSelectEntry?.(continueEntry)
                    : undefined
                }
                size="small"
                type="primary"
              >
                {continueLabel}
              </Button>
            ) : null}
            {printHref != null || onPrint != null ? (
              <Button
                href={onPrint == null ? printHref : undefined}
                icon={<PrinterOutlined />}
                onClick={onPrint}
                size="small"
              >
                Print-friendly
              </Button>
            ) : null}
            {onDownloadHtml != null ? (
              <Button
                icon={<DownloadOutlined />}
                onClick={onDownloadHtml}
                size="small"
              >
                Download HTML
              </Button>
            ) : null}
          </Space>
        </Flex>
      }
    >
      <Row gutter={[18, 18]}>
        {groupedEntries.map(({ category, entries }) => (
          <Col key={category} lg={layout === "flyout" ? 24 : 8} md={12} xs={24}>
            <Flex gap={6} vertical>
              <Space size={6} wrap>
                <Text strong>{category}</Text>
                <Text type="secondary">({entries.length})</Text>
                {privateSummaries != null ? (
                  <Text type="secondary">
                    {
                      entries.filter(
                        (entry) =>
                          privateSummaries[entry.id]?.learnedAt != null,
                      ).length
                    }{" "}
                    / {entries.length} learned
                  </Text>
                ) : null}
              </Space>
              {privateSummaries != null ? (
                <Progress
                  percent={Math.round(
                    (100 *
                      entries.filter(
                        (entry) =>
                          privateSummaries[entry.id]?.learnedAt != null,
                      ).length) /
                      entries.length,
                  )}
                  showInfo={false}
                  size="small"
                />
              ) : null}
              <Flex gap={2} vertical>
                {entries.map((entry, index) => {
                  const viewed =
                    privateSummaries?.[entry.id]?.lastViewedAt != null;
                  const learned =
                    privateSummaries?.[entry.id]?.learnedAt != null;
                  const content = (
                    <>
                      <Text
                        type="secondary"
                        style={{ display: "inline-block", width: "2.2em" }}
                      >
                        {index + 1}.
                      </Text>
                      <span>{entry.title}</span>
                      {learned ? (
                        <CheckCircleFilled
                          style={{
                            color: COLORS.BS_GREEN_D,
                            marginLeft: 6,
                          }}
                        />
                      ) : null}
                    </>
                  );
                  const href = linkForEntry?.(entry);
                  if (href != null) {
                    return (
                      <a
                        href={href}
                        key={entry.id}
                        style={docsBrowserTocLinkStyle(viewed)}
                      >
                        {content}
                      </a>
                    );
                  }
                  return (
                    <button
                      key={entry.id}
                      onClick={() => onSelectEntry?.(entry)}
                      style={docsBrowserTocLinkStyle(viewed)}
                      type="button"
                    >
                      {content}
                    </button>
                  );
                })}
              </Flex>
            </Flex>
          </Col>
        ))}
      </Row>
    </Card>
  );
}

export function DocsIndexContent({
  docsAccess,
  layout = "page",
  linkForEntry,
  onDownloadHtml,
  onPrint,
  onSelectEntry,
  printHref,
  privateState,
}: {
  docsAccess?: DocsAccess;
  layout?: DocsBrowserLayout;
  linkForEntry?: (entry: DocsEntry) => string;
  onDownloadHtml?: () => void | Promise<void>;
  onPrint?: () => void;
  onSelectEntry?: (entry: DocsEntry) => void;
  printHref?: string;
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
        case "learned":
          return summary?.learnedAt != null;
        case "unlearned":
          return summary?.learnedAt == null;
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
              { label: "Learned", value: "learned" },
              { label: "Unlearned", value: "unlearned" },
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
          <DocsTocOverview
            groupedEntries={groupedEntries}
            layout={layout}
            linkForEntry={linkForEntry}
            onDownloadHtml={onDownloadHtml}
            onPrint={onPrint}
            onSelectEntry={onSelectEntry}
            printHref={printHref}
            privateSummaries={privateState?.summaries}
          />
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

function formatProjectHostOption(host: Host): { label: string; value: string } {
  const region = `${host.region ?? ""}`.trim();
  return {
    label: region ? `${host.name} (${region})` : host.name,
    value: host.id,
  };
}

function useProjectHostParameterOptions(enabled: boolean): {
  error?: string;
  loading: boolean;
  options: { label: string; value: string }[];
} {
  const [options, setOptions] = useState<{ label: string; value: string }[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    setLoading(true);
    setError(undefined);
    import("@cocalc/frontend/webapp-client")
      .then(({ webapp_client }) =>
        webapp_client.conat_client.hub.hosts.listHosts({ show_all: true }),
      )
      .then((hosts: Host[]) => {
        if (canceled) return;
        setOptions(hosts.map(formatProjectHostOption));
      })
      .catch((err) => {
        if (canceled) return;
        setError(err instanceof Error ? err.message : `${err}`);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [enabled]);

  return { error, loading, options };
}

function useProjectParameterOptions(enabled: boolean): {
  options: { label: string; value: string }[];
} {
  const [options, setOptions] = useState<{ label: string; value: string }[]>(
    [],
  );
  useEffect(() => {
    let canceled = false;
    let cleanup: (() => void) | undefined;
    if (!enabled) {
      setOptions([]);
      return;
    }
    void import("@cocalc/frontend/app-framework").then(({ redux }) => {
      if (canceled) return;
      const store = redux.getStore("projects");
      if (store == null) {
        setOptions([]);
        return;
      }
      const readOptions = () => {
        const projectMap = store.get("project_map");
        if (projectMap == null) return [];
        const values: { label: string; title: string; value: string }[] = [];
        for (const [projectId, project] of projectMap) {
          const title = `${project?.get?.("title") ?? "No Title"}`.trim();
          const state = `${project?.getIn?.(["state", "state"]) ?? ""}`.trim();
          values.push({
            label: state
              ? `${title || "No Title"} (${state})`
              : title || "No Title",
            title: title || "No Title",
            value: projectId,
          });
        }
        values.sort((a, b) => a.title.localeCompare(b.title));
        return values.map(({ label, value }) => ({ label, value }));
      };
      const updateOptions = () => setOptions(readOptions());
      store.on("change", updateOptions);
      updateOptions();
      cleanup = () => store.removeListener("change", updateOptions);
    });
    return () => {
      canceled = true;
      cleanup?.();
    };
  }, [enabled]);
  return { options };
}

export function DocsActions({
  actions,
  defaultActionParameters,
  layout = "page",
  onRunAction,
}: {
  actions?: DocsBrowserAction[];
  defaultActionParameters?: DocsBrowserActionParameters;
  layout?: DocsBrowserLayout;
  onRunAction?: (
    action: DocsBrowserAction,
    parameters?: DocsBrowserActionParameters,
  ) => void | Promise<void>;
}) {
  const visibleActions = actions ?? [];
  const needsProjectHostSelector =
    onRunAction != null &&
    visibleActions.some((action) =>
      action.parameters?.some((parameter) => parameter.type === "project-host"),
    );
  const needsProjectSelector =
    onRunAction != null &&
    visibleActions.some((action) =>
      action.parameters?.some((parameter) => parameter.type === "project"),
    );
  const hostOptions = useProjectHostParameterOptions(needsProjectHostSelector);
  const projectOptions = useProjectParameterOptions(needsProjectSelector);
  const [parameterValues, setParameterValues] = useState<
    Record<string, DocsBrowserActionParameters>
  >({});

  if (!visibleActions.length) return null;

  const setActionParameter = (
    action: DocsBrowserAction,
    name: string,
    value: string | undefined,
  ) => {
    setParameterValues((current) => ({
      ...current,
      [action.id]: {
        ...(current[action.id] ?? {}),
        [name]: value,
      },
    }));
  };

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
        {visibleActions.map((action) => {
          const state = actionState(action);
          const values = {
            ...(defaultActionParameters ?? {}),
            ...(parameterValues[action.id] ?? {}),
          };
          const hasParameters = !!action.parameters?.length;
          const missingRequiredParameter = action.parameters?.some(
            (parameter) => parameter.required && !values[parameter.name],
          );
          return (
            <Space.Compact
              block={layout === "flyout"}
              key={action.id}
              style={layout === "flyout" ? { width: "100%" } : undefined}
            >
              {action.parameters?.map((parameter) =>
                parameter.type === "project-host" ? (
                  <Select
                    allowClear
                    disabled={state.disabled || onRunAction == null}
                    key={parameter.name}
                    loading={hostOptions.loading}
                    notFoundContent={
                      hostOptions.error ??
                      (hostOptions.loading ? "Loading hosts..." : "No hosts")
                    }
                    onChange={(value) =>
                      setActionParameter(action, parameter.name, value)
                    }
                    optionFilterProp="label"
                    options={hostOptions.options}
                    placeholder={parameter.placeholder ?? parameter.label}
                    showSearch
                    size={layout === "flyout" ? "small" : "middle"}
                    style={{
                      minWidth: layout === "flyout" ? 0 : 220,
                      width: layout === "flyout" ? "60%" : 240,
                    }}
                    value={values[parameter.name]}
                  />
                ) : parameter.type === "project" ? (
                  <Select
                    allowClear
                    disabled={state.disabled || onRunAction == null}
                    key={parameter.name}
                    notFoundContent="No projects"
                    onChange={(value) =>
                      setActionParameter(action, parameter.name, value)
                    }
                    optionFilterProp="label"
                    options={projectOptions.options}
                    placeholder={parameter.placeholder ?? parameter.label}
                    showSearch
                    size={layout === "flyout" ? "small" : "middle"}
                    style={{
                      minWidth: layout === "flyout" ? 0 : 220,
                      width: layout === "flyout" ? "60%" : 240,
                    }}
                    value={values[parameter.name]}
                  />
                ) : null,
              )}
              <Button
                block={layout === "flyout" && !hasParameters}
                data-cocalc-action-id={action.id}
                disabled={
                  state.disabled ||
                  onRunAction == null ||
                  missingRequiredParameter
                }
                onClick={() => void onRunAction?.(action, values)}
                size={layout === "flyout" ? "small" : "middle"}
                title={action.reason ?? action.description}
                type={
                  !state.disabled && onRunAction != null ? "primary" : "default"
                }
              >
                {state.buttonText}
              </Button>
            </Space.Compact>
          );
        })}
      </Space>
      {layout === "page" ? (
        <Space wrap>
          {visibleActions.map((action) => {
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
  const previousEntry = navigation.previous ?? navigation.previousChapter;
  const previousLabel = navigation.previous ? "Previous" : "Previous Chapter";
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
          disabled={previousEntry == null}
          icon={<ArrowLeftOutlined />}
          onClick={() => {
            if (previousEntry != null) {
              navigation.onSelectEntry(previousEntry);
            }
          }}
          size={isFlyout ? "small" : "middle"}
          title={
            previousEntry != null
              ? `${previousLabel}: ${previousEntry.title}`
              : "This is the first page in this section"
          }
        >
          {previousLabel}
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
  defaultActionParameters,
  entry,
  linearNavigation,
  layout = "page",
  onBack,
  onRunAction,
  privateState,
}: {
  actionAvailability?: Map<string, DocsBrowserAction>;
  defaultActionParameters?: DocsBrowserActionParameters;
  entry: DocsEntry;
  linearNavigation?: DocsLinearNavigationState;
  layout?: DocsBrowserLayout;
  onBack?: () => void;
  onRunAction?: (
    action: DocsBrowserAction,
    parameters?: DocsBrowserActionParameters,
  ) => void | Promise<void>;
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
          defaultActionParameters={defaultActionParameters}
          layout={layout}
          onRunAction={onRunAction}
        />
        <div style={DOCS_BROWSER_FLYOUT_MARKDOWN_STYLE}>
          <DocsMarkdown value={entry.body} />
        </div>
        {privateState?.renderLearnedControl?.(entry)}
        <DocsLinearNavigation layout={layout} navigation={linearNavigation} />
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
        defaultActionParameters={defaultActionParameters}
        layout={layout}
        onRunAction={onRunAction}
      />
      <Card
        style={DOCS_BROWSER_CARD_STYLE}
        styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
      >
        <DocsMarkdown value={entry.body} />
      </Card>
      {privateState?.renderLearnedControl?.(entry)}
      <DocsLinearNavigation layout={layout} navigation={linearNavigation} />
    </Flex>
  );
}

export function DocsPrintContent({
  downloadHtmlButtonId,
  downloadHtmlBusy,
  docsAccess,
  onDownloadHtml,
  onBackHref,
  printButtonId,
  showControls = true,
}: {
  downloadHtmlButtonId?: string;
  downloadHtmlBusy?: boolean;
  docsAccess?: DocsAccess;
  onDownloadHtml?: () => void | Promise<void>;
  onBackHref?: string;
  printButtonId?: string;
  showControls?: boolean;
}) {
  const entries = useMemo(() => listDocsEntries(docsAccess), [docsAccess]);
  const groupedEntries = useMemo(
    () => groupDocsEntriesByCategory(entries),
    [entries],
  );

  return (
    <div className="cocalc-docs-print-page">
      <style>
        {`
          .cocalc-docs-print-page {
            box-sizing: border-box;
            margin: 0 auto;
            max-width: 980px;
            overflow-wrap: anywhere;
            width: 100%;
          }
          .cocalc-docs-print-page *,
          .cocalc-docs-print-page *::before,
          .cocalc-docs-print-page *::after {
            box-sizing: border-box;
          }
          .cocalc-docs-print-page img {
            height: auto;
            max-width: 100%;
          }
          .cocalc-docs-print-page pre,
          .cocalc-docs-print-page code {
            max-width: 100%;
            white-space: pre-wrap;
            word-break: break-word;
          }
          .cocalc-docs-print-page pre,
          .cocalc-docs-print-page table {
            overflow-x: auto;
          }
          .cocalc-docs-print-page table {
            display: block;
            max-width: 100%;
          }
          .cocalc-docs-print-page .ant-card {
            max-width: 100%;
            overflow: hidden;
          }
          .cocalc-docs-print-page .ant-row {
            display: flex;
            flex-wrap: wrap;
            gap: 18px 0;
            margin-left: 0 !important;
            margin-right: 0 !important;
          }
          .cocalc-docs-print-page .ant-col {
            flex: 1 1 260px;
            max-width: 100%;
            padding-left: 9px;
            padding-right: 9px;
          }
          @media screen and (max-width: 640px) {
            .cocalc-docs-print-page {
              max-width: none;
            }
            .cocalc-docs-print-page h1 {
              font-size: 1.75rem !important;
              line-height: 1.15 !important;
            }
            .cocalc-docs-print-page h2 {
              font-size: 1.35rem !important;
              line-height: 1.2 !important;
            }
            .cocalc-docs-print-page .ant-card-body {
              padding: 14px !important;
            }
            .cocalc-docs-print-page .ant-col {
              flex-basis: 100%;
              padding-left: 0 !important;
              padding-right: 0 !important;
            }
            .cocalc-docs-print-controls {
              align-items: stretch !important;
              flex-direction: column !important;
            }
            .cocalc-docs-print-controls .ant-space,
            .cocalc-docs-print-controls a,
            .cocalc-docs-print-controls button {
              width: 100%;
            }
          }
          @media print {
            .cocalc-docs-print-controls {
              display: none !important;
            }
            .cocalc-docs-print-page {
              color: black;
              max-width: none !important;
            }
            .cocalc-docs-print-entry {
              break-before: page;
              page-break-before: always;
            }
            .cocalc-docs-print-entry:first-of-type {
              break-before: auto;
              page-break-before: auto;
            }
          }
        `}
      </style>
      {showControls ? (
        <Flex
          className="cocalc-docs-print-controls"
          gap="small"
          justify="space-between"
          style={{ marginBottom: 24 }}
          wrap
        >
          <Button href={onBackHref} icon={<ArrowLeftOutlined />}>
            Back to docs
          </Button>
          <Space wrap>
            {onDownloadHtml != null || downloadHtmlButtonId != null ? (
              <Button
                icon={<DownloadOutlined />}
                id={downloadHtmlButtonId}
                loading={downloadHtmlBusy}
                onClick={onDownloadHtml}
              >
                Download HTML
              </Button>
            ) : null}
            <Button
              icon={<PrinterOutlined />}
              id={printButtonId}
              onClick={() => window.print()}
              type="primary"
            >
              Print
            </Button>
          </Space>
        </Flex>
      ) : null}
      <Flex gap="large" vertical>
        <div>
          <Text strong style={DOCS_BROWSER_MUTED_TITLE_STYLE}>
            CoCalc docs
          </Text>
          <Title style={{ marginBottom: 8 }}>Complete documentation</Title>
          <Text type="secondary">
            {entries.length} page{entries.length === 1 ? "" : "s"} in{" "}
            {groupedEntries.length} chapter
            {groupedEntries.length === 1 ? "" : "s"}
          </Text>
        </div>
        <Card
          size="small"
          style={DOCS_BROWSER_CARD_STYLE}
          styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
        >
          <Title level={2}>Table of contents</Title>
          <Row gutter={[18, 18]}>
            {groupedEntries.map(({ category, entries: categoryEntries }) => (
              <Col key={category} lg={8} md={12} xs={24}>
                <Flex gap={4} vertical>
                  <Text strong>{category}</Text>
                  {categoryEntries.map((entry, index) => (
                    <a href={`#${entry.id}`} key={entry.id}>
                      {index + 1}. {entry.title}
                    </a>
                  ))}
                </Flex>
              </Col>
            ))}
          </Row>
        </Card>
        {groupedEntries.map(({ category, entries: categoryEntries }) => (
          <section key={category}>
            <Title level={2}>{category}</Title>
            <Flex gap="large" vertical>
              {categoryEntries.map((entry, index) => (
                <article
                  className="cocalc-docs-print-entry"
                  id={entry.id}
                  key={entry.id}
                >
                  <Card
                    style={DOCS_BROWSER_CARD_STYLE}
                    styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
                  >
                    <Flex gap="middle" vertical>
                      <Space wrap>
                        <Tag>{category}</Tag>
                        <Text type="secondary">
                          Page {index + 1} of {categoryEntries.length}
                        </Text>
                        <Text type="secondary">
                          Reviewed {entry.lastReviewed}
                        </Text>
                      </Space>
                      <Title level={2} style={{ margin: 0 }}>
                        {entry.title}
                      </Title>
                      <Paragraph style={{ fontSize: "1.125em", margin: 0 }}>
                        {entry.summary}
                      </Paragraph>
                      <DocsEntryImage entry={entry} mode="detail" />
                    </Flex>
                  </Card>
                  <Card
                    style={{ ...DOCS_BROWSER_CARD_STYLE, marginTop: 12 }}
                    styles={{ body: DOCS_BROWSER_CARD_BODY_STYLE }}
                  >
                    <DocsMarkdown value={entry.body} />
                  </Card>
                </article>
              ))}
            </Flex>
          </section>
        ))}
      </Flex>
    </div>
  );
}

export function DocsBrowser({
  actionAvailability,
  browserHref,
  defaultActionParameters,
  docsAccess,
  initialEntry,
  layout = "page",
  onDownloadHtml,
  onPrint,
  onRunAction,
  onSelectedEntryChange,
  printHref,
  printMode = false,
  privateDetailState,
  privateIndexState,
}: {
  actionAvailability?: DocsBrowserAction[];
  browserHref?: string;
  defaultActionParameters?: DocsBrowserActionParameters;
  docsAccess?: DocsAccess;
  initialEntry?: DocsEntry;
  layout?: DocsBrowserLayout;
  onDownloadHtml?: () => void | Promise<void>;
  onPrint?: () => void;
  onRunAction?: (
    action: DocsBrowserAction,
    parameters?: DocsBrowserActionParameters,
  ) => void | Promise<void>;
  onSelectedEntryChange?: (entry?: DocsEntry) => void;
  printHref?: string;
  printMode?: boolean;
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

  if (printMode) {
    return (
      <DocsPrintContent
        docsAccess={docsAccess}
        onBackHref={browserHref}
        onDownloadHtml={onDownloadHtml}
      />
    );
  }

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
            previousChapter: allEntries
              .slice(0, selectedGlobalIndex)
              .reverse()
              .find((entry) => entry.category !== selectedEntry.category),
          }
        : undefined;
    return (
      <DocsDetailContent
        actionAvailability={actionMap}
        defaultActionParameters={defaultActionParameters}
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
      onDownloadHtml={onDownloadHtml}
      onPrint={onPrint}
      onSelectEntry={selectEntry}
      printHref={printHref}
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
