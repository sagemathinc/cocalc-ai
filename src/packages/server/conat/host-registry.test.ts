/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let connectMock: jest.Mock;
let upsertProjectHostMock: jest.Mock;
let ensureAutomaticHostRuntimeDeploymentsReconcileMock: jest.Mock;
let ensureAutomaticHostArtifactDeploymentsReconcileMock: jest.Mock;
let publishMock: jest.Mock;
let appendProjectOutboxEventForProjectMock: jest.Mock;
let publishProjectAccountFeedEventsBestEffortMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let appendProjectLogRowBestEffortMock: jest.Mock;
let startProjectOnHostMock: jest.Mock;
let loadProjectRuntimeSponsorMock: jest.Mock;
let reserveProjectRuntimeSlotMock: jest.Mock;
let heartbeatProjectRuntimeSlotMock: jest.Mock;
let releaseProjectRuntimeSlotMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => queryMock(...args),
    connect: (...args: any[]) => connectMock(...args),
  }),
}));

jest.mock("@cocalc/database/postgres/project-hosts", () => ({
  upsertProjectHost: (...args: any[]) => upsertProjectHostMock(...args),
}));

jest.mock("@cocalc/backend/conat", () => ({
  conat: () => ({ publish: (...args: any[]) => publishMock(...args) }),
}));

jest.mock("@cocalc/backend/data", () => ({
  getProjectHostAuthTokenPublicKey: () => "pubkey",
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendProjectOutboxEventForProjectMock(...args),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectAccountFeedEventsBestEffortMock(...args),
}));

jest.mock("@cocalc/server/projects/project-log", () => ({
  appendProjectLogRowBestEffort: (...args: any[]) =>
    appendProjectLogRowBestEffortMock(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  startProjectOnHost: (...args: any[]) => startProjectOnHostMock(...args),
}));

jest.mock("@cocalc/server/projects/runtime-sponsor-db", () => ({
  loadProjectRuntimeSponsor: (...args: any[]) =>
    loadProjectRuntimeSponsorMock(...args),
}));

jest.mock("@cocalc/server/projects/runtime-slots", () => ({
  reserveProjectRuntimeSlot: (...args: any[]) =>
    reserveProjectRuntimeSlotMock(...args),
  heartbeatProjectRuntimeSlot: (...args: any[]) =>
    heartbeatProjectRuntimeSlotMock(...args),
  releaseProjectRuntimeSlot: (...args: any[]) =>
    releaseProjectRuntimeSlotMock(...args),
}));

jest.mock("@cocalc/server/project-host/bootstrap-token", () => ({
  createProjectHostMasterConatToken: jest.fn(),
  verifyProjectHostToken: jest.fn(),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

jest.mock("@cocalc/server/cloud/db", () => ({
  enqueueCloudVmWorkOnce: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/cloud/spot-restore", () => ({
  shouldAutoRestoreInterruptedSpotHost: () => false,
}));

jest.mock("@cocalc/server/conat/api/hosts", () => ({
  ensureAutomaticHostRuntimeDeploymentsReconcile: (...args: any[]) =>
    ensureAutomaticHostRuntimeDeploymentsReconcileMock(...args),
  ensureAutomaticHostArtifactDeploymentsReconcile: (...args: any[]) =>
    ensureAutomaticHostArtifactDeploymentsReconcileMock(...args),
}));

jest.mock("./route-project", () => ({
  notifyProjectHostUpdate: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    silly: jest.fn(),
  }),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  createHostRegistryService: jest.fn(async ({ impl }) => impl),
}));

jest.mock("@cocalc/conat/service/typed", () => ({
  createServiceHandler: jest.fn(async ({ impl }) => impl),
}));

function handleAvailabilityQuery(sql: string) {
  if (
    sql.includes(
      "CREATE TABLE IF NOT EXISTS project_host_availability_events",
    ) ||
    sql.includes(
      "CREATE INDEX IF NOT EXISTS project_host_availability_events_host_started_idx",
    ) ||
    sql.includes(
      "CREATE UNIQUE INDEX IF NOT EXISTS project_host_availability_events_one_open_idx",
    ) ||
    (sql.includes("FROM project_host_availability_events") &&
      sql.includes("ended_at IS NULL")) ||
    (sql.includes("UPDATE project_host_availability_events") &&
      sql.includes("SET ended_at=$2")) ||
    sql.includes("INSERT INTO project_host_availability_events")
  ) {
    return { rows: [] };
  }
}

describe("host-registry automatic convergence retry", () => {
  beforeEach(() => {
    jest.resetModules();
    publishMock = jest.fn(async () => undefined);
    connectMock = jest.fn(() => {
      throw new Error("unexpected db connection");
    });
    appendProjectOutboxEventForProjectMock = jest.fn(async () => undefined);
    publishProjectAccountFeedEventsBestEffortMock = jest.fn(
      async () => undefined,
    );
    appendProjectLogRowBestEffortMock = jest.fn(async () => true);
    resolveMembershipForAccountMock = jest.fn(async () => ({
      effective_limits: { shared_compute_priority: 0 },
    }));
    startProjectOnHostMock = jest.fn(async () => undefined);
    loadProjectRuntimeSponsorMock = jest.fn(async (project_id: string) => ({
      sponsor_account_id: `sponsor-${project_id}`,
      owning_bay_id: "bay-0",
      host_id: "host-1",
      users: {},
    }));
    reserveProjectRuntimeSlotMock = jest.fn(async () => undefined);
    heartbeatProjectRuntimeSlotMock = jest.fn(async () => undefined);
    releaseProjectRuntimeSlotMock = jest.fn(async () => undefined);
    upsertProjectHostMock = jest.fn(async ({ metadata, host_session_id }) => {
      currentMetadata = {
        ...currentMetadata,
        ...(metadata ?? {}),
        ...(host_session_id ? { host_session_id } : {}),
      };
    });
    ensureAutomaticHostRuntimeDeploymentsReconcileMock = jest
      .fn()
      .mockResolvedValueOnce({
        queued: false,
        host_id: "host-1",
        reason: "observation_failed",
      })
      .mockResolvedValueOnce({
        queued: false,
        host_id: "host-1",
        reason: "no_reconcile_needed",
      });
    ensureAutomaticHostArtifactDeploymentsReconcileMock = jest
      .fn()
      .mockResolvedValue({
        queued: false,
        host_id: "host-1",
        reason: "no_reconcile_needed",
      });
  });

  let currentMetadata: any;

  it("retries pending automatic convergence on heartbeat after register observation failure", async () => {
    currentMetadata = {};
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      const availabilityResult = handleAvailabilityQuery(sql);
      if (availabilityResult) return availabilityResult;
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "running" }] };
      }
      if (
        sql.includes(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        ) ||
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata }] };
      }
      if (
        sql.includes(
          "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        expect(params[0]).toBe("host-1");
        currentMetadata = params[1];
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();

    await service.register({
      id: "host-1",
      metadata: {
        host_session_id: "session-1",
        machine: { cloud: "gcp" },
      },
    } as any);

    expect(
      currentMetadata?.runtime_deployments?.pending_automatic_convergence_retry,
    ).toMatchObject({
      runtime: true,
    });
    expect(
      ensureAutomaticHostRuntimeDeploymentsReconcileMock,
    ).toHaveBeenCalledWith({
      host_id: "host-1",
      reason: "host_register",
    });
    expect(
      ensureAutomaticHostArtifactDeploymentsReconcileMock,
    ).toHaveBeenCalledTimes(1);

    await service.heartbeat({
      id: "host-1",
      metadata: {
        host_session_id: "session-1",
        machine: { cloud: "gcp" },
      },
    } as any);

    expect(
      ensureAutomaticHostRuntimeDeploymentsReconcileMock,
    ).toHaveBeenCalledTimes(2);
    expect(
      ensureAutomaticHostRuntimeDeploymentsReconcileMock,
    ).toHaveBeenLastCalledWith({
      host_id: "host-1",
      reason: "host_heartbeat_retry",
    });
    expect(
      ensureAutomaticHostArtifactDeploymentsReconcileMock,
    ).toHaveBeenCalledTimes(1);
    expect(
      currentMetadata?.runtime_deployments?.pending_automatic_convergence_retry,
    ).toBeUndefined();
  });

  it("preserves existing host bay ownership when heartbeats arrive on another bay", async () => {
    currentMetadata = {
      host_session_id: "session-1",
      host_boot_id: "boot-1",
      machine: { cloud: "gcp" },
    };
    queryMock = jest.fn(async (sql: string) => {
      const availabilityResult = handleAvailabilityQuery(sql);
      if (availabilityResult) return availabilityResult;
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "running" }] };
      }
      if (
        sql.includes(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        ) ||
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata, bay_id: "bay-1" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    ensureAutomaticHostRuntimeDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));
    ensureAutomaticHostArtifactDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();

    await service.heartbeat({
      id: "host-1",
      metadata: currentMetadata,
    } as any);

    expect(upsertProjectHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "host-1",
        bay_id: "bay-1",
      }),
    );
  });

  it("accepts heartbeats while a host is starting", async () => {
    currentMetadata = {
      host_session_id: "session-1",
      host_boot_id: "boot-1",
      machine: { cloud: "gcp" },
    };
    queryMock = jest.fn(async (sql: string) => {
      const availabilityResult = handleAvailabilityQuery(sql);
      if (availabilityResult) return availabilityResult;
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "starting" }] };
      }
      if (
        sql.includes(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        ) ||
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata, bay_id: "bay-1" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    ensureAutomaticHostRuntimeDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));
    ensureAutomaticHostArtifactDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();

    await service.heartbeat({
      id: "host-1",
      metadata: currentMetadata,
    } as any);

    expect(upsertProjectHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "host-1",
        status: "running",
      }),
    );
  });

  it("accepts registration while a host is starting", async () => {
    currentMetadata = {
      host_session_id: "session-1",
      host_boot_id: "boot-1",
      machine: { cloud: "gcp" },
    };
    queryMock = jest.fn(async (sql: string) => {
      const availabilityResult = handleAvailabilityQuery(sql);
      if (availabilityResult) return availabilityResult;
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "starting" }] };
      }
      if (
        sql.includes(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        ) ||
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata, bay_id: "bay-1" }] };
      }
      if (
        sql.includes(
          "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    ensureAutomaticHostRuntimeDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));
    ensureAutomaticHostArtifactDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();

    await service.register({
      id: "host-1",
      metadata: currentMetadata,
    } as any);

    expect(upsertProjectHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "host-1",
        status: "running",
      }),
    );
  });

  it("does not mark running projects opened when only the host process session changes", async () => {
    currentMetadata = {
      host_session_id: "session-old",
      host_boot_id: "boot-1",
      machine: { cloud: "gcp" },
    };
    ensureAutomaticHostRuntimeDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));
    ensureAutomaticHostArtifactDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));
    const clientQueryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("UPDATE projects")) {
        expect(params[0]).toBe("host-1");
        expect(params[1]).toMatchObject({
          state: "opened",
          reason: "host_session_replaced",
          previous_host_session_id: "session-old",
          host_session_id: "session-new",
        });
        return {
          rows: [{ project_id: "proj-1" }, { project_id: "proj-2" }],
        };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });
    const client = {
      query: clientQueryMock,
      release: jest.fn(),
    };
    connectMock = jest.fn(() => client);
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      const availabilityResult = handleAvailabilityQuery(sql);
      if (availabilityResult) return availabilityResult;
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "running" }] };
      }
      if (
        sql.includes(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        ) ||
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata }] };
      }
      if (
        sql.includes(
          "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        expect(params[0]).toBe("host-1");
        currentMetadata = params[1];
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();

    await service.register({
      id: "host-1",
      metadata: {
        host_session_id: "session-new",
        host_boot_id: "boot-1",
        machine: { cloud: "gcp" },
      },
    } as any);

    expect(connectMock).not.toHaveBeenCalled();
    expect(appendProjectOutboxEventForProjectMock).not.toHaveBeenCalled();
    expect(
      publishProjectAccountFeedEventsBestEffortMock,
    ).not.toHaveBeenCalled();
  });

  it("queues restart recovery when a host registers after a boot change", async () => {
    currentMetadata = {
      host_session_id: "session-old",
      host_boot_id: "boot-old",
      machine: { cloud: "gcp" },
    };
    ensureAutomaticHostRuntimeDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));
    ensureAutomaticHostArtifactDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      const availabilityResult = handleAvailabilityQuery(sql);
      if (availabilityResult) return availabilityResult;
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "running" }] };
      }
      if (
        sql.includes(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        ) ||
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata }] };
      }
      if (
        sql.includes(
          "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        expect(params[0]).toBe("host-1");
        currentMetadata = params[1];
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();

    await service.register({
      id: "host-1",
      metadata: {
        host_session_id: "session-new",
        host_boot_id: "boot-new",
        machine: { cloud: "gcp" },
      },
    } as any);

    expect(connectMock).not.toHaveBeenCalled();
    expect(currentMetadata.restart_recovery).toMatchObject({
      status: "queued",
      previous_host_boot_id: "boot-old",
      host_boot_id: "boot-new",
      previous_host_session_id: "session-old",
      host_session_id: "session-new",
      source: "register",
    });
    expect(appendProjectOutboxEventForProjectMock).not.toHaveBeenCalled();
    expect(
      publishProjectAccountFeedEventsBestEffortMock,
    ).not.toHaveBeenCalled();
  });

  it("recovers host-restart projects in priority order", async () => {
    currentMetadata = {
      host_session_id: "session-new",
      host_boot_id: "boot-new",
      machine: { cloud: "gcp" },
    };
    resolveMembershipForAccountMock = jest.fn(async (account_id: string) => ({
      effective_limits: {
        shared_compute_priority: account_id === "owner-high" ? 10 : 0,
      },
    }));
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata }] };
      }
      if (
        sql.includes(
          "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        expect(params[0]).toBe("host-1");
        currentMetadata = params[1];
        return { rows: [] };
      }
      if (
        sql.includes("SELECT project_id, users, last_edited, created") &&
        sql.includes("FROM projects")
      ) {
        expect(params[0]).toBe("host-1");
        return {
          rows: [
            {
              project_id: "proj-low",
              users: { "owner-low": { group: "owner" } },
              last_edited: new Date("2026-05-01T00:00:00Z"),
              created: new Date("2026-04-01T00:00:00Z"),
            },
            {
              project_id: "proj-high",
              users: { "owner-high": { group: "owner" } },
              last_edited: new Date("2026-04-01T00:00:00Z"),
              created: new Date("2026-03-01T00:00:00Z"),
            },
          ],
        };
      }
      if (
        sql.includes("SELECT COALESCE(state->>'state', '') AS state") &&
        sql.includes("FROM projects")
      ) {
        return { rows: [{ state: "running" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { startHostRestartRecoveryForHost } = await import("./host-registry");
    await startHostRestartRecoveryForHost({
      host_id: "host-1",
      host_boot_id: "boot-new",
      previous_host_boot_id: "boot-old",
      previous_host_session_id: "session-old",
      host_session_id: "session-new",
      source: "register",
      max_parallel_starts: 1,
    });

    expect(startProjectOnHostMock.mock.calls.map((call) => call[0])).toEqual([
      "proj-high",
      "proj-low",
    ]);
    expect(startProjectOnHostMock).toHaveBeenNthCalledWith(1, "proj-high", {
      account_id: "owner-high",
      ignore_recent_state_snapshot: true,
    });
    expect(startProjectOnHostMock).toHaveBeenNthCalledWith(2, "proj-low", {
      account_id: "owner-low",
      ignore_recent_state_snapshot: true,
    });
    expect(reserveProjectRuntimeSlotMock).toHaveBeenCalledTimes(2);
    expect(heartbeatProjectRuntimeSlotMock).toHaveBeenCalledTimes(2);
    expect(releaseProjectRuntimeSlotMock).not.toHaveBeenCalled();
    expect(currentMetadata.restart_recovery).toMatchObject({
      status: "finished",
      total: 2,
      started: 2,
      skipped: 0,
      failed: 0,
    });
  });

  it("derives restart recovery parallelism from host capacity", async () => {
    const { hostRestartRecoveryParallelStarts } =
      await import("./host-registry");

    expect(hostRestartRecoveryParallelStarts({})).toBe(4);
    expect(
      hostRestartRecoveryParallelStarts({
        metadata: {
          metrics: {
            current: {
              memory_total_bytes: 256 * 1024 ** 3,
            },
          },
        },
      }),
    ).toBe(32);
    expect(
      hostRestartRecoveryParallelStarts({
        metadata: { host_cpu_count: 16 },
      }),
    ).toBe(8);
    expect(
      hostRestartRecoveryParallelStarts({
        metadata: {
          restart_recovery: {
            max_parallel_starts: 100,
          },
        },
      }),
    ).toBe(32);
  });

  it("lists stop policy deltas with mirrored activity and resolved priority", async () => {
    currentMetadata = {};
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "running" }] };
      }
      if (
        sql.includes(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        ) ||
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata }] };
      }
      if (sql.includes("FROM projects") && sql.includes("policy_updated_ms")) {
        return {
          rows: [
            {
              project_id: "proj-1",
              owner_account_id: "owner-1",
              authoritative_last_edited_ms: 1234,
              policy_updated_ms: 1234,
            },
            {
              project_id: "proj-2",
              owner_account_id: null,
              authoritative_last_edited_ms: null,
              policy_updated_ms: 1400,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveMembershipForAccountMock = jest.fn(async (account_id: string) => ({
      effective_limits: {
        shared_compute_priority: account_id === "owner-1" ? 5 : 0,
      },
    }));

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();

    const result = await service.listProjectStopPolicyDeltas({
      host_id: "host-1",
      since_ms: 1000,
      limit: 50,
    });

    expect(resolveMembershipForAccountMock).toHaveBeenCalledTimes(1);
    expect(resolveMembershipForAccountMock).toHaveBeenCalledWith("owner-1");
    expect(result).toEqual({
      rows: [
        {
          project_id: "proj-1",
          owner_account_id: "owner-1",
          shared_compute_priority: 5,
          authoritative_last_edited_ms: 1234,
          policy_updated_ms: 1234,
          stop_override: "default",
        },
        {
          project_id: "proj-2",
          owner_account_id: null,
          shared_compute_priority: 0,
          authoritative_last_edited_ms: null,
          policy_updated_ms: 1400,
          stop_override: "default",
        },
      ],
      next_since_ms: 1400,
      has_more: false,
    });
  });

  it("writes durable project log entries for pressure stops", async () => {
    currentMetadata = {};
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "running" }] };
      }
      if (
        sql.includes(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        ) ||
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();

    const result = await service.reportProjectPressureAction({
      host_id: "host-1",
      host_name: "Host One",
      project_id: "proj-1",
      action_status: "stopped",
      pressure_zone: "pressure",
      reason: "low_priority,stale_activity",
      trigger: "interval",
      candidate_count: 4,
      memory_used_percent: 96,
      memory_available_bytes: 123456789,
      occurred_at_ms: 1700000000000,
    });

    expect(result).toEqual({ logged: true });
    expect(appendProjectLogRowBestEffortMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      fresh: true,
      context: "host_pressure",
      row: {
        id: "project-pressure:host-1:proj-1:1700000000000:project_pressure_stopped",
        project_id: "proj-1",
        account_id: null,
        time: new Date(1700000000000),
        event: {
          event: "project_pressure_stopped",
          pressure_zone: "pressure",
          reason: "low_priority,stale_activity",
          source_host_id: "host-1",
          source_host_name: "Host One",
          trigger: "interval",
          candidate_count: 4,
          memory_used_percent: 96,
          memory_available_bytes: 123456789,
        },
      },
    });
  });
});
