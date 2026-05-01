const mockPodman = jest.fn();
const mockExecuteCode = jest.fn();
const mockGetConmonContainerProcesses = jest.fn();
const mockGetConmonContainerProcessLists = jest.fn();
const mockUnmountAll = jest.fn();

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
  fileServerClient: {},
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

import { getAll, state, stop } from "./podman";

describe("project-runner podman orphan fallback", () => {
  const project1 = "11111111-1111-4111-8111-111111111111";
  const project2 = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.clearAllMocks();
    mockUnmountAll.mockResolvedValue(undefined);
    mockExecuteCode.mockResolvedValue({ stdout: "" });
    mockGetConmonContainerProcessLists.mockResolvedValue(new Map());
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
});
