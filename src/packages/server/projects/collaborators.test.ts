export {};

let assertLocalProjectCollaboratorMock: jest.Mock;
let queryMock: jest.Mock;
let callback2Mock: jest.Mock;
let isAdminMock: jest.Mock;
let dbMock: jest.Mock;
let listProjectedMyCollaboratorsForAccountMock: jest.Mock;
let getClusterAccountByIdMock: jest.Mock;
let getClusterAccountsByIdsMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/database/postgres/account-collaborator-index", () => ({
  __esModule: true,
  listProjectedMyCollaboratorsForAccount: (...args: any[]) =>
    listProjectedMyCollaboratorsForAccountMock(...args),
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

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  getClusterAccountById: (...args: any[]) => getClusterAccountByIdMock(...args),
  getClusterAccountsByIds: (...args: any[]) =>
    getClusterAccountsByIdsMock(...args),
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
  const EMAIL_ACTION_ID = "44444444-4444-4444-8444-444444444444";
  const removeCollaboratorFromProject = jest.fn(async () => undefined);
  const accountCreationActions = jest.fn(async () => undefined);
  const whenSentProjectInvite = jest.fn(async () => 0);
  const getServerSettingsCached = jest.fn(async () => ({
    organization_email: "help@example.com",
  }));

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async () => ({ rows: [] }));
    callback2Mock = jest.fn(async (fn, opts) => await fn(opts));
    isAdminMock = jest.fn(async () => false);
    listProjectedMyCollaboratorsForAccountMock = jest.fn(async () => []);
    getClusterAccountByIdMock = jest.fn(async (account_id: string) => ({
      account_id,
      home_bay_id: "bay-0",
    }));
    getClusterAccountsByIdsMock = jest.fn(async (account_ids: string[]) =>
      account_ids.map((account_id) => ({
        account_id,
        home_bay_id: "bay-0",
      })),
    );
    removeCollaboratorFromProject.mockClear();
    accountCreationActions.mockClear();
    whenSentProjectInvite.mockClear();
    getServerSettingsCached.mockClear();
    dbMock = jest.fn(() => ({
      remove_collaborator_from_project: removeCollaboratorFromProject,
      account_creation_actions: accountCreationActions,
      when_sent_project_invite: whenSentProjectInvite,
      sent_project_invite: jest.fn(async () => undefined),
      get_server_settings_cached: getServerSettingsCached,
      account_exists: jest.fn(async ({ email_address }) =>
        email_address === "user@example.com" ? TARGET_ACCOUNT_ID : null,
      ),
    }));
    delete process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS;
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
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        group: "owner",
        name: "Owner",
      }),
      expect.objectContaining({
        account_id: TARGET_ACCOUNT_ID,
        group: "collaborator",
        name: "Collab",
      }),
    ]);
    expect(assertLocalProjectCollaboratorMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("uses projected my-collaborator rows when enabled", async () => {
    process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS = "prefer";
    listProjectedMyCollaboratorsForAccountMock = jest.fn(async () => [
      {
        account_id: TARGET_ACCOUNT_ID,
        name: "Collab",
        first_name: "Col",
        last_name: "Lab",
        email_address: null,
        last_active: null,
        shared_projects: 3,
      },
    ]);
    const { listMyCollaborators } = await import("./collaborators");
    await expect(
      listMyCollaborators({
        account_id: ACCOUNT_ID,
        limit: 20,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: TARGET_ACCOUNT_ID,
        shared_projects: 3,
        name: "Collab",
      }),
    ]);
    expect(listProjectedMyCollaboratorsForAccountMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      limit: 20,
      include_email: false,
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("falls back to legacy my-collaborator reads in prefer mode when projection is empty", async () => {
    process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS = "prefer";
    queryMock = jest.fn(async () => ({
      rows: [
        {
          account_id: TARGET_ACCOUNT_ID,
          name: "Legacy Collab",
          shared_projects: 2,
        },
      ],
    }));
    const { listMyCollaborators } = await import("./collaborators");
    await expect(
      listMyCollaborators({
        account_id: ACCOUNT_ID,
        limit: 20,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: TARGET_ACCOUNT_ID,
        shared_projects: 2,
        name: "Legacy Collab",
      }),
    ]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("uses projection-only collaborator reads in only mode", async () => {
    process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS = "only";
    listProjectedMyCollaboratorsForAccountMock = jest.fn(async () => []);
    const { listMyCollaborators } = await import("./collaborators");
    await expect(
      listMyCollaborators({
        account_id: ACCOUNT_ID,
        limit: 20,
      }),
    ).resolves.toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("lists pending email-only outbound invites", async () => {
    queryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            invite_id: `email-action:${EMAIL_ACTION_ID}`,
            project_id: PROJECT_ID,
            project_title: "Test Project",
            inviter_account_id: ACCOUNT_ID,
            invitee_account_id: null,
            invitee_email_address: "nobody@example.com",
            invite_source: "email",
            status: "pending",
            created: new Date("2026-04-01T00:00:00Z"),
            updated: new Date("2026-04-01T00:00:00Z"),
            responded: null,
            expires: new Date("2026-04-15T00:00:00Z"),
          },
        ],
      });
    const { listCollabInvites } = await import("./collaborators");
    await expect(
      listCollabInvites({
        account_id: ACCOUNT_ID,
        direction: "outbound",
        status: "pending",
        limit: 20,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        invite_id: `email-action:${EMAIL_ACTION_ID}`,
        invite_source: "email",
        invitee_email_address: "nobody@example.com",
        status: "pending",
      }),
    ]);
  });

  it("revokes pending email-only invites", async () => {
    queryMock = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            invite_id: `email-action:${EMAIL_ACTION_ID}`,
            project_id: PROJECT_ID,
            project_title: "Test Project",
            inviter_account_id: ACCOUNT_ID,
            invitee_account_id: null,
            invitee_email_address: "nobody@example.com",
            invite_source: "email",
            status: "pending",
            created: new Date("2026-04-01T00:00:00Z"),
            updated: new Date("2026-04-01T00:00:00Z"),
            responded: null,
            expires: new Date("2026-04-15T00:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { respondCollabInvite } = await import("./collaborators");
    await expect(
      respondCollabInvite({
        account_id: ACCOUNT_ID,
        invite_id: `email-action:${EMAIL_ACTION_ID}`,
        action: "revoke",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        invite_id: `email-action:${EMAIL_ACTION_ID}`,
        status: "canceled",
        responder_action: "revoke",
      }),
    );
    expect(queryMock.mock.calls[1]?.[0]).toContain(
      "DELETE FROM account_creation_actions",
    );
  });

  it("stores inviter metadata for email-only invites", async () => {
    const { inviteCollaboratorWithoutAccount } =
      await import("./collaborators");
    await inviteCollaboratorWithoutAccount({
      account_id: ACCOUNT_ID,
      opts: {
        project_id: PROJECT_ID,
        title: "Test Project",
        link2proj: "https://example.com/project",
        to: "nobody@example.com",
        email: "<p>Hello</p>",
        message: "Please join",
      },
    });
    expect(accountCreationActions).toHaveBeenCalledWith(
      expect.objectContaining({
        email_address: "nobody@example.com",
        action: expect.objectContaining({
          action: "add_to_project",
          group: "collaborator",
          project_id: PROJECT_ID,
          inviter_account_id: ACCOUNT_ID,
          message: "Please join",
        }),
      }),
    );
  });
});
