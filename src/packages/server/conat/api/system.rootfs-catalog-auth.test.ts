export {};

let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;
let saveRootfsImageMock: jest.Mock;
let requestRootfsImageDeletionMock: jest.Mock;
let runPendingRootfsReleaseGcMock: jest.Mock;

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
  requestRootfsImageDeletion: (...args: any[]) =>
    requestRootfsImageDeletionMock(...args),
  saveRootfsImage: (...args: any[]) => saveRootfsImageMock(...args),
}));

jest.mock("@cocalc/server/rootfs/releases", () => ({
  __esModule: true,
  runPendingRootfsReleaseGc: (...args: any[]) =>
    runPendingRootfsReleaseGcMock(...args),
}));

describe("RootFS catalog dangerous-session auth", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
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
});
