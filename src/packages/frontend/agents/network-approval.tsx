import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Radio, Space, Spin } from "antd";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import type {
  AgentNetwork,
  AgentNetworkDirectory,
  AgentNetworkMember,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { uuid } from "@cocalc/util/misc";
import { personalAgentApi, sameEndpoint } from "./api";
import { useBoundAgentAccount } from "./use-bound-account";
import { useSourceAgentName } from "./source-agent-name";
import type { AgentNameContext } from "./name-context";
import { cachedAgentNameContext } from "./name-context";
import { AgentNetworkSummary } from "./agent-network-summary";

const NEW_NETWORK = "new";

export interface NetworkApprovalTarget {
  source: AgentEndpoint;
  target: AgentEndpoint;
  sourceLabel: string;
  targetLabel: string;
  sourceName?: NamedAgent;
  sourceContext?: AgentNameContext;
  targetName?: NamedAgent;
  namingAccountId?: string;
}

function registeredMember(
  network: AgentNetwork,
  endpoint: AgentEndpoint,
): AgentNetworkMember | undefined {
  return network.members.find(
    (member) =>
      member.kind === "registered" && sameEndpoint(member.endpoint, endpoint),
  );
}

function networkLabel(network: AgentNetwork): string {
  return network.title?.trim() || "Untitled Agent Network";
}

async function loadAllNetworks(): Promise<AgentNetworkDirectory> {
  let cursor: string | undefined;
  let directory: AgentNetworkDirectory | undefined;
  const networks: AgentNetwork[] = [];
  do {
    const page = await personalAgentApi().listAgentNetworks({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    directory = page;
    networks.push(...page.networks);
    cursor = page.next_cursor;
  } while (cursor && networks.length < 1000);
  if (!directory) throw new Error("Agent Networks are unavailable");
  return { ...directory, networks };
}

export function NetworkApproval({
  value,
  onClose,
}: {
  value: NetworkApprovalTarget;
  onClose: (approved: boolean) => void;
}) {
  const boundAccount = useBoundAgentAccount();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [directory, setDirectory] = useState<AgentNetworkDirectory>();
  const [selection, setSelection] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const loadRevision = useRef(0);
  const requestIds = useRef(new Map<string, string>());
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const sourceNaming = useSourceAgentName(
    value.source,
    value.sourceName,
    busy,
    value.sourceContext,
  );
  const sourceContext = value.sourceContext
    ? cachedAgentNameContext(value.sourceContext)
    : undefined;

  const targetNetworks =
    directory?.networks.filter(
      (network) =>
        network.state === "active" && !!registeredMember(network, value.target),
    ) ?? [];
  const sharedNetwork = targetNetworks.find((network) =>
    registeredMember(network, value.source),
  );
  const joinableNetworks = targetNetworks.filter(
    (network) =>
      !registeredMember(network, value.source) &&
      network.members.length < (directory?.usage.member_limit ?? 0),
  );
  const selectedNetwork = joinableNetworks.find(
    ({ agent_network_id }) => agent_network_id === selection,
  );
  const selectedProjects = new Set(
    selectedNetwork?.members.flatMap((member) =>
      member.kind === "registered" ? [member.endpoint.project_id] : [],
    ) ?? [],
  );
  const crossesProject = selectedNetwork
    ? selectedProjects.size > 0 &&
      !selectedProjects.has(value.source.project_id)
    : value.source.project_id !== value.target.project_id;
  const creating = selection === NEW_NETWORK;
  const atNetworkLimit =
    !!directory &&
    directory.usage.active_networks >= directory.usage.network_limit;
  const canSubmit =
    !busy &&
    !loading &&
    !loadError &&
    sourceNaming.canApprove &&
    (!!sharedNetwork ||
      !!selectedNetwork ||
      (creating && !!newTitle.trim() && !atNetworkLimit));

  function requestId(key: string): string {
    let request = requestIds.current.get(key);
    if (!request) {
      request = uuid();
      requestIds.current.set(key, request);
    }
    return request;
  }

  async function load() {
    const revision = ++loadRevision.current;
    setLoading(true);
    setLoadError("");
    try {
      const next = await loadAllNetworks();
      if (!alive.current || revision !== loadRevision.current) return;
      setDirectory(next);
      const activeForTarget = next.networks.filter(
        (network) =>
          network.state === "active" &&
          !!registeredMember(network, value.target),
      );
      const shared = activeForTarget.find((network) =>
        registeredMember(network, value.source),
      );
      const firstJoinable = activeForTarget.find(
        (network) =>
          !registeredMember(network, value.source) &&
          network.members.length < next.usage.member_limit,
      );
      setSelection(
        shared?.agent_network_id ??
          firstJoinable?.agent_network_id ??
          NEW_NETWORK,
      );
    } catch (err) {
      if (alive.current && revision === loadRevision.current)
        setLoadError(`${err}`);
    } finally {
      if (alive.current && revision === loadRevision.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      loadRevision.current += 1;
    };
  }, []);

  async function connect() {
    if (lock.current || !canSubmit) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      boundAccount.assertCurrent();
      await sourceNaming.ensureNamed();
      boundAccount.assertCurrent();
      if (!alive.current) throw new Error("The network context changed.");
      if (sharedNetwork) {
        onClose(true);
        return;
      }
      const completed = await runFreshAuthAction(async () => {
        boundAccount.assertCurrent();
        if (selectedNetwork) {
          const key = `join:${selectedNetwork.agent_network_id}:${value.source.agent_id}:${selectedNetwork.generation}`;
          await personalAgentApi().updateAgentNetwork({
            request_id: requestId(key),
            agent_network_id: selectedNetwork.agent_network_id,
            action: "add-member",
            member: { kind: "registered", endpoint: value.source },
          });
        } else {
          const title = newTitle.trim();
          const key = `create:${title}:${value.source.agent_id}:${value.target.agent_id}`;
          await personalAgentApi().createAgentNetwork({
            request_id: requestId(key),
            title,
            delivery_mode: "queued",
            members: [
              { kind: "registered", endpoint: value.source },
              { kind: "registered", endpoint: value.target },
            ],
          });
        }
      });
      if (!completed) return;
      requestIds.current.clear();
      if (alive.current) onClose(true);
    } catch (err) {
      setError(`${err}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (!boundAccount.current) return null;
  const sourceLabel = sourceNaming.known
    ? `@${sourceNaming.known.name}`
    : value.sourceLabel;
  return (
    <>
      <Modal
        open
        width={640}
        title="Connect agents"
        okText={
          sharedNetwork
            ? "Use shared network"
            : selectedNetwork
              ? "Join network"
              : "Create network"
        }
        confirmLoading={busy}
        okButtonProps={{ disabled: !canSubmit }}
        onOk={() => void connect()}
        onCancel={() => {
          if (!busy) onClose(false);
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <p style={{ margin: 0 }}>
            Connect <strong>{sourceLabel}</strong> with{" "}
            <strong>{value.targetLabel}</strong> through a topic-oriented Agent
            Network.
          </p>
          <div style={{ color: UI_COLORS.secondary }}>
            {sourceContext?.thread_title ?? value.sourceLabel} /{" "}
            {sourceContext?.project_title ?? "Project name unavailable"}
            <span aria-hidden="true"> → </span>
            {value.targetName?.thread_title ?? value.targetLabel} /{" "}
            {value.targetName?.project_title ?? "Project name unavailable"}
          </div>
          {sourceNaming.field}
          {loading && (
            <div role="status" style={{ textAlign: "center", padding: 20 }}>
              <Spin /> Loading {value.targetLabel}&apos;s networks...
            </div>
          )}
          {loadError && (
            <Alert
              type="error"
              title="Unable to load Agent Networks"
              description={
                <Space orientation="vertical">
                  <span>{loadError}</span>
                  <Button size="small" onClick={() => void load()}>
                    Try again
                  </Button>
                </Space>
              }
            />
          )}
          {!loading && !loadError && sharedNetwork && (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Alert
                type="success"
                title="These agents already share a network"
              />
              <AgentNetworkSummary network={sharedNetwork} compact />
            </Space>
          )}
          {!loading && !loadError && !sharedNetwork && (
            <Radio.Group
              aria-label="Choose an Agent Network"
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
              style={{ width: "100%" }}
            >
              <Space orientation="vertical" style={{ width: "100%" }}>
                {joinableNetworks.length > 0 && (
                  <strong>Join an existing network</strong>
                )}
                {joinableNetworks.map((network) => (
                  <div
                    key={network.agent_network_id}
                    style={{
                      border: `1px solid ${selection === network.agent_network_id ? UI_COLORS.info : UI_COLORS.border}`,
                      borderRadius: 8,
                      padding: "10px 12px",
                      background:
                        selection === network.agent_network_id
                          ? UI_COLORS.infoBg
                          : UI_COLORS.surface,
                    }}
                  >
                    <Radio value={network.agent_network_id}>
                      <strong>{networkLabel(network)}</strong>
                    </Radio>
                    <div style={{ margin: "7px 0 0 24px" }}>
                      <AgentNetworkSummary network={network} compact />
                    </div>
                  </div>
                ))}
                {targetNetworks.length > joinableNetworks.length && (
                  <div style={{ color: UI_COLORS.secondary }}>
                    {targetNetworks.length - joinableNetworks.length} other
                    active network
                    {targetNetworks.length - joinableNetworks.length === 1
                      ? " is"
                      : "s are"}{" "}
                    full.
                  </div>
                )}
                <div
                  style={{
                    border: `1px solid ${creating ? UI_COLORS.info : UI_COLORS.border}`,
                    borderRadius: 8,
                    padding: "10px 12px",
                    background: creating ? UI_COLORS.infoBg : UI_COLORS.surface,
                  }}
                >
                  <Radio value={NEW_NETWORK} disabled={atNetworkLimit}>
                    <strong>Create a new topic network</strong>
                  </Radio>
                  {creating && (
                    <div style={{ margin: "9px 0 0 24px" }}>
                      <label htmlFor="new-agent-network-topic">
                        Network topic
                      </label>
                      <Input
                        id="new-agent-network-topic"
                        autoFocus
                        value={newTitle}
                        maxLength={120}
                        onChange={(event) => setNewTitle(event.target.value)}
                        placeholder="Illustration work"
                        style={{ marginTop: 5 }}
                      />
                    </div>
                  )}
                </div>
              </Space>
            </Radio.Group>
          )}
          {selectedNetwork && (
            <Alert
              type="info"
              title={`Add ${sourceLabel} to ${networkLabel(selectedNetwork)}`}
              description={`${sourceLabel} will be able to message every current member, and every member will be able to message ${sourceLabel}.`}
            />
          )}
          {crossesProject && !sharedNetwork && (
            <Alert
              type="warning"
              title="Cross-project prompt and data bridge"
              description="This expands the network into another project. Fresh authentication is required before the change is applied."
            />
          )}
          {!sharedNetwork && (
            <p style={{ margin: 0, color: UI_COLORS.secondary }}>
              Connecting grants permission only. It does not send this draft or
              start any agent. Messages use the selected network&apos;s delivery
              mode; new networks start with queued delivery.
            </p>
          )}
          {error && (
            <div role="alert">
              <Alert
                type="error"
                title="Unable to connect agents"
                description={error}
              />
            </div>
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
