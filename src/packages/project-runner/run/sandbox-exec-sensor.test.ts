/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Sensor runs: an explicit argv on a throwaway, read-only overlay of the
// platform's pristine default image, never the project's RootFS or image.

import { sandboxExec } from "./sandbox-exec";

const execFileMock = jest.fn();
const mountRootFsMock = jest.fn();
const disposeMock = jest.fn(async () => {});
const mountSensorRootfsMock = jest.fn(async () => ({
  rootfs: "/mnt/cocalc/data/cache/project-roots/run-overlay",
  dispose: disposeMock,
}));
const readImageMock = jest.fn(async () => "project-chose-this:latest");

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
  localPath: async () => ({ home: "/projects/p/home", scratch: undefined }),
}));
jest.mock("./env", () => ({
  getEnvironment: async () => ({ PATH: "/home/user/bin:/usr/bin" }),
}));
jest.mock("./mounts", () => ({ getCoCalcMounts: () => ({}) }));
jest.mock("./rootfs", () => ({
  getImageNamePath: () => "/projects/p/home/current-image.txt",
  mount: (...args: any[]) => mountRootFsMock(...args),
  mountSensorRootfs: (...args: any[]) =>
    (mountSensorRootfsMock as any)(...args),
  unmount: async () => {},
}));
jest.mock("./podman", () => ({
  getImage: (config?: { image?: string }) => config?.image || "default-image",
  networkArgument: () => "--network=pasta",
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

const RUN = "33333333-3333-4333-8333-333333333333";

describe("sandboxExec for sensors", () => {
  beforeEach(() => {
    execFileMock
      .mockReset()
      .mockImplementation((_c, _a, _o, callback) =>
        callback(undefined, "ok\n", ""),
      );
    mountRootFsMock.mockReset();
    mountSensorRootfsMock.mockClear();
    disposeMock.mockClear();
    readImageMock.mockClear();
  });

  it("runs the argv on a read-only base image overlay without sudo", async () => {
    await sandboxExec({
      project_id: "00000000-0000-4000-8000-000000000001",
      script: "",
      useEphemeral: true,
      argv: ["/usr/bin/env", "-i", "/bin/true"],
      platformImage: { run_id: RUN },
    });
    // The platform's default image, never the project's own choice.
    expect(readImageMock).not.toHaveBeenCalled();
    expect(mountSensorRootfsMock).toHaveBeenCalledWith({
      image: "default-image",
      run_id: RUN,
    });
    expect(mountRootFsMock).not.toHaveBeenCalled();
    const args: string[] = execFileMock.mock.calls[0][1];
    expect(args).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--security-opt=no-new-privileges",
      ]),
    );
    const rootfs = args.indexOf("--rootfs");
    expect(args[rootfs + 1]).toBe(
      "/mnt/cocalc/data/cache/project-roots/run-overlay",
    );
    expect(args.slice(-3)).toEqual(["/usr/bin/env", "-i", "/bin/true"]);
    expect(args).not.toContain("-lc");
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("removes the overlay even when the run fails", async () => {
    execFileMock.mockImplementation((_c, _a, _o, callback) =>
      callback(Object.assign(new Error("boom"), { code: 1 }), "", "boom"),
    );
    await sandboxExec({
      project_id: "00000000-0000-4000-8000-000000000001",
      script: "",
      useEphemeral: true,
      argv: ["/bin/false"],
      platformImage: { run_id: RUN },
    });
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a platform image run without an explicit argv", async () => {
    await expect(
      sandboxExec({
        project_id: "00000000-0000-4000-8000-000000000001",
        script: "true",
        useEphemeral: true,
        platformImage: { run_id: RUN },
      }),
    ).rejects.toThrow(/argv/);
  });
});
