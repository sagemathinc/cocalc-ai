import {
  Alert,
  Button,
  Divider,
  Dropdown,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import type { MenuProps } from "antd";
import {
  React,
  useEffect,
  useMemo,
  useState,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { lite } from "@cocalc/frontend/lite";
import {
  CodexCredentialsPanel,
  CodexUsageMeters,
} from "@cocalc/frontend/account/codex-credentials-panel";
import CodexSessionsPanel from "@cocalc/frontend/account/codex-sessions-panel";
import {
  CODEX_USAGE_LABEL,
  CODEX_USAGE_URL,
  getLiveCodexUsageStatus,
  readCachedCodexUsageStatus,
  writeCachedCodexUsageStatus,
} from "@cocalc/frontend/account/codex-usage";
import LiteAISettings from "@cocalc/frontend/account/lite-ai-settings";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  defaultWorkingDirectoryForChat,
  useWorkspaceChatWorkingDirectory,
} from "@cocalc/frontend/project/workspaces/chat-defaults";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import type {
  CodexPaymentSourceInfo,
  CodexUsageStatusInfo,
} from "@cocalc/conat/hub/api/system";
import {
  codexModelSupportsFastMode,
  DEFAULT_CODEX_MODELS,
  normalizeCodexSessionId,
  resolveCodexServiceTier,
  resolveCodexSessionMode,
  type CodexReasoningLevel,
  type CodexReasoningId,
  type CodexServiceTier,
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
const CODEX_CONTROLS_COLLAPSED_KEY = "cocalc.chat.codexControlsCollapsed";

type ModeOption = {
  value: CodexSessionMode;
  label: string;
  description: string;
  warning?: boolean;
};

function getModeOptions(): ModeOption[] {
  return [
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
      description: lite
        ? "Run commands with network access and edit files outside this workspace. Extremely powerful—use with caution."
        : "Run commands with network access and edit any files in this CoCalc project container. Extremely powerful—use with caution.",
      warning: true,
    },
  ];
}

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

export interface CodexPaymentCredentialsModalProps {
  open: boolean;
  projectId?: string;
  refreshPaymentSource?: () => void;
  onClose: () => void;
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
const sectionStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: 12,
  background: "white",
  padding: 14,
};
type PillSegment = "codex" | "expand" | "model" | "mode" | "reasoning";

const pillSegmentBaseStyle: React.CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: 0,
  borderRadius: 999,
  color: COLORS.GRAY_M,
  cursor: "pointer",
  display: "inline-flex",
  font: "inherit",
  lineHeight: 1.2,
  minWidth: 0,
  paddingBottom: 2,
  paddingLeft: 5,
  paddingRight: 5,
  paddingTop: 2,
  whiteSpace: "nowrap",
};

function readCodexControlsCollapsed(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(CODEX_CONTROLS_COLLAPSED_KEY) === "1"
    );
  } catch {
    return false;
  }
}

function writeCodexControlsCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(
      CODEX_CONTROLS_COLLAPSED_KEY,
      collapsed ? "1" : "0",
    );
  } catch {
    // Ignore storage errors; this is only a local display preference.
  }
}

export function CodexPaymentCredentialsModal({
  open,
  projectId,
  refreshPaymentSource,
  onClose,
}: CodexPaymentCredentialsModalProps): React.ReactElement {
  const [liteCodexStatus, setLiteCodexStatus] = useState<
    LiteCodexLocalStatus | undefined
  >(undefined);
  const [liteCodexStatusLoading, setLiteCodexStatusLoading] = useState(false);

  useEffect(() => {
    if (!lite || !open) return;
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
  }, [open]);

  return (
    <Modal
      open={open}
      title="Codex Payment & Credentials"
      footer={null}
      onCancel={onClose}
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
            onPaymentSourceChanged={refreshPaymentSource}
          />
          <Text type="secondary">
            CoCalc can show which source Codex will use. To check remaining
            ChatGPT Codex usage,{" "}
            <a href={CODEX_USAGE_URL} target="_blank" rel="noreferrer">
              {CODEX_USAGE_LABEL}
            </a>
            .
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
            onPaymentSourceChanged={refreshPaymentSource}
          />
          <Text type="secondary">
            CoCalc can show which source Codex will use. To check remaining
            ChatGPT Codex usage,{" "}
            <a href={CODEX_USAGE_URL} target="_blank" rel="noreferrer">
              {CODEX_USAGE_LABEL}
            </a>
            .
          </Text>
        </Space>
      )}
    </Modal>
  );
}

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
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [form] = Form.useForm();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [value, setValue] = useState<Partial<CodexThreadConfig> | null>(null);
  const [controlsCollapsed, setControlsCollapsed] = useState(
    readCodexControlsCollapsed,
  );
  const [codexUsageStatus, setCodexUsageStatus] = useState<
    CodexUsageStatusInfo | undefined
  >(undefined);
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [codexUsageStale, setCodexUsageStale] = useState(false);
  const [hoveredPillSegment, setHoveredPillSegment] = useState<
    PillSegment | undefined
  >(undefined);
  const lastAppliedThreadRef = React.useRef<string | undefined>(undefined);

  useEffect(() => {
    const initialModels = DEFAULT_CODEX_MODELS.map((m) => ({
      value: m.name,
      label: m.name,
      description: m.description,
      reasoning: m.reasoning,
    }));
    setModels(initialModels);
  }, []);

  const threadConfigKey = codexThreadConfigKey(threadConfig);

  useEffect(() => {
    if (!models.length) return;
    const threadId = `${threadKey ?? ""}`.trim();
    if (!threadId) {
      console.warn("invalid chat thread id", { threadKey });
      return;
    }
    const threadChanged = lastAppliedThreadRef.current !== threadId;
    if (open && !threadChanged) {
      return;
    }
    const baseModel = models[0]?.value ?? DEFAULT_MODEL_NAME;
    const baseReasoning = getReasoningForModel({
      models,
      modelValue: baseModel,
    });
    const defaults: CodexThreadConfig = {
      workingDirectory: defaultWorkingDir(
        chatPath,
        workspaceWorkingDirectory,
        getProjectHomeDirectory(projectId),
      ),
      sessionId: "",
      model: baseModel,
      reasoning: baseReasoning,
      serviceTier: "standard",
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
    const serviceTier = resolveCodexServiceTier({
      model,
      serviceTier: merged.serviceTier,
    });
    form.resetFields();
    const currentValue = {
      ...merged,
      model,
      reasoning,
      serviceTier,
      sessionMode,
    };
    form.setFieldsValue(currentValue);
    setValue(currentValue);
    lastAppliedThreadRef.current = threadId;
  }, [
    models,
    threadKey,
    chatPath,
    actions,
    form,
    open,
    threadConfigKey,
    defaultSessionMode,
    workspaceWorkingDirectory,
    projectId,
  ]);

  const selectedModelValue = Form.useWatch("model", form) ?? value?.model;
  const selectedReasoningValue =
    Form.useWatch("reasoning", form) ?? value?.reasoning;
  const currentSessionMode =
    Form.useWatch("sessionMode", form) ?? value?.sessionMode;
  const selectedServiceTierValue: CodexServiceTier =
    Form.useWatch("serviceTier", form) ?? value?.serviceTier ?? "standard";
  const allModeOptions = useMemo(() => getModeOptions(), []);
  const availableModeValues = useMemo(
    () => new Set(getCodexNewChatModeOptions().map(({ value }) => value)),
    [],
  );
  const modeOptions = useMemo(
    () =>
      allModeOptions.filter((option) => availableModeValues.has(option.value)),
    [allModeOptions, availableModeValues],
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

  useEffect(() => {
    if (!open || paymentSource?.source !== "subscription") {
      setCodexUsageStatus(undefined);
      setCodexUsageLoading(false);
      setCodexUsageStale(false);
      return;
    }
    let cancelled = false;
    const cached = readCachedCodexUsageStatus({ projectId });
    if (cached) {
      setCodexUsageStatus(cached.status);
      setCodexUsageStale(true);
    } else {
      setCodexUsageStatus(undefined);
      setCodexUsageStale(false);
    }
    setCodexUsageLoading(true);
    void getLiveCodexUsageStatus({ projectId })
      .then((status: CodexUsageStatusInfo) => {
        if (cancelled) return;
        setCodexUsageStatus(status);
        setCodexUsageStale(false);
        writeCachedCodexUsageStatus({ projectId, status });
      })
      .catch(() => {
        if (cancelled) return;
        if (!cached) {
          setCodexUsageStatus(undefined);
          setCodexUsageStale(false);
        }
      })
      .finally(() => {
        if (!cancelled) setCodexUsageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, paymentSource?.source, projectId]);

  const modeLabel =
    modeOptions.find((option) => option.value === currentSessionMode)?.label ??
    "Mode";
  const selectedModeOption = modeOptions.find(
    (option) => option.value === currentSessionMode,
  );
  const reasoningLabel =
    reasoningOptions.find((option) => option.value === selectedReasoningValue)
      ?.label ?? selectedReasoningValue;
  const fastModeSupported = codexModelSupportsFastMode(selectedModelValue);
  const effectiveServiceTier =
    selectedServiceTierValue === "fast" && fastModeSupported
      ? "fast"
      : "standard";
  const serviceTierLabel = effectiveServiceTier === "fast" ? "Fast" : undefined;
  const paymentNeedsAttention =
    paymentSourceLoading || paymentSource?.source === "none" || !paymentSource;
  const toggleControlsCollapsed = () => {
    setControlsCollapsed((collapsed) => {
      const next = !collapsed;
      writeCodexControlsCollapsed(next);
      return next;
    });
  };

  const normalizeConfigForSave = (
    values: Partial<CodexThreadConfig>,
  ): Partial<CodexThreadConfig> => {
    const sessionMode: CodexSessionMode =
      normalizeSessionMode(values) ?? defaultSessionMode;
    return {
      ...values,
      sessionId: normalizeCodexSessionId(values?.sessionId),
      sessionMode,
      serviceTier: resolveCodexServiceTier({
        model: values?.model,
        serviceTier: values?.serviceTier,
      }),
      allowWrite: sessionMode !== "read-only",
    };
  };

  const saveConfig = () => {
    const finalValues = normalizeConfigForSave(form.getFieldsValue());
    actions?.setCodexConfig?.(threadKey, finalValues);
    setTimeout(() => {
      setOpen(false);
    }, 1);
  };

  const onSave = () => saveConfig();

  const applyQuickConfigPatch = (patch: Partial<CodexThreadConfig>) => {
    const nextValues: Partial<CodexThreadConfig> = {
      ...(value ?? {}),
      ...form.getFieldsValue(),
      ...patch,
    };
    if (patch.model != null) {
      nextValues.reasoning = getReasoningForModel({
        models,
        modelValue: patch.model,
        desired: nextValues.reasoning,
      });
      if (!codexModelSupportsFastMode(patch.model)) {
        nextValues.serviceTier = "standard";
      }
    }
    const finalValues = normalizeConfigForSave(nextValues);
    form.setFieldsValue(finalValues);
    setValue(finalValues);
    actions?.setCodexConfig?.(threadKey, finalValues);
  };

  const modelMenu: MenuProps = {
    selectedKeys: selectedModelValue ? [selectedModelValue] : [],
    items: models.map((model) => ({
      key: model.value,
      label: model.label,
      title: model.description,
    })),
    onClick: ({ domEvent, key }) => {
      domEvent.stopPropagation();
      applyQuickConfigPatch({ model: `${key}` });
    },
  };

  const modeMenu: MenuProps = {
    selectedKeys: currentSessionMode ? [currentSessionMode] : [],
    items: modeOptions.map((option) => ({
      key: option.value,
      label: option.label,
      danger: option.warning,
      title: option.description,
    })),
    onClick: ({ domEvent, key }) => {
      domEvent.stopPropagation();
      applyQuickConfigPatch({ sessionMode: key as CodexSessionMode });
    },
  };

  const reasoningMenu: MenuProps = {
    selectedKeys: selectedReasoningValue ? [selectedReasoningValue] : [],
    items: reasoningOptions.map((option) => ({
      key: option.value,
      label: option.label,
      title: option.description,
    })),
    onClick: ({ domEvent, key }) => {
      domEvent.stopPropagation();
      applyQuickConfigPatch({ reasoning: key as CodexReasoningId });
    },
  };

  const pillSegmentStyle = (segment: PillSegment): React.CSSProperties => ({
    ...pillSegmentBaseStyle,
    background:
      hoveredPillSegment === segment ? COLORS.ANTD_BG_BLUE_L : "transparent",
    color: hoveredPillSegment === segment ? COLORS.BS_BLUE_TEXT : COLORS.GRAY_M,
    maxWidth: segment === "model" ? 170 : 120,
    overflow: "hidden",
    textOverflow: "ellipsis",
  });

  const pillSegmentHandlers = (segment: PillSegment) => ({
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation();
    },
    onMouseEnter: () => setHoveredPillSegment(segment),
    onMouseLeave: () => setHoveredPillSegment(undefined),
  });

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          maxWidth: "min(760px, calc(100vw - 32px))",
        }}
      >
        {controlsCollapsed ? (
          <span
            style={{
              alignItems: "center",
              background: "white",
              border: `1px solid ${COLORS.GRAY_L}`,
              borderRadius: 999,
              boxShadow: "0 1px 5px rgba(0,0,0,0.08)",
              display: "inline-flex",
              fontWeight: 600,
              gap: 2,
              overflow: "hidden",
              padding: "2px 6px",
            }}
          >
            <Tooltip title="Show Codex controls">
              <button
                type="button"
                aria-label="Expand Codex controls"
                onClick={toggleControlsCollapsed}
                onMouseEnter={() => setHoveredPillSegment("expand")}
                onMouseLeave={() => setHoveredPillSegment(undefined)}
                style={{
                  ...pillSegmentStyle("expand"),
                  color:
                    hoveredPillSegment === "expand"
                      ? COLORS.BS_BLUE_TEXT
                      : COLORS.GRAY_D,
                  fontWeight: 600,
                  paddingLeft: 3,
                  paddingRight: 3,
                }}
              >
                <Icon name="chevron-right" />
              </button>
            </Tooltip>
            <button
              type="button"
              onClick={() => setOpen(true)}
              onMouseEnter={() => setHoveredPillSegment("codex")}
              onMouseLeave={() => setHoveredPillSegment(undefined)}
              style={{
                ...pillSegmentStyle("codex"),
                color:
                  hoveredPillSegment === "codex"
                    ? COLORS.BS_BLUE_TEXT
                    : COLORS.GRAY_D,
                fontWeight: 600,
              }}
            >
              Codex
            </button>
          </span>
        ) : (
          <>
            <span
              onClick={() => setOpen(true)}
              style={{
                alignItems: "center",
                background: "white",
                border: `1px solid ${COLORS.GRAY_L}`,
                borderRadius: 999,
                boxShadow: "0 1px 5px rgba(0,0,0,0.08)",
                display: "inline-flex",
                fontWeight: 600,
                gap: 6,
                cursor: "pointer",
                maxWidth: "min(520px, calc(100vw - 220px))",
                overflow: "hidden",
                padding: "2px 8px",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: COLORS.BS_GREEN_D,
                  display: "inline-block",
                  flex: "0 0 auto",
                }}
              />
              <button
                type="button"
                onClick={() => setOpen(true)}
                style={{
                  ...pillSegmentBaseStyle,
                  color: COLORS.GRAY_D,
                  fontWeight: 600,
                  paddingLeft: 0,
                }}
              >
                Codex
              </button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                ·
              </Text>
              <Dropdown menu={modelMenu} trigger={["click"]}>
                <button
                  type="button"
                  title="Change Codex model"
                  style={pillSegmentStyle("model")}
                  {...pillSegmentHandlers("model")}
                >
                  {selectedModelValue}
                </button>
              </Dropdown>
              <Text type="secondary" style={{ fontSize: 12 }}>
                ·
              </Text>
              <Dropdown menu={modeMenu} trigger={["click"]}>
                <button
                  type="button"
                  title="Change Codex access mode"
                  style={pillSegmentStyle("mode")}
                  {...pillSegmentHandlers("mode")}
                >
                  {modeLabel}
                </button>
              </Dropdown>
              {reasoningLabel ? (
                <>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ·
                  </Text>
                  <Dropdown menu={reasoningMenu} trigger={["click"]}>
                    <button
                      type="button"
                      title="Change Codex thinking level"
                      style={pillSegmentStyle("reasoning")}
                      {...pillSegmentHandlers("reasoning")}
                    >
                      {reasoningLabel}
                    </button>
                  </Dropdown>
                </>
              ) : null}
              {serviceTierLabel ? (
                <>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ·
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {serviceTierLabel}
                  </Text>
                </>
              ) : null}
              <Tooltip title="Hide Codex controls">
                <button
                  type="button"
                  aria-label="Hide Codex controls"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleControlsCollapsed();
                  }}
                  onMouseEnter={() => setHoveredPillSegment("expand")}
                  onMouseLeave={() => setHoveredPillSegment(undefined)}
                  style={{
                    ...pillSegmentStyle("expand"),
                    color:
                      hoveredPillSegment === "expand"
                        ? COLORS.BS_BLUE_TEXT
                        : COLORS.GRAY_D,
                    fontWeight: 600,
                    paddingLeft: 3,
                    paddingRight: 3,
                  }}
                >
                  <Icon name="chevron-left" />
                </button>
              </Tooltip>
            </span>
            {paymentNeedsAttention ? (
              <Tooltip title={sourceTooltip}>
                <Button
                  size="small"
                  danger={paymentSource?.source === "none"}
                  onClick={() => setPaymentOpen(true)}
                  style={{
                    background:
                      paymentSource?.source === "none"
                        ? COLORS.ANTD_BG_RED_L
                        : "white",
                  }}
                >
                  {sourceShortLabel}
                </Button>
              </Tooltip>
            ) : null}
          </>
        )}
      </div>
      <Modal
        open={open}
        title="Codex settings"
        okText="Save"
        onOk={onSave}
        onCancel={() => setOpen(false)}
        width={720}
        styles={{
          body: {
            maxHeight: "75vh",
            overflowY: "auto",
            background: "white",
            paddingTop: 12,
          },
        }}
      >
        <Space orientation="vertical" style={{ width: "100%" }} size={12}>
          <div
            style={{
              ...sectionStyle,
              background: COLORS.ANTD_BG_BLUE_L,
              borderColor: COLORS.BS_BLUE_BGRND,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div>
              <Text strong style={{ color: COLORS.BS_BLUE_TEXT }}>
                Codex configuration for this chat
              </Text>
              <div
                style={{
                  color: COLORS.GRAY_M,
                  fontSize: 12,
                  marginTop: 4,
                  lineHeight: 1.35,
                }}
              >
                These settings apply to the selected Codex thread. The compact
                pill in chat shows the same model, access mode, and reasoning
                level.
              </div>
            </div>
            {paymentSource?.source === "subscription" ? (
              <div style={{ width: "100%" }}>
                {codexUsageLoading && !codexUsageStatus ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Checking ChatGPT Codex usage...
                  </Text>
                ) : null}
                <CodexUsageMeters
                  status={codexUsageStatus}
                  compact
                  stale={codexUsageStale}
                  updating={codexUsageLoading && codexUsageStale}
                />
              </div>
            ) : null}
            <Space
              wrap
              size={8}
              style={{
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <Space size={6} wrap style={{ justifyContent: "flex-end" }}>
                <Tag color="blue">{selectedModelValue ?? "Model"}</Tag>
                <Tag color={selectedModeOption?.warning ? "red" : "green"}>
                  {modeLabel}
                </Tag>
                {reasoningLabel ? <Tag>{reasoningLabel}</Tag> : null}
                {serviceTierLabel ? <Tag color="orange">Fast</Tag> : null}
              </Space>
              <Tooltip
                title={`Current source: ${
                  paymentSourceLoading ? "Checking..." : sourceShortLabel
                }. ${sourceTooltip}`}
              >
                <Button
                  icon={<Icon name="credit-card" />}
                  onClick={() => setPaymentOpen(true)}
                >
                  Payment & Credentials
                </Button>
              </Tooltip>
              <Button onClick={() => setSessionsOpen(true)}>
                View All Codex Sessions
              </Button>
            </Space>
          </div>
          <Form form={form} layout="vertical">
            <Space orientation="vertical" style={{ width: "100%" }} size={12}>
              <div style={sectionStyle}>
                <SectionTitle>Model and session</SectionTitle>
                <div
                  style={{
                    color: COLORS.GRAY_M,
                    fontSize: 12,
                    margin: "3px 0 10px",
                  }}
                >
                  Choose the model, access continuity, and directory Codex uses
                  for future turns.
                </div>
                <div style={gridTwoColStyle}>
                  <Form.Item label="Model" name="model" style={formItemStyle}>
                    <Select
                      placeholder="e.g., gpt-5.5"
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
                        if (!codexModelSupportsFastMode(val)) {
                          form.setFieldsValue({ serviceTier: "standard" });
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
                <Form.Item
                  label="Speed"
                  name="serviceTier"
                  tooltip="Fast mode uses more Codex credits. Standard is the default."
                  style={{ marginBottom: 0 }}
                >
                  <Radio.Group>
                    <Space wrap>
                      <Radio value="standard">Standard</Radio>
                      <Radio value="fast" disabled={!fastModeSupported}>
                        Fast
                      </Radio>
                    </Space>
                  </Radio.Group>
                </Form.Item>
                {effectiveServiceTier === "fast" ? (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 10 }}
                    message="Fast mode uses more Codex credits"
                    description="Use this only when lower latency is worth the higher cost."
                  />
                ) : null}
              </div>
              <div style={sectionStyle}>
                <SectionTitle>Access</SectionTitle>
                <div
                  style={{
                    color: COLORS.GRAY_M,
                    fontSize: 12,
                    margin: "3px 0 10px",
                  }}
                >
                  Control whether Codex can only inspect files, edit this
                  workspace, or use full project-container access.
                </div>
                <Form.Item
                  name="sessionMode"
                  tooltip="Control how much access Codex has inside your project."
                  style={{ marginBottom: 0 }}
                >
                  <Radio.Group style={{ width: "100%" }}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(185px, 1fr))",
                        gap: 8,
                      }}
                    >
                      {modeOptions.map((option) => {
                        const selected = currentSessionMode === option.value;
                        return (
                          <label
                            key={option.value}
                            style={{
                              border: `1px solid ${
                                selected ? COLORS.BLUE : COLORS.GRAY_L
                              }`,
                              borderRadius: 10,
                              padding: "10px 12px",
                              background: selected
                                ? COLORS.ANTD_BG_BLUE_L
                                : "white",
                              boxShadow: selected
                                ? `0 0 0 1px ${COLORS.BLUE} inset`
                                : undefined,
                              cursor: "pointer",
                              minHeight: 88,
                              display: "block",
                            }}
                          >
                            <Radio
                              value={option.value}
                              style={{ width: "100%" }}
                            >
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
                                    lineHeight: 1.35,
                                  }}
                                >
                                  {option.description}
                                </div>
                              </div>
                            </Radio>
                          </label>
                        );
                      })}
                    </div>
                  </Radio.Group>
                </Form.Item>
              </div>
            </Space>
          </Form>
        </Space>
      </Modal>
      <CodexPaymentCredentialsModal
        open={paymentOpen}
        projectId={projectId}
        refreshPaymentSource={refreshPaymentSource}
        onClose={() => setPaymentOpen(false)}
      />
      <Modal
        title="Codex sessions"
        open={sessionsOpen}
        onCancel={() => setSessionsOpen(false)}
        footer={null}
        width={1200}
      >
        <CodexSessionsPanel />
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

export function codexThreadConfigKey(
  config?: Partial<CodexThreadConfig> | null,
): string {
  if (config == null) return "";
  return JSON.stringify({
    allowWrite: config.allowWrite,
    codexPathOverride: config.codexPathOverride,
    envHome: config.envHome,
    envPath: config.envPath,
    model: config.model,
    notifyOnTurnFinish: config.notifyOnTurnFinish,
    reasoning: config.reasoning,
    serviceTier: config.serviceTier,
    sessionId: config.sessionId,
    sessionMode: config.sessionMode,
    workingDirectory: config.workingDirectory,
  });
}

function defaultWorkingDir(
  chatPath: string,
  workspaceWorkingDirectory?: string,
  projectHomeDirectory?: string,
): string {
  return defaultWorkingDirectoryForChat(
    chatPath,
    workspaceWorkingDirectory,
    projectHomeDirectory,
  );
}
