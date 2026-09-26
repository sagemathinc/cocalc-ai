import {
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
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
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import {
  ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY,
  CLAUDE_SUBSCRIPTION_KIND,
} from "@cocalc/util/ai/external-credential-profiles";
import { ClaudeProjectSecretModal } from "./claude-project-secret-modal";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import {
  HARNESS_CREDENTIAL_SELECTION_EVENT,
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "./harness-credential-selection";
import { ClaudeSubscriptionConnect } from "./claude-subscription-connect";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { ClaudePaymentStatus } from "./claude-payment-status";

const HARNESS_LIMITATIONS =
  "Text and image prompts. Live guidance works when the harness advertises it; otherwise messages queue. Automations are not supported yet.";

export function claudeCredentialTrustWarning(
  mode: "project-secret" | "account-api-key" | "account-subscription",
): string {
  if (mode === "account-subscription")
    return "Experimental Claude Pro/Max: sign-in is account-owned and runs in a separate controller. Project commands run through a private tool bridge, not inside the controller. Credential isolation and subscription billing still require live qualification; use only with trusted project code.";
  return mode === "account-api-key"
    ? "Full-project-trust preview: CoCalc does not expose the account-stored key value to project code for reading or copying. However, project code can use the key through Claude's active relay and incur Anthropic charges. Use only with trusted collaborators and code."
    : "Full-project-trust preview: the project secret can be read, copied, or used by project collaborators and code Claude runs. Anthropic bills the key owner. Use only with trusted collaborators and code.";
}

interface HarnessRuntimeSummaryProps {
  compact?: boolean;
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
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [error, setError] = useState("");
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const selection = readHarnessCredentialSelection({
    accountId,
    projectId,
    threadKey,
  });
  const [value, setValue] = useState(
    selection?.mode === "account-api-key" ||
      selection?.mode === "account-subscription"
      ? `${selection.mode}:${selection.credentialId}`
      : "project-secret",
  );
  useEffect(() => {
    let disposed = false;
    setCredentials([]);
    setCredentialsLoaded(false);
    setError("");
    const refresh = () => {
      const current = readHarnessCredentialSelection({
        accountId,
        projectId,
        threadKey,
      });
      setValue(
        current?.mode === "account-api-key" ||
          current?.mode === "account-subscription"
          ? `${current.mode}:${current.credentialId}`
          : "project-secret",
      );
    };
    refresh();
    void webapp_client.conat_client.hub.system
      .listExternalCredentials({
        provider: "anthropic",
        scope: "account",
      })
      .then((rows) => {
        if (!disposed) {
          setCredentials(
            rows.filter(
              (row) =>
                !row.revoked &&
                (row.kind === "anthropic-api-key" ||
                  row.kind === CLAUDE_SUBSCRIPTION_KIND),
            ),
          );
          setCredentialsLoaded(true);
        }
      })
      .catch((err) => {
        if (!disposed) setError(`${err}`);
      });
    window.addEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, refresh);
    return () => {
      disposed = true;
      window.removeEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, refresh);
    };
  }, [accountId, projectId, threadKey]);
  const selectedSubscription = value.startsWith("account-subscription:")
    ? credentials.find(
        (row) =>
          row.kind === CLAUDE_SUBSCRIPTION_KIND &&
          row.id === value.slice("account-subscription:".length),
      )
    : undefined;
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
            value: `${row.kind === CLAUDE_SUBSCRIPTION_KIND ? "account-subscription" : "account-api-key"}:${row.id}`,
            label: `${row.kind === CLAUDE_SUBSCRIPTION_KIND ? `${row.metadata?.plan || "Claude Pro/Max"} - ${row.metadata?.[ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY] || "unknown account"}` : row.metadata?.label || "Anthropic API key"} (${row.id.slice(0, 8)})`,
          })),
        ]}
        onChange={(next) => {
          const credential = next.startsWith("account-subscription:")
            ? {
                version: 1 as const,
                provider: "anthropic" as const,
                mode: "account-subscription" as const,
                credentialId: next.slice("account-subscription:".length),
              }
            : next.startsWith("account-api-key:")
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
      {value.startsWith("account-subscription:") && (
        <Popconfirm
          title="Disconnect Claude subscription?"
          description="Blocks new project-tool calls and future turns. Inference already in flight may continue."
          okText="Disconnect"
          okButtonProps={{ danger: true }}
          onConfirm={async () => {
            setDisconnectBusy(true);
            setError("");
            try {
              const credentialId = value.slice("account-subscription:".length);
              const completed = await runFreshAuthAction(async () => {
                await webapp_client.conat_client.hub.system.revokeExternalCredential(
                  {
                    id: credentialId,
                    browser_id: webapp_client.browser_id,
                  },
                );
              });
              if (!completed) return;
              setCredentials((rows) =>
                rows.filter((row) => row.id !== credentialId),
              );
              const credential = {
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
              setValue("project-secret");
            } catch (err) {
              setError(`${err}`);
            } finally {
              setDisconnectBusy(false);
            }
          }}
        >
          <Button danger loading={disconnectBusy}>
            Disconnect Claude subscription
          </Button>
        </Popconfirm>
      )}
      <ClaudeSubscriptionConnect
        compact
        hasConnection={credentials.some(
          (row) => row.kind === CLAUDE_SUBSCRIPTION_KIND,
        )}
        projectId={projectId}
        onConnected={async () => {
          const rows =
            await webapp_client.conat_client.hub.system.listExternalCredentials(
              { provider: "anthropic", scope: "account" },
            );
          setCredentials(
            rows.filter(
              (row) =>
                !row.revoked &&
                (row.kind === "anthropic-api-key" ||
                  row.kind === CLAUDE_SUBSCRIPTION_KIND),
            ),
          );
        }}
      />
      {selectedSubscription && (
        <Typography.Text role="status">
          Billing: Claude {selectedSubscription.metadata?.plan || "Pro/Max"}{" "}
          plan for{" "}
          {selectedSubscription.metadata?.[
            ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY
          ] || "unknown account"}
          .
        </Typography.Text>
      )}
      {credentialsLoaded &&
        value.startsWith("account-subscription:") &&
        !selectedSubscription && (
          <div role="alert">
            This Claude subscription is unavailable or revoked. Reconnect or
            choose another credential.
          </div>
        )}
      <Typography.Link
        href={`${appBasePath.replace(/\/$/, "")}/docs/ai/claude-code`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Claude Code preview: setup, security model, and billing
      </Typography.Link>
      {error && (
        <div role="alert">Unable to load account credentials: {error}</div>
      )}
      {secretsOpen && (
        <ClaudeProjectSecretModal
          open
          projectId={projectId}
          onClose={() => setSecretsOpen(false)}
          warning={claudeCredentialTrustWarning("project-secret")}
        />
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}

export function HarnessRuntimeControl(props: HarnessRuntimeSummaryProps) {
  return <HarnessRuntimeSummary {...props} />;
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
  const accountId = useTypedRedux("account", "account_id");
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
      key={JSON.stringify([
        runtime.profile,
        accountId,
        props.projectId,
        props.threadKey,
      ])}
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
  compact,
}: Omit<HarnessRuntimeSummaryProps, "runtime"> & {
  runtime: AcpHarnessRuntime;
}) {
  const id = useId();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [autoDiscovered, setAutoDiscovered] = useState(false);
  const generation = useRef(0);
  const [ignoredReported, setIgnoredReported] = useState<string>();
  const [discovered, setDiscovered] = useState<{
    profile: unknown;
    controls: unknown;
    reportedAtLoad: string | undefined;
  }>();
  const { profile, settings = {} } = runtime;
  const claude = profile.id === "claude-code";
  const name = claude ? "Claude Code" : `ACP: ${profile.id}`;
  let controls: HarnessSessionControls | undefined;
  for (const candidate of [
    discovered?.reportedAtLoad === JSON.stringify(reported)
      ? discovered
      : undefined,
    JSON.stringify(reported) !== ignoredReported ? reported : undefined,
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
  const discover = async () => {
    if (!onDiscover || loading) return;
    setLoading(true);
    setError("");
    const started = generation.current;
    try {
      const result = await onDiscover();
      if (started !== generation.current) return;
      parseHarnessSessionControls(result.controls);
      if (
        JSON.stringify(parseAcpHarnessProfile(result.profile)) !==
        JSON.stringify(profile)
      )
        throw Error(
          "Harness profile changed; reload its settings before discovery",
        );
      setDiscovered({ ...result, reportedAtLoad: JSON.stringify(reported) });
    } catch (err) {
      if (started === generation.current) setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };
  const invalidateCredential = useEffectEvent(() => {
    generation.current++;
    setIgnoredReported(JSON.stringify(reported));
    setDiscovered(undefined);
    setAutoDiscovered(false);
    setError("");
  });
  useEffect(() => {
    if (!claude || !projectId || !threadKey) return;
    const read = () =>
      JSON.stringify(
        readHarnessCredentialSelection({
          accountId: redux.getStore("account")?.get("account_id"),
          projectId,
          threadKey,
        }),
      );
    let previous = read();
    const refresh = () => {
      const next = read();
      if (next === previous) return;
      previous = next;
      invalidateCredential();
    };
    window.addEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [claude, projectId, threadKey]);
  const autoDiscover = useEffectEvent(discover);
  useEffect(() => {
    if (
      !compact ||
      !claude ||
      controls ||
      !onDiscover ||
      autoDiscovered ||
      loading
    )
      return;
    setAutoDiscovered(true);
    void autoDiscover();
  }, [compact, claude, !!controls, !!onDiscover, autoDiscovered, loading]);
  const select = (
    control: NonNullable<typeof controls>["configOptions"][number],
    inline = false,
  ) => {
    const legacy = control === controls?.mode;
    const value =
      (legacy
        ? settings.modeId
        : settings.configOptions?.find(({ id }) => id === control.id)?.value) ??
      control.currentValue;
    return (
      <Select
        id={`${id}-${inline ? "inline-" : ""}${control.id}`}
        aria-label={inline ? `${name} ${control.name}` : undefined}
        value={value}
        disabled={!onSettings}
        size={inline ? "small" : undefined}
        variant={inline ? "borderless" : undefined}
        popupMatchSelectWidth={false}
        style={inline ? { minWidth: 90, maxWidth: "100%" } : { width: "100%" }}
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
    );
  };
  const information = (
    <>
      <details>
        <summary>
          {claude ? "Runtime details" : `${name} · Full project access`}
        </summary>
        <dl style={{ overflowWrap: "anywhere", margin: 8 }}>
          <dt>Credentials</dt>
          <dd>
            {profile.id === "claude-code"
              ? "Billing and access depend on the selected payment method"
              : "Project-managed (not CoCalc billing)"}
          </dd>
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
    </>
  );
  const form = (
    <Space
      orientation="vertical"
      size={12}
      style={{ width: "100%", minWidth: 0 }}
    >
      <Tag>Experimental preview</Tag>
      {onSettings && controls && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
          {[
            ...(controls.mode ? [controls.mode] : []),
            ...controls.configOptions,
          ].map((control) => {
            if (claude && (control.id === "mode" || control === controls.mode))
              return null;
            return (
              <div
                key={control.id}
                style={{ flex: "1 1 180px", minWidth: 0, maxWidth: "100%" }}
              >
                <label
                  htmlFor={`${id}-${control.id}`}
                  style={{ display: "block", overflowWrap: "anywhere" }}
                >
                  {control.name}
                </label>
                {select(control)}
              </div>
            );
          })}
        </div>
      )}
      <details>
        <summary>How access, billing, and settings work</summary>
        <p>{HARNESS_LIMITATIONS}</p>
        <p>
          Full-project-access preview: CoCalc does not pause for per-tool
          approval. {claude ? "Claude" : "The harness"} may run project commands
          and change files during an admitted turn.
        </p>
        {claude && (
          <p>
            Credential selection is private to your account. Project code and
            authorized Agent Network turns can consume the selected billing
            authority. Anthropic controls subscription limits and extra usage.
          </p>
        )}
        <p>
          Changes apply to the next submitted turn, not running or already
          queued turns. Harness modes do not change container isolation.
        </p>
        <p>
          Loading options starts a temporary session with project access,
          without sending a prompt.
        </p>
      </details>
      {profile.version === 2 &&
        profile.id === "claude-code" &&
        projectId &&
        threadKey && (
          <section aria-label="Payment">
            <Typography.Text strong>Payment</Typography.Text>
            <ClaudeCredentialControl
              projectId={projectId}
              threadKey={threadKey}
            />
          </section>
        )}
      {onDiscover && (
        <Button
          type={claude ? "text" : "default"}
          size={claude ? "small" : undefined}
          loading={loading}
          style={{ maxWidth: "100%", height: "auto", whiteSpace: "normal" }}
          onClick={() => void discover()}
        >
          {claude ? "Refresh model options" : "Load model and mode options"}
        </Button>
      )}
      <span role="status">
        {loading
          ? "Loading harness options"
          : discovered
            ? "Harness options loaded"
            : ""}
      </span>
      {onSettings && (
        <Typography.Text type="secondary">
          {controls && (controls.mode || controls.configOptions.length)
            ? "Applies to your next turn."
            : "Model and mode selectors appear after the harness advertises them. Until then, it uses its project configuration."}
        </Typography.Text>
      )}
      {information}
      {error && <div role="alert">{error}</div>}
    </Space>
  );
  if (!compact) return form;
  const inlineControls =
    controls?.configOptions.filter(
      ({ id }) => id === "model" || id === "effort",
    ) ?? [];
  const fast = controls?.configOptions.find(
    ({ id }) => id === "fast" || id === "fastMode" || id === "fast_mode",
  );
  const fastValue =
    fast &&
    (settings.configOptions?.find(({ id }) => id === fast.id)?.value ??
      fast.currentValue);
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 4,
          minWidth: 0,
        }}
      >
        <Button
          size="small"
          type="text"
          aria-label={`${name} settings`}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {name}
        </Button>
        {claude && (
          <>
            <Tag style={{ margin: 0 }}>Preview</Tag>
            {inlineControls.map((control) => (
              <span key={control.id} style={{ minWidth: 0, maxWidth: "100%" }}>
                {select(control, true)}
              </span>
            ))}
            {!inlineControls.some(({ id }) => id === "model") && (
              <Button
                size="small"
                type="text"
                loading={loading}
                onClick={() => void discover()}
                disabled={!onDiscover}
              >
                {loading ? "Loading model" : "Model unavailable - retry"}
              </Button>
            )}
            {fast && ["on", "true", "enabled"].includes(fastValue ?? "") && (
              <Button size="small" type="text" onClick={() => setOpen(true)}>
                Fast on
              </Button>
            )}
            {projectId && threadKey && (
              <ClaudePaymentStatus
                projectId={projectId}
                threadKey={threadKey}
                onConfigure={() => setOpen(true)}
              />
            )}
          </>
        )}
      </div>
      {error && <div role="alert">{error}</div>}
      <Modal
        open={open}
        title={claude ? "Claude Code settings" : "ACP harness settings"}
        footer={null}
        onCancel={() => setOpen(false)}
        modalRender={(modal) => <KeyboardBoundary>{modal}</KeyboardBoundary>}
        styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
      >
        {form}
      </Modal>
    </>
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
