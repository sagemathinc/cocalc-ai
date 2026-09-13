import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Space, Typography } from "antd";
import { getLogger } from "@cocalc/frontend/logger";
import { query } from "@cocalc/frontend/frame-editors/generic/client";
import { Gap, Loading } from "@cocalc/frontend/components";
import { redux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const log = getLogger("account:lite-ai-settings");

type ProviderKey = {
  keyField: string;
  label: string;
  placeholder?: string;
};

const OPENAI_PROVIDER: ProviderKey = {
  keyField: "openai_api_key",
  label: "OpenAI API Key",
  placeholder: "sk-...",
};

type State = "load" | "ready" | "save" | "error";

export interface LiteAISettingsProps {
  onSaved?: () => void;
  showTitle?: boolean;
}

export default function LiteAISettings({
  onSaved,
  showTitle = true,
}: LiteAISettingsProps = {}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedValues, setSavedValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<State>("load");
  const [error, setError] = useState<string>("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

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
      log.info("failed to load AI settings", err);
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
      const { keyField } = OPENAI_PROVIDER;
      const val = values[keyField] ?? "";
      const completed = await runFreshAuthAction(async () => {
        const result =
          await webapp_client.conat_client.hub.system.setSiteSettings({
            settings: [{ name: keyField, value: val }],
            browser_id: webapp_client.browser_id,
          });
        const failures = result.bays.filter(
          ({ status }) => status === "failed",
        );
        if (failures.length > 0) {
          throw Error(
            failures
              .map(
                ({ bay_id, error }) =>
                  `${bay_id}: ${error ?? "settings propagation failed"}`,
              )
              .join("; "),
          );
        }
      });
      if (!completed) {
        setState("ready");
        return;
      }
      redux.getStore("projects").clearOpenAICache();
      // @ts-ignore
      await redux.getActions("customize")?.reload();
      setSavedValues(values);
      setState("ready");
      onSaved?.();
    } catch (err) {
      log.info("failed to save AI settings", err);
      setError(`${err}`);
      setState("error");
    }
  }

  return (
    <div>
      {showTitle ? (
        <>
          <Typography.Title level={4} style={{ marginBottom: 8 }}>
            Option B: OpenAI API Key
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            This is optional. Use it if you want the site to fund Codex usage
            through a shared OpenAI API key.
          </Typography.Paragraph>
        </>
      ) : null}
      {error && (
        <Alert type="error" title="Error" description={error} closable />
      )}
      <Space orientation="vertical" style={{ width: "100%" }} size={8}>
        <div style={{ fontWeight: 500 }}>{OPENAI_PROVIDER.label}</div>
        <Input.Password
          allowClear
          value={values[OPENAI_PROVIDER.keyField] ?? ""}
          placeholder={OPENAI_PROVIDER.placeholder}
          aria-label={OPENAI_PROVIDER.label}
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
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
