import { classifyProjectHostAcpWorkers } from "./hub/acp/worker-manager";

describe("classifyProjectHostAcpWorkers", () => {
  it("keeps only the newest worker from the current bundle", () => {
    const launch = {
      command: "/usr/bin/node",
      args: ["/opt/cocalc/project-host/bundles/current/main/index.js"],
      nodeLike: true,
      resolvedCommand: "/usr/bin/node",
      resolvedEntryPoint:
        "/opt/cocalc/project-host/bundles/current/main/index.js",
    };
    const workers = [
      {
        pid: 101,
        env: { COCALC_PROJECT_HOST_ACP_WORKER: "1" },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/old/main/index.js",
        ],
      },
      {
        pid: 102,
        env: { COCALC_PROJECT_HOST_ACP_WORKER: "1" },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/current/main/index.js",
        ],
      },
      {
        pid: 103,
        env: { COCALC_PROJECT_HOST_ACP_WORKER: "1" },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/current/main/index.js",
        ],
      },
    ];

    expect(
      classifyProjectHostAcpWorkers({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      keepPid: 103,
      stalePids: [101, 102],
    });
  });

  it("marks all ACP workers stale when none match the current launch", () => {
    const launch = {
      command: "/usr/bin/node",
      args: ["/opt/cocalc/project-host/bundles/current/main/index.js"],
      nodeLike: true,
      resolvedCommand: "/usr/bin/node",
      resolvedEntryPoint:
        "/opt/cocalc/project-host/bundles/current/main/index.js",
    };
    const workers = [
      {
        pid: 201,
        env: { COCALC_PROJECT_HOST_ACP_WORKER: "1" },
        cmdline: [
          "/usr/bin/node",
          "/opt/cocalc/project-host/bundles/old/main/index.js",
        ],
      },
    ];

    expect(
      classifyProjectHostAcpWorkers({
        workers: workers as any,
        launch: launch as any,
      }),
    ).toEqual({
      keepPid: undefined,
      stalePids: [201],
    });
  });
});
