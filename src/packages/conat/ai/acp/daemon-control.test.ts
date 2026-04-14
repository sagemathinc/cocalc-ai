/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  acpDaemonControlClient,
  acpDaemonControlSubject,
  initAcpDaemonControlService,
} from "./daemon-control";

describe("acp daemon control", () => {
  it("uses a host-scoped worker subject", () => {
    expect(
      acpDaemonControlSubject({
        host_id: "00000000-1000-4000-8000-000000000001",
        worker_id: "worker-1",
      }),
    ).toBe("hub.host.00000000-1000-4000-8000-000000000001.acp-worker.worker-1");
  });

  it("builds a typed client call wrapper", async () => {
    const health = jest.fn(async () => ({
      worker_id: "worker-1",
      host_id: "00000000-1000-4000-8000-000000000001",
      pid: 123,
      bundle_version: "bundle",
      bundle_path: "/bundle",
      state: "active" as const,
      started_at: 1,
      last_heartbeat_at: 2,
      last_seen_running_jobs: 3,
      running_turn_leases: 4,
      exit_requested_at: null,
      stop_reason: null,
    }));
    const requestDrain = jest.fn(async () => await health());
    const service = {
      health,
      requestDrain,
    };
    const call = jest.fn(() => service);
    const client = { call } as any;

    const api = acpDaemonControlClient({
      client,
      host_id: "00000000-1000-4000-8000-000000000001",
      worker_id: "worker-1",
      timeout: 250,
    });

    await expect(api.health()).resolves.toMatchObject({
      worker_id: "worker-1",
      state: "active",
    });
    await api.requestDrain({ reason: "rolling_restart" });
    expect(call).toHaveBeenCalledWith(
      "hub.host.00000000-1000-4000-8000-000000000001.acp-worker.worker-1",
      { timeout: 250, waitForInterest: false },
    );
    expect(requestDrain).toHaveBeenCalledWith({ reason: "rolling_restart" });
  });

  it("registers a control service", async () => {
    const service = { close: jest.fn() };
    const client = {
      service: jest.fn(async (_subject, impl) => {
        await impl.health();
        await impl.requestDrain({ reason: "rolling_restart" });
        return service;
      }),
    } as any;
    const getStatus = jest.fn(async () => ({
      worker_id: "worker-1",
      host_id: "00000000-1000-4000-8000-000000000001",
      pid: 123,
      bundle_version: "bundle",
      bundle_path: "/bundle",
      state: "active" as const,
      started_at: 1,
      last_heartbeat_at: 2,
      last_seen_running_jobs: 3,
      running_turn_leases: 4,
      exit_requested_at: null,
      stop_reason: null,
    }));
    const requestDrain = jest.fn(async () => await getStatus());

    const sub = await initAcpDaemonControlService({
      client,
      host_id: "00000000-1000-4000-8000-000000000001",
      worker_id: "worker-1",
      getStatus,
      requestDrain,
    });

    expect(client.service).toHaveBeenCalledWith(
      "hub.host.00000000-1000-4000-8000-000000000001.acp-worker.worker-1",
      expect.objectContaining({
        health: expect.any(Function),
        requestDrain: expect.any(Function),
      }),
    );
    expect(getStatus).toHaveBeenCalled();
    expect(requestDrain).toHaveBeenCalledWith({ reason: "rolling_restart" });
    expect(sub).toBe(service);
  });
});
