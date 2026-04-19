/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let upsertProjectHostMock: jest.Mock;
let ensureAutomaticHostRuntimeDeploymentsReconcileMock: jest.Mock;
let ensureAutomaticHostArtifactDeploymentsReconcileMock: jest.Mock;
let publishMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
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
});
