/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let poolQueryMock: jest.Mock;
let startMock: jest.Mock;
let reserveSlotMock: jest.Mock;
let heartbeatSlotMock: jest.Mock;
let isAdminMock: jest.Mock;
let countsTowardManagedCpuBudgetForHostMock: jest.Mock;
let getManagedProjectCpuPolicyMock: jest.Mock;
let assertProjectStartAllowedDuringMoveMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => poolQueryMock(...args),
  })),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBayDirect: jest.fn(async () => ({
    bay_id: "bay-0",
    epoch: 0,
  })),
}));

jest.mock("@cocalc/server/projects/control", () => ({
  __esModule: true,
  getProject: jest.fn(async () => ({
    start: (...args: any[]) => startMock(...args),
  })),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/projects/runtime-slots", () => ({
  __esModule: true,
  reserveProjectRuntimeSlot: (...args: any[]) => reserveSlotMock(...args),
  heartbeatProjectRuntimeSlot: (...args: any[]) => heartbeatSlotMock(...args),
  releaseProjectRuntimeSlot: jest.fn(async () => undefined),
  getProjectRuntimeSlotDenial: jest.fn(async () => null),
  RuntimeSponsorSlotsExhaustedError: class RuntimeSponsorSlotsExhaustedError extends Error {},
}));

jest.mock("@cocalc/server/projects/move-guard", () => ({
  __esModule: true,
  assertProjectStartAllowedDuringMove: (...args: any[]) =>
    assertProjectStartAllowedDuringMoveMock(...args),
}));

jest.mock("@cocalc/server/membership/managed-cpu-scope", () => ({
  __esModule: true,
  countsTowardManagedCpuBudgetForHost: (...args: any[]) =>
    countsTowardManagedCpuBudgetForHostMock(...args),
}));

jest.mock("@cocalc/server/membership/managed-cpu-policy", () => ({
  __esModule: true,
  getManagedProjectCpuPolicy: (...args: any[]) =>
    getManagedProjectCpuPolicyMock(...args),
  formatManagedProjectCpuPolicyBlockMessage: (policy: any) =>
    `managed CPU budget exceeded (${policy.blocked_by})`,
}));

jest.mock("@cocalc/server/projects/active-operation", () => ({
  __esModule: true,
  upsertProjectActiveOperation: jest.fn(async () => undefined),
  clearProjectActiveOperation: jest.fn(async () => undefined),
  getProjectActiveOperation: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/inter-bay/start-lro-forward", () => ({
  __esModule: true,
  forwardRemoteStartLroProgress: jest.fn(async () => async () => undefined),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  getProject: jest.fn(),
}));

jest.mock("@cocalc/server/conat/api/projects", () => ({
  __esModule: true,
  moveProject: jest.fn(),
  createBackup: jest.fn(),
}));

function mockProjectRow({
  allowCollaboratorStarts,
  autostartEnabled,
  backupRepoId,
  provisioned,
}: {
  allowCollaboratorStarts?: boolean | null;
  autostartEnabled?: boolean | null;
  backupRepoId?: string | null;
  provisioned?: boolean | null;
}) {
  poolQueryMock.mockResolvedValue({
    rows: [
      {
        runtime_sponsor_account_id: "owner",
        usage_account_id: null,
        allow_collaborator_starts_using_sponsor: allowCollaboratorStarts,
        autostart_enabled: autostartEnabled,
        users: {
          owner: { group: "owner" },
          collaborator: { group: "collaborator" },
        },
        owning_bay_id: "bay-0",
        host_id: "host-1",
        backup_repo_id: backupRepoId ?? null,
        provisioned: provisioned ?? null,
      },
    ],
  });
}

describe("project-control runtime sponsor start policy", () => {
  beforeEach(() => {
    jest.resetModules();
    poolQueryMock = jest.fn();
    startMock = jest.fn(async () => undefined);
    reserveSlotMock = jest.fn(async () => undefined);
    heartbeatSlotMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    countsTowardManagedCpuBudgetForHostMock = jest.fn(async () => true);
    getManagedProjectCpuPolicyMock = jest.fn(async () => ({ allowed: true }));
    assertProjectStartAllowedDuringMoveMock = jest.fn(async () => undefined);
  });

  it("blocks ordinary collaborator starts when sponsor starts are disabled", async () => {
    mockProjectRow({ allowCollaboratorStarts: false });
    const { handleProjectControlStart } = await import("./project-control");

    await expect(
      handleProjectControlStart({
        project_id: "project-1",
        account_id: "collaborator",
        lro_op_id: "op-1",
        source_bay_id: "bay-0",
        epoch: 0,
      }),
    ).rejects.toThrow("Collaborator starts using the runtime sponsor");

    expect(reserveSlotMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("allows owner starts when sponsor starts are disabled", async () => {
    mockProjectRow({ allowCollaboratorStarts: false });
    const { handleProjectControlStart } = await import("./project-control");

    await handleProjectControlStart({
      project_id: "project-1",
      account_id: "owner",
      lro_op_id: "op-1",
      source_bay_id: "bay-0",
      epoch: 0,
    });

    expect(reserveSlotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sponsor_account_id: "owner",
        actor_account_id: "owner",
      }),
    );
    expect(startMock).toHaveBeenCalled();
  });

  it("blocks autostart when automatic starts are disabled", async () => {
    mockProjectRow({ autostartEnabled: false });
    const { handleProjectControlStart } = await import("./project-control");

    await expect(
      handleProjectControlStart({
        project_id: "project-1",
        account_id: "owner",
        autostart: true,
        lro_op_id: "op-1",
        source_bay_id: "bay-0",
        epoch: 0,
      }),
    ).rejects.toThrow("Automatic starts are disabled");

    expect(reserveSlotMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("blocks starts while another project move owns the guard", async () => {
    mockProjectRow({});
    assertProjectStartAllowedDuringMoveMock.mockRejectedValue(
      new Error("Project is being moved"),
    );
    const { handleProjectControlStart } = await import("./project-control");

    await expect(
      handleProjectControlStart({
        project_id: "project-1",
        account_id: "owner",
        lro_op_id: "op-1",
        source_bay_id: "bay-0",
        epoch: 0,
      }),
    ).rejects.toThrow("Project is being moved");

    expect(reserveSlotMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("passes the move id to the owning-bay guard", async () => {
    mockProjectRow({});
    const { handleProjectControlCheckStartAdmission } =
      await import("./project-control");

    await handleProjectControlCheckStartAdmission({
      project_id: "project-1",
      account_id: "owner",
      project_move_id: "move-1",
      source_bay_id: "bay-0",
      epoch: 0,
    });

    expect(assertProjectStartAllowedDuringMoveMock).toHaveBeenCalledWith({
      project_id: "project-1",
      project_move_id: "move-1",
    });
  });

  it("reports when the owning bay must recover project storage", async () => {
    mockProjectRow({
      backupRepoId: "repo-1",
      provisioned: false,
    });
    const { handleProjectControlCheckStartAdmission } =
      await import("./project-control");

    const admission = await handleProjectControlCheckStartAdmission({
      project_id: "project-1",
      account_id: "owner",
      source_bay_id: "bay-0",
      epoch: 0,
    });

    expect(admission).toEqual({ storage_recovery_required: true });
  });

  it("allows explicit manual start when automatic starts are disabled", async () => {
    mockProjectRow({ autostartEnabled: false });
    const { handleProjectControlStart } = await import("./project-control");

    await handleProjectControlStart({
      project_id: "project-1",
      account_id: "owner",
      lro_op_id: "op-1",
      source_bay_id: "bay-0",
      epoch: 0,
    });

    expect(reserveSlotMock).toHaveBeenCalled();
    expect(startMock).toHaveBeenCalled();
  });

  it("blocks start admission when the managed CPU budget is exhausted", async () => {
    mockProjectRow({});
    getManagedProjectCpuPolicyMock.mockResolvedValue({
      allowed: false,
      blocked_by: "5h",
    });
    const { handleProjectControlCheckStartAdmission } =
      await import("./project-control");

    await expect(
      handleProjectControlCheckStartAdmission({
        project_id: "project-1",
        account_id: "owner",
        source_bay_id: "bay-0",
        epoch: 0,
      }),
    ).rejects.toThrow("managed CPU budget exceeded (5h)");

    expect(countsTowardManagedCpuBudgetForHostMock).toHaveBeenCalledWith({
      host_id: "host-1",
      project_id: "project-1",
    });
    expect(reserveSlotMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("blocks actual start before reserving a slot when the managed CPU budget is exhausted", async () => {
    mockProjectRow({});
    getManagedProjectCpuPolicyMock.mockResolvedValue({
      allowed: false,
      blocked_by: "7d",
    });
    const { handleProjectControlStart } = await import("./project-control");

    await expect(
      handleProjectControlStart({
        project_id: "project-1",
        account_id: "owner",
        lro_op_id: "op-1",
        source_bay_id: "bay-0",
        epoch: 0,
      }),
    ).rejects.toThrow("managed CPU budget exceeded (7d)");

    expect(reserveSlotMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("bypasses runtime sponsor admission for admin host drain restore starts", async () => {
    mockProjectRow({
      allowCollaboratorStarts: false,
      autostartEnabled: false,
    });
    const { handleProjectControlStart } = await import("./project-control");

    await handleProjectControlStart({
      project_id: "project-1",
      account_id: "collaborator",
      autostart: true,
      lro_op_id: "op-1",
      source_bay_id: "bay-0",
      managed_egress_override: "admin-host-drain",
      epoch: 0,
    });

    expect(reserveSlotMock).not.toHaveBeenCalled();
    expect(heartbeatSlotMock).not.toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "collaborator",
        managed_egress_override: "admin-host-drain",
      }),
    );
  });
});
