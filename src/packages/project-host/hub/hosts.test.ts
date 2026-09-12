const callHubMock = jest.fn();
const getMasterConatClientMock = jest.fn(() => ({ id: "master-client" }));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => callHubMock(...args),
}));

jest.mock("../master-status", () => ({
  getMasterConatClient: () => getMasterConatClientMock(),
}));

describe("wireHostsApi", () => {
  it("forwards identity issuance and queued-delivery authorization as the host, not as an account", async () => {
    const { hubApi } = await import("@cocalc/lite/hub/api");
    const { wireHostsApi } = await import("./hosts");
    wireHostsApi();
    const opts = {
      account_id: "account",
      project_id: "project",
      path: "a.chat",
      thread_id: "thread",
      run_id: "run",
    };
    await hubApi.agent.issueIdentity(opts);
    expect(callHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agent.issueIdentity",
        args: [opts],
        host_id: process.env.PROJECT_HOST_ID,
      }),
    );
    await hubApi.agent.authorizeDelivery({ ...opts, message_id: "message" });
    expect(callHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agent.authorizeDelivery",
        host_id: process.env.PROJECT_HOST_ID,
      }),
    );
  });
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.PROJECT_HOST_ID = "00000000-1000-4000-8000-000000000123";
  });

  it("forwards issueProjectHostAgentAuthToken through the master host scope", async () => {
    callHubMock.mockResolvedValue({
      host_id: "00000000-1000-4000-8000-000000000123",
      token: "issued-token",
      expires_at: 1234,
    });
    const { hubApi } = await import("@cocalc/lite/hub/api");
    (hubApi as any).hosts = {};
    const { wireHostsApi } = await import("./hosts");
    wireHostsApi();

    await expect(
      hubApi.hosts.issueProjectHostAgentAuthToken({
        account_id: "00000000-1000-4000-8000-000000000001",
        project_id: "00000000-1000-4000-8000-000000000002",
      }),
    ).resolves.toMatchObject({
      token: "issued-token",
    });

    expect(callHubMock).toHaveBeenCalledWith({
      client: { id: "master-client" },
      name: "hosts.issueProjectHostAgentAuthToken",
      args: [
        {
          account_id: "00000000-1000-4000-8000-000000000001",
          project_id: "00000000-1000-4000-8000-000000000002",
        },
      ],
      host_id: "00000000-1000-4000-8000-000000000123",
    });
  });
});
