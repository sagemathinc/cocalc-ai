/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Empty, List, Space, Tag, Typography } from "antd";
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

interface AgentsFlyoutProps {
  project_id: string;
  wrap: (content: React.JSX.Element, style?: React.CSSProperties) => React.JSX.Element;
}

export function AgentsFlyout({ project_id, wrap }: AgentsFlyoutProps) {
  const actions = useActions({ project_id }) as ProjectActions;
  const account_id = useTypedRedux("account", "account_id");
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string>("");
  const [updatingSessionId, setUpdatingSessionId] = useState<string>("");

  useEffect(() => {
    if (typeof account_id !== "string" || account_id.trim().length === 0) {
      setSessions([]);
      setLoading(false);
      return;
    }
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    setError("");
    setLoading(true);

    void watchAgentSessionsForProject(
      { account_id, project_id },
      (records: AgentSessionRecord[]) => {
        if (closed) return;
        setSessions(records);
        setLoading(false);
      },
    )
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
    if (showArchived) return sessions;
    return sessions.filter((session) => session.status !== "archived");
  }, [sessions, showArchived]);

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
    return (
      <List.Item
        key={record.session_id}
        actions={[
          <Button
            key="resume"
            size="small"
            type="link"
            onClick={() => openNavigatorSession(record)}
          >
            Resume
          </Button>,
          <Button
            key="open-chat"
            size="small"
            type="link"
            onClick={() => actions?.open_file({ path: record.chat_path })}
          >
            Open Chat File
          </Button>,
          <Button
            key="archive"
            size="small"
            type="link"
            disabled={updatingSessionId === record.session_id}
            onClick={() => void toggleArchive(record)}
          >
            {record.status === "archived" ? "Unarchive" : "Archive"}
          </Button>,
        ]}
      >
        <List.Item.Meta
          title={
            <Space size="small">
              <Typography.Text strong>{record.title || "Navigator session"}</Typography.Text>
              <Tag color={STATUS_COLORS[record.status] ?? "default"}>
                {record.status}
              </Tag>
            </Space>
          }
          description={
            <Space size="small" wrap>
              {record.model ? <Tag>{record.model}</Tag> : null}
              {record.mode ? <Tag>{record.mode}</Tag> : null}
              <Typography.Text type="secondary">
                Updated: {formatUpdated(record.updated_at)}
              </Typography.Text>
            </Space>
          }
        />
      </List.Item>
    );
  }

  if (loading) {
    return wrap(<Loading theme="medium" />);
  }

  return wrap(
    <div>
      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 8 }}
        />
      ) : null}
      <div style={{ marginBottom: 8 }}>
        <Space>
          <Typography.Text strong>Recent agent sessions</Typography.Text>
          <Button
            size="small"
            type="link"
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
        <List
          dataSource={visibleSessions}
          renderItem={(session) => renderSession(session)}
          size="small"
        />
      )}
    </div>,
  );
}
