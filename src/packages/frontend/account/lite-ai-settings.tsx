import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Space, Typography } from "antd";
import { getLogger } from "@cocalc/frontend/logger";
import { query } from "@cocalc/frontend/frame-editors/generic/client";
import { Gap, Loading } from "@cocalc/frontend/components";
import { redux } from "@cocalc/frontend/app-framework";

const log = getLogger("account:lite-ai-settings");

type ProviderKey = {
  keyField: string;
  enableField: string;
  label: string;
  placeholder?: string;
};

const OPENAI_PROVIDER: ProviderKey = {
  keyField: "openai_api_key",
  enableField: "openai_enabled",
  label: "OpenAI API Key",
  placeholder: "sk-...",
};

type State = "load" | "ready" | "save" | "error";

export default function LiteAISettings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedValues, setSavedValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<State>("load");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    load();
  }, []);

  async function load(): Promise<void> {
    setState("load");
    try {
      const result = await query({
        query: {
          site_settings: [{ name: null, value: null }],
        },
      });
      const next: Record<string, string> = {};
      for (const row of result.query.site_settings ?? []) {
        next[row.name] = row.value;
      }
      setValues(next);
      setSavedValues(next);
      setError("");
      setState("ready");
    } catch (err) {
      log.info("failed to load llm settings", err);
      setError(`${err}`);
      setState("error");
    }
  }

  function onChange(key: string, val: string) {
    setValues((cur) => ({ ...cur, [key]: val }));
  }

  const saving = state === "save";
  const dirty = useMemo(() => {
    const { keyField } = OPENAI_PROVIDER;
    if ((values[keyField] ?? "") !== (savedValues[keyField] ?? "")) {
      return true;
    }
    return false;
  }, [values, savedValues]);

  async function save(): Promise<void> {
    if (saving || !dirty) return;
    setState("save");
    try {
      const { keyField, enableField } = OPENAI_PROVIDER;
      const val = values[keyField] ?? "";
      await query({
        query: { site_settings: { name: keyField, value: val } },
      });
      await query({
        query: {
          site_settings: {
            name: enableField,
            value: val ? "yes" : "no",
          },
        },
      });
      redux.getStore("projects").clearOpenAICache();
      // @ts-ignore
      await redux.getActions("customize")?.reload();
      setSavedValues(values);
      setState("ready");
    } catch (err) {
      log.info("failed to save llm settings", err);
      setError(`${err}`);
      setState("error");
    }
  }

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 8 }}>
        Option B: OpenAI API Key
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        Choose this if you want Codex billed through your OpenAI API key.
      </Typography.Paragraph>
      {error && (
        <Alert type="error" title="Error" description={error} closable />
      )}
      <Space orientation="vertical" style={{ width: "100%" }} size={8}>
        <div style={{ fontWeight: 500 }}>{OPENAI_PROVIDER.label}</div>
        <Input.Password
          allowClear
          value={values[OPENAI_PROVIDER.keyField] ?? ""}
          placeholder={OPENAI_PROVIDER.placeholder}
          name={`llm-${OPENAI_PROVIDER.keyField}`}
          autoComplete="off"
          onChange={(e) => onChange(OPENAI_PROVIDER.keyField, e.target.value)}
        />
      </Space>
      <Gap />
      <Button
        type="primary"
        onClick={save}
        disabled={saving || !dirty}
        style={{ marginTop: 8 }}
      >
        {saving ? <Loading text="Saving" /> : "Save"}
      </Button>
    </div>
  );
}
