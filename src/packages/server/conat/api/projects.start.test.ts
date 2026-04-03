export {};

let assertCollabMock: jest.Mock;
let createLroMock: jest.Mock;
let updateLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let getProjectMock: jest.Mock;
let projectStartMock: jest.Mock;
let mirrorStartLroProgressMock: jest.Mock;
let supersedeOlderProjectStartLrosMock: jest.Mock;

async function flushBackgroundStartTask() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

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
  default: jest.fn(() => ({ query: jest.fn() })),
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
  getProject: (...args: any[]) => getProjectMock(...args),
}));

jest.mock("@cocalc/server/projects/copy-db", () => ({
  __esModule: true,
  cancelCopy: jest.fn(),
  listCopiesForProject: jest.fn(async () => []),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
  updateLro: (...args: any[]) => updateLroMock(...args),
}));

jest.mock("@cocalc/server/projects/start-lro-progress", () => ({
  __esModule: true,
  mirrorStartLroProgress: (...args: any[]) =>
    mirrorStartLroProgressMock(...args),
}));

jest.mock("@cocalc/server/projects/start-lro-cleanup", () => ({
  __esModule: true,
  supersedeOlderProjectStartLros: (...args: any[]) =>
    supersedeOlderProjectStartLrosMock(...args),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: (...args: any[]) => publishLroEventMock(...args),
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/conat/lro/names", () => ({
  __esModule: true,
  lroStreamName: jest.fn((op_id: string) => `stream:${op_id}`),
}));

jest.mock("@cocalc/conat/persist/util", () => ({
  __esModule: true,
  SERVICE: "persist-service",
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

describe("projects.start", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    createLroMock = jest.fn(async () => ({
      op_id: "op-1",
      kind: "project-start",
      scope_type: "project",
      scope_id: "proj-1",
      status: "queued",
    }));
    updateLroMock = jest.fn(async ({ status }: { status: string }) => ({
      op_id: "op-1",
      kind: "project-start",
      scope_type: "project",
      scope_id: "proj-1",
      status,
    }));
    publishLroSummaryMock = jest.fn(() => new Promise(() => {}));
    publishLroEventMock = jest.fn(async () => undefined);
    projectStartMock = jest.fn(async () => undefined);
    mirrorStartLroProgressMock = jest.fn(async () => async () => undefined);
    supersedeOlderProjectStartLrosMock = jest.fn(async () => undefined);
    getProjectMock = jest.fn(async () => ({
      start: projectStartMock,
    }));
  });

  it("does not let stuck summary publication block async project start", async () => {
    const { start } = await import("./projects");
    const response = await start({
      account_id: "acct-1",
      project_id: "proj-1",
      wait: false,
    });

    await flushBackgroundStartTask();

    expect(response).toEqual({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "proj-1",
      service: "persist-service",
      stream_name: "stream:op-1",
    });
    expect(projectStartMock).toHaveBeenCalledWith({
      lro_op_id: "op-1",
      account_id: "acct-1",
    });
    expect(supersedeOlderProjectStartLrosMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      keep_op_id: "op-1",
    });
    expect(publishLroSummaryMock).toHaveBeenCalled();
  });
});
