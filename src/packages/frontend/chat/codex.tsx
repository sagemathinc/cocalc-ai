import {
  Alert,
  Button,
  Divider,
  Form,
  Input,
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
import { Tooltip } from "@cocalc/frontend/components/tip";
import { lite } from "@cocalc/frontend/lite";
import { CodexCredentialsPanel } from "@cocalc/frontend/account/codex-credentials-panel";
import LiteAISettings from "@cocalc/frontend/account/lite-ai-settings";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  defaultWorkingDirectoryForChat,
  useWorkspaceChatWorkingDirectory,
} from "@cocalc/frontend/project/workspaces/chat-defaults";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import {
  DEFAULT_CODEX_MODELS,
  normalizeCodexSessionId,
  resolveCodexSessionMode,
  type CodexReasoningLevel,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
import { COLORS } from "@cocalc/util/theme";
import type { CodexThreadConfig } from "@cocalc/chat";
import type { ChatActions } from "./actions";
import {
  getCodexNewChatModeOptions,
  getDefaultCodexSessionMode,
} from "./codex-defaults";
import { getLatestAcpThreadIdForThread } from "./thread-session";
import {
  getCodexPaymentSourceShortLabel,
  getCodexPaymentSourceTooltip,
} from "./use-codex-payment-source";

const { Text } = Typography;
const DEFAULT_MODEL_NAME = DEFAULT_CODEX_MODELS[0].name;
const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

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
      "Allow edits inside this project only (network access is allowed). System-wide changes are blocked.",
  },
  {
    value: "full-access",
    label: "Full access",
    description:
      "Run commands with network access and edit files outside this project. Extremely powerful—use with caution.",
    warning: true,
  },
];

export interface CodexConfigButtonProps {
  threadKey: string;
  chatPath: string;
  projectId?: string;
  actions?: ChatActions;
  threadConfig?: Partial<CodexThreadConfig> | null;
  paymentSource?: CodexPaymentSourceInfo;
  paymentSourceLoading?: boolean;
  refreshPaymentSource?: () => void;
}

type ModelOption = {
  value: string;
  label: string;
  description?: string;
  reasoning?: CodexReasoningLevel[];
};

type LiteCodexLocalStatus = {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  error?: string;
  checkedAt?: number;
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

export function CodexConfigButton({
  threadKey,
  chatPath,
  projectId,
  actions,
  threadConfig,
  paymentSource,
  paymentSourceLoading = false,
  refreshPaymentSource,
}: CodexConfigButtonProps): React.ReactElement {
  const defaultSessionMode = getDefaultCodexSessionMode();
  const workspaceWorkingDirectory = useWorkspaceChatWorkingDirectory(chatPath);
  const [open, setOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [liteCodexStatus, setLiteCodexStatus] = useState<
    LiteCodexLocalStatus | undefined
  >(undefined);
  const [liteCodexStatusLoading, setLiteCodexStatusLoading] = useState(false);
  const [form] = Form.useForm();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [value, setValue] = useState<Partial<CodexThreadConfig> | null>(null);

  useEffect(() => {
    const initialModels = DEFAULT_CODEX_MODELS.map((m) => ({
      value: m.name,
      label: m.name,
      description: m.description,
      reasoning: m.reasoning,
    }));
    setModels(initialModels);
  }, []);

  useEffect(() => {
    if (!models.length) return;
    const threadId = `${threadKey ?? ""}`.trim();
    if (!threadId) {
      console.warn("invalid chat thread id", { threadKey });
      return;
    }
    const baseModel = models[0]?.value ?? DEFAULT_MODEL_NAME;
    const baseReasoning = getReasoningForModel({
      models,
      modelValue: baseModel,
    });
    const defaults: CodexThreadConfig = {
      workingDirectory: defaultWorkingDir(chatPath, workspaceWorkingDirectory),
      sessionId: "",
      model: baseModel,
      reasoning: baseReasoning,
      sessionMode: defaultSessionMode,
    };
    const saved = threadConfig ?? actions?.getCodexConfig?.(threadId);
    const liveSessionId = getLatestAcpThreadIdForThread({
      actions,
      threadId,
    });
    const merged: CodexThreadConfig = { ...defaults, ...saved };
    merged.sessionId =
      normalizeCodexSessionId(merged.sessionId) ?? liveSessionId ?? "";
    const model = models.some((m) => m.value === merged.model)
      ? merged.model
      : baseModel;
    const reasoning = getReasoningForModel({
      models,
      modelValue: model,
      desired: merged.reasoning,
    });
    const sessionMode = normalizeSessionMode(merged) ?? defaultSessionMode;
    form.resetFields();
    const currentValue = {
      ...merged,
      model,
      reasoning,
      sessionMode,
    };
    form.setFieldsValue(currentValue);
    setValue(currentValue);
  }, [
    models,
    threadKey,
    chatPath,
    actions,
    form,
    open,
    threadConfig,
    defaultSessionMode,
    workspaceWorkingDirectory,
  ]);

  const selectedModelValue = Form.useWatch("model", form) ?? value?.model;
  const selectedReasoningValue =
    Form.useWatch("reasoning", form) ?? value?.reasoning;
  const currentSessionMode =
    Form.useWatch("sessionMode", form) ?? value?.sessionMode;
  const availableModeValues = useMemo(
    () => new Set(getCodexNewChatModeOptions().map(({ value }) => value)),
    [],
  );
  const modeOptions = useMemo(
    () =>
      MODE_OPTIONS.filter((option) => availableModeValues.has(option.value)),
    [availableModeValues],
  );
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
  const sourceShortLabel = paymentSourceLoading
    ? "Checking…"
    : getCodexPaymentSourceShortLabel(paymentSource?.source);
  const sourceTooltip = getCodexPaymentSourceTooltip(paymentSource);

  const saveConfig = () => {
    const values = form.getFieldsValue();
    const sessionMode: CodexSessionMode =
      normalizeSessionMode(values) ?? defaultSessionMode;
    const finalValues = {
      ...values,
      sessionId: normalizeCodexSessionId(values?.sessionId),
      sessionMode,
      allowWrite: sessionMode !== "read-only",
    };
    actions?.setCodexConfig?.(threadKey, finalValues);
    setTimeout(() => {
      setOpen(false);
    }, 1);
  };

  const onSave = () => saveConfig();

  const updateConfig = (patch: Partial<CodexThreadConfig>) => {
    const base = value ?? form.getFieldsValue();
    const next = { ...base, ...patch };
    const sessionMode: CodexSessionMode =
      normalizeSessionMode(next) ?? defaultSessionMode;
    const finalValues = {
      ...next,
      sessionId: normalizeCodexSessionId(next?.sessionId),
      sessionMode,
      allowWrite: sessionMode !== "read-only",
    };
    actions?.setCodexConfig?.(threadKey, finalValues);
    setValue(finalValues);
    form.setFieldsValue(finalValues);
  };

  const compactModeOptions = modeOptions.map((option) => ({
    value: option.value,
    label: option.label,
  }));

  useEffect(() => {
    if (!lite || !paymentOpen) return;
    let cancelled = false;
    const loadStatus = async () => {
      setLiteCodexStatusLoading(true);
      try {
        const systemApi: any = webapp_client.conat_client.hub.system as any;
        if (typeof systemApi.getCodexLocalStatus !== "function") {
          if (!cancelled) {
            setLiteCodexStatus(undefined);
          }
          return;
        }
        const result = await systemApi.getCodexLocalStatus();
        if (cancelled) return;
        setLiteCodexStatus(result as LiteCodexLocalStatus);
      } catch (err) {
        if (cancelled) return;
        setLiteCodexStatus({
          installed: false,
          error: `${err}`,
        });
      } finally {
        if (!cancelled) {
          setLiteCodexStatusLoading(false);
        }
      }
    };
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [paymentOpen]);

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
        <Tooltip title={sourceTooltip}>
          <Button size="small" onClick={() => setPaymentOpen(true)}>
            {sourceShortLabel}
          </Button>
        </Tooltip>
        <Select
          size="small"
          value={currentSessionMode}
          options={compactModeOptions}
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
        styles={{ body: { maxHeight: "75vh", overflowY: "auto" } }}
      >
        <Space orientation="vertical" style={{ width: "100%" }} size={12}>
          <Form form={form} layout="vertical">
            <SectionTitle>Session basics</SectionTitle>
            <div style={gridTwoColStyle}>
              <Form.Item
                label="Working directory"
                name="workingDirectory"
                tooltip="Codex runs in this directory for subsequent turns."
                style={formItemStyle}
              >
                <Input placeholder="Derived from the directory containing this chat" />
              </Form.Item>
              <Form.Item
                label="Session ID"
                name="sessionId"
                tooltip="Reuse a Codex session to keep continuity."
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
                  placeholder="e.g., gpt-5.4"
                  options={models}
                  optionRender={(option) =>
                    renderOptionWithDescription({
                      title: `${option.data.label}`,
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
                  {modeOptions.map((option) => {
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
      <Modal
        open={paymentOpen}
        title="Codex Payment & Credentials"
        footer={null}
        onCancel={() => setPaymentOpen(false)}
        width={760}
        styles={{ body: { maxHeight: "75vh", overflowY: "auto" } }}
      >
        {lite ? (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <Text strong>Choose one: ChatGPT Plan or OpenAI API key</Text>
            <Text type="secondary">
              Configure Codex from this modal. If both are configured, ChatGPT
              Plan is used.
            </Text>
            {liteCodexStatusLoading ? (
              <Alert
                type="info"
                showIcon
                title="Checking local Codex install..."
              />
            ) : liteCodexStatus?.installed === false ? (
              <Alert
                type="warning"
                showIcon
                title="Codex CLI not detected"
                description={
                  liteCodexStatus.error
                    ? `Install Codex CLI and restart CoCalc Lite. Details: ${liteCodexStatus.error}`
                    : "Install Codex CLI and restart CoCalc Lite."
                }
              />
            ) : liteCodexStatus?.installed ? (
              <Alert
                type="success"
                showIcon
                title="Codex CLI detected"
                description={`${liteCodexStatus.binaryPath ?? "codex"}${
                  liteCodexStatus.version ? ` (${liteCodexStatus.version})` : ""
                }`}
              />
            ) : null}
            <CodexCredentialsPanel
              embedded
              hidePanelChrome
              defaultProjectId={projectId}
            />
            <Text type="secondary">
              <a href={CODEX_USAGE_URL} target="_blank" rel="noreferrer">
                View Codex usage in ChatGPT
              </a>
            </Text>
            <Divider style={{ margin: "8px 0" }} />
            <LiteAISettings onSaved={refreshPaymentSource} showTitle />
          </Space>
        ) : (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <CodexCredentialsPanel
              embedded
              hidePanelChrome
              defaultProjectId={projectId}
            />
            <Text type="secondary">
              <a href={CODEX_USAGE_URL} target="_blank" rel="noreferrer">
                View Codex usage in ChatGPT
              </a>
            </Text>
          </Space>
        )}
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

function normalizeSessionMode(
  config?: Partial<CodexThreadConfig>,
): CodexSessionMode | undefined {
  const mode = resolveCodexSessionMode(config as CodexThreadConfig);
  if (getCodexNewChatModeOptions().some(({ value }) => value === mode)) {
    return mode;
  }
  return getDefaultCodexSessionMode();
}

function defaultWorkingDir(
  chatPath: string,
  workspaceWorkingDirectory?: string,
): string {
  return defaultWorkingDirectoryForChat(chatPath, workspaceWorkingDirectory);
}
