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
  AgentNetwork,
  AgentNetworkActivity,
  AgentNetworkDeliveryMode,
  AgentNetworkDirectory,
  AgentNetworkProposal,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { uuid } from "@cocalc/util/misc";
import { personalAgentApi, refreshAgentNetworks, sameEndpoint } from "./api";
import { openAgentThread } from "./open-agent";
import {
  AgentNetworkProposalSummary,
  AgentNetworkSummary,
} from "./agent-network-summary";

const memberKey = (agent: NamedAgent) =>
  `${agent.endpoint.project_id}:${agent.endpoint.agent_id}`;

function networkMemberLabel(network: AgentNetwork, memberId: string) {
  const member = network.members.find(
    ({ member_id }) => member_id === memberId,
  );
  if (!member) return memberId;
  return member.kind === "registered"
    ? member.name
      ? `@${member.name}`
      : (member.thread_title ?? member.member_id)
    : member.label;
}

export function AgentNetworks({ agents }: { agents: NamedAgent[] }) {
  const [directory, setDirectory] = useState<AgentNetworkDirectory>();
  const [activities, setActivities] = useState<
    Record<string, AgentNetworkActivity[]>
  >({});
  const [proposals, setProposals] = useState<AgentNetworkProposal[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState<AgentNetwork>();
  const [renameTitle, setRenameTitle] = useState("");
  const [delivery, setDelivery] = useState<AgentNetworkDeliveryMode>("queued");
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
        personalAgentApi().listAgentNetworks({ limit: 100 }),
        personalAgentApi().listAgentNetworkProposals({ limit: 100 }),
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
        refreshAgentNetworks();
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
        personalAgentApi().createAgentNetwork({
          request_id: requestId(key),
          title: title.trim(),
          delivery_mode: delivery,
          members,
        }),
      "Agent Network created.",
      projects.size > 1,
    );
    if (completed) {
      setCreateOpen(false);
      setSelected([]);
      setTitle("");
      setDelivery("queued");
    }
  }

  async function loadActivity(network: AgentNetwork) {
    try {
      const rows = await personalAgentApi().listAgentNetworkActivity({
        agent_network_id: network.agent_network_id,
        limit: 50,
      });
      setActivities((old) => ({ ...old, [network.agent_network_id]: rows }));
    } catch (err) {
      setError(`${err}`);
    }
  }

  const active =
    directory?.networks.filter(({ state }) => state !== "closed") ?? [];
  return (
    <section aria-labelledby="agent-networks-heading">
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <div>
          <h2 id="agent-networks-heading" style={{ marginBottom: 4 }}>
            Agent Networks
          </h2>
          <p style={{ color: UI_COLORS.secondary }}>
            Every member of a network can message every other member in both
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
            New Agent Network
          </Button>
          <Button disabled={busy} onClick={() => void refresh()}>
            Refresh networks
          </Button>
          {directory && (
            <span role="status">
              {directory.usage.active_networks} active; up to{" "}
              {directory.usage.member_limit} members per network
            </span>
          )}
        </Space>
        {error && (
          <div role="alert">
            <Alert
              type="error"
              title="Agent Networks needs attention"
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
                title={`Proposed: ${proposal.title}`}
                extra={<Tag color="gold">Needs approval</Tag>}
              >
                <Space orientation="vertical" style={{ width: "100%" }}>
                  <p>
                    An authenticated agent proposed a {proposal.delivery_mode}{" "}
                    network with {proposal.members.length} members. This grants
                    no authority until you approve it.
                  </p>
                  <AgentNetworkProposalSummary
                    proposal={proposal}
                    agents={agents}
                  />
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
                            personalAgentApi().resolveAgentNetworkProposal({
                              proposal_id: proposal.proposal_id,
                              action: "approve",
                              request_id: requestId(key),
                            }),
                          "Agent Network proposal approved.",
                          proposedProjects.size > 1,
                        );
                      }}
                    >
                      Approve network
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        const key = `proposal:${proposal.proposal_id}:reject`;
                        void mutate(
                          key,
                          () =>
                            personalAgentApi().resolveAgentNetworkProposal({
                              proposal_id: proposal.proposal_id,
                              action: "reject",
                              request_id: requestId(key),
                            }),
                          "Agent Network proposal rejected.",
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
            No Agent Networks yet. Select at least two named agents to create a
            two-way communication network.
          </Card>
        )}
        {active.map((network) => {
          const projects = new Set(
            network.members.flatMap((member) =>
              member.kind === "registered" ? [member.endpoint.project_id] : [],
            ),
          );
          const rows = activities[network.agent_network_id];
          return (
            <Card key={network.agent_network_id} size="small">
              <Space orientation="vertical" style={{ width: "100%" }}>
                <AgentNetworkSummary network={network} />
                {network.delivery_mode === "live" && (
                  <Alert
                    type="warning"
                    title="Live delivery"
                    description="Every member may interrupt every other member's running turn with agent-provided guidance."
                  />
                )}
                <Space wrap>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setRenaming(network);
                      setRenameTitle(network.title);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    disabled={busy || network.state === "closed"}
                    onClick={() => {
                      const next =
                        network.delivery_mode === "live" ? "queued" : "live";
                      const key = `${network.agent_network_id}:delivery:${next}:${network.generation}`;
                      const apply = () =>
                        mutate(
                          key,
                          () =>
                            personalAgentApi().updateAgentNetwork({
                              request_id: requestId(key),
                              agent_network_id: network.agent_network_id,
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
                            "Every network member may interrupt every other member's running turn. Peer messages remain agent-provided content, not human instructions.",
                          okText: "Enable live delivery",
                          onOk: apply,
                        });
                      } else void apply();
                    }}
                  >
                    Use {network.delivery_mode === "live" ? "queued" : "live"}{" "}
                    delivery
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const action =
                        network.state === "paused" ? "resume" : "pause";
                      const key = `${network.agent_network_id}:${action}:${network.generation}`;
                      void mutate(
                        key,
                        () =>
                          personalAgentApi().updateAgentNetwork({
                            request_id: requestId(key),
                            agent_network_id: network.agent_network_id,
                            action,
                          }),
                        `Network ${action === "pause" ? "paused" : "resumed"}.`,
                        action === "resume" && projects.size > 1,
                      );
                    }}
                  >
                    {network.state === "paused" ? "Resume" : "Pause"}
                  </Button>
                  <Button onClick={() => void loadActivity(network)}>
                    {rows ? "Refresh activity" : "Recent activity"}
                  </Button>
                  <Button
                    danger
                    disabled={busy}
                    onClick={() =>
                      Modal.confirm({
                        title: "Close this Agent Network?",
                        content:
                          "Closing is permanent and blocks future messages. It does not cancel accepted work or erase chat history.",
                        okText: "Close network",
                        okButtonProps: { danger: true },
                        onOk: () => {
                          const key = `${network.agent_network_id}:close:${network.generation}`;
                          return mutate(
                            key,
                            () =>
                              personalAgentApi().updateAgentNetwork({
                                request_id: requestId(key),
                                agent_network_id: network.agent_network_id,
                                action: "close",
                              }),
                            "Agent Network closed.",
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
                  {network.members.map((member) => (
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
                        {networkMemberLabel(network, member.member_id)}
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
                      {network.members.length > 2 && (
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
                              title: `Remove ${networkMemberLabel(network, member.member_id)}?`,
                              content:
                                "This removes every communication direction between this member and every other network member. It does not cancel work already accepted.",
                              okText: "Remove member",
                              okButtonProps: { danger: true },
                              onOk: () => {
                                const key = `${network.agent_network_id}:remove:${member.member_id}:${network.generation}`;
                                return mutate(
                                  key,
                                  () =>
                                    personalAgentApi().updateAgentNetwork({
                                      request_id: requestId(key),
                                      agent_network_id:
                                        network.agent_network_id,
                                      action: "remove-member",
                                      member: locator,
                                    }),
                                  "Member removed from the network.",
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
                  {network.state !== "closed" && (
                    <Select
                      aria-label={`Add member to ${network.title || "Agent Network"}`}
                      placeholder="Add a named agent"
                      style={{ minWidth: 260, marginTop: 12 }}
                      disabled={
                        busy ||
                        network.members.length >=
                          (directory?.usage.member_limit ?? 0)
                      }
                      options={agents
                        .filter(
                          (agent) =>
                            !network.members.some(
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
                          title: `Add @${agent.name} to this Agent Network?`,
                          content:
                            "This immediately authorizes both directions between this agent and every current network member.",
                          okText: "Add member",
                          onOk: () => {
                            const key = `${network.agent_network_id}:add:${value}:${network.generation}`;
                            return mutate(
                              key,
                              () =>
                                personalAgentApi().updateAgentNetwork({
                                  request_id: requestId(key),
                                  agent_network_id: network.agent_network_id,
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
                    aria-label={`Recent activity for ${network.title || "Agent Network"}`}
                  >
                    <strong>Recent activity</strong>
                    <div style={{ marginBlock: 6 }}>
                      {network.members.map((member) => {
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
                            {networkMemberLabel(network, member.member_id)}:{" "}
                            {sent} sent, {received} received
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
                            {networkMemberLabel(network, row.source_member_id)}{" "}
                            to{" "}
                            {networkMemberLabel(network, row.target_member_id)}:{" "}
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
              </Space>
            </Card>
          );
        })}
      </Space>
      <Modal
        open={createOpen}
        title="New Agent Network"
        okText="Create network"
        confirmLoading={busy}
        okButtonProps={{
          disabled:
            !title.trim() ||
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
          <label htmlFor="agent-network-title">Network title</label>
          <Input
            id="agent-network-title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Release review"
          />
          <label htmlFor="agent-network-members">Named agents</label>
          <Select
            id="agent-network-members"
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
            aria-label="Agent Network delivery mode"
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
              description="This network lets every selected agent send content to every selected agent across these projects. Fresh authentication is required."
            />
          )}
        </Space>
      </Modal>
      <Modal
        open={!!renaming}
        title="Rename Agent Network"
        okText="Rename"
        confirmLoading={busy}
        okButtonProps={{ disabled: !renameTitle.trim() }}
        onCancel={() => {
          if (!busy) setRenaming(undefined);
        }}
        onOk={() => {
          if (!renaming || !renameTitle.trim()) return;
          const key = `${renaming.agent_network_id}:title:${renameTitle.trim()}:${renaming.generation}`;
          void mutate(
            key,
            () =>
              personalAgentApi().updateAgentNetwork({
                request_id: requestId(key),
                agent_network_id: renaming.agent_network_id,
                action: "set-title",
                title: renameTitle.trim(),
              }),
            "Agent Network renamed.",
          ).then((completed) => {
            if (completed) setRenaming(undefined);
          });
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <label htmlFor="rename-agent-network">Network title</label>
        <Input
          id="rename-agent-network"
          autoFocus
          value={renameTitle}
          maxLength={120}
          onChange={(event) => setRenameTitle(event.target.value)}
          style={{ marginTop: 6 }}
        />
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </section>
  );
}
