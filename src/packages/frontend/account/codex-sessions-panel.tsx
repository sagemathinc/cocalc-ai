/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AiSessionInterruptAllResponse,
  AiSessionRecord,
  AiSessionState,
} from "@cocalc/conat/hub/api/ai-sessions";
import { Button, Card, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";

import { webapp_client } from "@cocalc/frontend/webapp-client";

const { Paragraph, Text } = Typography;

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

export default function CodexSessionsPanel() {
  const [sessions, setSessions] = useState<AiSessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>("");
  const [lastStopResult, setLastStopResult] =
    useState<AiSessionInterruptAllResponse | null>(null);

  const refresh = async () => {
    try {
      setLoading(true);
      setError("");
      const result = await webapp_client.conat_client.hub.aiSessions.list({
        limit: 50,
      });
      setSessions(result);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
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
      await refresh();
      if (result.uncertain > 0) {
        message.warning(
          `${result.uncertain} Codex session interrupt could not be confirmed.`,
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
      render: (_, session) => (
        <Space direction="vertical" size={0}>
          <Text strong>{titleForSession(session)}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {session.path || session.project_id}
          </Text>
        </Space>
      ),
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
