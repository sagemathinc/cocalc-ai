/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Space,
  Tag,
  Tooltip,
  Typography,
  type MenuProps,
} from "antd";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon, Loading, TimeAgo } from "@cocalc/frontend/components";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import type {
  AgentSessionRecord,
  AgentSessionStatus,
} from "@cocalc/frontend/chat/agent-session-index";
import {
  upsertAgentSessionRecord,
  watchAgentSessionsForProject,
} from "@cocalc/frontend/chat/agent-session-index";
import {
  initChat,
  getChatActions,
  isChatActions,
  removeWithInstance as removeChatWithInstance,
} from "@cocalc/frontend/chat/register";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { groupThreadsByRecency } from "@cocalc/frontend/chat/threads";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import {
  delete_local_storage,
  get_local_storage,
  html_to_text,
  set_local_storage,
} from "@cocalc/frontend/misc";
import { ThreadBadge } from "@cocalc/frontend/chat/thread-badge";
import { openFloatingAgentSession } from "@cocalc/frontend/project/page/agent-dock-state";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import { NAVIGATOR_CHAT_INSTANCE_KEY } from "@cocalc/frontend/project/new/navigator-shell";
import { saveNavigatorSelectedThreadKey } from "@cocalc/frontend/project/new/navigator-state";
import { useAgentChatFontSize } from "@cocalc/frontend/project/page/agent-chat-font-size";
import { AGENT_CHAT_MAX_WIDTH_PX } from "@cocalc/frontend/project/page/agent-layout-constants";

const STATUS_COLORS: Record<AgentSessionStatus, string> = {
  active: "processing",
  idle: "default",
  running: "blue",
  archived: "purple",
  failed: "red",
};
const AGENTS_INLINE_CHAT_INSTANCE_KEY = "agents-panel-inline";
const AGENTS_PIN_CHAT_INSTANCE_KEY = "agents-panel-pin";
const CHAT_PATH_SCAN_INTERVAL_MS = 20000;
const AGENTS_OPEN_SESSION_STORAGE_PREFIX = "agents-panel-open-session";
const AGENTS_MODEL_MIN_PANEL_WIDTH_PX = 360;

function shortAccountId(accountId?: string): string {
  if (!accountId) return "unknown";
  if (accountId.length <= 12) return accountId;
  return `${accountId.slice(0, 8)}...`;
}

function ellipsize(value: string, max = 72): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
}

function dateMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).valueOf();
  return Number.isFinite(ms) ? ms : 0;
}

function isMissingPathError(err: unknown): boolean {
  const code = `${(err as any)?.code ?? ""}`.toUpperCase();
  if (code === "ENOENT" || code === "404") return true;
  const message = `${(err as any)?.message ?? err ?? ""}`.toUpperCase();
  return message.includes("ENOENT") || message.includes("NO SUCH FILE");
}

function areSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function normalizedTitle(record: AgentSessionRecord): string {
  const raw = typeof record.title === "string" ? record.title : "";
  const plain = html_to_text(raw).replace(/\s+/g, " ").trim();
  if (plain) return plain;
  return "Navigator session";
}

interface SessionListItem {
  key: string;
  label: string;
  newestTime: number;
  messageCount: number;
  isPinned?: boolean;
  record: AgentSessionRecord;
}

function openedSessionStorageKey(
  project_id: string,
  layout: "flyout" | "page",
): string {
  return `${AGENTS_OPEN_SESSION_STORAGE_PREFIX}:${project_id}:${layout}`;
}

function loadOpenedSessionId(
  project_id: string,
  layout: "flyout" | "page",
): string | null {
  const raw = get_local_storage(openedSessionStorageKey(project_id, layout));
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function saveOpenedSessionId(
  project_id: string,
  layout: "flyout" | "page",
  sessionId: string | null,
): void {
  const key = openedSessionStorageKey(project_id, layout);
  if (!sessionId) {
    delete_local_storage(key);
    return;
  }
  set_local_storage(key, sessionId);
}

interface AgentsFlyoutProps {
  project_id: string;
  wrap: (content: React.JSX.Element, style?: React.CSSProperties) => React.JSX.Element;
}

interface AgentsPanelProps {
  project_id: string;
  layout?: "flyout" | "page";
}

export function AgentsPanel({ project_id, layout = "page" }: AgentsPanelProps) {
  const actions = useActions({ project_id }) as ProjectActions;
  const account_id = useTypedRedux("account", "account_id");
  const accountFontSize = useTypedRedux("account", "font_size") ?? 13;
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [missingChatPaths, setMissingChatPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string>("");
  const [updatingSessionId, setUpdatingSessionId] = useState<string>("");
  const [inlineSessionId, setInlineSessionId] = useState<string | null>(() =>
    loadOpenedSessionId(project_id, layout),
  );
  const [inlineActions, setInlineActions] = useState<ChatActions | null>(null);
  const [inlineError, setInlineError] = useState<string>("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = useState<number>(0);
  const isFlyout = layout === "flyout";
  const {
    fontSize,
    increaseFontSize,
    decreaseFontSize,
    canIncreaseFontSize,
    canDecreaseFontSize,
  } = useAgentChatFontSize(accountFontSize);

  useEffect(() => {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    setError("");
    setLoading(true);

    void watchAgentSessionsForProject({ project_id }, (records: AgentSessionRecord[]) => {
        if (closed) return;
        setSessions(records);
        setLoading(false);
      })
      .then((cleanup) => {
        if (closed) {
          cleanup();
          return;
        }
        unsubscribe = cleanup;
      })
      .catch((err) => {
        if (closed) return;
        setError(`${err}`);
        setLoading(false);
      });

    return () => {
      closed = true;
      unsubscribe?.();
    };
  }, [account_id, project_id]);

  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const update = () => {
      const width = node.getBoundingClientRect().width;
      if (Number.isFinite(width)) {
        setPanelWidth(width);
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => update());
    ro.observe(node);
    return () => {
      ro.disconnect();
    };
  }, [layout, inlineSessionId]);

  const showModelInMeta = useMemo(() => {
    if (!isFlyout) return true;
    if (panelWidth <= 0) return false;
    return panelWidth >= AGENTS_MODEL_MIN_PANEL_WIDTH_PX;
  }, [isFlyout, panelWidth]);

  const knownChatPaths = useMemo(() => {
    return Array.from(
      new Set(
        sessions
          .map((session) => session.chat_path)
          .filter(
            (path): path is string =>
              typeof path === "string" && path.trim().length > 0,
          ),
      ),
    );
  }, [sessions]);

  useEffect(() => {
    const fs = actions?.fs?.();
    if (typeof fs?.stat !== "function") return;
    let closed = false;
    let inFlight = false;

    async function scanChatPaths(): Promise<void> {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        const missing = new Set<string>();
        for (const path of knownChatPaths) {
          try {
            await fs.stat(path);
          } catch (err) {
            // Only hide entries when we are certain the file is missing.
            if (isMissingPathError(err)) {
              missing.add(path);
            }
          }
        }
        if (closed) return;
        setMissingChatPaths((prev) => {
          const next = new Set(prev);
          for (const path of knownChatPaths) {
            next.delete(path);
          }
          for (const path of missing) {
            next.add(path);
          }
          return areSetsEqual(prev, next) ? prev : next;
        });
      } finally {
        inFlight = false;
      }
    }

    void scanChatPaths();
    const timer = setInterval(() => {
      void scanChatPaths();
    }, CHAT_PATH_SCAN_INTERVAL_MS);

    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [actions, knownChatPaths, project_id]);

  const sessionsWithExistingChat = useMemo(() => {
    return sessions.filter((session) => !missingChatPaths.has(session.chat_path));
  }, [sessions, missingChatPaths]);

  const inlineSession = useMemo(() => {
    if (!inlineSessionId) return null;
    return (
      sessionsWithExistingChat.find(
        (session) => session.session_id === inlineSessionId,
      ) ?? null
    );
  }, [inlineSessionId, sessionsWithExistingChat]);

  const scopedSessions = useMemo(() => {
    let filtered = sessionsWithExistingChat;
    if (scope === "mine" && typeof account_id === "string" && account_id.trim()) {
      filtered = filtered.filter((session) => session.account_id === account_id);
    }
    return [...filtered].sort(
      (a, b) => dateMs(b.updated_at) - dateMs(a.updated_at),
    );
  }, [sessionsWithExistingChat, scope, account_id]);

  const visibleSections = useMemo(() => {
    const activeItems: SessionListItem[] = scopedSessions
      .filter((session) => session.status !== "archived")
      .map((record) => ({
        key: `${record.chat_path}::${record.thread_key}`,
        label: normalizedTitle(record),
        newestTime: Math.max(dateMs(record.updated_at), dateMs(record.created_at)),
        messageCount: 1,
        isPinned: record.thread_pin === true,
        record,
      }));
    return groupThreadsByRecency(activeItems).map((section) => ({
      ...section,
      threads: section.threads.map((item) => item.record),
    }));
  }, [scopedSessions]);

  const archivedSessions = useMemo(() => {
    return scopedSessions.filter((session) => session.status === "archived");
  }, [scopedSessions]);

  useEffect(() => {
    if (!inlineSessionId) return;
    if (inlineSession) return;
    if (loading) return;
    setInlineSessionId(null);
  }, [inlineSession, inlineSessionId, loading]);

  useEffect(() => {
    saveOpenedSessionId(project_id, layout, inlineSessionId);
  }, [inlineSessionId, layout, project_id]);

  useEffect(() => {
    const chatPath = inlineSession?.chat_path;
    if (!chatPath) {
      setInlineActions(null);
      setInlineError("");
      return;
    }
    let mounted = true;
    let chatActions: ChatActions | undefined;
    let ownsChatInstance = false;
    setInlineError("");

    try {
      const directActions = redux.getEditorActions(project_id, chatPath);
      const sharedActions =
        (isChatActions(directActions) ? directActions : undefined) ??
        getChatActions(project_id, chatPath, {
          instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
        });
      if (sharedActions) {
        setInlineActions(sharedActions);
        return () => {
          mounted = false;
        };
      }
      setInlineActions(null);
      chatActions = initChat(project_id, chatPath, {
        instanceKey: AGENTS_INLINE_CHAT_INSTANCE_KEY,
      });
      ownsChatInstance = true;
      if (!mounted) {
        if (ownsChatInstance) {
          removeChatWithInstance(chatPath, redux, project_id, {
            instanceKey: AGENTS_INLINE_CHAT_INSTANCE_KEY,
          });
        }
        return;
      }
      setInlineActions(chatActions);
    } catch (err) {
      if (!mounted) return;
      setInlineActions(null);
      setInlineError(`${err}`);
    }

    return () => {
      mounted = false;
      if (chatActions && ownsChatInstance) {
        setInlineActions((current) => (current === chatActions ? null : current));
        removeChatWithInstance(chatPath, redux, project_id, {
          instanceKey: AGENTS_INLINE_CHAT_INSTANCE_KEY,
        });
      }
    };
  }, [inlineSession?.chat_path, project_id]);

  useEffect(() => {
    if (!inlineActions || !inlineSession?.thread_key) return;
    inlineActions.setSelectedThread?.(inlineSession.thread_key);
    const timer = setTimeout(() => {
      inlineActions?.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
    }, 0);
    return () => clearTimeout(timer);
  }, [inlineActions, inlineSession?.thread_key]);

  const inlineDesc = useMemo(() => {
    if (!inlineSession?.thread_key) return undefined;
    return {
      "data-selectedThreadKey": inlineSession.thread_key,
      "data-preferLatestThread": false,
      "data-showThreadImagePreview": false,
    };
  }, [inlineSession?.thread_key]);

  const inlineFileContext = useMemo(() => {
    if (!inlineSession?.chat_path) return undefined;
    return {
      project_id,
      path: inlineSession.chat_path,
      urlTransform: getUrlTransform({
        project_id,
        path: inlineSession.chat_path,
      }),
      AnchorTagComponent: getAnchorTagComponent({
        project_id,
        path: inlineSession.chat_path,
      }),
    };
  }, [inlineSession?.chat_path, project_id]);

  function openNavigatorSession(record: AgentSessionRecord): void {
    saveNavigatorSelectedThreadKey(record.thread_key);
    actions?.set_active_tab("home");
  }

  function openInlineSession(record: AgentSessionRecord): void {
    setInlineSessionId(record.session_id);
    setInlineError("");
    const directActions = redux.getEditorActions(project_id, record.chat_path);
    const sharedActions =
      (isChatActions(directActions) ? directActions : undefined) ??
      getChatActions(project_id, record.chat_path, {
        instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
      });
    if (sharedActions) {
      setInlineActions(sharedActions);
    }
  }

  function openFloatingSession(record: AgentSessionRecord): void {
    openFloatingAgentSession(project_id, record);
  }

  function recordMetaLine(record: AgentSessionRecord): string {
    const parts: string[] = [];
    if (scope === "all") {
      parts.push(shortAccountId(record.account_id));
    }
    if (showModelInMeta && record.model) {
      parts.push(ellipsize(record.model, isFlyout ? 30 : 44));
    }
    if (record.thread_pin) {
      parts.push("pinned");
    }
    return parts.join(" · ");
  }

  function renderSessionMenu(record: AgentSessionRecord): React.JSX.Element {
    const items: MenuProps["items"] = [
      {
        key: "resume",
        label: "Go to Home Chat",
      },
      {
        key: "float",
        label: "Float",
      },
      {
        key: "open-file",
        label: "Open Chat File",
      },
      {
        type: "divider",
      },
      {
        key: "pin",
        label: record.thread_pin ? "Unpin" : "Pin",
        disabled: updatingSessionId === record.session_id,
      },
      {
        key: "archive",
        label: record.status === "archived" ? "Unarchive" : "Archive",
        disabled: updatingSessionId === record.session_id,
        danger: record.status !== "archived",
      },
    ];
    return (
      <Dropdown
        trigger={["click"]}
        menu={{
          items,
          onClick: ({ key }) => {
            switch (key) {
              case "resume":
                openNavigatorSession(record);
                return;
              case "float":
                openFloatingSession(record);
                return;
              case "open-file":
                actions?.open_file({ path: record.chat_path });
                return;
              case "pin":
                void togglePin(record);
                return;
              case "archive":
                void toggleArchive(record);
                return;
            }
          },
        }}
      >
        <Button size="small" type="text" icon={<Icon name="ellipsis" />} />
      </Dropdown>
    );
  }

  function renderInlineSessionMenu(record: AgentSessionRecord): React.JSX.Element {
    const items: MenuProps["items"] = [
      {
        key: "resume",
        label: "Go to Home Chat",
      },
      {
        key: "float",
        label: "Float",
      },
      {
        key: "open-file",
        label: "Open Chat File",
      },
      {
        type: "divider",
      },
      {
        key: "pin",
        label: record.thread_pin ? "Unpin" : "Pin",
        disabled: updatingSessionId === record.session_id,
      },
      {
        key: "archive",
        label: record.status === "archived" ? "Unarchive" : "Archive",
        disabled: updatingSessionId === record.session_id,
        danger: record.status !== "archived",
      },
    ];
    return (
      <Dropdown
        trigger={["click"]}
        menu={{
          items,
          onClick: ({ key }) => {
            switch (key) {
              case "resume":
                openNavigatorSession(record);
                return;
              case "float":
                openFloatingSession(record);
                return;
              case "open-file":
                actions?.open_file({ path: record.chat_path });
                return;
              case "pin":
                void togglePin(record);
                return;
              case "archive":
                void toggleArchive(record);
                return;
            }
          },
        }}
      >
        <Button size="small">Actions</Button>
      </Dropdown>
    );
  }

  function renderFontSizeControls(minimal = false): React.JSX.Element {
    return (
      <Space size={[4, 0]} wrap>
        {!minimal ? (
          <Typography.Text type="secondary">Font</Typography.Text>
        ) : null}
        <Tooltip title="Decrease chat font size">
          <Button
            size="small"
            type="text"
            disabled={!canDecreaseFontSize}
            onClick={decreaseFontSize}
            style={{ minWidth: 24, padding: "0 4px" }}
          >
            <Icon name="minus" />
          </Button>
        </Tooltip>
        <Tooltip title={`Agent chat font size: ${fontSize}px`}>
          <Typography.Text style={{ minWidth: 28, textAlign: "center" }}>
            {fontSize}
          </Typography.Text>
        </Tooltip>
        <Tooltip title="Increase chat font size">
          <Button
            size="small"
            type="text"
            disabled={!canIncreaseFontSize}
            onClick={increaseFontSize}
            style={{ minWidth: 24, padding: "0 4px" }}
          >
            <Icon name="plus" />
          </Button>
        </Tooltip>
      </Space>
    );
  }

  async function resolveChatActionsForRecord(record: AgentSessionRecord): Promise<{
    chatActions: ChatActions;
    cleanup?: () => void;
  }> {
    const directActions = redux.getEditorActions(project_id, record.chat_path);
    const sharedActions =
      (isChatActions(directActions) ? directActions : undefined) ??
      getChatActions(project_id, record.chat_path, {
        instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
      }) ??
      getChatActions(project_id, record.chat_path, {
        instanceKey: AGENTS_INLINE_CHAT_INSTANCE_KEY,
      });
    if (sharedActions) {
      return { chatActions: sharedActions };
    }

    const chatActions = initChat(project_id, record.chat_path, {
      instanceKey: AGENTS_PIN_CHAT_INSTANCE_KEY,
    });
    const syncdb = (chatActions as any)?.syncdb;
    try {
      if (syncdb?.get_state?.() !== "ready") {
        await new Promise<void>((resolve, reject) => {
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            reject(new Error("Chat closed before ready."));
          };
          const cleanup = () => {
            syncdb?.removeListener?.("ready", onReady);
            syncdb?.removeListener?.("close", onClose);
          };
          syncdb?.once?.("ready", onReady);
          syncdb?.once?.("close", onClose);
        });
      }
    } catch (err) {
      removeChatWithInstance(record.chat_path, redux, project_id, {
        instanceKey: AGENTS_PIN_CHAT_INSTANCE_KEY,
      });
      throw err;
    }
    return {
      chatActions,
      cleanup: () => {
        removeChatWithInstance(record.chat_path, redux, project_id, {
          instanceKey: AGENTS_PIN_CHAT_INSTANCE_KEY,
        });
      },
    };
  }

  async function togglePin(record: AgentSessionRecord): Promise<void> {
    setUpdatingSessionId(record.session_id);
    const nextPinned = record.thread_pin !== true;
    let cleanup: (() => void) | undefined;
    try {
      const { chatActions, cleanup: removeTemp } = await resolveChatActionsForRecord(
        record,
      );
      cleanup = removeTemp;
      const ok = chatActions.setThreadPin?.(record.thread_key, nextPinned);
      if (!ok) {
        throw new Error("Could not update thread pin state.");
      }
      await upsertAgentSessionRecord({
        ...record,
        thread_pin: nextPinned,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      cleanup?.();
      setUpdatingSessionId("");
    }
  }

  async function toggleArchive(record: AgentSessionRecord): Promise<void> {
    setUpdatingSessionId(record.session_id);
    try {
      const nextStatus: AgentSessionStatus =
        record.status === "archived" ? "active" : "archived";
      await upsertAgentSessionRecord({
        ...record,
        status: nextStatus,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setUpdatingSessionId("");
    }
  }

  function renderSession(record: AgentSessionRecord): React.JSX.Element {
    const image = record.thread_image?.trim() || undefined;
    const icon = record.thread_icon?.trim() || undefined;
    const color = record.thread_color?.trim() || undefined;
    const title = normalizedTitle(record);
    const metaLine = recordMetaLine(record);
    const updatedAt = record.updated_at ?? record.created_at;
    const showCornerImage = Boolean(image);
    const statusTag =
      record.status === "running" || record.status === "failed" ? (
        <Tag
          color={STATUS_COLORS[record.status] ?? "default"}
          style={{ marginInlineEnd: 0 }}
        >
          {record.status}
        </Tag>
      ) : null;
    return (
      <div key={record.session_id}>
        <div
          style={{
            width: "100%",
            border: "1px solid #e8e8e8",
            borderRadius: 8,
            padding: isFlyout ? 8 : 10,
            background: "#fff",
            borderLeft: color ? `4px solid ${color}` : undefined,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {showCornerImage ? (
            <div
              style={{
                position: "absolute",
                top: 10,
                right: 10,
                width: 72,
                height: 72,
                borderRadius: 10,
                overflow: "hidden",
                border: "1px solid #ddd",
                boxShadow: "0 1px 8px rgba(0,0,0,0.1)",
              }}
            >
              <img
                src={image}
                alt="Thread image"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <ThreadBadge
              image={showCornerImage ? undefined : image}
              icon={icon}
              color={color}
              fallbackIcon="comment"
              size={isFlyout ? 36 : 32}
              style={{ marginTop: 1 }}
            />
            <div
              style={{
                minWidth: 0,
                flex: 1,
                paddingRight: showCornerImage ? 84 : undefined,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-start",
                  gap: 8,
                }}
              >
                <Typography.Text strong title={title}>
                  {ellipsize(title, isFlyout ? 48 : 56)}
                </Typography.Text>
                {statusTag}
              </div>
              {metaLine ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    marginTop: 2,
                  }}
                >
                  <Typography.Text
                    type="secondary"
                    style={{
                      minWidth: 0,
                      flex: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {metaLine}
                  </Typography.Text>
                  {updatedAt ? (
                    <span
                      style={{
                        color: "#9a9a9a",
                        fontSize: 12,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      <TimeAgo
                        date={updatedAt}
                        click_to_toggle={false}
                        style={{
                          whiteSpace: "nowrap",
                        }}
                      />
                    </span>
                  ) : null}
                </div>
              ) : updatedAt ? (
                <span
                  style={{
                    color: "#9a9a9a",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    display: "block",
                    marginTop: 2,
                  }}
                >
                  <TimeAgo
                    date={updatedAt}
                    click_to_toggle={false}
                    style={{
                      whiteSpace: "nowrap",
                    }}
                  />
                </span>
              ) : null}
            </div>
          </div>
          <Space size={[4, 0]}>
            <Button
              size="small"
              type="primary"
              onClick={() => openInlineSession(record)}
            >
              Open
            </Button>
            {renderSessionMenu(record)}
          </Space>
        </div>
      </div>
    );
  }

  if (loading) {
    return <Loading theme="medium" />;
  }

  if (inlineSession) {
    const inlineTitle = normalizedTitle(inlineSession);
    return (
      <div
        ref={panelRef}
        style={
          isFlyout
            ? {
                display: "flex",
                flexDirection: "column",
                height: "100%",
                minHeight: 0,
              }
            : {
                width: "100%",
                maxWidth: AGENT_CHAT_MAX_WIDTH_PX,
                margin: "0 auto",
                padding: "12px 16px 24px",
              }
        }
      >
        <Space
          wrap
          size={[8, 8]}
          style={{ marginBottom: 8, width: "100%", justifyContent: "space-between" }}
        >
          <Space size={[6, 6]} wrap style={{ minWidth: 0 }}>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              onClick={() => setInlineSessionId(null)}
            >
              Back
            </Button>
            <Typography.Text strong title={inlineTitle}>
              {ellipsize(inlineTitle, isFlyout ? 42 : 90)}
            </Typography.Text>
          </Space>
          <Space size={[4, 4]} wrap>
            {renderFontSizeControls(true)}
            {renderInlineSessionMenu(inlineSession)}
          </Space>
        </Space>
        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />
        ) : null}
        {inlineError ? (
          <Alert
            type="error"
            showIcon
            message={inlineError}
            style={{ marginBottom: 8 }}
          />
        ) : null}
        <div
          style={{
            border: "1px solid #eee",
            borderRadius: 8,
            overflow: "hidden",
            background: "white",
            flex: 1,
            minHeight: 0,
            height: isFlyout ? undefined : "min(78vh, 860px)",
          }}
        >
          {inlineActions ? (
            <FileContext.Provider value={inlineFileContext ?? {}}>
              <SideChat
                actions={inlineActions}
                project_id={project_id}
                path={inlineSession.chat_path}
                fontSize={fontSize}
                hideSidebar
                desc={inlineDesc}
              />
            </FileContext.Provider>
          ) : (
            <Loading theme="medium" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      style={
        isFlyout
          ? {
              height: "100%",
              minHeight: 0,
            }
          : {
              width: "100%",
              padding: "12px 16px 24px",
            }
      }
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 8 }}
        />
      ) : null}
      <div style={{ marginBottom: 12 }}>
        <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
          Recent agent sessions
        </Typography.Text>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Space size={[6, 6]} wrap>
            <Button
              size="small"
              type={scope === "mine" ? "primary" : "default"}
              onClick={() => setScope("mine")}
            >
              Mine
            </Button>
            <Button
              size="small"
              type={scope === "all" ? "primary" : "default"}
              onClick={() => setScope("all")}
            >
              All Users
            </Button>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived
                ? "Hide archived"
                : `Show archived${archivedSessions.length ? ` (${archivedSessions.length})` : ""}`}
            </Button>
          </Space>
        </div>
      </div>
      {visibleSections.length === 0 && (!showArchived || archivedSessions.length === 0) ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={"No indexed sessions yet"}
        />
      ) : (
        <Space
          direction="vertical"
          size={12}
          style={{ display: "flex", width: "100%" }}
        >
          {visibleSections.map((section) => (
            <div key={section.key}>
              <Typography.Text type="secondary" strong style={{ display: "block", marginBottom: 6 }}>
                {section.title}
              </Typography.Text>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isFlyout
                    ? "1fr"
                    : "repeat(auto-fit, minmax(360px, 1fr))",
                  gap: isFlyout ? 8 : 12,
                }}
              >
                {section.threads.map((session) => renderSession(session))}
              </div>
            </div>
          ))}
          {showArchived && archivedSessions.length > 0 ? (
            <div>
              <Typography.Text
                type="secondary"
                strong
                style={{ display: "block", marginBottom: 6 }}
              >
                Archived
              </Typography.Text>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isFlyout
                    ? "1fr"
                    : "repeat(auto-fit, minmax(360px, 1fr))",
                  gap: isFlyout ? 8 : 12,
                }}
              >
                {archivedSessions.map((session) => renderSession(session))}
              </div>
            </div>
          ) : null}
        </Space>
      )}
    </div>
  );
}

export function AgentsFlyout({ project_id, wrap }: AgentsFlyoutProps) {
  return wrap(<AgentsPanel project_id={project_id} layout="flyout" />);
}
