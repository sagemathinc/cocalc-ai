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
}: {
  allowCollaboratorStarts?: boolean | null;
}) {
  poolQueryMock.mockResolvedValue({
    rows: [
      {
        runtime_sponsor_account_id: "owner",
        usage_account_id: null,
        allow_collaborator_starts_using_sponsor: allowCollaboratorStarts,
        users: {
          owner: { group: "owner" },
          collaborator: { group: "collaborator" },
        },
        owning_bay_id: "bay-0",
        host_id: "host-1",
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
});
