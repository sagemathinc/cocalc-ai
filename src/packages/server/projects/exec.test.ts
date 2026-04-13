export {};

let assertProjectCollaboratorAccessAllowRemoteMock: jest.Mock;
let projectApiClientMock: jest.Mock;
let resolveHostConnectionMock: jest.Mock;
let issueProjectHostAuthTokenMock: jest.Mock;
let connectConatMock: jest.Mock;
let systemExecMock: jest.Mock;
let waitUntilSignedInMock: jest.Mock;
let closeMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  __esModule: true,
  assertProjectCollaboratorAccessAllowRemote: (...args: any[]) =>
    assertProjectCollaboratorAccessAllowRemoteMock(...args),
}));

jest.mock("@cocalc/backend/data", () => ({
  __esModule: true,
  conatServer: "http://localhost:9100",
}));

jest.mock("@cocalc/server/conat/api/hosts", () => ({
  __esModule: true,
  resolveHostConnection: (...args: any[]) => resolveHostConnectionMock(...args),
  issueProjectHostAuthToken: (...args: any[]) =>
    issueProjectHostAuthTokenMock(...args),
}));

jest.mock("@cocalc/conat/core/client", () => ({
  __esModule: true,
  connect: (...args: any[]) => connectConatMock(...args),
}));

jest.mock("@cocalc/conat/project/api", () => ({
  __esModule: true,
  projectApiClient: (...args: any[]) => projectApiClientMock(...args),
}));

describe("project exec local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      title: "Project",
      host_id: "33333333-3333-4333-8333-333333333333",
      owning_bay_id: "bay-2",
    }));
    resolveHostConnectionMock = jest.fn(async () => ({
      connect_url: "https://host.example",
      local_proxy: false,
    }));
    issueProjectHostAuthTokenMock = jest.fn(async () => ({
      token: "issued-token",
      expires_at: 123456,
    }));
    waitUntilSignedInMock = jest.fn(async () => undefined);
    closeMock = jest.fn();
    connectConatMock = jest.fn(() => ({
      kind: "conat-client",
      waitUntilSignedIn: waitUntilSignedInMock,
      close: closeMock,
    }));
    systemExecMock = jest.fn(async () => ({
      stdout: "ok",
      stderr: "",
      exit_code: 0,
    }));
    projectApiClientMock = jest.fn(() => ({
      system: {
        exec: systemExecMock,
      },
    }));
  });

  it("executes using the routed host api for collaborators on any bay", async () => {
    const { default: execProject } = await import("./exec");
    await expect(
      execProject({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        execOpts: { command: "pwd", timeout: 5 },
      }),
    ).resolves.toEqual({ stdout: "ok", stderr: "", exit_code: 0 });
    expect(assertProjectCollaboratorAccessAllowRemoteMock).toHaveBeenCalledWith(
      {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      },
    );
    expect(resolveHostConnectionMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      host_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(issueProjectHostAuthTokenMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      host_id: "33333333-3333-4333-8333-333333333333",
      project_id: PROJECT_ID,
    });
    expect(connectConatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "https://host.example",
        noCache: true,
        forceNew: true,
        reconnection: false,
      }),
    );
    expect(projectApiClientMock).toHaveBeenCalledWith({
      client: expect.objectContaining({ kind: "conat-client" }),
      project_id: PROJECT_ID,
      timeout: 7000,
    });
    expect(systemExecMock).toHaveBeenCalledWith({ command: "pwd", timeout: 5 });
    expect(closeMock).toHaveBeenCalled();
  });

  it("fails clearly when the project has no assigned host", async () => {
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      title: "Project",
      host_id: null,
      owning_bay_id: "bay-2",
    }));
    const { default: execProject } = await import("./exec");
    await expect(
      execProject({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        execOpts: { command: "pwd", timeout: 5 },
      }),
    ).rejects.toThrow(`project ${PROJECT_ID} has no assigned host`);
  });
});
