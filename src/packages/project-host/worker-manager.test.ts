import { planProjectHostAcpWorkerRollout } from "./hub/acp/worker-manager";

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
});
