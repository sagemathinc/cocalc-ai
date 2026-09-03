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
let enqueueCloudVmWorkOnceMock: jest.Mock;
let recordProviderSpotPreemptionMock: jest.Mock;
let shouldAutoRestoreInterruptedSpotHostMock: jest.Mock;
let spotRecoveryPolicyMock: jest.Mock;

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
  enqueueCloudVmWorkOnce: (...args: any[]) =>
    enqueueCloudVmWorkOnceMock(...args),
}));

jest.mock("@cocalc/server/cloud/spot-restore", () => ({
  recordProviderSpotPreemption: (...args: any[]) =>
    recordProviderSpotPreemptionMock(...args),
  shouldAutoRestoreInterruptedSpotHost: (...args: any[]) =>
    shouldAutoRestoreInterruptedSpotHostMock(...args),
  spotRecoveryPolicy: (...args: any[]) => spotRecoveryPolicyMock(...args),
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

jest.mock("@cocalc/backend/logger", () => {
  const getLogger = jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    silly: jest.fn(),
  }));
  return {
    __esModule: true,
    default: getLogger,
    getLogger,
  };
});

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
  beforeAll(async () => {
    await import("./host-registry");
  }, 30_000);

  beforeEach(() => {
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
    enqueueCloudVmWorkOnceMock = jest.fn(async () => undefined);
    recordProviderSpotPreemptionMock = jest.fn(({ state }) => ({
      state: state ?? { phase: "idle" },
      recorded: true,
      circuit_breaker_triggered: false,
    }));
    shouldAutoRestoreInterruptedSpotHostMock = jest.fn(() => false);
    spotRecoveryPolicyMock = jest.fn(() => undefined);
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

  it("records one rapid-preemption event per host session", async () => {
    const holdUntil = "2026-07-29T14:34:17.613Z";
    currentMetadata = {
      host_session_id: "session-1",
      machine: { cloud: "gcp", machine_type: "t2d-standard-16" },
      pricing_model: "spot",
      desired_pricing_model: "spot",
      effective_pricing_model: "spot",
      interruption_restore_policy: "immediate",
    };
    let currentStatus = "running";
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      const availabilityResult = handleAvailabilityQuery(sql);
      if (availabilityResult) return availabilityResult;
      if (
        sql.includes(
          "SELECT status, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return {
          rows: [{ status: currentStatus, metadata: currentMetadata }],
        };
      }
      if (
        sql.includes(
          "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1",
        )
      ) {
        currentMetadata = params[1];
        return { rows: [] };
      }
      if (
        sql.includes(
          "UPDATE project_hosts SET status='starting', last_seen=NULL, metadata=$2",
        )
      ) {
        currentStatus = "starting";
        currentMetadata = params[1];
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    shouldAutoRestoreInterruptedSpotHostMock.mockReturnValue(true);
    spotRecoveryPolicyMock.mockReturnValue({});
    recordProviderSpotPreemptionMock.mockReturnValue({
      state: {
        phase: "idle",
        last_preempted_at: "2026-07-28T14:34:17.613Z",
        standard_hold_until: holdUntil,
      },
      recorded: true,
      circuit_breaker_triggered: true,
    });
    enqueueCloudVmWorkOnceMock.mockResolvedValue("work-1");

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();
    const notice = {
      host_id: "host-1",
      host_session_id: "session-1",
      signal: "GCP_PREEMPTED",
      reason: "host-shutdown",
    };

    await service.shutdownNotice(notice);
    await service.shutdownNotice(notice);

    expect(recordProviderSpotPreemptionMock).toHaveBeenCalledTimes(1);
    expect(enqueueCloudVmWorkOnceMock).toHaveBeenCalledTimes(1);
    expect(currentMetadata.spot_recovery_state).toMatchObject({
      phase: "retrying_spot",
      standard_hold_until: holdUntil,
    });
  });

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

  it("clears a planned project-host transition only after runtime is ready", async () => {
    const operationId = "beab4b03-dbbe-40d0-a35a-fc50d40dfc1f";
    currentMetadata = {
      host_session_id: "session-new",
      host_boot_id: "boot-1",
      machine: { cloud: "gcp" },
      runtime_health: { status: "starting", ready: false },
      runtime_deployments: {
        planned_project_host_transition: {
          operation_id: operationId,
          component: "project-host",
          previous_host_session_id: "session-old",
          started_at: new Date(Date.now() - 10_000).toISOString(),
          deadline_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          banner_suppression_until: new Date(
            Date.now() + 3 * 60_000,
          ).toISOString(),
        },
      },
    };
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
        return { rows: [{ metadata: currentMetadata, bay_id: "bay-1" }] };
      }
      if (
        sql.includes("planned_project_host_transition") &&
        sql.includes("UPDATE project_hosts")
      ) {
        expect(params).toEqual(["host-1", operationId]);
        return { rows: [] };
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
      metadata: {
        host_session_id: "session-new",
        host_boot_id: "boot-1",
        machine: { cloud: "gcp" },
        runtime_health: { status: "ready", ready: true },
      },
    } as any);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("planned_project_host_transition"),
      ["host-1", operationId],
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

  it("accepts registration from a cloud host after startup timeout marked it error", async () => {
    currentMetadata = {
      desired_state: "running",
      bootstrap: { status: "done" },
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
        return { rows: [{ status: "error" }] };
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
        bay_id: "bay-1",
        status: "running",
      }),
    );
  });

  it("keeps ignoring registration from an error host that is not intended to run", async () => {
    currentMetadata = {
      desired_state: "stopped",
      bootstrap: { status: "failed" },
      host_session_id: "session-1",
      host_boot_id: "boot-1",
      machine: { cloud: "gcp" },
    };
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "error" }] };
      }
      if (
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

    await service.register({
      id: "host-1",
      metadata: currentMetadata,
    } as any);

    expect(upsertProjectHostMock).not.toHaveBeenCalled();
  });

  it("does not mark running projects opened when only the host process session changes", async () => {
    currentMetadata = {
      host_session_id: "session-old",
      host_boot_id: "boot-1",
      machine: { cloud: "gcp" },
      restart_recovery: {
        status: "running",
        host_boot_id: "boot-1",
        host_session_id: "session-old",
      },
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
    expect(currentMetadata.restart_recovery).toMatchObject({
      status: "queued",
      host_boot_id: "boot-1",
      previous_host_session_id: "session-old",
      host_session_id: "session-new",
      waiting_for: "runtime_ready",
    });
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
      runtime_health: { status: "ready", ready: true },
    };
    resolveMembershipForAccountMock = jest.fn(async (account_id: string) => ({
      effective_limits: {
        shared_compute_priority: account_id === "owner-high" ? 10 : 0,
      },
    }));
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes(
          "SELECT status, last_seen, metadata FROM project_hosts WHERE id=$1",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              last_seen: new Date(),
              metadata: currentMetadata,
            },
          ],
        };
      }
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
      host_session_id: "session-new",
    });
    expect(startProjectOnHostMock).toHaveBeenNthCalledWith(2, "proj-low", {
      account_id: "owner-low",
      ignore_recent_state_snapshot: true,
      host_session_id: "session-new",
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

describe("host-registry runtime availability", () => {
  const readyMetadata = {
    runtime_health: {
      status: "ready",
      ready: true,
      consecutive_failures: 0,
    },
  };

  it.each(["running_standard_fallback", "probing_spot"])(
    "preserves the standard-fallback summary during %s",
    async (phase) => {
      const { _test } = await import("./host-registry");

      expect(
        _test.hostRuntimeAvailability(readyMetadata, {
          spot_recovery_state: { phase },
        }),
      ).toMatchObject({
        state: "online",
        category: "unknown",
        summary: "Host is online on standard fallback.",
      });
    },
  );

  it("uses the normal online summary outside standard fallback", async () => {
    const { _test } = await import("./host-registry");

    expect(_test.hostRuntimeAvailability(readyMetadata)).toMatchObject({
      state: "online",
      category: "unknown",
      summary: "Host is online.",
    });
  });

  it("prefers an explicitly reported idle phase over stale control-plane fallback metadata", async () => {
    const { _test } = await import("./host-registry");

    expect(
      _test.hostRuntimeAvailability(
        {
          ...readyMetadata,
          spot_recovery_state: { phase: "idle" },
        },
        {
          spot_recovery_state: { phase: "running_standard_fallback" },
        },
      ),
    ).toMatchObject({
      state: "online",
      category: "unknown",
      summary: "Host is online.",
    });
  });
});
