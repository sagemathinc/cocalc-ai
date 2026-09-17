export {};

let assertLocalProjectOwnershipMock: jest.Mock;
let projectRunnerClientMock: jest.Mock;
let stopProjectOnHostMock: jest.Mock;
let startProjectOnHostMock: jest.Mock;
let advanceProjectRuntimeLifecycleRevisionMock: jest.Mock;
let getPoolQueryMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectOwnership: (...args: any[]) =>
    assertLocalProjectOwnershipMock(...args),
}));

jest.mock("@cocalc/conat/project/runner/run", () => ({
  __esModule: true,
  client: (...args: any[]) => projectRunnerClientMock(...args),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  advanceProjectRuntimeLifecycleRevision: (...args: any[]) =>
    advanceProjectRuntimeLifecycleRevisionMock(...args),
  startProjectOnHost: (...args: any[]) => startProjectOnHostMock(...args),
  stopProjectOnHost: (...args: any[]) => stopProjectOnHostMock(...args),
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

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => getPoolQueryMock(...args),
  })),
}));

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: jest.fn(() => ({})),
}));

jest.mock("@cocalc/database/postgres/query", () => ({
  __esModule: true,
  query: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/database/postgres/quota-site-settings", () => ({
  __esModule: true,
  getQuotaSiteSettings: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/server/membership/project-defaults", () => ({
  __esModule: true,
  getMembershipBrowserIdleTimeoutForAccount: jest.fn(async () => 0),
  getMembershipProjectDefaultsForAccount: jest.fn(async () => ({})),
  getMembershipRuntimeSchedulingForAccount: jest.fn(async () => ({
    io_class: "standard",
    shared_compute_priority: 0,
  })),
}));

describe("BaseProject local ownership", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const originalProduct = process.env.COCALC_PRODUCT;
  const originalRuntime = process.env.COCALC_PROJECT_RUNTIME;

  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_PRODUCT = "plus";
    delete process.env.COCALC_PROJECT_RUNTIME;
    assertLocalProjectOwnershipMock = jest.fn(async () => undefined);
    startProjectOnHostMock = jest.fn(async () => undefined);
    stopProjectOnHostMock = jest.fn(async () => undefined);
    advanceProjectRuntimeLifecycleRevisionMock = jest.fn(async () => 7);
    getPoolQueryMock = jest.fn(async () => ({ rows: [] }));
    projectRunnerClientMock = jest.fn(() => ({
      start: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(async () => ({ state: "opened" })),
      status: jest.fn(async () => ({ state: "running", ip: "1.2.3.4" })),
    }));
  });

  afterAll(() => {
    if (originalProduct == null) {
      delete process.env.COCALC_PRODUCT;
    } else {
      process.env.COCALC_PRODUCT = originalProduct;
    }
    if (originalRuntime == null) {
      delete process.env.COCALC_PROJECT_RUNTIME;
    } else {
      process.env.COCALC_PROJECT_RUNTIME = originalRuntime;
    }
  });

  it("blocks state access when the project belongs to another bay", async () => {
    assertLocalProjectOwnershipMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.state()).rejects.toThrow(
      "project belongs to another bay",
    );
    expect(projectRunnerClientMock).not.toHaveBeenCalled();
  });

  it("blocks stop when the project belongs to another bay", async () => {
    assertLocalProjectOwnershipMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.stop()).rejects.toThrow(
      "project belongs to another bay",
    );
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
  });

  it("treats stop with no assigned host as already stopped", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [{ host_id: null, state: "opened" }],
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.stop()).resolves.toBeUndefined();
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
  });

  it("fences a hostless restart before starting at the new revision", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [{ host_id: null, state: "opened" }],
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    project.computeQuota = jest.fn(async () => undefined);

    await project.restart({ account_id: "account-1", lro_op_id: "restart-1" });

    expect(advanceProjectRuntimeLifecycleRevisionMock).toHaveBeenCalledWith(
      PROJECT_ID,
    );
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
    expect(startProjectOnHostMock).toHaveBeenCalledWith(PROJECT_ID, {
      account_id: "account-1",
      ignore_recent_state_snapshot: true,
      lro_op_id: "restart-1",
      runtime_lifecycle_revision: 7,
    });
  });

  it("fails restart when its assigned host cannot confirm the stop fence", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [
        {
          host_deleted: null,
          host_found: false,
          host_id: "host-1",
          host_status: null,
          state: "running",
        },
      ],
    }));
    stopProjectOnHostMock.mockRejectedValueOnce(
      new Error("assigned host unavailable"),
    );
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);

    await expect(
      project.restart({ account_id: "account-1", lro_op_id: "restart-1" }),
    ).rejects.toThrow("assigned host unavailable");

    expect(stopProjectOnHostMock).toHaveBeenCalledWith(PROJECT_ID, {
      runtime_lifecycle_revision: 7,
    });
    expect(startProjectOnHostMock).not.toHaveBeenCalled();
  });

  it("treats stop for an inactive project as already stopped", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [
        {
          host_deleted: null,
          host_found: true,
          host_id: "host-1",
          host_status: "running",
          state: "opened",
        },
      ],
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.stop()).resolves.toBeUndefined();
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
  });

  it("fences an in-flight start even when the state snapshot is inactive", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [
        {
          host_deleted: null,
          host_found: true,
          host_id: "host-1",
          host_status: "running",
          state: "opened",
        },
      ],
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(
      project.stop({ fence_inflight_start: true }),
    ).resolves.toBeUndefined();
    expect(stopProjectOnHostMock).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("treats stop on a deprovisioned host as already stopped", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [
        {
          host_deleted: null,
          host_found: true,
          host_id: "host-1",
          host_status: "deprovisioned",
          state: "running",
        },
      ],
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.stop()).resolves.toBeUndefined();
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
  });

  it("treats stop on a missing assigned host as already stopped", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [
        {
          host_deleted: null,
          host_found: false,
          host_id: "host-1",
          host_status: null,
          state: "running",
        },
      ],
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.stop()).resolves.toBeUndefined();
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
  });

  it("stops active projects with an assigned host", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [
        {
          host_deleted: null,
          host_found: true,
          host_id: "host-1",
          host_status: "running",
          state: "running",
        },
      ],
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.stop()).resolves.toBeUndefined();
    expect(stopProjectOnHostMock).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("routes a workspace start to the local runner without assigning a host", async () => {
    process.env.COCALC_PRODUCT = "launchpad";
    process.env.COCALC_PROJECT_RUNTIME = "workspace";
    const runnerStart = jest.fn(async () => ({ state: "running" }));
    projectRunnerClientMock = jest.fn(() => ({
      start: runnerStart,
      stop: jest.fn(),
      status: jest.fn(),
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.start()).resolves.toBeUndefined();
    expect(runnerStart).toHaveBeenCalledWith({ project_id: PROJECT_ID });
    expect(startProjectOnHostMock).not.toHaveBeenCalled();
  });

  it("routes a hostless workspace stop to the local runner", async () => {
    process.env.COCALC_PRODUCT = "launchpad";
    process.env.COCALC_PROJECT_RUNTIME = "workspace";
    const runnerStop = jest.fn(async () => ({ state: "opened" }));
    projectRunnerClientMock = jest.fn(() => ({
      start: jest.fn(),
      stop: runnerStop,
      status: jest.fn(),
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.stop({ force: true })).resolves.toBeUndefined();
    expect(runnerStop).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      force: true,
    });
    expect(getPoolQueryMock).not.toHaveBeenCalled();
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
  });

  it("allows local state access and caches the ownership check", async () => {
    const runnerStatus = jest.fn(async () => ({
      state: "running",
      ip: "1.2.3.4",
    }));
    projectRunnerClientMock = jest.fn(() => ({
      status: runnerStatus,
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.state()).resolves.toEqual({
      state: "running",
      ip: "1.2.3.4",
    });
    await expect(project.state()).resolves.toEqual({
      state: "running",
      ip: "1.2.3.4",
    });
    expect(assertLocalProjectOwnershipMock).toHaveBeenCalledTimes(1);
    expect(runnerStatus).toHaveBeenCalledTimes(2);
  });
});
