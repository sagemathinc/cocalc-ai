/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Input, Modal, Select, Space, Tooltip } from "antd";
import {
  React,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { debounce } from "lodash";
import { ColorButton } from "@cocalc/frontend/components/color-picker";
import { lite } from "@cocalc/frontend/lite";
import { COLORS } from "@cocalc/util/theme";
import {
  DEFAULT_CODEX_MODELS,
  resolveCodexSessionMode,
  type CodexReasoningLevel,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
import type { CodexThreadConfig } from "@cocalc/chat";
import { ChatLog } from "./chat-log";
import CodexConfigButton from "./codex";
import { ThreadBadge } from "./thread-badge";
import type { ChatActions } from "./actions";
import type { ChatMessages } from "./types";
import type * as immutable from "immutable";
import type { ThreadIndexEntry } from "./message-cache";
import type { ThreadListItem, ThreadMeta } from "./threads";
import { dateValue } from "./access";
import { newest_content } from "./utils";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import type {
  ChatStoreArchivedRow,
  ChatStoreSearchHit,
} from "@cocalc/conat/hub/api/projects";
import { ChatIconPicker } from "./chat-icon-picker";
import { Icon } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const CHAT_LOG_STYLE: React.CSSProperties = {
  padding: "0",
  background: "white",
  flex: "1 1 0",
  minHeight: 0,
  position: "relative",
} as const;

const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_MODELS[0]?.name ?? "gpt-5.3-codex";
const DEFAULT_CODEX_SESSION_MODE: CodexSessionMode = lite
  ? "read-only"
  : "workspace-write";
const ARCHIVED_SEARCH_LIMIT = 20;
const ARCHIVED_HISTORY_LIMIT = 50;
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODE_OPTIONS: { value: CodexSessionMode; label: string }[] = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "full-access", label: "Full access" },
];

export type NewThreadAgentMode = "codex" | "human" | "model";
export interface NewThreadSetup {
  title: string;
  icon?: string;
  color?: string;
  image?: string;
  agentMode: NewThreadAgentMode;
  model: string;
  codexConfig: Partial<CodexThreadConfig>;
}

export const DEFAULT_NEW_THREAD_SETUP: NewThreadSetup = {
  title: "",
  icon: undefined,
  color: undefined,
  image: "",
  agentMode: "codex",
  model: DEFAULT_CODEX_MODEL,
  codexConfig: {
    model: DEFAULT_CODEX_MODEL,
    sessionMode: DEFAULT_CODEX_SESSION_MODE,
    reasoning: getReasoningForModel({ modelValue: DEFAULT_CODEX_MODEL }),
  },
};

interface ChatRoomThreadPanelProps {
  actions: ChatActions;
  project_id?: string;
  path?: string;
  messages: ChatMessages;
  threadIndex?: Map<string, ThreadIndexEntry>;
  acpState: immutable.Map<string, string>;
  scrollToBottomRef: React.MutableRefObject<any>;
  scrollCacheId: string;
  fontSize?: number;
  selectedThreadKey: string | null;
  selectedThread?: ThreadMeta | ThreadListItem;
  variant: "compact" | "default";
  scrollToIndex: number | null;
  scrollToDate: string | null;
  fragmentId: string | null;
  threadsCount: number;
  onNewChat: () => void;
  composerTargetKey?: string | null;
  composerFocused?: boolean;
  codexPaymentSource?: CodexPaymentSourceInfo;
  codexPaymentSourceLoading?: boolean;
  refreshCodexPaymentSource?: () => void;
  newThreadSetup: NewThreadSetup;
  onNewThreadSetupChange: (next: NewThreadSetup) => void;
  showThreadImagePreview?: boolean;
  hideChatTypeSelector?: boolean;
}

export function ChatRoomThreadPanel({
  actions,
  project_id,
  path,
  messages,
  threadIndex,
  acpState,
  scrollToBottomRef,
  scrollCacheId,
  fontSize,
  selectedThreadKey,
  selectedThread,
  variant,
  scrollToIndex,
  scrollToDate,
  fragmentId,
  threadsCount,
  onNewChat,
  composerTargetKey,
  composerFocused,
  codexPaymentSource,
  codexPaymentSourceLoading,
  refreshCodexPaymentSource,
  newThreadSetup,
  onNewThreadSetupChange,
  showThreadImagePreview = true,
  hideChatTypeSelector = false,
}: ChatRoomThreadPanelProps) {
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadSearchInput, setThreadSearchInput] = useState("");
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [threadSearchCursor, setThreadSearchCursor] = useState(0);
  const [threadSearchJumpToken, setThreadSearchJumpToken] = useState(0);
  const [archivedSearchLoading, setArchivedSearchLoading] = useState(false);
  const [archivedSearchHits, setArchivedSearchHits] = useState<ChatStoreSearchHit[]>(
    [],
  );
  const [archivedSearchError, setArchivedSearchError] = useState("");
  const [archivedHistoryOpen, setArchivedHistoryOpen] = useState(false);
  const [archivedHistoryLoading, setArchivedHistoryLoading] = useState(false);
  const [archivedHistoryRows, setArchivedHistoryRows] = useState<ChatStoreArchivedRow[]>(
    [],
  );
  const [archivedHistoryError, setArchivedHistoryError] = useState("");
  const [archivedHistoryNextOffset, setArchivedHistoryNextOffset] = useState<
    number | undefined
  >(undefined);
  const searchInputRef = useRef<any>(null);
  const selectedThreadId = useMemo(() => {
    if (selectedThreadKey && UUID_RX.test(selectedThreadKey)) {
      return selectedThreadKey;
    }
    return undefined;
  }, [selectedThreadKey]);
  const selectedThreadMeta = useMemo(
    () =>
      selectedThreadId
        ? actions.getThreadMetadata(selectedThreadId, { threadId: selectedThreadId })
        : undefined,
    [actions, selectedThreadId],
  );
  const archivedRowsCount = useMemo(() => {
    const value = selectedThreadMeta?.archived_chat_rows;
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
  }, [selectedThreadMeta?.archived_chat_rows]);
  const selectedThreadLookup = selectedThreadId;
  const selectedThreadMessages = useMemo(
    () =>
      selectedThreadLookup != null
        ? actions.getMessagesInThread(selectedThreadLookup) ?? []
        : [],
    [actions, selectedThreadLookup, messages],
  );
  const threadSearchMatches = useMemo(() => {
    const needle = threadSearchQuery.trim().toLowerCase();
    if (!needle) return [] as string[];
    const matches: string[] = [];
    for (const message of selectedThreadMessages) {
      const text = newest_content(message)
        .replace(/<[^>]*>/g, " ")
        .toLowerCase();
      if (!text.includes(needle)) continue;
      const d = dateValue(message);
      if (!d) continue;
      matches.push(`${d.valueOf()}`);
    }
    return matches;
  }, [threadSearchQuery, selectedThreadMessages]);
  const matchCount = threadSearchMatches.length;
  const normalizedCursor = useMemo(() => {
    if (!matchCount) return 0;
    const c = threadSearchCursor % matchCount;
    return c >= 0 ? c : c + matchCount;
  }, [threadSearchCursor, matchCount]);
  const activeSearchMatchDate = useMemo(
    () => (matchCount ? threadSearchMatches[normalizedCursor] : undefined),
    [matchCount, normalizedCursor, threadSearchMatches],
  );
  const archivedMatchCount = archivedSearchHits.length;

  const loadArchivedHistory = useCallback(
    async (offset = 0, append = false) => {
      if (!project_id || !path || !selectedThreadId) {
        setArchivedHistoryRows([]);
        setArchivedHistoryNextOffset(undefined);
        return;
      }
      const hubProjects = webapp_client.conat_client?.hub?.projects;
      if (!hubProjects) {
        setArchivedHistoryError("Conat project API is unavailable.");
        setArchivedHistoryRows([]);
        setArchivedHistoryNextOffset(undefined);
        return;
      }
      setArchivedHistoryLoading(true);
      setArchivedHistoryError("");
      try {
        const result = await hubProjects.chatStoreReadArchived({
          project_id,
          chat_path: path,
          thread_id: selectedThreadId,
          limit: ARCHIVED_HISTORY_LIMIT,
          offset,
        });
        setArchivedHistoryRows((prev) =>
          append ? [...prev, ...(result.rows ?? [])] : (result.rows ?? []),
        );
        setArchivedHistoryNextOffset(result.next_offset);
      } catch (err) {
        setArchivedHistoryError(`${err}`);
      } finally {
        setArchivedHistoryLoading(false);
      }
    },
    [project_id, path, selectedThreadId],
  );

  const setSearchQueryDebounced = useMemo(
    () =>
      debounce((value: string) => {
        setThreadSearchQuery(value);
      }, 300),
    [],
  );

  useEffect(() => {
    return () => {
      setSearchQueryDebounced.cancel();
    };
  }, [setSearchQueryDebounced]);

  useEffect(() => {
    setThreadSearchCursor(0);
  }, [threadSearchQuery, selectedThreadKey]);

  useEffect(() => {
    setThreadSearchInput("");
    setThreadSearchQuery("");
    setThreadSearchOpen(false);
    setArchivedSearchHits([]);
    setArchivedSearchError("");
    setArchivedHistoryRows([]);
    setArchivedHistoryError("");
    setArchivedHistoryNextOffset(undefined);
    setArchivedHistoryOpen(false);
  }, [selectedThreadKey]);

  useEffect(() => {
    if (!matchCount) return;
    if (threadSearchCursor >= matchCount) {
      setThreadSearchCursor(matchCount - 1);
    }
  }, [threadSearchCursor, matchCount]);

  useEffect(() => {
    if (!activeSearchMatchDate) return;
    setThreadSearchJumpToken((n) => n + 1);
  }, [activeSearchMatchDate]);

  useEffect(() => {
    const query = threadSearchQuery.trim();
    if (
      !threadSearchOpen ||
      !query ||
      !project_id ||
      !path ||
      !selectedThreadId
    ) {
      setArchivedSearchLoading(false);
      setArchivedSearchHits([]);
      setArchivedSearchError("");
      return;
    }
    let canceled = false;
    setArchivedSearchLoading(true);
    setArchivedSearchError("");
    void (async () => {
      const hubProjects = webapp_client.conat_client?.hub?.projects;
      if (!hubProjects) {
        setArchivedSearchLoading(false);
        setArchivedSearchHits([]);
        setArchivedSearchError("Conat project API is unavailable.");
        return;
      }
      try {
        const result = await hubProjects.chatStoreSearch({
          project_id,
          chat_path: path,
          query,
          thread_id: selectedThreadId,
          limit: ARCHIVED_SEARCH_LIMIT,
          offset: 0,
        });
        if (canceled) return;
        setArchivedSearchHits(result.hits ?? []);
      } catch (err) {
        if (canceled) return;
        setArchivedSearchHits([]);
        setArchivedSearchError(`${err}`);
      } finally {
        if (!canceled) {
          setArchivedSearchLoading(false);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [threadSearchOpen, threadSearchQuery, project_id, path, selectedThreadId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setThreadSearchOpen(true);
      setTimeout(() => {
        searchInputRef.current?.focus?.();
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onSearchInputChange = (value: string) => {
    setThreadSearchInput(value);
    if (!value.trim()) {
      setSearchQueryDebounced.cancel();
      setThreadSearchQuery("");
      return;
    }
    setSearchQueryDebounced(value);
  };
  if (!selectedThreadKey) {
    type ModelOption = {
      value: string;
      label: string;
      description?: string;
      reasoning?: CodexReasoningLevel[];
    };
    const update = (patch: Partial<NewThreadSetup>) =>
      onNewThreadSetupChange({ ...newThreadSetup, ...patch });
    const codexModel = newThreadSetup.codexConfig.model ?? DEFAULT_CODEX_MODEL;
    const codexModelOptions: ModelOption[] = DEFAULT_CODEX_MODELS.map((model) => ({
      value: model.name,
      label: model.name,
      description: model.description,
      reasoning: model.reasoning,
    }));
    const codexReasoningOptions = (
      codexModelOptions.find((model) => model.value === codexModel)?.reasoning ?? []
    ).map((r) => ({
      value: r.id,
      label: r.label,
      description: r.description,
      default: r.default,
    }));
    const shouldHideChatType = hideChatTypeSelector;
    return (
      <div
        className="smc-vfill"
        style={{
          ...CHAT_LOG_STYLE,
          overflowY: "auto",
          padding: "14px 10px",
        }}
      >
        <div
          style={{
            width: "min(840px, 96%)",
            margin: "0 auto",
            padding: "18px 20px",
            border: "1px solid #eee",
            borderRadius: 12,
            background: "#fcfcfc",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>New chat setup</div>
          <div style={{ color: "#666", marginBottom: 14, fontSize: 13 }}>
            All fields are optional and can be edited later from settings.
            Codex is selected by default.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Title</div>
              <Input
                placeholder="Optional title"
                value={newThreadSetup.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </div>
            <div>
              {!shouldHideChatType ? (
                <>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Chat type
                  </div>
                  <Select
                    value={newThreadSetup.agentMode}
                    style={{ width: "100%" }}
                    onChange={(value) => {
                      const mode = value as NewThreadAgentMode;
                      if (mode === "codex") {
                        const model = isCodexModelName(newThreadSetup.model)
                          ? newThreadSetup.model
                          : DEFAULT_CODEX_MODEL;
                        update({
                          agentMode: mode,
                          model,
                          codexConfig: {
                            ...newThreadSetup.codexConfig,
                            model,
                            sessionMode:
                              normalizeSessionMode(newThreadSetup.codexConfig) ??
                              DEFAULT_CODEX_SESSION_MODE,
                            reasoning: getReasoningForModel({
                              modelValue: model,
                              desired: newThreadSetup.codexConfig.reasoning,
                            }),
                          },
                        });
                        return;
                      }
                      update({ agentMode: mode });
                    }}
                    options={[
                      { value: "codex", label: "Codex (agent)" },
                      { value: "human", label: "Human only" },
                    ]}
                  />
                </>
              ) : null}
            </div>
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Icon</div>
              <ChatIconPicker
                value={newThreadSetup.icon}
                onChange={(value) => update({ icon: value ? String(value) : undefined })}
                modalTitle="Select Chat Icon"
                placeholder="Optional icon"
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Color</div>
              <Space>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: newThreadSetup.color ?? COLORS.GRAY_L,
                    border: `1px solid ${COLORS.GRAY_L}`,
                  }}
                />
                <ColorButton
                  onChange={(value) => update({ color: value })}
                  title="Select chat color"
                />
                <Button
                  size="small"
                  onClick={() => update({ color: undefined })}
                >
                  Clear
                </Button>
              </Space>
            </div>
          </div>
          {newThreadSetup.agentMode === "codex" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div>
                <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                  Codex model
                </div>
                <Select
                  value={codexModel}
                  style={{ width: "100%" }}
                  options={codexModelOptions}
                  optionRender={(option) =>
                    renderOptionWithDescription({
                      title: `${option.data.label}`,
                      description: option.data.description,
                    })
                  }
                  showSearch
                  optionFilterProp="label"
                  onChange={(value) => {
                    const model = String(value);
                    update({
                      model,
                      codexConfig: {
                        ...newThreadSetup.codexConfig,
                        model,
                        reasoning: getReasoningForModel({
                          modelValue: model,
                          desired: newThreadSetup.codexConfig.reasoning,
                        }),
                      },
                    });
                  }}
                />
              </div>
              <div>
                <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                  Reasoning
                </div>
                <Select
                  allowClear
                  value={newThreadSetup.codexConfig.reasoning}
                  style={{ width: "100%" }}
                  options={codexReasoningOptions}
                  optionRender={(option) =>
                    renderOptionWithDescription({
                      title: `${option.data.label}${
                        option.data.default ? " (default)" : ""
                      }`,
                      description: option.data.description,
                    })
                  }
                  onChange={(value) =>
                    update({
                      codexConfig: {
                        ...newThreadSetup.codexConfig,
                        reasoning: value as CodexReasoningId,
                      },
                    })
                  }
                />
              </div>
              <div>
                <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                  Execution mode
                </div>
                <Select
                  value={
                    normalizeSessionMode(newThreadSetup.codexConfig) ??
                    DEFAULT_CODEX_SESSION_MODE
                  }
                  style={{ width: "100%" }}
                  options={MODE_OPTIONS}
                  onChange={(value) =>
                    update({
                      codexConfig: {
                        ...newThreadSetup.codexConfig,
                        sessionMode: value as CodexSessionMode,
                      },
                    })
                  }
                />
              </div>
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {(newThreadSetup.icon || newThreadSetup.color) && (
                <ThreadBadge
                  icon={newThreadSetup.icon}
                  color={newThreadSetup.color}
                  image={newThreadSetup.image}
                  size={20}
                />
              )}
              <span style={{ color: "#666", fontSize: 13 }}>
                {threadsCount === 0
                  ? "No chats yet. Send your first message below."
                  : "Use these defaults for the next new chat you send."}
              </span>
            </div>
            <Button size="small" onClick={onNewChat}>
              Reset
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const shouldShowCodexConfig =
    selectedThread != null &&
    Boolean(selectedThread.rootMessage) &&
    Boolean(
      actions?.isCodexThread?.(new Date(parseInt(selectedThread.key, 10))),
    );
  const selectedThreadForLog = selectedThreadKey ?? undefined;
  const threadMeta =
    selectedThread && "displayLabel" in selectedThread
      ? selectedThread
      : undefined;
  const compactThreadLabel = threadMeta?.displayLabel ?? selectedThread?.label;
  const compactThreadIcon = threadMeta?.threadIcon;
  const compactThreadColor = threadMeta?.threadColor;
  const compactThreadImage = threadMeta?.threadImage;
  const compactThreadHasAppearance = threadMeta?.hasCustomAppearance ?? false;
  const threadImagePreview = showThreadImagePreview
    ? compactThreadImage?.trim()
    : undefined;

  return (
    <div
      className="smc-vfill"
      style={{
        ...CHAT_LOG_STYLE,
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {shouldShowCodexConfig && (
        <div style={{ position: "absolute", top: 8, left: 8, zIndex: 10 }}>
          <Space size={6}>
            <CodexConfigButton
              threadKey={selectedThreadKey}
              chatPath={path ?? ""}
              projectId={project_id}
              actions={actions}
              paymentSource={codexPaymentSource}
              paymentSourceLoading={codexPaymentSourceLoading}
              refreshPaymentSource={refreshCodexPaymentSource}
            />
          </Space>
        </div>
      )}
      {threadImagePreview ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 16,
            zIndex: 10,
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid #ddd",
            background: "white",
            boxShadow: "0 1px 8px rgba(0,0,0,0.12)",
          }}
        >
          <img
            src={threadImagePreview}
            alt="Chat image"
            style={{ width: 84, height: 84, objectFit: "cover", display: "block" }}
          />
        </div>
      ) : null}
      {variant === "compact" && compactThreadLabel && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #e5e5e5",
            background: "#f7f7f7",
            color: "#555",
            fontWeight: 600,
            fontSize: "12px",
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {compactThreadHasAppearance && (
            <ThreadBadge
              icon={compactThreadIcon}
              color={compactThreadColor}
              image={compactThreadImage}
              size={18}
            />
          )}
          {compactThreadLabel}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: threadImagePreview ? 116 : 12,
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Tooltip title="Search thread (Ctrl/Cmd+F)">
          <Button
            size="small"
            onClick={() => {
              setThreadSearchOpen((open) => {
                const next = !open;
                if (next) {
                  setTimeout(() => searchInputRef.current?.focus?.(), 0);
                }
                return next;
              });
            }}
            icon={<Icon name="search" />}
          >
            Search
          </Button>
        </Tooltip>
      </div>
      {threadSearchOpen ? (
        <div
          style={{
            position: "absolute",
            top: 44,
            right: threadImagePreview ? 116 : 12,
            zIndex: 21,
            padding: "8px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            background: "rgba(250,250,250,0.98)",
            border: "1px solid #ddd",
            borderRadius: 8,
            boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
            maxWidth: "min(90vw, 560px)",
          }}
        >
          <Input
            ref={searchInputRef}
            size="small"
            allowClear
            placeholder={
              selectedThreadId
                ? "Search this thread"
                : "Select a thread to search"
            }
            value={threadSearchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
            onPressEnter={() => {
              if (!matchCount) return;
              setThreadSearchCursor((n) => n + 1);
            }}
            style={{ width: "min(320px, 100%)" }}
            disabled={!selectedThreadId}
          />
          <div style={{ display: "inline-flex", gap: 8, whiteSpace: "nowrap" }}>
            <Button
              size="small"
              disabled={!selectedThreadId || !matchCount}
              onClick={() => setThreadSearchCursor((n) => n - 1)}
            >
              Prev
            </Button>
            <Button
              size="small"
              disabled={!selectedThreadId || !matchCount}
              onClick={() => setThreadSearchCursor((n) => n + 1)}
            >
              Next
            </Button>
          </div>
          <span style={{ color: "#666", fontSize: 12 }}>
            {!selectedThreadId
              ? "Select a thread to search"
              : matchCount
                ? `${normalizedCursor + 1}/${matchCount}`
                : "0 matches"}
          </span>
          {selectedThreadId && threadSearchQuery.trim().length > 0 ? (
            <span style={{ color: "#666", fontSize: 12 }}>
              {archivedSearchLoading
                ? "Archived: searching…"
                : archivedSearchError
                  ? "Archived: error"
                  : `Archived: ${archivedMatchCount}`}
            </span>
          ) : null}
          <Button
            size="small"
            disabled={!selectedThreadId || !project_id || !path}
            onClick={() => {
              setArchivedHistoryOpen(true);
              void loadArchivedHistory(0, false);
            }}
          >
            History
          </Button>
          <Button
            size="small"
            type="text"
            onClick={() => setThreadSearchOpen(false)}
          >
            ×
          </Button>
          {selectedThreadId && threadSearchQuery.trim().length > 0 ? (
            <div
              style={{
                width: "100%",
                maxHeight: 160,
                overflowY: "auto",
                borderTop: "1px solid #e6e6e6",
                paddingTop: 6,
                marginTop: 2,
                color: "#555",
                fontSize: 12,
              }}
            >
              {archivedSearchLoading ? (
                <div>Searching archived history…</div>
              ) : archivedSearchError ? (
                <div style={{ color: "#b71c1c" }}>{archivedSearchError}</div>
              ) : archivedSearchHits.length === 0 ? (
                <div>No archived matches.</div>
              ) : (
                archivedSearchHits.slice(0, 6).map((hit) => {
                  const when =
                    typeof hit.date_ms === "number"
                      ? new Date(hit.date_ms).toLocaleString()
                      : "";
                  const text = (hit.snippet ?? hit.excerpt ?? "")
                    .replace(/<[^>]*>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                  return (
                    <div
                      key={`${hit.segment_id}:${hit.row_id}`}
                      style={{ marginBottom: 6, lineHeight: "16px" }}
                    >
                      <div style={{ fontSize: 11, color: "#888" }}>{when}</div>
                      <div>{text || "(no preview)"}</div>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      <Modal
        title="Archived thread history"
        open={archivedHistoryOpen}
        width={680}
        onCancel={() => setArchivedHistoryOpen(false)}
        footer={[
          <Button key="close" onClick={() => setArchivedHistoryOpen(false)}>
            Close
          </Button>,
          <Button
            key="more"
            onClick={() => {
              if (archivedHistoryNextOffset == null) return;
              void loadArchivedHistory(archivedHistoryNextOffset, true);
            }}
            disabled={archivedHistoryLoading || archivedHistoryNextOffset == null}
          >
            Load more
          </Button>,
        ]}
      >
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {archivedHistoryLoading && archivedHistoryRows.length === 0 ? (
            <div style={{ color: "#666" }}>Loading archived history…</div>
          ) : archivedHistoryError ? (
            <div style={{ color: "#b71c1c" }}>{archivedHistoryError}</div>
          ) : archivedHistoryRows.length === 0 ? (
            <div style={{ color: "#666" }}>No archived rows for this thread.</div>
          ) : (
            archivedHistoryRows.map((row) => {
              const when =
                typeof row.date_ms === "number"
                  ? new Date(row.date_ms).toLocaleString()
                  : "(unknown time)";
              const text = (row.excerpt ?? "")
                .replace(/<[^>]*>/g, " ")
                .replace(/\s+/g, " ")
                .trim();
              return (
                <div
                  key={`${row.segment_id}:${row.row_id}`}
                  style={{
                    borderBottom: "1px solid #f0f0f0",
                    padding: "8px 0",
                    fontSize: 12,
                  }}
                >
                  <div style={{ color: "#888", marginBottom: 2 }}>{when}</div>
                  <div style={{ color: "#333" }}>{text || "(no preview)"}</div>
                </div>
              );
            })
          )}
        </div>
      </Modal>
      {selectedThreadId && archivedRowsCount > 0 ? (
        <div
          style={{
            margin: "8px 12px 0 12px",
            padding: "8px 10px",
            border: "1px solid #ffe58f",
            background: "#fffbe6",
            borderRadius: 8,
            color: "#8a6d3b",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            zIndex: 1,
          }}
        >
          <span>
            {archivedRowsCount.toLocaleString()} older message
            {archivedRowsCount === 1 ? "" : "s"} archived.
          </span>
          <Button
            size="small"
            onClick={() => {
              setArchivedHistoryOpen(true);
              void loadArchivedHistory(0, false);
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
      <ChatLog
        actions={actions}
        project_id={project_id ?? ""}
        path={path ?? ""}
        messages={messages}
        threadIndex={threadIndex}
        acpState={acpState}
        scrollToBottomRef={scrollToBottomRef}
        scrollCacheId={scrollCacheId}
        mode={variant === "compact" ? "sidechat" : "standalone"}
        fontSize={fontSize}
        selectedThread={selectedThreadForLog}
        scrollToIndex={scrollToIndex}
        scrollToDate={scrollToDate}
        selectedDate={activeSearchMatchDate ?? fragmentId ?? undefined}
        composerTargetKey={composerTargetKey}
        composerFocused={composerFocused}
        searchJumpDate={activeSearchMatchDate}
        searchJumpToken={threadSearchJumpToken}
        searchQuery={threadSearchQuery}
      />
    </div>
  );
}

function getReasoningForModel({
  modelValue,
  desired,
}: {
  modelValue?: string;
  desired?: CodexReasoningId;
}): CodexReasoningId | undefined {
  const model =
    DEFAULT_CODEX_MODELS.find((m) => m.name === modelValue) ??
    DEFAULT_CODEX_MODELS[0];
  const options = model?.reasoning ?? [];
  if (!options.length) return undefined;
  const match = options.find((r) => r.id === desired);
  return match?.id ?? options.find((r) => r.default)?.id ?? options[0]?.id;
}

function normalizeSessionMode(
  config?: Partial<CodexThreadConfig>,
): CodexSessionMode | undefined {
  const mode = resolveCodexSessionMode(config as CodexThreadConfig);
  if (
    mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "full-access"
  ) {
    return mode;
  }
  return undefined;
}

function isCodexModelName(value?: string): boolean {
  if (!value) return false;
  return DEFAULT_CODEX_MODELS.some((model) => model.name === value);
}

function renderOptionWithDescription({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div style={{ lineHeight: "18px" }}>
      <div>{title}</div>
      {description ? (
        <div style={{ fontSize: 11, color: "#888", lineHeight: "14px" }}>
          {description}
        </div>
      ) : null}
    </div>
  );
}
