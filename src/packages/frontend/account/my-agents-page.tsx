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
import {
  formatConnectionTime,
  groupPersonalConnections,
  latestConnectionObservation,
} from "@cocalc/frontend/agents/connection-groups";

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
      style={{ width: "100%", maxWidth: 1000, minWidth: 0 }}
    >
      <p>
        Your names and communication permissions across all projects on this
        site. Listing agents reads metadata only; Open navigates to their
        existing thread. Shared chat history remains shared.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
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
      </div>
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
        {groupPersonalConnections(connections?.connections ?? [])
          .filter(
            (group) =>
              !filter ||
              group.connections.some(
                (connection) =>
                  connection.source.agent_id === filter ||
                  connection.target.agent_id === filter,
              ),
          )
          .map((group) => {
            const connection = group.connections[0];
            const statuses = [
              ...new Set(group.connections.map((entry) => entry.status)),
            ];
            const expiries = [
              ...new Set(group.connections.map((entry) => entry.expires_at)),
            ];
            const allRevoked = statuses.every((status) => status === "revoked");
            const needsApproval = statuses.some(
              (status) => status === "revoked" || status === "expired",
            );
            const allPaused = group.connections.every((entry) => entry.paused);
            const label = group.bidirectional
              ? `${endpointLabel(connection.source)} and ${endpointLabel(connection.target)}`
              : `${endpointLabel(connection.source)} sends to ${endpointLabel(connection.target)}`;
            return (
              <Card
                key={group.id}
                role="group"
                aria-label={`Connection: ${label}`}
                size="small"
                style={{ marginTop: 8 }}
              >
                <Space
                  orientation="vertical"
                  style={{ width: "100%", overflowWrap: "anywhere" }}
                >
                  <strong>{label}</strong>
                  {group.bidirectional && (
                    <div>Communication in both directions</div>
                  )}
                  <div>
                    Status: {statuses.join(" / ")}
                    {statuses.length > 1 ? " (varies by direction)" : ""}.{" "}
                    {expiries.length > 1
                      ? "Expiry varies by direction"
                      : connection.expires_at == null
                        ? "Never expires"
                        : `Expires ${formatConnectionTime(connection.expires_at)}`}
                    .
                  </div>
                  <div>
                    Last observed attempt
                    {group.bidirectional ? " (either direction)" : ""}:{" "}
                    {formatConnectionTime(
                      latestConnectionObservation(
                        group.connections,
                        "last_attempt_at",
                      ),
                    )}
                  </div>
                  <div>
                    Last observed acceptance
                    {group.bidirectional ? " (either direction)" : ""}:{" "}
                    {formatConnectionTime(
                      latestConnectionObservation(
                        group.connections,
                        "last_accepted_at",
                      ),
                    )}
                  </div>
                  <Space wrap>
                    {needsApproval && (
                      <Button
                        disabled={busy || connections?.controls?.paused}
                        onClick={() =>
                          setApproval({
                            source: connection.source,
                            target: connection.target,
                            sourceLabel: endpointLabel(connection.source),
                            targetLabel: endpointLabel(connection.target),
                            bothDirections: group.bidirectional,
                            sourceName: directory?.agents.find((agent) =>
                              sameEndpoint(agent.endpoint, connection.source),
                            ),
                            targetName: directory?.agents.find((agent) =>
                              sameEndpoint(agent.endpoint, connection.target),
                            ),
                          })
                        }
                      >
                        {statuses.includes("revoked")
                          ? "Approve new connection"
                          : "Renew connection"}
                      </Button>
                    )}
                    {!allRevoked && (!allPaused || !needsApproval) && (
                      <Button
                        disabled={busy}
                        aria-label={`${allPaused ? "Resume" : "Pause"} connection: ${label}`}
                        onClick={() =>
                          connectionAction(
                            group.id,
                            allPaused ? "active" : "paused",
                          )
                        }
                      >
                        {allPaused ? "Resume" : "Pause"}
                      </Button>
                    )}
                    {!allRevoked && (
                      <Button
                        danger
                        disabled={busy}
                        aria-label={`Revoke connection: ${label}`}
                        onClick={() => connectionAction(group.id, "revoked")}
                      >
                        Revoke
                      </Button>
                    )}
                  </Space>
                  <details>
                    <summary>Connection details</summary>
                    <p>Direction group: {group.id}</p>
                    {group.connections.map((direction) => (
                      <div key={direction.link_id}>
                        <strong>
                          {endpointLabel(direction.source)} sends to{" "}
                          {endpointLabel(direction.target)}
                        </strong>
                        <p>Direction status: {direction.status}</p>
                        <p>
                          Expires:{" "}
                          {direction.expires_at == null
                            ? "Never expires"
                            : formatConnectionTime(direction.expires_at)}
                        </p>
                        <p>Reason: {direction.reason}</p>
                        <p>Grant: {direction.link_id}</p>
                        <p>
                          Last attempt:{" "}
                          {formatConnectionTime(direction.last_attempt_at)}
                        </p>
                        <p>
                          Last accepted:{" "}
                          {formatConnectionTime(direction.last_accepted_at)}
                        </p>
                      </div>
                    ))}
                  </details>
                </Space>
              </Card>
            );
          })}
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
