import {
  Alert,
  Button,
  Collapse,
  Divider,
  Dropdown,
  Form,
  Input,
  Modal,
  Popover,
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
  useProjectMapField,
  useState,
  useTypedRedux,
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
  clearCachedCodexModelCatalog,
  getChatGptAccountInfo,
  getLiveCodexUsageStatus,
  readCachedCodexModelCatalog,
  readCachedCodexUsageStatus,
  subscribeToCodexModelCatalogInvalidation,
  writeCachedCodexModelCatalog,
  writeCachedCodexUsageStatus,
} from "@cocalc/frontend/account/codex-usage";
import LiteAISettings from "@cocalc/frontend/account/lite-ai-settings";
import { UsageWindowMeters } from "@cocalc/frontend/account/usage-window-meters";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  defaultWorkingDirectoryForChat,
  useWorkspaceChatWorkingDirectory,
} from "@cocalc/frontend/project/workspaces/chat-defaults";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import DirectorySelector from "@cocalc/frontend/project/directory-selector";
import type {
  CodexModelCapabilityInfo,
  CodexPaymentSourceInfo,
  CodexUsageStatusInfo,
} from "@cocalc/conat/hub/api/system";
import {
  codexModelSupportsFastMode,
  DEFAULT_CODEX_MODELS,
  DEFAULT_CODEX_MODEL_NAME,
  normalizeCodexSessionId,
  resolveCodexServiceTier,
  resolveCodexSessionMode,
  type CodexReasoningLevel,
  type CodexReasoningId,
  type CodexPaymentSourcePreference,
  type CodexServiceTier,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
import { COLORS } from "@cocalc/util/theme";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import type { CodexThreadConfig } from "@cocalc/chat";
import { CodexSubagentConcurrencyButton } from "@cocalc/frontend/account/codex-subagent-concurrency";
import type { ChatActions } from "./actions";
import {
  getCodexNewChatModeOptions,
  getDefaultCodexSessionMode,
} from "./codex-defaults";
import { CodexFullAccessNotice } from "./codex-full-access";
import { CodexThreadId } from "./codex-thread-id";
import { AgentCommunication } from "./agent-communication";
import { getLatestAcpThreadIdForThread } from "./thread-session";
import {
  getCodexPaymentSourceShortLabel,
  getCodexPaymentSourceOptions,
  getCodexPaymentSourceTooltip,
} from "./use-codex-payment-source";
import { getCodexSubscriptionDisplayName } from "./codex-subscription-label";
import {
  readCodexSubscriptionSelection,
  writeCodexSubscriptionSelection,
} from "./codex-subscription-selection";

const { Text } = Typography;
const DEFAULT_MODEL_NAME = DEFAULT_CODEX_MODEL_NAME;
const CODEX_CONTROLS_COLLAPSED_KEY = "cocalc.chat.codexControlsCollapsed";
const REFRESH_MODELS_MENU_KEY = "__refresh-models__";

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
  compact?: boolean | "summary" | "composer";
  threadKey: string;
  chatPath: string;
  projectId?: string;
  actions?: ChatActions;
  threadConfig?: Partial<CodexThreadConfig> | null;
  paymentSource?: CodexPaymentSourceInfo;
  paymentSourceLoading?: boolean;
  refreshPaymentSource?: () => void;
  turnRunning?: boolean;
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
  serviceTiers?: string[];
  default?: boolean;
  disabled?: boolean;
};

function staticCodexModelOptions(): ModelOption[] {
  return DEFAULT_CODEX_MODELS.map((model) => ({
    value: model.name,
    label: model.name,
    description: model.description,
    reasoning: model.reasoning,
    serviceTiers: model.serviceTiers?.map(({ id }) => id),
    default: model.name === DEFAULT_CODEX_MODEL_NAME,
  }));
}

const CODEX_REASONING_LEVELS = new Map(
  DEFAULT_CODEX_MODELS.flatMap((model) => model.reasoning ?? []).map(
    (level) => [level.id, level],
  ),
);

function catalogReasoningLevels(
  model: CodexModelCapabilityInfo,
): CodexReasoningLevel[] {
  return model.reasoning.flatMap((reasoning) => {
    const known = CODEX_REASONING_LEVELS.get(reasoning.id as CodexReasoningId);
    if (!known) return [];
    return [
      {
        ...known,
        description: reasoning.description || known.description,
        default: reasoning.default,
      },
    ];
  });
}

export function codexModelOptionsForCatalog(
  catalog?: CodexModelCapabilityInfo[],
  selectedModel?: string,
): ModelOption[] {
  if (!catalog?.length) {
    const options = staticCodexModelOptions();
    if (
      selectedModel &&
      !options.some(({ value }) => value === selectedModel)
    ) {
      options.push({
        value: selectedModel,
        label: selectedModel,
        description:
          "Previously selected Codex model. Account availability has not been checked yet.",
      });
    }
    return options;
  }
  const staticModels = new Map(
    DEFAULT_CODEX_MODELS.map((model) => [model.name, model]),
  );
  const options: ModelOption[] = catalog.map((model) => {
    const fallback = staticModels.get(model.model);
    const specialty = ["cyber", "cybersecurity"].includes(
      model.specialty?.toLowerCase() ?? "",
    )
      ? "Cybersecurity model."
      : undefined;
    return {
      value: model.model,
      label: model.model,
      description: [model.description || fallback?.description, specialty]
        .filter(Boolean)
        .join(" "),
      reasoning: catalogReasoningLevels(model),
      serviceTiers: model.serviceTiers.map(({ id }) => id),
      default: model.default,
    };
  });
  if (selectedModel && !options.some(({ value }) => value === selectedModel)) {
    const fallback = staticModels.get(selectedModel);
    options.push({
      value: selectedModel,
      label: selectedModel,
      description: `${fallback?.description ?? "Previously selected Codex model."} Not available with the connected ChatGPT account.`,
      reasoning: fallback?.reasoning,
      serviceTiers: fallback?.serviceTiers?.map(({ id }) => id),
      disabled: true,
    });
  }
  return options;
}

type LiteCodexLocalStatus = {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  error?: string;
  checkedAt?: number;
};

function MembershipUsageMeters({
  status,
  compact = false,
}: {
  status: NonNullable<
    NonNullable<CodexPaymentSourceInfo["siteFundedCodex"]>["status"]
  >["account"];
  compact?: boolean;
}) {
  if (!status) return null;
  const windows = [
    {
      key: "5h",
      label: "5-hour limit",
      limit: status.limit5hMicrousd,
      remaining: status.remaining5hMicrousd,
      resetAt: status.reset5hAt,
    },
    {
      key: "7d",
      label: "7-day limit",
      limit: status.limit7dMicrousd,
      remaining: status.remaining7dMicrousd,
      resetAt: status.reset7dAt,
    },
  ]
    .filter(
      ({ limit, remaining }) =>
        typeof limit === "number" &&
        Number.isFinite(limit) &&
        limit > 0 &&
        typeof remaining === "number" &&
        Number.isFinite(remaining),
    )
    .map(({ key, label, limit = 0, remaining = 0, resetAt }) => ({
      key,
      label,
      remainingPercent: Math.max(
        0,
        Math.min(100, Math.round((remaining / limit) * 100)),
      ),
      resetAt: resetAt ? new Date(resetAt) : undefined,
    }));
  return (
    <UsageWindowMeters
      windows={windows}
      compact={compact}
      statusLabel="CoCalc Membership usage"
    />
  );
}

const HelpPopover = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <Popover
    content={<div style={{ maxWidth: 360 }}>{children}</div>}
    placement="top"
    trigger={["click"]}
  >
    <Button
      aria-label={`Help: ${label}`}
      icon={<Icon name="question-circle" />}
      size="small"
      type="text"
    />
  </Popover>
);

const SectionTitle = ({
  children,
  help,
}: {
  children: React.ReactNode;
  help?: React.ReactNode;
}) => (
  <span style={{ alignItems: "center", display: "inline-flex", gap: 2 }}>
    <Text strong style={{ color: UI_COLORS.text }}>
      {children}
    </Text>
    {help ? <HelpPopover label={`${children}`}>{help}</HelpPopover> : null}
  </span>
);

const formItemStyle = { marginBottom: 12 } as const;
const gridTwoColStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: 12,
  width: "100%",
} as const;
const sectionStyle: React.CSSProperties = {
  border: `1px solid ${UI_COLORS.border}`,
  borderRadius: 12,
  background: UI_COLORS.surface,
  padding: 14,
};
type PillSegment =
  | "codex"
  | "expand"
  | "source"
  | "model"
  | "mode"
  | "reasoning";

const pillSegmentBaseStyle: React.CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: 0,
  borderRadius: 999,
  color: UI_COLORS.secondary,
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
            Choose the payment source for each chat in Codex settings.
            Credentials connected here remain available without overriding an
            explicit choice.
          </Text>
        </Space>
      )}
    </Modal>
  );
}

export function CodexConfigButton({
  compact = false,
  threadKey,
  chatPath,
  projectId,
  actions,
  threadConfig,
  paymentSource,
  paymentSourceLoading = false,
  refreshPaymentSource,
  turnRunning = false,
}: CodexConfigButtonProps): React.ReactElement {
  const defaultSessionMode = getDefaultCodexSessionMode();
  const accountId = useTypedRedux("account", "account_id");
  const codexRuntimeVersion = useProjectMapField<string>(projectId, [
    "state",
    "tools_version",
  ]);
  const projectTitle = useProjectMapField<string>(projectId, ["title"]);
  const workspaceWorkingDirectory = useWorkspaceChatWorkingDirectory(chatPath);
  const [open, setOpen] = useState(false);
  const [membershipHelpOpen, setMembershipHelpOpen] = useState(false);
  const paymentSourceButtonRef = React.useRef<HTMLButtonElement>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [directoryPopoverOpen, setDirectoryPopoverOpen] = useState(false);
  const [directorySelectorOpen, setDirectorySelectorOpen] = useState(false);
  const [directoryDraft, setDirectoryDraft] = useState("");
  const [form] = Form.useForm();
  const [selectedCredentialId, setSelectedCredentialId] = useState<
    string | undefined
  >();
  const [credentialSelectionLoaded, setCredentialSelectionLoaded] =
    useState(false);
  useEffect(() => {
    setCredentialSelectionLoaded(false);
    setSelectedCredentialId(
      readCodexSubscriptionSelection({ accountId, projectId, threadKey }),
    );
    setCredentialSelectionLoaded(true);
  }, [accountId, projectId, threadKey]);
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
  const [codexUsageRequested, setCodexUsageRequested] = useState(false);
  const [codexModelRequestNonce, setCodexModelRequestNonce] = useState(0);
  const [codexModelsLoading, setCodexModelsLoading] = useState(false);
  const [codexModelCatalog, setCodexModelCatalog] = useState<
    CodexModelCapabilityInfo[] | undefined
  >(undefined);
  const [codexModelRefreshNonce, setCodexModelRefreshNonce] = useState(0);
  const [hoveredPillSegment, setHoveredPillSegment] = useState<
    PillSegment | undefined
  >(undefined);
  const lastAppliedThreadRef = React.useRef<string | undefined>(undefined);
  const lastCodexUsageScopeRef = React.useRef<string | undefined>(undefined);
  const lastCodexModelRefreshRef = React.useRef(0);
  const modelSelectionTouchedRef = React.useRef(false);
  const runningConfigSnapshotRef = React.useRef<{
    threadKey: string;
    key: string;
  }>(undefined);
  const [configChangedForNextTurn, setConfigChangedForNextTurn] =
    useState(false);

  useEffect(
    () =>
      subscribeToCodexModelCatalogInvalidation({
        accountId,
        onInvalidate: () => {
          setCodexModelCatalog(undefined);
          setCodexModelRefreshNonce((nonce) => nonce + 1);
        },
      }),
    [accountId],
  );

  useEffect(() => {
    setModels(staticCodexModelOptions());
  }, []);

  const selectedModelValue =
    Form.useWatch("model", form) ?? value?.model ?? threadConfig?.model;

  useEffect(() => {
    setModels(
      paymentSource?.source === "subscription"
        ? codexModelOptionsForCatalog(codexModelCatalog, selectedModelValue)
        : staticCodexModelOptions(),
    );
  }, [codexModelCatalog, paymentSource?.source, selectedModelValue]);

  const threadConfigKey = codexThreadConfigKey(threadConfig);

  useEffect(() => {
    if (!models.length) return;
    const threadId = `${threadKey ?? ""}`.trim();
    if (!threadId) {
      console.warn("invalid chat thread id", { threadKey });
      return;
    }
    const threadChanged = lastAppliedThreadRef.current !== threadId;
    if (threadChanged) {
      modelSelectionTouchedRef.current = false;
    }
    if (open && !threadChanged) {
      return;
    }
    const baseModel =
      models.find((model) => model.default && !model.disabled)?.value ??
      models.find((model) => !model.disabled)?.value ??
      DEFAULT_MODEL_NAME;
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
      paymentSource: "auto",
    };
    const saved = threadConfig ?? actions?.getCodexConfig?.(threadId);
    const liveSessionId = getLatestAcpThreadIdForThread({
      actions,
      threadId,
    });
    const merged: CodexThreadConfig = { ...defaults, ...saved };
    merged.sessionId =
      normalizeCodexSessionId(merged.sessionId) ?? liveSessionId ?? "";
    // A model advertised for this account may not exist in the static fallback
    // catalog. Never rewrite persisted thread state while discovery is pending.
    const model = `${merged.model ?? ""}`.trim() || baseModel;
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

  const selectedReasoningValue =
    Form.useWatch("reasoning", form) ?? value?.reasoning;
  const currentSessionMode =
    Form.useWatch("sessionMode", form) ?? value?.sessionMode;
  const selectedPaymentSource =
    Form.useWatch("paymentSource", form) ?? value?.paymentSource ?? "auto";
  const selectedWorkingDirectory =
    Form.useWatch("workingDirectory", form) ??
    value?.workingDirectory ??
    threadConfig?.workingDirectory ??
    defaultWorkingDir(
      chatPath,
      workspaceWorkingDirectory,
      getProjectHomeDirectory(projectId),
    );
  useEffect(() => {
    if (!directoryPopoverOpen) {
      setDirectoryDraft(selectedWorkingDirectory);
    }
  }, [directoryPopoverOpen, selectedWorkingDirectory]);
  const activeSessionId = normalizeCodexSessionId(
    Form.useWatch("sessionId", form) ?? value?.sessionId,
  );
  const hasEstablishedSession = activeSessionId != null;
  const selectedServiceTierValue: CodexServiceTier =
    Form.useWatch("serviceTier", form) ?? value?.serviceTier ?? "standard";
  const siteFundedPolicy =
    !lite &&
    paymentSource?.source === "site-api-key" &&
    paymentSource.siteFundedCodex?.enabled
      ? paymentSource.siteFundedCodex.policy
      : undefined;
  const effectiveConfigKey = `${codexThreadConfigKey(
    threadConfig ?? value,
  )}\0${selectedCredentialId ?? ""}`;

  useEffect(() => {
    if (!turnRunning) {
      runningConfigSnapshotRef.current = undefined;
      setConfigChangedForNextTurn(false);
      return;
    }
    if (value == null || !credentialSelectionLoaded) return;
    const snapshot = runningConfigSnapshotRef.current;
    if (!snapshot || snapshot.threadKey !== threadKey) {
      runningConfigSnapshotRef.current = {
        threadKey,
        key: effectiveConfigKey,
      };
      setConfigChangedForNextTurn(false);
      return;
    }
    setConfigChangedForNextTurn(snapshot.key !== effectiveConfigKey);
  }, [
    credentialSelectionLoaded,
    effectiveConfigKey,
    threadKey,
    turnRunning,
    value,
  ]);
  const siteFundedAccountStatus =
    paymentSource?.siteFundedCodex?.status?.account;
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
  const selectedSubscription = paymentSource?.subscriptions?.find(
    ({ id }) => id === (selectedCredentialId ?? paymentSource.credentialId),
  );
  const sourceShortLabel = paymentSourceLoading
    ? "Checking…"
    : paymentSource?.source === "subscription" && selectedSubscription
      ? getCodexSubscriptionDisplayName(
          selectedSubscription,
          paymentSource.subscriptions ?? [],
        )
      : selectedPaymentSource === "subscription" && selectedCredentialId
        ? "ChatGPT selection unavailable"
        : getCodexPaymentSourceShortLabel(paymentSource?.source);
  const sourceTooltip = getCodexPaymentSourceTooltip(paymentSource);
  const membershipNeedsNewThread =
    hasEstablishedSession &&
    paymentSource?.source !== "site-api-key" &&
    getCodexPaymentSourceOptions(paymentSource).some(
      (option) => option.value === "site-api-key" && !option.disabled,
    );
  const membershipPolicy = paymentSource?.siteFundedCodex?.policy;
  const membershipThreadHelp =
    `CoCalc Membership uses ${membershipPolicy ? `${membershipPolicy.model} with ${membershipPolicy.reasoning} reasoning` : "a fixed model and reasoning level"}. ` +
    "An existing thread using a different model cannot switch to this profile because its conversation may exceed the model's context size. " +
    "Start a new thread and choose CoCalc Membership before sending your first message, or continue a thread already using CoCalc Membership. Your current thread and messages will remain unchanged.";
  const chatgptAccount = getChatGptAccountInfo(codexUsageStatus);
  const sourceTooltipDetails =
    paymentSource?.source === "site-api-key" ? (
      <Space orientation="vertical" size={0}>
        <span>{sourceTooltip}</span>
        {siteFundedAccountStatus ? (
          <div style={{ marginTop: 4, width: 390 }}>
            <MembershipUsageMeters status={siteFundedAccountStatus} compact />
          </div>
        ) : null}
      </Space>
    ) : paymentSource?.source === "subscription" && codexUsageStatus ? (
      <Space orientation="vertical" size={4}>
        <span>{sourceTooltip}</span>
        {chatgptAccount?.email ? (
          <Text style={{ color: "inherit" }}>{chatgptAccount.email}</Text>
        ) : null}
        <div style={{ marginTop: 2, width: 360 }}>
          <CodexUsageMeters
            compact
            status={codexUsageStatus}
            stale={codexUsageStale}
            updating={codexUsageLoading}
          />
        </div>
      </Space>
    ) : (
      sourceTooltip
    );
  const paymentSourceOptions = getCodexPaymentSourceOptions(paymentSource).map(
    (option) => {
      if (!hasEstablishedSession) return option;
      if (option.value === "site-api-key" && membershipNeedsNewThread) {
        return {
          ...option,
          disabled: true,
          description: membershipThreadHelp,
        };
      }
      if (option.value === "auto" && selectedPaymentSource !== "auto") {
        return {
          ...option,
          disabled: true,
          description:
            "Automatic fallback is disabled after a session starts because it could switch into an incompatible membership-funded profile.",
        };
      }
      return option;
    },
  );

  useEffect(() => {
    const wantsModels = open || codexModelRequestNonce > 0;
    const wantsUsage = open || codexUsageRequested;
    if (paymentSource?.source !== "subscription") {
      setCodexUsageStatus(undefined);
      setCodexUsageLoading(false);
      setCodexUsageStale(false);
      setCodexModelsLoading(false);
      setCodexModelCatalog(undefined);
      lastCodexUsageScopeRef.current = undefined;
      return;
    }
    const scope = `${accountId ?? ""}\0${projectId ?? ""}\0${codexRuntimeVersion ?? ""}\0${paymentSource.subscriptionRevision ?? ""}`;
    const scopeChanged = lastCodexUsageScopeRef.current !== scope;
    if (!wantsModels && !wantsUsage) {
      if (scopeChanged) {
        setCodexUsageStatus(undefined);
        setCodexUsageStale(false);
        setCodexModelCatalog(undefined);
        lastCodexUsageScopeRef.current = scope;
      }
      setCodexUsageLoading(false);
      setCodexModelsLoading(false);
      return;
    }
    let cancelled = false;
    lastCodexUsageScopeRef.current = scope;
    const forceModels =
      codexModelRefreshNonce !== lastCodexModelRefreshRef.current;
    lastCodexModelRefreshRef.current = codexModelRefreshNonce;
    const cachedUsage = readCachedCodexUsageStatus({ accountId });
    const cachedCatalog = forceModels
      ? undefined
      : readCachedCodexModelCatalog({
          accountId,
          projectId,
          runtimeVersion: codexRuntimeVersion,
          subscriptionRevision: paymentSource.subscriptionRevision,
        });
    const staleCatalog =
      forceModels || cachedCatalog
        ? undefined
        : readCachedCodexModelCatalog({
            accountId,
            projectId,
            runtimeVersion: codexRuntimeVersion,
            subscriptionRevision: paymentSource.subscriptionRevision,
            allowExpired: true,
          });
    if (cachedUsage) {
      setCodexUsageStatus(cachedUsage.status);
      setCodexUsageStale(true);
    } else if (scopeChanged) {
      setCodexUsageStatus(undefined);
      setCodexUsageStale(false);
    }
    if (cachedCatalog) {
      setCodexModelCatalog(cachedCatalog.models);
    } else if (staleCatalog) {
      // Keep a same-account/runtime/credential catalog stable while it is
      // revalidated. A changed scope has a different cache key and is cleared.
      setCodexModelCatalog(staleCatalog.models);
    } else if (scopeChanged) {
      setCodexModelCatalog(undefined);
    }
    const includeModels = wantsModels && !cachedCatalog;
    if (!wantsUsage && !includeModels) {
      setCodexModelsLoading(false);
      return;
    }
    setCodexUsageLoading(wantsUsage);
    setCodexModelsLoading(includeModels);
    void getLiveCodexUsageStatus({
      projectId,
      includeModels,
      refreshModels: forceModels,
      credentialId: paymentSource.credentialId,
    })
      .then((status: CodexUsageStatusInfo) => {
        if (cancelled) return;
        setCodexUsageStatus(status);
        setCodexUsageStale(false);
        writeCachedCodexUsageStatus({ accountId, status });
        if (status.models?.length) {
          setCodexModelCatalog(status.models);
          const checkedAt = Date.parse(status.modelsCheckedAt ?? "");
          writeCachedCodexModelCatalog({
            accountId,
            projectId,
            runtimeVersion: codexRuntimeVersion,
            subscriptionRevision: paymentSource.subscriptionRevision,
            models: status.models,
            cachedAt: Number.isFinite(checkedAt) ? checkedAt : Date.now(),
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (!cachedUsage) {
          setCodexUsageStatus(undefined);
          setCodexUsageStale(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCodexUsageLoading(false);
          setCodexModelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    codexModelRefreshNonce,
    codexModelRequestNonce,
    codexUsageRequested,
    open,
    paymentSource?.source,
    paymentSource?.subscriptionRevision,
    codexRuntimeVersion,
    projectId,
  ]);

  const modeLabel =
    modeOptions.find((option) => option.value === currentSessionMode)?.label ??
    "Mode";
  const reasoningLabel =
    reasoningOptions.find((option) => option.value === selectedReasoningValue)
      ?.label ?? selectedReasoningValue;
  const selectedModelOption = models.find(
    (model) => model.value === selectedModelValue,
  );
  const selectedModelUnavailable = selectedModelOption?.disabled === true;
  const fastModeSupported =
    selectedModelOption?.serviceTiers?.includes("fast") ??
    codexModelSupportsFastMode(selectedModelValue);
  const effectiveServiceTier =
    selectedServiceTierValue === "fast" && fastModeSupported
      ? "fast"
      : "standard";
  const serviceTierLabel = effectiveServiceTier === "fast" ? "Fast" : undefined;
  const displayedModel = siteFundedPolicy?.model ?? selectedModelValue;
  const displayedReasoning = siteFundedPolicy
    ? (reasoningOptions.find(
        (option) => option.value === siteFundedPolicy.reasoning,
      )?.label ?? siteFundedPolicy.reasoning)
    : reasoningLabel;
  const displayedServiceTier = siteFundedPolicy ? undefined : serviceTierLabel;
  const displayedWorkingDirectory = (() => {
    const home = getProjectHomeDirectory(projectId);
    if (selectedWorkingDirectory === home) return "~";
    if (selectedWorkingDirectory.startsWith(`${home}/`)) {
      return `~/${selectedWorkingDirectory.slice(home.length + 1)}`;
    }
    return selectedWorkingDirectory;
  })();
  const paymentNeedsAttention =
    paymentSourceLoading || paymentSource?.source === "none" || !paymentSource;
  const toggleControlsCollapsed = () => {
    setControlsCollapsed((collapsed) => {
      const next = !collapsed;
      writeCodexControlsCollapsed(next);
      return next;
    });
  };

  const modelSupportsFastMode = (modelValue?: string): boolean =>
    models
      .find((model) => model.value === modelValue)
      ?.serviceTiers?.includes("fast") ??
    codexModelSupportsFastMode(modelValue);

  useEffect(() => {
    if (!open || paymentSource?.source !== "subscription") return;
    const catalog = codexModelCatalog;
    if (!catalog?.length) return;
    const current = form.getFieldsValue([
      "model",
      "reasoning",
      "serviceTier",
    ]) as Partial<CodexThreadConfig>;
    const saved = threadConfig ?? actions?.getCodexConfig?.(threadKey);
    const hasPersistedModel = !!`${saved?.model ?? ""}`.trim();
    let model = current.model ?? selectedModelValue;
    const patch: Partial<CodexThreadConfig> = {};
    const advertisedDefault =
      catalog.find((entry) => entry.default)?.model ?? catalog[0]?.model;
    const mayAdoptAdvertisedDefault =
      !hasPersistedModel && !modelSelectionTouchedRef.current;
    if (
      mayAdoptAdvertisedDefault &&
      advertisedDefault &&
      model !== advertisedDefault
    ) {
      model = advertisedDefault;
      patch.model = model;
    } else if (!model || !catalog.some((entry) => entry.model === model)) {
      // Preserve an explicit or persisted selection so the UI can show that it
      // is unavailable instead of silently switching the thread.
      return;
    }
    const reasoning = getReasoningForModel({
      models,
      modelValue: model,
      desired: current.reasoning ?? selectedReasoningValue,
    });
    const serviceTier =
      (current.serviceTier ?? selectedServiceTierValue) === "fast" &&
      modelSupportsFastMode(model)
        ? "fast"
        : "standard";
    if ((current.reasoning ?? selectedReasoningValue) !== reasoning) {
      patch.reasoning = reasoning;
    }
    if ((current.serviceTier ?? selectedServiceTierValue) !== serviceTier) {
      patch.serviceTier = serviceTier;
    }
    if (!Object.keys(patch).length) return;
    form.setFieldsValue(patch);
    setValue((currentValue) => ({ ...(currentValue ?? {}), ...patch }));
  }, [
    actions,
    codexModelCatalog,
    form,
    models,
    open,
    paymentSource?.source,
    selectedModelValue,
    selectedReasoningValue,
    selectedServiceTierValue,
    threadConfigKey,
    threadKey,
  ]);

  const normalizeConfigForSave = (
    values: Partial<CodexThreadConfig>,
  ): Partial<CodexThreadConfig> => {
    const sessionMode: CodexSessionMode =
      normalizeSessionMode(values) ?? defaultSessionMode;
    return {
      ...values,
      sessionId: normalizeCodexSessionId(values?.sessionId),
      sessionMode,
      serviceTier:
        values?.serviceTier === "fast" && modelSupportsFastMode(values?.model)
          ? "fast"
          : "standard",
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
    if (patch.model != null) {
      modelSelectionTouchedRef.current = true;
    }
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
      if (!modelSupportsFastMode(patch.model)) {
        nextValues.serviceTier = "standard";
      }
    }
    const finalValues = normalizeConfigForSave(nextValues);
    form.setFieldsValue(finalValues);
    setValue(finalValues);
    actions?.setCodexConfig?.(threadKey, finalValues);
  };

  const applyWorkingDirectory = (nextDirectory: string) => {
    const normalized = normalizeAbsolutePath(
      nextDirectory,
      getProjectHomeDirectory(projectId),
    );
    applyQuickConfigPatch({ workingDirectory: normalized });
    setDirectoryDraft(normalized);
    setDirectoryPopoverOpen(false);
  };

  const paymentSourcePatch = (
    next: CodexPaymentSourcePreference,
  ): Partial<CodexThreadConfig> => {
    if (hasEstablishedSession && siteFundedPolicy && next !== "site-api-key") {
      return {
        paymentSource: next,
        model: siteFundedPolicy.model,
        reasoning: siteFundedPolicy.reasoning,
        serviceTier: siteFundedPolicy.serviceTier,
      };
    }
    return { paymentSource: next };
  };

  const modelMenu: MenuProps = {
    selectedKeys: selectedModelValue ? [selectedModelValue] : [],
    items: [
      ...models.map((model) => ({
        key: model.value,
        label: model.label,
        disabled: model.disabled,
        title: model.description,
      })),
      ...(paymentSource?.source === "subscription"
        ? [
            { key: "__refresh-models-divider__", type: "divider" as const },
            {
              key: REFRESH_MODELS_MENU_KEY,
              label: "Refresh models",
              icon: <Icon name="refresh" spin={codexModelsLoading} />,
              disabled: codexModelsLoading,
            },
          ]
        : []),
    ],
    onClick: ({ domEvent, key }) => {
      domEvent.stopPropagation();
      if (key === REFRESH_MODELS_MENU_KEY) {
        clearCachedCodexModelCatalog({ accountId });
        return;
      }
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

  const configuredPaymentSources = paymentSourceOptions.filter(
    ({ value }) => value !== "auto",
  );
  const showPaymentSourceSelector =
    !lite &&
    (configuredPaymentSources.length > 1 ||
      (paymentSource?.subscriptions?.length ?? 0) > 1);
  const paymentSourceMenu: MenuProps = {
    selectedKeys: [
      selectedPaymentSource === "subscription" && selectedSubscription
        ? `subscription:${selectedSubscription.id}`
        : selectedPaymentSource,
    ],
    items: [
      ...paymentSourceOptions.flatMap((option) =>
        option.value === "subscription"
          ? paymentSource?.subscriptions?.length
            ? paymentSource.subscriptions.map((credential) => ({
                key: `subscription:${credential.id}`,
                label: getCodexSubscriptionDisplayName(
                  credential,
                  paymentSource.subscriptions ?? [],
                ),
                title: credential.plan
                  ? `ChatGPT ${credential.plan} subscription`
                  : "ChatGPT subscription",
              }))
            : [
                {
                  key: option.value,
                  label: option.label,
                  title: option.description,
                },
              ]
          : [
              {
                key: option.value,
                label: option.label,
                disabled:
                  option.value === "site-api-key" && membershipNeedsNewThread
                    ? false
                    : option.disabled,
                title: option.description,
              },
            ],
      ),
      { type: "divider" },
      { key: "manage-subscriptions", label: "Manage subscriptions" },
    ],
    onClick: ({ domEvent, key }) => {
      domEvent.stopPropagation();
      if (key === "manage-subscriptions") {
        setPaymentOpen(true);
        return;
      }
      if (key.startsWith("subscription:")) {
        const credentialId = key.slice("subscription:".length);
        if (accountId && projectId) {
          writeCodexSubscriptionSelection({
            accountId,
            projectId,
            threadKey,
            credentialId,
          });
          setSelectedCredentialId(credentialId);
          applyQuickConfigPatch(paymentSourcePatch("subscription"));
          refreshPaymentSource?.();
        }
        return;
      }
      const next = key as CodexPaymentSourcePreference;
      if (next === "site-api-key" && membershipNeedsNewThread) {
        setMembershipHelpOpen(true);
        return;
      }
      applyQuickConfigPatch(paymentSourcePatch(next));
    },
  };
  const serviceTierMenu: MenuProps = {
    selectedKeys: [effectiveServiceTier],
    items: [
      { key: "standard", label: "Standard" },
      { key: "fast", label: "Fast", disabled: !fastModeSupported },
    ],
    onClick: ({ domEvent, key }) => {
      domEvent.stopPropagation();
      applyQuickConfigPatch({ serviceTier: key as CodexServiceTier });
    },
  };

  const pillSegmentStyle = (segment: PillSegment): React.CSSProperties => ({
    ...pillSegmentBaseStyle,
    background:
      hoveredPillSegment === segment ? UI_COLORS.hover : "transparent",
    color:
      hoveredPillSegment === segment ? UI_COLORS.link : UI_COLORS.secondary,
    maxWidth: segment === "model" ? 170 : 120,
    overflow: "hidden",
    textOverflow: "ellipsis",
  });

  const pillSegmentHandlers = (segment: PillSegment) => ({
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation();
    },
    onMouseEnter: () => {
      setHoveredPillSegment(segment);
      if (segment === "source" && paymentSource?.source === "subscription") {
        setCodexUsageRequested(true);
      }
    },
    onMouseLeave: () => setHoveredPillSegment(undefined),
  });

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          maxWidth:
            compact === "composer" ? "100%" : "min(760px, calc(100vw - 32px))",
          minWidth: 0,
          overflow: compact === "composer" ? "hidden" : undefined,
        }}
      >
        {compact === "composer" ? (
          <>
            <Tooltip
              title={`${projectTitle ?? "Project"} / ${selectedWorkingDirectory}`}
            >
              <Popover
                open={directoryPopoverOpen}
                onOpenChange={(nextOpen) => {
                  setDirectoryPopoverOpen(nextOpen);
                  if (nextOpen) setDirectoryDraft(selectedWorkingDirectory);
                }}
                placement="topLeft"
                trigger="click"
                content={
                  <Space
                    orientation="vertical"
                    size={8}
                    style={{ width: "min(360px, calc(100vw - 32px))" }}
                  >
                    <Text strong>Working directory</Text>
                    <Space.Compact style={{ width: "100%" }}>
                      <Input
                        aria-label="Working directory"
                        value={directoryDraft}
                        onChange={(event) =>
                          setDirectoryDraft(event.target.value)
                        }
                        onPressEnter={() =>
                          applyWorkingDirectory(directoryDraft)
                        }
                      />
                      <Button
                        type="primary"
                        onClick={() => applyWorkingDirectory(directoryDraft)}
                      >
                        Apply
                      </Button>
                    </Space.Compact>
                    <Button
                      icon={<Icon name="folder-open" />}
                      onClick={() => {
                        setDirectoryPopoverOpen(false);
                        setTimeout(() => setDirectorySelectorOpen(true), 0);
                      }}
                    >
                      Choose directory…
                    </Button>
                  </Space>
                }
              >
                <Button
                  aria-label={`Working directory: ${projectTitle ?? "Project"} / ${selectedWorkingDirectory}`}
                  aria-haspopup="dialog"
                  icon={<Icon name="folder-open" />}
                  size="small"
                  type="text"
                  style={{
                    color: UI_COLORS.secondary,
                    display: "inline-flex",
                    flex: "0 1 auto",
                    maxWidth: 240,
                    minWidth: 0,
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      flex: "0 1 110px",
                      minWidth: 24,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {projectTitle ?? "Project"}
                  </span>
                  <Text type="secondary" style={{ flex: "0 0 auto" }}>
                    &nbsp;/&nbsp;
                  </Text>
                  <span
                    style={{
                      flex: "1 1 70px",
                      minWidth: 50,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {displayedWorkingDirectory}
                  </span>
                </Button>
              </Popover>
            </Tooltip>
            <span
              style={{
                alignItems: "center",
                display: "inline-flex",
                flex: "0 1 auto",
                minWidth: 0,
                overflow: "hidden",
              }}
            >
              {siteFundedPolicy ? (
                <Tooltip title="CoCalc Membership chooses the model">
                  <button
                    type="button"
                    style={{ ...pillSegmentBaseStyle, cursor: "default" }}
                  >
                    {displayedModel}
                  </button>
                </Tooltip>
              ) : (
                <Dropdown
                  menu={modelMenu}
                  trigger={["click"]}
                  onOpenChange={(nextOpen) => {
                    if (
                      nextOpen &&
                      paymentSource?.source === "subscription" &&
                      !codexModelsLoading
                    ) {
                      setCodexModelRequestNonce((nonce) => nonce + 1);
                    }
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Change model. Current model: ${displayedModel}`}
                    style={{ ...pillSegmentBaseStyle, maxWidth: 150 }}
                  >
                    <span
                      style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                      {displayedModel}
                    </span>
                  </button>
                </Dropdown>
              )}
              <Text type="secondary">·</Text>
              {siteFundedPolicy ? (
                <Tooltip title="CoCalc Membership chooses the thinking level">
                  <button
                    type="button"
                    style={{ ...pillSegmentBaseStyle, cursor: "default" }}
                  >
                    {displayedReasoning}
                  </button>
                </Tooltip>
              ) : (
                <Dropdown menu={reasoningMenu} trigger={["click"]}>
                  <button
                    type="button"
                    aria-label={`Change thinking level. Current level: ${displayedReasoning}`}
                    style={pillSegmentBaseStyle}
                  >
                    {displayedReasoning}
                  </button>
                </Dropdown>
              )}
              {displayedServiceTier ? (
                <>
                  <Text type="secondary">·</Text>
                  <Dropdown menu={serviceTierMenu} trigger={["click"]}>
                    <button
                      type="button"
                      aria-label={`Change speed. Current speed: ${displayedServiceTier}`}
                      style={pillSegmentBaseStyle}
                    >
                      {displayedServiceTier}
                    </button>
                  </Dropdown>
                </>
              ) : null}
              <Text type="secondary">·</Text>
              {lite ? (
                <Tooltip
                  allow_touch
                  ignore_hide_setting
                  title={sourceTooltipDetails}
                  styles={{ root: { maxWidth: 420 } }}
                >
                  <button
                    type="button"
                    aria-label={`Change payment source. Current source: ${sourceShortLabel}`}
                    aria-haspopup="dialog"
                    onMouseEnter={() => setCodexUsageRequested(true)}
                    onClick={() => setPaymentOpen(true)}
                    style={{
                      ...pillSegmentBaseStyle,
                      color: paymentNeedsAttention
                        ? UI_COLORS.danger
                        : UI_COLORS.secondary,
                    }}
                  >
                    {sourceShortLabel}
                  </button>
                </Tooltip>
              ) : (
                <Tooltip
                  allow_touch
                  ignore_hide_setting
                  title={sourceTooltipDetails}
                  styles={{ root: { maxWidth: 420 } }}
                >
                  <Dropdown menu={paymentSourceMenu} trigger={["click"]}>
                    <button
                      type="button"
                      aria-label={`Change payment source. Current source: ${sourceShortLabel}`}
                      onMouseEnter={() => setCodexUsageRequested(true)}
                      style={{
                        ...pillSegmentBaseStyle,
                        color: paymentNeedsAttention
                          ? UI_COLORS.danger
                          : UI_COLORS.secondary,
                        maxWidth: 120,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {sourceShortLabel}
                    </button>
                  </Dropdown>
                </Tooltip>
              )}
            </span>
            <Tooltip title="More agent settings">
              <Button
                aria-label="More agent settings"
                aria-haspopup="dialog"
                icon={<Icon name="sliders" />}
                onClick={() => setOpen(true)}
                size="small"
                type="text"
              ></Button>
            </Tooltip>
          </>
        ) : compact ? (
          <Button
            className={
              compact === "summary" ? "cocalc-chat-model-summary" : undefined
            }
            aria-label={
              compact === "summary"
                ? `Codex settings: ${displayedModel} ${displayedReasoning}`
                : "Codex settings"
            }
            aria-haspopup="dialog"
            title={
              compact === "summary"
                ? `${displayedModel} ${displayedReasoning}`
                : undefined
            }
            icon={compact === "summary" ? undefined : <Icon name="sliders" />}
            type={compact === "summary" ? "text" : "default"}
            onClick={() => setOpen(true)}
          >
            {compact === "summary"
              ? `${displayedModel} ${displayedReasoning}`
              : "Codex settings"}
          </Button>
        ) : controlsCollapsed ? (
          <span
            style={{
              alignItems: "center",
              background: UI_COLORS.surface,
              border: `1px solid ${UI_COLORS.border}`,
              borderRadius: 999,
              boxShadow: `0 1px 5px ${UI_COLORS.shadow}`,
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
                      ? UI_COLORS.link
                      : UI_COLORS.text,
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
                    ? UI_COLORS.link
                    : UI_COLORS.text,
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
                background: UI_COLORS.surface,
                border: `1px solid ${UI_COLORS.border}`,
                borderRadius: 999,
                boxShadow: `0 1px 5px ${UI_COLORS.shadow}`,
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
                  color: UI_COLORS.text,
                  fontWeight: 600,
                  paddingLeft: 0,
                }}
              >
                Codex
              </button>
              {showPaymentSourceSelector ? (
                <>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ·
                  </Text>
                  <Tooltip
                    title={sourceTooltipDetails}
                    styles={{ root: { maxWidth: 420 } }}
                  >
                    <Dropdown menu={paymentSourceMenu} trigger={["click"]}>
                      <button
                        ref={paymentSourceButtonRef}
                        type="button"
                        aria-label={
                          chatgptAccount?.email
                            ? `Change Codex payment source. Connected ChatGPT account: ${chatgptAccount.email}`
                            : "Change Codex payment source"
                        }
                        title="Change Codex payment source"
                        style={pillSegmentStyle("source")}
                        {...pillSegmentHandlers("source")}
                      >
                        {sourceShortLabel}
                      </button>
                    </Dropdown>
                  </Tooltip>
                </>
              ) : null}
              <Text type="secondary" style={{ fontSize: 12 }}>
                ·
              </Text>
              {siteFundedPolicy ? (
                <button
                  type="button"
                  title="CoCalc Membership uses a fixed model"
                  style={pillSegmentStyle("model")}
                  {...pillSegmentHandlers("model")}
                >
                  {displayedModel}
                </button>
              ) : (
                <Dropdown
                  menu={modelMenu}
                  trigger={["click"]}
                  onOpenChange={(nextOpen) => {
                    if (
                      nextOpen &&
                      paymentSource?.source === "subscription" &&
                      !codexModelsLoading
                    ) {
                      setCodexModelRequestNonce((nonce) => nonce + 1);
                    }
                  }}
                >
                  <button
                    type="button"
                    title="Change Codex model"
                    style={pillSegmentStyle("model")}
                    {...pillSegmentHandlers("model")}
                  >
                    {displayedModel}
                  </button>
                </Dropdown>
              )}
              {lite ? (
                <>
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
                </>
              ) : null}
              {displayedReasoning ? (
                <>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ·
                  </Text>
                  {siteFundedPolicy ? (
                    <button
                      type="button"
                      title={`CoCalc Membership uses ${siteFundedPolicy.reasoning} reasoning`}
                      style={pillSegmentStyle("reasoning")}
                      {...pillSegmentHandlers("reasoning")}
                    >
                      {displayedReasoning}
                    </button>
                  ) : (
                    <Dropdown menu={reasoningMenu} trigger={["click"]}>
                      <button
                        type="button"
                        title="Change Codex thinking level"
                        style={pillSegmentStyle("reasoning")}
                        {...pillSegmentHandlers("reasoning")}
                      >
                        {displayedReasoning}
                      </button>
                    </Dropdown>
                  )}
                </>
              ) : null}
              {displayedServiceTier ? (
                <>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ·
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {displayedServiceTier}
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
                        ? UI_COLORS.link
                        : UI_COLORS.text,
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
                        ? UI_COLORS.dangerBg
                        : UI_COLORS.surface,
                  }}
                >
                  {sourceShortLabel}
                </Button>
              </Tooltip>
            ) : null}
          </>
        )}
        {configChangedForNextTurn ? (
          <Tooltip title="These settings changed while a turn is running. They will apply to the next admitted turn, including recovery of a pending message that was not admitted.">
            <Tag color="orange" role="status" style={{ marginInlineEnd: 0 }}>
              Next turn
            </Tag>
          </Tooltip>
        ) : null}
      </div>
      <Modal
        open={directorySelectorOpen}
        title="Choose working directory"
        footer={null}
        destroyOnHidden
        onCancel={() => setDirectorySelectorOpen(false)}
      >
        {projectId ? (
          <DirectorySelector
            project_id={projectId}
            startingPath={selectedWorkingDirectory}
            allowAbsolutePaths
            closable={false}
            onSelect={(directory) => {
              applyWorkingDirectory(directory);
              setDirectorySelectorOpen(false);
            }}
          />
        ) : null}
      </Modal>
      <Modal
        open={membershipHelpOpen}
        title="Start a new thread to use CoCalc Membership"
        onCancel={() => setMembershipHelpOpen(false)}
        afterClose={() => paymentSourceButtonRef.current?.focus()}
        footer={
          <Button onClick={() => setMembershipHelpOpen(false)}>Got it</Button>
        }
      >
        <p>{membershipThreadHelp}</p>
      </Modal>
      <Modal
        open={open}
        title="Agent settings"
        okText="Save"
        onOk={onSave}
        onCancel={() => setOpen(false)}
        width={680}
        styles={{ body: { background: UI_COLORS.surface, paddingTop: 8 } }}
      >
        <Form form={form} layout="vertical">
          <Space orientation="vertical" style={{ width: "100%" }} size={10}>
            {configChangedForNextTurn ? (
              <Alert
                type="info"
                showIcon
                title="Changes apply to the next turn"
                description="The running turn and its internal retries keep the settings with which they were admitted. The current settings will be used for the next admitted turn, including recovery of a pending message that never started."
              />
            ) : null}
            <div
              style={{
                alignItems: "center",
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                justifyContent: "space-between",
              }}
            >
              <SectionTitle
                help={
                  <Space orientation="vertical" size={6}>
                    <span>
                      These settings apply to future turns in this chat.
                    </span>
                    {sourceTooltipDetails}
                  </Space>
                }
              >
                Runtime
              </SectionTitle>
              <Space size={6} wrap>
                <Button
                  size="small"
                  icon={<Icon name="credit-card" />}
                  onClick={() => setPaymentOpen(true)}
                >
                  Payment & credentials
                </Button>
                <Button size="small" onClick={() => setSessionsOpen(true)}>
                  Sessions
                </Button>
                {paymentSource?.source === "subscription" &&
                !siteFundedPolicy ? (
                  <Button
                    size="small"
                    icon={<Icon name="refresh" />}
                    loading={codexModelsLoading}
                    onClick={() => clearCachedCodexModelCatalog({ accountId })}
                  >
                    Refresh models
                  </Button>
                ) : null}
              </Space>
            </div>

            <div style={gridTwoColStyle}>
              {!lite ? (
                <Form.Item
                  label={
                    <SectionTitle
                      help={
                        hasEstablishedSession
                          ? "Established sessions may restrict switching to membership funding."
                          : "Choose how future turns in this chat are funded."
                      }
                    >
                      Payment source
                    </SectionTitle>
                  }
                  name="paymentSource"
                  style={formItemStyle}
                >
                  <Select
                    aria-label="Payment source"
                    options={paymentSourceOptions}
                    optionRender={(option) =>
                      renderOptionWithDescription({
                        title: `${option.data.label}`,
                        description: option.data.description,
                      })
                    }
                    onChange={(next: CodexPaymentSourcePreference) => {
                      form.setFieldsValue(paymentSourcePatch(next));
                    }}
                  />
                </Form.Item>
              ) : null}
              {siteFundedPolicy ? (
                <Form.Item
                  label={
                    <SectionTitle
                      help={
                        <>
                          CoCalc Membership selects the model and thinking
                          level.
                          {siteFundedAccountStatus ? (
                            <div style={{ marginTop: 8 }}>
                              <MembershipUsageMeters
                                status={siteFundedAccountStatus}
                                compact
                              />
                            </div>
                          ) : null}
                        </>
                      }
                    >
                      Model
                    </SectionTitle>
                  }
                  style={formItemStyle}
                >
                  <Input
                    value={`${displayedModel} · ${displayedReasoning}`}
                    disabled
                  />
                </Form.Item>
              ) : (
                <Form.Item label="Model" name="model" style={formItemStyle}>
                  <Select
                    placeholder="e.g., gpt-5.6-sol"
                    options={models}
                    optionRender={(option) =>
                      renderOptionWithDescription({
                        title: `${option.data.label}`,
                        description: option.data.description,
                      })
                    }
                    showSearch
                    onChange={(val) => {
                      modelSelectionTouchedRef.current = true;
                      const selected = models.find((m) => m.value === val);
                      const reasoning =
                        selected?.reasoning?.find((entry) => entry.default)
                          ?.id ?? selected?.reasoning?.[0]?.id;
                      if (reasoning) form.setFieldsValue({ reasoning });
                      if (!modelSupportsFastMode(val)) {
                        form.setFieldsValue({ serviceTier: "standard" });
                      }
                    }}
                  />
                </Form.Item>
              )}
              {!siteFundedPolicy ? (
                <Form.Item
                  label="Thinking level"
                  name="reasoning"
                  style={formItemStyle}
                >
                  <Select options={reasoningOptions} />
                </Form.Item>
              ) : null}
              <Form.Item
                label="Working directory"
                name="workingDirectory"
                style={formItemStyle}
              >
                <Input />
              </Form.Item>
              {!siteFundedPolicy ? (
                <Form.Item
                  label={
                    <SectionTitle help="Fast mode responds sooner but uses more credits.">
                      Speed
                    </SectionTitle>
                  }
                  name="serviceTier"
                  style={formItemStyle}
                >
                  <Radio.Group optionType="button" buttonStyle="solid">
                    <Radio.Button value="standard">Standard</Radio.Button>
                    <Radio.Button value="fast" disabled={!fastModeSupported}>
                      Fast
                    </Radio.Button>
                  </Radio.Group>
                </Form.Item>
              ) : null}
            </div>

            {selectedModelUnavailable ? (
              <Alert
                type="warning"
                showIcon
                title="Model unavailable for this ChatGPT account"
              />
            ) : null}
            {membershipNeedsNewThread ? (
              <Alert
                type="info"
                showIcon
                title="Start a new chat to use CoCalc Membership"
                action={
                  <HelpPopover label="CoCalc Membership">
                    {membershipThreadHelp}
                  </HelpPopover>
                }
              />
            ) : null}
            {selectedPaymentSource === "subscription" &&
            paymentSource?.source === "none" ? (
              <Alert
                type="warning"
                showIcon
                title="Reconnect your ChatGPT Plan"
              />
            ) : null}

            <div style={{ ...sectionStyle, padding: 10 }}>
              <SectionTitle help="Controls what files and commands the agent can use.">
                Access
              </SectionTitle>
              {lite ? (
                <Form.Item name="sessionMode" style={{ margin: "8px 0 0" }}>
                  <Radio.Group optionType="button" buttonStyle="solid">
                    {modeOptions.map((option) => (
                      <Tooltip key={option.value} title={option.description}>
                        <Radio.Button
                          value={option.value}
                          style={{
                            color: option.warning
                              ? UI_COLORS.danger
                              : undefined,
                          }}
                        >
                          {option.label}
                        </Radio.Button>
                      </Tooltip>
                    ))}
                  </Radio.Group>
                </Form.Item>
              ) : (
                <Space size={4} style={{ marginTop: 8 }}>
                  <Text>Full project access</Text>
                  <HelpPopover label="Full project access">
                    <CodexFullAccessNotice />
                  </HelpPopover>
                </Space>
              )}
            </div>

            <Collapse
              size="small"
              items={[
                {
                  key: "advanced",
                  label: "Advanced",
                  children: (
                    <Space
                      orientation="vertical"
                      size={10}
                      style={{ width: "100%" }}
                    >
                      <div style={gridTwoColStyle}>
                        <Form.Item
                          label="Session ID"
                          name="sessionId"
                          style={{ marginBottom: 0 }}
                        >
                          <Input
                            placeholder="Create a new session"
                            allowClear
                          />
                        </Form.Item>
                        <div style={{ alignSelf: "end" }}>
                          <CodexSubagentConcurrencyButton />
                        </div>
                      </div>
                      <CodexThreadId threadId={threadKey} />
                      {projectId && threadKey && accountId ? (
                        <AgentCommunication
                          api={webapp_client.conat_client.hub.agent}
                          projectId={projectId}
                          path={chatPath}
                          threadId={threadKey}
                          accountId={accountId}
                        />
                      ) : null}
                    </Space>
                  ),
                },
              ]}
            />
          </Space>
        </Form>
      </Modal>
      <CodexPaymentCredentialsModal
        open={paymentOpen}
        projectId={projectId}
        refreshPaymentSource={() => {
          refreshPaymentSource?.();
        }}
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
        <div
          style={{
            fontSize: 11,
            color: UI_COLORS.secondary,
            lineHeight: "14px",
          }}
        >
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
    paymentSource: config.paymentSource,
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
