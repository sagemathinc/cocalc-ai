export {};

let materializeProjectHostTargetMock: jest.Mock;
let materializeRemoteProjectHostTargetMock: jest.Mock;
let fileServerClientMock: jest.Mock;
let conatWithProjectRoutingMock: jest.Mock;
let pingMock: jest.Mock;

jest.mock("./route-project", () => ({
  __esModule: true,
  materializeProjectHostTarget: (...args: any[]) =>
    materializeProjectHostTargetMock(...args),
  materializeRemoteProjectHostTarget: (...args: any[]) =>
    materializeRemoteProjectHostTargetMock(...args),
}));

jest.mock("./route-client", () => ({
  __esModule: true,
  conatWithProjectRouting: (...args: any[]) =>
    conatWithProjectRoutingMock(...args),
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: (...args: any[]) => fileServerClientMock(...args),
}));

describe("conat/file-server-client", () => {
  beforeEach(() => {
    jest.resetModules();
    materializeProjectHostTargetMock = jest.fn(async () => ({
      address: "https://host",
      host_id: "host-1",
    }));
    materializeRemoteProjectHostTargetMock = jest.fn(async () => undefined);
    conatWithProjectRoutingMock = jest.fn(() => ({ id: "routed-client" }));
    pingMock = jest.fn(async () => undefined);
    fileServerClientMock = jest.fn(() => ({
      createBackup: jest.fn(),
      conat: { ping: pingMock },
    }));
  });

  it("materializes route before creating project file-server client", async () => {
    const { getProjectFileServerClient } = await import("./file-server-client");
    const client = await getProjectFileServerClient({
      project_id: "11111111-1111-1111-1111-111111111111",
      timeout: 1234,
    });

    expect(materializeProjectHostTargetMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      { fresh: true },
    );
    expect(fileServerClientMock).toHaveBeenCalledWith({
      client: { id: "routed-client" },
      project_id: "11111111-1111-1111-1111-111111111111",
      timeout: 1234,
      waitForInterest: true,
    });
    expect(client).toBeDefined();
  });

  it("throws a clear error when no route can be resolved", async () => {
    materializeProjectHostTargetMock = jest.fn(async () => undefined);
    const { getProjectFileServerClient } = await import("./file-server-client");

    await expect(
      getProjectFileServerClient({
        project_id: "22222222-2222-2222-2222-222222222222",
      }),
    ).rejects.toThrow(
      "unable to route project 22222222-2222-2222-2222-222222222222 to a host",
    );
    expect(fileServerClientMock).not.toHaveBeenCalled();
  });

  it("uses authenticated remote project routing when local route lookup misses", async () => {
    materializeProjectHostTargetMock = jest.fn(async () => undefined);
    materializeRemoteProjectHostTargetMock = jest.fn(async () => ({
      address: "https://remote-host",
      host_id: "host-remote",
    }));
    const { getProjectFileServerClient } = await import("./file-server-client");

    await getProjectFileServerClient({
      project_id: "22222222-2222-2222-2222-222222222222",
      account_id: "account-1",
    });

    expect(materializeRemoteProjectHostTargetMock).toHaveBeenCalledWith({
      account_id: "account-1",
      project_id: "22222222-2222-2222-2222-222222222222",
    });
    expect(fileServerClientMock).toHaveBeenCalled();
  });

  it("supports bypassing route checks when explicitly disabled", async () => {
    const { getProjectFileServerClient } = await import("./file-server-client");
    await getProjectFileServerClient({
      project_id: "33333333-3333-3333-3333-333333333333",
      ensure_route: false,
    });

    expect(materializeProjectHostTargetMock).not.toHaveBeenCalled();
    expect(fileServerClientMock).toHaveBeenCalledWith({
      client: { id: "routed-client" },
      project_id: "33333333-3333-3333-3333-333333333333",
      timeout: undefined,
      waitForInterest: true,
    });
  });

  it("pings the file-server service when explicitly asked to ensure readiness", async () => {
    const { ensureProjectFileServerClientReady, getProjectFileServerClient } =
      await import("./file-server-client");
    const client = await getProjectFileServerClient({
      project_id: "44444444-4444-4444-4444-444444444444",
    });

    await ensureProjectFileServerClientReady({
      project_id: "44444444-4444-4444-4444-444444444444",
      client,
      maxWait: 4321,
    });

    expect(pingMock).toHaveBeenCalledWith({ maxWait: 4321 });
  });

  it("wraps readiness ping failures in a clearer project-scoped error", async () => {
    pingMock = jest.fn(async () => {
      throw new Error("timed out waiting for file-server pong");
    });
    fileServerClientMock = jest.fn(() => ({
      createBackup: jest.fn(),
      conat: { ping: pingMock },
    }));
    const { ensureProjectFileServerClientReady, getProjectFileServerClient } =
      await import("./file-server-client");
    const project_id = "55555555-5555-5555-5555-555555555555";
    const client = await getProjectFileServerClient({ project_id });

    await expect(
      ensureProjectFileServerClientReady({ project_id, client }),
    ).rejects.toThrow(
      `project file-server service for ${project_id} is not responding`,
    );
  });
});
