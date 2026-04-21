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

jest.mock("@cocalc/conat/service/typed", () => ({
  createServiceHandler: jest.fn(async ({ impl }) => impl),
}));

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
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "running" }] };
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

  it("marks running projects opened when a host registers with a new session", async () => {
    currentMetadata = {
      host_session_id: "session-old",
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
      if (
        sql.includes(
          "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return { rows: [{ status: "running" }] };
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
      throw new Error(`unexpected query: ${sql}`);
    });

    const { initHostRegistryService } = await import("./host-registry");
    const service = await initHostRegistryService();

    await service.register({
      id: "host-1",
      metadata: {
        host_session_id: "session-new",
        machine: { cloud: "gcp" },
      },
    } as any);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(clientQueryMock).toHaveBeenCalledWith("BEGIN");
    expect(clientQueryMock).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(appendProjectOutboxEventForProjectMock).toHaveBeenCalledTimes(2);
    expect(appendProjectOutboxEventForProjectMock).toHaveBeenCalledWith({
      db: client,
      event_type: "project.state_changed",
      project_id: "proj-1",
      default_bay_id: "bay-0",
    });
    expect(publishProjectAccountFeedEventsBestEffortMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      default_bay_id: "bay-0",
    });
    expect(publishProjectAccountFeedEventsBestEffortMock).toHaveBeenCalledWith({
      project_id: "proj-2",
      default_bay_id: "bay-0",
    });
  });
});
