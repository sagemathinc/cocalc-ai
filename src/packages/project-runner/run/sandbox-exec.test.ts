/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { sandboxExec } from "./sandbox-exec";

const execFileMock = jest.fn();
const podmanEnvMock = jest.fn(() => ({
  PATH: "/usr/bin",
  XDG_RUNTIME_DIR: "/mnt/cocalc/data/tmp/cocalc-podman-runtime-2000",
  CONTAINERS_CGROUP_MANAGER: "cgroupfs",
}));

jest.mock("node:child_process", () => ({
  ...jest.requireActual("node:child_process"),
  execFile: (...args: any[]) => execFileMock(...args),
}));

jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: () => podmanEnvMock(),
}));

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

describe("sandboxExec", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    podmanEnvMock.mockClear();
  });

  it("uses the shared Podman runtime environment for container exec", async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(undefined, "marker\n", "");
    });

    await expect(
      sandboxExec({
        project_id: "00000000-0000-4000-8000-000000000001",
        script: "printf marker",
      }),
    ).resolves.toEqual({
      stdout: "marker\n",
      stderr: "",
      code: 0,
    });

    expect(podmanEnvMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([
        "cocalc-project-podman",
        "exec",
        "project-00000000-0000-4000-8000-000000000001",
      ]),
      expect.objectContaining({
        cwd: "/",
        env: {
          PATH: "/usr/bin",
          XDG_RUNTIME_DIR: "/mnt/cocalc/data/tmp/cocalc-podman-runtime-2000",
          CONTAINERS_CGROUP_MANAGER: "cgroupfs",
        },
      }),
      expect.any(Function),
    );
  });
});
