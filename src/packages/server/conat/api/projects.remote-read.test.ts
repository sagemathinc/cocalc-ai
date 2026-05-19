export {};

let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let isAdminMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let projectDetailsGetMock: jest.Mock;
let projectReferenceGetMock: jest.Mock;
let inviteWithoutAccountMock: jest.Mock;
let copyEmailLinkMock: jest.Mock;
let redeemEmailMock: jest.Mock;
let loadProjectReadDetailsDirectMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  PROJECT_COLLABORATOR_REQUIRED_ERROR: "user must be a collaborator on project",
  PROJECT_NOT_FOUND_ERROR: "project not found",
  getLocalProjectCollaboratorAccessStatus: (...args: any[]) =>
    getLocalProjectCollaboratorAccessStatusMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectDetails: jest.fn(() => ({
      get: (...args: any[]) => projectDetailsGetMock(...args),
    })),
    projectReference: jest.fn(() => ({
      get: (...args: any[]) => projectReferenceGetMock(...args),
    })),
    projectCollabInvite: jest.fn(() => ({
      inviteWithoutAccount: (...args: any[]) =>
        inviteWithoutAccountMock(...args),
      copyEmailLink: (...args: any[]) => copyEmailLinkMock(...args),
      redeemEmail: (...args: any[]) => redeemEmailMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/projects/details", () => ({
  __esModule: true,
  loadProjectReadDetailsDirect: (...args: any[]) =>
    loadProjectReadDetailsDirectMock(...args),
}));

describe("remote project detail reads", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "missing-project",
    );
    isAdminMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 2,
    }));
    projectDetailsGetMock = jest.fn(async () => ({
      region: "wnam",
      created: new Date("2026-04-08T20:00:00Z"),
      env: { FOO: "bar" },
      rootfs: { image: "buildpack-deps:noble-scm" },
      snapshots: { daily: 7 },
      backups: { daily: 1 },
      run_quota: { disk_quota: 1234 },
      settings: { mintime: 3600 },
      course: null,
    }));
    projectReferenceGetMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      title: "Remote Project",
      host_id: null,
      owning_bay_id: "bay-7",
      users: {
        [ACCOUNT_ID]: { group: "collaborator" },
      },
    }));
    inviteWithoutAccountMock = jest.fn(async () => ({
      email_sent: false,
      invites: [
        {
          invite_id: "77777777-7777-4777-8777-777777777777",
          project_id: PROJECT_ID,
          inviter_account_id: ACCOUNT_ID,
          invitee_account_id: null,
          invite_source: "email",
          status: "pending",
          created: "2026-05-18T00:00:00.000Z",
          updated: "2026-05-18T00:00:00.000Z",
        },
      ],
    }));
    copyEmailLinkMock = jest.fn(async () => ({
      invite_id: "77777777-7777-4777-8777-777777777777",
      invite_url:
        "https://example.com/invites/project/22222222-2222-4222-8222-222222222222/77777777-7777-4777-8777-777777777777?token=t",
      expires: "2026-06-01T00:00:00.000Z",
    }));
    redeemEmailMock = jest.fn(async () => ({
      invite_id: "77777777-7777-4777-8777-777777777777",
      project_id: PROJECT_ID,
      inviter_account_id: "33333333-3333-4333-8333-333333333333",
      invitee_account_id: null,
      accepted_account_id: ACCOUNT_ID,
      invite_source: "email",
      status: "accepted",
      created: "2026-05-18T00:00:00.000Z",
      updated: "2026-05-18T00:00:00.000Z",
      responded: "2026-05-18T01:00:00.000Z",
    }));
    loadProjectReadDetailsDirectMock = jest.fn();
  });

  it("routes getProjectCreated through the owning bay", async () => {
    const { getProjectCreated } = await import("./projects");
    await expect(
      getProjectCreated({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual(new Date("2026-04-08T20:00:00Z"));
    expect(resolveProjectBayMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(projectDetailsGetMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(loadProjectReadDetailsDirectMock).not.toHaveBeenCalled();
  });

  it("routes email-token invite creation through the owning bay", async () => {
    const { inviteCollaboratorWithoutAccount } = await import("./projects");
    const opts = {
      project_id: PROJECT_ID,
      title: "Remote Project",
      link2proj: "",
      to: "student@example.com",
      email: "",
      send_email: false,
    };
    const result = await inviteCollaboratorWithoutAccount({
      account_id: ACCOUNT_ID,
      opts,
    });

    expect(inviteWithoutAccountMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      opts,
    });
    expect(result.email_sent).toBe(false);
    expect(result.invites[0].created).toEqual(
      new Date("2026-05-18T00:00:00.000Z"),
    );
  });

  it("routes email invite copy-link through the owning bay", async () => {
    const { copyEmailProjectInviteLink } = await import("./projects");
    const result = await copyEmailProjectInviteLink({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
    });

    expect(copyEmailLinkMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
    });
    expect(result.expires).toEqual(new Date("2026-06-01T00:00:00.000Z"));
  });

  it("routes email invite redemption through the owning bay", async () => {
    const { redeemEmailProjectInvite } = await import("./projects");
    const result = await redeemEmailProjectInvite({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
      token: "token-1",
    });

    expect(redeemEmailMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
      token: "token-1",
    });
    expect(result.responded).toEqual(new Date("2026-05-18T01:00:00.000Z"));
  });
});
