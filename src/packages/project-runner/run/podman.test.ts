const mockPodman = jest.fn();
const mockExecuteCode = jest.fn();
const mockGetConmonContainerProcesses = jest.fn();
const mockGetConmonContainerProcessLists = jest.fn();
const mockUnmountAll = jest.fn();
const mockFileServerClient = jest.fn();
let processKillSpy: jest.SpyInstance;

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: factory,
    getLogger: factory,
  };
});

jest.mock("@cocalc/backend/podman", () => ({
  mountArg: jest.fn(() => ""),
  podman: (...args: any[]) => mockPodman(...args),
}));

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (...args: any[]) => mockExecuteCode(...args),
}));

jest.mock(
  "@cocalc/backend/podman/conmon",
  () => ({
    getConmonContainerProcesses: (...args: any[]) =>
      mockGetConmonContainerProcesses(...args),
    getConmonContainerProcessLists: (...args: any[]) =>
      mockGetConmonContainerProcessLists(...args),
  }),
  { virtual: true },
);

jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: jest.fn(() => ({})),
}));

jest.mock("@cocalc/backend/get-port", () => ({
  __esModule: true,
  default: jest.fn(async () => 12345),
}));

jest.mock("./mounts", () => ({
  COCALC_LIB: "/lib",
  COCALC_RUNTIME_LIB: "/runtime-lib",
  DEFAULT_PROJECT_TOOLS: "/tools",
  PROJECT_BUNDLE_MOUNT_POINT: "/bundle",
  PROJECT_BUNDLES_MOUNT_POINT: "/bundles",
  projectBundleBinPathPrefix: jest.fn(() => "/bundle/bin"),
  nodePath: "/usr/bin/node",
  getCoCalcMounts: jest.fn(() => ({})),
  COCALC_SRC: "/tmp/cocalc-src",
}));

jest.mock("./util", () => ({
  ensureConfFilesExists: jest.fn(),
  setupDataPath: jest.fn(),
  writeSecretToken: jest.fn(),
}));

jest.mock("./env", () => ({
  DEFAULT_PROJECT_PROXY_PORT: "9000",
  getEnvironment: jest.fn(() => ({})),
}));

jest.mock("./filesystem", () => ({
  fileServerClient: (...args: any[]) => mockFileServerClient(...args),
  setQuota: jest.fn(),
}));

jest.mock("./rootfs", () => ({
  mount: jest.fn(),
  unmountAll: (...args: any[]) => mockUnmountAll(...args),
}));

jest.mock("./limits", () => ({
  podmanLimits: jest.fn(async () => []),
}));

jest.mock("./startup-scripts", () => ({
  writeStartupScripts: jest.fn(),
}));

jest.mock("./conat-client", () => ({
  getConatClient: jest.fn(),
}));

import getPort from "@cocalc/backend/get-port";
import { mountArg } from "@cocalc/backend/podman";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  cleanupProjectSecretsHostPath,
  cleanupStaleProjectContainers,
  cleanupStaleProjectSecretsHostPaths,
  getAll,
  projectSecretsHostPath,
  PROJECT_SECRETS_HOST_ROOT,
  redactConfigurationForLog,
  start,
  state,
  stop,
  writeProjectSecretsHostPath,
} from "./podman";

function mockProjectStartPodman(project_id: string) {
  const name = `project-${project_id}`;
  mockPodman.mockImplementation(async (args: string[]) => {
    if (
      args[0] === "ps" &&
      args.includes(`name=${name}`) &&
      args.includes("{{.Names}} {{.State}}")
    ) {
      return { stdout: `${name} running\n` };
    }
    return { stdout: "" };
  });
}

describe("project-runner podman orphan fallback", () => {
  const project1 = "11111111-1111-4111-8111-111111111111";
  const project2 = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.clearAllMocks();
    mockUnmountAll.mockResolvedValue(undefined);
    mockExecuteCode.mockResolvedValue({ stdout: "" });
    mockGetConmonContainerProcessLists.mockResolvedValue(new Map());
    mockFileServerClient.mockReturnValue({
      beginRestoreStaging: jest.fn(async () => null),
    });
    delete process.env.COCALC_SHARED_SCRATCH_ENABLED;
    delete process.env.COCALC_SHARED_SCRATCH_HOST_MOUNT;
    delete process.env.COCALC_SHARED_SCRATCH_PROJECT_MOUNT;
    processKillSpy = jest.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    processKillSpy.mockRestore();
  });

  it("treats a project as running when podman misses it but conmon sees it", async () => {
    mockPodman.mockResolvedValue({ stdout: "" });
    mockGetConmonContainerProcesses.mockResolvedValue(
      new Map([
        [
          `project-${project1}`,
          {
            name: `project-${project1}`,
            project_id: project1,
            conmon_pid: 100,
            child_pids: [101],
          },
        ],
      ]),
    );

    await expect(state(project1)).resolves.toBe("running");
  });

  it("includes conmon-only projects in getAll", async () => {
    mockPodman.mockResolvedValue({ stdout: `${project1}\n` });
    mockGetConmonContainerProcesses.mockResolvedValue(
      new Map([
        [
          `project-${project2}`,
          {
            name: `project-${project2}`,
            project_id: project2,
            conmon_pid: 200,
            child_pids: [201],
          },
        ],
      ]),
    );

    await expect(getAll()).resolves.toEqual([project1, project2]);
  });

  it("force-kills an orphaned live project when podman metadata is missing", async () => {
    mockPodman
      .mockRejectedValueOnce(new Error("no such container"))
      .mockRejectedValueOnce(new Error("no such container"));
    mockGetConmonContainerProcesses.mockResolvedValue(
      new Map([
        [
          `project-${project1}`,
          {
            name: `project-${project1}`,
            project_id: project1,
            conmon_pid: 300,
            child_pids: [301],
          },
        ],
      ]),
    );
    mockGetConmonContainerProcessLists.mockResolvedValue(
      new Map([
        [
          `project-${project1}`,
          [
            {
              name: `project-${project1}`,
              project_id: project1,
              conmon_pid: 300,
              child_pids: [301],
            },
          ],
        ],
      ]),
    );

    await stop({ project_id: project1 });

    expect(mockExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "podman",
        args: [
          "inspect",
          "--format",
          "{{.State.Pid}} {{.State.ConmonPid}}",
          `project-${project1}`,
        ],
      }),
    );
    expect(mockUnmountAll).toHaveBeenCalledWith(project1);
  });

  it("force-kills a live project when podman rm reports success but conmon is still alive", async () => {
    mockPodman
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: "" });
    mockGetConmonContainerProcesses
      .mockResolvedValueOnce(
        new Map([
          [
            `project-${project1}`,
            {
              name: `project-${project1}`,
              project_id: project1,
              conmon_pid: 400,
              child_pids: [401],
            },
          ],
        ]),
      )
      .mockResolvedValueOnce(
        new Map([
          [
            `project-${project1}`,
            {
              name: `project-${project1}`,
              project_id: project1,
              conmon_pid: 400,
              child_pids: [401],
            },
          ],
        ]),
      );
    mockGetConmonContainerProcessLists.mockResolvedValue(
      new Map([
        [
          `project-${project1}`,
          [
            {
              name: `project-${project1}`,
              project_id: project1,
              conmon_pid: 400,
              child_pids: [401],
            },
          ],
        ],
      ]),
    );

    await stop({ project_id: project1 });

    expect(mockPodman).toHaveBeenNthCalledWith(1, [
      "container",
      "exists",
      `project-${project1}`,
    ]);
    expect(mockPodman).toHaveBeenNthCalledWith(
      2,
      ["rm", "-f", "-t", "5", `project-${project1}`],
      { timeout: 10 },
    );
    expect(mockPodman).toHaveBeenNthCalledWith(
      3,
      ["rm", "-f", "-t", "5", `project-${project1}`],
      { timeout: 10 },
    );
    expect(mockExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "podman",
        args: [
          "inspect",
          "--format",
          "{{.State.Pid}} {{.State.ConmonPid}}",
          `project-${project1}`,
        ],
      }),
    );
    expect(mockUnmountAll).toHaveBeenCalledWith(project1);
  });

  it("force-kills a live project when podman rm times out and the retry still leaves conmon alive", async () => {
    mockPodman
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    mockGetConmonContainerProcesses.mockResolvedValue(
      new Map([
        [
          `project-${project1}`,
          {
            name: `project-${project1}`,
            project_id: project1,
            conmon_pid: 500,
            child_pids: [501],
          },
        ],
      ]),
    );
    mockGetConmonContainerProcessLists.mockResolvedValue(
      new Map([
        [
          `project-${project1}`,
          [
            {
              name: `project-${project1}`,
              project_id: project1,
              conmon_pid: 500,
              child_pids: [501],
            },
          ],
        ],
      ]),
    );

    await stop({ project_id: project1 });

    expect(mockPodman).toHaveBeenNthCalledWith(1, [
      "container",
      "exists",
      `project-${project1}`,
    ]);
    expect(mockPodman).toHaveBeenNthCalledWith(
      2,
      ["rm", "-f", "-t", "5", `project-${project1}`],
      { timeout: 10 },
    );
    expect(mockPodman).toHaveBeenNthCalledWith(
      3,
      ["rm", "-f", "-t", "5", `project-${project1}`],
      { timeout: 10 },
    );
    expect(mockPodman).toHaveBeenNthCalledWith(
      4,
      ["rm", "-f", "-t", "5", `project-${project1}`],
      { timeout: 10 },
    );
    expect(processKillSpy).toHaveBeenCalledWith(500, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(-500, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(501, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(-501, "SIGKILL");
    expect(mockUnmountAll).toHaveBeenCalledWith(project1);
  });

  it("force-kills every duplicate main conmon tree for one project", async () => {
    mockPodman
      .mockRejectedValueOnce(new Error("no such container"))
      .mockRejectedValueOnce(new Error("no such container"));
    mockGetConmonContainerProcesses.mockResolvedValue(
      new Map([
        [
          `project-${project1}`,
          {
            name: `project-${project1}`,
            project_id: project1,
            conmon_pid: 701,
            child_pids: [702],
          },
        ],
      ]),
    );
    mockGetConmonContainerProcessLists.mockResolvedValue(
      new Map([
        [
          `project-${project1}`,
          [
            {
              name: `project-${project1}`,
              project_id: project1,
              conmon_pid: 601,
              child_pids: [602],
            },
            {
              name: `project-${project1}`,
              project_id: project1,
              conmon_pid: 701,
              child_pids: [702],
            },
          ],
        ],
      ]),
    );

    await stop({ project_id: project1 });

    expect(processKillSpy).toHaveBeenCalledWith(601, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(-601, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(602, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(-602, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(701, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(-701, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(702, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(-702, "SIGKILL");
    expect(mockExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "podman",
        args: [
          "inspect",
          "--format",
          "{{.State.Pid}} {{.State.ConmonPid}}",
          `project-${project1}`,
        ],
      }),
    );
    expect(mockUnmountAll).toHaveBeenCalledWith(project1);
  });

  it("uses caller-provided host ports when starting a project", async () => {
    mockProjectStartPodman(project1);
    const libatomic = `/tmp/cocalc-test-libatomic-${project1}`;
    const compatLibs = `/tmp/cocalc-test-runtime-libs-${project1}`;
    await writeFile(libatomic, "test-libatomic");
    process.env.COCALC_NODE_RUNTIME_LIBATOMIC = libatomic;
    process.env.COCALC_NODE_RUNTIME_COMPAT_LIBS = compatLibs;

    let status;
    try {
      status = await start({
        project_id: project1,
        localPath: async () => ({
          home: `/tmp/project-${project1}`,
        }),
        config: {
          image: "docker.io/library/ubuntu:latest",
          ssh_port: 30123,
          http_port: 45123,
        },
      });
    } finally {
      delete process.env.COCALC_NODE_RUNTIME_LIBATOMIC;
      delete process.env.COCALC_NODE_RUNTIME_COMPAT_LIBS;
      await rm(libatomic, { force: true }).catch(() => {});
      await rm(compatLibs, { force: true, recursive: true }).catch(() => {});
    }

    expect(getPort).not.toHaveBeenCalled();
    expect(mockPodman).toHaveBeenCalledWith(
      expect.arrayContaining([
        "-p",
        "127.0.0.1:30123:22",
        "-p",
        "127.0.0.1:45123:9000",
        "-e",
        "LD_LIBRARY_PATH=/runtime-lib:/lib",
        "-e",
        expect.stringContaining("COCALC_PROJECT_SSH_START_SCRIPT="),
        "--sshd",
        "--init",
        ".local/share/cocalc/startup.sh",
      ]),
    );
    expect(status).toMatchObject({
      state: "running",
      ssh_port: 30123,
      http_port: 45123,
    });
  });

  it("does not set project quota twice when localPath already applied it", async () => {
    mockProjectStartPodman(project1);
    const { setQuota } = jest.requireMock("./filesystem");

    await start({
      project_id: project1,
      localPath: async () => ({
        home: `/tmp/project-${project1}`,
        quota_applied: true,
      }),
      config: {
        disk: 1024,
        image: "docker.io/library/ubuntu:latest",
        ssh_port: 30123,
        http_port: 45123,
      },
    });

    expect(setQuota).not.toHaveBeenCalled();
  });

  it("resets scratch before launching a fresh project container", async () => {
    mockProjectStartPodman(project1);
    const localPath = jest.fn(async () => ({
      home: `/tmp/project-${project1}`,
      scratch: `/tmp/project-${project1}-scratch`,
      quota_applied: true,
    }));

    await start({
      project_id: project1,
      localPath,
      config: {
        disk: 1024,
        image: "docker.io/library/ubuntu:latest",
        ssh_port: 30123,
        http_port: 45123,
      },
    });

    expect(localPath).toHaveBeenNthCalledWith(1, {
      project_id: project1,
      disk: 1024,
      scratch: undefined,
      ensure: false,
    });
    expect(localPath).toHaveBeenNthCalledWith(2, {
      project_id: project1,
      disk: 1024,
      scratch: undefined,
      ensure: true,
      resetScratch: true,
    });
    expect(mountArg).toHaveBeenCalledWith({
      source: `/tmp/project-${project1}-scratch`,
      target: "/tmp",
    });
  });

  it("does not reset scratch when a live project container is already running", async () => {
    mockGetConmonContainerProcessLists.mockResolvedValue(
      new Map([
        [
          `project-${project1}`,
          [
            {
              name: `project-${project1}`,
              project_id: project1,
              conmon_pid: 400,
              child_pids: [401],
            },
          ],
        ],
      ]),
    );
    mockProjectStartPodman(project1);
    const localPath = jest.fn(async () => ({
      home: `/tmp/project-${project1}`,
      scratch: `/tmp/project-${project1}-scratch`,
      quota_applied: true,
    }));

    await start({
      project_id: project1,
      localPath,
      config: {
        disk: 1024,
        image: "docker.io/library/ubuntu:latest",
        ssh_port: 30123,
        http_port: 45123,
      },
    });

    expect(localPath).toHaveBeenNthCalledWith(2, {
      project_id: project1,
      disk: 1024,
      scratch: undefined,
      ensure: true,
      resetScratch: false,
    });
  });

  it("bind mounts host shared scratch into started project containers", async () => {
    mockProjectStartPodman(project1);
    process.env.COCALC_SHARED_SCRATCH_ENABLED = "1";
    process.env.COCALC_SHARED_SCRATCH_HOST_MOUNT = "/";
    process.env.COCALC_SHARED_SCRATCH_PROJECT_MOUNT = "/scratch";

    await start({
      project_id: project1,
      localPath: async () => ({
        home: `/tmp/project-${project1}`,
      }),
      config: {
        image: "docker.io/library/ubuntu:latest",
        ssh_port: 30123,
        http_port: 45123,
      },
    });

    expect(mountArg).toHaveBeenCalledWith({
      source: "/",
      target: "/scratch",
    });
  });

  it("fails project start when configured shared scratch is not mounted", async () => {
    mockProjectStartPodman(project1);
    process.env.COCALC_SHARED_SCRATCH_ENABLED = "1";
    process.env.COCALC_SHARED_SCRATCH_HOST_MOUNT = `/tmp/missing-scratch-${project1}`;

    await expect(
      start({
        project_id: project1,
        localPath: async () => ({
          home: `/tmp/project-${project1}`,
        }),
        config: {
          image: "docker.io/library/ubuntu:latest",
          ssh_port: 30123,
          http_port: 45123,
        },
      }),
    ).rejects.toThrow(
      "shared scratch is enabled but host mount /tmp/missing-scratch-11111111-1111-4111-8111-111111111111 does not exist",
    );
  });

  it("materializes project secrets as private runtime files", async () => {
    await cleanupProjectSecretsHostPath(project1);

    const path = await writeProjectSecretsHostPath({
      project_id: project1,
      secrets: { API_KEY: "secret" },
    });

    expect(path).toBe(projectSecretsHostPath(project1));
    await expect(readFile(`${path}/API_KEY`, "utf8")).resolves.toBe("secret");
    const info = await stat(`${path}/API_KEY`);
    expect(info.mode & 0o777).toBe(0o400);

    await cleanupProjectSecretsHostPath(project1);
    await expect(stat(`${path}/API_KEY`)).rejects.toThrow();
  });

  it("removes stale project secret runtime directories on startup cleanup", async () => {
    await cleanupProjectSecretsHostPath(project1);
    await cleanupProjectSecretsHostPath(project2);
    await writeProjectSecretsHostPath({
      project_id: project1,
      secrets: { API_KEY: "active" },
    });
    await writeProjectSecretsHostPath({
      project_id: project2,
      secrets: { API_KEY: "stale" },
    });
    await mkdir(`${PROJECT_SECRETS_HOST_ROOT}/.tmp-stale`, {
      recursive: true,
    });
    mockPodman.mockResolvedValueOnce({ stdout: `${project1}\n` });

    await cleanupStaleProjectSecretsHostPaths();

    await expect(
      stat(`${projectSecretsHostPath(project1)}/API_KEY`),
    ).resolves.toBeDefined();
    await expect(stat(projectSecretsHostPath(project2))).rejects.toThrow();
    await expect(
      stat(`${PROJECT_SECRETS_HOST_ROOT}/.tmp-stale`),
    ).rejects.toThrow();
    await cleanupProjectSecretsHostPath(project1);
  });

  it("removes non-running project containers with runtime-only secret mounts on startup cleanup", async () => {
    mockPodman
      .mockResolvedValueOnce({
        stdout: [
          `project-${project1}|created`,
          `project-${project2}|running`,
        ].join("\n"),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            Source: `${PROJECT_SECRETS_HOST_ROOT}/${project1}`,
            Destination: "/run/secrets/cocalc",
          },
        ]),
      })
      .mockResolvedValueOnce(undefined);

    await cleanupStaleProjectContainers();

    expect(mockPodman).toHaveBeenNthCalledWith(1, [
      "ps",
      "-a",
      "--filter",
      "label=role=project",
      "--format",
      "{{.Names}}|{{.State}}",
    ]);
    expect(mockPodman).toHaveBeenNthCalledWith(2, [
      "inspect",
      "--format",
      "{{json .Mounts}}",
      `project-${project1}`,
    ]);
    expect(mockPodman).toHaveBeenNthCalledWith(
      3,
      ["rm", "-f", "-t", "0", `project-${project1}`],
      { timeout: 10 },
    );
  });

  it("does not remove non-running containers without project secret mounts", async () => {
    mockPodman
      .mockResolvedValueOnce({
        stdout: `project-${project1}|exited\n`,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            Source: `/mnt/cocalc/project-${project1}`,
            Destination: "/home/user",
          },
        ]),
      });

    await cleanupStaleProjectContainers();

    expect(mockPodman).toHaveBeenCalledTimes(2);
  });

  it("redacts runtime secrets before logging project start config", () => {
    expect(
      redactConfigurationForLog({
        secret: "project-token",
        secrets: { API_KEY: "secret", SSH_KEY: "private" },
        env: { PUBLIC: "ok" },
      }),
    ).toEqual({
      secret: "[redacted]",
      secrets: { API_KEY: "[redacted]", SSH_KEY: "[redacted]" },
      env: { PUBLIC: "ok" },
    });
  });

  it("falls back to indexed backups when full rustic backup listing is truncated", async () => {
    mockProjectStartPodman(project1);
    const getBackups = jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "rustic snapshots output truncated while listing backups for project-11111111-1111-4111-8111-111111111111",
        ),
      )
      .mockResolvedValueOnce([
        {
          id: "backup-1",
          time: new Date("2026-05-01T00:00:00.000Z"),
          summary: {},
        },
      ]);
    const restoreBackup = jest.fn(async () => undefined);
    mockFileServerClient.mockReturnValue({
      beginRestoreStaging: jest.fn(async () => ({
        project_id: project1,
        home: `/tmp/project-${project1}`,
        restore: "auto",
        homeExists: true,
        stagingRoot: `/tmp/project-${project1}/.restore-staging`,
        stagingPath: `/tmp/project-${project1}/.restore-staging/project-${project1}`,
        markerPath: `/tmp/project-${project1}/.restore-staging/project-${project1}.json`,
      })),
      getBackups,
      ensureRestoreStaging: jest.fn(async () => undefined),
      restoreBackup,
      finalizeRestoreStaging: jest.fn(async () => undefined),
      releaseRestoreStaging: jest.fn(async () => undefined),
    });

    const status = await start({
      project_id: project1,
      localPath: async () => ({
        home: `/tmp/project-${project1}`,
      }),
      config: {
        image: "docker.io/library/ubuntu:latest",
        restore: "auto",
      },
    });

    expect(getBackups).toHaveBeenNthCalledWith(1, { project_id: project1 });
    expect(getBackups).toHaveBeenNthCalledWith(2, {
      project_id: project1,
      indexed_only: true,
    });
    expect(restoreBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: project1,
        id: "backup-1",
      }),
    );
    expect(status).toMatchObject({ state: "running" });
  });

  it("falls back to indexed backups when full rustic backup listing is empty", async () => {
    mockProjectStartPodman(project1);
    const getBackups = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "backup-from-index",
          time: new Date("2026-05-01T00:00:00.000Z"),
          summary: {},
        },
      ]);
    const restoreBackup = jest.fn(async () => undefined);
    mockFileServerClient.mockReturnValue({
      beginRestoreStaging: jest.fn(async () => ({
        project_id: project1,
        home: `/tmp/project-${project1}`,
        restore: "auto",
        homeExists: true,
        stagingRoot: `/tmp/project-${project1}/.restore-staging`,
        stagingPath: `/tmp/project-${project1}/.restore-staging/project-${project1}`,
        markerPath: `/tmp/project-${project1}/.restore-staging/project-${project1}.json`,
      })),
      getBackups,
      ensureRestoreStaging: jest.fn(async () => undefined),
      restoreBackup,
      finalizeRestoreStaging: jest.fn(async () => undefined),
      releaseRestoreStaging: jest.fn(async () => undefined),
    });

    const status = await start({
      project_id: project1,
      localPath: async () => ({
        home: `/tmp/project-${project1}`,
      }),
      config: {
        image: "docker.io/library/ubuntu:latest",
        restore: "auto",
      },
    });

    expect(getBackups).toHaveBeenNthCalledWith(1, { project_id: project1 });
    expect(getBackups).toHaveBeenNthCalledWith(2, {
      project_id: project1,
      indexed_only: true,
    });
    expect(restoreBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: project1,
        id: "backup-from-index",
      }),
    );
    expect(status).toMatchObject({ state: "running" });
  });

  it("restores an explicit backup id without listing backups", async () => {
    mockProjectStartPodman(project1);
    const getBackups = jest.fn();
    const restoreBackup = jest.fn(async () => undefined);
    mockFileServerClient.mockReturnValue({
      beginRestoreStaging: jest.fn(async () => ({
        project_id: project1,
        home: `/tmp/project-${project1}`,
        restore: "required",
        homeExists: true,
        stagingRoot: `/tmp/project-${project1}/.restore-staging`,
        stagingPath: `/tmp/project-${project1}/.restore-staging/project-${project1}`,
        markerPath: `/tmp/project-${project1}/.restore-staging/project-${project1}.json`,
      })),
      getBackups,
      ensureRestoreStaging: jest.fn(async () => undefined),
      restoreBackup,
      finalizeRestoreStaging: jest.fn(async () => undefined),
      releaseRestoreStaging: jest.fn(async () => undefined),
    });

    const status = await start({
      project_id: project1,
      localPath: async () => ({
        home: `/tmp/project-${project1}`,
      }),
      config: {
        image: "docker.io/library/ubuntu:latest",
        restore: "required",
        restore_backup_id: "backup-explicit",
      },
    });

    expect(getBackups).not.toHaveBeenCalled();
    expect(restoreBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: project1,
        id: "backup-explicit",
      }),
    );
    expect(status).toMatchObject({ state: "running" });
  });
});
