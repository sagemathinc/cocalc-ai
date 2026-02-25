export {};

let materializeProjectHostMock: jest.Mock;
let fileServerClientMock: jest.Mock;

jest.mock("./route-project", () => ({
  __esModule: true,
  materializeProjectHost: (...args: any[]) => materializeProjectHostMock(...args),
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: (...args: any[]) => fileServerClientMock(...args),
}));

describe("conat/file-server-client", () => {
  beforeEach(() => {
    jest.resetModules();
    materializeProjectHostMock = jest.fn(async () => "https://host");
    fileServerClientMock = jest.fn(() => ({ createBackup: jest.fn() }));
  });

  it("materializes route before creating project file-server client", async () => {
    const { getProjectFileServerClient } = await import("./file-server-client");
    const client = await getProjectFileServerClient({
      project_id: "11111111-1111-1111-1111-111111111111",
      timeout: 1234,
    });

    expect(materializeProjectHostMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(fileServerClientMock).toHaveBeenCalledWith({
      project_id: "11111111-1111-1111-1111-111111111111",
      timeout: 1234,
    });
    expect(client).toBeDefined();
  });

  it("throws a clear error when no route can be resolved", async () => {
    materializeProjectHostMock = jest.fn(async () => undefined);
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

  it("supports bypassing route checks when explicitly disabled", async () => {
    const { getProjectFileServerClient } = await import("./file-server-client");
    await getProjectFileServerClient({
      project_id: "33333333-3333-3333-3333-333333333333",
      ensure_route: false,
    });

    expect(materializeProjectHostMock).not.toHaveBeenCalled();
    expect(fileServerClientMock).toHaveBeenCalledWith({
      project_id: "33333333-3333-3333-3333-333333333333",
      timeout: undefined,
    });
  });
});
