let mockRole = "standalone";
jest.mock("@cocalc/server/cluster-config", () => ({
  getClusterConfig: () => ({ role: mockRole }),
}));
jest.mock("@cocalc/backend/data", () => ({ conatPassword: "this-bay-only" }));

import {
  AGENT_RPC_REPORT_MAX_AGE_MS,
  signAgentRpcReportCapability,
  verifyAgentRpcReportCapability,
} from "./rpc-report-capability";

const execution = {
  version: 3 as const,
  source: {
    project_id: "11111111-1111-4111-8111-111111111111",
    agent_id: "22222222-2222-4222-8222-222222222222",
  },
  source_run_id: "77777777-7777-4777-8777-777777777777",
  target: {
    project_id: "33333333-3333-4333-8333-333333333333",
    agent_id: "44444444-4444-4444-8444-444444444444",
  },
  target_path: "/home/user/b.chat",
  target_thread_id: "thread-b",
  agent_network_id: "88888888-8888-4888-8888-888888888888",
  network_generation: "99999999-9999-4999-8999-999999999999",
  account_generation: 3,
  configured_delivery: "queued" as const,
  principal_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  guidance: false,
  attempt_id: "55555555-5555-4555-8555-555555555555",
};
const signed = (issued_at?: number) => ({
  ...execution,
  report_capability: signAgentRpcReportCapability(execution, issued_at),
});

afterEach(() => {
  mockRole = "standalone";
  delete process.env.COCALC_CLUSTER_SHARED_SECRET;
});

test("a capability is the hub's, for exactly this message, for a week", () => {
  process.env.COCALC_CLUSTER_SHARED_SECRET = "cluster";
  const now = Date.now();
  expect(signed(now).report_capability).toMatch(
    /^[0-9]{13}\.[A-Za-z0-9_-]{43}$/,
  );
  expect(verifyAgentRpcReportCapability(signed(now), now)).toBe(true);
  // Another mint time is another capability.
  const [, mac] = signed(now).report_capability.split(".");
  expect(
    verifyAgentRpcReportCapability(
      { ...execution, report_capability: `${now - 1}.${mac}` },
      now,
    ),
  ).toBe(false);
  expect(
    verifyAgentRpcReportCapability(
      signed(now - AGENT_RPC_REPORT_MAX_AGE_MS - 1),
      now,
    ),
  ).toBe(false);
  expect(verifyAgentRpcReportCapability(signed(now + 60 * 60_000), now)).toBe(
    false,
  );
  // Another cluster's secret.
  const capability = signed(now);
  process.env.COCALC_CLUSTER_SHARED_SECRET = "other cluster";
  expect(verifyAgentRpcReportCapability(capability, now)).toBe(false);
});

test("a bay of a cluster never signs with its own conat password", () => {
  mockRole = "attached";
  expect(() => signAgentRpcReportCapability(execution)).toThrow(
    "missing COCALC_CLUSTER_SHARED_SECRET",
  );
  mockRole = "standalone";
  const capability = signed();
  // Which an attached bay could not verify anyway.
  mockRole = "attached";
  expect(verifyAgentRpcReportCapability(capability)).toBe(false);
  mockRole = "standalone";
  expect(verifyAgentRpcReportCapability(capability)).toBe(true);
});
