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
  response: unknown;
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
        actionType: "project.system.listing",
        args: { path: (list[1] ?? ".").trim() || ".", hidden: false },
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
        actionType: "project.system.write_text_file",
        args: { path: write[1], content: write[2] },
      },
    };
  }
  return {
    error:
      "Unknown command. Try: ping | list [path] | status <app> | start <app> | stop <app> | write <path> ::: <text>",
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

  const parsed = useMemo(() => parsePrompt(prompt), [prompt]);

  async function runAction() {
    const parsed = parsePrompt(prompt);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError("");
    setBusy("execute");
    try {
      const response: AgentExecuteResponse =
        await webapp_client.conat_client.agent.execute({
          action: parsed.action,
          defaults: { projectId: project_id },
        });
      setHistory((cur) => [
        {
          ts: new Date().toISOString(),
          prompt: prompt.trim(),
          label: parsed.label,
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
      <Space.Compact style={{ width: "100%" }}>
        <Input
          size="large"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Try: ping | list . | status code | start jupyterlab"
          onPressEnter={() => runAction()}
        />
        <Button
          size="large"
          type="primary"
          onClick={runAction}
          loading={busy === "execute"}
          disabled={busy !== ""}
        >
          Run
        </Button>
      </Space.Compact>
      <Space style={{ marginTop: 8 }} size={8} wrap>
        {"error" in parsed ? (
          <Tag color="orange">No executable action</Tag>
        ) : (
          <Tag color="green">{parsed.action.actionType}</Tag>
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
      <Input.TextArea
        style={{ marginTop: 8 }}
        value={
          lastResult
            ? prettify({
                at: lastResult.ts,
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
