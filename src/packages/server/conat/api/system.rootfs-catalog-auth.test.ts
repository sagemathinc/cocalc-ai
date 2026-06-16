export {};

let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;
let saveRootfsImageMock: jest.Mock;
let requestRootfsImageDeletionMock: jest.Mock;
let runPendingRootfsReleaseGcMock: jest.Mock;
let listRootfsRusticReposAdminMock: jest.Mock;
let assertProjectCollaboratorAccessAllowRemoteMock: jest.Mock;
let assertCanCreateOrUpdateRootfsMock: jest.Mock;
let createLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let listVisibleRootfsImagesByIdMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

jest.mock("@cocalc/server/rootfs/catalog", () => ({
  __esModule: true,
  listRootfsImagesAdmin: jest.fn(),
  listVisibleRootfsImages: jest.fn(),
  listVisibleRootfsImagesById: (...args: any[]) =>
    listVisibleRootfsImagesByIdMock(...args),
  requestRootfsImageDeletion: (...args: any[]) =>
    requestRootfsImageDeletionMock(...args),
  saveRootfsImage: (...args: any[]) => saveRootfsImageMock(...args),
}));

jest.mock("@cocalc/server/rootfs/releases", () => ({
  __esModule: true,
  listRootfsRusticReposAdmin: (...args: any[]) =>
    listRootfsRusticReposAdminMock(...args),
  runPendingRootfsReleaseGc: (...args: any[]) =>
    runPendingRootfsReleaseGcMock(...args),
}));

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  __esModule: true,
  assertProjectCollaboratorAccessAllowRemote: (...args: any[]) =>
    assertProjectCollaboratorAccessAllowRemoteMock(...args),
}));

jest.mock("@cocalc/server/membership/rootfs-limits", () => ({
  __esModule: true,
  assertCanCreateOrUpdateRootfs: (...args: any[]) =>
    assertCanCreateOrUpdateRootfsMock(...args),
  assertCanSelectProjectRootfsImage: jest.fn(),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: (...args: any[]) => publishLroEventMock(...args),
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/conat/lro/names", () => ({
  __esModule: true,
  lroStreamName: jest.fn((op_id: string) => `stream:${op_id}`),
}));

jest.mock("@cocalc/conat/persist/util", () => ({
  __esModule: true,
  SERVICE: "persist-service",
}));

describe("RootFS catalog dangerous-session auth", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [{ owner_id: ACCOUNT_ID }],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    requireDangerousSessionAuthMock = jest.fn(async () => ({}));
    saveRootfsImageMock = jest.fn(async () => ({ id: "image-1" }));
    requestRootfsImageDeletionMock = jest.fn(async () => ({
      image_id: "image-1",
      blockers: { total: 0 },
    }));
    runPendingRootfsReleaseGcMock = jest.fn(async () => ({
      scanned: 0,
      deleted: 0,
      blocked: 0,
      errors: [],
    }));
    listRootfsRusticReposAdminMock = jest.fn(async () => ({
      repos: [],
      legacy: { artifact_count: 0, artifact_bytes: 0 },
    }));
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(async () => {});
    assertCanCreateOrUpdateRootfsMock = jest.fn(async () => {});
    createLroMock = jest.fn(async (opts) => ({
      op_id: "op-rootfs-publish-1",
      scope_type: opts.scope_type,
      scope_id: opts.scope_id,
      service: "persist-service",
      stream_name: "stream:op-rootfs-publish-1",
      ...opts,
    }));
    publishLroSummaryMock = jest.fn(async () => {});
    publishLroEventMock = jest.fn(async () => {});
    listVisibleRootfsImagesByIdMock = jest.fn(async () => ({
      version: 1,
      images: [],
    }));
  });

  it("requires fresh auth, not 2FA, for ordinary owner catalog saves", async () => {
    const { saveRootfsCatalogEntry } = await import("./system");
    await saveRootfsCatalogEntry({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      image: "example/rootfs:latest",
      label: "Example",
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      require_second_factor: false,
    });
    expect(saveRootfsImageMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      body: {
        image: "example/rootfs:latest",
        label: "Example",
      },
    });
  });

  it("requires recent 2FA for admin lifecycle catalog fields", async () => {
    isAdminMock = jest.fn(async () => true);
    const { saveRootfsCatalogEntry } = await import("./system");
    await saveRootfsCatalogEntry({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      image: "example/rootfs:latest",
      label: "Example",
      hidden: false,
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      require_second_factor: true,
    });
  });

  it("requires recent 2FA when an admin deletes another account's RootFS entry", async () => {
    isAdminMock = jest.fn(async () => true);
    queryMock = jest.fn(async () => ({
      rows: [{ owner_id: OTHER_ACCOUNT_ID }],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    const { requestRootfsImageDeletion } = await import("./system");
    await requestRootfsImageDeletion({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      image_id: "image-1",
      reason: "cleanup",
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      require_second_factor: true,
    });
    expect(requestRootfsImageDeletionMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      image_id: "image-1",
      reason: "cleanup",
    });
  });

  it("requires recent 2FA for RootFS release GC", async () => {
    isAdminMock = jest.fn(async () => true);
    const { runRootfsReleaseGc } = await import("./system");
    await runRootfsReleaseGc({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      limit: 100,
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      require_second_factor: true,
    });
    expect(runPendingRootfsReleaseGcMock).toHaveBeenCalledWith({ limit: 100 });
  });

  it("requires fresh auth before publishing a project RootFS image", async () => {
    requireDangerousSessionAuthMock = jest.fn(async () => {
      throw Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      });
    });

    const { publishProjectRootfsImage } = await import("./system");
    await expect(
      publishProjectRootfsImage({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        project_id: "project-1",
        label: "Published RootFS",
      }),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: false,
    });
  });

  it("queues project switch preference in the RootFS publish LRO input", async () => {
    const { publishProjectRootfsImage } = await import("./system");
    const op = await publishProjectRootfsImage({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      project_id: "project-1",
      label: "Published RootFS",
      switch_project: true,
    });

    expect(op).toMatchObject({
      op_id: "op-rootfs-publish-1",
      scope_type: "project",
      scope_id: "project-1",
      service: "persist-service",
      stream_name: "stream:op-rootfs-publish-1",
    });
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project-rootfs-publish",
        scope_type: "project",
        scope_id: "project-1",
        input: expect.objectContaining({
          project_id: "project-1",
          label: "Published RootFS",
          switch_project: true,
        }),
      }),
    );
  });

  it("resolves visible RootFS catalog entries by id", async () => {
    const { getRootfsCatalogEntries } = await import("./system");
    const result = await getRootfsCatalogEntries({
      account_id: ACCOUNT_ID,
      image_ids: ["image-1", "image-2"],
    });

    expect(result).toEqual({ version: 1, images: [] });
    expect(listVisibleRootfsImagesByIdMock).toHaveBeenCalledWith(ACCOUNT_ID, [
      "image-1",
      "image-2",
    ]);
  });

  it("allows admins to list RootFS rustic repos without fresh auth", async () => {
    isAdminMock = jest.fn(async () => true);
    const { getRootfsRusticReposAdmin } = await import("./system");
    await getRootfsRusticReposAdmin({
      account_id: ACCOUNT_ID,
      region: "wnam",
      status: "active",
    });

    expect(requireDangerousSessionAuthMock).not.toHaveBeenCalled();
    expect(listRootfsRusticReposAdminMock).toHaveBeenCalledWith({
      region: "wnam",
      status: "active",
    });
  });

  it("rejects non-admin RootFS rustic repo listings", async () => {
    const { getRootfsRusticReposAdmin } = await import("./system");
    await expect(
      getRootfsRusticReposAdmin({
        account_id: ACCOUNT_ID,
      }),
    ).rejects.toThrow("must be an admin");
    expect(listRootfsRusticReposAdminMock).not.toHaveBeenCalled();
  });
});
