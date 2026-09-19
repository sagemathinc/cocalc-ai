/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  normalizeAgentName,
  type NamedAgent,
  type NamedAgentDirectory,
} from "@cocalc/conat/agents/personal";
import {
  redux,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTypedRedux,
  useEditorRedux,
} from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { useAppContext } from "@cocalc/frontend/app/context";
import type { CodexThreadConfig } from "@cocalc/chat";
import type { CodexModelCapabilityInfo } from "@cocalc/conat/hub/api/system";
import {
  DEFAULT_CODEX_MODEL_NAME,
  DEFAULT_CODEX_MODELS,
  type CodexPaymentSourcePreference,
  type CodexReasoningId,
} from "@cocalc/util/ai/codex";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { initChat } from "@cocalc/frontend/chat/register";
import { chatMetaFile } from "@cocalc/frontend/chat/paths";
import { ThreadBadge } from "@cocalc/frontend/chat/thread-badge";
import { ThreadImageUpload } from "@cocalc/frontend/chat/thread-image-upload";
import { writeChatComposerDraft } from "@cocalc/frontend/chat/use-chat-composer-draft";
import { stableDraftKeyFromThreadKey } from "@cocalc/frontend/chat/utils";
import { set_url } from "@cocalc/frontend/history";
import { getPageUrlPath } from "@cocalc/frontend/page-routing";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import {
  ProjectContext,
  useProjectContextProvider,
} from "@cocalc/frontend/project/context";
import { EmbeddedProjectFile } from "@cocalc/frontend/project/page/content";
import { Icon, Loading, ThemeEditorModal } from "@cocalc/frontend/components";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import DirectorySelector from "@cocalc/frontend/project/directory-selector";
import { openFileComponentRuntimeIsUsable } from "@cocalc/frontend/project/redux/open-file-runtime";
import { CompactAgentsTopNav } from "@cocalc/frontend/app/compact-agents-top-nav";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { joinAbsolutePath } from "@cocalc/util/path-model";
import { uuid } from "@cocalc/util/misc";
import type { ThemeEditorDraft } from "@cocalc/frontend/theme/types";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import { Resizable } from "re-resizable";
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
  Popover,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
  message as antdMessage,
} from "antd";
import { openAgentThread } from "./open-agent";
import { personalAgentApi, refreshNamedAgents, useNamedAgents } from "./api";
import { AgentNameInput, agentNameProblem } from "./agent-name-input";
import { cachedAgentNameContext } from "./name-context";
import { useBoundAgentAccount } from "./use-bound-account";
import { useAgentWorkspaceOrganization } from "./use-workspace-organization";
import { groupAgentsByRecency } from "./workspace-organization";
import { AgentLoadingPreview } from "./loading-preview";
import { NameAgent } from "./name-agent";
import { AgentsAccountMenu } from "./account-menu";
import {
  AGENT_SIDEBAR_ID,
  AgentsSidebarToggle,
} from "./workspace-sidebar-toggle";
import { AgentWorkspaceCloseButton } from "./workspace-close-button";
import {
  readAgentThreadAppearance,
  resolveAgentHeaderTheme,
  resolveNamedAgentTheme,
  sameAgentHeaderAppearance,
  type AgentHeaderAppearance,
} from "./workspace-header-theme";
import {
  agentWorkspaceKey,
  findWorkspaceAgentForThread,
  selectedChatThreadFromLocalViewState,
} from "./workspace-model";
import {
  isNamedAgentLimitError,
  namedAgentLimitReached,
  NamedAgentLimitAlert,
  NamedAgentUsage,
} from "./agent-limit";
import {
  getDefaultCodexNewChatDefaults,
  getDefaultCodexSessionMode,
} from "@cocalc/frontend/chat/codex-defaults";
import {
  getCodexPaymentSourceOptions,
  useCodexPaymentSource,
} from "@cocalc/frontend/chat/use-codex-payment-source";
import {
  cachedAccountCodexModels,
  discoverAccountCodexModels,
} from "@cocalc/frontend/chat/codex-model-discovery";
import { codexModelOptionsForCatalog } from "@cocalc/frontend/chat/codex";
import {
  freshAgentExecutionConfig,
  rememberAgentName,
  suggestedAgentName,
} from "./new-agent-defaults";
import {
  readAgentSubscriptionSelection,
  writeAgentSubscriptionSelection,
} from "./agent-subscription-selection";

const { Text, Title } = Typography;

const DEFAULT_AGENT_SIDEBAR_WIDTH = 280;
const MIN_AGENT_SIDEBAR_WIDTH = 220;
const MAX_AGENT_SIDEBAR_WIDTH = 600;
const AGENT_SIDEBAR_WIDTH_STORAGE_KEY = "cocalc-agents-sidebar-width-v1";
const AGENT_SIDEBAR_HIDDEN_STORAGE_KEY = "cocalc-agents-sidebar-hidden-v1";

function initialAgentSidebarWidth(): number {
  if (typeof window === "undefined") return DEFAULT_AGENT_SIDEBAR_WIDTH;
  const stored = Number.parseInt(
    window.localStorage.getItem(AGENT_SIDEBAR_WIDTH_STORAGE_KEY) ?? "",
    10,
  );
  return Number.isFinite(stored)
    ? Math.min(
        MAX_AGENT_SIDEBAR_WIDTH,
        Math.max(MIN_AGENT_SIDEBAR_WIDTH, stored),
      )
    : DEFAULT_AGENT_SIDEBAR_WIDTH;
}

function initialAgentSidebarHidden(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.localStorage.getItem(AGENT_SIDEBAR_HIDDEN_STORAGE_KEY) === "true"
  );
}

interface PendingAgent {
  projectId: string;
  path: string;
  threadId: string;
}

function mostRecentlyEditedWritableProject(
  projectMap: any,
): string | undefined {
  const projectStore: any = redux.getStore("projects");
  const ids = projectMap?.keySeq?.().toArray?.() ?? [];
  return ids
    .filter(
      (id: string) =>
        !projectMap.getIn?.([id, "deleted"]) &&
        projectStore?.get_my_group?.(id) !== "viewer",
    )
    .sort((left: string, right: string) => {
      const value = (id: string) => {
        const date = projectMap.getIn?.([id, "last_edited"]);
        return date instanceof Date
          ? date.valueOf()
          : new Date(date ?? 0).valueOf() || 0;
      };
      return value(right) - value(left);
    })[0];
}

function selectedAgentCodexConfig(
  agent?: NamedAgent,
): CodexThreadConfig | undefined {
  if (!agent) return;
  return redux
    .getEditorActions(agent.endpoint.project_id, agent.path)
    ?.getChatActions?.()
    ?.getCodexConfig?.(agent.thread_id);
}

type NewAgentModelOption = {
  value: string;
  label: string;
  reasoning?: { id: CodexReasoningId; label: string; default?: boolean }[];
  disabled?: boolean;
  default?: boolean;
};

type NewAgentCodexConfig = CodexThreadConfig & { credentialId?: string };

type PaymentSourceWithSubscriptions = NonNullable<
  ReturnType<typeof useCodexPaymentSource>["paymentSource"]
> & {
  subscriptions?: {
    id: string;
    label?: string;
    email?: string;
    plan?: string;
  }[];
};

function defaultModelOptions(
  catalog?: CodexModelCapabilityInfo[],
  selectedModel?: string,
): NewAgentModelOption[] {
  if (catalog?.length) {
    return codexModelOptionsForCatalog(catalog, selectedModel).map(
      (option) => ({
        ...option,
        reasoning: option.reasoning?.map(
          ({ id, label, default: isDefault }) => ({
            id,
            label,
            default: isDefault,
          }),
        ),
      }),
    );
  }
  return DEFAULT_CODEX_MODELS.map((model) => ({
    value: model.name,
    label: model.name,
    reasoning: model.reasoning,
  }));
}

function reconcileAgentConfig(
  config: CodexThreadConfig,
  options: NewAgentModelOption[],
): CodexThreadConfig {
  const available = options.filter(({ disabled }) => !disabled);
  const selected = available.find(({ value }) => value === config.model);
  const model =
    selected?.value ??
    available.find(({ default: isDefault }) => isDefault)?.value ??
    available[0]?.value ??
    config.model ??
    DEFAULT_CODEX_MODEL_NAME;
  const reasoningOptions =
    options.find(({ value }) => value === model)?.reasoning ?? [];
  const reasoning =
    reasoningOptions.find(({ id }) => id === config.reasoning)?.id ??
    reasoningOptions.find(({ default: isDefault }) => isDefault)?.id ??
    reasoningOptions[0]?.id;
  return { ...config, model, reasoning };
}

async function waitForChatReady(actions: any): Promise<void> {
  if (actions.syncdb?.get_state?.() === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out preparing the new agent chat"));
    }, 15_000);
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = (err: unknown) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      actions.syncdb?.removeListener?.("ready", ready);
      actions.syncdb?.removeListener?.("error", failed);
    };
    actions.syncdb?.once?.("ready", ready);
    actions.syncdb?.once?.("error", failed);
  });
}

function NewAgentPanel({
  agents,
  namedAgentDirectory,
  sourceAgent,
  onCancel,
  onCreated,
}: {
  agents: NamedAgent[];
  namedAgentDirectory?: NamedAgentDirectory;
  sourceAgent?: NamedAgent;
  onCancel: () => void;
  onCreated: (agentId: string) => void;
}) {
  const projectMap = useTypedRedux("projects", "project_map");
  const boundAccount = useBoundAgentAccount();
  const sourceConfig = useMemo(
    () => freshAgentExecutionConfig(selectedAgentCodexConfig(sourceAgent)),
    [sourceAgent?.endpoint.agent_id],
  );
  const accountDefaults = useMemo(() => getDefaultCodexNewChatDefaults(), []);
  const [projectId, setProjectId] = useState<string | undefined>(
    () =>
      sourceAgent?.endpoint.project_id ||
      mostRecentlyEditedWritableProject(projectMap),
  );
  const [directory, setDirectory] = useState(
    () =>
      sourceConfig?.workingDirectory?.trim() ||
      (sourceAgent
        ? getProjectHomeDirectory(sourceAgent.endpoint.project_id)
        : projectId
          ? getProjectHomeDirectory(projectId)
          : ""),
  );
  const [config, setConfig] = useState<NewAgentCodexConfig>(() => ({
    ...(sourceConfig ?? {}),
    model: sourceConfig?.model || accountDefaults.model,
    reasoning: sourceConfig?.reasoning ?? accountDefaults.reasoning,
    serviceTier: sourceConfig?.serviceTier ?? accountDefaults.serviceTier,
    sessionMode:
      sourceConfig?.sessionMode ??
      accountDefaults.sessionMode ??
      getDefaultCodexSessionMode(),
    allowWrite:
      (sourceConfig?.sessionMode ?? accountDefaults.sessionMode) !==
      "read-only",
    paymentSource: sourceConfig?.paymentSource ?? "auto",
    credentialId: sourceAgent
      ? readAgentSubscriptionSelection({
          accountId: boundAccount.accountId,
          projectId: sourceAgent.endpoint.project_id,
          threadId: sourceAgent.thread_id,
        })
      : undefined,
  }));
  const [name, setName] = useState(() =>
    suggestedAgentName(agents, boundAccount.accountId),
  );
  const [description, setDescription] = useState("");
  const [firstRequest, setFirstRequest] = useState("");
  const [directorySelectorOpen, setDirectorySelectorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<
    CodexModelCapabilityInfo[] | undefined
  >();
  const [pending, setPending] = useState<PendingAgent>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const paymentPreference = (config.paymentSource ??
    "auto") as CodexPaymentSourcePreference;
  const {
    paymentSource,
    loading: paymentSourceLoading,
    error: paymentSourceError,
  } = useCodexPaymentSource({
    projectId,
    preference: paymentPreference,
    enabled: !!projectId,
    credentialId:
      paymentPreference === "subscription" ? config.credentialId : undefined,
  } as Parameters<typeof useCodexPaymentSource>[0] & {
    credentialId?: string;
  });
  const modelOptions = useMemo(
    () => defaultModelOptions(modelCatalog, config.model),
    [config.model, modelCatalog],
  );
  const reasoningOptions =
    modelOptions.find(({ value }) => value === config.model)?.reasoning ?? [];
  const problem = agentNameProblem(
    name,
    agents,
    pending
      ? {
          project_id: pending.projectId,
          path: pending.path,
          thread_id: pending.threadId,
        }
      : undefined,
  );
  const atLimit = namedAgentLimitReached(namedAgentDirectory);

  useEffect(() => {
    if (projectId || !projectMap) return;
    const preferred = mostRecentlyEditedWritableProject(projectMap);
    if (preferred) {
      setProjectId(preferred);
      setDirectory(getProjectHomeDirectory(preferred));
    }
  }, [projectId, projectMap]);

  useEffect(() => {
    let disposed = false;
    setModelCatalog(undefined);
    if (!projectId || paymentSource?.source !== "subscription") return;
    const cached = cachedAccountCodexModels(projectId, paymentSource);
    if (cached?.length) setModelCatalog(cached);
    void discoverAccountCodexModels(projectId, paymentSource)
      .then((catalog) => {
        if (!disposed && catalog?.length) setModelCatalog(catalog);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [paymentSource?.source, paymentSource?.subscriptionRevision, projectId]);

  useEffect(() => {
    const policy =
      paymentSource?.source === "site-api-key" &&
      paymentSource.siteFundedCodex?.enabled
        ? paymentSource.siteFundedCodex.policy
        : undefined;
    setConfig((current) => {
      const next = policy
        ? {
            ...current,
            model: policy.model,
            reasoning: policy.reasoning as CodexReasoningId,
          }
        : reconcileAgentConfig(
            current,
            defaultModelOptions(modelCatalog, current.model),
          );
      return next.model === current.model &&
        next.reasoning === current.reasoning
        ? current
        : next;
    });
  }, [modelCatalog, paymentSource?.source, paymentSource?.siteFundedCodex]);

  async function prepare(): Promise<PendingAgent> {
    if (pending) return pending;
    let targetProjectId = projectId;
    if (!targetProjectId) {
      targetProjectId = await redux.getActions("projects").create_project({
        title: "Agents",
        description: "Workspace for CoCalc agents",
        start: true,
      });
      setProjectId(targetProjectId);
    }
    await ensureProjectReduxRuntime();
    const projectActions = redux.getProjectActions(targetProjectId);
    const fs = projectActions?.fs?.();
    if (!projectActions || !fs) {
      throw new Error("The selected project filesystem is unavailable");
    }
    const workingDirectory =
      directory.trim() || getProjectHomeDirectory(targetProjectId);
    const stat = await fs.stat(workingDirectory);
    if (!stat.isDirectory()) {
      throw new Error("The working directory is not a directory");
    }
    const path = joinAbsolutePath(
      getProjectHomeDirectory(targetProjectId),
      `.local/share/cocalc/agents/${uuid()}.chat`,
    );
    await projectActions.ensureContainingDirectoryExists(path);
    await fs.writeFile(path, "");
    const chatActions = initChat(targetProjectId, chatMetaFile(path));
    await waitForChatReady(chatActions);
    const threadId = chatActions.createEmptyThread({
      name: name.trim(),
      threadAgent: {
        mode: "codex",
        model: config.model,
        codexConfig: { ...config, workingDirectory },
      },
    });
    if (!threadId) throw new Error("Unable to create the agent thread");
    await chatActions.syncdb?.save();
    const created = { projectId: targetProjectId, path, threadId };
    writeAgentSubscriptionSelection({
      accountId: boundAccount.accountId,
      projectId: targetProjectId,
      threadId,
      credentialId:
        config.paymentSource === "subscription"
          ? config.credentialId
          : undefined,
    });
    setPending(created);
    return created;
  }

  async function create() {
    if (busy || problem || atLimit || !firstRequest.trim()) return;
    setBusy(true);
    setError("");
    try {
      const created = await prepare();
      boundAccount.assertCurrent();
      const api = personalAgentApi();
      const locator = {
        project_id: created.projectId,
        path: created.path,
        thread_id: created.threadId,
      };
      let identity = await api.resolveIdentity(locator);
      if (!identity) {
        identity = await api.registerIdentity(locator);
      }
      if (!identity) throw new Error("Unable to register this agent thread");
      boundAccount.assertCurrent();
      await api.nameAgent({
        endpoint: {
          project_id: created.projectId,
          agent_id: identity.agent_id,
        },
        name: normalizeAgentName(name),
        description,
        ...cachedAgentNameContext(locator),
        project_title: projectMap?.getIn([created.projectId, "title"]) as
          | string
          | undefined,
        thread_title: name.trim(),
      });
      const actions = initChat(created.projectId, chatMetaFile(created.path));
      await waitForChatReady(actions);
      const sent = actions.sendChat({
        input: firstRequest.trim(),
        reply_thread_id: created.threadId,
        acpConfigOverride: config,
      });
      if (sent) {
        await actions.syncdb?.save();
      } else {
        await writeChatComposerDraft({
          account_id: boundAccount.accountId,
          project_id: created.projectId,
          path: chatMetaFile(created.path),
          composerDraftKey: stableDraftKeyFromThreadKey(created.threadId),
          text: firstRequest,
        });
        antdMessage.warning(
          "The agent was created, but the first request could not start. It is preserved as a draft.",
        );
      }
      rememberAgentName(normalizeAgentName(name), boundAccount.accountId);
      refreshNamedAgents();
      onCreated(identity.agent_id);
    } catch (err) {
      setError(
        isNamedAgentLimitError(err)
          ? "Your membership's named-agent limit was reached."
          : `${err}`,
      );
      if (isNamedAgentLimitError(err)) refreshNamedAgents();
    } finally {
      setBusy(false);
    }
  }

  const projectTitle = projectId
    ? ((projectMap?.getIn([projectId, "title"]) as string | undefined) ??
      "Project")
    : "New project";
  const subscriptions =
    (paymentSource as PaymentSourceWithSubscriptions | undefined)
      ?.subscriptions ?? [];
  const paymentOptions = getCodexPaymentSourceOptions(paymentSource).flatMap(
    (option) => {
      if (option.value !== "subscription" || subscriptions.length === 0) {
        return [option];
      }
      return subscriptions.map((subscription) => ({
        value: `subscription:${subscription.id}`,
        label:
          subscription.label?.trim() ||
          (() => {
            const index = [...subscriptions]
              .sort((left, right) => left.id.localeCompare(right.id))
              .findIndex(({ id }) => id === subscription.id);
            return index > 0 ? `ChatGPT ${index + 1}` : "ChatGPT";
          })(),
        description: subscription.plan
          ? `Use this ChatGPT ${subscription.plan} subscription.`
          : option.description,
      }));
    },
  );
  const selectedPaymentValue =
    paymentPreference === "subscription" && config.credentialId
      ? `subscription:${config.credentialId}`
      : paymentPreference;
  const paymentLabel =
    paymentOptions.find(({ value }) => value === selectedPaymentValue)?.label ??
    "Automatic";
  const siteFundedPolicy =
    paymentSource?.source === "site-api-key" &&
    paymentSource.siteFundedCodex?.enabled
      ? paymentSource.siteFundedCodex.policy
      : undefined;
  const advancedSettings = (
    <div style={{ width: 360, maxWidth: "calc(100vw - 48px)" }}>
      <Space orientation="vertical" size={10} style={{ width: "100%" }}>
        <label htmlFor="new-agent-name">Agent name</label>
        <AgentNameInput
          id="new-agent-name"
          value={name}
          onChange={setName}
          problem={name.trim() ? problem : undefined}
          busy={busy || !!pending}
          onEnter={() => undefined}
        />
        <label htmlFor="new-agent-description">Description (optional)</label>
        <Input.TextArea
          id="new-agent-description"
          value={description}
          maxLength={500}
          disabled={busy}
          autoSize={{ minRows: 2, maxRows: 5 }}
          onChange={(event) => setDescription(event.target.value)}
        />
        <label>Project</label>
        <SelectProject
          fullCollaboratorOnly
          value={projectId}
          disabled={busy || !!pending}
          onChange={(nextProjectId) => {
            setProjectId(nextProjectId);
            setDirectory(getProjectHomeDirectory(nextProjectId));
          }}
        />
        {!projectId && (
          <Text type="secondary">
            A project named “Agents” will be created when you start.
          </Text>
        )}
        <label htmlFor="new-agent-directory">Working directory</label>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            id="new-agent-directory"
            value={directory}
            disabled={busy || !!pending}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <Button
            style={{ height: 31 }}
            disabled={!projectId || busy || !!pending}
            onClick={() => {
              setSettingsOpen(false);
              setDirectorySelectorOpen(true);
            }}
          >
            Choose…
          </Button>
        </Space.Compact>
      </Space>
    </div>
  );

  return (
    <div
      style={{
        alignItems: "center",
        boxSizing: "border-box",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        overflowY: "auto",
        padding: "48px 20px",
        width: "100%",
      }}
    >
      <Space
        orientation="vertical"
        size={16}
        style={{ maxWidth: 820, minWidth: 0, width: "100%" }}
      >
        <div style={{ textAlign: "center" }}>
          <Title level={2} style={{ marginBottom: 4 }}>
            What should your new agent do?
          </Title>
          <Text type="secondary">
            Starting from{" "}
            {sourceAgent ? `@${sourceAgent.name}` : "your defaults"}. You can
            change any setting below.
          </Text>
        </div>
        <NamedAgentLimitAlert directory={namedAgentDirectory} />
        <div
          style={{
            background: UI_COLORS.surface,
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 18,
            boxSizing: "border-box",
            boxShadow: `0 12px 40px ${UI_COLORS.shadow}`,
            maxWidth: "100%",
            padding: 12,
          }}
        >
          <label htmlFor="new-agent-first-request" style={{ display: "none" }}>
            First request
          </label>
          <Input.TextArea
            id="new-agent-first-request"
            aria-label="First request"
            value={firstRequest}
            autoFocus
            autoSize={{ minRows: 5, maxRows: 16 }}
            variant="borderless"
            disabled={busy}
            placeholder="Ask your agent to build, research, debug, or explain…"
            style={{ fontSize: 16, resize: "none" }}
            onChange={(event) => setFirstRequest(event.target.value)}
            onKeyDown={(event) => {
              if (event.shiftKey && event.key === "Enter") {
                event.preventDefault();
                void create();
              }
            }}
          />
          <div
            style={{
              alignItems: "center",
              borderTop: `1px solid ${UI_COLORS.border}`,
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              paddingTop: 10,
            }}
          >
            <Popover
              content={advancedSettings}
              open={settingsOpen}
              placement="bottomLeft"
              trigger="click"
              onOpenChange={setSettingsOpen}
            >
              <Button icon={<Icon name="sliders" />}>Settings</Button>
            </Popover>
            <Tag style={{ alignContent: "center", minHeight: 30 }}>
              {projectTitle}
            </Tag>
            <Select
              aria-label="Payment source"
              value={selectedPaymentValue}
              loading={paymentSourceLoading}
              disabled={busy || !!pending}
              options={paymentOptions}
              style={{ minWidth: 150 }}
              onChange={(value: string) => {
                if (value.startsWith("subscription:")) {
                  setConfig((current) => ({
                    ...current,
                    paymentSource: "subscription",
                    credentialId: value.slice("subscription:".length),
                  }));
                  return;
                }
                setConfig((current) => ({
                  ...current,
                  paymentSource: value as CodexPaymentSourcePreference,
                  credentialId: undefined,
                }));
              }}
            />
            <Select
              aria-label="Model"
              value={config.model}
              disabled={busy || !!pending || !!siteFundedPolicy}
              options={modelOptions}
              showSearch
              optionFilterProp="label"
              style={{ minWidth: 150 }}
              onChange={(model) =>
                setConfig((current) =>
                  reconcileAgentConfig({ ...current, model }, modelOptions),
                )
              }
            />
            <Select
              aria-label="Reasoning level"
              value={config.reasoning}
              disabled={
                busy ||
                !!pending ||
                !!siteFundedPolicy ||
                reasoningOptions.length === 0
              }
              options={reasoningOptions.map(({ id, label }) => ({
                value: id,
                label,
              }))}
              placeholder="Reasoning"
              style={{ minWidth: 120 }}
              onChange={(reasoning: CodexReasoningId) =>
                setConfig((current) => ({ ...current, reasoning }))
              }
            />
            <span style={{ flex: 1 }} />
            <Button
              type="primary"
              shape="round"
              loading={busy}
              disabled={!!problem || !firstRequest.trim() || atLimit}
              onClick={() => void create()}
            >
              Start agent
            </Button>
          </div>
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            justifyContent: "space-between",
          }}
        >
          <Text type="secondary">
            @{name} · {paymentLabel} · Shift+Enter to start
          </Text>
          <Space>
            <NamedAgentUsage directory={namedAgentDirectory} />
            {agents.length > 0 && (
              <Button type="text" disabled={busy} onClick={onCancel}>
                Cancel
              </Button>
            )}
          </Space>
        </div>
        {paymentSourceError && (
          <Alert
            role="alert"
            type="error"
            showIcon
            title="Unable to determine an available payment source"
            description={paymentSourceError}
          />
        )}
        {pending && (
          <Alert
            type="info"
            showIcon
            title="Agent storage prepared"
            description="Registration did not finish. Retrying reuses this thread."
          />
        )}
        {error && <Alert role="alert" type="error" title={error} />}
      </Space>
      <Modal
        open={directorySelectorOpen}
        title="Choose working directory"
        footer={null}
        destroyOnHidden
        onCancel={() => setDirectorySelectorOpen(false)}
      >
        {projectId && (
          <DirectorySelector
            project_id={projectId}
            startingPath={directory}
            allowAbsolutePaths
            closable={false}
            onSelect={(path) => {
              setDirectory(path);
              setDirectorySelectorOpen(false);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function AgentProjectContext({
  agent,
  workspaceAgents,
  active,
  accountId,
  onSelectedThread,
  onAgentActivity,
  onThreadAppearance,
  onChatActions,
}: {
  agent: NamedAgent;
  workspaceAgents: NamedAgent[];
  active: boolean;
  accountId?: string;
  onSelectedThread: (threadId: string) => void;
  onAgentActivity: (agentId: string, at: number) => void;
  onThreadAppearance: (
    threadId: string,
    appearance: AgentHeaderAppearance,
  ) => void;
  onChatActions: (actions: ChatActions | undefined) => void;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const initialThreadRef = useRef(agent.thread_id);
  const requestedThreadRef = useRef<string | undefined>(undefined);
  const wasActiveRef = useRef(active);
  const useEditor = useEditorRedux<{ activity: any; local_view_state: any }>({
    project_id: agent.endpoint.project_id,
    path: agent.path,
  });
  const localViewState = useEditor("local_view_state");
  const activity = useEditor("activity");
  const onAgentActivityRef = useRef(onAgentActivity);
  const onThreadAppearanceRef = useRef(onThreadAppearance);
  const workspaceAgentsRef = useRef(workspaceAgents);
  const reportedActivityRef = useRef<Map<string, number>>(new Map());
  const workspaceAgentKey = workspaceAgents
    .map(({ endpoint, thread_id }) => `${endpoint.agent_id}:${thread_id}`)
    .join("\0");
  const openFiles = useTypedRedux(
    { project_id: agent.endpoint.project_id },
    "open_files",
  );
  const component = openFiles?.getIn?.([agent.path, "component"]) as
    | {
        Editor?: unknown;
        redux_name?: string;
        runtime_generation?: number;
      }
    | undefined;
  const runtimeIsUsable = openFileComponentRuntimeIsUsable({
    info: component,
    isViewer: false,
    getActions: (name) => redux.getActions(name),
    getStore: (name) => redux.getStore(name),
  });
  const selectedThread = selectedChatThreadFromLocalViewState(localViewState);
  const projectContext = useProjectContextProvider({
    project_id: agent.endpoint.project_id,
    is_active: active,
    mainWidthPx: 900,
    manageWorkspaceSelection: false,
  });

  useEffect(() => {
    onAgentActivityRef.current = onAgentActivity;
  }, [onAgentActivity]);

  useEffect(() => {
    onThreadAppearanceRef.current = onThreadAppearance;
  }, [onThreadAppearance]);

  useEffect(() => {
    workspaceAgentsRef.current = workspaceAgents;
  }, [workspaceAgentKey]);

  useEffect(() => {
    const updates = workspaceAgentsRef.current.flatMap(
      ({ endpoint, thread_id }) => {
        const at = activity?.get?.(thread_id);
        return typeof at === "number" &&
          at > (reportedActivityRef.current.get(endpoint.agent_id) ?? 0)
          ? [{ agentId: endpoint.agent_id, at }]
          : [];
      },
    );
    if (updates.length === 0) return;
    const timer = setTimeout(() => {
      for (const { agentId, at } of updates) {
        reportedActivityRef.current.set(agentId, at);
        onAgentActivityRef.current(agentId, at);
      }
    }, 750);
    return () => clearTimeout(timer);
  }, [activity, workspaceAgentKey]);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let actions: ChatActions | undefined;
    let cleanupListeners = () => {};
    const update = (chatActions: ChatActions) => {
      const threadIds = new Set(
        workspaceAgentsRef.current.map(({ thread_id }) => thread_id),
      );
      if (selectedThread) threadIds.add(selectedThread);
      for (const threadId of threadIds) {
        onThreadAppearanceRef.current(
          threadId,
          readAgentThreadAppearance(chatActions, threadId),
        );
      }
    };
    const attach = () => {
      if (disposed) return;
      actions = redux
        .getEditorActions(agent.endpoint.project_id, agent.path)
        ?.getChatActions?.();
      if (!actions?.getThreadMetadata) {
        retryTimer = setTimeout(attach, 50);
        return;
      }
      const attachedActions = actions;
      onChatActions(attachedActions);
      const refresh = () => update(attachedActions);
      update(attachedActions);
      attachedActions.syncdb?.on?.("change", refresh);
      attachedActions.messageCache?.on?.("version", refresh);
      cleanupListeners = () => {
        attachedActions.syncdb?.removeListener?.("change", refresh);
        attachedActions.messageCache?.removeListener?.("version", refresh);
      };
    };
    attach();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      cleanupListeners();
      onChatActions(undefined);
    };
  }, [
    agent.endpoint.project_id,
    agent.path,
    component?.redux_name,
    component?.runtime_generation,
    onChatActions,
    ready,
    selectedThread,
    workspaceAgentKey,
  ]);

  const openEmbeddedFile = useCallback(async () => {
    await ensureProjectReduxRuntime();
    const actions = redux.getProjectActions(agent.endpoint.project_id);
    if (!actions) throw new Error("Unable to load this agent's project");
    await actions.open_file({
      path: agent.path,
      embedded: true,
      foreground: false,
      foreground_project: false,
      wait_for_ready: true,
      change_history: false,
      fragmentId: { thread: initialThreadRef.current },
    });
  }, [agent.endpoint.project_id, agent.path]);

  useEffect(() => {
    let disposed = false;
    setReady(false);
    setError("");
    void (async () => {
      await openEmbeddedFile();
      if (!disposed) setReady(true);
    })().catch((err) => {
      if (!disposed) setError(`${err}`);
    });
    return () => {
      disposed = true;
    };
  }, [openEmbeddedFile, retry]);

  useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!becameActive || !ready) return;
    if (runtimeIsUsable) return;

    // Closing this file in its project destroys the shared editor runtime.
    // Unmount the stale editor before open_file creates its replacement so
    // hooks subscribe to the new store/actions rather than the closed ones.
    setReady(false);
    setRetry((value) => value + 1);
  }, [active, ready, runtimeIsUsable]);

  useEffect(() => {
    if (!active || !ready) return;
    requestedThreadRef.current = agent.thread_id;
    const editorActions: any = redux.getEditorActions(
      agent.endpoint.project_id,
      agent.path,
    );
    if (typeof editorActions?.gotoFragment === "function") {
      void editorActions.gotoFragment({ thread: agent.thread_id });
    } else {
      redux
        .getProjectActions(agent.endpoint.project_id)
        ?.gotoFragment(agent.path, { thread: agent.thread_id });
    }
  }, [active, agent.endpoint.project_id, agent.path, agent.thread_id, ready]);

  useEffect(() => {
    if (!active || !ready || !selectedThread) return;
    if (requestedThreadRef.current) {
      if (selectedThread !== requestedThreadRef.current) return;
      requestedThreadRef.current = undefined;
    }
    onSelectedThread(selectedThread);
  }, [active, onSelectedThread, ready, selectedThread]);

  if (error) {
    return (
      <Alert
        showIcon
        type="error"
        title="Unable to open this agent"
        description={error}
        action={
          <Space>
            <Button onClick={() => setRetry((value) => value + 1)}>
              Retry
            </Button>
            <Button
              onClick={() =>
                void openAgentThread({
                  project_id: agent.endpoint.project_id,
                  path: agent.path,
                  thread_id: agent.thread_id,
                })
              }
            >
              Open in project
            </Button>
          </Space>
        }
      />
    );
  }
  if (!ready)
    return <AgentLoadingPreview accountId={accountId} agent={agent} />;
  return (
    <ProjectContext.Provider value={projectContext}>
      <EmbeddedProjectFile path={agent.path} isVisible={active} />
    </ProjectContext.Provider>
  );
}

function AgentsWorkspaceNavigation({
  onOpenInProject,
  foregroundColor,
}: {
  onOpenInProject?: () => void;
  foregroundColor?: string;
} = {}) {
  const { pageStyle } = useAppContext();
  const accountId = useTypedRedux("account", "account_id");
  return (
    <CompactAgentsTopNav
      isLoggedIn={!!accountId}
      pageStyle={pageStyle}
      onOpenInProject={onOpenInProject}
      foregroundColor={foregroundColor}
    />
  );
}

function AgentWorkspace({
  workspaceKey,
  agent,
  workspaceAgents,
  active,
  accountId,
  onShowList,
  agentSidebarHidden,
  onToggleAgentSidebar,
  onAgentActivity,
  agentAppearances,
  onAgentAppearance,
  onClose,
  onRegisteredThreadSelected,
}: {
  workspaceKey: string;
  agent: NamedAgent;
  workspaceAgents: NamedAgent[];
  active: boolean;
  accountId?: string;
  onShowList?: () => void;
  agentSidebarHidden?: boolean;
  onToggleAgentSidebar?: () => void;
  onAgentActivity: (agentId: string, at: number) => void;
  agentAppearances: Map<string, AgentHeaderAppearance>;
  onAgentAppearance: (
    agentId: string,
    appearance: AgentHeaderAppearance,
  ) => void;
  onClose: () => void;
  onRegisteredThreadSelected: (workspaceKey: string, agent: NamedAgent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [selectedThread, setSelectedThread] = useState(agent.thread_id);
  const [headerAppearance, setHeaderAppearance] = useState<{
    threadId: string;
    value: AgentHeaderAppearance;
  }>();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [appearanceThreadId, setAppearanceThreadId] = useState<string>();
  const [appearanceDraft, setAppearanceDraft] =
    useState<ThemeEditorDraft | null>(null);
  const [chatActions, setChatActions] = useState<ChatActions>();
  const selectedAgent = findWorkspaceAgentForThread(
    workspaceAgents,
    agent.endpoint.project_id,
    agent.path,
    selectedThread,
  );
  const displayedAgent = selectedAgent ?? agent;
  const projectUsers: any = useTypedRedux("projects", "project_map")?.getIn?.([
    agent.endpoint.project_id,
    "users",
  ]);
  const collaboratorCount =
    typeof projectUsers?.size === "number"
      ? projectUsers.size
      : projectUsers && typeof projectUsers === "object"
        ? Object.keys(projectUsers).length
        : undefined;
  const sharing =
    collaboratorCount == null
      ? undefined
      : collaboratorCount <= 1
        ? "Only you"
        : `${collaboratorCount} collaborators`;
  useEffect(() => {
    if (active || !ref.current?.contains(document.activeElement)) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, [active]);
  const handleSelectedThread = useCallback(
    (threadId: string) => {
      setSelectedThread(threadId);
      const registered = findWorkspaceAgentForThread(
        workspaceAgents,
        agent.endpoint.project_id,
        agent.path,
        threadId,
      );
      if (registered) {
        onRegisteredThreadSelected(workspaceKey, registered);
      }
    },
    [
      agent.endpoint.project_id,
      agent.path,
      onRegisteredThreadSelected,
      workspaceAgents,
      workspaceKey,
    ],
  );
  const unregistered = selectedThread && !selectedAgent;
  const selectedThreadMetadata = selectedThread
    ? chatActions?.getThreadMetadata?.(selectedThread, {
        threadId: selectedThread,
      })
    : undefined;
  const canRegisterSelectedThread =
    !!unregistered && selectedThreadMetadata?.agent_kind === "acp";
  const threadTitle = unregistered
    ? cachedAgentNameContext({
        project_id: agent.endpoint.project_id,
        path: agent.path,
        thread_id: selectedThread,
      }).thread_title
    : undefined;
  const appearance =
    headerAppearance?.threadId === selectedThread
      ? headerAppearance.value
      : selectedAgent
        ? agentAppearances.get(selectedAgent.endpoint.agent_id)
        : undefined;
  const resolvedTheme = unregistered
    ? resolveAgentHeaderTheme({
        appearance,
        fallbackTitle: threadTitle || "Unregistered thread",
      })
    : resolveNamedAgentTheme(displayedAgent, appearance);
  const {
    accentColor,
    backgroundColor,
    primaryColor,
    textColor: headerTextColor,
    title,
  } = resolvedTheme;
  const openAppearanceEditor = () => {
    if (!selectedThread) return;
    const metadata = readAgentThreadAppearance(chatActions, selectedThread);
    setAppearanceDraft({
      title: metadata?.name?.trim() || title,
      description: "",
      color: metadata?.thread_color?.trim() || null,
      accent_color: metadata?.thread_accent_color?.trim() || null,
      icon: metadata?.thread_icon?.trim() || "",
      image_blob: metadata?.thread_image?.trim() || "",
    });
    setAppearanceThreadId(selectedThread);
    setAppearanceOpen(true);
  };
  const saveAppearance = () => {
    if (!appearanceThreadId || !appearanceDraft) return;
    const saved = chatActions?.setThreadAppearance?.(appearanceThreadId, {
      name: appearanceDraft.title,
      color: appearanceDraft.color ?? undefined,
      accentColor: appearanceDraft.accent_color ?? undefined,
      icon: appearanceDraft.icon,
      image: appearanceDraft.image_blob,
    });
    if (!saved) {
      antdMessage.error("Unable to save thread appearance.");
      return;
    }
    setAppearanceOpen(false);
    setAppearanceThreadId(undefined);
    antdMessage.success("Appearance saved.");
  };
  const openProject = (target: "files/" | "settings", anchor?: string) => {
    void redux
      .getActions("projects")
      .open_project({
        project_id: agent.endpoint.project_id,
        target,
        switch_to: true,
        fragmentId: anchor ? { anchor } : undefined,
      })
      .then(() => {
        if (anchor) Fragment.set({ anchor });
      })
      .catch((err) => {
        antdMessage.error(`Unable to open project: ${err}`);
      });
  };
  return (
    <div
      ref={ref}
      aria-hidden={!active}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: UI_COLORS.surface,
        opacity: active ? 1 : 0,
        pointerEvents: active ? "auto" : "none",
        visibility: active ? "visible" : "hidden",
      }}
    >
      <header
        style={{
          alignItems: "center",
          background: backgroundColor,
          borderBottom: `2px solid ${primaryColor ?? UI_COLORS.border}`,
          boxShadow: primaryColor ? `inset 4px 0 0 ${primaryColor}` : undefined,
          color: headerTextColor,
          display: "flex",
          gap: 12,
          padding: "2px 12px",
        }}
      >
        {onShowList && (
          <Button
            aria-label="Back to agent list"
            icon={<Icon name="arrow-left" />}
            onClick={onShowList}
          />
        )}
        {onToggleAgentSidebar && agentSidebarHidden != null && (
          <AgentsSidebarToggle
            hidden={agentSidebarHidden}
            onToggle={onToggleAgentSidebar}
            color={headerTextColor}
          />
        )}
        <Button
          aria-label="Edit thread appearance"
          type="text"
          onClick={openAppearanceEditor}
          style={{ color: headerTextColor, height: 44, padding: 4 }}
        >
          <ThreadBadge
            icon={appearance?.thread_icon}
            color={primaryColor}
            accentColor={accentColor}
            image={appearance?.thread_image}
            fallbackIcon={
              primaryColor || accentColor || appearance?.thread_image
                ? undefined
                : "robot"
            }
            size={36}
          />
        </Button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Button
            aria-label="Edit thread appearance"
            type="text"
            onClick={openAppearanceEditor}
            style={{
              color: headerTextColor,
              display: "block",
              fontSize: 16,
              fontWeight: 600,
              height: "auto",
              maxWidth: "100%",
              overflow: "hidden",
              padding: 0,
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </Button>
          <div
            style={{
              alignItems: "center",
              color: headerTextColor,
              display: "flex",
              minWidth: 0,
              opacity: 0.78,
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {canRegisterSelectedThread ? (
              <Text style={{ color: "inherit" }}>Not yet registered</Text>
            ) : !unregistered ? (
              <NameAgent
                agent={displayedAgent}
                projectId={agent.endpoint.project_id}
                path={agent.path}
                threadId={selectedThread}
                threadTitle={title}
                projectTitle={agent.project_title}
                triggerLabel={`@${displayedAgent.name}`}
                triggerButtonProps={{
                  type: "link",
                  style: {
                    color: "inherit",
                    height: "auto",
                    padding: 0,
                  },
                }}
              />
            ) : null}
            {!unregistered || canRegisterSelectedThread ? (
              <span aria-hidden="true">&nbsp;·&nbsp;</span>
            ) : null}
            <Button
              type="link"
              size="small"
              onClick={() => openProject("files/")}
              style={{ color: "inherit", height: "auto", padding: 0 }}
            >
              {displayedAgent.project_title || agent.endpoint.project_id}
            </Button>
            {sharing ? (
              <>
                <span aria-hidden="true">&nbsp;·&nbsp;</span>
                <Button
                  type="link"
                  size="small"
                  onClick={() => openProject("settings", "people")}
                  style={{ color: "inherit", height: "auto", padding: 0 }}
                >
                  {sharing}
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {canRegisterSelectedThread && (
          <NameAgent
            projectId={agent.endpoint.project_id}
            path={agent.path}
            threadId={selectedThread}
            threadTitle={threadTitle}
            projectTitle={agent.project_title}
            triggerLabel="Add to Agents"
            modalTitle="Add thread to Agents"
          />
        )}
        {!unregistered && !displayedAgent.available && (
          <Tag color="warning">Unavailable</Tag>
        )}
        {active && (
          <AgentsWorkspaceNavigation
            foregroundColor={headerTextColor}
            onOpenInProject={() =>
              void openAgentThread({
                project_id: agent.endpoint.project_id,
                path: agent.path,
                thread_id: selectedThread || agent.thread_id,
              })
            }
          />
        )}
        <AgentWorkspaceCloseButton
          agentPath={agent.path}
          color={headerTextColor}
          onClose={onClose}
        />
      </header>
      <ThemeEditorModal
        open={appearanceOpen}
        title="Edit Thread Appearance"
        value={appearanceDraft}
        projectId={agent.endpoint.project_id}
        defaultIcon="comment"
        showDescription={false}
        previewImageUrl={appearanceDraft?.image_blob}
        onChange={(patch) =>
          setAppearanceDraft((current) =>
            current == null ? current : { ...current, ...patch },
          )
        }
        onCancel={() => {
          setAppearanceOpen(false);
          setAppearanceThreadId(undefined);
        }}
        onSave={saveAppearance}
        renderImageInput={({ value, onChange }) => (
          <ThreadImageUpload
            projectId={agent.endpoint.project_id}
            value={value?.image_blob}
            onChange={(image_blob) => onChange({ image_blob })}
            modalTitle="Edit Chat Image"
            uploadText="Click or drag chat image"
            size={64}
          />
        )}
      />
      <div style={{ position: "relative", minHeight: 0, flex: 1 }}>
        <AgentProjectContext
          agent={agent}
          workspaceAgents={workspaceAgents}
          active={active}
          accountId={accountId}
          onSelectedThread={handleSelectedThread}
          onAgentActivity={onAgentActivity}
          onChatActions={setChatActions}
          onThreadAppearance={(threadId, value) => {
            if (threadId === selectedThread) {
              setHeaderAppearance((current) =>
                current?.threadId === threadId &&
                sameAgentHeaderAppearance(current.value, value)
                  ? current
                  : { threadId, value },
              );
            }
            const registered = findWorkspaceAgentForThread(
              workspaceAgents,
              agent.endpoint.project_id,
              agent.path,
              threadId,
            );
            if (registered) {
              onAgentAppearance(registered.endpoint.agent_id, value);
            }
          }}
        />
      </div>
    </div>
  );
}

export function MyAgentsWorkspacePage({ active = true }: { active?: boolean }) {
  const { pageStyle } = useAppContext();
  const isNarrow = pageStyle.isNarrow;
  const { directory, error, loading } = useNamedAgents();
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const activeAgentId = useTypedRedux("page", "active_agent_id") as
    | string
    | undefined;
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [copyingAgent, setCopyingAgent] = useState<NamedAgent>();
  const [copyName, setCopyName] = useState("");
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [mobileList, setMobileList] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [agentSidebarWidth, setAgentSidebarWidth] = useState(
    initialAgentSidebarWidth,
  );
  const [agentSidebarHidden, setAgentSidebarHidden] = useState(
    initialAgentSidebarHidden,
  );
  const [mountedWorkspaces, setMountedWorkspaces] = useState<Set<string>>(
    () => new Set(),
  );
  const [workspaceAgentIds, setWorkspaceAgentIds] = useState<
    Map<string, string>
  >(() => new Map());
  const [agentAppearances, setAgentAppearances] = useState<
    Map<string, AgentHeaderAppearance>
  >(() => new Map());
  const rootRef = useRef<HTMLElement>(null);
  const boundAccount = useBoundAgentAccount();

  const toggleAgentSidebar = useCallback(() => {
    setAgentSidebarHidden((hidden) => {
      const next = !hidden;
      window.localStorage.setItem(AGENT_SIDEBAR_HIDDEN_STORAGE_KEY, `${next}`);
      return next;
    });
  }, []);

  useEffect(() => {
    if (active || !rootRef.current?.contains(document.activeElement)) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, [active]);
  const agents = directory?.agents ?? [];
  const agentOrganization = useAgentWorkspaceOrganization(agents);
  const selected = activeAgentId
    ? agents.find((agent) => agent.endpoint.agent_id === activeAgentId)
    : (agentOrganization.groups.pinned[0] ??
      agentOrganization.groups.unpinned[0]);

  const handleAgentAppearance = useCallback(
    (agentId: string, appearance: AgentHeaderAppearance) => {
      setAgentAppearances((current) => {
        if (sameAgentHeaderAppearance(current.get(agentId), appearance)) {
          return current;
        }
        const next = new Map(current);
        next.set(agentId, appearance);
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (!selected) return;
    const workspace = agentWorkspaceKey(selected);
    setMountedWorkspaces((old) => {
      if (old.has(workspace)) return old;
      const next = new Set(old);
      next.add(workspace);
      return next;
    });
    setWorkspaceAgentIds((old) => {
      if (old.get(workspace) === selected.endpoint.agent_id) return old;
      const next = new Map(old);
      next.set(workspace, selected.endpoint.agent_id);
      return next;
    });
  }, [selected?.endpoint.agent_id]);

  const visibleGroups = useMemo(() => {
    const value = search.trim().toLowerCase();
    const filter = (agent: NamedAgent) =>
      !value ||
      [
        agent.name,
        agentAppearances.get(agent.endpoint.agent_id)?.name,
        agent.thread_title,
        agent.project_title,
        agent.description,
      ]
        .filter(Boolean)
        .some((part) => `${part}`.toLowerCase().includes(value));
    return {
      pinned: agentOrganization.groups.pinned.filter(filter),
      unpinned: agentOrganization.groups.unpinned.filter(filter),
      hidden: agentOrganization.groups.hidden.filter(filter),
    };
  }, [agentAppearances, agentOrganization.groups, search]);
  const recencySections = useMemo(
    () =>
      groupAgentsByRecency(
        visibleGroups.unpinned,
        agentOrganization.organization.lastOpened,
      ),
    [agentOrganization.organization.lastOpened, visibleGroups.unpinned],
  );

  const handleRegisteredThreadSelected = useCallback(
    (workspace: string, nextAgent: NamedAgent) => {
      setWorkspaceAgentIds((old) => {
        if (old.get(workspace) === nextAgent.endpoint.agent_id) return old;
        const next = new Map(old);
        next.set(workspace, nextAgent.endpoint.agent_id);
        return next;
      });
      const currentAgentId = redux.getStore("page")?.get("active_agent_id");
      if (currentAgentId === nextAgent.endpoint.agent_id) return;
      redux.getActions("page").setState({
        active_agent_id: nextAgent.endpoint.agent_id,
      });
      set_url(
        getPageUrlPath({
          page: "agents",
          agent_id: nextAgent.endpoint.agent_id,
        }),
      );
    },
    [],
  );

  function selectAgent(agent: NamedAgent) {
    mountAgent(agent);
    selectAgentId(agent.endpoint.agent_id);
    setMobileList(false);
  }

  function mountAgent(agent: NamedAgent) {
    const workspace = agentWorkspaceKey(agent);
    setMountedWorkspaces((old) => {
      if (old.has(workspace)) return old;
      const next = new Set(old);
      next.add(workspace);
      return next;
    });
    setWorkspaceAgentIds((old) => {
      if (old.get(workspace) === agent.endpoint.agent_id) return old;
      const next = new Map(old);
      next.set(workspace, agent.endpoint.agent_id);
      return next;
    });
  }

  function selectAgentId(agentId: string) {
    redux.getActions("page").setState({ active_agent_id: agentId });
    set_url(getPageUrlPath({ page: "agents", agent_id: agentId }));
  }

  function openCopyAgent(agent: NamedAgent) {
    setCopyingAgent(agent);
    setCopyName(suggestedAgentName(agents, accountId));
    setCopyError("");
  }

  async function copyAgent() {
    if (!copyingAgent || copyBusy) return;
    const problem = agentNameProblem(copyName, agents);
    if (problem) {
      setCopyError(problem);
      return;
    }
    setCopyBusy(true);
    setCopyError("");
    try {
      const actions = initChat(
        copyingAgent.endpoint.project_id,
        chatMetaFile(copyingAgent.path),
      );
      await waitForChatReady(actions);
      const threadId = await actions.forkThread({
        threadKey: copyingAgent.thread_id,
        title: copyName.trim(),
        sourceTitle: copyingAgent.thread_title || copyingAgent.name,
        isAI: true,
        selectNewThread: false,
      });
      await actions.syncdb?.save();
      writeAgentSubscriptionSelection({
        accountId,
        projectId: copyingAgent.endpoint.project_id,
        threadId,
        credentialId: readAgentSubscriptionSelection({
          accountId,
          projectId: copyingAgent.endpoint.project_id,
          threadId: copyingAgent.thread_id,
        }),
      });
      const locator = {
        project_id: copyingAgent.endpoint.project_id,
        path: copyingAgent.path,
        thread_id: threadId,
      };
      const api = personalAgentApi();
      let identity = await api.resolveIdentity(locator);
      if (!identity) {
        boundAccount.assertCurrent();
        identity = await api.registerIdentity(locator);
      }
      if (!identity) throw new Error("Unable to register the copied agent");
      await api.nameAgent({
        endpoint: {
          project_id: copyingAgent.endpoint.project_id,
          agent_id: identity.agent_id,
        },
        name: normalizeAgentName(copyName),
        description: "",
        ...cachedAgentNameContext(locator),
        project_title: copyingAgent.project_title,
        thread_title: copyName.trim(),
      });
      rememberAgentName(normalizeAgentName(copyName), accountId);
      refreshNamedAgents();
      setCopyingAgent(undefined);
      selectAgentId(identity.agent_id);
      antdMessage.success(`Copied @${copyingAgent.name} to @${copyName}.`);
    } catch (err) {
      setCopyError(`${err}`);
    } finally {
      setCopyBusy(false);
    }
  }

  function renderAgentRow(
    agent: NamedAgent,
    pinned: boolean,
    reorderable = true,
    hidden = false,
  ) {
    const active = agent.endpoint.agent_id === selected?.endpoint.agent_id;
    const id = agent.endpoint.agent_id;
    const appearance = agentAppearances.get(id);
    const theme = resolveNamedAgentTheme(agent, appearance);
    return (
      <div
        role="listitem"
        style={{
          alignItems: "center",
          background: active ? UI_COLORS.selected : "transparent",
          borderInlineStart: `3px solid ${theme.primaryColor ?? "transparent"}`,
          borderRadius: 6,
          display: "flex",
        }}
      >
        {reorderable ? (
          <DragHandle
            id={id}
            ariaLabel={`Drag @${agent.name} to reorder`}
            title="Drag to reorder"
            style={{
              alignItems: "center",
              cursor: "grab",
              display: "flex",
              flex: "0 0 auto",
              padding: "10px 6px",
            }}
          />
        ) : (
          <span aria-hidden style={{ flex: "0 0 26px" }} />
        )}
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          onClick={() => selectAgent(agent)}
          style={{
            alignItems: "center",
            background: "transparent",
            border: 0,
            color: UI_COLORS.text,
            cursor: "pointer",
            display: "flex",
            flex: 1,
            gap: 8,
            minWidth: 0,
            padding: "9px 4px",
            textAlign: "left",
          }}
        >
          <ThreadBadge
            icon={appearance?.thread_icon}
            color={theme.primaryColor}
            accentColor={theme.accentColor}
            image={appearance?.thread_image}
            fallbackIcon={
              theme.primaryColor ||
              theme.accentColor ||
              appearance?.thread_image
                ? undefined
                : "robot"
            }
            size={30}
          />
          <span style={{ minWidth: 0 }}>
            <Text strong ellipsis style={{ display: "block" }}>
              {theme.title}
            </Text>
            <Text type="secondary" ellipsis style={{ display: "block" }}>
              @{agent.name} · {agent.project_title || agent.endpoint.project_id}
            </Text>
          </span>
        </button>
        {!hidden && (
          <Button
            type="text"
            size="small"
            icon={
              <Icon
                name={pinned ? "pushpin-filled" : "pushpin"}
                style={{
                  color: pinned ? UI_COLORS.link : UI_COLORS.secondary,
                }}
              />
            }
            aria-label={`${pinned ? "Unpin" : "Pin"} @${agent.name}`}
            title={pinned ? "Unpin" : "Pin"}
            onClick={() => agentOrganization.setPinned(id, !pinned)}
          />
        )}
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              {
                key: "copy",
                icon: <Icon name="copy" />,
                label: "Copy agent…",
              },
              {
                key: hidden ? "show" : "hide",
                icon: <Icon name={hidden ? "eye" : "eye-slash"} />,
                label: hidden ? "Show in Agents" : "Hide from Agents",
              },
            ],
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation();
              if (key === "copy") {
                openCopyAgent(agent);
                return;
              }
              agentOrganization.setHidden(id, !hidden);
            },
          }}
        >
          <Button
            type="text"
            size="small"
            aria-label={`More actions for @${agent.name}`}
            title={`More actions for @${agent.name}`}
            icon={<Icon name="ellipsis-vertical" />}
          />
        </Dropdown>
      </div>
    );
  }

  function renderSortableAgentGroup(
    group: NamedAgent[],
    pinned: boolean,
    reorderable = true,
  ) {
    if (search.trim() || !reorderable) {
      return group.map((agent) => (
        <div key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}>
          {renderAgentRow(agent, pinned, false)}
        </div>
      ));
    }
    const ids = group.map(({ endpoint }) => endpoint.agent_id);
    return (
      <SortableList
        items={ids}
        onDragStop={(_oldIndex, newIndex, activeId) => {
          if (typeof activeId === "string") {
            agentOrganization.moveToIndex(activeId, newIndex);
          }
        }}
      >
        {group.map((agent) => (
          <SortableItem
            key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}
            id={agent.endpoint.agent_id}
            hideActive={false}
          >
            {renderAgentRow(agent, pinned)}
          </SortableItem>
        ))}
      </SortableList>
    );
  }

  if (loading && !directory) return <Loading theme="medium" />;
  const sidebar = (
    <aside
      id={AGENT_SIDEBAR_ID}
      aria-label="Agents"
      style={{
        background: UI_COLORS.inset,
        borderRight: `1px solid ${UI_COLORS.border}`,
        display: "flex",
        flex: 1,
        flexDirection: "column",
        height: "100%",
        boxSizing: "border-box",
        overflow: "hidden",
        minWidth: 0,
        padding: 12,
        ...(isNarrow && !mobileList ? { display: "none" } : {}),
      }}
    >
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <Button
          type="primary"
          block
          icon={<Icon name="plus" />}
          onClick={() => {
            setCreating(true);
            setMobileList(false);
          }}
        >
          New Agent
        </Button>
        <Input.Search
          allowClear
          aria-label="Search agents"
          placeholder="Search agents"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Segmented
          block
          aria-label="Agent ordering"
          options={[
            { label: "Recent", value: "recent" },
            { label: "Custom", value: "custom" },
          ]}
          value={agentOrganization.organization.mode}
          onChange={(value) =>
            agentOrganization.setMode(value as "recent" | "custom")
          }
        />
        {agentOrganization.saveError && (
          <Alert
            role="alert"
            type="error"
            showIcon
            title={agentOrganization.saveError}
          />
        )}
      </Space>
      <div
        role="list"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", marginTop: 12 }}
      >
        {visibleGroups.pinned.length > 0 && (
          <Text type="secondary" style={{ display: "block", padding: 6 }}>
            Pinned
          </Text>
        )}
        {renderSortableAgentGroup(visibleGroups.pinned, true)}
        {agentOrganization.organization.mode === "custom" ? (
          <>
            {visibleGroups.unpinned.length > 0 && (
              <Text type="secondary" style={{ display: "block", padding: 6 }}>
                Custom order
              </Text>
            )}
            {renderSortableAgentGroup(visibleGroups.unpinned, false)}
          </>
        ) : (
          recencySections.map((section) => (
            <div key={section.key}>
              <Text type="secondary" style={{ display: "block", padding: 6 }}>
                {section.title}
              </Text>
              {renderSortableAgentGroup(section.agents, false, false)}
            </div>
          ))
        )}
        {visibleGroups.hidden.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <Button
              type="text"
              block
              style={{ textAlign: "left" }}
              icon={<Icon name={showHidden ? "caret-down" : "caret-right"} />}
              aria-expanded={showHidden}
              onClick={() => setShowHidden((value) => !value)}
            >
              Hidden ({visibleGroups.hidden.length})
            </Button>
            {showHidden &&
              visibleGroups.hidden.map((agent) => (
                <div
                  key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}
                >
                  {renderAgentRow(agent, false, false, true)}
                </div>
              ))}
          </div>
        )}
      </div>
      <div
        style={{
          borderTop: `1px solid ${UI_COLORS.border}`,
          flex: "0 0 auto",
          paddingTop: 8,
        }}
      >
        <AgentsAccountMenu />
      </div>
    </aside>
  );
  return (
    <main
      ref={rootRef}
      aria-label="Agents workspace"
      style={{
        background: UI_COLORS.page,
        color: UI_COLORS.text,
        display: "flex",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {isNarrow ? (
        sidebar
      ) : (
        <div
          style={{
            display: agentSidebarHidden ? "none" : "block",
            flex: "0 0 auto",
            height: "100%",
          }}
        >
          <Resizable
            size={{ width: agentSidebarWidth, height: "100%" }}
            enable={{ right: true }}
            minWidth={MIN_AGENT_SIDEBAR_WIDTH}
            maxWidth={MAX_AGENT_SIDEBAR_WIDTH}
            handleStyles={{
              right: {
                width: "6px",
                right: "-3px",
                cursor: "col-resize",
                background: "transparent",
                zIndex: 2,
              },
            }}
            handleComponent={{
              right: (
                <div
                  aria-label="Resize Agents panel"
                  style={{ width: "100%", height: "100%" }}
                />
              ),
            }}
            onResizeStop={(_, __, ___, delta) => {
              const width = Math.min(
                MAX_AGENT_SIDEBAR_WIDTH,
                Math.max(
                  MIN_AGENT_SIDEBAR_WIDTH,
                  agentSidebarWidth + delta.width,
                ),
              );
              setAgentSidebarWidth(width);
              window.localStorage.setItem(
                AGENT_SIDEBAR_WIDTH_STORAGE_KEY,
                `${width}`,
              );
            }}
          >
            {sidebar}
          </Resizable>
        </div>
      )}
      <section
        aria-label={selected ? `Agent @${selected.name}` : "Agent workspace"}
        style={{
          flex: 1,
          minWidth: 0,
          position: "relative",
          ...(isNarrow && mobileList ? { display: "none" } : {}),
        }}
      >
        {active &&
          (creating ||
            !!error ||
            agents.length === 0 ||
            !selected ||
            !mountedWorkspaces.has(agentWorkspaceKey(selected))) && (
            <div
              style={{
                alignItems: "center",
                display: "flex",
                justifyContent: "space-between",
                left: 8,
                position: "absolute",
                right: 12,
                top: 6,
                zIndex: 3,
              }}
            >
              {!isNarrow ? (
                <AgentsSidebarToggle
                  hidden={agentSidebarHidden}
                  onToggle={toggleAgentSidebar}
                />
              ) : (
                <span />
              )}
              <AgentsWorkspaceNavigation />
            </div>
          )}
        {creating || agents.length === 0 ? (
          <NewAgentPanel
            agents={agents}
            namedAgentDirectory={directory}
            sourceAgent={selected}
            onCancel={() => {
              setCreating(false);
              setMobileList(true);
            }}
            onCreated={(agentId) => {
              const agent = agents.find(
                ({ endpoint }) => endpoint.agent_id === agentId,
              );
              if (agent) mountAgent(agent);
              selectAgentId(agentId);
              setCreating(false);
            }}
          />
        ) : error ? (
          <Alert
            type="error"
            showIcon
            title="Unable to load agents"
            description={error}
            action={
              <Button onClick={refreshNamedAgents}>Retry directory</Button>
            }
          />
        ) : agents.length === 0 ? (
          <Empty
            style={{ marginTop: 80 }}
            description="Name an agent chat to make it available here."
          >
            <Button
              type="link"
              onClick={() => openAccountSettings({ page: "my-agents" })}
            >
              Manage named agents
            </Button>
          </Empty>
        ) : !selected ? (
          <Empty
            style={{ marginTop: 80 }}
            description="This registered agent is not available in your directory."
          >
            <Space>
              <Button onClick={refreshNamedAgents}>Refresh directory</Button>
              <Button onClick={() => setMobileList(true)}>
                Choose an agent
              </Button>
            </Space>
          </Empty>
        ) : (
          <>
            {[...mountedWorkspaces].map((workspace) => {
              const workspaceAgents = agents.filter(
                (agent) => agentWorkspaceKey(agent) === workspace,
              );
              const agent =
                workspaceAgents.find(
                  ({ endpoint }) =>
                    endpoint.agent_id === workspaceAgentIds.get(workspace),
                ) ?? workspaceAgents[0];
              if (!agent) return null;
              return (
                <AgentWorkspace
                  key={workspace}
                  workspaceKey={workspace}
                  agent={agent}
                  workspaceAgents={workspaceAgents}
                  accountId={accountId}
                  active={
                    active &&
                    !!selected &&
                    agentWorkspaceKey(selected) === workspace
                  }
                  onRegisteredThreadSelected={handleRegisteredThreadSelected}
                  onShowList={isNarrow ? () => setMobileList(true) : undefined}
                  agentSidebarHidden={isNarrow ? undefined : agentSidebarHidden}
                  onToggleAgentSidebar={
                    isNarrow ? undefined : toggleAgentSidebar
                  }
                  onAgentActivity={agentOrganization.recordActivity}
                  agentAppearances={agentAppearances}
                  onAgentAppearance={handleAgentAppearance}
                  onClose={() => {
                    setMountedWorkspaces((old) => {
                      const next = new Set(old);
                      next.delete(workspace);
                      return next;
                    });
                    if (isNarrow) setMobileList(true);
                  }}
                />
              );
            })}
            {!mountedWorkspaces.has(agentWorkspaceKey(selected)) && (
              <Empty
                style={{ marginTop: 80 }}
                description={`Workspace for @${selected.name} is closed.`}
              >
                <Button type="primary" onClick={() => mountAgent(selected)}>
                  Open workspace
                </Button>
              </Empty>
            )}
          </>
        )}
      </section>
      <Modal
        title={`Copy @${copyingAgent?.name ?? "agent"}`}
        open={!!copyingAgent}
        okText="Copy agent"
        okButtonProps={{
          loading: copyBusy,
          disabled: copyBusy || !!agentNameProblem(copyName, agents),
        }}
        cancelButtonProps={{ disabled: copyBusy }}
        destroyOnHidden
        onOk={() => void copyAgent()}
        onCancel={() => {
          setCopyingAgent(undefined);
          setCopyError("");
        }}
      >
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Text>
            Copy the complete conversation and Codex context into a new named
            agent. Project, working directory, model, reasoning, and payment
            source are preserved. The description starts blank.
          </Text>
          <AgentNameInput
            id="copy-agent-name"
            value={copyName}
            onChange={setCopyName}
            problem={
              copyName.trim() ? agentNameProblem(copyName, agents) : undefined
            }
            busy={copyBusy}
            onEnter={() => void copyAgent()}
          />
          {copyError && (
            <Alert role="alert" type="error" showIcon title={copyError} />
          )}
        </Space>
      </Modal>
    </main>
  );
}
