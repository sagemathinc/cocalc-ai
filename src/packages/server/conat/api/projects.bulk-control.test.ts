export {};

let assertCollabMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let interBayStopMock: jest.Mock;
let getProjectMock: jest.Mock;
let handleStopMock: jest.Mock;
let executeHubApiCallMock: jest.Mock;

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

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectControl: jest.fn(() => ({
      stop: (...args: any[]) => interBayStopMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/inter-bay/project-control", () => ({
  __esModule: true,
  handleProjectControlStop: (...args: any[]) => handleStopMock(...args),
}));

jest.mock("@cocalc/server/projects/copy-db", () => ({
  __esModule: true,
  cancelCopy: jest.fn(),
  listCopiesForProject: jest.fn(async () => []),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: jest.fn(),
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
  publishLroEvent: jest.fn(),
  publishLroSummary: jest.fn(),
}));

jest.mock("@cocalc/conat/lro/names", () => ({
  __esModule: true,
  lroStreamName: jest.fn(),
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

// Each project's call runs through the edge router, as if made directly.
jest.mock("./edge-routing", () => ({
  __esModule: true,
  executeHubApiCall: (...args: any[]) => executeHubApiCallMock(...args),
}));

const P = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];
const REQUEST = "99999999-9999-4999-8999-999999999999";

describe("projects.stopProjects / restartProjects", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    resolveProjectBayMock = jest.fn();
    interBayStopMock = jest.fn();
    handleStopMock = jest.fn();
    getProjectMock = jest.fn();
    executeHubApiCallMock = jest.fn(async ({ args }) => ({
      op_id: `op-${args[0].project_id}`,
    }));
  });

  it("stops each project with its own routed stop call", async () => {
    const { stopProjects } = await import("./projects");
    const results = await stopProjects({
      account_id: "acct-1",
      project_ids: [P[0], P[1], P[0]],
    });
    expect(results).toEqual([
      { project_id: P[0], ok: true },
      { project_id: P[1], ok: true },
    ]);
    expect(executeHubApiCallMock.mock.calls.map(([call]) => call)).toEqual([
      {
        name: "projects.stop",
        args: [{ project_id: P[0] }],
        account_id: "acct-1",
      },
      {
        name: "projects.stop",
        args: [{ project_id: P[1] }],
        account_id: "acct-1",
      },
    ]);
  });

  it("runs at most three at a time", async () => {
    let running = 0;
    let most = 0;
    executeHubApiCallMock = jest.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
    });
    const { stopProjects } = await import("./projects");
    await stopProjects({ account_id: "acct-1", project_ids: P });
    expect(executeHubApiCallMock).toHaveBeenCalledTimes(P.length);
    expect(most).toBe(3);
  });

  it("reports each project's failure, with its code, and carries on", async () => {
    executeHubApiCallMock = jest.fn(async ({ args }) => {
      if (args[0].project_id === P[1]) {
        throw Object.assign(
          new Error("outcome unknown: bay-1 did not answer"),
          {
            code: "OUTCOME_UNKNOWN",
          },
        );
      }
    });
    const { stopProjects } = await import("./projects");
    await expect(
      stopProjects({ account_id: "acct-1", project_ids: [P[0], P[1], P[2]] }),
    ).resolves.toEqual([
      { project_id: P[0], ok: true },
      {
        project_id: P[1],
        ok: false,
        error: "outcome unknown: bay-1 did not answer",
        code: "OUTCOME_UNKNOWN",
      },
      { project_id: P[2], ok: true },
    ]);
  });

  it("rejects bad input before doing anything", async () => {
    const { stopProjects, restartProjects } = await import("./projects");
    const { MAX_BULK_PROJECT_CONTROL } =
      await import("@cocalc/conat/hub/api/projects");
    await expect(
      stopProjects({ account_id: "acct-1", project_ids: "x" as any }),
    ).rejects.toThrow("must be an array");
    await expect(
      stopProjects({ account_id: "acct-1", project_ids: [P[0], "nope"] }),
    ).rejects.toThrow("invalid project id");
    const many = Array.from(
      { length: MAX_BULK_PROJECT_CONTROL + 1 },
      (_, i) => `00000000-0000-4000-8000-${`${i}`.padStart(12, "0")}`,
    );
    await expect(
      stopProjects({ account_id: "acct-1", project_ids: many }),
    ).rejects.toThrow(`at most ${MAX_BULK_PROJECT_CONTROL}`);
    await expect(
      restartProjects({
        account_id: "acct-1",
        project_ids: [P[0]],
        request_id: "nope",
      }),
    ).rejects.toThrow("request_id must be a UUID");
    expect(executeHubApiCallMock).not.toHaveBeenCalled();
  });

  it("queues a restart per project, with ids stable across a retry", async () => {
    const { restartProjects } = await import("./projects");
    const first = await restartProjects({
      account_id: "acct-1",
      project_ids: [P[0], P[1]],
      request_id: REQUEST,
    });
    expect(first).toEqual([
      { project_id: P[0], ok: true, op_id: `op-${P[0]}` },
      { project_id: P[1], ok: true, op_id: `op-${P[1]}` },
    ]);
    const calls = executeHubApiCallMock.mock.calls.map(([call]) => call);
    for (const call of calls) {
      expect(call).toMatchObject({
        name: "projects.restart",
        account_id: "acct-1",
        args: [{ wait: false }],
      });
    }
    const ids = calls.map((call) => call.args[0].restart_request_id);
    expect(new Set(ids).size).toBe(2);
    // A retry of the same bulk action reuses each project's restart id, so
    // the server joins the earlier restart instead of starting another.
    executeHubApiCallMock.mockClear();
    await restartProjects({
      account_id: "acct-1",
      project_ids: [P[0], P[1]],
      request_id: REQUEST,
    });
    expect(
      executeHubApiCallMock.mock.calls.map(
        ([call]) => call.args[0].restart_request_id,
      ),
    ).toEqual(ids);
  });

  it("sizes the client timeout to the number of projects", async () => {
    const { bulkProjectControlTimeout } =
      await import("@cocalc/conat/hub/api/projects");
    expect(bulkProjectControlTimeout(1)).toBe(45_000);
    expect(bulkProjectControlTimeout(5)).toBe(60_000);
    expect(bulkProjectControlTimeout(100)).toBe(30_000 + 34 * 15_000);
  });
});
