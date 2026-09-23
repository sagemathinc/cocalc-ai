/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  normalizeAgentName,
  type AgentNetwork,
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
import { requestThreadSearch } from "@cocalc/frontend/chat/thread-search-request";
import { AgentSearch } from "./search";
import { AgentArtifactBrowser } from "./artifact-browser";
import { LibraryEntry } from "./library-entry";
import { closedLibraryState, openLibrary } from "./library-navigation";
import type { ForeignArtifactTarget } from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import { agentSearchStore } from "./search-state";
import { agentMessageFragment } from "./message-fragment";
import type { AgentSearchHit } from "./search-runner";
import { ChatEmbeddingOptionsProvider } from "@cocalc/frontend/chat/embedding-options";
import { ThreadBadge } from "@cocalc/frontend/chat/thread-badge";
import { ThreadImageUpload } from "@cocalc/frontend/chat/thread-image-upload";
import { AgentFileAttachment } from "@cocalc/frontend/chat/agent-file-attachment";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import { writeChatComposerDraft } from "@cocalc/frontend/chat/use-chat-composer-draft";
import { stableDraftKeyFromThreadKey } from "@cocalc/frontend/chat/utils";
import { set_url } from "@cocalc/frontend/history";
import { getPageUrlPath } from "@cocalc/frontend/page-routing";
import { useWorkspaceRoute } from "./use-workspace-route";
import { lite } from "@cocalc/frontend/lite";
import { useNavigationIntent } from "./use-navigation-intent";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import {
  ProjectContext,
  useProjectContextProvider,
} from "@cocalc/frontend/project/context";
import { EmbeddedProjectFile } from "@cocalc/frontend/project/page/content";
import { ProjectDocsPanel } from "@cocalc/frontend/project/page/flyouts/docs";
import {
  PROJECT_DOCS_OPEN_EVENT,
  type ProjectDocsOpenDetail,
} from "@cocalc/frontend/docs/navigation";
import { Icon, Loading, ThemeEditorModal } from "@cocalc/frontend/components";
import { WorkspaceSidebarActions } from "./workspace-sidebar-actions";
import "./workspace-sidebar-row.css";
import { AgentOrganizationControls } from "./organization-controls";
import { AgentsSidebarResizeHandle } from "./sidebar-resize-handle";
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
  Drawer,
  Dropdown,
  Empty,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Tag,
  Typography,
  message as antdMessage,
} from "antd";
import { openAgentThread } from "./open-agent";
import {
  personalAgentApi,
  refreshAgentNetworks,
  refreshNamedAgents,
  useAgentNetworks,
  useNamedAgents,
} from "./api";
import { AgentNetworkPills } from "./agent-network-pills";
import {
  readAgentNetworkFilter,
  rememberAgentNetworkFilter,
} from "./agent-network-filter";
import {
  AgentNetworkDetailsModal,
  AgentNetworkFilterBar,
} from "./agent-network-details-modal";
import { AgentNameInput, agentNameProblem } from "./agent-name-input";
import { CopyAgentModal } from "./copy-agent-modal";
import { FreshConversationModal } from "./fresh-conversation-modal";
import { cachedAgentNameContext } from "./name-context";
import { useBoundAgentAccount } from "./use-bound-account";
import { useAgentWorkspaceOrganization } from "./use-workspace-organization";
import {
  groupAgentsByProject,
  groupAgentsByRecency,
} from "./workspace-organization";
import { AgentLoadingPreview } from "./loading-preview";
import { NameAgent } from "./name-agent";
import { AgentsAccountMenu } from "./account-menu";
import { AgentRunningIndicator } from "./agent-running-indicator";
import { AgentProjectStatus } from "./project-status";
import {
  AGENT_SIDEBAR_ID,
  AgentsSidebarToggle,
} from "./workspace-sidebar-toggle";
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
import { namedAgentExecutionState } from "./agent-execution-state";
import {
  readAgentSubscriptionSelection,
  writeAgentSubscriptionSelection,
} from "./agent-subscription-selection";
import {
  assertAgentWorkingDirectory,
  createAgentWorkingDirectory,
  effectiveNewAgentWorkingDirectory,
  MissingAgentWorkingDirectoryError,
  relativeAgentWorkingDirectory,
} from "./workspace-path";

const { Text, Title } = Typography;

const DEFAULT_AGENT_SIDEBAR_WIDTH = 280;
const MIN_AGENT_SIDEBAR_WIDTH = 220;
const MAX_AGENT_SIDEBAR_WIDTH = 600;
const AGENT_SIDEBAR_WIDTH_STORAGE_KEY = "cocalc-agents-sidebar-width-v1";
const AGENT_SIDEBAR_HIDDEN_STORAGE_KEY = "cocalc-agents-sidebar-hidden-v1";
const AGENT_DOCS_DRAWER_OPEN_STORAGE_KEY = "cocalc-agents-docs-drawer-open-v1";
const AGENT_DOCS_DRAWER_WIDTH_STORAGE_KEY =
  "cocalc-agents-docs-drawer-width-v1";
const DEFAULT_AGENT_DOCS_DRAWER_WIDTH = 720;
const MIN_AGENT_DOCS_DRAWER_WIDTH = 360;

function networksForAgent(networks: AgentNetwork[], agent: NamedAgent) {
  return networks.filter(
    (network) =>
      network.state !== "closed" &&
      network.members.some(
        (member) =>
          member.kind === "registered" &&
          !member.removed_at &&
          member.endpoint.project_id === agent.endpoint.project_id &&
          member.endpoint.agent_id === agent.endpoint.agent_id,
      ),
  );
}

function clampAgentDocsDrawerWidth(width: number): number {
  const maximum =
    typeof window === "undefined" ? 960 : Math.max(320, window.innerWidth - 32);
  const minimum = Math.min(MIN_AGENT_DOCS_DRAWER_WIDTH, maximum);
  return Math.min(maximum, Math.max(minimum, width));
}

function initialAgentDocsDrawerWidth(): number {
  if (typeof window === "undefined") return DEFAULT_AGENT_DOCS_DRAWER_WIDTH;
  try {
    const stored = Number(
      window.localStorage.getItem(AGENT_DOCS_DRAWER_WIDTH_STORAGE_KEY),
    );
    return Number.isFinite(stored) && stored > 0
      ? clampAgentDocsDrawerWidth(stored)
      : clampAgentDocsDrawerWidth(DEFAULT_AGENT_DOCS_DRAWER_WIDTH);
  } catch {
    return clampAgentDocsDrawerWidth(DEFAULT_AGENT_DOCS_DRAWER_WIDTH);
  }
}

function rememberAgentDocsDrawerWidth(width: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    AGENT_DOCS_DRAWER_WIDTH_STORAGE_KEY,
    `${clampAgentDocsDrawerWidth(width)}`,
  );
}

function initialAgentDocsDrawerOpen(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.localStorage.getItem(AGENT_DOCS_DRAWER_OPEN_STORAGE_KEY) === "true"
  );
}

function rememberAgentDocsDrawerOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AGENT_DOCS_DRAWER_OPEN_STORAGE_KEY, `${open}`);
}

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

const NEW_AGENT_BOOTSTRAP_INSTANCE_KEY = "agents-workspace-new-agent";
const COPY_AGENT_BOOTSTRAP_INSTANCE_KEY = "agents-workspace-copy-agent";

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
  const [directoryProjectId, setDirectoryProjectId] = useState(projectId);
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
  const firstRequestRef = useRef<() => string>(() => "");
  const [directorySelectorOpen, setDirectorySelectorOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<
    CodexModelCapabilityInfo[] | undefined
  >();
  const [pending, setPending] = useState<PendingAgent>();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [missingDirectory, setMissingDirectory] = useState<{
    path: string;
    projectId: string;
  }>();
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
      const home = getProjectHomeDirectory(preferred);
      setDirectory(home);
      setDirectoryProjectId(preferred);
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
    const projectHome = getProjectHomeDirectory(targetProjectId);
    const workingDirectory =
      directoryProjectId === targetProjectId
        ? directory.trim() || projectHome
        : projectHome;
    await assertAgentWorkingDirectory(fs, workingDirectory);
    const path = joinAbsolutePath(
      getProjectHomeDirectory(targetProjectId),
      `.local/share/cocalc/agents/${uuid()}.chat`,
    );
    await projectActions.ensureContainingDirectoryExists(path);
    await fs.writeFile(path, "");
    const chatActions = initChat(targetProjectId, path, {
      instanceKey: NEW_AGENT_BOOTSTRAP_INSTANCE_KEY,
    });
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
    await chatActions.save_to_disk();
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

  async function create(requestValue?: string) {
    const request = (requestValue ?? firstRequestRef.current()).trim();
    if (busy || uploading || problem || atLimit || !request) return;
    setBusy(true);
    setError("");
    setMissingDirectory(undefined);
    try {
      await submitNewAgentRequest(request);
    } catch (err) {
      handleCreateError(err);
      if (isNamedAgentLimitError(err)) refreshNamedAgents();
    } finally {
      setBusy(false);
    }
  }

  async function submitNewAgentRequest(request: string): Promise<void> {
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
    const actions = initChat(created.projectId, created.path, {
      instanceKey: NEW_AGENT_BOOTSTRAP_INSTANCE_KEY,
    });
    await waitForChatReady(actions);
    const sent = actions.sendChat({
      input: request,
      reply_thread_id: created.threadId,
      acpConfigOverride: config,
    });
    if (sent) {
      await actions.syncdb?.save();
      await actions.save_to_disk();
    } else {
      await writeChatComposerDraft({
        account_id: boundAccount.accountId,
        project_id: created.projectId,
        path: created.path,
        composerDraftKey: stableDraftKeyFromThreadKey(created.threadId),
        text: request,
      });
      antdMessage.warning(
        "The agent was created, but the first request could not start. It is preserved as a draft.",
      );
    }
    rememberAgentName(normalizeAgentName(name), boundAccount.accountId);
    refreshNamedAgents();
    onCreated(identity.agent_id);
  }

  function handleCreateError(err: unknown): void {
    if (err instanceof MissingAgentWorkingDirectoryError && projectId) {
      setMissingDirectory({ path: err.path, projectId });
      setError("");
      return;
    }
    setError(
      isNamedAgentLimitError(err)
        ? "Your membership's named-agent limit was reached."
        : `${err}`,
    );
  }

  async function createMissingDirectoryAndContinue(): Promise<void> {
    if (!missingDirectory || busy) return;
    const request = firstRequestRef.current().trim();
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      await ensureProjectReduxRuntime();
      const fs = redux.getProjectActions(missingDirectory.projectId)?.fs?.();
      if (!fs) {
        throw new Error("The selected project filesystem is unavailable");
      }
      await createAgentWorkingDirectory(fs, missingDirectory.path);
      setMissingDirectory(undefined);
      await submitNewAgentRequest(request);
    } catch (err) {
      handleCreateError(err);
    } finally {
      setBusy(false);
    }
  }

  const projectTitle = projectId
    ? ((projectMap?.getIn([projectId, "title"]) as string | undefined) ??
      "Project")
    : "New project";
  const projectHome = projectId ? getProjectHomeDirectory(projectId) : "";
  const effectiveDirectory = effectiveNewAgentWorkingDirectory({
    projectId,
    directoryProjectId,
    directory,
    projectHome,
  });
  const directoryLabel =
    relativeAgentWorkingDirectory(effectiveDirectory, projectHome) ??
    (effectiveDirectory || "~/");
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
            setMissingDirectory(undefined);
            setError("");
            setProjectId(nextProjectId);
            const home = getProjectHomeDirectory(nextProjectId);
            setDirectory(home);
            setDirectoryProjectId(nextProjectId);
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
            value={effectiveDirectory}
            disabled={busy || !!pending}
            onChange={(event) => {
              setMissingDirectory(undefined);
              setError("");
              setDirectory(event.target.value);
              setDirectoryProjectId(projectId);
            }}
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
          <div inert={busy ? true : undefined}>
            <MarkdownInput
              project_id={projectId}
              cacheId={`new-agent:${boundAccount.accountId ?? "account"}`}
              value={firstRequest}
              getValueRef={firstRequestRef}
              onChange={setFirstRequest}
              onShiftEnter={(value) => void create(value)}
              onCtrlEnter={() => undefined}
              autoFocus
              autoGrow
              autoGrowMinHeight={128}
              autoGrowMaxHeight={420}
              enableUpload
              onUploadStart={() => setUploading(true)}
              onUploadEnd={() => setUploading(false)}
              hideHelp
              modeSwitchPlacement="toolbar"
              reserveModeSwitchSpace
              undoMode="local"
              redoMode="local"
              placeholder="Ask your agent to build, research, debug, or explain…"
              style={{ fontSize: 16 }}
            />
          </div>
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
            {projectId ? (
              <AgentFileAttachment
                projectId={projectId}
                workingDirectory={effectiveDirectory}
                disabled={busy || !!pending}
                onInsert={(markdown) =>
                  setFirstRequest(
                    (current) =>
                      `${current}${current && !/\s$/.test(current) ? " " : ""}${markdown}`,
                  )
                }
              />
            ) : (
              <Button
                aria-label="Add files and more"
                disabled
                icon={<Icon name="plus" />}
                shape="circle"
                style={{ height: 32, minWidth: 32, width: 32 }}
                title="Choose a project before adding files"
                type="text"
              />
            )}
            <Popover
              content={advancedSettings}
              open={settingsOpen}
              placement="bottomLeft"
              trigger="click"
              onOpenChange={setSettingsOpen}
            >
              <Button
                icon={<Icon name="folder-open" />}
                style={{ height: "auto", maxWidth: 280, overflow: "hidden" }}
                title={`${projectTitle} / ${effectiveDirectory}`}
              >
                <span
                  style={{
                    alignItems: "flex-start",
                    display: "flex",
                    flexDirection: "column",
                    lineHeight: 1.25,
                    minWidth: 0,
                    overflow: "hidden",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {projectTitle}
                  </span>
                  <span
                    style={{
                      color: UI_COLORS.secondary,
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {directoryLabel}
                  </span>
                </span>
              </Button>
            </Popover>
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
              shape="circle"
              aria-label="Start agent"
              title="Start agent (Shift+Enter)"
              icon={<Icon name="arrow-up" />}
              style={{ height: 32, minWidth: 32, width: 32 }}
              loading={busy}
              disabled={
                uploading || !!problem || !firstRequest.trim() || atLimit
              }
              onClick={() => void create()}
            />
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
          <Space size={4} wrap>
            <Button
              type="link"
              size="small"
              aria-label={`Change agent name @${name}`}
              disabled={busy || !!pending}
              style={{ height: "auto", padding: 0 }}
              onClick={() => setNameOpen(true)}
            >
              @{name}
            </Button>
            <Text type="secondary">
              · {paymentLabel} · Shift+Enter to start
            </Text>
          </Space>
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
        {error && <Alert role="alert" type="error" title={error} />}
        {missingDirectory && (
          <Alert
            role="alert"
            type="error"
            showIcon
            title={`Working directory ${JSON.stringify(missingDirectory.path)} does not exist in the selected project.`}
            description={
              <span>
                Choose an existing directory or{" "}
                <Button
                  type="link"
                  size="small"
                  loading={busy}
                  style={{ height: "auto", padding: 0 }}
                  onClick={() => void createMissingDirectoryAndContinue()}
                >
                  create this directory
                </Button>
                .
              </span>
            }
          />
        )}
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
            startingPath={effectiveDirectory}
            allowAbsolutePaths
            closable={false}
            onSelect={(path) => {
              setMissingDirectory(undefined);
              setError("");
              setDirectory(path);
              setDirectoryProjectId(projectId);
              setDirectorySelectorOpen(false);
            }}
          />
        )}
      </Modal>
      <Modal
        open={nameOpen}
        title="Agent name"
        okText="Done"
        okButtonProps={{ disabled: !!problem }}
        cancelButtonProps={{ style: { display: "none" } }}
        onOk={() => setNameOpen(false)}
        onCancel={() => setNameOpen(false)}
      >
        <AgentNameInput
          id="new-agent-name-dialog"
          value={name}
          onChange={setName}
          problem={name.trim() ? problem : undefined}
          busy={busy || !!pending}
          onEnter={() => {
            if (!problem) setNameOpen(false);
          }}
        />
      </Modal>
    </div>
  );
}

function AgentProjectContext({
  selectedNetworkId,
  showEditorControls,
  agent,
  workspaceAgents,
  active,
  accountId,
  onSelectedThread,
  onAgentActivity,
  onThreadAppearance,
  onChatActions,
  onClose,
  onOpenDocs,
}: {
  selectedNetworkId?: string;
  showEditorControls: boolean;
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
  onClose: () => void;
  onOpenDocs: () => void;
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
    const openFragment = () => {
      const fragment = Fragment.get();
      const chat = agentMessageFragment(fragment, agent.thread_id);
      if (typeof editorActions?.gotoFragment === "function") {
        void editorActions.gotoFragment({ thread: agent.thread_id, chat });
      } else {
        redux
          .getProjectActions(agent.endpoint.project_id)
          ?.gotoFragment(agent.path, { thread: agent.thread_id });
      }
    };
    openFragment();
    window.addEventListener("hashchange", openFragment);
    window.addEventListener("popstate", openFragment);
    return () => {
      window.removeEventListener("hashchange", openFragment);
      window.removeEventListener("popstate", openFragment);
    };
  }, [active, agent.endpoint.project_id, agent.path, agent.thread_id, ready]);

  useEffect(() => {
    if (!active || !ready || !selectedThread) return;
    if (requestedThreadRef.current) {
      if (selectedThread !== requestedThreadRef.current) return;
      requestedThreadRef.current = undefined;
    }
    onSelectedThread(selectedThread);
  }, [active, onSelectedThread, ready, selectedThread]);

  useEffect(() => {
    if (!ready) return;
    const editorActions: any = redux.getEditorActions(
      agent.endpoint.project_id,
      agent.path,
    );
    if (typeof editorActions?.setEmbeddedCloseHandler !== "function") return;
    editorActions.setEmbeddedCloseHandler(active ? onClose : undefined);
    return () => {
      if (active) editorActions.setEmbeddedCloseHandler(undefined);
    };
  }, [active, agent.endpoint.project_id, agent.path, onClose, ready]);

  useEffect(() => {
    if (!active) return;
    const handleOpenDocs = (event: Event) => {
      const detail = (event as CustomEvent<ProjectDocsOpenDetail>).detail;
      if (detail?.projectId !== agent.endpoint.project_id) return;
      event.preventDefault();
      onOpenDocs();
    };
    window.addEventListener(PROJECT_DOCS_OPEN_EVENT, handleOpenDocs);
    return () =>
      window.removeEventListener(PROJECT_DOCS_OPEN_EVENT, handleOpenDocs);
  }, [active, agent.endpoint.project_id, onOpenDocs]);

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
      <ChatEmbeddingOptionsProvider
        value={{
          agentWorkspace: true,
          agentWorkspaceActive: active,
          onSearchAll: () => {
            if (accountId) agentSearchStore(accountId).set({ open: true });
          },
          onBrowseAllArtifacts: () => {
            if (accountId) openLibrary();
          },
          selectedNetworkId,
          disableConversationFocus: true,
          hideSingleFrameToolbar: !showEditorControls,
          hideTopControls: false,
          hideCompactThreadHeader: true,
          hideComposerIdentity: true,
          openFilesInWorkbench: true,
          sidebarHiddenByDefault: true,
          sidebarPreferenceKey: `cocalc:agents:chat-sidebar-hidden:${agent.account_id}:${agent.endpoint.agent_id}`,
        }}
      >
        <EmbeddedProjectFile path={agent.path} isVisible={active} />
      </ChatEmbeddingOptionsProvider>
    </ProjectContext.Provider>
  );
}

function AgentsWorkspaceNavigation({
  onOpenInProject,
  foregroundColor,
  workspaceItems,
  onOpenDocs,
}: {
  onOpenInProject?: () => void;
  foregroundColor?: string;
  workspaceItems?: import("antd").MenuProps["items"];
  onOpenDocs?: () => void;
} = {}) {
  const { pageStyle } = useAppContext();
  const accountId = useTypedRedux("account", "account_id");
  return (
    <CompactAgentsTopNav
      isLoggedIn={!!accountId}
      pageStyle={pageStyle}
      onOpenInProject={onOpenInProject}
      foregroundColor={foregroundColor}
      workspaceItems={workspaceItems}
      onOpenDocs={onOpenDocs}
    />
  );
}

function AgentWorkspace({
  onCopy,
  onFresh,
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
  networks,
  selectedNetworkId,
  onSelectNetwork,
  onOpenNetwork,
}: {
  onCopy: (agent: NamedAgent) => void;
  onFresh: (agent: NamedAgent) => void;
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
  networks: AgentNetwork[];
  selectedNetworkId?: string;
  onSelectNetwork: (network: AgentNetwork) => void;
  onOpenNetwork: (network: AgentNetwork) => void;
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
  const [docsOpen, setDocsOpen] = useState(initialAgentDocsDrawerOpen);
  const [docsDrawerWidth, setDocsDrawerWidth] = useState(
    initialAgentDocsDrawerWidth,
  );
  const [showEditorControls, setShowEditorControls] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [, setChatVersion] = useState(0);
  const repairedLegacyThreads = useRef<Set<string>>(new Set());
  const openDocs = useCallback(() => {
    setDocsOpen(true);
    rememberAgentDocsDrawerOpen(true);
  }, []);
  const closeDocs = useCallback(() => {
    setDocsOpen(false);
    rememberAgentDocsDrawerOpen(false);
  }, []);
  useEffect(() => {
    const syncdb = chatActions?.syncdb;
    if (!syncdb) return;
    const changed = () => setChatVersion((version) => version + 1);
    syncdb.on("change", changed);
    syncdb.on("ready", changed);
    return () => {
      syncdb.removeListener("change", changed);
      syncdb.removeListener("ready", changed);
    };
  }, [chatActions]);
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
  const selectedThreadConfig = selectedThreadMetadata?.acp_config as
    | CodexThreadConfig
    | undefined;
  const executionState =
    chatActions && selectedThread && !unregistered
      ? namedAgentExecutionState(selectedThreadMetadata ?? {})
      : undefined;
  const selectedWorkingDirectory =
    (selectedThreadConfig as any)?.get?.("workingDirectory") ??
    selectedThreadConfig?.workingDirectory;
  const workingDirectoryLabel = relativeAgentWorkingDirectory(
    selectedWorkingDirectory,
    getProjectHomeDirectory(agent.endpoint.project_id),
  );
  const canRegisterSelectedThread =
    !!unregistered && selectedThreadMetadata?.agent_kind === "acp";
  const enableSelectedAgent = useCallback(
    (showNotice = true) => {
      if (!chatActions || !selectedThread) return;
      const defaults = getDefaultCodexNewChatDefaults();
      chatActions.setCodexConfig(selectedThread, {
        ...defaults,
        allowWrite: defaults.sessionMode !== "read-only",
        workingDirectory: getProjectHomeDirectory(agent.endpoint.project_id),
      });
      if (showNotice) antdMessage.success("Agent execution enabled.");
    },
    [agent.endpoint.project_id, chatActions, selectedThread],
  );
  useEffect(() => {
    if (
      !active ||
      executionState !== "legacy-missing" ||
      !selectedThread ||
      repairedLegacyThreads.current.has(selectedThread)
    ) {
      return;
    }
    repairedLegacyThreads.current.add(selectedThread);
    enableSelectedAgent(false);
  }, [active, enableSelectedAgent, executionState, selectedThread]);
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
  const runFrameAction = (action: "terminal" | "show_search") => {
    const editor = redux.getEditorActions(
      agent.endpoint.project_id,
      agent.path,
    );
    const id =
      editor?._get_most_recent_active_frame_id_of_type("chatroom") ??
      editor?._get_active_id();
    if (editor && id) void editor[action](id);
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
        <div
          style={{
            minWidth: 0,
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 0,
          }}
        >
          <Button
            type="text"
            aria-label={`Edit thread title: ${title}`}
            title={title}
            onClick={openAppearanceEditor}
            style={{
              color: "inherit",
              fontSize: 16,
              fontWeight: 600,
              height: "auto",
              padding: 0,
              justifyContent: "flex-start",
              minWidth: 0,
              maxWidth: "100%",
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {title}
            </span>
          </Button>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
              width: "100%",
              flexWrap: "wrap",
              fontSize: 12,
            }}
          >
            {!unregistered ? (
              <NameAgent
                agent={displayedAgent}
                projectId={agent.endpoint.project_id}
                path={agent.path}
                threadId={selectedThread}
                threadTitle={title}
                projectTitle={agent.project_title}
                triggerLabel={`@${displayedAgent.name}`}
                triggerButtonProps={{
                  type: "text",
                  title: displayedAgent.description || title,
                  style: {
                    color: "inherit",
                    fontSize: 12,
                    height: "auto",
                    padding: 0,
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                }}
              />
            ) : (
              <Text style={{ color: "inherit" }}>Unregistered thread</Text>
            )}
            {!unregistered && networks.length > 0 && (
              <AgentNetworkPills
                networks={networks}
                maxVisible={2}
                selectedNetworkId={selectedNetworkId}
                onSelect={onSelectNetwork}
                onOpen={onOpenNetwork}
              />
            )}
            <span aria-hidden="true">·</span>
            <AgentProjectStatus agent={agent} active={active} />
            {workingDirectoryLabel && (
              <Button
                type="text"
                aria-label={`Change working directory: ${workingDirectoryLabel}`}
                title={`${displayedAgent.project_title || agent.endpoint.project_id}: ${selectedWorkingDirectory}`}
                onClick={() => setDirectoryOpen(true)}
                style={{
                  color: "inherit",
                  textAlign: "left",
                  flex: "1 1 180px",
                  justifyContent: "flex-start",
                  minWidth: 0,
                  padding: 0,
                  height: "auto",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {workingDirectoryLabel}
                </span>
              </Button>
            )}
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
            onOpenDocs={openDocs}
            workspaceItems={[
              {
                key: "workspace-terminal",
                label: "Open terminal",
                icon: <Icon name="terminal" />,
                onClick: () => runFrameAction("terminal"),
              },
              {
                key: "workspace-find",
                label: "Find in conversation",
                icon: <Icon name="search" />,
                onClick: () =>
                  requestThreadSearch(
                    agent.endpoint.project_id,
                    agent.path,
                    selectedThread || agent.thread_id,
                  ),
              },
              {
                key: "workspace-appearance",
                label: "Appearance",
                icon: <Icon name="sun" />,
                onClick: openAppearanceEditor,
              },
              ...(!unregistered
                ? [
                    {
                      key: "workspace-copy",
                      label: "Copy agent",
                      icon: <Icon name="copy" />,
                      onClick: () => onCopy(displayedAgent),
                    },
                    {
                      key: "workspace-fresh",
                      label: "Start fresh conversation…",
                      icon: <Icon name="plus-circle" />,
                      onClick: () => onFresh(displayedAgent),
                    },
                  ]
                : []),
              {
                key: "workspace-collaborators",
                label: sharing ?? "Collaborators",
                icon: <Icon name="users" />,
                onClick: () => openProject("settings", "people"),
              },
              {
                key: "workspace-controls",
                icon: <Icon name="sliders" />,
                label: showEditorControls
                  ? "Hide editor controls"
                  : "Show editor controls",
                onClick: () => setShowEditorControls((value) => !value),
              },
              {
                key: "workspace-close",
                label: "Close workbench",
                icon: <Icon name="times" />,
                onClick: onClose,
              },
              { type: "divider" },
            ]}
            onOpenInProject={() =>
              void openAgentThread({
                project_id: agent.endpoint.project_id,
                path: agent.path,
                thread_id: selectedThread || agent.thread_id,
              })
            }
          />
        )}
      </header>
      <Modal
        title="Working directory"
        open={directoryOpen}
        footer={null}
        onCancel={() => setDirectoryOpen(false)}
        destroyOnHidden
      >
        <DirectorySelector
          allowAbsolutePaths
          style={{ width: "100%" }}
          project_id={agent.endpoint.project_id}
          startingPath={selectedWorkingDirectory}
          onSelect={(workingDirectory) => {
            chatActions?.setCodexConfig(selectedThread, { workingDirectory });
            setDirectoryOpen(false);
          }}
        />
      </Modal>
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
      {!unregistered && executionState === "disabled" && (
        <Alert
          showIcon
          type="warning"
          title="Agent execution is disabled"
          description="This named agent cannot run turns or receive Agent Network messages until agent execution is enabled."
          action={
            <Button type="primary" onClick={() => enableSelectedAgent()}>
              Enable agent
            </Button>
          }
        />
      )}
      {!unregistered && executionState === "legacy-missing" && (
        <Alert
          showIcon
          type="info"
          title="Repairing agent configuration"
          description="This named agent has incomplete legacy execution settings. CoCalc is restoring them from your current agent defaults."
          action={
            <Button onClick={() => enableSelectedAgent()}>Enable now</Button>
          }
        />
      )}
      <div style={{ position: "relative", minHeight: 0, flex: 1 }}>
        <AgentProjectContext
          selectedNetworkId={selectedNetworkId}
          showEditorControls={showEditorControls}
          agent={agent}
          workspaceAgents={workspaceAgents}
          active={active}
          accountId={accountId}
          onSelectedThread={handleSelectedThread}
          onAgentActivity={onAgentActivity}
          onChatActions={setChatActions}
          onClose={onClose}
          onOpenDocs={openDocs}
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
      <Drawer
        destroyOnHidden={false}
        open={active && docsOpen}
        placement="right"
        title="Documentation"
        size={docsDrawerWidth}
        resizable={{
          onResize: (width) => {
            const next = clampAgentDocsDrawerWidth(width);
            setDocsDrawerWidth(next);
            try {
              rememberAgentDocsDrawerWidth(next);
            } catch {
              // Resizing still works when localStorage is unavailable.
            }
          },
        }}
        onClose={closeDocs}
        styles={{ body: { overflow: "auto", padding: "12px 0 0 14px" } }}
      >
        <ProjectDocsPanel
          layout="flyout"
          project_id={agent.endpoint.project_id}
        />
      </Drawer>
    </div>
  );
}

export function MyAgentsWorkspacePage({ active = true }: { active?: boolean }) {
  const { pageStyle } = useAppContext();
  const isNarrow = pageStyle.isNarrow;
  const { directory, error, loading } = useNamedAgents();
  const { directory: networkDirectory, error: networkError } =
    useAgentNetworks();
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const searchNavigation = useNavigationIntent(active, accountId);
  const libraryOpen = !!useTypedRedux("page", "library_open");
  const libraryProjectId = useTypedRedux("page", "library_project_id");
  const libraryEntryId = useTypedRedux("page", "library_entry_id");
  const artifactOpen =
    libraryOpen && (libraryProjectId != null || libraryEntryId != null);
  const libraryButton = useRef<HTMLButtonElement>(null);
  const workspaceContent = useRef<HTMLElement>(null);
  function showLibrary() {
    searchNavigation.current++;
    openLibrary();
    setMobileList(false);
  }
  const activeAgentId = useTypedRedux("page", "active_agent_id") as
    | string
    | undefined;
  const [search, setSearch] = useState("");
  const [networkFilterId, setNetworkFilterId] = useState(
    readAgentNetworkFilter,
  );
  const [networkDetailsId, setNetworkDetailsId] = useState<string>();
  const [creating, setCreating] = useState(activeAgentId === "new");
  const [creatingSourceAgentId, setCreatingSourceAgentId] = useState<string>();
  const [copyingAgent, setCopyingAgent] = useState<NamedAgent>();
  const [freshAgent, startFresh] = useState<NamedAgent>();
  const [initialCopyName, setInitialCopyName] = useState("");
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [retiringAgentId, setRetiringAgentId] = useState<string>();
  const [mobileList, setMobileList] = useState(!libraryOpen);
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

  useEffect(() => {
    if (libraryOpen) setMobileList(false);
  }, [libraryOpen, libraryProjectId, libraryEntryId]);

  function libraryNavigationControl() {
    return isNarrow ? (
      <Button
        type="text"
        aria-label="Show agents"
        icon={<Icon name="bars" />}
        onClick={() => setMobileList(true)}
      />
    ) : (
      <AgentsSidebarToggle
        hidden={agentSidebarHidden}
        onToggle={toggleAgentSidebar}
      />
    );
  }

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
  const networks = networkDirectory?.networks ?? [];
  const selectedNetwork = networks.find(
    ({ agent_network_id }) => agent_network_id === networkFilterId,
  );
  const detailsNetwork = networks.find(
    ({ agent_network_id }) => agent_network_id === networkDetailsId,
  );
  const agentOrganization = useAgentWorkspaceOrganization(agents);
  const selected =
    activeAgentId && activeAgentId !== "new"
      ? agents.find(
          (agent) =>
            agent.endpoint.agent_id === activeAgentId ||
            agent.name === activeAgentId,
        )
      : (agentOrganization.groups.pinned[0] ??
        agentOrganization.groups.unpinned[0]);
  const creatingSourceAgent =
    agents.find(
      ({ endpoint }) => endpoint.agent_id === creatingSourceAgentId,
    ) ?? selected;

  useEffect(() => {
    if (!networkDirectory || !networkFilterId) return;
    if (selectedNetwork) {
      rememberAgentNetworkFilter(networkFilterId);
      return;
    }
    rememberAgentNetworkFilter();
    setNetworkFilterId(undefined);
  }, [networkDirectory, networkFilterId, selectedNetwork]);

  const networkFallback =
    selectedNetwork &&
    !creating &&
    (!selected || !networksForAgent([selectedNetwork], selected).length)
      ? agents.find(
          (agent) => networksForAgent([selectedNetwork], agent).length > 0,
        )
      : undefined;
  useWorkspaceRoute({
    active: active && !libraryOpen,
    activeAgentId,
    selected,
    networkFallback,
    mountAgent,
  });

  useEffect(() => {
    setCreating(activeAgentId === "new");
  }, [activeAgentId]);

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
    if (!selected || libraryOpen || !active) return;
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
  }, [selected?.endpoint.agent_id, libraryOpen, active]);

  const visibleGroups = useMemo(() => {
    const value = search.trim().toLowerCase();
    const filter = (agent: NamedAgent) => {
      if (
        selectedNetwork &&
        !networksForAgent([selectedNetwork], agent).length
      ) {
        return false;
      }
      return (
        !value ||
        [
          agent.name,
          agentAppearances.get(agent.endpoint.agent_id)?.name,
          agent.thread_title,
          agent.project_title,
          agent.description,
        ]
          .filter(Boolean)
          .some((part) => `${part}`.toLowerCase().includes(value))
      );
    };
    return {
      pinned: agentOrganization.groups.pinned.filter(filter),
      unpinned: agentOrganization.groups.unpinned.filter(filter),
      hidden: agentOrganization.groups.hidden.filter(filter),
    };
  }, [agentAppearances, agentOrganization.groups, search, selectedNetwork]);
  const recencySections = useMemo(
    () =>
      groupAgentsByRecency(
        visibleGroups.unpinned,
        agentOrganization.organization.lastOpened,
      ),
    [agentOrganization.organization.lastOpened, visibleGroups.unpinned],
  );
  const projectGroups = useMemo(
    () =>
      groupAgentsByProject(
        visibleGroups.pinned,
        visibleGroups.unpinned,
        agentOrganization.organization.lastOpened,
      ),
    [
      agentOrganization.organization.lastOpened,
      visibleGroups.pinned,
      visibleGroups.unpinned,
    ],
  );

  const handleRegisteredThreadSelected = useCallback(
    (workspace: string, nextAgent: NamedAgent) => {
      if (!active || libraryOpen) return;
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
        active_agent_name: nextAgent.name,
      });
      set_url(
        getPageUrlPath({
          page: "agents",
          agent_id: nextAgent.name,
        }),
      );
    },
    [active, libraryOpen],
  );

  function selectAgent(agent: NamedAgent, keepNavigation = false) {
    mountAgent(agent);
    selectAgentId(agent.endpoint.agent_id, keepNavigation);
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

  function selectAgentId(agentId: string, keepNavigation = false) {
    if (!keepNavigation) searchNavigation.current++;
    const routeName = agents.find(
      ({ endpoint }) => endpoint.agent_id === agentId,
    )?.name;
    redux.getActions("page").setState({
      ...closedLibraryState,
      active_agent_id: agentId,
      active_agent_name: routeName,
    });
    set_url(
      getPageUrlPath({
        page: "agents",
        agent_id: routeName ?? agentId,
      }),
      "",
    );
  }

  function selectNetwork(network?: AgentNetwork) {
    const next = network?.agent_network_id;
    rememberAgentNetworkFilter(next);
    setNetworkFilterId(next);
  }

  function openCopyAgent(agent: NamedAgent) {
    setCopyingAgent(agent);
    setInitialCopyName(suggestedAgentName(agents, accountId));
    setCopyError("");
  }

  async function performFresh(agent: NamedAgent) {
    const next = await personalAgentApi().startFreshConversation({
      project_id: agent.endpoint.project_id,
      agent_id: agent.endpoint.agent_id,
      expected_thread_id: agent.thread_id,
    });
    writeAgentSubscriptionSelection({
      accountId,
      projectId: agent.endpoint.project_id,
      threadId: next.thread_id,
      credentialId: readAgentSubscriptionSelection({
        accountId,
        projectId: agent.endpoint.project_id,
        threadId: agent.thread_id,
      }),
    });
    refreshNamedAgents();
    selectAgentId(agent.endpoint.agent_id);
  }

  async function openSearchHit(
    result: AgentSearchHit,
    showConversation = false,
  ) {
    const navigation = ++searchNavigation.current;
    const superseded = () => navigation !== searchNavigation.current;
    const { agent, threadId, hit, historical } = result;
    const identity = await personalAgentApi().getIdentity({
      project_id: agent.endpoint.project_id,
      agent_id: agent.endpoint.agent_id,
    });
    if (superseded()) return;
    if (!historical && identity.thread_id !== threadId)
      throw new Error(
        "This agent started a fresh conversation. Search again to open its current results.",
      );
    await ensureProjectReduxRuntime();
    if (superseded()) return;
    if (hit.artifact_id) {
      const { openForeignArtifactSource } =
        await import("@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source");
      if (superseded()) return;
      await openForeignArtifactSource({
        projectId: agent.endpoint.project_id,
        path: agent.path,
        threadId,
        artifactId: hit.artifact_id,
      });
      if (superseded()) return;
    }
    if (historical) {
      await redux.getActions("projects").open_project({
        project_id: agent.endpoint.project_id,
        target: "files/",
        switch_to: true,
      });
      if (superseded()) return;
    } else {
      selectAgent(agent, true);
    }
    await redux.getProjectActions(agent.endpoint.project_id).open_file({
      path: agent.path,
      embedded: !historical,
      foreground: historical,
      foreground_project: historical,
      wait_for_ready: true,
      change_history: historical,
      fragmentId: {
        thread: threadId,
        chat:
          hit.artifact_id || hit.date_ms == null ? undefined : `${hit.date_ms}`,
      },
    });
    if (superseded()) return;
    const editor: any = redux.getEditorActions(
      agent.endpoint.project_id,
      agent.path,
    );
    if (!editor) throw new Error("Unable to open the conversation editor");
    await editor.gotoFragment({ thread: threadId });
    if (superseded()) return;
    const chat = editor.getChatActions();
    if (!chat) throw new Error("Conversation is not ready; try again shortly");
    if (hit.artifact_id) {
      const { openSourceArtifact, sourceArtifactPublication } =
        await import("./open-source-artifact");
      const { showConversation: showArtifactConversation } =
        await import("@cocalc/frontend/chat/artifact-browser");
      if (superseded()) return;
      if (showConversation) {
        await showArtifactConversation(chat, {
          publication: sourceArtifactPublication(chat, result),
        });
      } else {
        openSourceArtifact(chat, result);
      }
      return;
    }
    if (hit.segment_id !== "head") {
      const { webapp_client } = await import("@cocalc/frontend/webapp-client");
      if (superseded()) return;
      const archived =
        await webapp_client.conat_client.hub.projects.chatStoreReadArchivedHit({
          project_id: agent.endpoint.project_id,
          chat_path: agent.path,
          thread_id: threadId,
          row_id: hit.row_id,
        });
      if (superseded()) return;
      if (!archived.row?.row)
        throw new Error("Archived message is no longer available");
      chat.hydrateArchivedRows([archived.row.row]);
    }
    await editor.gotoFragment({ thread: threadId, chat: hit.date_ms });
    if (
      !superseded() &&
      !historical &&
      hit.date_ms != null &&
      redux.getStore("page").get("active_agent_id") === agent.endpoint.agent_id
    ) {
      Fragment.set({ thread: threadId, chat: `${hit.date_ms}` });
    }
  }

  async function openLibraryHit(result: AgentSearchHit, conversation = false) {
    if (conversation) return openSearchHit(result, true);
    if (!result.catalogEntryId)
      throw Error("Artifact catalog identity missing");
    searchNavigation.current++;
    openLibrary(result.agent.endpoint.project_id, result.catalogEntryId);
    setMobileList(false);
  }

  async function showLibraryConversation(target: ForeignArtifactTarget) {
    const agent = agents.find(
      (candidate) =>
        candidate.endpoint.project_id === target.projectId &&
        candidate.path === target.path &&
        candidate.thread_id === target.threadId,
    );
    if (agent) {
      await openSearchHit(
        {
          agent,
          threadId: target.threadId,
          historical: false,
          hit: {
            row_id: 0,
            segment_id: "head",
            thread_id: target.threadId,
            artifact_id: target.artifactId,
            excerpt: "",
          },
        },
        true,
      );
      return;
    }
    // A link remains useful after an agent is retired or starts a new thread.
    const navigation = ++searchNavigation.current;
    await ensureProjectReduxRuntime();
    if (navigation !== searchNavigation.current) return;
    const project = redux.getProjectActions(target.projectId);
    await project.fs().stat(target.path);
    if (navigation !== searchNavigation.current) return;
    await project.open_file({
      path: target.path,
      foreground: true,
      foreground_project: true,
      change_history: true,
      fragmentId: { thread: target.threadId },
    });
  }

  useEffect(() => {
    if (!active) return;
    const show = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || typeof detail !== "object") return;
      const agent = agents.find(
        (agent) =>
          agent.endpoint.agent_id === detail.agent_id &&
          agent.endpoint.project_id === detail.project_id &&
          agent.path === detail.path &&
          agent.thread_id === detail.thread_id,
      );
      if (!agent) {
        antdMessage.error(
          "The source conversation is no longer in your agent directory.",
        );
        return;
      }
      void openSearchHit(
        {
          agent,
          threadId: detail.thread_id,
          historical: false,
          hit: {
            row_id: 0,
            segment_id: "head",
            thread_id: detail.thread_id,
            artifact_id: detail.artifact_id,
            operation_id: detail.operation_id,
            excerpt: "",
          },
        },
        true,
      ).catch((err) => antdMessage.error(`${err}`));
    };
    window.addEventListener("cocalc:artifact-show-conversation", show);
    return () =>
      window.removeEventListener("cocalc:artifact-show-conversation", show);
  }, [active, agents, openSearchHit]);

  async function copyAgent(copyName: string) {
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
        copyingAgent.path,
        { instanceKey: COPY_AGENT_BOOTSTRAP_INSTANCE_KEY },
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
      await actions.save_to_disk();
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

  function confirmRetireAgent(agent: NamedAgent) {
    Modal.confirm({
      title: `Remove @${agent.name} from Agents?`,
      content:
        "This frees a named-agent slot. The conversation and artifacts are preserved, and historical Agent Networks keep their records, but this agent becomes unavailable to those networks.",
      okText: "Remove from Agents",
      okButtonProps: { danger: true },
      onOk: async () => {
        setRetiringAgentId(agent.endpoint.agent_id);
        try {
          await personalAgentApi().retireNamedAgent({
            endpoint: agent.endpoint,
          });
          const workspace = agentWorkspaceKey(agent);
          const nextAgent = agents.find(
            ({ endpoint }) => endpoint.agent_id !== agent.endpoint.agent_id,
          );
          setMountedWorkspaces((old) => {
            if (
              agents.some(
                (candidate) =>
                  candidate.endpoint.agent_id !== agent.endpoint.agent_id &&
                  agentWorkspaceKey(candidate) === workspace,
              )
            ) {
              return old;
            }
            const next = new Set(old);
            next.delete(workspace);
            return next;
          });
          if (selected?.endpoint.agent_id === agent.endpoint.agent_id) {
            if (nextAgent) {
              mountAgent(nextAgent);
              selectAgentId(nextAgent.endpoint.agent_id);
            } else {
              setCreatingSourceAgentId(undefined);
              setCreating(true);
              redux.getActions("page").setState({
                active_agent_id: "new",
                active_agent_name: undefined,
              });
              set_url(
                getPageUrlPath({
                  page: "agents",
                  agent_id: "new",
                }),
              );
            }
          }
          refreshNamedAgents();
          antdMessage.success(`Removed @${agent.name} from Agents.`);
        } catch (err) {
          antdMessage.error(`Unable to remove @${agent.name}: ${err}`);
          throw err;
        } finally {
          setRetiringAgentId(undefined);
        }
      },
    });
  }

  function renderAgentRow(
    agent: NamedAgent,
    pinned: boolean,
    reorderable = true,
    hidden = false,
    showProjectTitle = true,
  ) {
    const active =
      !libraryOpen && agent.endpoint.agent_id === selected?.endpoint.agent_id;
    const id = agent.endpoint.agent_id;
    const appearance = agentAppearances.get(id);
    const theme = resolveNamedAgentTheme(agent, appearance);
    return (
      <div
        role="listitem"
        className="cocalc-agent-sidebar-row"
        style={{
          alignItems: "center",
          background: active ? UI_COLORS.selected : "transparent",
          borderInlineStart: `3px solid ${theme.primaryColor ?? "transparent"}`,
          borderRadius: 6,
          display: "flex",
        }}
      >
        {reorderable ? (
          <span className="cocalc-agent-sidebar-row-reveal">
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
          </span>
        ) : (
          <span aria-hidden style={{ flex: "0 0 26px" }} />
        )}
        <div style={{ flex: 1, minWidth: 0, padding: "5px 4px" }}>
          <button
            type="button"
            aria-current={active ? "page" : undefined}
            aria-label={`${theme.title}, @${agent.name}, ${agent.project_title || agent.endpoint.project_id}`}
            title={`@${agent.name} · ${agent.project_title || agent.endpoint.project_id}`}
            onClick={() => selectAgent(agent)}
            style={{
              alignItems: "center",
              background: "transparent",
              border: 0,
              color: UI_COLORS.text,
              cursor: "pointer",
              display: "flex",
              gap: 8,
              minWidth: 0,
              padding: "4px 0",
              textAlign: "left",
              width: "100%",
            }}
          >
            <AgentRunningIndicator agent={agent}>
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
            </AgentRunningIndicator>
            <span style={{ minWidth: 0, flex: 1 }}>
              <Text strong ellipsis style={{ display: "block" }}>
                {theme.title}
              </Text>
              <Text type="secondary" ellipsis style={{ display: "block" }}>
                {showProjectTitle
                  ? agent.project_title || agent.endpoint.project_id
                  : `@${agent.name}`}
              </Text>
            </span>
          </button>
        </div>
        {!hidden && (
          <Button
            className={pinned ? undefined : "cocalc-agent-sidebar-row-reveal"}
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
                key: "fresh",
                label: "Start fresh conversation…",
                icon: <Icon name="plus-circle" />,
              },
              {
                key: hidden ? "show" : "hide",
                icon: <Icon name={hidden ? "eye" : "eye-slash"} />,
                label: hidden ? "Show in Agents" : "Hide from Agents",
              },
              { type: "divider" },
              {
                key: "remove",
                danger: true,
                disabled: retiringAgentId === id,
                icon: <Icon name="trash" />,
                label:
                  retiringAgentId === id
                    ? "Removing from Agents…"
                    : "Remove from Agents…",
              },
            ],
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation();
              if (key === "copy") {
                openCopyAgent(agent);
                return;
              }
              if (key === "fresh") {
                startFresh(agent);
                return;
              }
              if (key === "remove") {
                confirmRetireAgent(agent);
                return;
              }
              agentOrganization.setHidden(id, !hidden);
            },
          }}
        >
          <Button
            className="cocalc-agent-sidebar-row-reveal"
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
    options: {
      projectAgentIds?: string[];
      showProjectTitle?: boolean;
    } = {},
  ) {
    if (search.trim() || !reorderable) {
      return group.map((agent) => (
        <div key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}>
          {renderAgentRow(
            agent,
            pinned,
            false,
            false,
            options.showProjectTitle,
          )}
        </div>
      ));
    }
    const ids = group.map(({ endpoint }) => endpoint.agent_id);
    return (
      <SortableList
        items={ids}
        onDragStop={(_oldIndex, newIndex, activeId) => {
          if (typeof activeId === "string") {
            if (options.projectAgentIds) {
              agentOrganization.moveWithinProject(
                activeId,
                options.projectAgentIds,
                newIndex,
              );
            } else {
              agentOrganization.moveToIndex(activeId, newIndex);
            }
          }
        }}
      >
        {group.map((agent) => (
          <SortableItem
            key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}
            id={agent.endpoint.agent_id}
            hideActive={false}
          >
            {renderAgentRow(
              agent,
              pinned,
              true,
              false,
              options.showProjectTitle,
            )}
          </SortableItem>
        ))}
      </SortableList>
    );
  }

  if (loading && !directory && !libraryOpen) return <Loading theme="medium" />;
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
        padding: "12px 0 0 12px",
        ...(isNarrow && !mobileList ? { display: "none" } : {}),
      }}
    >
      <WorkspaceSidebarActions
        footer={
          <div
            style={{
              borderTop: `1px solid ${UI_COLORS.border}`,
              paddingTop: 8,
            }}
          >
            <AgentsAccountMenu />
          </div>
        }
        onProjects={
          lite
            ? undefined
            : () => {
                void redux.getActions("page").set_active_tab("projects");
              }
        }
        onNewAgent={() => {
          searchNavigation.current++;
          setCreatingSourceAgentId(selected?.endpoint.agent_id);
          setCreating(true);
          redux.getActions("page").setState({
            ...closedLibraryState,
            active_agent_id: "new",
            active_agent_name: undefined,
          });
          set_url(
            getPageUrlPath({
              page: "agents",
              agent_id: "new",
            }),
          );
          setMobileList(false);
        }}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Button
            ref={libraryButton}
            block
            type="text"
            style={{
              justifyContent: "flex-start",
              background: libraryOpen ? UI_COLORS.selected : undefined,
            }}
            icon={<Icon name="files" />}
            aria-pressed={libraryOpen}
            aria-current={libraryOpen ? "page" : undefined}
            onClick={showLibrary}
          >
            Library
          </Button>
          {accountId && (
            <AgentSearch
              accountId={accountId}
              agents={agents}
              activity={agentOrganization.organization.lastOpened}
              active={active}
              onSelect={openSearchHit}
              available={(agent) => agent.available}
            />
          )}
          <AgentOrganizationControls
            mode={agentOrganization.organization.mode}
            groupByProject={agentOrganization.organization.groupByProject}
            onMode={agentOrganization.setMode}
            onGroupByProject={agentOrganization.setGroupByProject}
          />
          <Input
            allowClear
            aria-label="Filter agents by name"
            placeholder="Filter agents by name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {selectedNetwork && (
            <AgentNetworkFilterBar
              network={selectedNetwork}
              onOpen={() =>
                setNetworkDetailsId(selectedNetwork.agent_network_id)
              }
              onClear={() => selectNetwork()}
            />
          )}
          {networkError && (
            <Alert
              role="alert"
              type="warning"
              showIcon
              title="Unable to load Agent Networks"
              description={networkError}
            />
          )}
          {agentOrganization.saveError && (
            <Alert
              role="alert"
              type="error"
              showIcon
              title={agentOrganization.saveError}
            />
          )}
        </Space>
        <div>
          {agentOrganization.organization.groupByProject ? (
            projectGroups.map((group) => {
              const count = group.pinned.length + group.unpinned.length;
              const collapsed =
                !search.trim() &&
                agentOrganization.organization.collapsedProjects.includes(
                  group.projectId,
                );
              return (
                <section
                  key={group.projectId}
                  aria-label={`${group.projectTitle} agents`}
                  style={{ marginBottom: 8 }}
                >
                  <Button
                    type="text"
                    block
                    aria-expanded={!collapsed}
                    onClick={() =>
                      agentOrganization.setProjectCollapsed(
                        group.projectId,
                        !collapsed,
                      )
                    }
                    style={{
                      alignItems: "center",
                      background: UI_COLORS.surface,
                      border: `1px solid ${UI_COLORS.border}`,
                      display: "flex",
                      fontWeight: 600,
                      justifyContent: "flex-start",
                      paddingInline: 8,
                      textAlign: "left",
                    }}
                    icon={
                      <Icon name={collapsed ? "caret-right" : "caret-down"} />
                    }
                  >
                    <span
                      title={group.projectTitle}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {group.projectTitle}
                    </span>
                    <Text type="secondary" style={{ marginLeft: 6 }}>
                      {count}
                    </Text>
                  </Button>
                  {!collapsed && (
                    <div
                      role="list"
                      aria-label={`Agents in ${group.projectTitle}`}
                    >
                      {renderSortableAgentGroup(group.pinned, true, true, {
                        projectAgentIds: group.pinned.map(
                          ({ endpoint }) => endpoint.agent_id,
                        ),
                        showProjectTitle: false,
                      })}
                      {renderSortableAgentGroup(
                        group.unpinned,
                        false,
                        agentOrganization.organization.mode === "custom",
                        {
                          projectAgentIds: group.unpinned.map(
                            ({ endpoint }) => endpoint.agent_id,
                          ),
                          showProjectTitle: false,
                        },
                      )}
                    </div>
                  )}
                </section>
              );
            })
          ) : (
            <div role="list" aria-label="Visible agents">
              {visibleGroups.pinned.length > 0 && (
                <Text type="secondary" style={{ display: "block", padding: 6 }}>
                  Pinned
                </Text>
              )}
              {renderSortableAgentGroup(visibleGroups.pinned, true)}
              {agentOrganization.organization.mode === "custom" ? (
                <>
                  {visibleGroups.unpinned.length > 0 && (
                    <Text
                      type="secondary"
                      style={{ display: "block", padding: 6 }}
                    >
                      Custom order
                    </Text>
                  )}
                  {renderSortableAgentGroup(visibleGroups.unpinned, false)}
                </>
              ) : (
                recencySections.map((section) => (
                  <div key={section.key}>
                    <Text
                      type="secondary"
                      style={{ display: "block", padding: 6 }}
                    >
                      {section.title}
                    </Text>
                    {renderSortableAgentGroup(section.agents, false, false)}
                  </div>
                ))
              )}
            </div>
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
              {showHidden && (
                <div role="list" aria-label="Hidden agents">
                  {visibleGroups.hidden.map((agent) => (
                    <div
                      key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}
                    >
                      {renderAgentRow(agent, false, false, true)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </WorkspaceSidebarActions>
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
                <AgentsSidebarResizeHandle
                  width={agentSidebarWidth}
                  minWidth={MIN_AGENT_SIDEBAR_WIDTH}
                  maxWidth={MAX_AGENT_SIDEBAR_WIDTH}
                  onResize={(width) => {
                    setAgentSidebarWidth(width);
                    window.localStorage.setItem(
                      AGENT_SIDEBAR_WIDTH_STORAGE_KEY,
                      `${width}`,
                    );
                  }}
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
        ref={workspaceContent}
        tabIndex={-1}
        aria-label={
          libraryOpen
            ? "Artifact Library"
            : selected
              ? `Agent @${selected.name}`
              : "Agent workspace"
        }
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          ...(isNarrow && mobileList ? { display: "none" } : {}),
        }}
      >
        {accountId && (
          <AgentArtifactBrowser
            key={accountId}
            accountId={accountId}
            agents={agents}
            activeAgent={selected}
            active={
              active &&
              libraryOpen &&
              !artifactOpen &&
              (!isNarrow || !mobileList)
            }
            navigation={libraryNavigationControl()}
            onSelect={openLibraryHit}
            onShowConversation={(result) => openLibraryHit(result, true)}
          />
        )}
        {active && artifactOpen && accountId && (!isNarrow || !mobileList) && (
          <LibraryEntry
            navigation={libraryNavigationControl()}
            accountId={accountId}
            projectId={libraryProjectId ?? ""}
            entryId={libraryEntryId ?? ""}
            agents={agents}
            onBack={showLibrary}
            onShowConversation={showLibraryConversation}
          />
        )}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            position: "relative",
            display: libraryOpen ? "none" : undefined,
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
              sourceAgent={creatingSourceAgent}
              onCancel={() => {
                setCreating(false);
                setCreatingSourceAgentId(undefined);
                if (selected) {
                  selectAgentId(selected.endpoint.agent_id);
                } else {
                  redux.getActions("page").setState({
                    active_agent_id: undefined,
                    active_agent_name: undefined,
                  });
                  set_url(
                    getPageUrlPath({
                      page: "agents",
                    }),
                  );
                }
                setMobileList(true);
              }}
              onCreated={(agentId) => {
                const agent = agents.find(
                  ({ endpoint }) => endpoint.agent_id === agentId,
                );
                if (agent) mountAgent(agent);
                selectAgentId(agentId);
                setCreating(false);
                setCreatingSourceAgentId(undefined);
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
                    onCopy={openCopyAgent}
                    onFresh={startFresh}
                    key={workspace}
                    workspaceKey={workspace}
                    agent={agent}
                    workspaceAgents={workspaceAgents}
                    accountId={accountId}
                    active={
                      active &&
                      !libraryOpen &&
                      !!selected &&
                      agentWorkspaceKey(selected) === workspace
                    }
                    onRegisteredThreadSelected={handleRegisteredThreadSelected}
                    onShowList={
                      isNarrow ? () => setMobileList(true) : undefined
                    }
                    agentSidebarHidden={
                      isNarrow ? undefined : agentSidebarHidden
                    }
                    onToggleAgentSidebar={
                      isNarrow ? undefined : toggleAgentSidebar
                    }
                    onAgentActivity={agentOrganization.recordActivity}
                    agentAppearances={agentAppearances}
                    onAgentAppearance={handleAgentAppearance}
                    networks={networksForAgent(networks, agent)}
                    selectedNetworkId={networkFilterId}
                    onSelectNetwork={selectNetwork}
                    onOpenNetwork={(network) =>
                      setNetworkDetailsId(network.agent_network_id)
                    }
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
                  description={`Workbench for @${selected.name} is closed.`}
                >
                  <Button type="primary" onClick={() => mountAgent(selected)}>
                    Open workbench
                  </Button>
                </Empty>
              )}
            </>
          )}
        </div>
      </section>
      {copyingAgent && (
        <CopyAgentModal
          agent={copyingAgent}
          agents={agents}
          initialName={initialCopyName}
          busy={copyBusy}
          error={copyError}
          onCopy={(name) => void copyAgent(name)}
          onCancel={() => {
            setCopyingAgent(undefined);
            setCopyError("");
          }}
        />
      )}
      {freshAgent && (
        <FreshConversationModal
          name={freshAgent.name}
          agent={freshAgent}
          onConfirm={() => performFresh(freshAgent)}
          onClose={() => startFresh(undefined)}
        />
      )}
      <AgentNetworkDetailsModal
        network={detailsNetwork}
        onClose={() => setNetworkDetailsId(undefined)}
        onChanged={refreshAgentNetworks}
      />
    </main>
  );
}
