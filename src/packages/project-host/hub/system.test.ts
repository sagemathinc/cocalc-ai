const callHubMock = jest.fn();
const getMasterConatClientMock = jest.fn(() => ({ id: "master-client" }));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => callHubMock(...args),
}));

jest.mock("../master-status", () => ({
  getMasterConatClient: () => getMasterConatClientMock(),
}));

describe("wireSystemApi", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.PROJECT_HOST_ID = "00000000-1000-4000-8000-000000000123";
  });

  it("handles ping locally on the project-host", async () => {
    const { hubApi } = await import("@cocalc/lite/hub/api");
    const { wireSystemApi } = await import("./system");
    const before = Date.now();

    wireSystemApi();

    expect(hubApi.system.ping()).toEqual({
      now: expect.any(Number),
    });
    expect(hubApi.system.ping().now).toBeGreaterThanOrEqual(before);
    expect(callHubMock).not.toHaveBeenCalled();
    expect(getMasterConatClientMock).not.toHaveBeenCalled();
  });

  it("keeps non-local system methods forwarded through the master host scope", async () => {
    callHubMock.mockResolvedValue({
      effective_limit: 3,
    });
    const { hubApi } = await import("@cocalc/lite/hub/api");
    const { wireSystemApi } = await import("./system");

    wireSystemApi();

    await expect(
      hubApi.system.getProjectHostParallelOpsLimit({
        worker_kind: "project-host-backup-execution",
      }),
    ).resolves.toEqual({
      effective_limit: 3,
    });
    expect(callHubMock).toHaveBeenCalledWith({
      client: { id: "master-client" },
      name: "system.getProjectHostParallelOpsLimit",
      args: [
        {
          worker_kind: "project-host-backup-execution",
        },
      ],
      host_id: "00000000-1000-4000-8000-000000000123",
    });
  });
});
