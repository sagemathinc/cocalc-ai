import { Alert, Button, Input, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentManifestEntry,
} from "@cocalc/conat/hub/api/agent";
import { webapp_client } from "@cocalc/frontend/webapp-client";

type ActionEnvelope = AgentExecuteRequest["action"];

type ParsedPrompt =
  | {
      action: ActionEnvelope;
      label: string;
    }
  | { error: string };

type ResultEntry = {
  ts: string;
  prompt: string;
  label: string;
  mode: "preview" | "run" | "confirm" | "manifest";
  response: unknown;
};

type PendingConfirmation = {
  action: ActionEnvelope;
  label: string;
  prompt: string;
};

function parsePrompt(prompt: string): ParsedPrompt {
  const text = prompt.trim();
  if (!text) {
    return { error: "Please enter a command." };
  }
  if (/^ping$/i.test(text)) {
    return {
      label: "Ping hub",
      action: { actionType: "hub.system.ping", args: {} },
    };
  }
  const list = text.match(/^list(?:\s+(.+))?$/i);
  if (list) {
    return {
      label: "List files",
      action: {
        actionType: "project.fs.readdir",
        args: { path: (list[1] ?? ".").trim() || "." },
      },
    };
  }
  const status = text.match(/^status\s+([a-z0-9_-]+)$/i);
  if (status) {
    return {
      label: `App status: ${status[1]}`,
      action: {
        actionType: "project.apps.status",
        args: { name: status[1] },
      },
    };
  }
  const start = text.match(/^start\s+([a-z0-9_-]+)$/i);
  if (start) {
    return {
      label: `Start app: ${start[1]}`,
      action: {
        actionType: "project.apps.start",
        args: { name: start[1] },
      },
    };
  }
  const stop = text.match(/^stop\s+([a-z0-9_-]+)$/i);
  if (stop) {
    return {
      label: `Stop app: ${stop[1]}`,
      action: {
        actionType: "project.apps.stop",
        args: { name: stop[1] },
      },
    };
  }
  const write = text.match(/^write\s+(\S+)\s+:::\s+([\s\S]+)$/i);
  if (write) {
    return {
      label: `Write file: ${write[1]}`,
      action: {
        actionType: "project.fs.writeFile",
        args: { path: write[1], data: write[2] },
      },
    };
  }
  const read = text.match(/^read\s+(\S+)$/i);
  if (read) {
    return {
      label: `Read file: ${read[1]}`,
      action: {
        actionType: "project.fs.readFile",
        args: { path: read[1], encoding: "utf8" },
      },
    };
  }
  const readbin = text.match(/^readbin\s+(\S+)$/i);
  if (readbin) {
    return {
      label: `Read file (binary): ${readbin[1]}`,
      action: {
        actionType: "project.fs.readFile",
        args: { path: readbin[1] },
      },
    };
  }
  const rename = text.match(/^rename\s+(\S+)\s+->\s+(\S+)$/i);
  if (rename) {
    return {
      label: `Rename file: ${rename[1]} -> ${rename[2]}`,
      action: {
        actionType: "project.fs.rename",
        args: { oldPath: rename[1], newPath: rename[2] },
      },
    };
  }
  const move = text.match(/^move\s+(.+)\s+->\s+(\S+)$/i);
  if (move) {
    const paths = move[1]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return {
      label: `Move files: ${paths.join(", ")} -> ${move[2]}`,
      action: {
        actionType: "project.fs.move",
        args: { src: paths.length === 1 ? paths[0] : paths, dest: move[2] },
      },
    };
  }
  const realpath = text.match(/^realpath\s+(\S+)$/i);
  if (realpath) {
    return {
      label: `Realpath: ${realpath[1]}`,
      action: {
        actionType: "project.fs.realpath",
        args: { path: realpath[1] },
      },
    };
  }
  return {
    error:
      "Unknown command. Try: ping | list [path] | read <path> | readbin <path> | write <path> ::: <text> | rename <src> -> <dest> | move <a,b> -> <dest> | realpath <path> | status <app> | start <app> | stop <app>",
  };
}

function prettify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface NavigatorShellProps {
  project_id: string;
}

export function NavigatorShell({ project_id }: NavigatorShellProps) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"" | "execute" | "manifest">("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<ResultEntry[]>([]);
  const [manifest, setManifest] = useState<AgentManifestEntry[] | null>(null);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);

  const parsed = useMemo(() => parsePrompt(prompt), [prompt]);
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
  }) {
    setError("");
    setBusy("execute");
    try {
      const response: AgentExecuteResponse =
        await webapp_client.conat_client.agent.execute({
          action,
          defaults: { projectId: project_id },
          confirmationToken,
        });
      if (
        response.status === "blocked" &&
        response.requiresConfirmation &&
        !confirmationToken
      ) {
        setPendingConfirmation({
          action: { ...action, dryRun: false },
          label,
          prompt: promptText,
        });
      } else {
        setPendingConfirmation(null);
      }
      setHistory((cur) => [
        {
          ts: new Date().toISOString(),
          prompt: promptText,
          label,
          mode,
          response,
        },
        ...cur,
      ]);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy("");
    }
  }

  async function runAction() {
    const parsed = parsePrompt(prompt);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    await executeAction({
      action: parsed.action,
      label: parsed.label,
      promptText: prompt.trim(),
      mode: "run",
    });
  }

  async function previewAction() {
    const parsed = parsePrompt(prompt);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    await executeAction({
      action: { ...parsed.action, dryRun: true },
      label: `Preview: ${parsed.label}`,
      promptText: prompt.trim(),
      mode: "preview",
    });
  }

  async function confirmAction() {
    if (!pendingConfirmation) return;
    await executeAction({
      action: { ...pendingConfirmation.action, dryRun: false },
      label: `Confirmed: ${pendingConfirmation.label}`,
      promptText: pendingConfirmation.prompt,
      mode: "confirm",
      confirmationToken: "user-confirmed",
    });
  }

  async function loadManifest() {
    setError("");
    setBusy("manifest");
    try {
      const value = await webapp_client.conat_client.agent.manifest();
      setManifest(value);
      setHistory((cur) => [
        {
          ts: new Date().toISOString(),
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
        Deterministic command shell over `hub.agent.execute` while planner
        integration is in progress.
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
                <code style={{ marginLeft: 6 }}>
                  {pendingConfirmation.action.actionType}
                </code>
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
          placeholder="Try: list . | read notes.md | rename a.txt -> b.txt | move a.txt,b.txt -> docs"
          onPressEnter={() => runAction()}
        />
        <Button
          size="large"
          onClick={previewAction}
          loading={busy === "execute"}
          disabled={busy !== ""}
        >
          Preview
        </Button>
        <Button
          size="large"
          type="primary"
          onClick={runAction}
          loading={busy === "execute"}
          disabled={busy !== ""}
        >
          Run
        </Button>
      </div>
      <Space style={{ marginTop: 8 }} size={8} wrap>
        {"error" in parsed ? (
          <Tag color="orange">No executable action</Tag>
        ) : (
          <>
            <Tag color="green">{parsed.action.actionType}</Tag>
            {manifestByAction.get(parsed.action.actionType)?.riskLevel ? (
              <Tag>
                Risk: {manifestByAction.get(parsed.action.actionType)?.riskLevel}
              </Tag>
            ) : null}
            {manifestByAction.get(parsed.action.actionType)
              ?.requiresConfirmationByDefault ? (
              <Tag color="gold">Confirm by default</Tag>
            ) : null}
          </>
        )}
        <Button
          size="small"
          onClick={loadManifest}
          loading={busy === "manifest"}
          disabled={busy !== ""}
        >
          Refresh manifest
        </Button>
        {manifest ? (
          <Tag>{manifest.length} capabilities</Tag>
        ) : null}
      </Space>
      {"error" in parsed ? null : (
        <Input.TextArea
          style={{ marginTop: 8 }}
          value={prettify(parsed.action)}
          readOnly
          autoSize={{ minRows: 4, maxRows: 10 }}
          placeholder="Action preview..."
        />
      )}
      <Input.TextArea
        style={{ marginTop: 8 }}
        value={
          lastResult
            ? prettify({
                at: lastResult.ts,
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
    </div>
  );
}
