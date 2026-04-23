/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Space, Typography } from "antd";
import { useIntl } from "react-intl";

import {
  React,
  useActions,
  useEffect,
  useIsMountedRef,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { ErrorDisplay, Gap, SettingBox } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { useProjectEnv } from "@cocalc/frontend/project/use-project-env";

export const ENV_VARS_ICON = "bars";

interface Props {
  project_id: string;
  mode?: "project" | "flyout";
}

type EnvRow = {
  id: string;
  key: string;
  value: string;
};

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeEnv(env: unknown): Record<string, string> {
  if (typeof env != "object" || env == null || Array.isArray(env)) return {};
  const obj: Record<string, string> = {};
  for (const key in env) {
    const value = `${(env as Record<string, unknown>)[key]}`;
    if (value !== "") {
      obj[key] = value;
    }
  }
  return obj;
}

function envToRows(env: unknown): EnvRow[] {
  const normalized = normalizeEnv(env);
  return Object.keys(normalized)
    .sort()
    .map((key) => ({ id: `env:${key}`, key, value: normalized[key] }));
}

function envFingerprint(env: unknown): string {
  const normalized = normalizeEnv(env);
  return JSON.stringify(
    Object.keys(normalized)
      .sort()
      .map((key) => [key, normalized[key]]),
  );
}

function rowsToEnv(rows: EnvRow[]): {
  env: Record<string, string>;
  error?: string;
} {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    const value = row.value;
    if (key === "" && value === "") {
      continue;
    }
    if (key === "") {
      return { env, error: "Environment variable names cannot be empty." };
    }
    if (!ENV_NAME_RE.test(key)) {
      return {
        env,
        error: `Invalid environment variable name "${key}". Use letters, numbers, and underscores, and do not start with a number.`,
      };
    }
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      return { env, error: `Duplicate environment variable "${key}".` };
    }
    if (value !== "") {
      env[key] = value;
    }
  }
  return { env };
}

export const Environment: React.FC<Props> = ({
  project_id,
  mode = "project",
}: Props) => {
  const isFlyout = mode === "flyout";
  const intl = useIntl();
  const projectLabelLower = intl.formatMessage(labels.project).toLowerCase();
  const { env, setEnv } = useProjectEnv(project_id);
  const actions = useActions({ project_id });
  const is_mounted_ref = useIsMountedRef();
  const nextRowIdRef = useRef<number>(0);
  const envRows = useMemo(() => envToRows(env), [env]);
  const envKey = useMemo(() => envFingerprint(env), [env]);
  const lastEnvKeyRef = useRef<string>(envKey);
  const [rows, setRows] = useState<EnvRow[]>(envRows);
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);

  const current = useMemo(() => rowsToEnv(rows), [rows]);
  const currentKey = useMemo(() => envFingerprint(current.env), [current.env]);
  const dirty = currentKey !== envKey;

  useEffect(() => {
    const previousEnvKey = lastEnvKeyRef.current;
    if (envKey === previousEnvKey || saving) {
      return;
    }
    if (currentKey === previousEnvKey) {
      setRows(envRows);
    }
    lastEnvKeyRef.current = envKey;
  }, [currentKey, envKey, envRows, saving]);

  function updateRow(id: string, patch: Partial<EnvRow>): void {
    setRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
    setError("");
  }

  function addRow(): void {
    setRows((rows) => [
      ...rows,
      { id: `new:${nextRowIdRef.current++}`, key: "", value: "" },
    ]);
    setError("");
  }

  function removeRow(id: string): void {
    setRows((rows) => rows.filter((row) => row.id !== id));
    setError("");
  }

  async function save(): Promise<void> {
    if (current.error) {
      setError(current.error);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await actions?.set_environment(current.env);
      setEnv(current.env);
      if (!is_mounted_ref.current) return;
      setRows(envToRows(current.env));
    } catch (err) {
      if (!is_mounted_ref.current) return;
      setError(`${err}`);
    } finally {
      if (is_mounted_ref.current) {
        setSaving(false);
      }
    }
  }

  const help = (
    <Alert
      banner
      showIcon={false}
      type="info"
      message={
        <>
          These variables are available to terminals, Jupyter kernels, and other
          processes in your {projectLabelLower}. Restart the {projectLabelLower}{" "}
          for changes to take effect.
          <br />
          Empty values are treated as deleted variables. For <code>PATH</code>,
          values are prepended to the existing <code>PATH</code> unless they
          include <code>$PATH</code>, which is replaced by the current path.
        </>
      }
    />
  );

  function renderBody() {
    return (
      <div style={{ padding: "10px" }}>
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          {help}
          {error ? <ErrorDisplay banner error={error} /> : undefined}
          {current.error ? (
            <ErrorDisplay banner error={current.error} />
          ) : undefined}
          <div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(140px, 1fr) minmax(180px, 2fr) auto",
                gap: "8px",
                marginBottom: "6px",
              }}
            >
              <Typography.Text strong>Name</Typography.Text>
              <Typography.Text strong>Value</Typography.Text>
              <span />
            </div>
            {rows.length === 0 ? (
              <Typography.Text type="secondary">
                No custom environment variables are configured.
              </Typography.Text>
            ) : (
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                {rows.map((row) => (
                  <div
                    key={row.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(140px, 1fr) minmax(180px, 2fr) auto",
                      gap: "8px",
                    }}
                  >
                    <Input
                      disabled={saving}
                      placeholder="NAME"
                      value={row.key}
                      onChange={(event) =>
                        updateRow(row.id, { key: event.target.value })
                      }
                    />
                    <Input
                      disabled={saving}
                      placeholder="value"
                      value={row.value}
                      onChange={(event) =>
                        updateRow(row.id, { value: event.target.value })
                      }
                    />
                    <Button disabled={saving} onClick={() => removeRow(row.id)}>
                      Remove
                    </Button>
                  </div>
                ))}
              </Space>
            )}
          </div>
          <div>
            <Button disabled={saving} onClick={addRow}>
              Add Variable
            </Button>
            <Gap />
            <Button
              disabled={!dirty || saving}
              onClick={() => setRows(envRows)}
            >
              {intl.formatMessage(labels.cancel)}
            </Button>
            <Gap />
            <Button
              type="primary"
              disabled={!dirty || saving || current.error != null}
              onClick={save}
            >
              {saving ? "Saving..." : dirty ? "Save" : "Saved"}
            </Button>
          </div>
        </Space>
      </div>
    );
  }

  if (isFlyout) {
    return renderBody();
  }

  return (
    <SettingBox title="Custom Environment Variables" icon={ENV_VARS_ICON}>
      {renderBody()}
    </SettingBox>
  );
};
