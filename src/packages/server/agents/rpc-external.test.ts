// Messages to an external network member: its inbox holds the files sent
// with a message, and the sender, and only the sender, can ask whether it was
// read.

import { createHash, randomUUID } from "node:crypto";

const sourceProject = randomUUID();
const sourceAgent = randomUUID();
const runId = randomUUID();
const account = randomUUID();
const targetAccount = randomUUID();
const network = randomUUID();
const generation = randomUUID();
const installation = randomUUID();
const externalAgent = randomUUID();

const checkNetwork = jest.fn();
const enqueue = jest.fn();
const inspect = jest.fn();
const attachment = jest.fn();

jest.mock("./store", () => ({
  agentStore: () => ({
    get: async () => ({
      agent_id: sourceAgent,
      project_id: sourceProject,
      path: "/home/user/source.chat",
      thread_id: "source",
    }),
    activeRun: async () => ({ account_id: account }),
    query: async () => ({ rows: [] }),
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
jest.mock("./external", () => ({
  assertExternalAgentLoginEnabled: () => {},
  externalControl: jest.fn(),
  enqueueExternalAgentMessage: (...args: unknown[]) => enqueue(...args),
  inspectExternalAgentMessage: (...args: unknown[]) => inspect(...args),
  externalStore: () => ({
    activeInstallation: async () => ({ agent_id: externalAgent }),
    attachment: (...args: unknown[]) => attachment(...args),
  }),
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: async () => {},
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => false,
  getAccountRevokedBeforeCached: () => undefined,
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async () => ({ bay_id: "bay", epoch: 1 }),
  resolveHostBayAcrossCluster: async () => ({ bay_id: "bay" }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));

import { acceptAgentRpc, acceptExternalAgentRpc } from "./rpc";
import { agentMessagingSubject } from "@cocalc/conat/agents/protocol";
import { externalAgentSubject } from "@cocalc/conat/agents/external";

const source = { project_id: sourceProject, agent_id: sourceAgent };
const target = {
  kind: "external" as const,
  account_id: targetAccount,
  agent_id: externalAgent,
  installation_id: installation,
};
const subject = agentMessagingSubject(sourceAgent, runId);

function file(name: string, text: string) {
  const data = new TextEncoder().encode(text);
  return {
    name,
    size: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    data,
  };
}

function attempt() {
  return {
    version: 3 as const,
    attempt_id: randomUUID(),
    agent_network_id: network,
    target,
  };
}

beforeEach(() => {
  enqueue.mockReset().mockResolvedValue({ message_id: randomUUID() });
  inspect.mockReset();
  attachment.mockReset();
  checkNetwork.mockReset().mockResolvedValue({
    agent_network_id: network,
    network_title: "Ops",
    network_generation: generation,
    account_generation: 1,
    account_id: targetAccount,
    delivery_mode: "queued",
    source: {
      kind: "registered",
      member_id: sourceAgent,
      endpoint: source,
      available: true,
      added_at: new Date().toISOString(),
    },
    target: {
      kind: "external",
      member_id: externalAgent,
      source: target,
      available: true,
      added_at: new Date().toISOString(),
    },
  });
});

test("the sender can ask whether the external member read its message", async () => {
  const request = { ...attempt(), action: "inspect" as const };
  inspect.mockResolvedValueOnce({
    state: "pending",
    created_at: "2026-10-23T10:00:00.000Z",
    expires_at: "2026-10-30T10:00:00.000Z",
  });
  expect(await acceptAgentRpc(subject, request)).toMatchObject({
    outcome: "accepted",
    inbox: { state: "pending" },
    reason: expect.stringMatching(/Not read yet/),
  });
  expect(inspect).toHaveBeenCalledWith({
    account_id: targetAccount,
    installation_id: installation,
    attempt_id: request.attempt_id,
    agent_network_id: network,
    source,
    source_account_id: account,
  });
  inspect.mockResolvedValueOnce({
    state: "acknowledged",
    created_at: "2026-10-23T10:00:00.000Z",
    expires_at: "2026-10-30T10:00:00.000Z",
    acknowledged_at: "2026-10-23T11:00:00.000Z",
  });
  expect(await acceptAgentRpc(subject, request)).toMatchObject({
    outcome: "accepted",
    inbox: { state: "acknowledged" },
    reason: expect.stringMatching(/Read by the external agent/),
  });
  inspect.mockResolvedValueOnce(null);
  expect(await acceptAgentRpc(subject, request)).toMatchObject({
    outcome: "unknown",
  });
  // No turn starts there, so there is nothing to take back.
  expect(
    await acceptAgentRpc(subject, { ...attempt(), action: "withdraw" }),
  ).toMatchObject({ outcome: "rejected", chat_effect: "none" });
});

test("a message records who sent it, so only that account can inspect it", async () => {
  const request = { ...attempt(), action: "send" as const, body: "hello" };
  expect(await acceptAgentRpc(subject, request)).toMatchObject({
    outcome: "accepted",
  });
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      attempt_id: request.attempt_id,
      source: expect.objectContaining(source),
      source_account_id: account,
    }),
  );
});

test("files go to the external inbox with the message", async () => {
  const files = [file("report.md", "# Report\n"), file("log.txt", "ok\n")];
  const manifest = files.map(({ name, size, sha256 }) => ({
    name,
    size,
    sha256,
  }));
  const request = {
    ...attempt(),
    body: "Bug report attached.",
    snapshot_manifest: manifest,
  };
  const prepared: any = await acceptAgentRpc(subject, {
    ...request,
    action: "prepare-attachments",
  });
  expect(prepared).toMatchObject({ outcome: "prepared" });
  expect(prepared.expires_at).toBeGreaterThan(Date.now());
  const sent = await acceptAgentRpc(subject, {
    ...request,
    attachment_reservation: prepared.reservation_id,
    action: "send",
    snapshot_payload: files,
  });
  expect(sent).toMatchObject({ outcome: "accepted", chat_effect: "saved" });
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id: targetAccount,
      installation_id: installation,
      body: "Bug report attached.",
      attachments: files,
    }),
  );
});

test("project paths cannot go to an external member: it has no project", async () => {
  const outcome = await acceptAgentRpc(subject, {
    ...attempt(),
    action: "send",
    body: "See this file.",
    file_references: [{ kind: "project-file", path: "/home/user/a.md" }],
  });
  expect(outcome).toMatchObject({
    outcome: "rejected",
    code: "attachment_unavailable",
    chat_effect: "none",
  });
  expect(enqueue).not.toHaveBeenCalled();
});

test("the external member reads a message's files with its own credential", async () => {
  const message_id = randomUUID();
  attachment.mockResolvedValueOnce({ name: "report.md", index: 0, count: 1 });
  const external = externalAgentSubject(targetAccount, installation);
  expect(
    await acceptExternalAgentRpc(external, {
      version: 3,
      action: "inbox-attachment",
      message_id,
      index: 0,
    }),
  ).toMatchObject({ name: "report.md" });
  expect(attachment).toHaveBeenCalledWith(
    targetAccount,
    installation,
    message_id,
    0,
  );
  // A native agent has no external inbox.
  await expect(
    acceptAgentRpc(subject, {
      version: 3,
      action: "inbox-attachment",
      message_id,
      index: 0,
    }),
  ).rejects.toThrow(/do not have an external inbox/);
});

test("every inspection that finds nothing gets the same answer, so probing learns nothing", async () => {
  const request = { ...attempt(), action: "inspect" as const };
  inspect.mockResolvedValueOnce(null);
  const none = await acceptAgentRpc(subject, request);
  expect(none).toMatchObject({ outcome: "unknown" });
  const same = (outcome: any) =>
    expect({ outcome: outcome.outcome, reason: outcome.reason }).toEqual({
      outcome: none.outcome,
      reason: none.reason,
    });
  // Not a member of that network (or the network names another target).
  checkNetwork.mockResolvedValueOnce({ denied: "not in this network" });
  same(await acceptAgentRpc(subject, request));
  // A network member, but not the installation named in the request.
  const proof = await checkNetwork.getMockImplementation()!();
  checkNetwork.mockResolvedValueOnce({
    ...proof,
    target: {
      ...proof.target,
      source: { ...target, installation_id: randomUUID() },
    },
  });
  same(await acceptAgentRpc(subject, request));
  // Another account than the one named.
  checkNetwork.mockResolvedValueOnce({ ...proof, account_id: randomUUID() });
  same(await acceptAgentRpc(subject, request));
  // A nonexistent, disabled or moving account, or a failing service.
  inspect.mockRejectedValueOnce(new Error("account 1234 is rehoming"));
  const failed = await acceptAgentRpc(subject, request);
  same(failed);
  expect(JSON.stringify(failed)).not.toMatch(/rehoming/);
  // The home was asked only when the network proved the target.
  expect(inspect).toHaveBeenCalledTimes(2);
});

test("a target spelled in uppercase is the same target", async () => {
  const request = {
    ...attempt(),
    agent_network_id: network.toUpperCase(),
    target: {
      kind: "external" as const,
      account_id: targetAccount.toUpperCase(),
      agent_id: externalAgent.toUpperCase(),
      installation_id: installation.toUpperCase(),
    },
    action: "inspect" as const,
  };
  inspect.mockResolvedValueOnce({
    state: "pending",
    created_at: "2026-10-23T10:00:00.000Z",
    expires_at: "2026-10-30T10:00:00.000Z",
  });
  const outcome = await acceptAgentRpc(subject, request);
  expect(outcome).toMatchObject({
    outcome: "accepted",
    inbox: { state: "pending" },
    // The outcome names the target as the caller did.
    target: request.target,
  });
  // The network is checked, and the home asked, in canonical form.
  expect(checkNetwork).toHaveBeenCalledWith(
    account,
    expect.objectContaining({
      options: expect.objectContaining({
        agent_network_id: network,
        target,
      }),
    }),
  );
  expect(inspect).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id: targetAccount,
      installation_id: installation,
      agent_network_id: network,
    }),
  );
});
