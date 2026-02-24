/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Empty, Space, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "@cocalc/frontend/app-framework";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Loading } from "@cocalc/frontend/components";
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
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { ThreadBadge } from "@cocalc/frontend/chat/thread-badge";
import { openFloatingAgentSession } from "@cocalc/frontend/project/page/agent-dock-state";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import { NAVIGATOR_CHAT_INSTANCE_KEY } from "@cocalc/frontend/project/new/navigator-shell";
import { saveNavigatorSelectedThreadKey } from "@cocalc/frontend/project/new/navigator-state";

const STATUS_COLORS: Record<AgentSessionStatus, string> = {
  active: "processing",
  idle: "default",
  running: "blue",
  archived: "purple",
  failed: "red",
};
const AGENTS_INLINE_CHAT_INSTANCE_KEY = "agents-panel-inline";

function formatUpdated(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.valueOf())) return "";
  return date.toLocaleString();
}

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
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string>("");
  const [updatingSessionId, setUpdatingSessionId] = useState<string>("");
  const [inlineSession, setInlineSession] = useState<AgentSessionRecord | null>(
    null,
  );
  const [inlineActions, setInlineActions] = useState<ChatActions | null>(null);
  const [inlineError, setInlineError] = useState<string>("");
  const isFlyout = layout === "flyout";

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

  const visibleSessions = useMemo(() => {
    let visible = showArchived
      ? sessions
      : sessions.filter((session) => session.status !== "archived");
    if (scope === "mine" && typeof account_id === "string" && account_id.trim()) {
      visible = visible.filter((session) => session.account_id === account_id);
    }
    return visible;
  }, [sessions, showArchived, scope, account_id]);

  useEffect(() => {
    if (!inlineSession) return;
    const updated = sessions.find(
      (session) => session.session_id === inlineSession.session_id,
    );
    if (updated) {
      setInlineSession(updated);
      return;
    }
    setInlineSession(null);
  }, [inlineSession, sessions]);

  useEffect(() => {
    if (!inlineSession) {
      setInlineActions(null);
      setInlineError("");
      return;
    }
    let mounted = true;
    let chatActions: ChatActions | undefined;
    let ownsChatInstance = false;
    setInlineError("");

    try {
      const directActions = redux.getEditorActions(project_id, inlineSession.chat_path);
      const sharedActions =
        (isChatActions(directActions) ? directActions : undefined) ??
        getChatActions(project_id, inlineSession.chat_path, {
          instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
        });
      if (sharedActions) {
        setInlineActions(sharedActions);
        return () => {
          mounted = false;
        };
      }
      setInlineActions(null);
      chatActions = initChat(project_id, inlineSession.chat_path, {
        instanceKey: AGENTS_INLINE_CHAT_INSTANCE_KEY,
      });
      ownsChatInstance = true;
      if (!mounted) {
        if (ownsChatInstance) {
          removeChatWithInstance(inlineSession.chat_path, redux, project_id, {
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
        removeChatWithInstance(inlineSession.chat_path, redux, project_id, {
          instanceKey: AGENTS_INLINE_CHAT_INSTANCE_KEY,
        });
      }
    };
  }, [inlineSession, project_id]);

  useEffect(() => {
    if (!inlineActions || !inlineSession?.thread_key) return;
    inlineActions.setSelectedThread?.(inlineSession.thread_key);
    const timer = setTimeout(() => {
      inlineActions?.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
    }, 0);
    return () => clearTimeout(timer);
  }, [inlineActions, inlineSession]);

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
    setInlineSession(record);
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
    const showFlyoutImage = isFlyout && Boolean(image);
    const showPageCornerImage = !isFlyout && Boolean(image);
    return (
      <div key={record.session_id}>
        <div
          style={{
            width: "100%",
            border: "1px solid #e8e8e8",
            borderRadius: 8,
            padding: isFlyout ? 10 : 12,
            background: "#fff",
            borderLeft: color ? `4px solid ${color}` : undefined,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {showFlyoutImage ? (
            <div
              style={{
                margin: "-10px -10px 10px -10px",
                borderBottom: "1px solid #eee",
                background: "#fafafa",
              }}
            >
              <img
                src={image}
                alt="Thread image"
                style={{
                  width: "100%",
                  height: 96,
                  objectFit: "cover",
                  display: "block",
                }}
              />
            </div>
          ) : null}
          {showPageCornerImage ? (
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
              image={showFlyoutImage || showPageCornerImage ? undefined : image}
              icon={icon}
              color={color}
              fallbackIcon="comment"
              size={isFlyout ? 44 : 28}
              style={{ marginTop: 1 }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <Typography.Text strong title={record.title || "Navigator session"}>
                  {ellipsize(
                    record.title || "Navigator session",
                    isFlyout ? 48 : 56,
                  )}
                </Typography.Text>
                <Tag
                  color={STATUS_COLORS[record.status] ?? "default"}
                  style={{ marginInlineEnd: 0 }}
                >
                  {record.status}
                </Tag>
              </div>
              <Space size={[6, 6]} wrap style={{ marginTop: 6 }}>
                <Tag>{shortAccountId(record.account_id)}</Tag>
                {record.model ? (
                  <Tag title={record.model}>{ellipsize(record.model, isFlyout ? 28 : 36)}</Tag>
                ) : null}
                {record.mode ? <Tag>{record.mode}</Tag> : null}
              </Space>
            </div>
          </div>
          <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
            Updated: {formatUpdated(record.updated_at)}
          </Typography.Text>
          <Space size={[6, 0]} wrap>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              onClick={() => openInlineSession(record)}
            >
              Open
            </Button>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              onClick={() => openFloatingSession(record)}
            >
              Float
            </Button>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              onClick={() => openNavigatorSession(record)}
            >
              Resume
            </Button>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              onClick={() => actions?.open_file({ path: record.chat_path })}
            >
              Open Chat File
            </Button>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              disabled={updatingSessionId === record.session_id}
              onClick={() => void toggleArchive(record)}
            >
              {record.status === "archived" ? "Unarchive" : "Archive"}
            </Button>
          </Space>
        </div>
      </div>
    );
  }

  if (loading) {
    return <Loading theme="medium" />;
  }

  if (inlineSession) {
    const inlineImage = inlineSession.thread_image?.trim() || undefined;
    return (
      <div
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
                padding: "12px 16px 24px",
              }
        }
      >
        {isFlyout && inlineImage ? (
          <div
            style={{
              marginBottom: 8,
              borderRadius: 8,
              overflow: "hidden",
              border: "1px solid #eee",
            }}
          >
            <img
              src={inlineImage}
              alt="Thread image"
              style={{ width: "100%", height: 100, objectFit: "cover", display: "block" }}
            />
          </div>
        ) : null}
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
              onClick={() => setInlineSession(null)}
            >
              Back
            </Button>
            <Typography.Text strong title={inlineSession.title || "Agent session"}>
              {ellipsize(inlineSession.title || "Agent session", isFlyout ? 42 : 90)}
            </Typography.Text>
            <Tag
              color={STATUS_COLORS[inlineSession.status] ?? "default"}
              style={{ marginInlineEnd: 0 }}
            >
              {inlineSession.status}
            </Tag>
            {inlineSession.model ? (
              <Tag title={inlineSession.model}>
                {ellipsize(inlineSession.model, isFlyout ? 24 : 40)}
              </Tag>
            ) : null}
          </Space>
          <Space size={[4, 4]} wrap>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              onClick={() => openNavigatorSession(inlineSession)}
            >
              Resume
            </Button>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              onClick={() => openFloatingSession(inlineSession)}
            >
              Float
            </Button>
            <Button
              size="small"
              type="link"
              style={{ paddingLeft: 0 }}
              onClick={() => actions?.open_file({ path: inlineSession.chat_path })}
            >
              Open Chat File
            </Button>
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
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
        </Space>
      </div>
      {visibleSessions.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={"No indexed sessions yet"}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isFlyout
              ? "1fr"
              : "repeat(auto-fit, minmax(360px, 1fr))",
            gap: isFlyout ? 8 : 12,
          }}
        >
          {visibleSessions.map((session) => renderSession(session))}
        </div>
      )}
    </div>
  );
}

export function AgentsFlyout({ project_id, wrap }: AgentsFlyoutProps) {
  return wrap(<AgentsPanel project_id={project_id} layout="flyout" />);
}
