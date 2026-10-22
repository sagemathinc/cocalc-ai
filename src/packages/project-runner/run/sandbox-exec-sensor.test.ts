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
