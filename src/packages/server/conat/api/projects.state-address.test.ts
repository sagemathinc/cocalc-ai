export {};

let assertCollabMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let interBayStateMock: jest.Mock;
let interBayAddressMock: jest.Mock;
let interBayActiveOpMock: jest.Mock;
let interBayMoveMock: jest.Mock;
let requireDangerousProjectMutationAuthMock: jest.Mock;
let poolQueryMock: jest.Mock;
let createLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let lroStreamNameMock: jest.Mock;
let loadProjectRuntimeSponsorMock: jest.Mock;
let assertCanStartUsingRuntimeSponsorMock: jest.Mock;
let reserveProjectRuntimeSlotMock: jest.Mock;
let releaseProjectRuntimeSlotMock: jest.Mock;

jest.mock("@cocalc/server/projects/create", () => ({
  __esModule: true,
  default: jest.fn(),
}));

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

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/projects/collaborators", () => ({
  __esModule: true,
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: jest.fn(),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => poolQueryMock(...args),
  })),
}));

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: jest.fn(() => ({})),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  updateAuthorizedKeysOnHost: jest.fn(),
  takeStartProjectPhaseTimings: jest.fn(() => undefined),
}));

jest.mock("@cocalc/server/projects/control", () => ({
  __esModule: true,
  getProject: jest.fn(),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectControl: jest.fn(() => ({
      state: (...args: any[]) => interBayStateMock(...args),
      address: (...args: any[]) => interBayAddressMock(...args),
      activeOp: (...args: any[]) => interBayActiveOpMock(...args),
      move: (...args: any[]) => interBayMoveMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/projects/copy-db", () => ({
  __esModule: true,
  cancelCopy: jest.fn(),
  listCopiesForProject: jest.fn(async () => []),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
  updateLro: jest.fn(),
}));

jest.mock("@cocalc/server/projects/start-lro-progress", () => ({
  __esModule: true,
  mirrorStartLroProgress: jest.fn(),
}));

jest.mock("@cocalc/server/projects/start-lro-cleanup", () => ({
  __esModule: true,
  supersedeOlderProjectStartLros: jest.fn(),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: (...args: any[]) => publishLroEventMock(...args),
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/conat/lro/names", () => ({
  __esModule: true,
  lroStreamName: (...args: any[]) => lroStreamNameMock(...args),
}));

jest.mock("@cocalc/conat/persist/util", () => ({
  __esModule: true,
  SERVICE: "persist-service",
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: jest.fn(),
  assertCollabAllowRemoteProjectAccess: (...args: any[]) =>
    assertCollabMock(...args),
}));

jest.mock("./project-dangerous-auth", () => ({
  __esModule: true,
  PROJECT_DANGEROUS_INTERNAL_AUTH: Symbol("project-dangerous-internal-auth"),
  requireDangerousProjectMutationAuth: (...args: any[]) =>
    requireDangerousProjectMutationAuthMock(...args),
}));

jest.mock("@cocalc/server/projects/runtime-sponsor-db", () => ({
  __esModule: true,
  loadProjectRuntimeSponsor: (...args: any[]) =>
    loadProjectRuntimeSponsorMock(...args),
  assertCanStartUsingRuntimeSponsor: (...args: any[]) =>
    assertCanStartUsingRuntimeSponsorMock(...args),
}));

jest.mock("@cocalc/server/projects/runtime-slots", () => ({
  __esModule: true,
  DEFAULT_RUNTIME_SLOT_TTL_MS: 15 * 60 * 1000,
  reserveProjectRuntimeSlot: (...args: any[]) =>
    reserveProjectRuntimeSlotMock(...args),
  releaseProjectRuntimeSlot: (...args: any[]) =>
    releaseProjectRuntimeSlotMock(...args),
}));

describe("projects.getProjectState / getProjectAddress", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-1",
      epoch: 7,
    }));
    interBayStateMock = jest.fn(async () => ({
      state: "running",
      ip: "10.0.0.1",
    }));
    interBayAddressMock = jest.fn(async () => ({
      host: "10.0.0.1",
      port: 443,
      secret_token: "secret",
    }));
    interBayActiveOpMock = jest.fn(async () => ({
      project_id: "proj-1",
      op_id: "op-1",
      kind: "project-start",
      action: "start",
      status: "running",
      started_by_account_id: "acct-1",
      source_bay_id: "bay-0",
      phase: "runner_start",
      message: "starting",
      progress: 50,
      detail: null,
      started_at: new Date("2026-04-08T10:00:00Z"),
      updated_at: new Date("2026-04-08T10:00:01Z"),
    }));
    interBayMoveMock = jest.fn(async () => ({
      op_id: "move-op-1",
      scope_type: "project",
      scope_id: "proj-1",
      service: "persist-service",
      stream_name: "lro.move-op-1",
    }));
    requireDangerousProjectMutationAuthMock = jest.fn(async () => undefined);
    poolQueryMock = jest.fn(async () => ({
      rows: [
        {
          source_host_id: null,
          last_edited: new Date("2026-04-08T10:00:00Z"),
          last_backup: new Date("2026-04-08T10:00:01Z"),
        },
      ],
    }));
    createLroMock = jest.fn(async () => ({
      op_id: "move-op-local",
      scope_type: "project",
      scope_id: "proj-1",
      status: "queued",
    }));
    publishLroSummaryMock = jest.fn(async () => undefined);
    publishLroEventMock = jest.fn(async () => undefined);
    lroStreamNameMock = jest.fn((opId) => `lro.${opId}`);
    loadProjectRuntimeSponsorMock = jest.fn(async () => ({
      sponsor_account_id: "sponsor-1",
      owning_bay_id: "bay-0",
      host_id: "host-0",
      users: { "acct-1": { group: "owner" } },
    }));
    assertCanStartUsingRuntimeSponsorMock = jest.fn(async () => undefined);
    reserveProjectRuntimeSlotMock = jest.fn(async () => ({
      sponsor_account_id: "sponsor-1",
      project_id: "proj-1",
      current: 1,
      existing: false,
      slot: {},
    }));
    releaseProjectRuntimeSlotMock = jest.fn(async () => undefined);
  });

  it("routes project state reads through the owning bay", async () => {
    const { getProjectState } = await import("./projects");
    await expect(
      getProjectState({
        account_id: "acct-1",
        project_id: "proj-1",
      }),
    ).resolves.toEqual({
      state: "running",
      ip: "10.0.0.1",
    });
    expect(interBayStateMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      epoch: 7,
    });
  });

  it("routes project address reads through the owning bay", async () => {
    const { getProjectAddress } = await import("./projects");
    await expect(
      getProjectAddress({
        account_id: "acct-1",
        project_id: "proj-1",
      }),
    ).resolves.toEqual({
      host: "10.0.0.1",
      port: 443,
      secret_token: "secret",
    });
    expect(interBayAddressMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      account_id: "acct-1",
      epoch: 7,
    });
  });

  it("routes project active operation reads through the owning bay", async () => {
    const { getProjectActiveOperation } = await import("./projects");
    await expect(
      getProjectActiveOperation({
        account_id: "acct-1",
        project_id: "proj-1",
      }),
    ).resolves.toMatchObject({
      project_id: "proj-1",
      op_id: "op-1",
      kind: "project-start",
      action: "start",
      status: "running",
      phase: "runner_start",
    });
    expect(interBayActiveOpMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      epoch: 7,
    });
  });

  it("routes project move requests through the owning bay", async () => {
    const { moveProject } = await import("./projects");
    await expect(
      moveProject({
        account_id: "acct-1",
        session_hash: "session-1",
        project_id: "proj-1",
        dest_host_id: "host-1",
        allow_offline: true,
      }),
    ).resolves.toEqual({
      op_id: "move-op-1",
      scope_type: "project",
      scope_id: "proj-1",
      service: "persist-service",
      stream_name: "lro.move-op-1",
    });
    expect(interBayMoveMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      account_id: "acct-1",
      session_hash: "session-1",
      dest_host_id: "host-1",
      allow_offline: true,
      epoch: 7,
    });
    expect(requireDangerousProjectMutationAuthMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      browser_id: undefined,
      session_hash: "session-1",
      internalAuth: undefined,
    });
  });

  it("reserves a runtime sponsor slot before creating a local move LRO", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 7,
    }));
    const { moveProject } = await import("./projects");

    await expect(
      moveProject({
        account_id: "acct-1",
        project_id: "proj-1",
        dest_host_id: "host-1",
        allow_offline: true,
      }),
    ).resolves.toEqual({
      op_id: "move-op-local",
      scope_type: "project",
      scope_id: "proj-1",
      service: "persist-service",
      stream_name: "lro.move-op-local",
    });

    expect(assertCanStartUsingRuntimeSponsorMock).toHaveBeenCalledWith({
      sponsor: expect.objectContaining({ sponsor_account_id: "sponsor-1" }),
      account_id: "acct-1",
    });
    expect(reserveProjectRuntimeSlotMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sponsor_account_id: "sponsor-1",
        project_id: "proj-1",
        actor_account_id: "acct-1",
        reason: "project-move",
        state: "starting",
      }),
    );
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project-move",
        input: expect.objectContaining({
          runtime_slot: {
            sponsor_account_id: "sponsor-1",
            existing: false,
          },
        }),
      }),
    );
    expect(reserveProjectRuntimeSlotMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sponsor_account_id: "sponsor-1",
        project_id: "proj-1",
        op_id: "move-op-local",
      }),
    );
  });
});
