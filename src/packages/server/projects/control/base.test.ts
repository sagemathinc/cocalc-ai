export {};

let assertLocalProjectOwnershipMock: jest.Mock;
let projectRunnerClientMock: jest.Mock;
let stopProjectOnHostMock: jest.Mock;
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
  startProjectOnHost: jest.fn(async () => undefined),
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
  getMembershipProjectDefaultsForAccount: jest.fn(async () => ({})),
}));

describe("BaseProject local ownership", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectOwnershipMock = jest.fn(async () => undefined);
    stopProjectOnHostMock = jest.fn(async () => undefined);
    getPoolQueryMock = jest.fn(async () => ({ rows: [] }));
    projectRunnerClientMock = jest.fn(() => ({
      status: jest.fn(async () => ({ state: "running", ip: "1.2.3.4" })),
    }));
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

  it("treats stop for an inactive project as already stopped", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [{ host_id: "host-1", state: "opened" }],
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.stop()).resolves.toBeUndefined();
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
  });

  it("stops active projects with an assigned host", async () => {
    getPoolQueryMock = jest.fn(async () => ({
      rows: [{ host_id: "host-1", state: "running" }],
    }));
    const { getProject } = await import("./base");
    const project = getProject(PROJECT_ID);
    await expect(project.stop()).resolves.toBeUndefined();
    expect(stopProjectOnHostMock).toHaveBeenCalledWith(PROJECT_ID);
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
