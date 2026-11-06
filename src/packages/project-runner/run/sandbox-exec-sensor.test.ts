/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Sensor runs: an ephemeral container in the project's own software, with the
// run's credentials mounted read-only, other turns' credentials hidden, and
// no privilege escalation.

import { sandboxExec } from "./sandbox-exec";

const execFileMock = jest.fn();
const mountRootFsMock = jest.fn(async () => "/roots/project");
const readImageMock = jest.fn(async () => "image-file-in-home:latest");
const KEEP_ID = {
  mode: "keep-id",
  usernsArgs: ["--userns=keep-id:uid=2001,gid=2001"],
  status: { configured: "keep-id", effective: "keep-id" },
};
const sidecarRuntimeMock = jest.fn(
  async (..._args: any[]): Promise<any> => KEEP_ID,
);
const acquireSeparateMock = jest.fn();
const releaseMock = jest.fn(async () => {});

jest.mock("node:child_process", () => ({
  ...jest.requireActual("node:child_process"),
  execFile: (...args: any[]) => execFileMock(...args),
}));
jest.mock("fs/promises", () => ({
  ...jest.requireActual("fs/promises"),
  readFile: (...args: any[]) => (readImageMock as any)(...args),
}));
jest.mock("@cocalc/backend/podman/env", () => ({ podmanEnv: () => ({}) }));
jest.mock("./filesystem", () => ({
  localPath: async () => ({ home: "/projects/p/home", scratch: "/scratch/p" }),
}));
jest.mock("./env", () => ({
  getEnvironment: async () => ({
    PATH: "/home/user/bin:/usr/bin",
    CONAT_SERVER: "http://host.containers.internal:9102",
  }),
}));
jest.mock("./mounts", () => ({ getCoCalcMounts: () => ({}) }));
jest.mock("./rootfs", () => ({
  acquireSeparateRuntime: (...args: any[]) => acquireSeparateMock(...args),
  getImageNamePath: () => "/projects/p/home/current-image.txt",
  mount: (...args: any[]) => (mountRootFsMock as any)(...args),
  unmount: async () => {},
}));
jest.mock("./podman", () => ({
  getImage: (config?: { image?: string }) => config?.image || "default-image",
  networkArgument: () => "--network=pasta",
  containerConatHostArgs: async (_net: string, env: any) => {
    env.CONAT_SERVER = "http://169.254.1.2:9102";
    return ["--add-host", "host.containers.internal:169.254.1.2"];
  },
  podmanRuntimeArgs: async () => [],
  projectPoolPodmanLauncher: () => undefined,
  sidecarRuntimeFor: (...args: any[]) => sidecarRuntimeMock(...args),
}));
jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return { __esModule: true, default: factory, getLogger: factory };
});

const PROJECT = "00000000-0000-4000-8000-000000000001";

describe("sandboxExec for sensors", () => {
  beforeEach(() => {
    execFileMock
      .mockReset()
      .mockImplementation((_c, _a, _o, callback) =>
        callback(undefined, "ok\n", ""),
      );
    mountRootFsMock.mockClear();
    readImageMock.mockClear();
  });

  it("runs in the trusted image, with the run's mounts and nothing else", async () => {
    await sandboxExec({
      project_id: PROJECT,
      script: "",
      useEphemeral: true,
      argv: ["/bin/bash", "-lc", "true"],
      image: "hub-record-image:1",
      extraMounts: [
        { source: "/host/run", target: "/run/cocalc-sensor", readOnly: true },
      ],
      tmpfs: ["/tmp", "/home/user/.local/share/cocalc/runtime"],
      noNewPrivileges: true,
      pathPrefix: ["/run/cocalc-sensor/cli/bin"],
    });
    // The hub's image, not the file in the project's home; the project's
    // own RootFS changes still apply (it is the project's software).
    expect(readImageMock).not.toHaveBeenCalled();
    expect(mountRootFsMock).toHaveBeenCalledWith(
      expect.objectContaining({ config: { image: "hub-record-image:1" } }),
    );
    const args: string[] = execFileMock.mock.calls[0][1];
    const joined = args.join(" ");
    expect(args).toEqual(
      expect.arrayContaining([
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp",
        "/home/user/.local/share/cocalc/runtime",
        "PATH=/run/cocalc-sensor/cli/bin:/home/user/bin:/usr/bin",
        // The project's API relay on the host is reachable, as in the
        // project container.
        "--add-host",
        "host.containers.internal:169.254.1.2",
        "CONAT_SERVER=http://169.254.1.2:9102",
      ]),
    );
    // Scratch is not mounted over the in-memory /tmp.
    expect(joined).not.toContain("/scratch/p");
    expect(joined).toContain("/host/run");
    expect(joined).toMatch(/\/run\/cocalc-sensor[^ ]*ro/);
    expect(args.slice(-3)).toEqual(["/bin/bash", "-lc", "true"]);
  });

  it("refuses these options outside an ephemeral run, and bad tmpfs paths", async () => {
    await expect(
      sandboxExec({ project_id: PROJECT, script: "true", image: "x" }),
    ).rejects.toThrow(/ephemeral/);
    await expect(
      sandboxExec({
        project_id: PROJECT,
        script: "",
        useEphemeral: true,
        argv: ["/bin/true"],
        tmpfs: ["/tmp,uid=0"],
      }),
    ).rejects.toThrow(/tmpfs/);
  });

  it("names each run's container uniquely, even in the same millisecond", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1792637287987);
    try {
      const run = () =>
        sandboxExec({
          project_id: PROJECT,
          script: "",
          useEphemeral: true,
          argv: ["/bin/true"],
        });
      await Promise.all([run(), run(), run()]);
    } finally {
      now.mockRestore();
    }
    const names = execFileMock.mock.calls.map((call) => {
      const args = call[1] as string[];
      return args[args.indexOf("--name") + 1];
    });
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    for (const name of names)
      expect(name).toMatch(
        new RegExp(`^sandbox-${PROJECT}-1792637287987-[0-9a-f]{8}$`),
      );
  });

  it("removes a run's container when the run is killed at its deadline", async () => {
    execFileMock.mockImplementation((_c, args, _o, callback) => {
      if ((args as string[])[0] === "rm") callback(undefined, "", "");
      else callback({ killed: true, signal: "SIGKILL", code: null }, "", "");
    });
    const result = await sandboxExec({
      project_id: PROJECT,
      script: "",
      useEphemeral: true,
      argv: ["/bin/sleep", "1000"],
      timeoutMs: 10,
    });
    expect(result.signal).toBe("SIGKILL");
    const [run, rm] = execFileMock.mock.calls;
    const runArgs = run[1] as string[];
    const name = runArgs[runArgs.indexOf("--name") + 1];
    expect(rm[0]).toBe("podman");
    expect(rm[1]).toEqual(["rm", "--force", "--time", "0", name]);
  });

  it("removes a run's container when it is killed for printing too much", async () => {
    execFileMock.mockImplementation((_c, args, _o, callback) => {
      if ((args as string[])[0] === "rm") callback(undefined, "", "");
      // What execFile reports when maxBuffer is exceeded: no signal.
      else
        callback(
          Object.assign(new Error("stdout maxBuffer length exceeded"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
          "x".repeat(1024),
          "",
        );
    });
    await sandboxExec({
      project_id: PROJECT,
      script: "",
      useEphemeral: true,
      argv: ["/usr/bin/yes"],
      maxOutputBytes: 1024,
    });
    const [run, rm] = execFileMock.mock.calls;
    const runArgs = run[1] as string[];
    expect(rm?.[1]).toEqual([
      "rm",
      "--force",
      "--time",
      "0",
      runArgs[runArgs.indexOf("--name") + 1],
    ]);
  });

  it("leaves a run that ended by itself to --rm", async () => {
    await sandboxExec({
      project_id: PROJECT,
      script: "",
      useEphemeral: true,
      argv: ["/bin/true"],
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("sandboxExec for a project with a separate runtime uid", () => {
  const P = 1073741824;
  const SEPARATE = {
    mode: "separate",
    uid: P,
    gid: P,
    usernsArgs: ["--uidmap=0:1:2001", "--uidmap=2001:4194305:1"],
    status: { configured: "separate", effective: "separate" },
  };
  const VIEWS = {
    home: `/run/cocalc/project-views/${PROJECT}/home`,
    scratch: `/run/cocalc/project-views/${PROJECT}/scratch`,
  };
  const ROOTFS = `/run/cocalc/project-rootfs/${PROJECT}/root`;
  const reserveMock = jest.fn(async (_name: string) => {});
  const markLaunchedMock = jest.fn(async () => {});
  const orphanMock = jest.fn(async () => {});

  // podman as the separate path sees it: `container exists` answers exit 1
  // (absent) once the container was removed
  const fakePodman = ({
    startFails = false,
    rmFails = false,
    stillThere = false,
    onCreate,
  }: {
    startFails?: boolean;
    rmFails?: boolean;
    stillThere?: boolean;
    onCreate?: () => void;
  } = {}) =>
    execFileMock.mockImplementation((_c, args: string[], _o, callback) => {
      const fail = (code: number) =>
        callback(Object.assign(new Error(`exit ${code}`), { code }), "", "");
      if (args.includes("create")) onCreate?.();
      if (args.includes("start") && startFails) return fail(125);
      if (args.includes("rm") && rmFails) return fail(125);
      if (args.includes("exists"))
        return stillThere ? callback(undefined, "", "") : fail(1);
      return callback(undefined, "ok\n", "");
    });
  const verbs = () =>
    execFileMock.mock.calls.map(([, args]) =>
      (args as string[]).find((a) =>
        ["create", "start", "rm", "exists", "run"].includes(a),
      ),
    );

  beforeEach(() => {
    execFileMock.mockReset();
    fakePodman();
    mountRootFsMock.mockClear();
    releaseMock.mockReset();
    releaseMock.mockResolvedValue(undefined);
    sidecarRuntimeMock.mockReset();
    sidecarRuntimeMock.mockResolvedValue(SEPARATE);
    reserveMock.mockReset();
    reserveMock.mockResolvedValue(undefined);
    markLaunchedMock.mockReset();
    markLaunchedMock.mockResolvedValue(undefined);
    orphanMock.mockReset();
    orphanMock.mockResolvedValue(undefined);
    acquireSeparateMock.mockReset();
    acquireSeparateMock.mockResolvedValue({
      rootfs: ROOTFS,
      views: VIEWS,
      mountViews: async () => {},
      reserve: reserveMock,
      markLaunched: markLaunchedMock,
      orphan: orphanMock,
      release: releaseMock,
    });
  });

  afterAll(() => {
    sidecarRuntimeMock.mockReset();
    sidecarRuntimeMock.mockResolvedValue(KEEP_ID);
  });

  const run = async () =>
    await sandboxExec({
      project_id: PROJECT,
      script: "",
      useEphemeral: true,
      argv: ["/bin/bash", "-lc", "true"],
    });

  it("runs as the project user's separate uid, on its views and idmapped rootfs, as its own holder", async () => {
    await run();
    expect(acquireSeparateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: PROJECT,
        idmapUid: P,
        kinds: ["home", "scratch"],
        holder: "sandbox",
      }),
    );
    expect(mountRootFsMock).not.toHaveBeenCalled();
    const args: string[] = execFileMock.mock.calls[0][1];
    const joined = args.join(" ");
    expect(args).toEqual(expect.arrayContaining(SEPARATE.usernsArgs));
    expect(joined).not.toContain("--userns=keep-id");
    expect(joined).toContain(VIEWS.home);
    expect(joined).toContain(VIEWS.scratch);
    // no raw project dir reaches the container
    expect(joined).not.toContain("/projects/p/home");
    expect(joined).not.toContain("/scratch/p");
    expect(args[args.indexOf("--rootfs") + 1]).toBe(ROOTFS);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("reserves, creates, marks launched, then starts its container (C1)", async () => {
    await run();
    const calls = execFileMock.mock.calls.map(([, args]) => args as string[]);
    // then removed and proven gone, before the release
    expect(verbs()).toEqual(["create", "start", "rm", "exists"]);
    expect(execFileMock.mock.invocationCallOrder[3]).toBeLessThan(
      releaseMock.mock.invocationCallOrder[0],
    );
    expect(calls[0]).toContain("create");
    expect(calls[0]).not.toContain("run");
    const name = calls[0][calls[0].indexOf("--name") + 1];
    expect(name).toContain(PROJECT);
    expect(calls[1].slice(-4)).toEqual([
      "start",
      "--attach",
      "--interactive",
      name,
    ]);
    expect(reserveMock).toHaveBeenCalledWith(name);
    const order = [
      reserveMock.mock.invocationCallOrder[0],
      execFileMock.mock.invocationCallOrder[0],
      markLaunchedMock.mock.invocationCallOrder[0],
      execFileMock.mock.invocationCallOrder[1],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("never runs a streaming command ephemerally: no holder, nothing created", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      sandboxExec({
        project_id: PROJECT,
        script: "true",
        useEphemeral: true,
        signal: abort.signal,
        onOutput: () => {},
      } as any),
    ).rejects.toThrow(
      "Managed commands require the existing project container",
    );
    expect(acquireSeparateMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("creates nothing when reserving is refused (C1)", async () => {
    reserveMock.mockRejectedValueOnce(
      new Error("the project is being stopped; not launching"),
    );
    await expect(run()).rejects.toThrow("being stopped");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("starts nothing, and removes what it created, when marking it launched is refused (C1)", async () => {
    markLaunchedMock.mockRejectedValueOnce(
      new Error("this holder of the project's runtime was released"),
    );
    await expect(run()).rejects.toThrow("was released");
    expect(verbs()).toEqual(["create", "rm", "exists"]);
    expect(execFileMock.mock.invocationCallOrder[2]).toBeLessThan(
      releaseMock.mock.invocationCallOrder[0],
    );
  });

  it("removes its container before the release when the start fails (C1)", async () => {
    fakePodman({ startFails: true });
    await run();
    expect(verbs()).toEqual(["create", "start", "rm", "exists"]);
    expect(execFileMock.mock.invocationCallOrder[3]).toBeLessThan(
      releaseMock.mock.invocationCallOrder[0],
    );
  });

  it("removes its container before the release when aborted between create and start (C1)", async () => {
    const abort = new AbortController();
    fakePodman({ onCreate: () => abort.abort() });
    await sandboxExec({
      project_id: PROJECT,
      script: "true",
      useEphemeral: true,
      signal: abort.signal,
    }).catch(() => {});
    expect(verbs()).toEqual(["create", "start", "rm", "exists"]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      releaseMock.mock.invocationCallOrder[0],
    );
  });

  it("orphans the kept holder when a refused mark's container can't be removed (K1)", async () => {
    markLaunchedMock.mockRejectedValueOnce(
      new Error("the project is being stopped; not launching"),
    );
    fakePodman({ rmFails: true });
    await expect(run()).rejects.toThrow(
      "could not remove this run's container",
    );
    expect(orphanMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("removes what a failed create may have left before the release (C1)", async () => {
    execFileMock.mockImplementation((_c, args: string[], _o, callback) =>
      args.includes("create")
        ? callback(Object.assign(new Error("exit 125"), { code: 125 }), "", "")
        : args.includes("exists")
          ? callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "")
          : callback(undefined, "", ""),
    );
    await expect(run()).rejects.toThrow("could not create");
    expect(verbs()).toEqual(["create", "rm", "exists"]);
    expect(markLaunchedMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["its removal fails", { rmFails: true }],
    ["it is still there after removal", { stillThere: true }],
  ])(
    "keeps the holder (no release, no detach) when %s (C1)",
    async (_why, opts) => {
      fakePodman(opts);
      await expect(run()).rejects.toThrow(
        "could not remove this run's container",
      );
      expect(releaseMock).not.toHaveBeenCalled();
      // kept, but droppable by a later stop's proof (K1)
      expect(orphanMock).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses, never the raw dir, when its handle lacks a view", async () => {
    acquireSeparateMock.mockResolvedValue({
      rootfs: ROOTFS,
      views: { scratch: VIEWS.scratch },
      mountViews: async () => {},
      reserve: reserveMock,
      markLaunched: markLaunchedMock,
      orphan: orphanMock,
      release: releaseMock,
    });
    await expect(run()).rejects.toThrow("no home view for this run");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("releases its holder after a failed run too", async () => {
    // the command exits 1; its container is removed
    execFileMock.mockImplementation((_c, args: string[], _o, callback) =>
      args.includes("start") || args.includes("exists")
        ? callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "boom")
        : callback(undefined, "", ""),
    );
    await run().catch(() => {});
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("lets a failed release reach the caller (L1)", async () => {
    releaseMock.mockRejectedValueOnce(
      new Error("could not unmount this project's RootFS"),
    );
    await expect(run()).rejects.toThrow("could not unmount");
  });

  it("stays on keep-id while the project runs keep-id", async () => {
    sidecarRuntimeMock.mockResolvedValue(KEEP_ID);
    await run();
    expect(acquireSeparateMock).not.toHaveBeenCalled();
    expect(mountRootFsMock).toHaveBeenCalled();
    const joined = execFileMock.mock.calls[0][1].join(" ");
    expect(joined).toContain("--userns=keep-id");
  });
});
