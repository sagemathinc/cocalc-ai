export {};

let queryMock: jest.Mock;
let startProjectOnHostMock: jest.Mock;
let stopProjectOnHostMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let ensureProjectFileServerClientReadyMock: jest.Mock;
let issueRootfsReleaseArtifactUploadMock: jest.Mock;
let upsertPublishedRootfsReleaseMock: jest.Mock;
let getCurrentProjectRootfsBindingMock: jest.Mock;
let setProjectRootfsImageWithRollbackMock: jest.Mock;
let queryTableMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: (...args: any[]) => queryMock(...args) })),
}));

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: jest.fn(() => ({})),
}));

jest.mock("@cocalc/database/postgres/query", () => ({
  __esModule: true,
  query: (...args: any[]) => queryTableMock(...args),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  startProjectOnHost: (...args: any[]) => startProjectOnHostMock(...args),
  stopProjectOnHost: (...args: any[]) => stopProjectOnHostMock(...args),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: (...args: any[]) =>
    getProjectFileServerClientMock(...args),
  ensureProjectFileServerClientReady: (...args: any[]) =>
    ensureProjectFileServerClientReadyMock(...args),
}));

jest.mock("@cocalc/server/rootfs/releases", () => ({
  __esModule: true,
  issueRootfsReleaseArtifactUpload: (...args: any[]) =>
    issueRootfsReleaseArtifactUploadMock(...args),
  upsertPublishedRootfsRelease: (...args: any[]) =>
    upsertPublishedRootfsReleaseMock(...args),
}));

jest.mock("@cocalc/server/projects/rootfs-state", () => ({
  __esModule: true,
  getCurrentProjectRootfsBinding: (...args: any[]) =>
    getCurrentProjectRootfsBindingMock(...args),
  setProjectRootfsImageWithRollback: (...args: any[]) =>
    setProjectRootfsImageWithRollbackMock(...args),
}));

jest.mock("@cocalc/server/membership/project-defaults", () => ({
  __esModule: true,
  getMembershipProjectDefaultsForAccount: jest.fn(async () => ({})),
  mergeProjectSettingsWithMembership: jest.fn((settings: any) => settings),
}));

jest.mock("@cocalc/database/postgres/quota-site-settings", () => ({
  __esModule: true,
  getQuotaSiteSettings: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/util/upgrades/quota", () => ({
  __esModule: true,
  quota: jest.fn(() => ({})),
}));

jest.mock("@cocalc/conat/project/runner/run", () => ({
  __esModule: true,
  client: jest.fn(() => ({
    status: jest.fn(async () => ({ state: "opened" })),
  })),
}));

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: jest.fn(() => ({})),
}));

describe("BaseProject.start RootFS sealing", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
  const HOST_ID = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT COALESCE(owning_bay_id, $2) AS owning_bay_id")) {
        return { rows: [{ owning_bay_id: "bay-0" }] };
      }
      if (sql === "SELECT host_id FROM projects WHERE project_id=$1") {
        return { rows: [{ host_id: HOST_ID }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    queryTableMock = jest.fn(async () => ({}));
    startProjectOnHostMock = jest.fn(async () => undefined);
    stopProjectOnHostMock = jest.fn(async () => undefined);
    ensureProjectFileServerClientReadyMock = jest.fn(async () => undefined);
    issueRootfsReleaseArtifactUploadMock = jest.fn(async () => ({
      backend: "rustic",
      repo_toml: "repo",
      repo_selector: "repo-selector",
      artifact_backend: "rest",
    }));
    upsertPublishedRootfsReleaseMock = jest.fn(async () => ({
      release_id: "release-1",
    }));
    getCurrentProjectRootfsBindingMock = jest.fn(async () => ({
      image: "docker.io/ubuntu:26.04",
    }));
    setProjectRootfsImageWithRollbackMock = jest.fn(async () => undefined);
    getProjectFileServerClientMock = jest.fn(async () => ({
      publishRootfsImage: jest.fn(async () => ({
        image: "cocalc.local/rootfs/abcdef",
        content_key:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        source_image: "docker.io/ubuntu:26.04",
        arch: "amd64",
        snapshot: "snap-1",
        created_snapshot: true,
        upload_result: {
          ok: true,
          backend: "rustic",
          artifact_format: "rustic",
          artifact_backend: "rest",
          artifact_sha256:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          artifact_bytes: 123,
          artifact_path: "rustic/rest/site/snap-1",
          snapshot_id:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          repo_selector: "repo-selector",
        },
      })),
      uploadRootfsReleaseArtifact: jest.fn(),
    }));
  });

  it("restarts on a sealed managed RootFS when the current binding is unsealed", async () => {
    const { BaseProject } = await import("./base");
    const project = new BaseProject(PROJECT_ID);
    project.computeQuota = jest.fn(async () => undefined);

    await project.start({ account_id: ACCOUNT_ID, lro_op_id: "op-1" });

    expect(startProjectOnHostMock).toHaveBeenNthCalledWith(1, PROJECT_ID, {
      account_id: ACCOUNT_ID,
      lro_op_id: "op-1",
    });
    expect(issueRootfsReleaseArtifactUploadMock).toHaveBeenCalledWith({
      host_id: HOST_ID,
      artifact_kind: "full",
    });
    expect(setProjectRootfsImageWithRollbackMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      image: "cocalc.local/rootfs/abcdef",
      set_by_account_id: ACCOUNT_ID,
    });
    expect(stopProjectOnHostMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(startProjectOnHostMock).toHaveBeenNthCalledWith(2, PROJECT_ID, {
      account_id: ACCOUNT_ID,
      lro_op_id: "op-1",
    });
  });

  it("does not publish or restart when the current RootFS is already managed", async () => {
    getCurrentProjectRootfsBindingMock = jest.fn(async () => ({
      image: "cocalc.local/rootfs/abcdef",
      release_id: "release-1",
    }));
    const { BaseProject } = await import("./base");
    const project = new BaseProject(PROJECT_ID);
    project.computeQuota = jest.fn(async () => undefined);

    await project.start({ account_id: ACCOUNT_ID, lro_op_id: "op-1" });

    expect(startProjectOnHostMock).toHaveBeenCalledTimes(1);
    expect(issueRootfsReleaseArtifactUploadMock).not.toHaveBeenCalled();
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
    expect(setProjectRootfsImageWithRollbackMock).not.toHaveBeenCalled();
  });
});
