import { Button, Input, Modal, Select, Space, Typography } from "antd";
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
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

interface HarnessRuntimeSummaryProps {
  runtime: unknown;
  reported?: unknown;
  onSettings?: (settings: HarnessSessionSettings) => void;
  onDiscover?: () => Promise<{ profile: unknown; controls: unknown }>;
}

/** Composer toolbars cannot contain the full, wrapping runtime form. */
export function HarnessRuntimeControl({
  compact,
  ...props
}: HarnessRuntimeSummaryProps & { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  let name = "harness";
  try {
    name = parseAcpHarnessRuntime(props.runtime).profile.id;
  } catch {
    /* The form explains invalid configuration. */
  }
  if (!compact) return <HarnessRuntimeSummary {...props} />;
  return (
    <>
      <Button
        size="small"
        type="text"
        aria-label={`ACP: ${name} settings`}
        aria-haspopup="dialog"
        title={`ACP: ${name} settings`}
        onClick={() => setOpen(true)}
        style={{ minWidth: 0, maxWidth: "100%", width: "100%" }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          ACP: {name}
        </span>
      </Button>
      <Modal
        open={open}
        title="ACP harness settings"
        footer={null}
        onCancel={() => setOpen(false)}
        modalRender={(modal) => <KeyboardBoundary>{modal}</KeyboardBoundary>}
        styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
      >
        <HarnessRuntimeSummary {...props} />
      </Modal>
    </>
  );
}

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
  onDiscover,
}: HarnessRuntimeSummaryProps) {
  const id = useId();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [discovered, setDiscovered] = useState<{
    profile: unknown;
    controls: unknown;
    reportedAtLoad: string | undefined;
  }>();
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
  for (const candidate of [
    discovered?.reportedAtLoad === JSON.stringify(reported)
      ? discovered
      : undefined,
    reported,
  ]) {
    try {
      const snapshot = candidate as {
        profile: unknown;
        controls: unknown;
      };
      if (
        JSON.stringify(parseAcpHarnessProfile(snapshot.profile)) ===
        JSON.stringify(profile)
      ) {
        controls = parseHarnessSessionControls(snapshot.controls);
        break;
      }
    } catch {
      /* Missing, stale or invalid metadata is not a usable catalog. */
    }
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
    <Space
      orientation="vertical"
      size={4}
      style={{ width: "100%", minWidth: 0 }}
    >
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
      {onDiscover && (
        <Button
          loading={loading}
          style={{ maxWidth: "100%", height: "auto", whiteSpace: "normal" }}
          onClick={async () => {
            setLoading(true);
            setError("");
            try {
              const result = await onDiscover();
              parseHarnessSessionControls(result.controls);
              if (
                JSON.stringify(parseAcpHarnessProfile(result.profile)) !==
                JSON.stringify(profile)
              )
                throw Error(
                  "Harness profile changed; reload its settings before discovery",
                );
              setDiscovered({
                ...result,
                reportedAtLoad: JSON.stringify(reported),
              });
            } catch (err) {
              setError(`${err}`);
            } finally {
              setLoading(false);
            }
          }}
        >
          Load model and mode options
        </Button>
      )}
      {onDiscover && (
        <Typography.Text type="secondary">
          Starts a temporary harness session with project access, without
          sending a prompt.
        </Typography.Text>
      )}
      <span role="status">
        {loading
          ? "Loading harness options"
          : discovered
            ? "Harness options loaded"
            : ""}
      </span>
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
        in these fields. Load advertised model/mode options before the first
        turn, or use the harness configuration. Agent Networks support queued
        messages. Images, automations and live guidance are not supported yet.
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
