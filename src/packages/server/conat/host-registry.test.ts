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
let computeQuotaMock: jest.Mock;
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

jest.mock("@cocalc/server/projects/control", () => ({
  getProject: (project_id: string) => ({
    computeQuota: (...args: any[]) => computeQuotaMock(project_id, ...args),
  }),
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
  exchangeProjectHostBootstrapToken: jest.fn(),
  proveProjectHostMasterToken: jest.fn(),
  rotateProjectHostMasterToken: jest.fn(),
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
    computeQuotaMock = jest.fn(async () => undefined);
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

  function applyRestartRecoveryMetadataUpdate(params: any[]) {
    const expectedHostSessionId = params[2];
    if (
      expectedHostSessionId != null &&
      currentMetadata?.host_session_id !== expectedHostSessionId
    ) {
      return { rowCount: 0, rows: [] };
    }
    const patch = JSON.parse(params[1]);
    currentMetadata = {
      ...currentMetadata,
      restart_recovery: {
        ...(currentMetadata?.restart_recovery ?? {}),
        ...patch,
      },
    };
    return { rowCount: 1, rows: [] };
  }

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
      if (sql.includes("'{shutdown_notice}'")) {
        currentMetadata = {
          ...currentMetadata,
          shutdown_notice: JSON.parse(params[1]),
        };
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    // The recovery transaction: refuses while wanted stopped, marks the host
    // wanted running, writes the recovery state, queues the start.
    connectMock = jest.fn(async () => ({
      release: jest.fn(),
      query: jest.fn(async (sql: string, params: any[]) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] };
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [
              {
                desired_state: currentMetadata.desired_state,
                desired_state_generation: 4,
              },
            ],
          };
        }
        if (sql.includes("'{desired_state}'")) {
          currentMetadata = { ...currentMetadata, desired_state: params[1] };
          return { rows: [{ desired_state_generation: 5 }] };
        }
        if (sql.includes("'{spot_recovery_state}'")) {
          currentStatus = "starting";
          currentMetadata = {
            ...currentMetadata,
            spot_recovery_state: JSON.parse(params[1]),
          };
          return { rows: [] };
        }
        throw new Error(`unexpected transaction query: ${sql}`);
      }),
    }));
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
    // Queued under the recovery's intent generation, inside its transaction.
    expect(enqueueCloudVmWorkOnceMock.mock.calls[0][0].payload).toMatchObject({
      source: "shutdown_notice",
      intent_generation: 5,
    });
    expect(
      enqueueCloudVmWorkOnceMock.mock.calls[0][1]?.inTransaction,
    ).toBeTruthy();
    expect(currentMetadata.desired_state).toBe("running");
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
        sql.includes("UPDATE project_hosts") &&
        sql.includes("'{restart_recovery}'")
      ) {
        expect(params[0]).toBe("host-1");
        return applyRestartRecoveryMetadataUpdate(params);
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

  it("retries artifact convergence on heartbeat while a host upgrade is in flight at register", async () => {
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
        sql.includes("UPDATE project_hosts") &&
        sql.includes("'{restart_recovery}'")
      ) {
        return applyRestartRecoveryMetadataUpdate(params);
      }
      if (
        sql.includes(
          "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        currentMetadata = params[1];
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    ensureAutomaticHostRuntimeDeploymentsReconcileMock = jest.fn(async () => ({
      queued: false,
      host_id: "host-1",
      reason: "no_reconcile_needed",
    }));
    // The upgrade that restarted project-host has not recorded its target yet.
    ensureAutomaticHostArtifactDeploymentsReconcileMock = jest
      .fn()
      .mockResolvedValueOnce({
        queued: false,
        host_id: "host-1",
        reason: "host_upgrade_in_flight",
      })
      .mockResolvedValueOnce({
        queued: false,
        host_id: "host-1",
        reason: "no_reconcile_needed",
      });

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();
    const registration = {
      id: "host-1",
      metadata: { host_session_id: "session-2", machine: { cloud: "gcp" } },
    } as any;

    await service.register(registration);
    expect(
      currentMetadata?.runtime_deployments?.pending_automatic_convergence_retry,
    ).toMatchObject({ artifacts: true });

    await service.heartbeat(registration);
    expect(
      ensureAutomaticHostArtifactDeploymentsReconcileMock,
    ).toHaveBeenCalledTimes(2);
    expect(
      currentMetadata?.runtime_deployments?.pending_automatic_convergence_retry,
    ).toBeUndefined();
  });

  it("re-delivers project content epochs in the hosts' catch-up sync", async () => {
    const seen: string[] = [];
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM projects") && sql.includes("users")) {
        seen.push(sql);
        // Like the database: the column is only there if selected.
        return {
          rows: [
            {
              project_id: "project-1",
              users: {},
              runtime_lifecycle_revision: "1",
              ...(sql.includes("AS content_epoch")
                ? { content_epoch: "3" }
                : {}),
              updated_ms: "10",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { initHostRegistryService } = await import("./host-registry");
    const service: any = await initHostRegistryService();
    const deltas = await service.listProjectUserDeltas({ host_id: "host-1" });
    const reconcile = await service.listProjectUserReconcile({
      host_id: "host-1",
    });
    expect(deltas.rows[0].content_epoch).toBe("3");
    expect(reconcile.rows[0].content_epoch).toBe("3");
    expect(seen).toHaveLength(2);
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
    queryMock = jest.fn(async (sql: string, params: any[]) => {
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
        sql.includes("UPDATE project_hosts") &&
        sql.includes("'{restart_recovery}'")
      ) {
        expect(params[0]).toBe("host-1");
        return applyRestartRecoveryMetadataUpdate(params);
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
    queryMock = jest.fn(async (sql: string, params: any[]) => {
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
        sql.includes("UPDATE project_hosts") &&
        sql.includes("'{restart_recovery}'")
      ) {
        expect(params[0]).toBe("host-1");
        return applyRestartRecoveryMetadataUpdate(params);
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
        sql.includes("UPDATE project_hosts") &&
        sql.includes("'{restart_recovery}'")
      ) {
        expect(params[0]).toBe("host-1");
        return applyRestartRecoveryMetadataUpdate(params);
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
        sql.includes("UPDATE project_hosts") &&
        sql.includes("'{restart_recovery}'")
      ) {
        expect(params[0]).toBe("host-1");
        return applyRestartRecoveryMetadataUpdate(params);
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
        sql.includes("UPDATE project_hosts") &&
        sql.includes("'{restart_recovery}'")
      ) {
        expect(params[0]).toBe("host-1");
        return applyRestartRecoveryMetadataUpdate(params);
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

    // A failure to recompute the quota keeps the stored one.
    computeQuotaMock = jest.fn(async (project_id: string) => {
      if (project_id === "proj-low") throw new Error("quota unavailable");
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
    // The current membership, not the quota stored before the restart.
    expect(computeQuotaMock.mock.calls).toEqual([
      ["proj-high", "owner-high"],
      ["proj-low", "owner-low"],
    ]);
    for (const index of [0, 1]) {
      expect(computeQuotaMock.mock.invocationCallOrder[index]).toBeLessThan(
        startProjectOnHostMock.mock.invocationCallOrder[index],
      );
    }
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

  it("does not update recovery metadata after the host session changes", async () => {
    currentMetadata = {
      host_session_id: "session-old",
      host_boot_id: "boot-new",
      runtime_health: { status: "ready", ready: true },
      heartbeat_sequence: 11,
    };
    let recoveryUpdateSql = "";
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
        sql.includes("UPDATE project_hosts") &&
        sql.includes("'{restart_recovery}'")
      ) {
        recoveryUpdateSql = sql;
        expect(params[2]).toBe("session-old");
        currentMetadata = {
          ...currentMetadata,
          host_session_id: "session-new",
          heartbeat_sequence: 12,
        };
        return applyRestartRecoveryMetadataUpdate(params);
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

    const { startHostRestartRecoveryForHost } = await import("./host-registry");
    await startHostRestartRecoveryForHost({
      host_id: "host-1",
      host_boot_id: "boot-new",
      previous_host_boot_id: "boot-old",
      previous_host_session_id: "session-before-old",
      host_session_id: "session-old",
      source: "register",
      max_parallel_starts: 1,
    });

    expect(recoveryUpdateSql).toContain("jsonb_set");
    expect(recoveryUpdateSql).toContain("metadata->>'host_session_id'");
    expect(currentMetadata).toMatchObject({
      host_session_id: "session-new",
      heartbeat_sequence: 12,
    });
    expect(currentMetadata.restart_recovery).toBeUndefined();
    expect(startProjectOnHostMock).not.toHaveBeenCalled();
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
      if (sql.includes("SELECT host_id FROM projects WHERE project_id=$1")) {
        return { rows: [{ host_id: "host-1" }] };
      }
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

  it.each([
    ["on another host", [{ host_id: "host-2" }]],
    ["with no host", [{ host_id: null }]],
    ["missing or deleted", []],
  ])(
    "refuses a pressure report for a project %s, and writes no log (068-2)",
    async (_label, rows) => {
      queryMock = jest.fn(async (sql: string, params: any[]) => {
        if (sql.includes("SELECT host_id FROM projects WHERE project_id=$1")) {
          expect(params).toEqual(["proj-b"]);
          return { rows };
        }
        throw new Error(`unexpected query: ${sql}`);
      });
      const { initHostRegistryService } = await import("./host-registry");
      const service = await initHostRegistryService();
      await expect(
        service.reportProjectPressureAction({
          host_id: "host-1",
          project_id: "proj-b",
          action_status: "stopped",
          pressure_zone: "pressure",
          reason: "low_priority",
        }),
      ).rejects.toThrow("the project is not on the calling host");
      expect(appendProjectLogRowBestEffortMock).not.toHaveBeenCalled();
    },
  );
});

describe("host report sanitizer (054 C containment)", () => {
  const DENIED = [
    "self_host",
    "local",
    "provider",
    "cloud_provider",
    "machine",
    "runtime",
    "dns",
    "cloudflare_tunnel",
    "public_route",
    "content_dns",
    "public_url",
    "public_ip",
    "ip_address",
  ];
  const STORED_URLS = {
    public_url: "https://host-1.cocalc.example",
    internal_url: "http://10.0.0.5:9002",
  };
  let currentMetadata: any;
  let storedUrlQueries: number;

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
    computeQuotaMock = jest.fn(async () => undefined);
    loadProjectRuntimeSponsorMock = jest.fn(async () => undefined);
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
    // The bay-seeded row: a cloud host whose self_host the bay wrote.
    currentMetadata = {
      host_session_id: "session-1",
      host_boot_id: "boot-1",
      machine: { cloud: "gcp" },
      self_host: { http_tunnel_port: 41000, ssh_tunnel_port: 41001 },
    };
    storedUrlQueries = 0;
    upsertProjectHostMock = jest.fn(async () => undefined);
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
          "SELECT public_url, internal_url FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        storedUrlQueries += 1;
        return { rows: [STORED_URLS] };
      }
      if (
        sql.includes(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        ) ||
        sql.includes(
          "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ metadata: currentMetadata, bay_id: "bay-0" }] };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it("strips each denied top-level key and keeps everything else", async () => {
    const { stripHostReportedMetadata, HOST_REPORT_DENIED_METADATA_KEYS } =
      await import("./host-registry");
    expect([...HOST_REPORT_DENIED_METADATA_KEYS].sort()).toEqual(
      [...DENIED].sort(),
    );
    for (const key of DENIED) {
      const stripped: any = stripHostReportedMetadata({
        [key]: { anything: 1 },
        software: { project_host: "1.0.0" },
        host_session_id: "s",
      });
      expect(stripped).not.toHaveProperty(key);
      expect(stripped.software).toEqual({ project_host: "1.0.0" });
      expect(stripped.host_session_id).toBe("s");
    }
    const original = { self_host: { http_tunnel_port: 1 }, metrics: {} };
    stripHostReportedMetadata(original);
    expect(original).toHaveProperty("self_host");
    expect(stripHostReportedMetadata(undefined)).toBeUndefined();
  });

  it("refuses each bad URL class and keeps good URLs", async () => {
    const { sanitizeHostReport } = await import("./host-registry");
    for (const bad of [
      "http://127.0.0.1:5432",
      "http://localhost:9002",
      "http://2130706433/",
      "http://[::1]/",
      "http://0.0.0.0:9002",
      "http://169.254.169.254/",
      "http://metadata.google.internal/",
      "file:///etc/passwd",
      "http://user:pw@host.example",
      "not a url",
    ]) {
      const { report, refusedUrlFields } = sanitizeHostReport(
        { public_url: bad, internal_url: bad } as any,
        { isLocalSelfHost: false },
      );
      expect(refusedUrlFields.sort()).toEqual(["internal_url", "public_url"]);
      expect(report.public_url).toBeUndefined();
      expect(report.internal_url).toBeUndefined();
    }
    const good = sanitizeHostReport(
      {
        public_url: "https://host-1.cocalc.example",
        internal_url: "http://10.206.0.38:9002",
      } as any,
      { isLocalSelfHost: false },
    );
    expect(good.refusedUrlFields).toEqual([]);
    expect(good.report.public_url).toBe("https://host-1.cocalc.example");
    expect(good.report.internal_url).toBe("http://10.206.0.38:9002");
    const local = sanitizeHostReport(
      {
        public_url: "http://127.0.0.1:9002",
        internal_url: "http://127.0.0.1:9002",
        metadata: { local: true },
      } as any,
      { isLocalSelfHost: true },
    );
    expect(local.refusedUrlFields).toEqual([]);
    expect(local.report.public_url).toBeUndefined();
    expect(local.report.metadata).toEqual({});
  });

  for (const method of ["register", "heartbeat"] as const) {
    it(`${method}: a host report can't set or replace denied keys or point the URLs at refused addresses`, async () => {
      const { initHostRegistryService } = await import("./host-registry");
      const service = await initHostRegistryService();
      await service[method]({
        id: "host-1",
        public_url: "http://127.0.0.1:5432",
        internal_url: "http://169.254.169.254/",
        metadata: {
          host_session_id: "session-1",
          host_boot_id: "boot-1",
          software: { project_host: "1.0.0" },
          self_host: { http_tunnel_port: "127.0.0.1:22#" },
          local: true,
          provider: "star",
          cloud_provider: "star",
          machine: {
            cloud: "self-host",
            metadata: { self_host_mode: "local" },
          },
          runtime: { public_ip: "10.1.2.3", ssh_user: "-oX=y" },
          dns: { record_id: "other-hosts-record" },
          cloudflare_tunnel: { id: "other-tunnel", record_id: "r" },
          public_route: { active_mode: "cloudflare-proxy" },
          content_dns: { domain: "x", records: [] },
          public_url: "https://elsewhere.example",
          public_ip: "10.1.2.3",
          ip_address: "10.1.2.3",
        },
      } as any);
      expect(upsertProjectHostMock).toHaveBeenCalledTimes(1);
      const written = upsertProjectHostMock.mock.calls[0][0];
      for (const key of DENIED) {
        expect(written.metadata).not.toHaveProperty(key);
      }
      expect(written.metadata.software).toEqual({ project_host: "1.0.0" });
      // refused URLs keep the stored values, never the reported ones
      expect(written.public_url).toBe(STORED_URLS.public_url);
      expect(written.internal_url).toBe(STORED_URLS.internal_url);
      expect(storedUrlQueries).toBe(1);
    });

    it(`${method}: no accepted or refused URL text reaches the logger (R2)`, async () => {
      const loggerModule: any = await import("@cocalc/backend/logger");
      const { initHostRegistryService } = await import("./host-registry");
      const service = await initHostRegistryService();
      const texts = [
        "accepted-host.cocalc.example",
        "10.9.8.7",
        "127.0.0.1:5432",
        "169.254.169.254",
        "secret-path-marker",
      ];
      for (const [public_url, internal_url] of [
        [
          "https://accepted-host.cocalc.example/secret-path-marker?q=1",
          "http://10.9.8.7:9002",
        ],
        ["http://127.0.0.1:5432", "http://169.254.169.254/secret-path-marker"],
      ]) {
        await service[method]({
          id: "host-1",
          public_url,
          internal_url,
          metadata: { host_session_id: "session-1", host_boot_id: "boot-1" },
        } as any);
      }
      const logged = loggerModule.getLogger.mock.results
        .map((r: any) => r.value)
        .flatMap((l: any) =>
          ["info", "debug", "warn", "silly"].flatMap((level) =>
            (l?.[level]?.mock?.calls ?? []).map((c: any[]) =>
              JSON.stringify(c, (_k, v) => (v instanceof Error ? `${v}` : v)),
            ),
          ),
        )
        .join("\n");
      expect(logged).toContain("register");
      for (const text of texts) {
        expect(logged).not.toContain(text);
      }
    });

    it(`${method}: a clean report is passed through unchanged`, async () => {
      const { initHostRegistryService } = await import("./host-registry");
      const service = await initHostRegistryService();
      await service[method]({
        id: "host-1",
        public_url: "https://host-1.cocalc.example",
        internal_url: "http://10.0.0.5:9002",
        metadata: {
          host_session_id: "session-1",
          host_boot_id: "boot-1",
          software: { project_host: "1.0.0" },
        },
      } as any);
      const written = upsertProjectHostMock.mock.calls[0][0];
      expect(written.public_url).toBe("https://host-1.cocalc.example");
      expect(written.internal_url).toBe("http://10.0.0.5:9002");
      expect(written.metadata.software).toEqual({ project_host: "1.0.0" });
      expect(storedUrlQueries).toBe(0);
    });
  }
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

describe("host-registry master token exchange", () => {
  let tokens: any;
  let service: any;
  const masterInfo = {
    token_id: "m",
    host_id: "host-1",
    purpose: "master-conat",
    expires: new Date("2027-10-24T00:00:00Z"),
  };

  beforeAll(async () => {
    tokens = await import("@cocalc/server/project-host/bootstrap-token");
    const { initHostRegistryService } = await import("./host-registry");
    service = await initHostRegistryService();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    tokens.verifyProjectHostToken.mockReset();
    tokens.exchangeProjectHostBootstrapToken.mockReset();
    tokens.proveProjectHostMasterToken.mockReset();
    tokens.rotateProjectHostMasterToken.mockReset();
    tokens.rotateProjectHostMasterToken.mockResolvedValue({
      token: "new-master",
    });
  });

  it("exchanges a bootstrap token, bound to the host, when there is no current token", async () => {
    tokens.verifyProjectHostToken.mockResolvedValue(null);
    tokens.exchangeProjectHostBootstrapToken.mockResolvedValue({
      ok: true,
      host_id: "host-1",
      master: { token: "exchanged-master" },
    });
    await expect(
      service.rotateMasterConatToken({
        host_id: "host-1",
        current_token: "stale",
        bootstrap_token: "boot",
      }),
    ).resolves.toEqual({ master_conat_token: "exchanged-master" });
    expect(tokens.exchangeProjectHostBootstrapToken).toHaveBeenCalledWith(
      "boot",
      expect.objectContaining({ hostId: "host-1" }),
    );
    expect(tokens.rotateProjectHostMasterToken).not.toHaveBeenCalled();
  });

  it("refuses a bootstrap token whose exchange is closed or that is invalid", async () => {
    for (const reason of ["exchange_closed", "invalid"]) {
      tokens.exchangeProjectHostBootstrapToken.mockResolvedValue({
        ok: false,
        reason,
      });
      await expect(
        service.rotateMasterConatToken({
          host_id: "host-1",
          bootstrap_token: "boot",
        }),
      ).rejects.toThrow("token is invalid for host");
    }
    expect(tokens.rotateProjectHostMasterToken).not.toHaveBeenCalled();
  });

  it("rotates with a valid current token without touching the bootstrap token", async () => {
    tokens.verifyProjectHostToken.mockResolvedValue(masterInfo);
    await expect(
      service.rotateMasterConatToken({
        host_id: "host-1",
        current_token: "master",
        bootstrap_token: "boot",
      }),
    ).resolves.toEqual({ master_conat_token: "new-master" });
    // The current token is re-checked under the lock by its id.
    expect(tokens.rotateProjectHostMasterToken).toHaveBeenCalledWith(
      "host-1",
      "m",
      expect.anything(),
    );
    expect(tokens.exchangeProjectHostBootstrapToken).not.toHaveBeenCalled();
    expect(tokens.proveProjectHostMasterToken).not.toHaveBeenCalled();
  });

  it("refuses a current token revoked between the check and the locked rotation", async () => {
    tokens.verifyProjectHostToken.mockResolvedValue(masterInfo);
    tokens.rotateProjectHostMasterToken.mockResolvedValue(undefined);
    await expect(
      service.rotateMasterConatToken({
        host_id: "host-1",
        current_token: "master",
      }),
    ).rejects.toThrow("token is invalid for host");
  });

  it("refuses a current token of another host", async () => {
    tokens.verifyProjectHostToken.mockResolvedValue({
      ...masterInfo,
      host_id: "host-2",
    });
    await expect(
      service.rotateMasterConatToken({
        host_id: "host-1",
        current_token: "other",
      }),
    ).rejects.toThrow("token is invalid for host");
    expect(tokens.rotateProjectHostMasterToken).not.toHaveBeenCalled();
  });

  it("records the host's proof of its master token on a status check", async () => {
    tokens.verifyProjectHostToken.mockResolvedValue(masterInfo);
    tokens.proveProjectHostMasterToken.mockResolvedValue({
      valid: true,
      closed: 1,
    });
    await expect(
      service.getMasterConatTokenStatus({
        host_id: "host-1",
        current_token: "master",
      }),
    ).resolves.toEqual({ expires_at: "2027-10-24T00:00:00.000Z" });
    expect(tokens.proveProjectHostMasterToken).toHaveBeenCalledWith(
      "host-1",
      "m",
    );
  });

  it("does not record a proof for an invalid or foreign master token", async () => {
    tokens.verifyProjectHostToken.mockResolvedValue(null);
    await expect(
      service.getMasterConatTokenStatus({
        host_id: "host-1",
        current_token: "stale",
      }),
    ).rejects.toThrow("token is invalid for this host");
    tokens.verifyProjectHostToken.mockResolvedValue({
      ...masterInfo,
      host_id: "host-2",
    });
    await expect(
      service.getMasterConatTokenStatus({
        host_id: "host-1",
        current_token: "other",
      }),
    ).rejects.toThrow("token is invalid for this host");
    expect(tokens.proveProjectHostMasterToken).not.toHaveBeenCalled();
  });

  it("a valid token with nothing to close still succeeds; one revoked under the lock fails", async () => {
    tokens.verifyProjectHostToken.mockResolvedValue(masterInfo);
    tokens.proveProjectHostMasterToken.mockResolvedValue({
      valid: true,
      closed: 0,
    });
    await expect(
      service.getMasterConatTokenStatus({
        host_id: "host-1",
        current_token: "master",
      }),
    ).resolves.toEqual({ expires_at: "2027-10-24T00:00:00.000Z" });
    tokens.proveProjectHostMasterToken.mockResolvedValue({
      valid: false,
      closed: 0,
    });
    await expect(
      service.getMasterConatTokenStatus({
        host_id: "host-1",
        current_token: "master",
      }),
    ).rejects.toThrow("token is invalid for this host");
  });

  it("a failure to record the proof never fails the status check", async () => {
    tokens.verifyProjectHostToken.mockResolvedValue(masterInfo);
    tokens.proveProjectHostMasterToken.mockRejectedValue(new Error("db down"));
    await expect(
      service.getMasterConatTokenStatus({
        host_id: "host-1",
        current_token: "master",
      }),
    ).resolves.toEqual({ expires_at: "2027-10-24T00:00:00.000Z" });
  });
});

describe("authoritativeSshServer", () => {
  it("uses the provider-observed public IP for GCP hosts", async () => {
    const { authoritativeSshServer } = await import("./host-registry");
    const gcp = {
      machine: { cloud: "gcp" },
      runtime: { public_ip: "34.0.0.9" },
    };
    // The stack started at boot still reports the previous boot's address.
    expect(authoritativeSshServer(gcp, "34.0.0.1:2222")).toBe("34.0.0.9:2222");
    expect(
      authoritativeSshServer({ machine: { cloud: "gcp" } }, "34.0.0.1:2222"),
    ).toBe("34.0.0.1:2222");
    expect(
      authoritativeSshServer(
        { machine: { cloud: "nebius" }, runtime: { public_ip: "1.2.3.4" } },
        "10.0.0.5:2222",
      ),
    ).toBe("10.0.0.5:2222");
  });
});
