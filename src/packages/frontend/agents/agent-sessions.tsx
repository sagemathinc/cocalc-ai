import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Tag,
} from "antd";
import type {
  AgentSession,
  AgentSessionActivity,
  AgentSessionDeliveryMode,
  AgentSessionDirectory,
  AgentSessionProposal,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { uuid } from "@cocalc/util/misc";
import { personalAgentApi, sameEndpoint } from "./api";
import { openAgentThread } from "./open-agent";

const memberKey = (agent: NamedAgent) =>
  `${agent.endpoint.project_id}:${agent.endpoint.agent_id}`;

function sessionMemberLabel(session: AgentSession, memberId: string) {
  const member = session.members.find(
    ({ member_id }) => member_id === memberId,
  );
  if (!member) return memberId;
  return member.kind === "registered"
    ? member.name
      ? `@${member.name}`
      : (member.thread_title ?? member.member_id)
    : member.label;
}

export function AgentSessions({ agents }: { agents: NamedAgent[] }) {
  const [directory, setDirectory] = useState<AgentSessionDirectory>();
  const [activities, setActivities] = useState<
    Record<string, AgentSessionActivity[]>
  >({});
  const [proposals, setProposals] = useState<AgentSessionProposal[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [delivery, setDelivery] = useState<AgentSessionDeliveryMode>("queued");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const revision = useRef(0);
  const requestIds = useRef(new Map<string, string>());
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  async function refresh() {
    const current = ++revision.current;
    setError("");
    try {
      const [next, nextProposals] = await Promise.all([
        personalAgentApi().listAgentSessions({ limit: 100 }),
        personalAgentApi().listAgentSessionProposals({ limit: 100 }),
      ]);
      if (current === revision.current) {
        setDirectory(next);
        setProposals(nextProposals);
      }
    } catch (err) {
      if (current === revision.current) setError(`${err}`);
    }
  }

  useEffect(() => {
    void refresh();
    return () => {
      revision.current += 1;
    };
  }, []);

  function requestId(key: string) {
    let value = requestIds.current.get(key);
    if (!value) {
      value = uuid();
      requestIds.current.set(key, value);
    }
    return value;
  }

  async function mutate(
    key: string,
    action: () => Promise<unknown>,
    success: string,
    requireFresh = false,
  ) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const completed = requireFresh
        ? await runFreshAuthAction(async () => {
            await action();
          })
        : await action().then(() => true);
      if (completed) {
        requestIds.current.delete(key);
        setNotice(success);
        await refresh();
      }
      return completed;
    } catch (err) {
      setError(`${err}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const members = selected.flatMap((key) => {
      const agent = agents.find((candidate) => memberKey(candidate) === key);
      return agent
        ? [{ kind: "registered" as const, endpoint: agent.endpoint }]
        : [];
    });
    const projects = new Set(
      members.map(({ endpoint }) => endpoint.project_id),
    );
    const key = JSON.stringify([
      title.trim(),
      delivery,
      selected.slice().sort(),
    ]);
    const completed = await mutate(
      key,
      () =>
        personalAgentApi().createAgentSession({
          request_id: requestId(key),
          title: title.trim() || undefined,
          delivery_mode: delivery,
          members,
        }),
      "Agent Session created.",
      projects.size > 1,
    );
    if (completed) {
      setCreateOpen(false);
      setSelected([]);
      setTitle("");
      setDelivery("queued");
    }
  }

  async function loadActivity(session: AgentSession) {
    try {
      const rows = await personalAgentApi().listAgentSessionActivity({
        agent_session_id: session.agent_session_id,
        limit: 50,
      });
      setActivities((old) => ({ ...old, [session.agent_session_id]: rows }));
    } catch (err) {
      setError(`${err}`);
    }
  }

  const active =
    directory?.sessions.filter(({ state }) => state !== "closed") ?? [];
  return (
    <section aria-labelledby="agent-sessions-heading">
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <div>
          <h2 id="agent-sessions-heading" style={{ marginBottom: 4 }}>
            Agent Sessions
          </h2>
          <p style={{ color: UI_COLORS.secondary }}>
            Every member of a session can message every other member in both
            directions. Pausing or closing blocks future admission; it does not
            cancel work already accepted.
          </p>
        </div>
        <Space wrap>
          <Button
            type="primary"
            disabled={agents.length < 2 || busy}
            onClick={() => setCreateOpen(true)}
          >
            New Agent Session
          </Button>
          <Button disabled={busy} onClick={() => void refresh()}>
            Refresh sessions
          </Button>
          {directory && (
            <span role="status">
              {directory.usage.active_sessions} active; up to{" "}
              {directory.usage.member_limit} members per session
            </span>
          )}
        </Space>
        {error && (
          <div role="alert">
            <Alert
              type="error"
              title="Agent Sessions needs attention"
              description={error}
            />
          </div>
        )}
        {notice && <div role="status">{notice}</div>}
        {directory?.controls.paused && (
          <Alert
            type="warning"
            title="All agent messaging is paused for this account"
          />
        )}
        {proposals
          .filter(({ state }) => state === "pending")
          .map((proposal) => {
            const proposedProjects = new Set(
              proposal.members.flatMap((member) =>
                member.kind === "registered"
                  ? [member.endpoint.project_id]
                  : [],
              ),
            );
            return (
              <Card
                key={proposal.proposal_id}
                size="small"
                title={`Proposed: ${proposal.title || "Untitled Agent Session"}`}
                extra={<Tag color="gold">Needs approval</Tag>}
              >
                <Space orientation="vertical" style={{ width: "100%" }}>
                  <p>
                    An authenticated agent proposed a {proposal.delivery_mode}{" "}
                    session with {proposal.members.length} members. This grants
                    no authority until you approve it.
                  </p>
                  {proposal.reason && <p>{proposal.reason}</p>}
                  {proposedProjects.size > 1 && (
                    <Alert
                      type="warning"
                      title="Cross-project prompt and data bridge"
                      description="Approval lets every proposed member send content to every other member across these projects."
                    />
                  )}
                  <Space>
                    <Button
                      type="primary"
                      disabled={busy}
                      onClick={() => {
                        const key = `proposal:${proposal.proposal_id}:approve`;
                        void mutate(
                          key,
                          () =>
                            personalAgentApi().resolveAgentSessionProposal({
                              proposal_id: proposal.proposal_id,
                              action: "approve",
                              request_id: requestId(key),
                            }),
                          "Agent Session proposal approved.",
                          proposedProjects.size > 1,
                        );
                      }}
                    >
                      Approve session
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        const key = `proposal:${proposal.proposal_id}:reject`;
                        void mutate(
                          key,
                          () =>
                            personalAgentApi().resolveAgentSessionProposal({
                              proposal_id: proposal.proposal_id,
                              action: "reject",
                              request_id: requestId(key),
                            }),
                          "Agent Session proposal rejected.",
                        );
                      }}
                    >
                      Reject
                    </Button>
                  </Space>
                </Space>
              </Card>
            );
          })}
        {active.length === 0 && directory && (
          <Card size="small">
            No Agent Sessions yet. Select at least two named agents to create a
            two-way communication session.
          </Card>
        )}
        {active.map((session) => {
          const projects = new Set(
            session.members.flatMap((member) =>
              member.kind === "registered" ? [member.endpoint.project_id] : [],
            ),
          );
          const rows = activities[session.agent_session_id];
          return (
            <Card
              key={session.agent_session_id}
              size="small"
              title={session.title || "Untitled Agent Session"}
              extra={
                <Space wrap>
                  <Tag>{session.state}</Tag>
                  <Tag>{session.delivery_mode}</Tag>
                </Space>
              }
            >
              <Space orientation="vertical" style={{ width: "100%" }}>
                <div>
                  {session.members.map((member) => (
                    <Tag key={`${member.kind}:${member.member_id}`}>
                      {sessionMemberLabel(session, member.member_id)}
                    </Tag>
                  ))}
                </div>
                <div>
                  {session.members.length} members across {projects.size || 1}{" "}
                  project{projects.size === 1 ? "" : "s"}. Created{" "}
                  {new Date(session.created_at).toLocaleString()}.
                </div>
                {session.delivery_mode === "live" && (
                  <Alert
                    type="warning"
                    title="Live delivery"
                    description="Every member may interrupt every other member's running turn with agent-provided guidance."
                  />
                )}
                <Space wrap>
                  <Button
                    disabled={busy || session.state === "closed"}
                    onClick={() => {
                      const next =
                        session.delivery_mode === "live" ? "queued" : "live";
                      const key = `${session.agent_session_id}:delivery:${next}:${session.generation}`;
                      const apply = () =>
                        mutate(
                          key,
                          () =>
                            personalAgentApi().updateAgentSession({
                              request_id: requestId(key),
                              agent_session_id: session.agent_session_id,
                              action: "set-delivery",
                              delivery_mode: next,
                            }),
                          `Delivery changed to ${next}.`,
                          next === "live" && projects.size > 1,
                        );
                      if (next === "live") {
                        Modal.confirm({
                          title: "Enable live agent delivery?",
                          content:
                            "Every session member may interrupt every other member's running turn. Peer messages remain agent-provided content, not human instructions.",
                          okText: "Enable live delivery",
                          onOk: apply,
                        });
                      } else void apply();
                    }}
                  >
                    Use {session.delivery_mode === "live" ? "queued" : "live"}{" "}
                    delivery
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const action =
                        session.state === "paused" ? "resume" : "pause";
                      const key = `${session.agent_session_id}:${action}:${session.generation}`;
                      void mutate(
                        key,
                        () =>
                          personalAgentApi().updateAgentSession({
                            request_id: requestId(key),
                            agent_session_id: session.agent_session_id,
                            action,
                          }),
                        `Session ${action === "pause" ? "paused" : "resumed"}.`,
                        action === "resume" && projects.size > 1,
                      );
                    }}
                  >
                    {session.state === "paused" ? "Resume" : "Pause"}
                  </Button>
                  <Button onClick={() => void loadActivity(session)}>
                    {rows ? "Refresh activity" : "Recent activity"}
                  </Button>
                  <Button
                    danger
                    disabled={busy}
                    onClick={() =>
                      Modal.confirm({
                        title: "Close this Agent Session?",
                        content:
                          "Closing is permanent and blocks future messages. It does not cancel accepted work or erase chat history.",
                        okText: "Close session",
                        okButtonProps: { danger: true },
                        onOk: () => {
                          const key = `${session.agent_session_id}:close:${session.generation}`;
                          return mutate(
                            key,
                            () =>
                              personalAgentApi().updateAgentSession({
                                request_id: requestId(key),
                                agent_session_id: session.agent_session_id,
                                action: "close",
                              }),
                            "Agent Session closed.",
                          );
                        },
                      })
                    }
                  >
                    Close
                  </Button>
                </Space>
                <details>
                  <summary>Members and controls</summary>
                  {session.members.map((member) => (
                    <div
                      key={member.member_id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 8,
                        padding: "8px 0",
                        borderBottom: `1px solid ${UI_COLORS.border}`,
                      }}
                    >
                      <strong>
                        {sessionMemberLabel(session, member.member_id)}
                      </strong>
                      <span>{member.kind}</span>
                      {member.kind === "registered" && (
                        <Button
                          size="small"
                          disabled={!member.available}
                          onClick={() => {
                            const agent = agents.find((candidate) =>
                              sameEndpoint(candidate.endpoint, member.endpoint),
                            );
                            if (agent)
                              void openAgentThread({
                                project_id: agent.endpoint.project_id,
                                path: agent.path,
                                thread_id: agent.thread_id,
                              });
                          }}
                        >
                          Open agent
                        </Button>
                      )}
                      {session.members.length > 2 && (
                        <Button
                          size="small"
                          danger
                          disabled={busy}
                          onClick={() => {
                            const locator =
                              member.kind === "registered"
                                ? {
                                    kind: "registered" as const,
                                    endpoint: member.endpoint,
                                  }
                                : {
                                    kind: "external" as const,
                                    agent_id: member.source.agent_id,
                                    installation_id:
                                      member.source.installation_id,
                                  };
                            Modal.confirm({
                              title: `Remove ${sessionMemberLabel(session, member.member_id)}?`,
                              content:
                                "This removes every communication direction between this member and every other session member. It does not cancel work already accepted.",
                              okText: "Remove member",
                              okButtonProps: { danger: true },
                              onOk: () => {
                                const key = `${session.agent_session_id}:remove:${member.member_id}:${session.generation}`;
                                return mutate(
                                  key,
                                  () =>
                                    personalAgentApi().updateAgentSession({
                                      request_id: requestId(key),
                                      agent_session_id:
                                        session.agent_session_id,
                                      action: "remove-member",
                                      member: locator,
                                    }),
                                  "Member removed from the session.",
                                );
                              },
                            });
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  ))}
                  {session.state !== "closed" && (
                    <Select
                      aria-label={`Add member to ${session.title || "Agent Session"}`}
                      placeholder="Add a named agent"
                      style={{ minWidth: 260, marginTop: 12 }}
                      disabled={
                        busy ||
                        session.members.length >=
                          (directory?.usage.member_limit ?? 0)
                      }
                      options={agents
                        .filter(
                          (agent) =>
                            !session.members.some(
                              (member) =>
                                member.kind === "registered" &&
                                sameEndpoint(member.endpoint, agent.endpoint),
                            ),
                        )
                        .map((agent) => ({
                          value: memberKey(agent),
                          label: `@${agent.name} - ${agent.project_title ?? "Project"}`,
                        }))}
                      onChange={(value) => {
                        const agent = agents.find(
                          (candidate) => memberKey(candidate) === value,
                        );
                        if (!agent) return;
                        Modal.confirm({
                          title: `Add @${agent.name} to this Agent Session?`,
                          content:
                            "This immediately authorizes both directions between this agent and every current session member.",
                          okText: "Add member",
                          onOk: () => {
                            const key = `${session.agent_session_id}:add:${value}:${session.generation}`;
                            return mutate(
                              key,
                              () =>
                                personalAgentApi().updateAgentSession({
                                  request_id: requestId(key),
                                  agent_session_id: session.agent_session_id,
                                  action: "add-member",
                                  member: {
                                    kind: "registered",
                                    endpoint: agent.endpoint,
                                  },
                                }),
                              `@${agent.name} added. Every member can now message every other member.`,
                              !projects.has(agent.endpoint.project_id) &&
                                projects.size > 0,
                            );
                          },
                        });
                      }}
                    />
                  )}
                </details>
                {rows && (
                  <div
                    aria-label={`Recent activity for ${session.title || "Agent Session"}`}
                  >
                    <strong>Recent activity</strong>
                    <div style={{ marginBlock: 6 }}>
                      {session.members.map((member) => {
                        const sent = rows.filter(
                          ({ source_member_id }) =>
                            source_member_id === member.member_id,
                        ).length;
                        const received = rows.filter(
                          ({ target_member_id }) =>
                            target_member_id === member.member_id,
                        ).length;
                        return (
                          <Tag key={`activity:${member.member_id}`}>
                            {sessionMemberLabel(session, member.member_id)}: {sent}{" "}
                            sent, {received} received
                          </Tag>
                        );
                      })}
                    </div>
                    {rows.length === 0 ? (
                      <p>No retained activity.</p>
                    ) : (
                      <ul>
                        {rows.map((row) => (
                          <li key={row.attempt_id}>
                            {sessionMemberLabel(session, row.source_member_id)}{" "}
                            to{" "}
                            {sessionMemberLabel(session, row.target_member_id)}:{" "}
                            {row.outcome ?? "pending"}
                            {row.effective_delivery
                              ? ` via ${row.effective_delivery}`
                              : ""}
                            , {new Date(row.observed_at).toLocaleString()}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <details>
                  <summary>Session identifiers</summary>
                  <p>Session: {session.agent_session_id}</p>
                  <p>Generation: {session.generation}</p>
                </details>
              </Space>
            </Card>
          );
        })}
      </Space>
      <Modal
        open={createOpen}
        title="New Agent Session"
        okText="Create session"
        confirmLoading={busy}
        okButtonProps={{
          disabled:
            selected.length < 2 ||
            selected.length > (directory?.usage.member_limit ?? 0),
        }}
        onOk={() => void create()}
        onCancel={() => {
          if (!busy) setCreateOpen(false);
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <label htmlFor="agent-session-title">Session title</label>
          <Input
            id="agent-session-title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Release review"
          />
          <label htmlFor="agent-session-members">Named agents</label>
          <Select
            id="agent-session-members"
            mode="multiple"
            value={selected}
            onChange={setSelected}
            style={{ width: "100%" }}
            placeholder="Select at least two agents"
            options={agents.map((agent) => ({
              value: memberKey(agent),
              label: `@${agent.name} - ${agent.project_title ?? "Project"}`,
            }))}
          />
          <div>
            Every selected agent can message every other selected agent in both
            directions. Adding members later expands that complete graph.
          </div>
          <Radio.Group
            aria-label="Agent Session delivery mode"
            value={delivery}
            onChange={(event) => setDelivery(event.target.value)}
          >
            <Radio value="queued">Queued (recommended)</Radio>
            <Radio value="live">Live</Radio>
          </Radio.Group>
          {delivery === "live" && (
            <Alert
              type="warning"
              title="Live delivery can interrupt running turns"
              description="Every member may steer every other member while it is running. Messages are still agent-provided content, not human instructions."
            />
          )}
          {new Set(
            selected.flatMap((key) => {
              const agent = agents.find(
                (candidate) => memberKey(candidate) === key,
              );
              return agent ? [agent.endpoint.project_id] : [];
            }),
          ).size > 1 && (
            <Alert
              type="warning"
              title="Cross-project prompt and data bridge"
              description="This session lets every selected agent send content to every selected agent across these projects. Fresh authentication is required."
            />
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </section>
  );
}
