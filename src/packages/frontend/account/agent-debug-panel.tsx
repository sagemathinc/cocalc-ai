import { Alert, Button, Input, Space, Typography } from "antd";
import { useMemo, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const DEFAULT_ACTION = `{
  "actionType": "hub.system.ping",
  "args": {}
}`;

const DEFAULT_DEFAULTS = `{
  "projectId": ""
}`;

function parseJson(label: string, value: string): any {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err}`);
  }
}

export function AgentDebugPanel() {
  const [manifest, setManifest] = useState<any[] | null>(null);
  const [actionJson, setActionJson] = useState<string>(DEFAULT_ACTION);
  const [defaultsJson, setDefaultsJson] = useState<string>(DEFAULT_DEFAULTS);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<"" | "manifest" | "execute">("");
  const [error, setError] = useState<string>("");

  const resultText = useMemo(() => {
    if (result == null) return "";
    return JSON.stringify(result, null, 2);
  }, [result]);

  async function loadManifest() {
    setBusy("manifest");
    setError("");
    try {
      const value = await webapp_client.conat_client.agent.manifest();
      setManifest(value);
      setResult(value);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy("");
    }
  }

  async function execute() {
    setBusy("execute");
    setError("");
    try {
      const action = parseJson("Action", actionJson);
      const defaults = parseJson("Defaults", defaultsJson);
      const value = await webapp_client.conat_client.agent.execute({
        action,
        defaults,
      });
      setResult(value);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ marginTop: 20 }}>
      <Typography.Title level={5} style={{ marginBottom: 8 }}>
        Agent Debug (Developer)
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        Run `hub.agent.manifest` and `hub.agent.execute` directly for quick
        debugging.
      </Typography.Paragraph>
      {error ? (
        <Alert
          type="error"
          showIcon
          message="Agent request failed"
          description={error}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <Space direction="vertical" style={{ width: "100%" }} size="small">
        <Typography.Text strong>Action (JSON)</Typography.Text>
        <Input.TextArea
          value={actionJson}
          onChange={(e) => setActionJson(e.target.value)}
          autoSize={{ minRows: 5, maxRows: 10 }}
          spellCheck={false}
        />
        <Typography.Text strong>Defaults (JSON)</Typography.Text>
        <Input.TextArea
          value={defaultsJson}
          onChange={(e) => setDefaultsJson(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 6 }}
          spellCheck={false}
        />
        <Space>
          <Button
            onClick={loadManifest}
            loading={busy === "manifest"}
            disabled={busy !== ""}
          >
            Load Manifest
          </Button>
          <Button
            type="primary"
            onClick={execute}
            loading={busy === "execute"}
            disabled={busy !== ""}
          >
            Execute
          </Button>
        </Space>
        <Typography.Text strong>
          Result {manifest ? `(${manifest.length} manifest entries loaded)` : ""}
        </Typography.Text>
        <Input.TextArea
          value={resultText}
          readOnly
          autoSize={{ minRows: 8, maxRows: 20 }}
          spellCheck={false}
          placeholder="Results appear here..."
        />
      </Space>
    </div>
  );
}
