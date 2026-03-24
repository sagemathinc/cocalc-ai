/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

let conatWithProjectRoutingMock: jest.Mock;
let materializeProjectHostMock: jest.Mock;
let projectApiClientMock: jest.Mock;
let execMock: jest.Mock;
let isCollaboratorMock: jest.Mock;

jest.mock("@cocalc/server/conat/route-client", () => ({
  conatWithProjectRouting: (...args: any[]) =>
    conatWithProjectRoutingMock(...args),
}));

jest.mock("@cocalc/server/conat/route-project", () => ({
  materializeProjectHost: (...args: any[]) =>
    materializeProjectHostMock(...args),
}));

jest.mock("@cocalc/conat/project/api", () => ({
  projectApiClient: (...args: any[]) => projectApiClientMock(...args),
}));

jest.mock("@cocalc/server/projects/is-collaborator", () => ({
  __esModule: true,
  default: (...args: any[]) => isCollaboratorMock(...args),
}));

describe("projects.exec routing", () => {
  beforeEach(() => {
    execMock = jest.fn(async () => ({
      stdout: "ok",
      stderr: "",
      exit_code: 0,
    }));
    conatWithProjectRoutingMock = jest.fn(() => ({ id: "routed-client" }));
    materializeProjectHostMock = jest.fn(async () => "https://host.example");
    projectApiClientMock = jest.fn(() => ({
      system: {
        exec: execMock,
      },
    }));
    isCollaboratorMock = jest.fn(async () => true);
  });

  it("uses the routed conat client for project exec", async () => {
    const execProject = (await import("./exec")).default;
    const result = await execProject({
      account_id: "account-1",
      project_id: "project-1",
      execOpts: { command: "echo", args: ["hi"], timeout: 123 },
    });

    expect(result).toEqual({ stdout: "ok", stderr: "", exit_code: 0 });
    expect(isCollaboratorMock).toHaveBeenCalledWith({
      account_id: "account-1",
      project_id: "project-1",
    });
    expect(materializeProjectHostMock).toHaveBeenCalledWith("project-1");
    expect(conatWithProjectRoutingMock).toHaveBeenCalled();
    expect(projectApiClientMock).toHaveBeenCalledWith({
      client: { id: "routed-client" },
      project_id: "project-1",
      timeout: 125000,
    });
    expect(execMock).toHaveBeenCalledWith({
      command: "echo",
      args: ["hi"],
      timeout: 123,
    });
  });
});
