import { Button, Input, Modal, Select, Space, Typography } from "antd";
import { useEffect, useId, useState } from "react";
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
import { getQualifiedHarnessCandidate } from "@cocalc/util/ai/qualified-harnesses";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { redux } from "@cocalc/frontend/app-framework";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { ProjectSecretsModal } from "@cocalc/frontend/project/settings/secrets";
import {
  HARNESS_CREDENTIAL_SELECTION_EVENT,
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "./harness-credential-selection";

const HARNESS_LIMITATIONS =
  "Text prompts only. Agent Networks support queued messages. Images, automations and live guidance are not supported yet.";

interface HarnessRuntimeSummaryProps {
  runtime: unknown;
  reported?: unknown;
  projectId?: string;
  threadKey?: string;
  onSettings?: (settings: HarnessSessionSettings) => void;
  onDiscover?: () => Promise<{ profile: unknown; controls: unknown }>;
}

function ClaudeCredentialControl({
  projectId,
  threadKey,
}: {
  projectId: string;
  threadKey: string;
}) {
  const accountId = redux.getStore("account")?.get("account_id") as
    | string
    | undefined;
  const [credentials, setCredentials] = useState<ExternalCredentialInfo[]>([]);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [error, setError] = useState("");
  const selection = readHarnessCredentialSelection({
    accountId,
    projectId,
    threadKey,
  });
  const [value, setValue] = useState(
    selection?.mode === "account-api-key"
      ? `account-api-key:${selection.credentialId}`
      : "project-secret",
  );
  useEffect(() => {
    let disposed = false;
    void webapp_client.conat_client.hub.system
      .listExternalCredentials({
        provider: "anthropic",
        kind: "anthropic-api-key",
        scope: "account",
      })
      .then((rows) => {
        if (!disposed) setCredentials(rows.filter((row) => !row.revoked));
      })
      .catch((err) => {
        if (!disposed) setError(`${err}`);
      });
    const refresh = () => {
      const current = readHarnessCredentialSelection({
        accountId,
        projectId,
        threadKey,
      });
      setValue(
        current?.mode === "account-api-key"
          ? `account-api-key:${current.credentialId}`
          : "project-secret",
      );
    };
    window.addEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, refresh);
    return () => {
      disposed = true;
      window.removeEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, refresh);
    };
  }, [accountId, projectId, threadKey]);
  return (
    <Space orientation="vertical" size={4} style={{ width: "100%" }}>
      <Select
        aria-label="Claude credential"
        value={value}
        options={[
          {
            value: "project-secret",
            label: "Project secret: ANTHROPIC_API_KEY",
          },
          ...credentials.map((row) => ({
            value: `account-api-key:${row.id}`,
            label: `${row.metadata?.label || "Anthropic API key"} (${row.id.slice(0, 8)})`,
          })),
        ]}
        onChange={(next) => {
          const credential = next.startsWith("account-api-key:")
            ? {
                version: 1 as const,
                provider: "anthropic" as const,
                mode: "account-api-key" as const,
                credentialId: next.slice("account-api-key:".length),
              }
            : {
                version: 1 as const,
                provider: "anthropic" as const,
                mode: "project-secret" as const,
              };
          writeHarnessCredentialSelection({
            accountId,
            projectId,
            threadKey,
            credential,
          });
          setValue(next);
        }}
        style={{ width: "100%" }}
      />
      {value === "project-secret" && (
        <Button onClick={() => setSecretsOpen(true)}>
          Manage project secret
        </Button>
      )}
      <Typography.Text type="secondary">
        This account-local choice is applied when the next turn is admitted.
      </Typography.Text>
      {error && (
        <div role="alert">Unable to load account credentials: {error}</div>
      )}
      <ProjectSecretsModal
        open={secretsOpen}
        project_id={projectId}
        onClose={() => setSecretsOpen(false)}
      />
    </Space>
  );
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
        style={{
          minWidth: 0,
          maxWidth: "100%",
          width: "100%",
          justifyContent: "flex-start",
        }}
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

export function qualifiedHarnessRuntime(
  id: string,
  cwd: string,
): AcpHarnessRuntime {
  const candidate = getQualifiedHarnessCandidate(id);
  if (!candidate || candidate.status === "disabled") {
    throw Error("This qualified ACP harness is unavailable");
  }
  return parseAcpHarnessRuntime({
    version: 1,
    kind: "acp",
    profile: {
      version: 2,
      kind: "acp",
      id: candidate.id,
      revision: candidate.package.version,
      cwd,
      executionPolicy: "full-access",
      credentialMode: "project-managed",
    },
  });
}

export function HarnessRuntimeSummary(props: HarnessRuntimeSummaryProps) {
  let runtime: AcpHarnessRuntime;
  try {
    runtime = parseAcpHarnessRuntime(props.runtime);
  } catch {
    return (
      <div role="alert">
        Invalid ACP runtime configuration. This thread cannot run.
      </div>
    );
  }
  // Discovery belongs to this executable/profile, not to a later replacement.
  return (
    <HarnessRuntimeSummaryContent
      key={JSON.stringify(runtime.profile)}
      {...props}
      runtime={runtime}
    />
  );
}

function HarnessRuntimeSummaryContent({
  runtime,
  reported,
  projectId,
  threadKey,
  onSettings,
  onDiscover,
}: Omit<HarnessRuntimeSummaryProps, "runtime"> & {
  runtime: AcpHarnessRuntime;
}) {
  const id = useId();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [discovered, setDiscovered] = useState<{
    profile: unknown;
    controls: unknown;
    reportedAtLoad: string | undefined;
  }>();
  const { profile, settings = {} } = runtime;
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
          {profile.version === 1 ? (
            <>
              <dt>Executable</dt>
              <dd>{profile.executable}</dd>
              <dt>Arguments</dt>
              <dd>{JSON.stringify(profile.args)}</dd>
            </>
          ) : (
            <>
              <dt>Launch policy</dt>
              <dd>CoCalc qualified and pinned</dd>
            </>
          )}
          <dt>Working directory</dt>
          <dd>{profile.cwd}</dd>
        </dl>
      </details>
      <Typography.Text type="secondary">{HARNESS_LIMITATIONS}</Typography.Text>
      {profile.version === 2 &&
        profile.id === "claude-code" &&
        projectId &&
        threadKey && (
          <ClaudeCredentialControl
            projectId={projectId}
            threadKey={threadKey}
          />
        )}
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
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
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
              <div
                key={control.id}
                style={{ flex: "1 1 220px", minWidth: 0, maxWidth: "100%" }}
              >
                <label
                  htmlFor={`${id}-${control.id}`}
                  style={{ display: "block", overflowWrap: "anywhere" }}
                >
                  {control.name}
                </label>
                <Select
                  id={`${id}-${control.id}`}
                  value={value}
                  style={{ width: "100%" }}
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
        </div>
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
        turn, or use the harness configuration. {HARNESS_LIMITATIONS}
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
