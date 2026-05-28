/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let projectReferenceGetMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let getLocalProjectAccessStatusMock: jest.Mock;
let materializeProjectHostMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: jest.fn(async () => ({ rows: [] })),
  })),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-local"),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: jest.fn(() => ({
    projectReference: jest.fn(() => ({
      get: (...args: any[]) => projectReferenceGetMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/conat/route-project", () => ({
  materializeProjectHost: (...args: any[]) =>
    materializeProjectHostMock(...args),
}));

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  getLocalProjectCollaboratorAccessStatus: (...args: any[]) =>
    getLocalProjectCollaboratorAccessStatusMock(...args),
  getLocalProjectAccessStatus: (...args: any[]) =>
    getLocalProjectAccessStatusMock(...args),
  PROJECT_COLLABORATOR_REQUIRED_ERROR: "user must be a collaborator on project",
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("project remote access", () => {
  beforeEach(() => {
    jest.resetModules();
    projectReferenceGetMock = jest.fn();
    resolveProjectBayMock = jest.fn(async () => ({ bay_id: "bay-remote" }));
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "not-collaborator",
    );
    getLocalProjectAccessStatusMock = jest.fn(async () => "wrong-bay");
    materializeProjectHostMock = jest.fn(async () => undefined);
  });

  it("does not treat a remote viewer as a collaborator or warm runtime routing", async () => {
    projectReferenceGetMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      title: "Project",
      host_id: "33333333-3333-4333-8333-333333333333",
      owning_bay_id: "bay-remote",
      users: {
        [ACCOUNT_ID]: {
          group: "viewer",
          read_policy: {
            rules: [{ action: "include", path: "public/**" }],
          },
        },
      },
    }));
    const {
      hasProjectCollaboratorAccessAllowRemote,
      resolveProjectAccessAllowRemote,
    } = await import("./project-remote-access");
    await expect(
      hasProjectCollaboratorAccessAllowRemote({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBe(false);
    expect(materializeProjectHostMock).not.toHaveBeenCalled();

    const access = await resolveProjectAccessAllowRemote({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(access.role).toBe("viewer");
    expect(access.capabilities.readProjectFiles).toBe(true);
    expect(access.capabilities.useProjectRuntime).toBe(false);
  });
});
