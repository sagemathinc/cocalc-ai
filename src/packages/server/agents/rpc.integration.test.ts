import { randomUUID } from "node:crypto";

const sourceProject = randomUUID();
const targetProject = randomUUID();
const sourceAgent = randomUUID();
const targetAgent = randomUUID();
const runId = randomUUID();
const account = randomUUID();
const host = randomUUID();
const network = randomUUID();
const generation = randomUUID();

const identities = new Map([
  [
    sourceAgent,
    {
      agent_id: sourceAgent,
      project_id: sourceProject,
      path: "/home/user/source.chat",
      thread_id: "source",
    },
  ],
  [
    targetAgent,
    {
      agent_id: targetAgent,
      project_id: targetProject,
      path: "/home/user/target.chat",
      thread_id: "target",
    },
  ],
]);
const checkNetwork = jest.fn();
const assertHost = jest.fn(async () => {});
const submitAgentRpc = jest.fn();
const remoteSubmit = jest.fn();
let remoteTarget = false;
const query = jest.fn(async () => ({
  rows: [{ host_id: host, state: "running" }],
}));

jest.mock("./store", () => ({
  agentStore: () => ({
    get: async (agent_id: string) => identities.get(agent_id),
    activeRun: async () => ({ account_id: account }),
    query,
  }),
}));
jest.mock("./access", () => ({
  assertActor: async () => {},
  assertAgent: async () => {},
  assertRun: async () => {},
}));
jest.mock("./personal", () => ({
  withPersonalHome: (...args: unknown[]) => checkNetwork(...args),
  personalControl: jest.fn(),
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: (...args: unknown[]) =>
    assertHost(...args),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => false,
  getAccountRevokedBeforeCached: () => undefined,
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "target-bay",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async () => ({
    bay_id: remoteTarget ? "remote-bay" : "target-bay",
    epoch: 1,
  }),
  resolveHostBayAcrossCluster: async () => ({ bay_id: "target-bay" }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/agent-rpc", () => ({
  createAgentRpcControlClient: () => ({
    submit: (...args) => remoteSubmit(...args),
  }),
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitHostControlClient: async () => ({}),
}));
jest.mock("@cocalc/conat/project-host/api", () => ({
  createHostControlClient: () => ({ submitAgentRpc }),
}));
jest.mock("./admission-state", () => ({
  createAgentRpcAdmissionState: async () => {},
  deleteAgentRpcAdmissionState: async () => {},
  claimAgentRpcAdmissionState: async () => undefined,
  getAgentRpcAdmissionState: async () => undefined,
  hashAgentRpcAdmissionBinding: () => "binding",
}));

import { acceptAgentRpc, agentRpcControl, authorizeRpcExecution } from "./rpc";
import { agentMessagingSubject } from "@cocalc/conat/agents/protocol";

const source = { project_id: sourceProject, agent_id: sourceAgent };
const target = { project_id: targetProject, agent_id: targetAgent };
const sourceMember = {
  kind: "registered" as const,
  member_id: sourceAgent,
  endpoint: source,
  available: true,
  added_at: new Date().toISOString(),
};
const targetMember = {
  kind: "registered" as const,
  member_id: targetAgent,
  endpoint: target,
  available: true,
  added_at: new Date().toISOString(),
};

function authorization() {
  return {
    version: 3 as const,
    source,
    source_run_id: runId,
    target,
    target_path: "/home/user/target.chat",
    target_thread_id: "target",
    agent_network_id: network,
    network_generation: generation,
    account_generation: 4,
    configured_delivery: "queued" as const,
    principal_account_id: account,
    guidance: false,
  };
}

function networkAuthorization() {
  return {
    agent_network_id: network,
    network_title: "Review",
    network_generation: generation,
    account_generation: 4,
    account_id: account,
    delivery_mode: "queued" as const,
    source: sourceMember,
    target: targetMember,
  };
}

beforeEach(() => {
  remoteTarget = false;
  remoteSubmit.mockReset();
  assertHost.mockClear();
  query.mockClear();
  submitAgentRpc.mockReset().mockImplementation(async (envelope) => ({
    version: 3,
    target: envelope.target,
    attempt_id: envelope.attempt_id,
    agent_network_id: envelope.agent_network_id,
    outcome: "accepted",
    observed_at: Date.now(),
  }));
  checkNetwork.mockReset().mockResolvedValue({
    agent_network_id: network,
    network_title: "Review",
    network_generation: generation,
    account_generation: 4,
    account_id: account,
    delivery_mode: "queued",
    source: sourceMember,
    target: targetMember,
  });
});

test("lost broadcast acknowledgment stays unknown on replay without resubmission", async () => {
  remoteTarget = true;
  let persisted: any;
  checkNetwork.mockImplementation(async (_account, request) => {
    if (request.action === "beginBroadcast")
      return persisted
        ? { claimed: false, binding_hash: "binding", outcome: persisted }
        : {
            claimed: true,
            binding_hash: "binding",
            authorizations: [networkAuthorization()],
          };
    if (request.action === "finishBroadcast")
      persisted = request.options.outcome;
  });
  remoteSubmit.mockRejectedValue(new Error("ack lost after acceptance"));
  const request = {
    version: 3 as const,
    action: "broadcast" as const,
    broadcast_id: randomUUID(),
    agent_network_id: network,
    targets: [target],
    body: "hello",
  };
  const subject = agentMessagingSubject(sourceAgent, runId);
  const result = await acceptAgentRpc(subject, request);
  expect(result).toMatchObject({
    outcome: "unknown",
    children: [{ outcome: "unknown" }],
  });
  expect(persisted.children[0].chat_effect).not.toBe("none");
  expect(await acceptAgentRpc(subject, request)).toEqual(result);
  expect(remoteSubmit).toHaveBeenCalledTimes(1);
});

test("cross-bay submission does not require the source identity in the target bay", async () => {
  const sourceIdentity = identities.get(sourceAgent)!;
  identities.delete(sourceAgent);
  try {
    await expect(
      agentRpcControl.submit({
        account_id: account,
        project_id: targetProject,
        route: { bay_id: "target-bay", epoch: 1 },
        source,
        run_id: runId,
        request: {
          version: 3,
          attempt_id: randomUUID(),
          agent_network_id: network,
          target,
          body: "hello",
        },
      }),
    ).resolves.toMatchObject({ outcome: "accepted" });
    expect(submitAgentRpc).toHaveBeenCalledTimes(1);
    expect(submitAgentRpc.mock.calls[0][0]).toMatchObject({
      network_title: "Review",
    });
  } finally {
    identities.set(sourceAgent, sourceIdentity);
  }
});

test("broadcast snapshot skips redundant pre-submit network materialization", async () => {
  await expect(
    agentRpcControl.submit({
      account_id: account,
      project_id: targetProject,
      route: { bay_id: "target-bay", epoch: 1 },
      source,
      run_id: runId,
      request: {
        version: 3,
        attempt_id: randomUUID(),
        agent_network_id: network,
        target,
        body: "hello",
      },
      authorization: networkAuthorization(),
    }),
  ).resolves.toMatchObject({ outcome: "accepted" });
  expect(
    checkNetwork.mock.calls.filter(
      ([, request]) => request?.action === "checkNetwork",
    ),
  ).toHaveLength(0);
  expect(submitAgentRpc).toHaveBeenCalledTimes(1);
});

test("mismatched broadcast snapshots fail before host submission", async () => {
  await expect(
    agentRpcControl.submit({
      account_id: account,
      project_id: targetProject,
      route: { bay_id: "target-bay", epoch: 1 },
      source,
      run_id: runId,
      request: {
        version: 3,
        attempt_id: randomUUID(),
        agent_network_id: network,
        target,
        body: "hello",
      },
      authorization: {
        ...networkAuthorization(),
        network_generation: randomUUID(),
        agent_network_id: randomUUID(),
      },
    }),
  ).resolves.toMatchObject({ outcome: "rejected" });
  expect(
    checkNetwork.mock.calls.filter(
      ([, request]) => request?.action === "checkNetwork",
    ),
  ).toHaveLength(0);
  expect(submitAgentRpc).not.toHaveBeenCalled();
});

test("queued execution rechecks the exact network authority and host principal", async () => {
  const auth = authorization();
  await expect(
    authorizeRpcExecution({
      account_id: account,
      host_id: host,
      authorization: auth,
    }),
  ).resolves.toBeUndefined();
  expect(assertHost).toHaveBeenCalledWith({
    account_id: account,
    host_id: host,
    project_id: targetProject,
  });
  expect(checkNetwork).toHaveBeenCalledWith(account, {
    action: "checkNetwork",
    options: {
      agent_network_id: network,
      source,
      run_id: runId,
      target,
    },
  });
});

test.each([
  ["network generation", { network_generation: randomUUID() }],
  ["account generation", { account_generation: 5 }],
  ["delivery mode", { configured_delivery: "live", guidance: true }],
])("%s mutation rejects already queued work", async (_label, patch) => {
  await expect(
    authorizeRpcExecution({
      account_id: account,
      host_id: host,
      authorization: { ...authorization(), ...patch } as any,
    }),
  ).rejects.toThrow("network_stale");
});

test("a different execution principal fails before network use", async () => {
  await expect(
    authorizeRpcExecution({
      account_id: randomUUID(),
      host_id: host,
      authorization: authorization(),
    }),
  ).rejects.toThrow("principal_mismatch");
  expect(checkNetwork).not.toHaveBeenCalled();
});

test("changed target identity fails before queued execution", async () => {
  identities.set(targetAgent, {
    ...identities.get(targetAgent)!,
    path: "/home/user/replaced.chat",
  });
  try {
    await expect(
      authorizeRpcExecution({
        account_id: account,
        host_id: host,
        authorization: authorization(),
      }),
    ).rejects.toThrow("target identity changed");
  } finally {
    identities.set(targetAgent, {
      ...identities.get(targetAgent)!,
      path: "/home/user/target.chat",
    });
  }
});
