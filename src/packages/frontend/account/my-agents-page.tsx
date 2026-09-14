import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Input, Modal, Space, Tag } from "antd";
import { defineMessage } from "react-intl";
import type {
  PersonalConnectionDirectory,
  SetPersonalConnectionStateOptions,
  SetPersonalMessagingStateOptions,
} from "@cocalc/conat/agents/personal";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { NameAgent } from "@cocalc/frontend/agents/name-agent";
import { ConnectionApproval } from "@cocalc/frontend/agents/connection-approval";
import type { ApprovalTarget } from "@cocalc/frontend/agents/connection-approval";
import { AgentMessagingRequests } from "@cocalc/frontend/agents/messaging-requests";
import {
  personalAgentApi,
  refreshNamedAgents,
  sameEndpoint,
  useNamedAgents,
} from "@cocalc/frontend/agents/api";
import { agentThreadUrl } from "@cocalc/frontend/chat/agent-thread-url";
import type { SettingsPageDefinition } from "./settings-page";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useBoundAgentAccount } from "@cocalc/frontend/agents/use-bound-account";

export function MyAgentsPage() {
  const accountId = useTypedRedux("account", "account_id");
  return accountId ? <AccountAgentsPage key={accountId} /> : null;
}

function AccountAgentsPage() {
  const boundAccount = useBoundAgentAccount();
  const { directory, error: directoryError, loading } = useNamedAgents();
  const [connections, setConnections] = useState<PersonalConnectionDirectory>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revokeAll, setRevokeAll] = useState(false);
  const [approval, setApproval] = useState<ApprovalTarget>();
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const connectionsHeading = useRef<HTMLHeadingElement>(null);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  useEffect(() => {
    let disposed = false;
    void personalAgentApi()
      .listPersonalConnections({})
      .then((value) => {
        if (!disposed) setConnections(value);
      })
      .catch((err) => {
        if (!disposed) setError(`${err}`);
      });
    return () => {
      disposed = true;
    };
  }, [revision]);
  async function mutate(action: () => Promise<unknown>, message: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const completed = await runFreshAuthAction(async () => {
        boundAccount.assertCurrent();
        if (!alive.current)
          throw new Error(
            "The account changed. Review this action in the current session.",
          );
        await action();
      });
      if (completed) {
        setNotice(message);
        setRevision((n) => n + 1);
        setRevokeAll(false);
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const accountAction = (action: SetPersonalMessagingStateOptions["action"]) =>
    void mutate(
      () => personalAgentApi().setPersonalMessagingState({ action }),
      "Account communication settings updated. Already accepted work is not canceled.",
    );
  const connectionAction = (
    direction_group_id: string,
    state: SetPersonalConnectionStateOptions["state"],
  ) =>
    void mutate(
      () =>
        personalAgentApi().setPersonalConnectionState({
          direction_group_id,
          state,
        }),
      "Connection updated. Already accepted work is not canceled.",
    );
  const search = query.trim().toLowerCase().replace(/^@/, "");
  const agents = (directory?.agents ?? [])
    .filter((agent) =>
      `${agent.name} ${agent.thread_title ?? ""} ${agent.project_title ?? ""}`
        .toLowerCase()
        .includes(search),
    )
    .sort(
      (a, b) =>
        Number(b.name === search) - Number(a.name === search) ||
        a.name.localeCompare(b.name),
    );
  const endpointLabel = (endpoint) => {
    const agent = directory?.agents.find((agent) =>
      sameEndpoint(agent.endpoint, endpoint),
    );
    return agent ? `@${agent.name}` : endpoint.agent_id;
  };
  return (
    <Space
      orientation="vertical"
      size="middle"
      style={{ width: "100%", maxWidth: 1000 }}
    >
      <p>
        Your names and communication permissions across all projects on this
        site. Listing agents reads metadata only; Open navigates to their
        existing thread. Shared chat history remains shared.
      </p>
      <Space wrap>
        <Input.Search
          aria-label="Search My Agents"
          placeholder="Name, thread or project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ maxWidth: "100%", width: 300 }}
        />
        <Button
          loading={loading}
          disabled={busy}
          onClick={() => {
            refreshNamedAgents();
            setRevision((n) => n + 1);
          }}
        >
          Refresh My Agents
        </Button>
      </Space>
      {(directoryError || error) && (
        <div role="alert">
          <Alert
            type="error"
            title="My Agents needs attention"
            description={directoryError || error}
          />
        </div>
      )}
      {notice && <div role="status">{notice}</div>}
      {directory && !directory.enabled && (
        <Alert type="info" title="Named agents are not enabled on this site" />
      )}
      {!loading && directory?.enabled && !agents.length && (
        <p>
          No matching agents. Use Name agent beside an agent thread title to add
          it here, without starting a turn.
        </p>
      )}
      {agents.map((agent) => (
        <Card
          key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}
          size="small"
          title={`@${agent.name}`}
        >
          <Space
            orientation="vertical"
            style={{ width: "100%", overflowWrap: "anywhere" }}
          >
            <div>
              {agent.thread_title ?? "Agent thread"} /{" "}
              {agent.project_title ?? "Project"}
            </div>
            {agent.description && <p>{agent.description}</p>}
            <div>
              <Tag>{agent.available ? "Activity unknown" : "Unavailable"}</Tag>
              Metadata updated {new Date(agent.updated_at).toLocaleString()}
            </div>
            <Space wrap>
              <Button
                href={
                  agent.available
                    ? agentThreadUrl(
                        agent.endpoint.project_id,
                        agent.path,
                        agent.thread_id,
                      )
                    : undefined
                }
                disabled={!agent.available}
                aria-label={`Open @${agent.name}`}
              >
                Open
              </Button>
              <NameAgent
                agent={agent}
                projectId={agent.endpoint.project_id}
                path={agent.path}
                threadId={agent.thread_id}
                threadTitle={agent.thread_title}
                projectTitle={agent.project_title}
              />
              <Button
                aria-label={`Connections for @${agent.name}`}
                onClick={() => {
                  setFilter(agent.endpoint.agent_id);
                  connectionsHeading.current?.focus();
                }}
              >
                Connections
              </Button>
            </Space>
            <details>
              <summary>Agent details</summary>
              <p>Project: {agent.endpoint.project_id}</p>
              <p>Agent: {agent.endpoint.agent_id}</p>
              <p>Thread: {agent.thread_id}</p>
              <p>Path: {agent.path}</p>
              <a href={`/projects/${agent.endpoint.project_id}/files/`}>
                Open project
              </a>
            </details>
          </Space>
        </Card>
      ))}
      <section aria-labelledby="my-agent-connections">
        <h2 id="my-agent-connections" ref={connectionsHeading} tabIndex={-1}>
          Connections
        </h2>
        <p>
          These are your grants, not other collaborators' permissions. Pause and
          revoke affect future admission; queued or running work already
          accepted is not canceled.
        </p>
        <Space wrap>
          <Button
            disabled={busy || !connections?.enabled}
            onClick={() =>
              accountAction(connections?.controls?.paused ? "resume" : "pause")
            }
          >
            {connections?.controls?.paused
              ? "Resume all communication"
              : "Pause all communication"}
          </Button>
          <Button
            danger
            disabled={busy || !connections?.enabled}
            onClick={() => setRevokeAll(true)}
          >
            Revoke all connections
          </Button>
          {filter && (
            <Button onClick={() => setFilter(undefined)}>
              Show all connections
            </Button>
          )}
        </Space>
        {connections?.controls?.paused && (
          <div role="status">All your agent communication is paused.</div>
        )}
        {(connections?.connections ?? [])
          .filter(
            (connection) =>
              !filter ||
              connection.source.agent_id === filter ||
              connection.target.agent_id === filter,
          )
          .map((connection) => (
            <Card
              key={connection.link_id}
              size="small"
              style={{ marginTop: 8 }}
            >
              <Space
                orientation="vertical"
                style={{ width: "100%", overflowWrap: "anywhere" }}
              >
                <strong>
                  {endpointLabel(connection.source)} sends to{" "}
                  {endpointLabel(connection.target)}
                </strong>
                <div>
                  Status: {connection.status}.{" "}
                  {connection.expires_at
                    ? `Expires ${new Date(connection.expires_at).toLocaleString()}`
                    : "Never expires"}
                  .
                </div>
                <Space wrap>
                  {(connection.status === "revoked" ||
                    connection.status === "expired") && (
                    <Button
                      disabled={busy || connections?.controls?.paused}
                      onClick={() =>
                        setApproval({
                          source: connection.source,
                          target: connection.target,
                          sourceLabel: endpointLabel(connection.source),
                          targetLabel: endpointLabel(connection.target),
                          sourceName: directory?.agents.find((agent) =>
                            sameEndpoint(agent.endpoint, connection.source),
                          ),
                          targetName: directory?.agents.find((agent) =>
                            sameEndpoint(agent.endpoint, connection.target),
                          ),
                        })
                      }
                    >
                      {connection.status === "revoked"
                        ? "Approve new connection"
                        : "Renew connection"}
                    </Button>
                  )}
                  {connection.status !== "revoked" && (
                    <Button
                      disabled={busy}
                      aria-label={`${connection.paused ? "Resume" : "Pause"} connection ${connection.link_id}`}
                      onClick={() =>
                        connectionAction(
                          connection.direction_group_id,
                          connection.paused ? "active" : "paused",
                        )
                      }
                    >
                      {connection.paused ? "Resume" : "Pause"}
                    </Button>
                  )}
                  {connection.status !== "revoked" && (
                    <Button
                      danger
                      disabled={busy}
                      aria-label={`Revoke connection ${connection.link_id}`}
                      onClick={() =>
                        connectionAction(
                          connection.direction_group_id,
                          "revoked",
                        )
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </Space>
                <details>
                  <summary>Connection details</summary>
                  <p>Reason: {connection.reason}</p>
                  <p>Grant: {connection.link_id}</p>
                  <p>Paired direction group: {connection.direction_group_id}</p>
                  <p>Last attempt: {connection.last_attempt_at ?? "Unknown"}</p>
                  <p>
                    Last accepted: {connection.last_accepted_at ?? "Unknown"}
                  </p>
                </details>
              </Space>
            </Card>
          ))}
        {connections?.connections.length === 0 && (
          <p>
            No connections yet. Select a named agent with @ in an agent composer
            to approve communication there.
          </p>
        )}
      </section>
      <AgentMessagingRequests />
      {approval && (
        <ConnectionApproval
          value={approval}
          onClose={() => {
            setApproval(undefined);
            setRevision((n) => n + 1);
          }}
        />
      )}
      <Modal
        open={revokeAll}
        title="Revoke all your agent connections?"
        okText="Revoke all connections"
        okButtonProps={{ danger: true, disabled: busy }}
        confirmLoading={busy}
        onOk={() => accountAction("revoke_all")}
        onCancel={() => {
          if (!busy) setRevokeAll(false);
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <p>
          This revokes only your grants. Resuming communication later does not
          restore revoked grants. Already accepted work is not canceled.
        </p>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}

export const MY_AGENTS_SETTINGS_PAGE = {
  component: MyAgentsPage,
  description: defineMessage({
    id: "account.settings.my-agents.description",
    defaultMessage:
      "Your named agents and communication permissions across projects.",
  }),
  icon: "robot",
  key: "my-agents",
  label: defineMessage({
    id: "account.settings.my-agents.label",
    defaultMessage: "My Agents",
  }),
} satisfies SettingsPageDefinition;
