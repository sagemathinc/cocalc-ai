export {};

let assertLocalProjectCollaboratorMock: jest.Mock;
let queryMock: jest.Mock;
let callback2Mock: jest.Mock;
let isAdminMock: jest.Mock;
let dbMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/util/async-utils", () => ({
  __esModule: true,
  callback2: (...args: any[]) => callback2Mock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: (...args: any[]) => dbMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("./collab", () => ({
  __esModule: true,
  add_collaborators_to_projects: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/hub/email", () => ({
  __esModule: true,
  send_invite_email: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/accounts/get-email-address", () => ({
  __esModule: true,
  default: jest.fn(async () => null),
}));

jest.mock("@cocalc/database/postgres/account/queries", () => ({
  __esModule: true,
  is_paying_customer: jest.fn(async () => false),
}));

jest.mock("@cocalc/database/postgres/project/queries", () => ({
  __esModule: true,
  project_has_network_access: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  syncProjectUsersOnHost: jest.fn(async () => undefined),
}));

describe("project collaborators local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
  const TARGET_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
  const removeCollaboratorFromProject = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async () => ({ rows: [] }));
    callback2Mock = jest.fn(async (fn, opts) => await fn(opts));
    isAdminMock = jest.fn(async () => false);
    removeCollaboratorFromProject.mockClear();
    dbMock = jest.fn(() => ({
      remove_collaborator_from_project: removeCollaboratorFromProject,
    }));
  });

  it("rejects removing collaborators for wrong-bay projects", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { removeCollaborator } = await import("./collaborators");
    await expect(
      removeCollaborator({
        account_id: ACCOUNT_ID,
        opts: {
          account_id: TARGET_ACCOUNT_ID,
          project_id: PROJECT_ID,
        },
      }),
    ).rejects.toThrow("project belongs to another bay");
    expect(callback2Mock).not.toHaveBeenCalled();
  });

  it("loads collaborators only for local projects", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        { account_id: ACCOUNT_ID, group: "owner", name: "Owner" },
        {
          account_id: TARGET_ACCOUNT_ID,
          group: "collaborator",
          name: "Collab",
        },
        {
          account_id: "44444444-4444-4444-8444-444444444444",
          group: "viewer",
          name: "Viewer",
        },
      ],
    }));
    const { listCollaborators } = await import("./collaborators");
    await expect(
      listCollaborators({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual([
      { account_id: ACCOUNT_ID, group: "owner", name: "Owner" },
      { account_id: TARGET_ACCOUNT_ID, group: "collaborator", name: "Collab" },
    ]);
    expect(assertLocalProjectCollaboratorMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
