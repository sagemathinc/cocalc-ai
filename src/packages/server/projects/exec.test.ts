export {};

let assertLocalProjectCollaboratorMock: jest.Mock;
let materializeProjectHostMock: jest.Mock;
let projectApiClientMock: jest.Mock;
let conatWithProjectRoutingMock: jest.Mock;
let systemExecMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/server/conat/route-project", () => ({
  __esModule: true,
  materializeProjectHost: (...args: any[]) =>
    materializeProjectHostMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  conatWithProjectRouting: (...args: any[]) =>
    conatWithProjectRoutingMock(...args),
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
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    materializeProjectHostMock = jest.fn(async () => undefined);
    conatWithProjectRoutingMock = jest.fn(() => ({ kind: "conat-client" }));
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

  it("rejects exec when the project belongs to another bay", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { default: execProject } = await import("./exec");
    await expect(
      execProject({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        execOpts: { command: "pwd" },
      }),
    ).rejects.toThrow("project belongs to another bay");
    expect(materializeProjectHostMock).not.toHaveBeenCalled();
    expect(projectApiClientMock).not.toHaveBeenCalled();
  });

  it("executes using the routed project api for local collaborators", async () => {
    const { default: execProject } = await import("./exec");
    await expect(
      execProject({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        execOpts: { command: "pwd", timeout: 5 },
      }),
    ).resolves.toEqual({ stdout: "ok", stderr: "", exit_code: 0 });
    expect(assertLocalProjectCollaboratorMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(materializeProjectHostMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(conatWithProjectRoutingMock).toHaveBeenCalledTimes(1);
    expect(projectApiClientMock).toHaveBeenCalledWith({
      client: { kind: "conat-client" },
      project_id: PROJECT_ID,
      timeout: 7000,
    });
    expect(systemExecMock).toHaveBeenCalledWith({ command: "pwd", timeout: 5 });
  });
});
