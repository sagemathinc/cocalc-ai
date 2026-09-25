/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

const accountId = "00000000-0000-4000-8000-000000000001";
const hostId = "00000000-0000-4000-8000-000000000002";
const homeBay = jest.fn();
const remoteBegin = jest.fn();
const localBegin = jest.fn();
const localGet = jest.fn();
const remoteGet = jest.fn();

jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args: any[]) => homeBay(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "source-bay",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/agent-connector", () => ({
  createInterBayAgentConnectorClient: () => ({
    begin: (...args: any[]) => remoteBegin(...args),
    getConfig: (...args: any[]) => remoteGet(...args),
  }),
}));
jest.mock("./cocalc-connector-turn", () => ({
  beginManagedCocalcConnectorTurn: (...args: any[]) => localBegin(...args),
  renewManagedCocalcConnectorTurn: jest.fn(),
  endManagedCocalcConnectorTurn: jest.fn(),
}));
jest.mock("./cocalc-connector-config", () => ({
  getCocalcConnectorConfig: (...args: any[]) => localGet(...args),
  saveCocalcConnectorConfig: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  homeBay.mockResolvedValue({ home_bay_id: "source-bay" });
});

test("authenticated host calls the local account-home issuer", async () => {
  const { beginCocalcConnectorTurn } =
    await import("./cocalc-connector-routing");
  const opts = {
    account_id: accountId,
    host_id: hostId,
    agent_id: "agent",
    source_project_id: "source",
    run_id: "run",
    idempotency_key: "retry",
    turn_ref: {
      chat_path: "work.chat",
      message_date: "date",
      message_id: "message",
      thread_id: "thread",
    },
  };
  await beginCocalcConnectorTurn(opts);
  expect(localBegin).toHaveBeenCalledWith(opts);
  expect(remoteBegin).not.toHaveBeenCalled();
});

test("a different account home uses the inter-bay connector service", async () => {
  homeBay.mockResolvedValue({ home_bay_id: "account-home" });
  const { getCocalcConnectorConfig } =
    await import("./cocalc-connector-routing");
  const opts = {
    account_id: accountId,
    agent_id: "agent",
    source_project_id: "source",
  };
  await getCocalcConnectorConfig(opts);
  expect(remoteGet).toHaveBeenCalledWith(opts);
  expect(localGet).not.toHaveBeenCalled();
});

test("missing authenticated host identity fails before routing", async () => {
  const { beginCocalcConnectorTurn } =
    await import("./cocalc-connector-routing");
  await expect(
    beginCocalcConnectorTurn({
      account_id: accountId,
      agent_id: "agent",
      source_project_id: "source",
      run_id: "run",
      idempotency_key: "retry",
      turn_ref: {
        chat_path: "work.chat",
        message_date: "date",
        message_id: "message",
        thread_id: "thread",
      },
    }),
  ).rejects.toThrow("authenticated project host required");
  expect(remoteBegin).not.toHaveBeenCalled();
  expect(localBegin).not.toHaveBeenCalled();
});
