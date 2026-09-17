import fs from "node:fs";
import {
  __test__,
  configureProjectHostAcpWorkerLauncher,
  partitionManageableProjectHostAcpWorkers,
  partitionExpectedProjectHostAcpWorkers,
  registeredManageableProjectHostAcpWorkers,
  planProjectHostAcpWorkerRollout,
  shouldTerminateOverdueDrainingWorker,
} from "./hub/acp/worker-manager";
import { acpDaemonControlClient } from "@cocalc/conat/ai/acp/daemon-control";
import {
  getAcpWorker,
  listAcpWorkers,
  stopAcpWorker,
} from "@cocalc/lite/hub/sqlite/acp-workers";
import {
  countRunningAcpJobsForWorker,
  decodeAcpJobRequest,
  latestAcpJobUpdateForWorker,
  listRunningAcpJobsByWorker,
  oldestClaimableQueuedAcpJobTimestamp,
} from "@cocalc/lite/hub/sqlite/acp-jobs";
import { countRunningAcpTurnLeasesForWorker } from "@cocalc/lite/hub/sqlite/acp-turns";
import {
  __test__ as workerHealthTest,
  isUnexpectedAcpWorkerTermination,
  summarizeProjectHostAcpWorkerHealth,
} from "./hub/acp/worker-health";

jest.mock("@cocalc/lite/hub/sqlite/acp-workers", () => ({
  getAcpWorker: jest.fn(),
  listAcpWorkers: jest.fn(() => []),
  stopAcpWorker: jest.fn(),
}));
jest.mock("@cocalc/lite/hub/sqlite/acp-jobs", () => ({
  countRunningAcpJobsForWorker: jest.fn(() => 0),
  decodeAcpJobRequest: jest.fn((row) => JSON.parse(row.request_json ?? "{}")),
  latestAcpJobUpdateForWorker: jest.fn(() => undefined),
  listRunningAcpJobsByWorker: jest.fn(() => []),
  oldestClaimableQueuedAcpJobTimestamp: jest.fn(() => undefined),
}));
jest.mock("@cocalc/lite/hub/sqlite/acp-turns", () => ({
  countRunningAcpTurnLeasesForWorker: jest.fn(() => 0),
}));
jest.mock("@cocalc/conat/ai/acp/daemon-control", () => ({
  acpDaemonControlClient: jest.fn(),
}));
jest.mock("./runtime-client", () => ({
  getProjectHostConatClient: jest.fn(),
}));
jest.mock("./hub/acp/worker-target", () => ({
  readProjectHostAcpWorkerTarget: jest.fn(),
}));

const mockGetAcpWorker = getAcpWorker as jest.MockedFunction<
  typeof getAcpWorker
>;
const mockListAcpWorkers = listAcpWorkers as jest.MockedFunction<
  typeof listAcpWorkers
>;
const mockStopAcpWorker = stopAcpWorker as jest.MockedFunction<
  typeof stopAcpWorker
>;
const mockCountRunningAcpJobsForWorker =
  countRunningAcpJobsForWorker as jest.MockedFunction<
    typeof countRunningAcpJobsForWorker
  >;
const mockLatestAcpJobUpdateForWorker =
  latestAcpJobUpdateForWorker as jest.MockedFunction<
    typeof latestAcpJobUpdateForWorker
  >;
const mockListRunningAcpJobsByWorker =
  listRunningAcpJobsByWorker as jest.MockedFunction<
    typeof listRunningAcpJobsByWorker
  >;
const mockDecodeAcpJobRequest = decodeAcpJobRequest as jest.MockedFunction<
  typeof decodeAcpJobRequest
>;
const mockOldestClaimableQueuedAcpJobTimestamp =
  oldestClaimableQueuedAcpJobTimestamp as jest.MockedFunction<
    typeof oldestClaimableQueuedAcpJobTimestamp
  >;
const mockCountRunningAcpTurnLeasesForWorker =
  countRunningAcpTurnLeasesForWorker as jest.MockedFunction<
    typeof countRunningAcpTurnLeasesForWorker
  >;

beforeEach(() => {
  mockGetAcpWorker.mockReset();
  mockListAcpWorkers.mockReset();
  mockListAcpWorkers.mockReturnValue([]);
  mockStopAcpWorker.mockReset();
  mockCountRunningAcpJobsForWorker.mockReset();
  mockCountRunningAcpJobsForWorker.mockReturnValue(0);
  mockLatestAcpJobUpdateForWorker.mockReset();
  mockLatestAcpJobUpdateForWorker.mockReturnValue(undefined);
  mockListRunningAcpJobsByWorker.mockReset();
  mockListRunningAcpJobsByWorker.mockReturnValue([]);
  mockDecodeAcpJobRequest.mockClear();
  mockDecodeAcpJobRequest.mockImplementation((row) =>
    JSON.parse(row.request_json ?? "{}"),
  );
  mockOldestClaimableQueuedAcpJobTimestamp.mockReset();
  mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(undefined);
  mockCountRunningAcpTurnLeasesForWorker.mockReset();
  mockCountRunningAcpTurnLeasesForWorker.mockReturnValue(0);
});

describe("ACP worker health", () => {
  it("reports unexpected supervisor replacements during the rolling window", () => {
    const now = Date.UTC(2026, 8, 14, 20, 0, 0);
    expect(isUnexpectedAcpWorkerTermination("managed_component_rollout")).toBe(
      false,
    );
    expect(isUnexpectedAcpWorkerTermination("queue_stalled_worker")).toBe(true);
    expect(
      summarizeProjectHostAcpWorkerHealth({
        now,
        oldestQueuedAt: now - 10 * 60_000,
        events: [
          {
            at_ms: now - workerHealthTest.degradedWindowMs - 1,
            reason: "queue_stalled_worker",
          },
          {
            at_ms: now - 30_000,
            reason: "unresponsive_worker",
          },
        ],
      }),
    ).toMatchObject({
      status: "degraded",
      unexpected_terminations: 1,
      latest_termination_reason: "unresponsive_worker",
      oldest_queued_age_ms: 10 * 60_000,
    });
  });
});

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

  it("preserves an older-bundle worker during steady-state project-host startup", () => {
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
        preserveMismatchedActive: true,
      }),
    ).toEqual({
      activePid: 201,
      drainingPids: [],
      terminatePids: [],
      spawnNewActive: false,
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

  it("requires a matching host-owned registration before fencing a worker", () => {
    const worker = {
      pid: 501,
      start_time_ticks: "12345",
      env: {
        COCALC_PROJECT_HOST_ACP_WORKER: "1",
        COCALC_ACP_INSTANCE_ID: "worker-current",
        PROJECT_HOST_ID: "host-1",
      },
      cmdline: [
        "/usr/bin/node",
        "/opt/cocalc/project-host/bundles/current/main/index.js",
      ],
    };
    const row = {
      worker_id: "worker-current",
      host_id: "host-1",
      bundle_version: "current",
      bundle_path: "/opt/cocalc/project-host/bundles/current",
      pid: 501,
      pid_start_time_ticks: "12345",
      state: "active",
      started_at: 1,
      last_heartbeat_at: 1,
      last_seen_running_jobs: 0,
      last_queue_progress_at: 1,
    } as const;

    expect(
      registeredManageableProjectHostAcpWorkers({
        workers: [worker],
        launch: launch as any,
        rows: [],
      }),
    ).toEqual([]);
    expect(
      registeredManageableProjectHostAcpWorkers({
        workers: [worker],
        launch: launch as any,
        rows: [{ ...row, pid: 999 }],
      }),
    ).toEqual([]);
    expect(
      registeredManageableProjectHostAcpWorkers({
        workers: [worker],
        launch: launch as any,
        rows: [{ ...row, pid_start_time_ticks: "54321" }],
      }),
    ).toEqual([]);
    expect(
      registeredManageableProjectHostAcpWorkers({
        workers: [worker],
        launch: launch as any,
        rows: [row],
      }),
    ).toEqual([worker]);
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
      last_queue_progress_at: 92_000,
    });

    expect(
      __test__.workerDatabaseStateProtectsUnresponsiveWorker({
        pid: 1003,
        env: {
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: ["project-host:acp-worker"],
      } as any),
    ).toBe(true);
  });

  it("does not treat a stale database heartbeat without running jobs as live", () => {
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
      last_seen_running_jobs: 0,
      last_queue_progress_at: 70_000,
    });

    expect(
      __test__.workerDatabaseStateProtectsUnresponsiveWorker({
        pid: 1004,
        env: {
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: ["project-host:acp-worker"],
      } as any),
    ).toBe(false);
  });

  it("protects an unresponsive worker with a running turn lease even when its heartbeat is stale", () => {
    jest.spyOn(Date, "now").mockReturnValue(100_000);
    mockGetAcpWorker.mockReturnValue({
      worker_id: "worker-current",
      host_id: "host-1",
      bundle_version: "current",
      bundle_path: "/opt/cocalc/project-host/bundles/current",
      pid: 1005,
      state: "active",
      started_at: 1_000,
      last_heartbeat_at: 70_000,
      last_seen_running_jobs: 1,
      last_queue_progress_at: 70_000,
    });
    mockListRunningAcpJobsByWorker.mockReturnValue([
      { worker_id: "worker-current" } as any,
    ]);
    mockCountRunningAcpTurnLeasesForWorker.mockReturnValue(1);

    expect(
      __test__.workerDatabaseStateProtectsUnresponsiveWorker({
        pid: 1005,
        env: {
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: ["project-host:acp-worker"],
      } as any),
    ).toBe(true);
  });

  it("protects an unresponsive worker while ACP backlog is inside the stall grace period", () => {
    jest.spyOn(Date, "now").mockReturnValue(100_000);
    mockGetAcpWorker.mockReturnValue({
      worker_id: "worker-current",
      host_id: "host-1",
      bundle_version: "current",
      bundle_path: "/opt/cocalc/project-host/bundles/current",
      pid: 1006,
      state: "active",
      started_at: 1_000,
      last_heartbeat_at: 70_000,
      last_seen_running_jobs: 0,
      last_queue_progress_at: 70_000,
    });
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(95_000);

    expect(
      __test__.workerDatabaseStateProtectsUnresponsiveWorker({
        pid: 1006,
        env: {
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: ["project-host:acp-worker"],
      } as any),
    ).toBe(true);
  });

  it("protects an unresponsive worker with fresh queue progress despite backlog", () => {
    jest.spyOn(Date, "now").mockReturnValue(100_000);
    mockGetAcpWorker.mockReturnValue({
      worker_id: "worker-current",
      host_id: "host-1",
      bundle_version: "current",
      bundle_path: "/opt/cocalc/project-host/bundles/current",
      pid: 1007,
      state: "active",
      started_at: 1_000,
      last_heartbeat_at: 98_000,
      last_seen_running_jobs: 1,
      last_queue_progress_at: 70_000,
    });
    mockListRunningAcpJobsByWorker.mockReturnValue([
      {
        worker_id: "worker-current",
        updated_at: 80_000,
        created_at: 80_000,
      } as any,
    ]);
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(80_000);

    expect(
      __test__.workerDatabaseStateProtectsUnresponsiveWorker({
        pid: 1007,
        env: {
          COCALC_ACP_INSTANCE_ID: "worker-current",
        },
        cmdline: ["project-host:acp-worker"],
      } as any),
    ).toBe(true);
  });

  it("does not protect an unresponsive worker when stale backlog has no queue progress", () => {
    jest.spyOn(Date, "now").mockReturnValue(200_000);
    mockGetAcpWorker.mockReturnValue({
      worker_id: "worker-current",
      host_id: "host-1",
      bundle_version: "current",
      bundle_path: "/opt/cocalc/project-host/bundles/current",
      pid: 1008,
      state: "active",
      started_at: 1_000,
      last_heartbeat_at: 195_000,
      last_seen_running_jobs: 1,
      last_queue_progress_at: 50_000,
    });
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(50_000);

    expect(
      __test__.workerDatabaseStateProtectsUnresponsiveWorker(
        {
          pid: 1008,
          env: {
            COCALC_ACP_INSTANCE_ID: "worker-current",
          },
          cmdline: ["project-host:acp-worker"],
        } as any,
        200_000,
      ),
    ).toBe(false);
  });
});

describe("queue-stalled ACP workers", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const worker = {
    pid: 1101,
    env: {
      COCALC_ACP_INSTANCE_ID: "worker-stalled",
      COCALC_PROJECT_HOST_ACP_WORKER_STARTED_AT: "1000",
    },
    cmdline: ["project-host:acp-worker"],
  };

  it("terminates stale backlog when the worker has no live turn lease and no queue progress", () => {
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(10_000);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(true);
  });

  it("does not terminate while backlog is still inside the stall grace period", () => {
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(170_000);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
  });

  it("only counts queue entries claimable by an active worker", () => {
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(undefined);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          state: "active",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
    expect(mockOldestClaimableQueuedAcpJobTimestamp).toHaveBeenCalledWith({
      worker_id: "worker-stalled",
      include_unassigned: true,
      known_worker_ids: [],
      reclaimable_worker_ids: [],
    });
  });

  it("counts queue affinity owned by a stopped worker as reclaimable", () => {
    mockListAcpWorkers.mockReturnValue([
      {
        worker_id: "worker-stopped",
        state: "stopped",
        started_at: 1_000,
        last_heartbeat_at: 1_000,
      } as any,
    ]);

    __test__.shouldTerminateQueueStalledWorker({
      worker: worker as any,
      status: {
        worker_id: "worker-stalled",
        state: "active",
        started_at: 1_000,
        last_queue_progress_at: 10_000,
        running_turn_leases: 0,
      } as any,
      now: 200_000,
      stallMs: 60_000,
    });

    expect(mockOldestClaimableQueuedAcpJobTimestamp).toHaveBeenCalledWith({
      worker_id: "worker-stalled",
      include_unassigned: true,
      known_worker_ids: ["worker-stopped"],
      reclaimable_worker_ids: ["worker-stopped"],
    });
  });

  it("counts queue affinity owned by a stale worker without a live pid", () => {
    mockListAcpWorkers.mockReturnValue([
      {
        worker_id: "worker-stale",
        state: "active",
        started_at: 1_000,
        last_heartbeat_at: 100_000,
        pid: null,
      } as any,
    ]);

    __test__.shouldTerminateQueueStalledWorker({
      worker: worker as any,
      status: {
        worker_id: "worker-stalled",
        state: "active",
        started_at: 1_000,
        last_queue_progress_at: 10_000,
        running_turn_leases: 0,
      } as any,
      now: 200_000,
      stallMs: 60_000,
    });

    expect(mockOldestClaimableQueuedAcpJobTimestamp).toHaveBeenCalledWith({
      worker_id: "worker-stalled",
      include_unassigned: true,
      known_worker_ids: ["worker-stale"],
      reclaimable_worker_ids: ["worker-stale"],
    });
  });

  it("preserves stale affinity while its pid is alive inside recovery grace", () => {
    jest.spyOn(process, "kill").mockImplementation(() => true);
    mockListAcpWorkers.mockReturnValue([
      {
        worker_id: "worker-recovering",
        state: "active",
        started_at: 1_000,
        last_heartbeat_at: 100_000,
        pid: 2202,
      } as any,
    ]);

    __test__.shouldTerminateQueueStalledWorker({
      worker: worker as any,
      status: {
        worker_id: "worker-stalled",
        state: "active",
        started_at: 1_000,
        last_queue_progress_at: 10_000,
        running_turn_leases: 0,
      } as any,
      now: 200_000,
      stallMs: 60_000,
    });

    expect(mockOldestClaimableQueuedAcpJobTimestamp).toHaveBeenCalledWith({
      worker_id: "worker-stalled",
      include_unassigned: true,
      known_worker_ids: ["worker-recovering"],
      reclaimable_worker_ids: [],
    });
  });

  it("does not assign unpinned queue entries to a draining worker", () => {
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(undefined);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          state: "draining",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
    expect(mockOldestClaimableQueuedAcpJobTimestamp).toHaveBeenCalledWith({
      worker_id: "worker-stalled",
      include_unassigned: false,
    });
  });

  it("leaves stopped workers to the normal stopped-worker cleanup", () => {
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(10_000);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          state: "stopped",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
    expect(mockOldestClaimableQueuedAcpJobTimestamp).not.toHaveBeenCalled();
  });

  it("does not terminate immediately after a long-running job completes", () => {
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(10_000);
    mockLatestAcpJobUpdateForWorker.mockReturnValue(199_000);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
    expect(mockLatestAcpJobUpdateForWorker).toHaveBeenCalledWith(
      "worker-stalled",
    );
  });

  it("does not terminate after execution settles but before its job transition", () => {
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(10_000);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 199_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
  });

  it("does not attribute another worker's running turn to the replacement worker", () => {
    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
  });

  it("terminates a worker that owns a stale running job without a turn lease", () => {
    mockListRunningAcpJobsByWorker.mockReturnValue([
      {
        worker_id: "worker-stalled",
        updated_at: 10_000,
        created_at: 10_000,
        request_json: "{}",
      } as any,
    ]);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(true);
  });

  it("does not terminate a worker that owns a live running turn lease", () => {
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(10_000);
    mockCountRunningAcpTurnLeasesForWorker.mockReturnValue(1);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
  });

  it("does not terminate a queue-stalled worker with a background terminal", () => {
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(10_000);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
          background_terminal_processes: 1,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
  });

  it("does not terminate a worker that is running a queued command job without a turn lease", () => {
    mockListRunningAcpJobsByWorker.mockReturnValue([
      {
        op_id: "command-job",
        worker_id: "worker-stalled",
        updated_at: 10_000,
        created_at: 10_000,
        request_json: JSON.stringify({ request_kind: "command" }),
      } as any,
    ]);

    expect(
      __test__.shouldTerminateQueueStalledWorker({
        worker: worker as any,
        status: {
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        } as any,
        now: 200_000,
        stallMs: 60_000,
      }),
    ).toBe(false);
  });

  it("cancels termination when execution settles during confirmation", async () => {
    jest.spyOn(Date, "now").mockReturnValue(200_000);
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(10_000);
    mockGetAcpWorker.mockReturnValue({
      worker_id: "worker-stalled",
      pid: worker.pid,
      state: "active",
      started_at: 1_000,
      last_heartbeat_at: 199_000,
      last_queue_progress_at: 199_000,
    } as any);

    const result = await __test__.confirmQueueStalledWorkerTermination({
      worker: worker as any,
      sleep: async () => {},
      readStatus: async () =>
        ({
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        }) as any,
      isAlive: () => true,
    });

    expect(result.confirmed).toBe(false);
  });

  it("confirms termination when the worker remains stalled", async () => {
    jest.spyOn(Date, "now").mockReturnValue(200_000);
    mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(10_000);
    mockGetAcpWorker.mockReturnValue({
      worker_id: "worker-stalled",
      pid: worker.pid,
      state: "active",
      started_at: 1_000,
      last_heartbeat_at: 199_000,
      last_queue_progress_at: 10_000,
    } as any);

    const result = await __test__.confirmQueueStalledWorkerTermination({
      worker: worker as any,
      sleep: async () => {},
      readStatus: async () =>
        ({
          worker_id: "worker-stalled",
          started_at: 1_000,
          last_queue_progress_at: 10_000,
          running_turn_leases: 0,
        }) as any,
      isAlive: () => true,
    });

    expect(result.confirmed).toBe(true);
  });

  it.each(["delay", "status refresh"])(
    "keeps the healthy worker when the newer candidate exits during %s",
    async (exitDuring) => {
      jest.useFakeTimers({ now: 200_000 });
      const entryPoint =
        "/opt/cocalc/project-host/bundles/current/main/index.js";
      configureProjectHostAcpWorkerLauncher({ entryPoint });
      const healthyPid = 1100;
      const candidatePid = 1101;
      let candidateAlive = true;
      jest
        .spyOn(fs, "readdirSync")
        .mockReturnValue([String(healthyPid), String(candidatePid)] as any);
      jest.spyOn(fs, "readFileSync").mockImplementation((filename) => {
        const pid = Number(String(filename).split("/")[2]);
        if (String(filename).endsWith("/environ")) {
          return [
            "COCALC_PROJECT_HOST_ACP_WORKER=1",
            "COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY=rolling-v1",
            "COCALC_PROJECT_HOST_ACP_WORKER_STARTED_AT=1000",
            `COCALC_ACP_INSTANCE_ID=worker-${pid}`,
            "PROJECT_HOST_ID=host-1",
          ].join("\0");
        }
        if (String(filename).endsWith("/cmdline")) {
          return [process.execPath, entryPoint].join("\0");
        }
        throw new Error(`Unexpected read: ${filename}`);
      });
      jest.spyOn(fs, "writeFileSync").mockImplementation(() => {});
      jest.spyOn(fs, "rmSync").mockImplementation(() => {});
      const kill = jest
        .spyOn(process, "kill")
        .mockImplementation((pid, signal) => {
          if (signal !== 0) throw new Error("Unexpected worker termination");
          if (pid === candidatePid && !candidateAlive) throw new Error("ESRCH");
          return true;
        });
      const requestDrain = jest.fn(async () => ({ state: "draining" }));
      let candidateStatusReads = 0;
      jest.mocked(acpDaemonControlClient).mockImplementation(
        ({ worker_id }) =>
          ({
            health: async () => {
              if (worker_id === `worker-${candidatePid}`) {
                candidateStatusReads += 1;
                if (
                  exitDuring === "status refresh" &&
                  candidateStatusReads === 2
                ) {
                  candidateAlive = false;
                }
              }
              return {
                worker_id,
                state: "active",
                started_at: 1_000,
                last_queue_progress_at:
                  worker_id === `worker-${healthyPid}` ? 199_000 : 10_000,
                running_turn_leases: 0,
              };
            },
            requestDrain,
          }) as any,
      );
      mockOldestClaimableQueuedAcpJobTimestamp.mockReturnValue(10_000);

      const reconciliation = __test__.reconcileProjectHostAcpWorkers();
      if (exitDuring === "delay") {
        setTimeout(() => {
          candidateAlive = false;
        }, 500);
      }
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(reconciliation).resolves.toBe(healthyPid);
      expect(requestDrain).not.toHaveBeenCalled();
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    },
  );
});

describe("stale ACP worker row cleanup", () => {
  it("selects only stale rows without a matching observed worker process", () => {
    const rows = [
      {
        worker_id: "live-worker",
        pid: 1001,
        state: "active",
        started_at: 1_000,
        last_heartbeat_at: 95_000,
      },
      {
        worker_id: "dead-worker",
        pid: 1002,
        state: "active",
        started_at: 1_000,
        last_heartbeat_at: 10_000,
      },
      {
        worker_id: "recent-worker",
        pid: 1003,
        state: "active",
        started_at: 1_000,
        last_heartbeat_at: 98_000,
      },
      {
        worker_id: "same-pid-different-worker",
        pid: 1001,
        state: "active",
        started_at: 1_000,
        last_heartbeat_at: 10_000,
      },
      {
        worker_id: "already-stopped",
        pid: 1004,
        state: "stopped",
        started_at: 1_000,
        last_heartbeat_at: 10_000,
      },
    ] as any[];

    expect(
      __test__
        .staleAcpWorkerRowsToStop({
          rows,
          observedWorkers: [
            {
              pid: 1001,
              env: {
                COCALC_ACP_INSTANCE_ID: "live-worker",
              },
              cmdline: ["project-host:acp-worker"],
            },
          ] as any[],
          now: 100_000,
          staleMs: 15_000,
        })
        .map((row) => row.worker_id),
    ).toEqual(["dead-worker", "same-pid-different-worker"]);
  });
});

describe("overdue draining ACP workers", () => {
  const worker = {
    pid: 2001,
    env: {
      COCALC_ACP_INSTANCE_ID: "worker-draining",
    },
    cmdline: ["project-host:acp-worker"],
  };

  it("does not terminate before the parent drain deadline", () => {
    expect(
      shouldTerminateOverdueDrainingWorker({
        worker: worker as any,
        status: {
          state: "draining",
          exit_requested_at: 10_000,
          last_seen_running_jobs: 0,
          running_turn_leases: 0,
        } as any,
        now: 69_999,
        drainTerminateMs: 60_000,
      }),
    ).toBe(false);
  });

  it("terminates after the deadline when the worker owns no live work", () => {
    expect(
      shouldTerminateOverdueDrainingWorker({
        worker: worker as any,
        status: {
          state: "draining",
          exit_requested_at: 10_000,
          last_seen_running_jobs: 0,
          running_turn_leases: 0,
        } as any,
        now: 70_000,
        drainTerminateMs: 60_000,
      }),
    ).toBe(true);
  });

  it("uses database state when the worker control RPC is unavailable", () => {
    expect(
      shouldTerminateOverdueDrainingWorker({
        worker: worker as any,
        row: {
          state: "draining",
          exit_requested_at: 10_000,
          last_seen_running_jobs: 0,
        } as any,
        now: 70_000,
        drainTerminateMs: 60_000,
      }),
    ).toBe(true);
  });

  it("does not terminate a worker that still has running jobs", () => {
    expect(
      shouldTerminateOverdueDrainingWorker({
        worker: worker as any,
        status: {
          state: "draining",
          exit_requested_at: 10_000,
          last_seen_running_jobs: 1,
          running_turn_leases: 0,
        } as any,
        now: 70_000,
        drainTerminateMs: 60_000,
      }),
    ).toBe(false);
  });

  it("does not terminate a worker that still owns a running turn lease", () => {
    mockCountRunningAcpTurnLeasesForWorker.mockReturnValue(1);

    expect(
      shouldTerminateOverdueDrainingWorker({
        worker: worker as any,
        status: {
          state: "draining",
          exit_requested_at: 10_000,
          last_seen_running_jobs: 0,
          running_turn_leases: 0,
        } as any,
        now: 70_000,
        drainTerminateMs: 60_000,
      }),
    ).toBe(false);
  });

  it("does not terminate a worker that owns a background terminal", () => {
    expect(
      shouldTerminateOverdueDrainingWorker({
        worker: worker as any,
        status: {
          state: "draining",
          exit_requested_at: 10_000,
          last_seen_running_jobs: 0,
          running_turn_leases: 0,
          background_terminal_processes: 1,
        } as any,
        now: 70_000,
        drainTerminateMs: 60_000,
      }),
    ).toBe(false);
  });
});
