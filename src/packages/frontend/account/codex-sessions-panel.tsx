/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AiSessionInterruptAllResponse,
  AiSessionInterruptResponse,
  AiSessionRecord,
  AiSessionState,
} from "@cocalc/conat/hub/api/ai-sessions";
import { Button, Card, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";

import {
  buildProjectFilesTarget,
  getProjectUrlPath,
} from "@cocalc/frontend/project-routing";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { encode_path } from "@cocalc/util/misc";

const { Paragraph, Text } = Typography;
const CONFIRM_INTERRUPT_POLL_ATTEMPTS = 5;
const CONFIRM_INTERRUPT_POLL_MS = 1_000;

const ACTIVE_STATES = new Set<AiSessionState>([
  "queued",
  "running",
  "interrupting",
]);

const UNCERTAIN_STATES = new Set<AiSessionState>([
  "possibly_active",
  "orphaned",
  "unknown",
]);

function isMoneyRiskSession(session: AiSessionRecord): boolean {
  return !session.terminal;
}

function formatTime(value: AiSessionRecord["updated_at"]): string {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function stateColor(state: AiSessionState): string {
  if (ACTIVE_STATES.has(state)) return "processing";
  if (UNCERTAIN_STATES.has(state)) return "warning";
  if (state === "failed") return "error";
  if (state === "interrupted" || state === "canceled") return "default";
  if (state === "completed") return "success";
  if (state === "host_stopped") return "blue";
  return "default";
}

function paymentSource(session: AiSessionRecord): string {
  return (
    session.payment_source_label ||
    session.payment_source_kind ||
    session.payment_source_id ||
    "unknown"
  );
}

function titleForSession(session: AiSessionRecord): string {
  return (
    session.title ||
    session.prompt_snippet ||
    session.path ||
    session.session_id ||
    session.session_key
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeProjectRelativePath(path: string): string {
  const relativePath = path.replace(/^\/+/, "");
  return relativePath ? encode_path(relativePath) : "";
}

function chatHref(session: AiSessionRecord): string | undefined {
  if (!session.project_id || !session.path) return;
  return getProjectUrlPath(
    session.project_id,
    buildProjectFilesTarget(session.path, false, {
      encodeRelativePath: encodeProjectRelativePath,
    }),
  );
}

function sessionId(session: AiSessionRecord): string {
  return session.session_key || session.session_id || session.op_id || "";
}

function hasMoneyRiskSession(
  sessions: AiSessionRecord[],
  target: AiSessionRecord,
): boolean {
  const targetId = sessionId(target);
  return sessions.some(
    (session) => sessionId(session) === targetId && isMoneyRiskSession(session),
  );
}

export default function CodexSessionsPanel() {
  const [sessions, setSessions] = useState<AiSessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [interrupting, setInterrupting] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>("");
  const [lastStopResult, setLastStopResult] =
    useState<AiSessionInterruptAllResponse | null>(null);

  const refresh = async (): Promise<AiSessionRecord[]> => {
    try {
      setLoading(true);
      setError("");
      const result = await webapp_client.conat_client.hub.aiSessions.list({
        limit: 50,
      });
      setSessions(result);
      return result;
    } catch (err) {
      setError(`${err}`);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const refreshWithConfirmation = async (): Promise<AiSessionRecord[]> => {
    let result = await refresh();
    for (let i = 0; i < CONFIRM_INTERRUPT_POLL_ATTEMPTS; i++) {
      if (!result.some(isMoneyRiskSession)) {
        return result;
      }
      await sleep(CONFIRM_INTERRUPT_POLL_MS);
      result = await refresh();
    }
    return result;
  };

  const interruptSession = async (session: AiSessionRecord) => {
    const key = sessionId(session);
    if (!key) return;
    setInterrupting((prev) => new Set(prev).add(key));
    try {
      setError("");
      const result: AiSessionInterruptResponse =
        await webapp_client.conat_client.hub.aiSessions.interrupt({
          session_key: session.session_key,
          session_id: session.session_id ?? undefined,
          op_id: session.op_id ?? undefined,
          note: "Requested from account AI settings",
        });
      const refreshed = result.terminal
        ? await refresh()
        : await refreshWithConfirmation();
      if (result.terminal || !hasMoneyRiskSession(refreshed, session)) {
        message.success("Codex session is no longer confirmed active.");
      } else {
        message.warning("Codex session interrupt could not be confirmed.");
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setInterrupting((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const stopAll = async () => {
    try {
      setStopping(true);
      setError("");
      const result =
        await webapp_client.conat_client.hub.aiSessions.interruptAll({
          limit: 100,
          note: "Requested from account AI settings",
        });
      setLastStopResult(result);
      const refreshed =
        result.uncertain > 0
          ? await refreshWithConfirmation()
          : await refresh();
      const remaining = refreshed.filter(isMoneyRiskSession).length;
      if (remaining > 0) {
        message.warning(
          `${remaining} Codex session interrupt could not be confirmed.`,
        );
      } else {
        message.success("No active Codex session remains confirmed running.");
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setStopping(false);
    }
  };

  useEffect(() => {
    refresh().catch((err) => setError(`${err}`));
  }, []);

  const moneyRisk = sessions.filter(isMoneyRiskSession);
  const active = sessions.filter((session) => ACTIVE_STATES.has(session.state));
  const uncertain = sessions.filter((session) =>
    UNCERTAIN_STATES.has(session.state),
  );

  const columns: ColumnsType<AiSessionRecord> = [
    {
      title: "State",
      dataIndex: "state",
      key: "state",
      render: (state: AiSessionState) => (
        <Tag color={stateColor(state)}>{state}</Tag>
      ),
      width: 140,
    },
    {
      title: "Session",
      key: "session",
      render: (_, session) => {
        const href = chatHref(session);
        return (
          <Space direction="vertical" size={0}>
            <Text strong>{titleForSession(session)}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {session.path || session.project_id}
            </Text>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                Open chat
              </a>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: "Model",
      dataIndex: "model",
      key: "model",
      render: (model: string | null) => model || "-",
      width: 140,
    },
    {
      title: "Payment",
      key: "payment",
      render: (_, session) => paymentSource(session),
      width: 180,
    },
    {
      title: "Updated",
      dataIndex: "updated_at",
      key: "updated_at",
      render: formatTime,
      width: 150,
    },
    {
      title: "Actions",
      key: "actions",
      render: (_, session) => {
        const key = sessionId(session);
        return (
          <Button
            danger
            disabled={!isMoneyRiskSession(session) || !key}
            loading={key ? interrupting.has(key) : false}
            onClick={() => void interruptSession(session)}
            size="small"
          >
            Interrupt
          </Button>
        );
      },
      width: 120,
    },
  ];

  return (
    <Card
      title="Codex sessions"
      extra={
        <Space>
          <Button onClick={refresh} loading={loading}>
            Refresh
          </Button>
          <Button
            danger
            disabled={moneyRisk.length === 0}
            loading={stopping}
            onClick={stopAll}
          >
            Stop all active or uncertain
          </Button>
        </Space>
      }
      style={{ marginTop: 24 }}
    >
      <Paragraph type="secondary">
        This shows your current and recent Codex sessions. Sessions remain
        visible here until the backend has written a terminal state, so a failed
        interrupt or stale heartbeat stays visible as possible AI resource use.
      </Paragraph>
      {error ? (
        <Paragraph type="danger" style={{ marginBottom: 12 }}>
          {error}
        </Paragraph>
      ) : null}
      <Space wrap style={{ marginBottom: 12 }}>
        <Tag color={moneyRisk.length ? "warning" : "success"}>
          {moneyRisk.length} may be active
        </Tag>
        <Tag color="processing">{active.length} active</Tag>
        <Tag color={uncertain.length ? "warning" : "default"}>
          {uncertain.length} uncertain
        </Tag>
        {lastStopResult ? (
          <Tag>
            Last stop: {lastStopResult.terminal} terminal,{" "}
            {lastStopResult.uncertain} uncertain
          </Tag>
        ) : null}
      </Space>
      <Table
        columns={columns}
        dataSource={sessions}
        loading={loading}
        pagination={{ pageSize: 10 }}
        rowKey="session_key"
        size="small"
      />
    </Card>
  );
}
