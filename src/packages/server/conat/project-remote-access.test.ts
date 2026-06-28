/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let projectReferenceGetMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let getLocalProjectAccessStatusMock: jest.Mock;
let materializeProjectHostMock: jest.Mock;
let getTemporaryViewerReadPolicyMock: jest.Mock;

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

jest.mock("@cocalc/server/conat/api/public-directory-shares", () => ({
  getTemporaryViewerReadPolicy: (...args: any[]) =>
    getTemporaryViewerReadPolicyMock(...args),
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
    getTemporaryViewerReadPolicyMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
    }));
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

  it("resolves temporary public-share grants as viewer access", async () => {
    resolveProjectBayMock = jest.fn(async () => null);
    getLocalProjectAccessStatusMock = jest.fn(async () => "missing-project");
    getTemporaryViewerReadPolicyMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      read_policy: {
        rules: [{ action: "include", path: "public/**" }],
      },
    }));
    const { resolveProjectAccessAllowRemote } =
      await import("./project-remote-access");
    const access = await resolveProjectAccessAllowRemote({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(access.role).toBe("viewer");
    expect(access.read_policy).toEqual({
      rules: [{ action: "include", path: "public/**" }],
    });
    expect(access.capabilities.readProjectFiles).toBe(true);
    expect(access.capabilities.writeProjectFiles).toBe(false);
  });

  it("does not downgrade collaborators when a temporary grant exists", async () => {
    getLocalProjectAccessStatusMock = jest.fn(async () => "local-project-user");
    projectReferenceGetMock = jest.fn();
    const pool = (await import("@cocalc/database/pool")).default as jest.Mock;
    pool.mockReturnValue({
      query: jest.fn(async () => ({
        rows: [
          {
            project_id: PROJECT_ID,
            title: "Project",
            host_id: null,
            owning_bay_id: "bay-local",
            users: {
              [ACCOUNT_ID]: { group: "collaborator" },
            },
          },
        ],
      })),
    });
    getTemporaryViewerReadPolicyMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      read_policy: {
        rules: [{ action: "include", path: "public/**" }],
      },
    }));
    const { resolveProjectAccessAllowRemote } =
      await import("./project-remote-access");
    const access = await resolveProjectAccessAllowRemote({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(access.role).toBe("collaborator");
    expect(access.capabilities.writeProjectFiles).toBe(true);
    expect(getTemporaryViewerReadPolicyMock).not.toHaveBeenCalled();
  });
});
