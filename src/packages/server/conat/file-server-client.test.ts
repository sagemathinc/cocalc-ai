export {};

let materializeProjectHostTargetMock: jest.Mock;
let materializeRemoteProjectHostTargetMock: jest.Mock;
let fileServerClientMock: jest.Mock;
let fsClientMock: jest.Mock;
let conatWithProjectRoutingMock: jest.Mock;
let getExplicitProjectRoutedClientMock: jest.Mock;
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
  getExplicitProjectRoutedClient: (...args: any[]) =>
    getExplicitProjectRoutedClientMock(...args),
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: (...args: any[]) => fileServerClientMock(...args),
}));

jest.mock("@cocalc/conat/files/fs", () => ({
  __esModule: true,
  fsClient: (...args: any[]) => fsClientMock(...args),
  fsSubject: ({ project_id }: { project_id: string }) =>
    `fs.project-${project_id}`,
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
    getExplicitProjectRoutedClientMock = jest.fn(async () => ({
      id: "explicit-project-client",
    }));
    pingMock = jest.fn(async () => undefined);
    fileServerClientMock = jest.fn(() => ({
      createBackup: jest.fn(),
      conat: { ping: pingMock },
    }));
    fsClientMock = jest.fn(() => ({
      exists: jest.fn(),
      mkdir: jest.fn(),
      writeFile: jest.fn(),
      readFile: jest.fn(),
      rm: jest.fn(),
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
    expect(getExplicitProjectRoutedClientMock).toHaveBeenCalledWith({
      project_id: "11111111-1111-1111-1111-111111111111",
      fresh: true,
    });
    expect(fileServerClientMock).toHaveBeenCalledWith({
      client: { id: "explicit-project-client" },
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

  it("uses hub-authenticated file-server client after remote route discovery", async () => {
    materializeProjectHostTargetMock = jest.fn(async () => undefined);
    materializeRemoteProjectHostTargetMock = jest.fn(async () => ({
      address: "https://remote-host",
      host_id: "host-remote",
      host_session_id: "session-remote",
    }));
    const { getProjectFileServerClient } = await import("./file-server-client");

    await getProjectFileServerClient({
      project_id: "22222222-2222-2222-2222-222222222222",
      account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    expect(materializeRemoteProjectHostTargetMock).toHaveBeenCalledWith({
      account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      project_id: "22222222-2222-2222-2222-222222222222",
    });
    expect(getExplicitProjectRoutedClientMock).not.toHaveBeenCalled();
    expect(fileServerClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client: { id: "routed-client" },
      }),
    );
  });

  it("uses account id only for remote route discovery", async () => {
    materializeProjectHostTargetMock = jest.fn(async () => undefined);
    materializeRemoteProjectHostTargetMock = jest.fn(async () => ({
      address: "https://remote-host",
      host_id: "host-remote",
    }));
    const { getProjectFileServerClient } = await import("./file-server-client");

    await getProjectFileServerClient({
      project_id: "66666666-6666-6666-6666-666666666666",
      account_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });

    expect(materializeRemoteProjectHostTargetMock).toHaveBeenCalledWith({
      account_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      project_id: "66666666-6666-6666-6666-666666666666",
    });
    expect(getExplicitProjectRoutedClientMock).not.toHaveBeenCalled();
    expect(fileServerClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client: { id: "routed-client" },
      }),
    );
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

  it("forwards an explicit stale-route override to the local routed client", async () => {
    const { getProjectFileServerClient } = await import("./file-server-client");
    await getProjectFileServerClient({
      project_id: "77777777-7777-7777-7777-777777777777",
      fresh: false,
    });

    expect(getExplicitProjectRoutedClientMock).toHaveBeenCalledWith({
      project_id: "77777777-7777-7777-7777-777777777777",
      fresh: false,
    });
  });

  it("creates a project filesystem client with the same fresh local routing", async () => {
    const { getProjectFsClient } = await import("./file-server-client");
    await getProjectFsClient({
      project_id: "88888888-8888-8888-8888-888888888888",
    });

    expect(getExplicitProjectRoutedClientMock).toHaveBeenCalledWith({
      project_id: "88888888-8888-8888-8888-888888888888",
      fresh: true,
    });
    expect(fsClientMock).toHaveBeenCalledWith({
      client: { id: "explicit-project-client" },
      subject: "fs.project-88888888-8888-8888-8888-888888888888",
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
