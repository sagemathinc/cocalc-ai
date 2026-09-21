import { Input, Select, Space, Typography } from "antd";
import { useId, useState } from "react";
import { parseHarnessSessionControls } from "@cocalc/util/ai/harness-controls";
import type {
  HarnessSessionControls,
  HarnessSessionSettings,
} from "@cocalc/util/ai/harness-controls";
import {
  parseAcpHarnessProfile,
  parseAcpHarnessRuntime,
} from "@cocalc/util/ai/runtime";
import type { AcpHarnessRuntime } from "@cocalc/util/ai/runtime";

export interface HarnessProfileDraft {
  id: string;
  revision: string;
  executable: string;
  args: string;
}

export function HarnessRuntimeSummary({
  runtime,
  reported,
  onSettings,
}: {
  runtime: unknown;
  reported?: unknown;
  onSettings?: (settings: HarnessSessionSettings) => void;
}) {
  const id = useId();
  const [error, setError] = useState("");
  let parsed;
  try {
    parsed = parseAcpHarnessRuntime(runtime);
  } catch {
    return (
      <div role="alert">
        Invalid ACP runtime configuration. This thread cannot run.
      </div>
    );
  }
  const { profile, settings = {} } = parsed;
  let controls: HarnessSessionControls | undefined;
  try {
    const snapshot = reported as { profile: unknown; controls: unknown };
    if (
      JSON.stringify(parseAcpHarnessProfile(snapshot.profile)) ===
      JSON.stringify(profile)
    )
      controls = parseHarnessSessionControls(snapshot.controls);
  } catch {
    /* Missing, stale or invalid metadata is not a usable catalog. */
  }
  const change = (next: HarnessSessionSettings) => {
    try {
      onSettings?.(next);
      setError("");
    } catch (err) {
      setError(`${err}`);
    }
  };
  return (
    <Space orientation="vertical" size={4}>
      <details>
        <summary>ACP: {profile.id} · Full project access</summary>
        <dl style={{ overflowWrap: "anywhere", margin: 8 }}>
          <dt>Credentials</dt>
          <dd>Project-managed (not CoCalc billing)</dd>
          <dt>Revision</dt>
          <dd>{profile.revision}</dd>
          <dt>Executable</dt>
          <dd>{profile.executable}</dd>
          <dt>Arguments</dt>
          <dd>{JSON.stringify(profile.args)}</dd>
          <dt>Working directory</dt>
          <dd>{profile.cwd}</dd>
        </dl>
      </details>
      {onSettings && controls && (
        <Space wrap>
          {[
            ...(controls.mode ? [controls.mode] : []),
            ...controls.configOptions,
          ].map((control) => {
            const legacy = control === controls.mode;
            const value =
              (legacy
                ? settings.modeId
                : settings.configOptions?.find(({ id }) => id === control.id)
                    ?.value) ?? control.currentValue;
            return (
              <div key={control.id}>
                <label htmlFor={`${id}-${control.id}`}>{control.name}</label>{" "}
                <Select
                  id={`${id}-${control.id}`}
                  value={value}
                  style={{ minWidth: 140, maxWidth: "100%" }}
                  options={control.options.map((option) => ({
                    value: option.value,
                    label: option.name,
                  }))}
                  onChange={(value: string) =>
                    change(
                      legacy
                        ? { ...settings, modeId: value }
                        : {
                            ...settings,
                            configOptions: [
                              ...(settings.configOptions ?? []).filter(
                                ({ id }) => id !== control.id,
                              ),
                              { id: control.id, value },
                            ],
                          },
                    )
                  }
                />
              </div>
            );
          })}
        </Space>
      )}
      {onSettings && (
        <Typography.Text type="secondary">
          {controls && (controls.mode || controls.configOptions.length)
            ? "Changes apply to the next submitted turn, not running or already queued turns. Harness modes do not change container isolation."
            : "Model and mode selectors appear after the harness advertises them. Until then, it uses its project configuration."}
        </Typography.Text>
      )}
      {error && <div role="alert">{error}</div>}
    </Space>
  );
}

export function harnessRuntimeFromDraft(
  draft: HarnessProfileDraft,
  cwd: string,
): AcpHarnessRuntime {
  return {
    version: 1,
    kind: "acp",
    profile: parseAcpHarnessProfile({
      version: 1,
      kind: "acp",
      id: draft.id.trim(),
      revision: draft.revision.trim(),
      executable: draft.executable.trim(),
      args: draft.args === "" ? [] : draft.args.split("\n"),
      cwd,
      executionPolicy: "full-access",
      credentialMode: "project-managed",
    }),
  };
}

export function HarnessProfileFields({
  value,
  onChange,
  disabled,
}: {
  value: HarnessProfileDraft;
  onChange: (value: HarnessProfileDraft) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        Experimental: an operator must enable ACP harnesses on the project host.
        Install and configure the harness in this project first. It runs with
        full project access and project-managed credentials. Do not put secrets
        in these fields. The first turn uses the harness configuration;
        supported model/mode selectors appear afterward. Agent Networks support
        queued messages. Images, automations and live guidance are not supported
        yet.
      </Typography.Text>
      {(
        [
          ["id", "Harness name"],
          ["revision", "Installed version / revision"],
          ["executable", "Executable (absolute project path)"],
        ] as const
      ).map(([key, label]) => (
        <div key={key}>
          <label htmlFor={`${id}-${key}`}>{label}</label>
          <Input
            id={`${id}-${key}`}
            value={value[key]}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          />
        </div>
      ))}
      <div>
        <label htmlFor={`${id}-args`}>
          Arguments (one per line, no shell quoting)
        </label>
        <Input.TextArea
          id={`${id}-args`}
          value={value.args}
          disabled={disabled}
          rows={3}
          onChange={(e) => onChange({ ...value, args: e.target.value })}
        />
      </div>
    </Space>
  );
}
