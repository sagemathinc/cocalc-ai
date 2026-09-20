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
  it("forwards identity issuance as the host, not as an account", async () => {
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
  });
  beforeEach(() => {
    jest.resetModules();
    callHubMock.mockReset();
    getMasterConatClientMock.mockClear();
    process.env.PROJECT_HOST_ID = "00000000-1000-4000-8000-000000000123";
  });

  it("wires RPC admission authorization to the owning hub with host attribution", async () => {
    const { hubApi } = await import("@cocalc/lite/hub/api");
    const { wireHostsApi } = await import("./hosts");
    wireHostsApi();
    const opts = {
      account_id: "target-account",
      envelope: { permit_id: "permit" },
    };
    await hubApi.agent.authorizeRpcAdmission(opts as any);
    expect(callHubMock).toHaveBeenCalledTimes(1);
    expect(callHubMock).toHaveBeenCalledWith({
      client: { id: "master-client" },
      name: "agent.authorizeRpcAdmission",
      args: [opts],
      host_id: process.env.PROJECT_HOST_ID,
    });
  });

  it("wires RPC execution authorization to the owning hub with host attribution", async () => {
    const { hubApi } = await import("@cocalc/lite/hub/api");
    const { wireHostsApi } = await import("./hosts");
    wireHostsApi();
    const opts = {
      account_id: "target-account",
      authorization: {
        version: 3,
        agent_network_id: "session",
        network_generation: "generation",
      },
    };
    await hubApi.agent.authorizeRpcExecution(opts as any);
    expect(callHubMock).toHaveBeenCalledTimes(1);
    expect(callHubMock).toHaveBeenCalledWith({
      client: { id: "master-client" },
      name: "agent.authorizeRpcExecution",
      args: [opts],
      host_id: process.env.PROJECT_HOST_ID,
    });
  });

  it("wires mention validation through the authenticated source host", async () => {
    const { hubApi } = await import("@cocalc/lite/hub/api");
    const { wireHostsApi } = await import("./hosts");
    wireHostsApi();
    const opts = {
      account_id: "human",
      project_id: "source-project",
      target: { project_id: "target-project", agent_id: "reviewer" },
    };
    await hubApi.agent.getMentionIdentity(opts);
    expect(callHubMock).toHaveBeenCalledWith({
      client: { id: "master-client" },
      name: "agent.getMentionIdentity",
      args: [opts],
      host_id: process.env.PROJECT_HOST_ID,
    });
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
