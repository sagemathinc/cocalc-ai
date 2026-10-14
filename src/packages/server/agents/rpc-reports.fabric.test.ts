/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

// A (the sender) is on a-bay, B (whose turn failed) on b-bay. B's host
// reports to b-bay's hub, which forwards over a real conat server to a-bay's
// agent-messaging service, which writes into A's chat on A's host. One
// process plays both bays here; src/scripts/multibay checks the same route
// between two real bays.
process.env.COCALC_CLUSTER_SHARED_SECRET = "test-cluster-secret";

const aProject = randomUUID();
const bProject = randomUUID();
const aAgent = randomUUID();
const bAgent = randomUUID();
const runId = randomUUID();
const account = randomUUID();
const aHost = randomUUID();
const bHost = randomUUID();
const network = randomUUID();
const generation = randomUUID();
const attempt = randomUUID();

let mockBay = "b-bay";
const mockIdentities = new Map<string, any>([
  [
    aAgent,
    {
      agent_id: aAgent,
      project_id: aProject,
      path: "/home/user/a.chat",
      thread_id: "thread-a",
    },
  ],
  [
    bAgent,
    {
      agent_id: bAgent,
      project_id: bProject,
      path: "/home/user/b.chat",
      thread_id: "thread-b",
    },
  ],
]);
const mockCheckNetwork = jest.fn();
const mockHostOf = jest.fn();
const mockDeliver = jest.fn();

jest.mock("./store", () => ({
  agentStore: () => ({
    get: async (agent_id: string) => mockIdentities.get(agent_id),
    query: async () => ({ rows: [{ host_id: aHost, state: "running" }] }),
  }),
}));
jest.mock("./access", () => ({
  assertActor: async () => {},
  assertAgent: async () => {},
  assertRun: async () => {},
}));
jest.mock("./personal", () => ({
  withPersonalHome: (...args: unknown[]) => mockCheckNetwork(...args),
  personalControl: jest.fn(),
}));
jest.mock("./external", () => ({
  assertExternalAgentLoginEnabled: jest.fn(),
  externalControl: jest.fn(),
  enqueueExternalAgentMessage: jest.fn(),
  externalStore: jest.fn(),
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
  getConfiguredBayId: () => mockBay,
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async (project_id: string) => ({
    bay_id: project_id === aProject ? "a-bay" : "b-bay",
    epoch: 1,
  }),
  resolveHostBayAcrossCluster: async () => ({ bay_id: mockBay }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => require("@cocalc/server/test").client,
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitHostControlClient: async ({ host_id }: { host_id: string }) => {
    mockHostOf(mockBay, host_id);
    return {};
  },
}));
jest.mock("@cocalc/conat/project-host/api", () => ({
  createHostControlClient: () => ({
    deliverAgentRpcReport: (...args: unknown[]) => mockDeliver(...args),
  }),
}));
jest.mock("./admission-state", () => ({}));
jest.mock("./rpc-report-executions", () => ({}));

import { after, before, client } from "@cocalc/server/test";
import {
  createAgentRpcControlClient,
  createAgentRpcControlHandler,
} from "@cocalc/conat/inter-bay/agent-rpc";
import { agentRpcControl, reportRpcTurnFailure } from "./rpc";
import { signAgentRpcReportCapability } from "./rpc-report-capability";

const a = { project_id: aProject, agent_id: aAgent };
const b = { project_id: bProject, agent_id: bAgent };
const member = (endpoint: typeof a, name: string) => ({
  kind: "registered" as const,
  member_id: endpoint.agent_id,
  endpoint,
  name,
  available: true,
  added_at: new Date().toISOString(),
});

function report() {
  const authorization: any = {
    version: 3,
    source: a,
    source_run_id: runId,
    target: b,
    target_path: "/home/user/b.chat",
    target_thread_id: "thread-b",
    agent_network_id: network,
    network_generation: generation,
    account_generation: 4,
    configured_delivery: "queued",
    principal_account_id: account,
    guidance: false,
    attempt_id: attempt,
  };
  authorization.report_capability = signAgentRpcReportCapability(authorization);
  return {
    version: 1 as const,
    report_id: randomUUID(),
    attempt_id: attempt,
    authorization,
    turn_started_at: Date.now() - 60_000,
    kind: "limit" as const,
    detail: "You've hit your usage limit.",
  };
}

let handler: { close: () => void } | undefined;
beforeAll(async () => {
  await before({ noDatabase: true });
  // a-bay's agent-messaging service. One process plays both bays, so the
  // configured bay is a-bay exactly while a-bay handles a call.
  handler = createAgentRpcControlHandler(
    "a-bay",
    {
      ...agentRpcControl,
      deliverReport: async (opts) => {
        mockBay = "a-bay";
        try {
          return await agentRpcControl.deliverReport(opts);
        } finally {
          mockBay = "b-bay";
        }
      },
    },
    { client },
  ) as any;
});
afterAll(async () => {
  handler?.close();
  await after();
});

beforeEach(() => {
  mockBay = "b-bay";
  mockHostOf.mockClear();
  mockDeliver.mockReset().mockResolvedValue({ message_id: "m1" });
  mockCheckNetwork.mockReset().mockResolvedValue({
    agent_network_id: network,
    network_title: "Review",
    network_generation: generation,
    account_generation: 4,
    account_id: account,
    delivery_mode: "queued",
    source: member(a, "builder"),
    target: member(b, "reviewer"),
  });
});

test("B's bay forwards the report to A's bay, which writes it on A's host", async () => {
  const r = report();
  await expect(
    reportRpcTurnFailure({ host_id: bHost, account_id: account, report: r }),
  ).resolves.toEqual({ message_id: "m1" });
  // Written by A's bay, on A's host, into A's own chat, exactly as reported.
  expect(mockHostOf).toHaveBeenCalledWith("a-bay", aHost);
  expect(mockDeliver).toHaveBeenCalledTimes(1);
  expect(mockDeliver).toHaveBeenCalledWith({
    account_id: account,
    report: r,
    path: "/home/user/a.chat",
    thread_id: "thread-a",
    target_label: "@reviewer",
  });
});

test("what A's host reports comes back across the bays", async () => {
  mockDeliver.mockResolvedValueOnce({ skipped: "replied" });
  await expect(
    reportRpcTurnFailure({
      host_id: bHost,
      account_id: account,
      report: report(),
    }),
  ).resolves.toEqual({ skipped: "replied" });
  // Not written yet: an error, so B's host tries again later.
  mockDeliver.mockResolvedValueOnce({ not_sent: "the project did not start" });
  await expect(
    reportRpcTurnFailure({
      host_id: bHost,
      account_id: account,
      report: report(),
    }),
  ).rejects.toThrow("the project did not start");
});

test("A's bay checks a call itself, whichever bay sent it", async () => {
  const aBay = createAgentRpcControlClient(client, "a-bay");
  const call = (overrides: any = {}) =>
    aBay.deliverReport({
      project_id: aProject,
      route: { bay_id: "a-bay", epoch: 1 },
      account_id: account,
      report: report(),
      target_label: "@reviewer",
      ...overrides,
    });
  await expect(call()).resolves.toEqual({ message_id: "m1" });
  // Not for a project another bay owns, nor a report the hub did not sign.
  await expect(call({ project_id: bProject })).rejects.toThrow(
    "stale agent RPC route",
  );
  const forged = report();
  forged.authorization.report_capability = `${Date.now()}.${"A".repeat(43)}`;
  await expect(call({ report: forged })).rejects.toThrow(
    "does not match an admitted message",
  );
  expect(mockDeliver).toHaveBeenCalledTimes(1);
});
