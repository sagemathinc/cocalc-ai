/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  normalizeAgentName,
  type NamedAgent,
} from "@cocalc/conat/agents/personal";
import {
  redux,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTypedRedux,
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
import {
  ProjectContext,
  useProjectContextProvider,
} from "@cocalc/frontend/project/context";
import { EmbeddedProjectFile } from "@cocalc/frontend/project/page/content";
import { Icon, Loading } from "@cocalc/frontend/components";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import DirectorySelector from "@cocalc/frontend/project/directory-selector";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { joinAbsolutePath } from "@cocalc/util/path-model";
import { uuid } from "@cocalc/util/misc";
import {
  Alert,
  Button,
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
import { AgentLoadingPreview } from "./loading-preview";

const { Text, Title } = Typography;

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
  onCancel,
  onCreated,
}: {
  agents: NamedAgent[];
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
          workbench: true,
        },
      },
    });
    if (!threadId) throw new Error("Unable to create the agent thread");
    const created = { projectId, path, threadId };
    setPending(created);
    return created;
  }

  async function create() {
    if (busy || problem) return;
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
      setError(`${err}`);
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
            disabled={!!problem || !projectId}
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
  active,
  accountId,
}: {
  agent: NamedAgent;
  active: boolean;
  accountId?: string;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const projectContext = useProjectContextProvider({
    project_id: agent.endpoint.project_id,
    is_active: active,
    mainWidthPx: 900,
    manageWorkspaceSelection: false,
  });

  useEffect(() => {
    let disposed = false;
    setReady(false);
    setError("");
    void (async () => {
      await ensureProjectReduxRuntime();
      const actions = redux.getProjectActions(agent.endpoint.project_id);
      if (!actions) throw new Error("Unable to load this agent's project");
      await actions.open_file({
        path: agent.path,
        foreground: false,
        foreground_project: false,
        wait_for_ready: true,
        change_history: false,
        fragmentId: { thread: agent.thread_id },
      });
      if (!disposed) setReady(true);
    })().catch((err) => {
      if (!disposed) setError(`${err}`);
    });
    return () => {
      disposed = true;
    };
  }, [agent.endpoint.project_id, agent.path, agent.thread_id, retry]);

  useEffect(() => {
    if (!active || !ready) return;
    redux
      .getProjectActions(agent.endpoint.project_id)
      ?.gotoFragment(agent.path, { thread: agent.thread_id });
  }, [active, agent.endpoint.project_id, agent.path, agent.thread_id, ready]);

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

function AgentWorkspace({
  agent,
  active,
  accountId,
  onShowList,
  onClose,
}: {
  agent: NamedAgent;
  active: boolean;
  accountId?: string;
  onShowList?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text strong ellipsis style={{ display: "block" }}>
            {agent.thread_title || `@${agent.name}`}
          </Text>
          <Text type="secondary" ellipsis style={{ display: "block" }}>
            @{agent.name} · {agent.project_title || agent.endpoint.project_id}
            {sharing ? ` · ${sharing}` : ""}
          </Text>
        </div>
        {!agent.available && <Tag color="warning">Unavailable</Tag>}
        <Button
          icon={<Icon name="external-link" />}
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
        <Button
          icon={<Icon name="times" />}
          aria-label={`Close workspace for @${agent.name}`}
          title="Close this mounted workspace view"
          onClick={onClose}
        />
      </header>
      <div style={{ position: "relative", minHeight: 0, flex: 1 }}>
        <AgentProjectContext
          agent={agent}
          active={active}
          accountId={accountId}
        />
      </div>
    </div>
  );
}

export function MyAgentsWorkspacePage() {
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
  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set());
  const [draggingId, setDraggingId] = useState<string>();
  const agents = directory?.agents ?? [];
  const agentOrganization = useAgentWorkspaceOrganization(
    agents,
    activeAgentId,
  );
  const selected = activeAgentId
    ? agents.find((agent) => agent.endpoint.agent_id === activeAgentId)
    : (agentOrganization.groups.pinned[0] ??
      agentOrganization.groups.unpinned[0]);

  useEffect(() => {
    if (!selected) return;
    setMountedIds((old) => {
      if (old.has(selected.endpoint.agent_id)) return old;
      const next = new Set(old);
      next.add(selected.endpoint.agent_id);
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
    };
  }, [agentOrganization.groups, search]);

  function selectAgent(agent: NamedAgent) {
    mountAgent(agent.endpoint.agent_id);
    selectAgentId(agent.endpoint.agent_id);
    setMobileList(false);
  }

  function mountAgent(agentId: string) {
    setMountedIds((old) => {
      if (old.has(agentId)) return old;
      const next = new Set(old);
      next.add(agentId);
      return next;
    });
  }

  function selectAgentId(agentId: string) {
    redux.getActions("page").setState({ active_agent_id: agentId });
    set_url(getPageUrlPath({ page: "agents", agent_id: agentId }));
  }

  function renderAgentRow(agent: NamedAgent, pinned: boolean) {
    const active = agent.endpoint.agent_id === selected?.endpoint.agent_id;
    const group = pinned
      ? agentOrganization.groups.pinned
      : agentOrganization.groups.unpinned;
    const id = agent.endpoint.agent_id;
    const index = group.findIndex(({ endpoint }) => endpoint.agent_id === id);
    return (
      <div
        key={`${agent.endpoint.project_id}:${id}`}
        role="listitem"
        draggable
        onDragStart={(event) => {
          setDraggingId(id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", id);
        }}
        onDragEnd={() => setDraggingId(undefined)}
        onDragOver={(event) => {
          if (draggingId && draggingId !== id) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const source = draggingId || event.dataTransfer.getData("text/plain");
          if (source && source !== id) agentOrganization.moveBefore(source, id);
          setDraggingId(undefined);
        }}
        style={{
          alignItems: "center",
          background: active ? UI_COLORS.selected : "transparent",
          borderRadius: 6,
          display: "flex",
          opacity: draggingId === id ? 0.55 : 1,
        }}
      >
        <Button
          type="text"
          icon={<Icon name="bars" />}
          aria-label={`Drag @${agent.name} to reorder`}
          title="Drag to reorder"
          style={{ cursor: "grab", flex: "0 0 auto" }}
        />
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
            {agent.project_title || agent.endpoint.project_id}
          </Text>
        </button>
        <Space.Compact direction="vertical">
          <Button
            type="text"
            size="small"
            icon={<Icon name={pinned ? "star-filled" : "star"} />}
            aria-label={`${pinned ? "Unpin" : "Pin"} @${agent.name}`}
            title={pinned ? "Unpin" : "Pin"}
            onClick={() => agentOrganization.setPinned(id, !pinned)}
          />
          {(pinned || agentOrganization.organization.mode === "custom") && (
            <Space.Compact>
              <Button
                type="text"
                size="small"
                icon={<Icon name="arrow-up" />}
                aria-label={`Move @${agent.name} up`}
                disabled={index === 0}
                onClick={() => agentOrganization.move(id, -1)}
              />
              <Button
                type="text"
                size="small"
                icon={<Icon name="arrow-down" />}
                aria-label={`Move @${agent.name} down`}
                disabled={index === group.length - 1}
                onClick={() => agentOrganization.move(id, 1)}
              />
            </Space.Compact>
          )}
        </Space.Compact>
      </div>
    );
  }

  if (loading && !directory) return <Loading theme="medium" />;
  return (
    <main
      aria-label="My Agents workspace"
      style={{
        background: UI_COLORS.page,
        color: UI_COLORS.text,
        display: "flex",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <aside
        aria-label="Agents"
        style={{
          background: UI_COLORS.inset,
          borderRight: `1px solid ${UI_COLORS.border}`,
          display: "flex",
          flex: "0 0 280px",
          flexDirection: "column",
          minWidth: 220,
          padding: 12,
          ...(isNarrow && !mobileList ? { display: "none" } : {}),
        }}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Title level={3} style={{ margin: 0 }}>
            My Agents
          </Title>
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
          {visibleGroups.pinned.map((agent) => renderAgentRow(agent, true))}
          {visibleGroups.unpinned.length > 0 && (
            <Text type="secondary" style={{ display: "block", padding: 6 }}>
              {agentOrganization.organization.mode === "custom"
                ? "Custom order"
                : "Recent"}
            </Text>
          )}
          {visibleGroups.unpinned.map((agent) => renderAgentRow(agent, false))}
        </div>
        <a href="/settings/my-agents" style={{ paddingTop: 10 }}>
          Manage agents and connections
        </a>
      </aside>
      <section
        aria-label={selected ? `Agent @${selected.name}` : "Agent workspace"}
        style={{
          flex: 1,
          minWidth: 0,
          position: "relative",
          ...(isNarrow && mobileList ? { display: "none" } : {}),
        }}
      >
        {creating ? (
          <NewAgentPanel
            agents={agents}
            onCancel={() => {
              setCreating(false);
              setMobileList(true);
            }}
            onCreated={(agentId) => {
              mountAgent(agentId);
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
            <a href="/settings/my-agents">Manage named agents</a>
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
            {agents
              .filter((agent) => mountedIds.has(agent.endpoint.agent_id))
              .map((agent) => (
                <AgentWorkspace
                  key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}
                  agent={agent}
                  accountId={accountId}
                  active={
                    agent.endpoint.agent_id === selected?.endpoint.agent_id
                  }
                  onShowList={isNarrow ? () => setMobileList(true) : undefined}
                  onClose={() => {
                    setMountedIds((old) => {
                      const next = new Set(old);
                      next.delete(agent.endpoint.agent_id);
                      return next;
                    });
                    if (isNarrow) setMobileList(true);
                  }}
                />
              ))}
            {!mountedIds.has(selected.endpoint.agent_id) && (
              <Empty
                style={{ marginTop: 80 }}
                description={`Workspace for @${selected.name} is closed.`}
              >
                <Button
                  type="primary"
                  onClick={() => mountAgent(selected.endpoint.agent_id)}
                >
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
