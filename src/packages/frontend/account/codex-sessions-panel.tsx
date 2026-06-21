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
import { useEffect, useMemo, useState } from "react";

import { redux } from "@cocalc/frontend/app-framework";
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

type CodexSessionGroup = {
  key: string;
  latest: AiSessionRecord;
  turns: AiSessionRecord[];
  interruptTarget?: AiSessionRecord;
};

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
  const metadata = sessionMetadata(session);
  const authSource =
    typeof metadata.auth_source === "string" ? metadata.auth_source : "";
  if (
    !session.payment_source_label &&
    (!session.payment_source_kind || session.payment_source_kind === "unknown")
  ) {
    if (authSource === "subscription") return "ChatGPT Plan";
    if (authSource === "account-api-key") return "OpenAI account API key";
    if (authSource === "project-api-key") return "Project OpenAI API key";
    if (authSource === "site-api-key") return "Site OpenAI API key";
    if (authSource === "shared-home") return "Local Codex auth";
  }
  return (
    session.payment_source_label ||
    session.payment_source_kind ||
    session.payment_source_id ||
    "Unknown payment source"
  );
}

function sessionMetadata(session: AiSessionRecord): Record<string, unknown> {
  if (session.metadata && typeof session.metadata === "object") {
    return session.metadata;
  }
  const raw = session.metadata_json;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function compactValue(value: unknown): string | undefined {
  const text = `${value ?? ""}`.trim();
  return text || undefined;
}

function modelLabel(session: AiSessionRecord): string {
  const metadata = sessionMetadata(session);
  return (
    [
      compactValue(session.model),
      compactValue(metadata.reasoning),
      compactValue(metadata.service_tier),
      compactValue(metadata.session_mode),
    ]
      .filter(Boolean)
      .join(" / ") || "-"
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
  const relativePath = projectRelativePath(path);
  return relativePath ? encode_path(relativePath) : "";
}

function projectRelativePath(path: string): string {
  return `${path ?? ""}`
    .trim()
    .replace(/^\/home\/user\/?/, "")
    .replace(/^\/+/, "");
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

function sessionGroupKey(session: AiSessionRecord): string {
  return (
    session.session_id ||
    session.thread_id ||
    `${session.project_id}:${session.path ?? ""}` ||
    sessionId(session)
  );
}

function timeMs(value: AiSessionRecord["updated_at"]): number {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function groupSessions(sessions: AiSessionRecord[]): CodexSessionGroup[] {
  const groups = new Map<string, AiSessionRecord[]>();
  for (const session of sessions) {
    const key = sessionGroupKey(session);
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return Array.from(groups.entries())
    .map(([key, turns]) => {
      const sorted = turns
        .slice()
        .sort((a, b) => timeMs(b.updated_at) - timeMs(a.updated_at));
      const latest = sorted[0]!;
      return {
        key,
        latest,
        turns: sorted,
        interruptTarget: sorted.find(isMoneyRiskSession),
      };
    })
    .sort((a, b) => timeMs(b.latest.updated_at) - timeMs(a.latest.updated_at));
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
  const groupedSessions = useMemo(() => groupSessions(sessions), [sessions]);

  const openChat = async (session: AiSessionRecord) => {
    if (!session.project_id || !session.path) return;
    const path = projectRelativePath(session.path);
    try {
      const actions = redux.getProjectActions(session.project_id);
      await actions.ensureProjectIsOpen(true);
      await actions.open_file({ path, foreground: true });
    } catch (err) {
      const href = chatHref(session);
      if (href) {
        window.location.href = href;
        return;
      }
      setError(`${err}`);
    }
  };

  const columns: ColumnsType<CodexSessionGroup> = [
    {
      title: "State",
      key: "state",
      render: (_, group) => (
        <Tag color={stateColor(group.latest.state)}>{group.latest.state}</Tag>
      ),
      width: 140,
    },
    {
      title: "Session",
      key: "session",
      render: (_, group) => {
        const session = group.latest;
        return (
          <Space direction="vertical" size={0}>
            <Text strong>{titleForSession(session)}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {session.path || session.project_id}
            </Text>
            {session.project_id && session.path ? (
              <Button
                type="link"
                size="small"
                style={{ padding: 0, height: "auto" }}
                onClick={() => void openChat(session)}
              >
                Open chat
              </Button>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: "Turns",
      key: "turns",
      render: (_, group) => group.turns.length,
      width: 80,
    },
    {
      title: "Model",
      key: "model",
      render: (_, group) => modelLabel(group.latest),
      width: 190,
    },
    {
      title: "Payment",
      key: "payment",
      render: (_, group) => paymentSource(group.latest),
      width: 180,
    },
    {
      title: "Updated",
      key: "updated_at",
      render: (_, group) => formatTime(group.latest.updated_at),
      width: 150,
    },
    {
      title: "Actions",
      key: "actions",
      render: (_, group) => {
        const session = group.interruptTarget;
        const key = session ? sessionId(session) : "";
        return (
          <Button
            danger
            disabled={!session || !key}
            loading={key ? interrupting.has(key) : false}
            onClick={() => session && void interruptSession(session)}
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
        This shows one row per Codex session, using the latest turn for the
        state, model, and payment source. Sessions remain visible here until the
        backend has written terminal states for their turns, so a failed
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
        dataSource={groupedSessions}
        loading={loading}
        pagination={{ pageSize: 10 }}
        rowKey="key"
        size="small"
      />
    </Card>
  );
}
