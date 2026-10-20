import { randomUUID } from "node:crypto";

process.env.COCALC_CLUSTER_SHARED_SECRET = "test-cluster-secret";

// A sent a message to B; B's turn on it failed. These tests are the hub:
// B's host reports it, and A's host runs the turn the report starts.
const aProject = randomUUID();
const bProject = randomUUID();
const aAgent = randomUUID();
const bAgent = randomUUID();
const runId = randomUUID();
const account = randomUUID();
const host = randomUUID();
const network = randomUUID();
const generation = randomUUID();
const attempt = randomUUID();

const identities = new Map<string, any>([
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
const checkNetwork = jest.fn();
const assertHost = jest.fn(async () => {});
const deliverAgentRpcReport = jest.fn();
const remoteDeliverReport = jest.fn();
const enqueueExternal = jest.fn();
const claimExecution = jest.fn();
let remoteSender = false;
// The delivery report version A's host advertises (undefined: none).
let senderReportVersion: number | undefined;
// The build A's host runs now (it advertised its version for "build-2").
let senderBuild = "build-2";

jest.mock("./store", () => ({
  agentStore: () => ({
    get: async (agent_id: string) => identities.get(agent_id),
    query: async (sql: string) =>
      sql.includes("agent_rpc_report")
        ? {
            rows: [
              {
                version: senderReportVersion?.toString() ?? null,
                for_build: "build-2",
                build: senderBuild,
              },
            ],
          }
        : { rows: [{ host_id: host, state: "running" }] },
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
  assertExternalAgentLoginEnabled: jest.fn(),
  externalControl: jest.fn(),
  enqueueExternalAgentMessage: (...args: unknown[]) => enqueueExternal(...args),
  externalStore: jest.fn(),
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
  getConfiguredBayId: () => "this-bay",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async (project_id: string) => ({
    bay_id: remoteSender && project_id === aProject ? "a-bay" : "this-bay",
    epoch: 1,
  }),
  resolveHostBayAcrossCluster: async () => ({ bay_id: "this-bay" }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/agent-rpc", () => ({
  createAgentRpcControlClient: () => ({
    deliverReport: (...args: unknown[]) => remoteDeliverReport(...args),
  }),
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitHostControlClient: async () => ({}),
}));
jest.mock("@cocalc/conat/project-host/api", () => ({
  createHostControlClient: () => ({ deliverAgentRpcReport }),
}));
jest.mock("./admission-state", () => ({}));
jest.mock("./rpc-report-executions", () => ({
  claimAgentRpcReportExecution: (...args: unknown[]) => claimExecution(...args),
}));

import {
  agentRpcControl,
  authorizeRpcReportExecution,
  reportRpcTurnFailure,
} from "./rpc";
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

// The capability the hub minted when it sent the message.
function signed<T extends { authorization: any }>(
  r: T,
  issued_at = Date.now(),
): T {
  delete r.authorization.report_capability;
  r.authorization.report_capability = signAgentRpcReportCapability(
    r.authorization,
    issued_at,
  );
  return r;
}
const WEEK = 7 * 24 * 60 * 60_000;

function report(overrides: any = {}) {
  return signed({
    version: 1 as const,
    report_id: randomUUID(),
    attempt_id: attempt,
    authorization: {
      version: 3 as const,
      source: a,
      source_run_id: runId,
      target: b,
      target_path: "/home/user/b.chat",
      target_thread_id: "thread-b",
      agent_network_id: network,
      network_generation: generation,
      account_generation: 4,
      configured_delivery: "queued" as const,
      principal_account_id: account,
      guidance: false,
      attempt_id: attempt,
    },
    turn_started_at: Date.now() - 60_000,
    kind: "limit" as const,
    detail: "You've hit your usage limit.",
    ...overrides,
  });
}

beforeEach(() => {
  remoteSender = false;
  // A's host is current unless a test says otherwise.
  senderReportVersion = 2;
  senderBuild = "build-2";
  claimExecution.mockReset().mockResolvedValue(true);
  assertHost.mockClear();
  enqueueExternal.mockReset();
  remoteDeliverReport.mockReset().mockResolvedValue({ message_id: "remote" });
  deliverAgentRpcReport.mockReset().mockResolvedValue({ message_id: "m1" });
  checkNetwork.mockReset().mockResolvedValue({
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

const fromHost = (r = report()) => ({
  host_id: host,
  account_id: account,
  report: r,
});

describe("B's host reports the failed turn", () => {
  test("A is told, in A's own chat, about B by the name A's network uses", async () => {
    const r = report();
    await expect(reportRpcTurnFailure(fromHost(r))).resolves.toEqual({
      message_id: "m1",
    });
    // Only the host the turn ran on (B's) may report it.
    expect(assertHost).toHaveBeenCalledWith({
      account_id: account,
      host_id: host,
      project_id: bProject,
    });
    // The original message's authority, as at execution: A may have ended.
    expect(checkNetwork).toHaveBeenCalledWith(account, {
      action: "checkExecutionNetwork",
      options: {
        agent_network_id: network,
        source: a,
        run_id: runId,
        target: b,
      },
    });
    expect(deliverAgentRpcReport).toHaveBeenCalledWith({
      account_id: account,
      report: r,
      path: "/home/user/a.chat",
      thread_id: "thread-a",
      target_label: "@reviewer",
    });
  });

  test("only as A's host can render it truthfully", async () => {
    const stopped = report({ kind: "stopped", tool_ran: true });
    // A host that advertises version 2 gets it as it is.
    senderReportVersion = 2;
    await reportRpcTurnFailure(fromHost(stopped));
    expect(deliverAgentRpcReport.mock.calls[0][0].report).toEqual(stopped);
    // A host rolled back to an older build keeps the newer build's value
    // (heartbeats are merged): it counts as the old version.
    senderBuild = "build-1";
    deliverAgentRpcReport.mockClear();
    await expect(reportRpcTurnFailure(fromHost(stopped))).rejects.toThrow(
      /must be upgraded/,
    );
    expect(deliverAgentRpcReport).not.toHaveBeenCalled();
    senderBuild = "build-2";
    // An older host would tell A that B "did not act": it is held, and B's
    // host tries again later.
    senderReportVersion = undefined;
    deliverAgentRpcReport.mockClear();
    await expect(reportRpcTurnFailure(fromHost(stopped))).rejects.toThrow(
      /must be upgraded/,
    );
    expect(deliverAgentRpcReport).not.toHaveBeenCalled();
    // Unless that is true: nothing ran, so it can have the old shape.
    const canceled = report({ kind: "canceled", tool_ran: false });
    await reportRpcTurnFailure(fromHost(canceled));
    const sent = deliverAgentRpcReport.mock.calls[0][0].report;
    expect(sent.kind).toBe("error");
    expect(sent.detail).toMatch(/canceled your message before it ran/);
    expect(sent).not.toHaveProperty("tool_ran");
    // Any kind is held once B ran tools, an old one too.
    deliverAgentRpcReport.mockClear();
    await expect(
      reportRpcTurnFailure(
        fromHost(report({ kind: "limit", resets_at: 123, tool_ran: true })),
      ),
    ).rejects.toThrow(/must be upgraded/);
    expect(deliverAgentRpcReport).not.toHaveBeenCalled();
    // An old kind is sent without the new fields when nothing ran.
    deliverAgentRpcReport.mockClear();
    await reportRpcTurnFailure(
      fromHost(report({ kind: "limit", resets_at: 123, tool_ran: false })),
    );
    const old = deliverAgentRpcReport.mock.calls[0][0].report;
    expect(old.kind).toBe("limit");
    expect(old).not.toHaveProperty("resets_at");
    expect(old).not.toHaveProperty("tool_ran");
    // Held when that is not known, even an old kind (an older recipient
    // host never says; the old text would claim B did not act).
    await expect(
      reportRpcTurnFailure(fromHost(report({ kind: "limit" }))),
    ).rejects.toThrow(/must be upgraded/);
    // A new kind whose tool use is not known is held.
    await expect(
      reportRpcTurnFailure(fromHost(report({ kind: "host-lost" }))),
    ).rejects.toThrow(/must be upgraded/);
  });

  test("through A's project bay when A is elsewhere", async () => {
    remoteSender = true;
    await expect(reportRpcTurnFailure(fromHost())).resolves.toEqual({
      message_id: "remote",
    });
    expect(remoteDeliverReport.mock.calls[0][0]).toMatchObject({
      project_id: aProject,
      route: { bay_id: "a-bay", epoch: 1 },
      account_id: account,
      target_label: "@reviewer",
    });
    expect(deliverAgentRpcReport).not.toHaveBeenCalled();
  });

  test("not when the message is no longer authorized", async () => {
    checkNetwork.mockResolvedValueOnce({ denied: "network_closed" });
    await expect(reportRpcTurnFailure(fromHost())).resolves.toEqual({
      not_sent: expect.stringContaining("network_closed"),
    });
    // The network changed since the message (another generation).
    checkNetwork.mockResolvedValueOnce({
      agent_network_id: network,
      network_generation: randomUUID(),
      account_generation: 4,
      account_id: account,
      delivery_mode: "queued",
      source: member(a, "builder"),
      target: member(b, "reviewer"),
    });
    await expect(reportRpcTurnFailure(fromHost())).resolves.toEqual({
      not_sent: expect.stringContaining("network_stale"),
    });
    expect(deliverAgentRpcReport).not.toHaveBeenCalled();
  });

  test("not when B moved to another conversation", async () => {
    const r = report();
    r.authorization.target_thread_id = "older-thread";
    await expect(reportRpcTurnFailure(fromHost(signed(r)))).resolves.toEqual({
      not_sent: "the recipient's conversation changed",
    });
  });

  test("never for another account, nor a report of another message", async () => {
    await expect(
      reportRpcTurnFailure({ ...fromHost(), account_id: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      reportRpcTurnFailure(fromHost(report({ attempt_id: randomUUID() }))),
    ).rejects.toThrow("delivery report names another message");
    assertHost.mockRejectedValueOnce(new Error("host does not serve project"));
    await expect(reportRpcTurnFailure(fromHost())).rejects.toThrow(
      "host does not serve project",
    );
    expect(deliverAgentRpcReport).not.toHaveBeenCalled();
  });

  test("never for a message the hub did not send exactly so", async () => {
    // Forged, or altered after signing (here: another network generation).
    const forged = report();
    forged.authorization.report_capability = `${Date.now()}.${"A".repeat(43)}`;
    const altered = report();
    altered.authorization.network_generation = randomUUID();
    const unsigned = report();
    delete (unsigned.authorization as any).report_capability;
    // Or a week old: messages that old are no longer reported.
    const old = signed(report(), Date.now() - WEEK - 60_000);
    for (const r of [forged, altered, old]) {
      await expect(reportRpcTurnFailure(fromHost(r))).resolves.toEqual({
        not_sent: "the report does not match an admitted message",
      });
    }
    await expect(reportRpcTurnFailure(fromHost(unsigned))).rejects.toThrow(
      "without the hub's capability",
    );
    expect(checkNetwork).not.toHaveBeenCalled();
    expect(deliverAgentRpcReport).not.toHaveBeenCalled();
  });

  test("a report A's host could not write yet is retried by B's host", async () => {
    deliverAgentRpcReport.mockResolvedValueOnce({
      not_sent: "the project did not start",
    });
    await expect(reportRpcTurnFailure(fromHost())).rejects.toThrow(
      "delivery report not written: the project did not start",
    );
    deliverAgentRpcReport.mockResolvedValueOnce({ skipped: "replied" });
    await expect(reportRpcTurnFailure(fromHost())).resolves.toEqual({
      skipped: "replied",
    });
  });

  test("not to an external sender, whose replies are not checked", async () => {
    const external = {
      kind: "external" as const,
      account_id: account,
      agent_id: randomUUID(),
      installation_id: randomUUID(),
    };
    const r = report();
    r.authorization.source = external as any;
    delete (r.authorization as any).source_run_id;
    await expect(reportRpcTurnFailure(fromHost(signed(r)))).resolves.toEqual({
      not_sent: "external senders are not sent delivery reports",
    });
    expect(enqueueExternal).not.toHaveBeenCalled();
  });
});

describe("the turn the report starts for A", () => {
  const execution = (r = report(), delivery?: any) => ({
    host_id: host,
    account_id: account,
    report: r,
    delivery: delivery ?? { path: "/home/user/a.chat", thread_id: "thread-a" },
  });

  test("is rechecked on A's host before it runs", async () => {
    const r = report();
    await expect(
      authorizeRpcReportExecution(execution(r)),
    ).resolves.toBeUndefined();
    expect(assertHost).toHaveBeenCalledWith({
      account_id: account,
      host_id: host,
      project_id: aProject,
    });
    // Last of all, its one turn is recorded.
    expect(claimExecution).toHaveBeenCalledWith({
      attempt_id: attempt,
      report_id: r.report_id,
      account_id: account,
      project_id: aProject,
      host_id: host,
      path: "/home/user/a.chat",
      thread_id: "thread-a",
    });
  });

  test("a held report and the final one each get their one turn", async () => {
    const held = {
      ...report(),
      phase: "held" as const,
      kind: "limit" as const,
    };
    await authorizeRpcReportExecution(execution(signed(held)));
    const heldKey = claimExecution.mock.calls.at(-1)[0].attempt_id;
    // Its own key, stable, and not the message's.
    expect(heldKey).not.toBe(attempt);
    expect(heldKey).toMatch(/^[0-9a-f-]{36}$/);
    await authorizeRpcReportExecution(execution(signed({ ...held })));
    expect(claimExecution.mock.calls.at(-1)[0].attempt_id).toBe(heldKey);
    await authorizeRpcReportExecution(execution());
    expect(claimExecution.mock.calls.at(-1)[0].attempt_id).toBe(attempt);
  });

  test("runs once: a report cannot be replayed into another turn", async () => {
    claimExecution.mockResolvedValueOnce(false);
    await expect(authorizeRpcReportExecution(execution())).rejects.toThrow(
      "this delivery report already started a turn",
    );
  });

  test("only with the hub's capability, as minted, within a week", async () => {
    // A's host holds the report it wrote, but cannot make up another one.
    const forged = report();
    forged.authorization.report_capability = `${Date.now()}.${"A".repeat(43)}`;
    const altered = report();
    altered.authorization.network_generation = randomUUID();
    const old = signed(report(), Date.now() - WEEK - 60_000);
    for (const r of [forged, altered, old])
      await expect(authorizeRpcReportExecution(execution(r))).rejects.toThrow(
        "does not match an admitted message",
      );
    expect(assertHost).not.toHaveBeenCalled();
    expect(claimExecution).not.toHaveBeenCalled();
  });

  test("not in another chat, nor once the message lost its authority", async () => {
    await expect(
      authorizeRpcReportExecution(
        execution(undefined, { path: "/home/user/a.chat", thread_id: "x" }),
      ),
    ).rejects.toThrow("sender identity changed");
    checkNetwork.mockResolvedValueOnce({ denied: "network_paused" });
    await expect(authorizeRpcReportExecution(execution())).rejects.toThrow();
    // A refused report spends nothing.
    expect(claimExecution).not.toHaveBeenCalled();
    await expect(
      authorizeRpcReportExecution({ ...execution(), account_id: randomUUID() }),
    ).rejects.toThrow();
  });
});

test("the control method writes only into the sender's own chat", async () => {
  await expect(
    agentRpcControl.deliverReport({
      project_id: aProject,
      route: { bay_id: "this-bay", epoch: 1 } as any,
      account_id: account,
      report: report(),
      target_label: "@reviewer",
    }),
  ).resolves.toEqual({ message_id: "m1" });
  // A stale route (A moved bays) is refused.
  await expect(
    agentRpcControl.deliverReport({
      project_id: aProject,
      route: { bay_id: "other-bay", epoch: 1 } as any,
      account_id: account,
      report: report(),
      target_label: "@reviewer",
    }),
  ).rejects.toThrow("stale agent RPC route");
});
