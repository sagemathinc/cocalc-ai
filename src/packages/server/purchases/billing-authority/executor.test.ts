/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

jest.mock("./dispatch", () => ({ dispatchBillingAuthorityCommand: jest.fn() }));
jest.mock("./store", () => ({
  claimNextBillingAuthorityCommand: jest.fn(),
  renewBillingAuthorityLease: jest.fn(),
  beginBillingAuthorityCommandExecution: jest.fn(),
  assertBillingAuthorityLease: jest.fn(),
  finishBillingAuthorityCommand: jest.fn(),
}));
jest.mock("@cocalc/database/pool", () => ({ getClient: jest.fn() }));
jest.mock("@cocalc/server/purchases/billing-account", () => ({}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterRole: () => "standalone",
  getConfiguredClusterSeedBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

import { performance } from "node:perf_hooks";
import { getClient } from "@cocalc/database/pool";
import { dispatchBillingAuthorityCommand } from "./dispatch";
import { __test__, startBillingAuthorityService } from "./service";
import * as store from "./store";

const lease = {
  instance_id: "11111111-1111-4111-8111-111111111111",
  generation: 1,
};

describe("isolated billing executor recovery", () => {
  const originalEnabled = process.env.COCALC_BILLING_AUTHORITY_ENABLED;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    __test__.resetLeaseRevocation();
    Object.assign(__test__.runtime, {
      lease,
      local_deadline_ms: performance.now() + 60000,
      draining: false,
      stopping: false,
      active_command_id: undefined,
      lease_client: undefined,
    });
    (getClient as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ rows: [] }),
      end: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    }));
  });
  afterEach(() => {
    jest.useRealTimers();
    if (originalEnabled == null)
      delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    else process.env.COCALC_BILLING_AUTHORITY_ENABLED = originalEnabled;
  });

  it("does not create executor database clients in a hub", () => {
    process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
    startBillingAuthorityService();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("pauses on a command-claim failure instead of terminating the process", async () => {
    (store.claimNextBillingAuthorityCommand as jest.Mock).mockRejectedValueOnce(
      Error("database disconnected"),
    );
    await __test__.processingLoop(lease, getClient());
    expect(__test__.authorityLocallyActive(lease)).toBe(false);
    expect(__test__.runtime.stopping).toBe(false);
    expect(dispatchBillingAuthorityCommand).not.toHaveBeenCalled();
  });

  it("closes a timed-out claim session without replaying the unknown claim", async () => {
    (store.claimNextBillingAuthorityCommand as jest.Mock).mockReturnValueOnce(
      new Promise(() => {}),
    );
    const client = getClient();
    const running = __test__.processingLoop(lease, client);
    await jest.advanceTimersByTimeAsync(10001);
    await running;
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(store.claimNextBillingAuthorityCommand).toHaveBeenCalledTimes(1);
    expect(dispatchBillingAuthorityCommand).not.toHaveBeenCalled();
  });

  it("waits for an in-flight command to settle after heartbeat failure", async () => {
    let finish!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      finish = resolve;
    });
    (dispatchBillingAuthorityCommand as jest.Mock).mockReturnValueOnce(
      dispatched,
    );
    (store.claimNextBillingAuthorityCommand as jest.Mock).mockResolvedValueOnce(
      {
        record: {
          command_id: "command-1",
          lane: "interactive",
          account_ids: [],
        },
        command: { kind: "http", operation: "get-customer", input: {} },
      },
    );
    (store.renewBillingAuthorityLease as jest.Mock).mockRejectedValueOnce(
      Error("heartbeat failed"),
    );
    __test__.runtime.lease_client = getClient();
    let settled = false;
    const running = __test__.runLease(lease, getClient()).then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(5001);
    expect(dispatchBillingAuthorityCommand).toHaveBeenCalledTimes(1);
    expect(__test__.authorityLocallyActive(lease)).toBe(false);
    expect(settled).toBe(false);
    finish();
    await running;
    expect(settled).toBe(true);
    expect(store.claimNextBillingAuthorityCommand).toHaveBeenCalledTimes(1);
    expect(store.finishBillingAuthorityCommand).not.toHaveBeenCalled();
  });
});
