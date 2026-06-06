import {
  __test__,
  partitionManageableProjectHostAcpWorkers,
  partitionExpectedProjectHostAcpWorkers,
  planProjectHostAcpWorkerRollout,
} from "./hub/acp/worker-manager";
import { getAcpWorker } from "@cocalc/lite/hub/sqlite/acp-workers";

jest.mock("@cocalc/lite/hub/sqlite/acp-workers", () => ({
  getAcpWorker: jest.fn(),
}));

const mockGetAcpWorker = getAcpWorker as jest.MockedFunction<
  typeof getAcpWorker
>;

describe("planProjectHostAcpWorkerRollout", () => {
  const launch = {
    command: "/usr/bin/node",
    args: ["/opt/cocalc/project-host/bundles/current/main/index.js"],
    nodeLike: true,
    resolvedCommand: "/usr/bin/node",
    resolvedEntryPoint:
      "/opt/cocalc/project-host/bundles/current/main/index.js",
  };

  it("keeps the newest worker on the current bundle active and drains the rest", () => {
    const workers = [
      {
        pid: 101,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-old",
        },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/old/main/index.js",
        ],
      },
      {
        pid: 102,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current-1",
        },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/current/main/index.js",
        ],
      },
      {
        pid: 103,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current-2",
        },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/current/main/index.js",
        ],
      },
    ];

    expect(
      planProjectHostAcpWorkerRollout({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      activePid: 103,
      drainingPids: [101, 102],
      terminatePids: [],
      spawnNewActive: false,
    });
  });

  it("spawns a new active worker when only older rolling workers exist", () => {
    const workers = [
      {
        pid: 201,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-old",
        },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/old/main/index.js",
        ],
      },
    ];

    expect(
      planProjectHostAcpWorkerRollout({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      activePid: undefined,
      drainingPids: [201],
      terminatePids: [],
      spawnNewActive: true,
    });
  });

  it("spawns a new active worker when the only current-bundle worker is already draining", () => {
    const workers = [
      {
        pid: 401,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current-draining",
        },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/current/main/index.js",
        ],
      },
    ];

    expect(
      planProjectHostAcpWorkerRollout({
        workers: workers as any,
        launch: launch as any,
        drainingWorkerIds: ["worker-current-draining"],
      }),
    ).toEqual({
      activePid: undefined,
      drainingPids: [401],
      terminatePids: [],
      spawnNewActive: true,
    });
  });

  it("treats legacy workers as non-cooperative during the rollout transition", () => {
    const workers = [
      {
        pid: 301,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
        },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/old/main/index.js",
        ],
      },
    ];

    expect(
      planProjectHostAcpWorkerRollout({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      activePid: undefined,
      drainingPids: [],
      terminatePids: [301],
      spawnNewActive: true,
    });
  });

  it("ignores ACP-tagged descendant processes that do not match the worker entrypoint", () => {
    const workers = [
      {
        pid: 501,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/current/main/index.js",
        ],
      },
      {
        pid: 777,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: ["/usr/bin/git", "status"],
      },
    ];

    expect(
      partitionExpectedProjectHostAcpWorkers({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      expectedWorkers: [workers[0]],
      ignoredWorkers: [workers[1]],
    });
  });

  it("accepts ACP workers that use the project-host process title as argv0", () => {
    const workers = [
      {
        pid: 601,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: [
          "project-host:acp-worker",
          "/opt/cocalc/project-host/bundles/current/main/index.js",
        ],
      },
      {
        pid: 602,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current-wrong-entry",
        },
        cmdline: [
          "project-host:acp-worker",
          "/opt/cocalc/project-host/bundles/old/main/index.js",
        ],
      },
    ];

    expect(
      partitionExpectedProjectHostAcpWorkers({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      expectedWorkers: [workers[0]],
      ignoredWorkers: [workers[1]],
    });
  });

  it("accepts titled ACP workers whose bundle identity only exists in env", () => {
    const workers = [
      {
        pid: 701,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current",
          COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_PATH:
            "/opt/cocalc/project-host/bundles/current",
          COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_VERSION: "current",
        },
        cmdline: ["project-host:acp-worker"],
      },
      {
        pid: 702,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-old",
          COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_PATH:
            "/opt/cocalc/project-host/bundles/old",
          COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_VERSION: "old",
        },
        cmdline: ["project-host:acp-worker"],
      },
    ];

    expect(
      partitionExpectedProjectHostAcpWorkers({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      expectedWorkers: [workers[0]],
      ignoredWorkers: [workers[1]],
    });
  });

  it("treats older-bundle ACP workers as manageable for supervisor cleanup", () => {
    const workers = [
      {
        pid: 801,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/current/main/index.js",
        ],
      },
      {
        pid: 802,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-old",
        },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/old/main/index.js",
        ],
      },
      {
        pid: 803,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-descendant",
        },
        cmdline: ["/usr/bin/git", "status"],
      },
    ];

    expect(
      partitionManageableProjectHostAcpWorkers({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      managedWorkers: [workers[0], workers[1]],
      ignoredWorkers: [workers[2]],
    });
  });

  it("treats titled older-bundle ACP workers with env-only bundle metadata as manageable", () => {
    const workers = [
      {
        pid: 901,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-current",
          COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_PATH:
            "/opt/cocalc/project-host/bundles/current",
          COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_VERSION: "current",
        },
        cmdline: ["project-host:acp-worker"],
      },
      {
        pid: 902,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-old",
          COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_PATH:
            "/opt/cocalc/project-host/bundles/old",
          COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_VERSION: "old",
        },
        cmdline: ["project-host:acp-worker"],
      },
      {
        pid: 903,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER: "1",
          COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: "rolling-v1",
          COCALC_ACP_INSTANCE_ID: "worker-descendant",
        },
        cmdline: ["project-host:acp-worker"],
      },
    ];

    expect(
      partitionManageableProjectHostAcpWorkers({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      managedWorkers: [workers[0], workers[1]],
      ignoredWorkers: [workers[2]],
    });
  });
});

describe("ACP worker spawn backoff", () => {
  beforeEach(() => {
    __test__.resetProjectHostAcpWorkerSpawnBackoff();
    jest.spyOn(Date, "now").mockReturnValue(1_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses bounded exponential delays between repeated spawn attempts", () => {
    expect(__test__.projectHostAcpWorkerSpawnBackoffRemainingMs()).toBe(0);

    expect(__test__.noteProjectHostAcpWorkerSpawn()).toEqual({
      attempt: 1,
      backoffMs: 5_000,
    });
    expect(__test__.projectHostAcpWorkerSpawnBackoffRemainingMs()).toBe(5_000);

    jest.spyOn(Date, "now").mockReturnValue(6_000);
    expect(__test__.noteProjectHostAcpWorkerSpawn()).toEqual({
      attempt: 2,
      backoffMs: 10_000,
    });
    expect(__test__.projectHostAcpWorkerSpawnBackoffRemainingMs()).toBe(10_000);
  });

  it("resets the backoff once a healthy worker is recognized", () => {
    __test__.noteProjectHostAcpWorkerSpawn();
    expect(__test__.projectHostAcpWorkerSpawnBackoffRemainingMs()).toBe(5_000);

    __test__.resetProjectHostAcpWorkerSpawnBackoff();
    expect(__test__.projectHostAcpWorkerSpawnBackoffRemainingMs()).toBe(0);
  });
});

describe("ACP worker control startup grace", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockGetAcpWorker.mockReset();
  });

  it("gives newly spawned workers time to register control RPCs", () => {
    jest.spyOn(Date, "now").mockReturnValue(10_000);
    expect(
      __test__.workerControlStartupGraceExpired({
        pid: 1001,
        env: {
          COCALC_PROJECT_HOST_ACP_WORKER_STARTED_AT: "9000",
        },
        cmdline: ["project-host:acp-worker"],
      } as any),
    ).toBe(false);
  });

  it("treats workers without spawn timestamps as past grace", () => {
    expect(
      __test__.workerControlStartupGraceExpired({
        pid: 1002,
        env: {},
        cmdline: ["project-host:acp-worker"],
      } as any),
    ).toBe(true);
  });

  it("treats an unresponsive worker with a fresh database heartbeat as live", () => {
    jest.spyOn(Date, "now").mockReturnValue(100_000);
    mockGetAcpWorker.mockReturnValue({
      worker_id: "worker-current",
      host_id: "host-1",
      bundle_version: "current",
      bundle_path: "/opt/cocalc/project-host/bundles/current",
      pid: 1003,
      state: "active",
      started_at: 1_000,
      last_heartbeat_at: 92_000,
      last_seen_running_jobs: 1,
    });

    expect(
      __test__.workerDatabaseHeartbeatFresh({
        pid: 1003,
        env: {
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: ["project-host:acp-worker"],
      } as any),
    ).toBe(true);
  });

  it("does not treat a stale database heartbeat as live", () => {
    jest.spyOn(Date, "now").mockReturnValue(100_000);
    mockGetAcpWorker.mockReturnValue({
      worker_id: "worker-current",
      host_id: "host-1",
      bundle_version: "current",
      bundle_path: "/opt/cocalc/project-host/bundles/current",
      pid: 1004,
      state: "active",
      started_at: 1_000,
      last_heartbeat_at: 70_000,
      last_seen_running_jobs: 1,
    });

    expect(
      __test__.workerDatabaseHeartbeatFresh({
        pid: 1004,
        env: {
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: ["project-host:acp-worker"],
      } as any),
    ).toBe(false);
  });
});
