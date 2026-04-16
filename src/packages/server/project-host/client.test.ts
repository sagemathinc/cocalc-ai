/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let createHostControlClientMock: jest.Mock;
let getExplicitHostControlClientMock: jest.Mock;
let resolveHostBayAcrossClusterMock: jest.Mock;
let bridgeHostControlMock: jest.Mock;
let bridgeCreateProjectMock: jest.Mock;
let bridgeStartProjectMock: jest.Mock;

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostControlClient: (...args: any[]) =>
    createHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  getExplicitHostControlClient: (...args: any[]) =>
    getExplicitHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveHostBayAcrossCluster: (...args: any[]) =>
    resolveHostBayAcrossClusterMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    hostControl: (...args: any[]) => bridgeHostControlMock(...args),
  })),
}));

describe("project-host client routing", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_BAY_ID = "bay-0";
    createHostControlClientMock = jest.fn(() => ({ kind: "local-client" }));
    getExplicitHostControlClientMock = jest.fn(async () => ({
      kind: "explicit-client",
    }));
    resolveHostBayAcrossClusterMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    bridgeCreateProjectMock = jest.fn(async () => ({ project_id: "p1" }));
    bridgeStartProjectMock = jest.fn(async () => ({ project_id: "p1" }));
    bridgeHostControlMock = jest.fn(() => ({
      createProject: (...args: any[]) => bridgeCreateProjectMock(...args),
      startProject: (...args: any[]) => bridgeStartProjectMock(...args),
      stopProject: jest.fn(async () => ({ project_id: "p1" })),
      updateAuthorizedKeys: jest.fn(async () => undefined),
      updateProjectUsers: jest.fn(async () => undefined),
      applyPendingCopies: jest.fn(async () => ({ claimed: 0 })),
      deleteProjectData: jest.fn(async () => undefined),
      upgradeSoftware: jest.fn(async () => ({ results: [] })),
      rolloutManagedComponents: jest.fn(async () => ({ results: [] })),
      growBtrfs: jest.fn(async () => ({ ok: true })),
      getRuntimeLog: jest.fn(async () => ({ source: "x", lines: 1, text: "" })),
      getProjectRuntimeLog: jest.fn(async () => ({
        project_id: "p1",
        container: "c1",
        lines: 1,
        text: "",
        found: true,
        running: true,
      })),
      listRootfsImages: jest.fn(async () => []),
      pullRootfsImage: jest.fn(async () => ({
        image: "img",
        cache_path: "/tmp/cache",
        project_count: 0,
        running_project_count: 0,
        project_ids: [],
        running_project_ids: [],
      })),
      deleteRootfsImage: jest.fn(async () => ({ removed: true })),
      listHostSshAuthorizedKeys: jest.fn(async () => ({
        user: "u",
        home: "/h",
        path: "/h/.ssh/authorized_keys",
        keys: [],
      })),
      addHostSshAuthorizedKey: jest.fn(async () => ({
        user: "u",
        home: "/h",
        path: "/h/.ssh/authorized_keys",
        keys: [],
        added: true,
      })),
      removeHostSshAuthorizedKey: jest.fn(async () => ({
        user: "u",
        home: "/h",
        path: "/h/.ssh/authorized_keys",
        keys: [],
        removed: true,
      })),
      getBackupExecutionStatus: jest.fn(async () => ({
        max_parallel: 1,
        in_flight: 0,
        queued: 0,
        project_lock_count: 0,
      })),
      getManagedComponentStatus: jest.fn(async () => []),
      getHostAgentStatus: jest.fn(async () => ({
        project_host: {
          last_known_good_version: "ph-v1",
        },
      })),
      inspectStaticAppPath: jest.fn(async () => ({
        project_id: "p1",
        app_id: "app",
        static_root: "/tmp",
        exposure_mode: "private",
        public_access_granted: false,
        requested: {
          kind: "file",
          relative_path: "a.txt",
          container_path: "/tmp/a.txt",
        },
        containing_directory: {
          relative_path: "",
          container_path: "/tmp",
        },
      })),
      buildRootfsImageManifest: jest.fn(async () => ({
        format: "rootfs-manifest-v1",
        source_kind: "cached-image",
        root_path: "/tmp",
        generated_at: new Date().toISOString(),
        manifest_sha256: "a",
        hardlink_sha256: "b",
        entry_count: 0,
        regular_file_count: 0,
        directory_count: 0,
        symlink_count: 0,
        other_count: 0,
        hardlink_group_count: 0,
        hardlink_member_count: 0,
        total_regular_bytes: 0,
      })),
      buildProjectRootfsManifest: jest.fn(async () => ({
        format: "rootfs-manifest-v1",
        source_kind: "project-rootfs",
        root_path: "/tmp",
        generated_at: new Date().toISOString(),
        manifest_sha256: "a",
        hardlink_sha256: "b",
        entry_count: 0,
        regular_file_count: 0,
        directory_count: 0,
        symlink_count: 0,
        other_count: 0,
        hardlink_group_count: 0,
        hardlink_member_count: 0,
        total_regular_bytes: 0,
      })),
    }));
  });

  it("uses direct host control on the local host bay", async () => {
    const { getRoutedHostControlClient } = await import("./client");
    const client = await getRoutedHostControlClient({ host_id: "host-1" });
    expect(client).toEqual({ kind: "local-client" });
    expect(createHostControlClientMock).toHaveBeenCalledWith({
      host_id: "host-1",
      client: { kind: "explicit-client" },
      timeout: undefined,
    });
    expect(bridgeHostControlMock).not.toHaveBeenCalled();
  });

  it("uses inter-bay forwarding for remote hosts", async () => {
    resolveHostBayAcrossClusterMock = jest.fn(async () => ({
      bay_id: "bay-2",
      epoch: 1,
    }));
    const { getRoutedHostControlClient } = await import("./client");
    const client = await getRoutedHostControlClient({ host_id: "host-9" });
    await client.startProject({ project_id: "p1" });
    expect(bridgeHostControlMock).toHaveBeenCalledWith("bay-2", {
      timeout_ms: undefined,
    });
    expect(bridgeStartProjectMock).toHaveBeenCalledWith({
      host_id: "host-9",
      start: { project_id: "p1" },
    });
    expect(createHostControlClientMock).not.toHaveBeenCalled();
  });

  it("requires account_id for remote createProject", async () => {
    resolveHostBayAcrossClusterMock = jest.fn(async () => ({
      bay_id: "bay-2",
      epoch: 1,
    }));
    const { getRoutedHostControlClient } = await import("./client");
    const client = await getRoutedHostControlClient({ host_id: "host-9" });
    await expect(
      client.createProject({ project_id: "p1", title: "P" } as any),
    ).rejects.toThrow(
      "remote host createProject for host-9 requires account_id",
    );
  });
});
