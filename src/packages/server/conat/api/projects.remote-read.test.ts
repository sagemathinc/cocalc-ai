export {};

let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let isAdminMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let resolveProjectCollabInviteDirectoryMock: jest.Mock;
let projectDetailsGetMock: jest.Mock;
let projectReferenceGetMock: jest.Mock;
let inviteWithoutAccountMock: jest.Mock;
let copyEmailLinkMock: jest.Mock;
let redeemEmailMock: jest.Mock;
let previewEmailMock: jest.Mock;
let respondEmailMock: jest.Mock;
let getProjectAccessLandingInfoMock: jest.Mock;
let requestProjectAccessMock: jest.Mock;
let listProjectAccessRequestsMock: jest.Mock;
let respondProjectAccessRequestMock: jest.Mock;
let listProjectAccessRequestBlocksMock: jest.Mock;
let unblockProjectAccessRequesterMock: jest.Mock;
let loadProjectReadDetailsDirectMock: jest.Mock;
let assertClusterAccountTrustedForProductAccessMock: jest.Mock;
let applyAccountProjectFeedRemoveOnHomeBayMock: jest.Mock;

jest.setTimeout(15_000);

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

jest.mock("@cocalc/server/projects/collab-invite-directory", () => ({
  __esModule: true,
  resolveProjectCollabInviteDirectory: (...args: any[]) =>
    resolveProjectCollabInviteDirectoryMock(...args),
}));

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  __esModule: true,
  getSecretSettingsKey: jest.fn(async () => Buffer.alloc(32, 1)),
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
      previewEmail: (...args: any[]) => previewEmailMock(...args),
      respondEmail: (...args: any[]) => respondEmailMock(...args),
      getProjectAccessLandingInfo: (...args: any[]) =>
        getProjectAccessLandingInfoMock(...args),
      requestProjectAccess: (...args: any[]) =>
        requestProjectAccessMock(...args),
      listProjectAccessRequests: (...args: any[]) =>
        listProjectAccessRequestsMock(...args),
      respondProjectAccessRequest: (...args: any[]) =>
        respondProjectAccessRequestMock(...args),
      listProjectAccessRequestBlocks: (...args: any[]) =>
        listProjectAccessRequestBlocksMock(...args),
      unblockProjectAccessRequester: (...args: any[]) =>
        unblockProjectAccessRequesterMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  assertClusterAccountTrustedForProductAccess: (...args: any[]) =>
    assertClusterAccountTrustedForProductAccessMock(...args),
}));

jest.mock("@cocalc/server/projects/details", () => ({
  __esModule: true,
  loadProjectReadDetailsDirect: (...args: any[]) =>
    loadProjectReadDetailsDirectMock(...args),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  applyAccountProjectFeedRemoveOnHomeBay: (...args: any[]) =>
    applyAccountProjectFeedRemoveOnHomeBayMock(...args),
  publishProjectAccountFeedEventsBestEffort: jest.fn(async () => undefined),
}));

describe("remote project detail reads", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "missing-project",
    );
    isAdminMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 2,
    }));
    resolveProjectCollabInviteDirectoryMock = jest.fn(async () => ({
      invite_id: "77777777-7777-4777-8777-777777777777",
      project_id: PROJECT_ID,
      owning_bay_id: "bay-7",
      token_hash: "hash",
    }));
    projectDetailsGetMock = jest.fn(async () => ({
      region: "wnam",
      created: new Date("2026-04-08T20:00:00Z"),
      env: { FOO: "bar" },
      rootfs: { image: "buildpack-deps:noble-scm" },
      rootfs_publish_config: null,
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
      email_available: true,
      manual_delivery_required: true,
      email_blocked_reason: "send_disabled_by_request",
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
      invite_url: "https://example.com/invites/t",
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
    previewEmailMock = jest.fn(async () => ({
      invite_id: "77777777-7777-4777-8777-777777777777",
      project_id: PROJECT_ID,
      project_title: "Remote Project",
      inviter_account_id: "33333333-3333-4333-8333-333333333333",
      invitee_account_id: null,
      invite_source: "email",
      status: "pending",
      message: "Please join",
      created: "2026-05-18T00:00:00.000Z",
      updated: "2026-05-18T00:00:00.000Z",
    }));
    respondEmailMock = jest.fn(async () => ({
      invite_id: "77777777-7777-4777-8777-777777777777",
      project_id: PROJECT_ID,
      inviter_account_id: "33333333-3333-4333-8333-333333333333",
      invitee_account_id: null,
      invite_source: "email",
      status: "declined",
      responder_action: "decline",
      created: "2026-05-18T00:00:00.000Z",
      updated: "2026-05-18T00:00:00.000Z",
      responded: "2026-05-18T01:00:00.000Z",
    }));
    getProjectAccessLandingInfoMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      title: "Remote Project",
      relationship: "none",
      pending_invite: null,
      pending_request: null,
      blocked: false,
    }));
    requestProjectAccessMock = jest.fn(async () => ({
      request_id: "88888888-8888-4888-8888-888888888888",
      project_id: PROJECT_ID,
      requester_account_id: ACCOUNT_ID,
      requested_role: "viewer",
      read_policy: null,
      message: null,
      status: "pending",
      source: "project-url",
      created: "2026-05-29T00:00:00.000Z",
      updated: "2026-05-29T00:00:00.000Z",
      decided: null,
      decided_by_account_id: null,
      decision_message: null,
    }));
    listProjectAccessRequestsMock = jest.fn(async () => [
      {
        request_id: "88888888-8888-4888-8888-888888888888",
        project_id: PROJECT_ID,
        requester_account_id: ACCOUNT_ID,
        requested_role: "viewer",
        status: "pending",
        source: "project-url",
        created: "2026-05-29T00:00:00.000Z",
        updated: "2026-05-29T00:00:00.000Z",
      },
    ]);
    respondProjectAccessRequestMock = jest.fn(async () => ({
      request_id: "88888888-8888-4888-8888-888888888888",
      project_id: PROJECT_ID,
      requester_account_id: ACCOUNT_ID,
      requested_role: "viewer",
      status: "approved",
      source: "project-url",
      created: "2026-05-29T00:00:00.000Z",
      updated: "2026-05-29T00:01:00.000Z",
    }));
    listProjectAccessRequestBlocksMock = jest.fn(async () => [
      {
        project_id: PROJECT_ID,
        blocker_account_id: "33333333-3333-4333-8333-333333333333",
        blocked_account_id: ACCOUNT_ID,
        created: "2026-05-29T00:00:00.000Z",
        updated: "2026-05-29T00:00:00.000Z",
      },
    ]);
    unblockProjectAccessRequesterMock = jest.fn(async () => ({
      unblocked: true,
      project_id: PROJECT_ID,
      blocked_account_id: ACCOUNT_ID,
    }));
    loadProjectReadDetailsDirectMock = jest.fn();
    assertClusterAccountTrustedForProductAccessMock = jest.fn(
      async () => undefined,
    );
    applyAccountProjectFeedRemoveOnHomeBayMock = jest.fn(async () => undefined);
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

  it("removes stale account project projections when ownership no longer resolves", async () => {
    resolveProjectBayMock = jest.fn(async () => null);

    const { getProjectRegion } = await import("./projects");
    await expect(
      getProjectRegion({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow("project not found");

    expect(applyAccountProjectFeedRemoveOnHomeBayMock).toHaveBeenCalledWith({
      type: "project.remove",
      ts: expect.any(Number),
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      reason: "membership_removed",
    });
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
    expect(
      assertClusterAccountTrustedForProductAccessMock,
    ).not.toHaveBeenCalled();
    expect(resolveProjectCollabInviteDirectoryMock).toHaveBeenCalledWith({
      invite_id: "77777777-7777-4777-8777-777777777777",
      token_hash: expect.any(String),
    });
    expect(result.responded).toEqual(new Date("2026-05-18T01:00:00.000Z"));
  });

  it("routes email invite preview through the owning bay", async () => {
    const { previewEmailProjectInvite } = await import("./projects");
    const result = await previewEmailProjectInvite({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
      token: "token-1",
    });

    expect(previewEmailMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
      token: "token-1",
    });
    expect(resolveProjectCollabInviteDirectoryMock).toHaveBeenCalledWith({
      invite_id: "77777777-7777-4777-8777-777777777777",
      token_hash: expect.any(String),
    });
    expect(result.created).toEqual(new Date("2026-05-18T00:00:00.000Z"));
    expect(result.message).toBe("Please join");
  });

  it("routes email invite decline/block responses through the owning bay", async () => {
    const { respondEmailProjectInvite } = await import("./projects");
    const result = await respondEmailProjectInvite({
      account_id: ACCOUNT_ID,
      action: "decline",
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
      token: "token-1",
    });

    expect(respondEmailMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      action: "decline",
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
      token: "token-1",
    });
    expect(
      assertClusterAccountTrustedForProductAccessMock,
    ).not.toHaveBeenCalled();
    expect(resolveProjectCollabInviteDirectoryMock).toHaveBeenCalledWith({
      invite_id: "77777777-7777-4777-8777-777777777777",
      token_hash: expect.any(String),
    });
    expect(result.responded).toEqual(new Date("2026-05-18T01:00:00.000Z"));
    expect(result.status).toBe("declined");
  });

  it("uses the central invite directory for email invite preview", async () => {
    resolveProjectBayMock = jest.fn(async () => null);
    resolveProjectCollabInviteDirectoryMock = jest.fn(async () => ({
      invite_id: "77777777-7777-4777-8777-777777777777",
      project_id: PROJECT_ID,
      owning_bay_id: "bay-7",
      token_hash: "hash",
    }));

    const { previewEmailProjectInvite } = await import("./projects");
    await expect(
      previewEmailProjectInvite({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        invite_id: "77777777-7777-4777-8777-777777777777",
        token: "token-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        invite_id: "77777777-7777-4777-8777-777777777777",
        project_id: PROJECT_ID,
      }),
    );
    expect(resolveProjectBayMock).not.toHaveBeenCalled();
    expect(resolveProjectCollabInviteDirectoryMock).toHaveBeenCalledWith({
      invite_id: "77777777-7777-4777-8777-777777777777",
      token_hash: expect.any(String),
    });
    expect(previewEmailMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
      token: "token-1",
    });
  });

  it("routes token-only email invite preview through the central directory", async () => {
    resolveProjectBayMock = jest.fn(async () => null);

    const { previewEmailProjectInvite } = await import("./projects");
    const result = await previewEmailProjectInvite({
      account_id: ACCOUNT_ID,
      token: "token-1",
    });

    expect(resolveProjectBayMock).not.toHaveBeenCalled();
    expect(resolveProjectCollabInviteDirectoryMock).toHaveBeenCalledWith({
      token_hash: expect.any(String),
    });
    expect(previewEmailMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
      token: "token-1",
    });
    expect(result.project_id).toBe(PROJECT_ID);
  });

  it("routes email invite accept responses without requiring product-access trust", async () => {
    const { respondEmailProjectInvite } = await import("./projects");
    await respondEmailProjectInvite({
      account_id: ACCOUNT_ID,
      action: "accept",
      token: "token-1",
    });

    expect(
      assertClusterAccountTrustedForProductAccessMock,
    ).not.toHaveBeenCalled();
    expect(respondEmailMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      action: "accept",
      project_id: PROJECT_ID,
      invite_id: "77777777-7777-4777-8777-777777777777",
      token: "token-1",
    });
  });

  it("routes project access request APIs to the owning bay", async () => {
    const {
      getProjectAccessLandingInfo,
      requestProjectAccess,
      listProjectAccessRequests,
      respondProjectAccessRequest,
      listProjectAccessRequestBlocks,
      unblockProjectAccessRequester,
    } = await import("./projects");

    await expect(
      getProjectAccessLandingInfo({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual(expect.objectContaining({ project_id: PROJECT_ID }));
    await expect(
      requestProjectAccess({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        requested_role: "viewer",
        source: "project-url",
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "pending" }));
    await expect(
      listProjectAccessRequests({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        status: "pending",
      }),
    ).resolves.toHaveLength(1);
    await expect(
      respondProjectAccessRequest({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        request_id: "88888888-8888-4888-8888-888888888888",
        action: "approve",
        role: "viewer",
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "approved" }));
    await expect(
      listProjectAccessRequestBlocks({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      unblockProjectAccessRequester({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        blocked_account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual(expect.objectContaining({ unblocked: true }));

    expect(getProjectAccessLandingInfoMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(requestProjectAccessMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      requested_role: "viewer",
      read_policy: undefined,
      message: undefined,
      source: "project-url",
    });
    expect(listProjectAccessRequestsMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      status: "pending",
      limit: undefined,
    });
    expect(respondProjectAccessRequestMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      request_id: "88888888-8888-4888-8888-888888888888",
      action: "approve",
      role: "viewer",
      read_policy: undefined,
      message: undefined,
    });
    expect(listProjectAccessRequestBlocksMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      limit: undefined,
    });
    expect(unblockProjectAccessRequesterMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      blocked_account_id: ACCOUNT_ID,
    });
  });
});
