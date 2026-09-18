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
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { DEFAULT_CODEX_MODEL_NAME } from "@cocalc/util/ai/codex";
import { initChat } from "@cocalc/frontend/chat/register";
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
import { Icon, Loading } from "@cocalc/frontend/components";
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
import { Resizable } from "re-resizable";
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
  Segmented,
  Space,
  Tag,
  Typography,
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

function suggestedAgentName(agents: NamedAgent[]): string {
  const used = new Set(agents.map(({ name }) => name));
  if (!used.has("agent")) return "agent";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `agent-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `agent-${Date.now()}`;
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
  onCancel,
  onCreated,
}: {
  agents: NamedAgent[];
  namedAgentDirectory?: NamedAgentDirectory;
  onCancel: () => void;
  onCreated: (agentId: string) => void;
}) {
  const projectMap = useTypedRedux("projects", "project_map");
  const activeTopTab = useTypedRedux("page", "active_top_tab") as
    | string
    | undefined;
  const lastProjectTab = useTypedRedux("page", "last_project_tab") as
    | string
    | undefined;
  const [projectId, setProjectId] = useState<string>();
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState(() => suggestedAgentName(agents));
  const [description, setDescription] = useState("");
  const [firstRequest, setFirstRequest] = useState("");
  const [directorySelectorOpen, setDirectorySelectorOpen] = useState(false);
  const [pending, setPending] = useState<PendingAgent>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const boundAccount = useBoundAgentAccount();
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
    const projectStore: any = redux.getStore("projects");
    const ids = [
      lastProjectTab,
      activeTopTab,
      ...(projectMap.keySeq?.().toArray?.() ?? []),
    ];
    const preferred = ids.find(
      (id) =>
        typeof id === "string" &&
        projectMap.has?.(id) &&
        !projectMap.getIn?.([id, "deleted"]) &&
        projectStore?.get_my_group?.(id) !== "viewer",
    );
    if (preferred) setProjectId(preferred);
  }, [activeTopTab, lastProjectTab, projectId, projectMap]);

  useEffect(() => {
    if (!projectId) return;
    setDirectory(getProjectHomeDirectory(projectId));
  }, [projectId]);

  async function prepare(): Promise<PendingAgent> {
    if (pending) return pending;
    if (!projectId) throw new Error("Select a project");
    await ensureProjectReduxRuntime();
    const projectActions = redux.getProjectActions(projectId);
    const fs = projectActions?.fs?.();
    if (!projectActions || !fs) {
      throw new Error("The selected project filesystem is unavailable");
    }
    const workingDirectory =
      directory.trim() || getProjectHomeDirectory(projectId);
    const stat = await fs.stat(workingDirectory);
    if (!stat.isDirectory()) {
      throw new Error("The working directory is not a directory");
    }
    const path = joinAbsolutePath(
      getProjectHomeDirectory(projectId),
      `.local/share/cocalc/agents/${uuid()}.chat`,
    );
    await projectActions.ensureContainingDirectoryExists(path);
    await fs.writeFile(path, "");
    const chatActions = initChat(projectId, path);
    await waitForChatReady(chatActions);
    const threadId = chatActions.createEmptyThread({
      name: name.trim(),
      threadAgent: {
        mode: "codex",
        model: DEFAULT_CODEX_MODEL_NAME,
        codexConfig: {
          model: DEFAULT_CODEX_MODEL_NAME,
          sessionMode: "workspace-write",
          allowWrite: true,
          workingDirectory,
        },
      },
    });
    if (!threadId) throw new Error("Unable to create the agent thread");
    const created = { projectId, path, threadId };
    setPending(created);
    return created;
  }

  async function create() {
    if (busy || problem || atLimit) return;
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
        const completed = await runFreshAuthAction(async () => {
          boundAccount.assertCurrent();
          identity = await api.registerIdentity(locator);
        });
        if (!completed) return;
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
      if (firstRequest.trim()) {
        await writeChatComposerDraft({
          account_id: boundAccount.accountId,
          project_id: created.projectId,
          path: created.path,
          composerDraftKey: stableDraftKeyFromThreadKey(created.threadId),
          text: firstRequest,
        });
      }
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

  return (
    <div style={{ margin: "auto", maxWidth: 720, padding: 32, width: "100%" }}>
      <Title level={2}>New Agent</Title>
      <Text type="secondary">
        Choose where this agent works. Creating it does not start a turn or
        grant messaging connections.
      </Text>
      <Space
        direction="vertical"
        size={14}
        style={{ marginTop: 24, width: "100%" }}
      >
        <NamedAgentLimitAlert directory={namedAgentDirectory} />
        <NamedAgentUsage directory={namedAgentDirectory} />
        {projectMap?.size === 0 && (
          <Alert
            type="info"
            showIcon
            title="Create a project first"
            description="Agents need an existing project for files and compute."
            action={<a href="/projects">Open Projects</a>}
          />
        )}
        <label>Project</label>
        <SelectProject
          fullCollaboratorOnly
          value={projectId}
          disabled={busy || !!pending}
          onChange={setProjectId}
        />
        <label htmlFor="new-agent-directory">Working directory</label>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            id="new-agent-directory"
            value={directory}
            disabled={busy || !!pending}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <Button
            disabled={!projectId || busy || !!pending}
            onClick={() => setDirectorySelectorOpen(true)}
          >
            Choose...
          </Button>
        </Space.Compact>
        <AgentNameInput
          id="new-agent-name"
          value={name}
          onChange={setName}
          problem={name.trim() ? problem : undefined}
          busy={busy || !!pending}
          onEnter={() => void create()}
        />
        <label htmlFor="new-agent-description">Description (optional)</label>
        <Input.TextArea
          id="new-agent-description"
          value={description}
          maxLength={500}
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
        />
        <label htmlFor="new-agent-first-request">
          First request (optional)
        </label>
        <Input.TextArea
          id="new-agent-first-request"
          value={firstRequest}
          autoFocus
          autoSize={{ minRows: 4, maxRows: 12 }}
          disabled={busy}
          placeholder="What should this agent work on?"
          onChange={(event) => setFirstRequest(event.target.value)}
        />
        <Text type="secondary">
          Your request opens as a draft in the registered agent. Review it and
          press Send there to start project compute.
        </Text>
        {pending && (
          <Alert
            type="info"
            showIcon
            title="Agent storage prepared"
            description="Complete approval to finish registration. Retrying reuses this thread."
          />
        )}
        {error && <Alert role="alert" type="error" title={error} />}
        <Space>
          <Button
            type="primary"
            loading={busy}
            disabled={!!problem || !projectId || atLimit}
            onClick={() => void create()}
          >
            {firstRequest.trim() ? "Create agent with draft" : "Create agent"}
          </Button>
          <Button disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </Space>
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
      <FreshAuthModal {...freshAuthModalProps} />
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
}: {
  agent: NamedAgent;
  workspaceAgents: NamedAgent[];
  active: boolean;
  accountId?: string;
  onSelectedThread: (threadId: string) => void;
  onAgentActivity: (agentId: string, at: number) => void;
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
  const workspaceAgentsRef = useRef(workspaceAgents);
  const reportedActivityRef = useRef<Map<string, number>>(new Map());
  const workspaceAgentKey = workspaceAgents
    .map(({ endpoint, thread_id }) => `${endpoint.agent_id}:${thread_id}`)
    .join("\0");
  const openFiles = useTypedRedux(
    { project_id: agent.endpoint.project_id },
    "open_files",
  );
  const component = openFiles?.getIn?.([agent.path, "component"]);
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
}: {
  onOpenInProject?: () => void;
} = {}) {
  const { pageStyle } = useAppContext();
  const accountId = useTypedRedux("account", "account_id");
  return (
    <CompactAgentsTopNav
      isLoggedIn={!!accountId}
      pageStyle={pageStyle}
      onOpenInProject={onOpenInProject}
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
  onClose: () => void;
  onRegisteredThreadSelected: (workspaceKey: string, agent: NamedAgent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [selectedThread, setSelectedThread] = useState(agent.thread_id);
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
  const threadTitle = unregistered
    ? cachedAgentNameContext({
        project_id: agent.endpoint.project_id,
        path: agent.path,
        thread_id: selectedThread,
      }).thread_title
    : undefined;
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
          borderBottom: `1px solid ${UI_COLORS.border}`,
          display: "flex",
          gap: 12,
          minHeight: 48,
          padding: "6px 12px",
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
          />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text strong ellipsis style={{ display: "block" }}>
            {unregistered
              ? threadTitle || "Unregistered thread"
              : displayedAgent.thread_title || `@${displayedAgent.name}`}
          </Text>
          <Text type="secondary" ellipsis style={{ display: "block" }}>
            {unregistered ? "Not yet registered" : `@${displayedAgent.name}`} ·{" "}
            {displayedAgent.project_title || agent.endpoint.project_id}
            {sharing ? ` · ${sharing}` : ""}
          </Text>
        </div>
        {unregistered && (
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
            onOpenInProject={() =>
              void openAgentThread({
                project_id: agent.endpoint.project_id,
                path: agent.path,
                thread_id: selectedThread || agent.thread_id,
              })
            }
          />
        )}
        <Button
          icon={<Icon name="times" />}
          aria-label={`Close workspace for ${agent.path}`}
          title="Close this mounted workspace view"
          onClick={onClose}
        />
      </header>
      <div style={{ position: "relative", minHeight: 0, flex: 1 }}>
        <AgentProjectContext
          agent={agent}
          workspaceAgents={workspaceAgents}
          active={active}
          accountId={accountId}
          onSelectedThread={handleSelectedThread}
          onAgentActivity={onAgentActivity}
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
  const rootRef = useRef<HTMLElement>(null);

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
      [agent.name, agent.thread_title, agent.project_title, agent.description]
        .filter(Boolean)
        .some((part) => `${part}`.toLowerCase().includes(value));
    return {
      pinned: agentOrganization.groups.pinned.filter(filter),
      unpinned: agentOrganization.groups.unpinned.filter(filter),
      hidden: agentOrganization.groups.hidden.filter(filter),
    };
  }, [agentOrganization.groups, search]);
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

  function renderAgentRow(
    agent: NamedAgent,
    pinned: boolean,
    reorderable = true,
    hidden = false,
  ) {
    const active = agent.endpoint.agent_id === selected?.endpoint.agent_id;
    const id = agent.endpoint.agent_id;
    return (
      <div
        role="listitem"
        style={{
          alignItems: "center",
          background: active ? UI_COLORS.selected : "transparent",
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
            background: "transparent",
            border: 0,
            color: UI_COLORS.text,
            cursor: "pointer",
            flex: 1,
            minWidth: 0,
            padding: "9px 4px",
            textAlign: "left",
          }}
        >
          <Text strong ellipsis style={{ display: "block" }}>
            {agent.thread_title || `@${agent.name}`}
          </Text>
          <Text type="secondary" ellipsis style={{ display: "block" }}>
            @{agent.name} · {agent.project_title || agent.endpoint.project_id}
          </Text>
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
                key: hidden ? "show" : "hide",
                icon: <Icon name={hidden ? "eye" : "eye-slash"} />,
                label: hidden ? "Show in Agents" : "Hide from Agents",
              },
            ],
            onClick: ({ domEvent }) => {
              domEvent.stopPropagation();
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
        {creating ? (
          <NewAgentPanel
            agents={agents}
            namedAgentDirectory={directory}
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
    </main>
  );
}
