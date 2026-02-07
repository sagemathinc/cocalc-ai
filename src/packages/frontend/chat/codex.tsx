import {
  Alert,
  Button,
  Collapse,
  Divider,
  Form,
  Input,
  message,
  Modal,
  Radio,
  Select,
  Space,
  Typography,
} from "antd";
import {
  React,
  useEffect,
  useMemo,
  useState,
} from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import {
  DEFAULT_CODEX_MODELS,
  resolveCodexSessionMode,
  type CodexReasoningLevel,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
import { COLORS } from "@cocalc/util/theme";
import type { CodexThreadConfig } from "@cocalc/chat";
import type { ChatActions } from "./actions";

const { Text } = Typography;
const DEFAULT_MODEL_NAME = DEFAULT_CODEX_MODELS[0].name;

type ModeOption = {
  value: CodexSessionMode;
  label: string;
  description: string;
  warning?: boolean;
};

const MODE_OPTIONS: ModeOption[] = [
  {
    value: "read-only",
    label: "Read only",
    description:
      "Inspect files safely. Commands that would modify files will fail.",
  },
  {
    value: "workspace-write",
    label: "Workspace write",
    description:
      "Allow edits inside this workspace only (network access is allowed). System-wide changes are blocked.",
  },
  {
    value: "full-access",
    label: "Full access",
    description:
      "Run commands with network access and edit files outside this workspace. Extremely powerful—use with caution.",
    warning: true,
  },
];

export interface CodexConfigButtonProps {
  threadKey: string;
  chatPath: string;
  projectId?: string;
  actions?: ChatActions;
}

type ModelOption = {
  value: string;
  label: string;
  thinking?: string;
  description?: string;
  reasoning?: CodexReasoningLevel[];
};

type DeviceAuthState = "pending" | "completed" | "failed" | "canceled";

type DeviceAuthStatus = {
  id: string;
  projectId: string;
  accountId: string;
  codexHome: string;
  state: DeviceAuthState;
  verificationUrl?: string;
  userCode?: string;
  output: string;
  startedAt: number;
  updatedAt: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
};

type DeviceAuthRateLimitInfo = {
  limited: boolean;
  message?: string;
};

const DEVICE_AUTH_ALERT_TYPE: Record<
  DeviceAuthState,
  "info" | "success" | "error" | "warning"
> = {
  pending: "info",
  completed: "success",
  failed: "error",
  canceled: "warning",
};

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <Text strong style={{ color: COLORS.GRAY_D }}>
    {children}
  </Text>
);

const formItemStyle = { marginBottom: 12 } as const;
const gridTwoColStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
  width: "100%",
} as const;

function getDeviceAuthRateLimitInfo(
  deviceAuth: DeviceAuthStatus | null,
  deviceAuthError: string,
): DeviceAuthRateLimitInfo {
  const text = [
    deviceAuthError,
    deviceAuth?.error,
    deviceAuth?.output,
  ]
    .filter(Boolean)
    .join("\n");
  if (!text) return { limited: false };
  const limited =
    /429/i.test(text) ||
    /too many requests/i.test(text) ||
    /rate[-\s]?limit/i.test(text);
  if (!limited) return { limited: false };
  return {
    limited: true,
    message:
      "OpenAI is temporarily rate-limiting device login requests for this source. Wait a bit before retrying to avoid extending the throttle window.",
  };
}

function getPossibleThrottleInfo(
  deviceAuth: DeviceAuthStatus | null,
): string | undefined {
  if (deviceAuth?.state !== "failed") return;
  if (!/codex login exited with code=1/i.test(deviceAuth.error ?? "")) return;
  if ((deviceAuth.output ?? "").trim()) return;
  return "This can happen when OpenAI throttles repeated device-auth attempts from the same host. Wait a few minutes, then retry.";
}

export function CodexConfigButton({
  threadKey,
  chatPath,
  projectId,
  actions,
}: CodexConfigButtonProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [value, setValue] = useState<Partial<CodexThreadConfig> | null>(null);
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthStatus | null>(null);
  const [deviceAuthError, setDeviceAuthError] = useState<string>("");
  const [deviceAuthActionPending, setDeviceAuthActionPending] =
    useState<boolean>(false);

  useEffect(() => {
    const initialModels = DEFAULT_CODEX_MODELS.map((m) => ({
      value: m.name,
      label: m.name,
      thinking: m.reasoning?.find((r) => r.default)?.label,
      description: m.description,
      reasoning: m.reasoning,
    }));
    setModels(initialModels);
  }, []);

  useEffect(() => {
    if (!models.length) return;
    const ms = parseInt(threadKey, 10);
    if (Number.isNaN(ms)) {
      console.warn("invalid chat message threadKey", { threadKey });
      return;
    }
    const baseModel = models[0]?.value ?? DEFAULT_MODEL_NAME;
    const baseReasoning = getReasoningForModel({
      models,
      modelValue: baseModel,
    });
    const defaults: CodexThreadConfig = {
      workingDirectory: defaultWorkingDir(chatPath),
      sessionId: "",
      model: baseModel,
      reasoning: baseReasoning,
      envHome: "",
      envPath: "",
      sessionMode: "workspace-write" as CodexSessionMode,
    };
    const saved = actions?.getCodexConfig?.(new Date(ms));
    const merged: CodexThreadConfig = { ...defaults, ...saved };
    const model = models.some((m) => m.value === merged.model)
      ? merged.model
      : baseModel;
    const reasoning = getReasoningForModel({
      models,
      modelValue: model,
      desired: merged.reasoning,
    });
    const sessionMode = resolveCodexSessionMode(merged);
    form.resetFields();
    const currentValue = {
      ...merged,
      model,
      reasoning,
      sessionMode,
    };
    form.setFieldsValue(currentValue);
    setValue(currentValue);
  }, [models, threadKey, chatPath, actions, form, open]);

  const selectedModelValue = Form.useWatch("model", form) ?? value?.model;
  const selectedReasoningValue =
    Form.useWatch("reasoning", form) ?? value?.reasoning;
  const currentSessionMode =
    Form.useWatch("sessionMode", form) ?? value?.sessionMode;
  const reasoningOptions = useMemo(() => {
    const selected =
      models.find((m) => m.value === selectedModelValue) ?? models[0];
    return (
      selected?.reasoning?.map((r) => ({
        value: r.id,
        label: r.label,
        description: r.description,
        default: r.default,
      })) ?? []
    );
  }, [models, selectedModelValue]);
  const selectedReasoningLabel =
    reasoningOptions.find((r) => r.value === selectedReasoningValue)?.label ??
    "";
  const deviceCodeExpiresAt =
    deviceAuth?.startedAt != null
      ? new Date(deviceAuth.startedAt + 15 * 60 * 1000)
      : undefined;
  const rateLimitInfo = useMemo(
    () => getDeviceAuthRateLimitInfo(deviceAuth, deviceAuthError),
    [deviceAuth, deviceAuthError],
  );
  const possibleThrottleInfo = useMemo(
    () => getPossibleThrottleInfo(deviceAuth),
    [deviceAuth],
  );

  const saveConfig = () => {
    const values = form.getFieldsValue();
    const sessionMode: CodexSessionMode =
      values.sessionMode ?? resolveCodexSessionMode(values);
    const finalValues = {
      ...values,
      sessionMode,
      allowWrite: sessionMode !== "read-only",
    };
    actions?.setCodexConfig?.(threadKey, finalValues);
    setTimeout(() => {
      setOpen(false);
    }, 1);
  };

  const onSave = () => saveConfig();

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement("textarea");
        el.value = text;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.focus();
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      void message.success(`${label} copied`);
    } catch (err) {
      void message.error(`Unable to copy ${label.toLowerCase()}: ${getErrorMessage(err)}`);
    }
  };

  const copyDeviceCode = async (): Promise<void> => {
    const code = deviceAuth?.userCode?.trim();
    if (!code) return;
    await copyText(code, "Device code");
  };

  const copyDeviceUrl = async (): Promise<void> => {
    const url = deviceAuth?.verificationUrl?.trim();
    if (!url) return;
    await copyText(url, "Verification URL");
  };

  const updateConfig = (patch: Partial<CodexThreadConfig>) => {
    const base = value ?? form.getFieldsValue();
    const next = { ...base, ...patch };
    const sessionMode: CodexSessionMode =
      next.sessionMode ?? resolveCodexSessionMode(next);
    const finalValues = {
      ...next,
      sessionMode,
      allowWrite: sessionMode !== "read-only",
    };
    actions?.setCodexConfig?.(threadKey, finalValues);
    setValue(finalValues);
    form.setFieldsValue(finalValues);
  };

  const modeOptions = MODE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
  }));

  const getErrorMessage = (err: unknown): string => {
    if (err instanceof Error) {
      return err.message;
    }
    return `${err}`;
  };

  const startDeviceAuth = async () => {
    if (!projectId) {
      setDeviceAuthError("No project selected.");
      return;
    }
    setDeviceAuthActionPending(true);
    setDeviceAuthError("");
    try {
      const status =
        await webapp_client.conat_client.hub.projects.codexDeviceAuthStart({
          project_id: projectId,
        });
      setDeviceAuth(status as DeviceAuthStatus);
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    } finally {
      setDeviceAuthActionPending(false);
    }
  };

  const refreshDeviceAuth = async (id?: string) => {
    if (!projectId) return;
    const authId = id ?? deviceAuth?.id;
    if (!authId) return;
    try {
      const status =
        await webapp_client.conat_client.hub.projects.codexDeviceAuthStatus({
          project_id: projectId,
          id: authId,
        });
      setDeviceAuth(status as DeviceAuthStatus);
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    }
  };

  const cancelDeviceAuth = async () => {
    if (!projectId || !deviceAuth?.id) return;
    setDeviceAuthActionPending(true);
    setDeviceAuthError("");
    try {
      await webapp_client.conat_client.hub.projects.codexDeviceAuthCancel({
        project_id: projectId,
        id: deviceAuth.id,
      });
      await refreshDeviceAuth(deviceAuth.id);
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    } finally {
      setDeviceAuthActionPending(false);
    }
  };

  useEffect(() => {
    if (
      !open ||
      !projectId ||
      deviceAuth?.state !== "pending" ||
      !deviceAuth.id
    ) {
      return;
    }
    const timer = setInterval(() => {
      void refreshDeviceAuth(deviceAuth.id);
    }, 1500);
    return () => clearInterval(timer);
  }, [open, projectId, deviceAuth?.id, deviceAuth?.state]);

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 6px",
          background: "white",
          border: "1px solid #d9d9d9",
          borderRadius: 6,
        }}
      >
        <Button size="small" onClick={() => setOpen(true)}>
          Codex
        </Button>
        <Select
          size="small"
          value={currentSessionMode}
          options={modeOptions}
          style={{ minWidth: 140 }}
          onChange={(val) => {
            updateConfig({ sessionMode: val as CodexSessionMode });
          }}
        />
        <Select
          size="small"
          value={selectedModelValue}
          options={models}
          style={{ minWidth: 160 }}
          onChange={(val) => {
            const nextReasoning = getReasoningForModel({
              models,
              modelValue: val,
            });
            updateConfig({ model: val, reasoning: nextReasoning });
          }}
        />
        <Select
          size="small"
          value={selectedReasoningValue}
          options={reasoningOptions}
          style={{ minWidth: 140 }}
          onChange={(val) => {
            updateConfig({ reasoning: val });
          }}
          disabled={reasoningOptions.length === 0}
        />
      </div>
      <Modal
        open={open}
        title="Codex Session Configuration"
        okText="Save"
        onOk={onSave}
        onCancel={() => setOpen(false)}
        width={560}
        bodyStyle={{ maxHeight: "75vh", overflowY: "auto" }}
      >
        <Space orientation="vertical" style={{ width: "100%" }} size={12}>
          <Form form={form} layout="vertical">
            <SectionTitle>Session basics</SectionTitle>
            <div style={gridTwoColStyle}>
              <Form.Item
                label="Working directory"
                name="workingDirectory"
                style={formItemStyle}
              >
                <Input
                  placeholder="Derived from the directory containing this chat"
                  disabled
                />
              </Form.Item>
              <Form.Item
                label="Session ID"
                name="sessionId"
                tooltip="Optional. Reuse a Codex session to keep continuity."
                style={formItemStyle}
              >
                <Input
                  placeholder="Leave blank to create a new session"
                  allowClear
                />
              </Form.Item>
            </div>
            <div style={gridTwoColStyle}>
              <Form.Item label="Model" name="model" style={formItemStyle}>
                <Select
                  placeholder="e.g., gpt-5.3-codex"
                  options={models}
                  optionRender={(option) =>
                    renderOptionWithDescription({
                      title: `${option.data.label}${
                        option.data.value === selectedModelValue &&
                        selectedReasoningLabel
                          ? ` (${selectedReasoningLabel})`
                          : option.data.thinking
                            ? ` (${option.data.thinking})`
                            : ""
                      }`,
                      description: option.data.description,
                    })
                  }
                  showSearch
                  allowClear
                  onChange={(val) => {
                    const selected = models.find((m) => m.value === val);
                    if (selected?.reasoning?.length) {
                      const def =
                        selected.reasoning.find((r) => r.default)?.id ??
                        selected.reasoning[0]?.id;
                      form.setFieldsValue({ reasoning: def });
                    }
                  }}
                />
              </Form.Item>
              <Form.Item
                label="Reasoning level"
                name="reasoning"
                style={formItemStyle}
              >
                <Select
                  placeholder="Select reasoning"
                  options={reasoningOptions}
                  optionRender={(option) =>
                    renderOptionWithDescription({
                      title: `${option.data.label}${
                        option.data.default ? " (default)" : ""
                      }`,
                      description: option.data.description,
                    })
                  }
                />
              </Form.Item>
            </div>
            <Divider style={{ margin: "12px 0" }} />
            <SectionTitle>Advanced options</SectionTitle>
            <Collapse size="small" bordered={false}>
              <Collapse.Panel
                header="Environment overrides"
                key="env"
                style={{ border: "none" }}
              >
                <Form.Item
                  label="HOME override"
                  name="envHome"
                  tooltip="Optional. Overrides HOME for the Codex CLI."
                  extra="Useful if Codex needs a different HOME than this notebook."
                  style={formItemStyle}
                >
                  <Input placeholder="Use logged-in Codex HOME if needed" />
                </Form.Item>
                <Form.Item
                  label="PATH override"
                  name="envPath"
                  tooltip="Optional. Ensures the codex CLI is on PATH."
                  extra="Provide a PATH string containing the codex binary."
                  style={formItemStyle}
                >
                  <Input placeholder="Custom PATH for codex binary" />
                </Form.Item>
              </Collapse.Panel>
            </Collapse>
            <Divider style={{ margin: "12px 0" }} />
            <SectionTitle>Authentication</SectionTitle>
            <Space direction="vertical" style={{ width: "100%" }} size={8}>
              <Text type="secondary">
                Connect a ChatGPT subscription to Codex using device login.
              </Text>
              {!projectId && (
                <Alert
                  type="warning"
                  showIcon
                  message="Project context required"
                  description="Open this chat in a project before starting device login."
                />
              )}
              <Space wrap>
                <Button
                  type="primary"
                  onClick={() => void startDeviceAuth()}
                  loading={deviceAuthActionPending}
                  disabled={!projectId || deviceAuth?.state === "pending"}
                >
                  Start device login
                </Button>
                <Button
                  onClick={() => void refreshDeviceAuth()}
                  disabled={
                    !projectId || !deviceAuth?.id || deviceAuthActionPending
                  }
                >
                  Refresh
                </Button>
                <Button
                  danger
                  onClick={() => void cancelDeviceAuth()}
                  loading={deviceAuthActionPending}
                  disabled={
                    !projectId ||
                    !deviceAuth?.id ||
                    deviceAuth?.state !== "pending"
                  }
                >
                  Cancel
                </Button>
              </Space>
              {deviceAuthError ? (
                <Alert type="error" showIcon message={deviceAuthError} />
              ) : null}
              {rateLimitInfo.limited ? (
                <Alert
                  type="warning"
                  showIcon
                  message="Device auth is currently rate-limited (HTTP 429)"
                  description={rateLimitInfo.message}
                />
              ) : null}
              {possibleThrottleInfo ? (
                <Alert
                  type="warning"
                  showIcon
                  message="Device auth may be temporarily throttled"
                  description={possibleThrottleInfo}
                />
              ) : null}
              {deviceAuth ? (
                deviceAuth.state === "completed" ? (
                  <Alert
                    type="success"
                    showIcon
                    style={{ borderWidth: 2, padding: 12 }}
                    message={
                      <span style={{ fontSize: 17, fontWeight: 700 }}>
                        Device authentication complete
                      </span>
                    }
                    description={
                      <span style={{ fontSize: 14 }}>
                        Your ChatGPT subscription is now connected for Codex on
                        this project-host. You can close this dialog and run a
                        Codex turn.
                      </span>
                    }
                  />
                ) : (
                  <Alert
                    type={DEVICE_AUTH_ALERT_TYPE[deviceAuth.state]}
                    showIcon
                    message={`Device auth status: ${deviceAuth.state}`}
                    description={
                      deviceAuth.state === "pending"
                        ? "Polling status every 1.5 seconds while this dialog is open."
                        : deviceAuth.error
                          ? deviceAuth.error
                          : undefined
                    }
                  />
                )
              ) : null}
              {deviceAuth?.userCode && deviceAuth.state !== "completed" ? (
                <div
                  style={{
                    border: "1px solid #d9d9d9",
                    borderRadius: 8,
                    padding: 12,
                    background: "#fafafa",
                  }}
                >
                  <Text type="secondary">1. Copy this one-time code</Text>
                  {deviceCodeExpiresAt ? (
                    <div style={{ marginTop: 4 }}>
                      <Text type="secondary">
                        Code expires <TimeAgo date={deviceCodeExpiresAt} />
                      </Text>
                    </div>
                  ) : null}
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 28,
                        lineHeight: "34px",
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {deviceAuth.userCode}
                    </Text>
                    <Button onClick={() => void copyDeviceCode()}>Copy code</Button>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary">
                      Device codes are a common phishing target. Never share this code.
                    </Text>
                  </div>
                </div>
              ) : null}
              {deviceAuth?.verificationUrl && deviceAuth.state !== "completed" ? (
                <div
                  style={{
                    border: "1px solid #d9d9d9",
                    borderRadius: 8,
                    padding: 12,
                    background: "#fafafa",
                  }}
                >
                  <Text type="secondary">
                    2.{" "}
                    <a
                      href={deviceAuth.verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open this link
                    </a>{" "}
                    in your browser, sign in to your account, and paste the
                    one-time code.
                  </Text>
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 16,
                        lineHeight: "22px",
                        fontWeight: 600,
                        wordBreak: "break-all",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      {deviceAuth.verificationUrl}
                    </Text>
                    <Space>
                      <Button
                        onClick={() => void copyDeviceUrl()}
                      >
                        Copy URL
                      </Button>
                      <Button
                        type="primary"
                        href={deviceAuth.verificationUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                      </Button>
                    </Space>
                  </div>
                </div>
              ) : null}
              {deviceAuth?.output ? (
                <Collapse size="small" bordered={false}>
                  <Collapse.Panel
                    key="device-auth-output"
                    header="Show raw Codex output"
                    style={{ border: "none", paddingInline: 0 }}
                  >
                    <Input.TextArea
                      readOnly
                      value={deviceAuth.output}
                      autoSize={{ minRows: 3, maxRows: 10 }}
                    />
                  </Collapse.Panel>
                </Collapse>
              ) : null}
            </Space>
            <Divider style={{ margin: "12px 0" }} />
            <Form.Item
              label="Execution mode"
              name="sessionMode"
              tooltip="Control how much access Codex has inside your project."
              style={formItemStyle}
            >
              <Radio.Group style={{ width: "100%" }}>
                <Space
                  orientation="vertical"
                  size={8}
                  style={{ width: "100%" }}
                >
                  {MODE_OPTIONS.map((option) => {
                    const selected = currentSessionMode === option.value;
                    return (
                      <div
                        key={option.value}
                        style={{
                          border: `1px solid ${
                            selected ? COLORS.BLUE : COLORS.GRAY_L
                          }`,
                          borderRadius: 8,
                          padding: 10,
                          background: selected ? COLORS.GRAY_LL : undefined,
                        }}
                      >
                        <Radio value={option.value} style={{ width: "100%" }}>
                          <div>
                            <strong
                              style={{
                                color: option.warning
                                  ? COLORS.FG_RED
                                  : COLORS.GRAY_D,
                              }}
                            >
                              {option.label}
                            </strong>
                            <div
                              style={{
                                fontSize: 12,
                                color: option.warning
                                  ? COLORS.FG_RED
                                  : COLORS.GRAY_M,
                              }}
                            >
                              {option.description}
                            </div>
                          </div>
                        </Radio>
                      </div>
                    );
                  })}
                </Space>
              </Radio.Group>
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </>
  );
}

export default CodexConfigButton;

function getReasoningForModel({
  models,
  modelValue,
  desired,
}: {
  models: ModelOption[];
  modelValue?: string;
  desired?: CodexReasoningId;
}): CodexReasoningId | undefined {
  if (!models.length) return undefined;
  const model =
    models.find((m) => m.value === modelValue) ?? models[0] ?? undefined;
  const options = model?.reasoning;
  if (!options?.length) return undefined;
  const match = options.find((r) => r.id === desired);
  return match?.id ?? options.find((r) => r.default)?.id ?? options[0]?.id;
}

function renderOptionWithDescription({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div style={{ lineHeight: "18px" }}>
      <div>{title}</div>
      {description ? (
        <div style={{ fontSize: 11, color: "#888", lineHeight: "14px" }}>
          {description}
        </div>
      ) : null}
    </div>
  );
}

function defaultWorkingDir(chatPath: string): string {
  if (!chatPath) return ".";
  const i = chatPath.lastIndexOf("/");
  if (i <= 0) return ".";
  return chatPath.slice(0, i);
}
