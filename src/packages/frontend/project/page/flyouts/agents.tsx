/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Empty, Space, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "@cocalc/frontend/app-framework";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Loading } from "@cocalc/frontend/components";
import type {
  AgentSessionRecord,
  AgentSessionStatus,
} from "@cocalc/frontend/chat/agent-session-index";
import {
  upsertAgentSessionRecord,
  watchAgentSessionsForProject,
} from "@cocalc/frontend/chat/agent-session-index";
import { ThreadBadge } from "@cocalc/frontend/chat/thread-badge";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import { saveNavigatorSelectedThreadKey } from "@cocalc/frontend/project/new/navigator-state";

const STATUS_COLORS: Record<AgentSessionStatus, string> = {
  active: "processing",
  idle: "default",
  running: "blue",
  archived: "purple",
  failed: "red",
};

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

  function openNavigatorSession(record: AgentSessionRecord): void {
    saveNavigatorSelectedThreadKey(record.thread_key);
    actions?.set_active_tab("home");
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
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <ThreadBadge
              image={image}
              icon={icon}
              color={color}
              fallbackIcon="comment"
              size={isFlyout ? 24 : 26}
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
                  {ellipsize(record.title || "Navigator session", isFlyout ? 48 : 72)}
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

  return (
    <div
      style={
        isFlyout
          ? undefined
          : {
              maxWidth: 1200,
              margin: "0 auto",
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
              : "repeat(auto-fill, minmax(360px, 1fr))",
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
