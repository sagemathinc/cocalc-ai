import { Alert, Button, Collapse, Input, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentManifestEntry,
  AgentPlanResponse,
} from "@cocalc/conat/hub/api/agent";
import { webapp_client } from "@cocalc/frontend/webapp-client";

type ActionEnvelope = AgentExecuteRequest["action"];

type ResultEntry = {
  ts: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  prompt: string;
  label: string;
  mode: "plan" | "preview" | "run" | "confirm" | "manifest";
  response: unknown;
};

type PendingConfirmation = {
  actions: ActionEnvelope[];
  stepIndex: number;
  label: string;
  prompt: string;
  dryRun: boolean;
};

function prettify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatElapsed(ms?: number): string {
  if (ms == null) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 1000).toFixed(1)} s`;
}

interface NavigatorShellProps {
  project_id: string;
}

export function NavigatorShell({ project_id }: NavigatorShellProps) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"" | "plan" | "execute" | "manifest">("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<ResultEntry[]>([]);
  const [manifest, setManifest] = useState<AgentManifestEntry[] | null>(null);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);
  const [plannedAction, setPlannedAction] = useState<ActionEnvelope | null>(
    null,
  );
  const [plannedActions, setPlannedActions] = useState<ActionEnvelope[]>([]);
  const [showAdvancedTrace, setShowAdvancedTrace] = useState(false);

  const manifestByAction = useMemo(() => {
    const map = new Map<string, AgentManifestEntry>();
    for (const entry of manifest ?? []) {
      map.set(entry.actionType, entry);
    }
    return map;
  }, [manifest]);

  async function executeAction({
    action,
    label,
    promptText,
    mode,
    confirmationToken,
  }: {
    action: ActionEnvelope;
    label: string;
    promptText: string;
    mode: ResultEntry["mode"];
    confirmationToken?: string;
  }): Promise<AgentExecuteResponse> {
    setError("");
    try {
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      const response: AgentExecuteResponse =
        await webapp_client.conat_client.agent.execute({
          action,
          defaults: { projectId: project_id },
          confirmationToken,
        });
      const finishedMs = Date.now();
      const finishedAt = new Date(finishedMs).toISOString();
      setHistory((cur) => [
        {
          ts: finishedAt,
          startedAt,
          finishedAt,
          elapsedMs: finishedMs - startedMs,
          prompt: promptText,
          label,
          mode,
          response,
        },
        ...cur,
      ]);
      return response;
    } catch (err) {
      setError(`${err}`);
      throw err;
    }
  }

  async function planPrompt(
    promptText: string
  ): Promise<{ actions: ActionEnvelope[]; label: string }> {
    const text = promptText.trim();
    if (!text) {
      throw Error("Please enter a prompt.");
    }
    setError("");
    setBusy("plan");
    try {
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      const response: AgentPlanResponse = await webapp_client.conat_client.agent.plan(
        {
          prompt: text,
          defaults: { projectId: project_id },
          manifest: manifest ?? undefined,
        },
      );
      const finishedMs = Date.now();
      const finishedAt = new Date(finishedMs).toISOString();
      if (response.status !== "planned" || !response.plan?.actions?.length) {
        throw Error(response.error ?? "Planner did not return an action.");
      }
      const actions = response.plan.actions;
      const firstAction = actions[0];
      setPlannedAction(firstAction);
      setPlannedActions(actions);
      const label =
        response.plan.summary?.trim() ||
        `Planned ${actions.length} action${actions.length === 1 ? "" : "s"}`;
      setHistory((cur) => [
        {
          ts: finishedAt,
          startedAt,
          finishedAt,
          elapsedMs: finishedMs - startedMs,
          prompt: text,
          label,
          mode: "plan",
          response,
        },
        ...cur,
      ]);
      return { actions, label };
    } finally {
      setBusy("");
    }
  }

  async function executePlannedActions({
    actions,
    label,
    promptText,
    dryRun,
    mode,
    startIndex = 0,
    confirmationToken,
  }: {
    actions: ActionEnvelope[];
    label: string;
    promptText: string;
    dryRun: boolean;
    mode: "run" | "preview" | "confirm";
    startIndex?: number;
    confirmationToken?: string;
  }) {
    if (actions.length === 0) {
      throw Error("Planner returned no actions.");
    }
    setBusy("execute");
    try {
      let token = confirmationToken;
      for (let i = startIndex; i < actions.length; i++) {
        const baseAction = actions[i];
        const action: ActionEnvelope = { ...baseAction, dryRun };
        const response = await executeAction({
          action,
          label: `${label} • step ${i + 1}/${actions.length}: ${baseAction.actionType}`,
          promptText,
          mode: mode === "confirm" ? "confirm" : mode,
          confirmationToken: token,
        });
        token = undefined;
        if (
          response.status === "blocked" &&
          response.requiresConfirmation &&
          !confirmationToken
        ) {
          setPendingConfirmation({
            actions,
            stepIndex: i,
            label,
            prompt: promptText,
            dryRun,
          });
          return;
        }
        if (response.status !== "completed") {
          return;
        }
      }
      setPendingConfirmation(null);
    } finally {
      setBusy("");
    }
  }

  async function runAction() {
    try {
      const promptText = prompt.trim();
      const planned = await planPrompt(promptText);
      await executePlannedActions({
        actions: planned.actions,
        label: planned.label,
        promptText,
        dryRun: false,
        mode: "run",
      });
    } catch (err) {
      setError(`${err}`);
    }
  }

  async function previewAction() {
    try {
      const promptText = prompt.trim();
      const planned = await planPrompt(promptText);
      await executePlannedActions({
        actions: planned.actions,
        label: `Preview: ${planned.label}`,
        promptText,
        dryRun: true,
        mode: "preview",
      });
    } catch (err) {
      setError(`${err}`);
    }
  }

  async function confirmAction() {
    if (!pendingConfirmation) return;
    await executePlannedActions({
      actions: pendingConfirmation.actions,
      label: `Confirmed: ${pendingConfirmation.label}`,
      promptText: pendingConfirmation.prompt,
      dryRun: pendingConfirmation.dryRun,
      mode: "confirm",
      startIndex: pendingConfirmation.stepIndex,
      confirmationToken: "user-confirmed",
    });
  }

  async function loadManifest() {
    setError("");
    setBusy("manifest");
    try {
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      const value = await webapp_client.conat_client.agent.manifest();
      const finishedMs = Date.now();
      const finishedAt = new Date(finishedMs).toISOString();
      setManifest(value);
      setHistory((cur) => [
        {
          ts: finishedAt,
          startedAt,
          finishedAt,
          elapsedMs: finishedMs - startedMs,
          prompt: "manifest",
          label: "Capability manifest",
          mode: "manifest",
          response: value,
        },
        ...cur,
      ]);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy("");
    }
  }

  const lastResult = history[0];

  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <h4 style={{ margin: 0 }}>Ask CoCalc (Preview)</h4>
        <Tag color="blue">Lite</Tag>
      </div>
      <Typography.Paragraph
        type="secondary"
        style={{ marginBottom: "8px", marginTop: "6px" }}
      >
        LLM planner over `hub.agent.plan` with policy-gated execution via
        `hub.agent.execute`.
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
      {pendingConfirmation ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message="Confirmation required"
          description={
            <div>
              <div style={{ marginBottom: 8 }}>
                This action was blocked pending confirmation:
                <code style={{ marginLeft: 6 }}>{pendingConfirmation.actions[pendingConfirmation.stepIndex]?.actionType}</code>
              </div>
              <Space>
                <Button
                  type="primary"
                  size="small"
                  onClick={confirmAction}
                  loading={busy === "execute"}
                  disabled={busy !== ""}
                >
                  Confirm & Run
                </Button>
                <Button
                  size="small"
                  onClick={() => setPendingConfirmation(null)}
                  disabled={busy !== ""}
                >
                  Cancel
                </Button>
              </Space>
            </div>
          }
        />
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Input
          size="large"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what you want to do, e.g. read a.txt or start vscode"
          onPressEnter={() => runAction()}
        />
        <Button
          size="large"
          onClick={previewAction}
          loading={busy === "plan" || busy === "execute"}
          disabled={busy !== ""}
        >
          Preview
        </Button>
        <Button
          size="large"
          type="primary"
          onClick={runAction}
          loading={busy === "plan" || busy === "execute"}
          disabled={busy !== ""}
        >
          Run
        </Button>
      </div>
      <Space style={{ marginTop: 8 }} size={8} wrap>
        {plannedAction ? (
          <>
            <Tag color="green">{plannedAction.actionType}</Tag>
            <Tag>
              {plannedActions.length} step{plannedActions.length === 1 ? "" : "s"}
            </Tag>
            {manifestByAction.get(plannedAction.actionType)?.riskLevel ? (
              <Tag>
                Risk: {manifestByAction.get(plannedAction.actionType)?.riskLevel}
              </Tag>
            ) : null}
            {manifestByAction.get(plannedAction.actionType)
              ?.requiresConfirmationByDefault ? (
              <Tag color="gold">Confirm by default</Tag>
            ) : null}
          </>
        ) : (
          <Tag color="orange">No plan yet</Tag>
        )}
        <Button
          size="small"
          onClick={loadManifest}
          loading={busy === "manifest"}
          disabled={busy !== ""}
        >
          Refresh manifest
        </Button>
        {manifest ? <Tag>{manifest.length} capabilities</Tag> : null}
      </Space>
      <Space style={{ marginTop: 8 }} size={8}>
        <Button size="small" onClick={() => setShowAdvancedTrace((v) => !v)}>
          {showAdvancedTrace ? "Hide advanced trace" : "Advanced trace"}
        </Button>
        {lastResult?.elapsedMs != null ? (
          <Tag color="purple">Last elapsed: {formatElapsed(lastResult.elapsedMs)}</Tag>
        ) : null}
      </Space>
      {plannedActions.length > 1 ? (
        <Alert
          style={{ marginTop: 8 }}
          type="info"
          showIcon
          message="This shell executes all planned steps sequentially."
          description="If a step requires confirmation, execution pauses and resumes after you confirm."
        />
      ) : null}
      {plannedAction ? (
        <Input.TextArea
          style={{ marginTop: 8 }}
          value={prettify(plannedActions)}
          readOnly
          autoSize={{ minRows: 4, maxRows: 10 }}
          placeholder="Planned actions appear here..."
        />
      ) : null}
      <Input.TextArea
        style={{ marginTop: 8 }}
        value={
          lastResult
            ? prettify({
                at: lastResult.ts,
                startedAt: lastResult.startedAt,
                finishedAt: lastResult.finishedAt,
                elapsedMs: lastResult.elapsedMs,
                mode: lastResult.mode,
                prompt: lastResult.prompt,
                label: lastResult.label,
                result: lastResult.response,
              })
            : ""
        }
        readOnly
        autoSize={{ minRows: 8, maxRows: 20 }}
        placeholder="Latest result appears here..."
      />
      {showAdvancedTrace && history.length > 0 ? (
        <Collapse
          style={{ marginTop: 8 }}
          size="small"
          items={history.map((entry, i) => ({
            key: `${entry.ts}-${i}`,
            label: `${entry.mode.toUpperCase()} • ${entry.label}`,
            extra: `${entry.ts} • ${formatElapsed(entry.elapsedMs)}`,
            children: (
              <Input.TextArea
                value={prettify({
                  at: entry.ts,
                  startedAt: entry.startedAt,
                  finishedAt: entry.finishedAt,
                  elapsedMs: entry.elapsedMs,
                  prompt: entry.prompt,
                  label: entry.label,
                  mode: entry.mode,
                  response: entry.response,
                })}
                readOnly
                autoSize={{ minRows: 6, maxRows: 14 }}
              />
            ),
          }))}
        />
      ) : null}
    </div>
  );
}
