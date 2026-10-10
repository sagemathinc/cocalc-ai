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
const localRemove = jest.fn();
const remoteRemove = jest.fn();

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
    removeConfig: (...args: any[]) => remoteRemove(...args),
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
  removeCocalcConnectorConfig: (...args: any[]) => localRemove(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  homeBay.mockResolvedValue({ home_bay_id: "source-bay" });
});

test("removal routes to the account home and never falls back on remote failure", async () => {
  const { removeCocalcConnectorConfig: remove } =
    await import("./cocalc-connector-routing");
  const opts = {
    account_id: accountId,
    session_hash: "bound",
    agent_id: "agent",
    source_project_id: "source",
    expected_config_id: "config",
    expected_revision: 1,
  };
  await remove(opts);
  expect(localRemove).toHaveBeenCalledWith(opts);
  localRemove.mockClear();
  homeBay.mockResolvedValue({ home_bay_id: "account-home" });
  remoteRemove.mockRejectedValueOnce(new Error("unavailable"));
  await expect(remove(opts)).rejects.toThrow("unavailable");
  expect(remoteRemove).toHaveBeenCalledWith(opts);
  expect(localRemove).not.toHaveBeenCalled();
  await expect(remove({ ...opts, account_id: undefined })).rejects.toThrow(
    "authenticated account required",
  );
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

test("a host cannot present a sensor run; only the hub's scheduler can", async () => {
  const { beginCocalcConnectorTurn, sensorConnectors } =
    await import("./cocalc-connector-routing");
  const turn_ref = {
    chat_path: "work.chat",
    message_date: "date",
    message_id: "run",
    thread_id: "thread",
    sensor_run_id: "run",
  };
  const opts = {
    account_id: accountId,
    host_id: hostId,
    agent_id: "agent",
    source_project_id: "source",
    run_id: "run",
    idempotency_key: "retry",
    turn_ref,
  };
  await beginCocalcConnectorTurn(opts);
  expect(localBegin.mock.calls[0][0].turn_ref).not.toHaveProperty(
    "sensor_run_id",
  );
  await sensorConnectors.begin(opts);
  expect(localBegin.mock.calls[1][0].turn_ref.sensor_run_id).toBe("run");
});
