export {};

let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let isAdminMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let resolveProjectCollabInviteDirectoryMock: jest.Mock;
let projectDetailsGetMock: jest.Mock;
let projectReferenceGetMock: jest.Mock;
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

  it("leaves course secret APIs to edge routing", async () => {
    // These run on the course project's owning bay; see edge-routing.test.ts
    // and the two-bay suite.
    const { getHubApiRoute, hubApiRouteKey } =
      await import("@cocalc/conat/hub/api/routes");
    for (const name of [
      "listCourseShareableSecrets",
      "getCourseSecretPolicy",
      "previewCourseSecretSync",
      "setCourseSecretPolicy",
      "setCourseSecretGrants",
      "approveCourseSecretRecipients",
      "revokeCourseSecretRecipients",
      "startCourseSecretSync",
      "startCourseSecretCleanup",
      "getCourseSecretSyncStatus",
      "revokeCourseSecretPolicy",
    ]) {
      const route = getHubApiRoute(`projects.${name}`);
      expect([name, route?.owner]).toEqual([name, "project"]);
      expect(hubApiRouteKey(route!, [{ course_project_id: PROJECT_ID }])).toBe(
        PROJECT_ID,
      );
    }
    const sharing = getHubApiRoute("projects.setProjectSecretCourseSharing")!;
    expect(hubApiRouteKey(sharing, [{ project_id: PROJECT_ID }])).toBe(
      PROJECT_ID,
    );
    // Copying secrets involves two projects: it stays an explicit workflow.
    expect(getHubApiRoute("projects.copyProjectSecrets")).toBeUndefined();
  });

  it("leaves collaborator invite APIs to edge routing", async () => {
    // These run on the bay that owns the project (or the email invite, found
    // in the invite directory); see edge-routing.test.ts and the two-bay suite.
    const { getHubApiRoute } = await import("@cocalc/conat/hub/api/routes");
    const owners = Object.fromEntries(
      [
        "createCollabInvite",
        "inviteCollaboratorWithoutAccount",
        "listCollabInvites",
        "respondCollabInvite",
        "removeCollaborator",
        "copyEmailProjectInviteLink",
        "redeemEmailProjectInvite",
        "previewEmailProjectInvite",
        "respondEmailProjectInvite",
      ].map((name) => [name, getHubApiRoute(`projects.${name}`)?.owner]),
    );
    expect(owners).toEqual({
      createCollabInvite: "project",
      inviteCollaboratorWithoutAccount: "project",
      listCollabInvites: "project",
      respondCollabInvite: "project",
      removeCollaborator: "project",
      copyEmailProjectInviteLink: "collab-invite",
      redeemEmailProjectInvite: "collab-invite",
      previewEmailProjectInvite: "collab-invite",
      respondEmailProjectInvite: "collab-invite",
    });
  });

  it("leaves project access request APIs to edge routing", async () => {
    // These run on the project's owning bay: the receiving hub forwards the
    // whole call there (see edge-routing.test.ts and the two-bay suite), so
    // the methods themselves no longer consult the inter-bay bridge.
    const { getHubApiRoute } = await import("@cocalc/conat/hub/api/routes");
    for (const name of [
      "getProjectAccessLandingInfo",
      "requestProjectAccess",
      "listProjectAccessRequests",
      "respondProjectAccessRequest",
      "listProjectAccessRequestBlocks",
      "unblockProjectAccessRequester",
      "getProjectCollaboratorInviteUsage",
    ]) {
      expect([name, getHubApiRoute(`projects.${name}`)?.owner]).toEqual([
        name,
        "project",
      ]);
    }
  });
});
