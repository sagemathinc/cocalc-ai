import {
  Alert,
  Button,
  Collapse,
  Input,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { CodexActivity } from "@cocalc/frontend/chat/codex-activity";
import {
  DEFAULT_CODEX_MODELS,
  type CodexReasoningId,
  type CodexSessionConfig,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";

type TurnStatus = "running" | "completed" | "failed" | "interrupted";

type TurnEntry = {
  id: string;
  prompt: string;
  status: TurnStatus;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  sessionIdAtStart?: string;
  sessionIdAtEnd?: string;
  requestConfig?: CodexSessionConfig;
  finalResponse?: string;
  error?: string;
  events: AcpStreamMessage[];
};

const SESSION_KEY_PREFIX = "cocalc:navigator:acp-session";
const CONFIG_KEY_PREFIX = "cocalc:navigator:acp-config";
const SESSION_MODE_OPTIONS: Array<{
  value: CodexSessionMode;
  label: string;
}> = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "full-access", label: "Full access" },
];
const NAVIGATOR_MODELS = DEFAULT_CODEX_MODELS.filter((m) =>
  m.name.includes("codex"),
);

function defaultModelName(): string {
  return NAVIGATOR_MODELS[0]?.name ?? DEFAULT_CODEX_MODELS[0]?.name ?? "";
}

function defaultReasoningForModel(modelName: string): CodexReasoningId | undefined {
  const model = NAVIGATOR_MODELS.find((m) => m.name === modelName);
  const reasoning =
    model?.reasoning?.find((entry) => entry.default)?.id ??
    model?.reasoning?.[0]?.id;
  return reasoning;
}

function prettify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatElapsed(ms?: number): string {
  if (ms == null) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function storageKey(projectId: string): string {
  return `${SESSION_KEY_PREFIX}:${projectId}`;
}

function configStorageKey(projectId: string): string {
  return `${CONFIG_KEY_PREFIX}:${projectId}`;
}

interface NavigatorShellProps {
  project_id: string;
}

export function NavigatorShell({ project_id }: NavigatorShellProps) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turns, setTurns] = useState<TurnEntry[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [model, setModel] = useState<string>(defaultModelName());
  const [reasoning, setReasoning] = useState<CodexReasoningId | undefined>(
    defaultReasoningForModel(defaultModelName()),
  );
  const [sessionMode, setSessionMode] = useState<CodexSessionMode>("read-only");
  const [showAdvancedTrace, setShowAdvancedTrace] = useState(false);
  const stopRequestedRef = useRef(false);
  const latestTurn = turns[0];

  useEffect(() => {
    try {
      const value = localStorage.getItem(storageKey(project_id)) ?? "";
      setSessionId(value);
    } catch {
      setSessionId("");
    }
    try {
      const raw = localStorage.getItem(configStorageKey(project_id)) ?? "";
      if (!raw) return;
      const cfg = JSON.parse(raw) as {
        model?: string;
        reasoning?: CodexReasoningId;
        sessionMode?: CodexSessionMode;
      };
      const model0 =
        typeof cfg.model === "string" && cfg.model.trim()
          ? cfg.model
          : defaultModelName();
      const sessionMode0 =
        cfg.sessionMode === "read-only" ||
        cfg.sessionMode === "workspace-write" ||
        cfg.sessionMode === "full-access"
          ? cfg.sessionMode
          : "read-only";
      const modelInfo = NAVIGATOR_MODELS.find((m) => m.name === model0);
      const reasoning0 = modelInfo?.reasoning?.some((entry) => entry.id === cfg.reasoning)
        ? cfg.reasoning
        : defaultReasoningForModel(model0);
      setModel(model0);
      setReasoning(reasoning0);
      setSessionMode(sessionMode0);
    } catch {}
  }, [project_id]);

  function saveSessionId(value?: string) {
    const next = value?.trim() ?? "";
    setSessionId(next);
    try {
      const key = storageKey(project_id);
      if (next) {
        localStorage.setItem(key, next);
      } else {
        localStorage.removeItem(key);
      }
    } catch {}
  }

  function updateTurn(id: string, update: (turn: TurnEntry) => TurnEntry) {
    setTurns((cur) => cur.map((turn) => (turn.id === id ? update(turn) : turn)));
  }

  function saveConfig(next: {
    model: string;
    reasoning?: CodexReasoningId;
    sessionMode: CodexSessionMode;
  }) {
    try {
      localStorage.setItem(configStorageKey(project_id), JSON.stringify(next));
    } catch {}
  }

  function onChangeModel(value: string) {
    const nextReasoning = defaultReasoningForModel(value);
    setModel(value);
    setReasoning(nextReasoning);
    saveConfig({
      model: value,
      reasoning: nextReasoning,
      sessionMode,
    });
  }

  function onChangeReasoning(value?: CodexReasoningId) {
    setReasoning(value);
    saveConfig({
      model,
      reasoning: value,
      sessionMode,
    });
  }

  function onChangeSessionMode(value: CodexSessionMode) {
    setSessionMode(value);
    saveConfig({
      model,
      reasoning,
      sessionMode: value,
    });
  }

  async function runAction() {
    const text = prompt.trim();
    if (!text || busy) return;
    setError("");
    setBusy(true);
    stopRequestedRef.current = false;

    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const turnId = `nav-${startedMs}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionAtStart = sessionId || undefined;
    let sessionAtEnd = sessionAtStart;
    let finalResponse = "";
    const events: AcpStreamMessage[] = [];
    const requestConfig: CodexSessionConfig = {
      model,
      reasoning,
      sessionMode,
      allowWrite: sessionMode !== "read-only",
    };

    setTurns((cur) => [
      {
        id: turnId,
        prompt: text,
        status: "running",
        startedAt,
        sessionIdAtStart: sessionAtStart,
        requestConfig,
        events: [],
      },
      ...cur,
    ]);

    try {
      const stream = await webapp_client.conat_client.streamAcp({
        project_id,
        prompt: text,
        session_id: sessionAtStart,
        config: requestConfig,
      });
      for await (const message of stream) {
        events.push(message);
        if (message.type === "summary") {
          finalResponse = message.finalResponse ?? finalResponse;
          const threadId =
            typeof message.threadId === "string" ? message.threadId : "";
          if (threadId) {
            sessionAtEnd = threadId;
            saveSessionId(threadId);
          }
        }
        if (message.type === "error") {
          setError(message.error);
        }
        updateTurn(turnId, (turn) => ({
          ...turn,
          events: [...events],
          finalResponse: finalResponse || turn.finalResponse,
          sessionIdAtEnd: sessionAtEnd,
        }));
      }

      const finishedMs = Date.now();
      const finishedAt = new Date(finishedMs).toISOString();
      const hasError = events.some((message) => message.type === "error");
      updateTurn(turnId, (turn) => ({
        ...turn,
        status: hasError
          ? stopRequestedRef.current
            ? "interrupted"
            : "failed"
          : "completed",
        finishedAt,
        elapsedMs: finishedMs - startedMs,
        events: [...events],
        finalResponse,
        sessionIdAtEnd: sessionAtEnd,
      }));
    } catch (err) {
      const finishedMs = Date.now();
      const finishedAt = new Date(finishedMs).toISOString();
      const message = `${err}`;
      setError(message);
      updateTurn(turnId, (turn) => ({
        ...turn,
        status: stopRequestedRef.current ? "interrupted" : "failed",
        finishedAt,
        elapsedMs: finishedMs - startedMs,
        error: message,
        events: [...events],
        finalResponse,
        sessionIdAtEnd: sessionAtEnd,
      }));
    } finally {
      setBusy(false);
      stopRequestedRef.current = false;
    }
  }

  async function stopAction() {
    if (!busy) return;
    stopRequestedRef.current = true;
    setError("");
    const threadId =
      sessionId || latestTurn?.sessionIdAtEnd || latestTurn?.sessionIdAtStart;
    try {
      await webapp_client.conat_client.interruptAcp({
        project_id,
        threadId,
        note: "navigator-shell interrupt",
      });
    } catch (err) {
      setError(`Unable to stop current run: ${err}`);
    }
  }

  function resetSession() {
    saveSessionId("");
  }

  const latestStatusColor: Record<TurnStatus, string> = {
    running: "processing",
    completed: "success",
    failed: "error",
    interrupted: "warning",
  };

  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <h4 style={{ margin: 0 }}>Ask CoCalc</h4>
        <Tag color="blue">Lite</Tag>
        <Tag color="cyan">Codex</Tag>
      </div>
      <Typography.Paragraph
        type="secondary"
        style={{ marginBottom: "8px", marginTop: "6px" }}
      >
        Global navigator shell using the same ACP/Codex runtime as chat, but not
        tied to a .chat file.
      </Typography.Paragraph>
      {error ? (
        <Alert
          type="error"
          showIcon
          message="Navigator request failed"
          description={error}
          style={{ marginBottom: 8 }}
        />
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Input
          size="large"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what you want to do, e.g. move b.txt to archive/"
          onPressEnter={() => runAction()}
        />
        <Button
          size="large"
          type="primary"
          onClick={runAction}
          loading={busy}
          disabled={busy}
        >
          Run
        </Button>
        <Button
          size="large"
          danger
          onClick={stopAction}
          disabled={!busy}
        >
          Stop
        </Button>
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        <Select
          size="small"
          style={{ minWidth: 220 }}
          value={model}
          options={NAVIGATOR_MODELS.map((entry) => ({
            value: entry.name,
            label: entry.name,
          }))}
          onChange={(value) => onChangeModel(value)}
          disabled={busy}
        />
        <Select
          size="small"
          style={{ minWidth: 160 }}
          value={reasoning}
          options={
            NAVIGATOR_MODELS.find((entry) => entry.name === model)?.reasoning?.map(
              (entry) => ({
                value: entry.id,
                label: entry.label,
              }),
            ) ?? []
          }
          onChange={(value) => onChangeReasoning(value)}
          disabled={busy}
          placeholder="Reasoning"
        />
        <Select
          size="small"
          style={{ minWidth: 170 }}
          value={sessionMode}
          options={SESSION_MODE_OPTIONS}
          onChange={(value) => onChangeSessionMode(value)}
          disabled={busy}
        />
      </div>
      <Space style={{ marginTop: 8 }} size={8} wrap>
        {latestTurn ? (
          <>
            <Tag color={latestStatusColor[latestTurn.status]}>
              {latestTurn.status}
            </Tag>
            <Tag>Elapsed: {formatElapsed(latestTurn.elapsedMs)}</Tag>
          </>
        ) : (
          <Tag color="orange">No runs yet</Tag>
        )}
        <Tag color={sessionId ? "green" : "default"}>
          Session: {sessionId || "new"}
        </Tag>
        <Tag>{model}</Tag>
        <Tag>{reasoning ?? "default reasoning"}</Tag>
        <Tag>Mode: {sessionMode}</Tag>
        <Button size="small" onClick={resetSession} disabled={busy || !sessionId}>
          Reset session
        </Button>
        <Button size="small" onClick={() => setShowAdvancedTrace((v) => !v)}>
          {showAdvancedTrace ? "Hide advanced trace" : "Advanced trace"}
        </Button>
      </Space>
      {latestTurn?.finalResponse ? (
        <Input.TextArea
          style={{ marginTop: 8 }}
          value={latestTurn.finalResponse}
          readOnly
          autoSize={{ minRows: 5, maxRows: 16 }}
          placeholder="Final response appears here..."
        />
      ) : null}
      {latestTurn?.events?.length ? (
        <div style={{ marginTop: 8 }}>
          <CodexActivity
            events={latestTurn.events}
            generating={busy && latestTurn.status === "running"}
            durationLabel={formatElapsed(latestTurn.elapsedMs)}
            persistKey={`navigator-shell:${project_id}:${latestTurn.id}`}
            projectId={project_id}
            expanded={false}
          />
        </div>
      ) : null}
      {showAdvancedTrace && turns.length > 0 ? (
        <Collapse
          style={{ marginTop: 8 }}
          size="small"
          items={turns.map((turn) => ({
            key: turn.id,
            label: `${turn.status.toUpperCase()} • ${turn.prompt}`,
            extra: `${turn.startedAt} • ${formatElapsed(turn.elapsedMs)}`,
            children: (
              <Input.TextArea
                value={prettify({
                  startedAt: turn.startedAt,
                  finishedAt: turn.finishedAt,
                  elapsedMs: turn.elapsedMs,
                  status: turn.status,
                  prompt: turn.prompt,
                  sessionIdAtStart: turn.sessionIdAtStart,
                  sessionIdAtEnd: turn.sessionIdAtEnd,
                  requestConfig: turn.requestConfig,
                  finalResponse: turn.finalResponse,
                  error: turn.error,
                  events: turn.events,
                })}
                readOnly
                autoSize={{ minRows: 8, maxRows: 18 }}
              />
            ),
          }))}
        />
      ) : null}
    </div>
  );
}
