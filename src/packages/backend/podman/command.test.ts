import podman from "./command";

const executeCodeMock = jest.fn();
const podmanEnvMock = jest.fn(() => ({
  XDG_RUNTIME_DIR: "/tmp/podman-test-runtime",
  CONTAINERS_CGROUP_MANAGER: "cgroupfs",
}));

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (...args: any[]) => executeCodeMock(...args),
}));

jest.mock("./env", () => ({
  podmanEnv: () => podmanEnvMock(),
}));

jest.mock("@cocalc/backend/logger", () => () => ({
  debug: jest.fn(),
  warn: jest.fn(),
}));

const stalePodmanStderr = [
  'time="2026-04-08T15:48:28Z" level=warning msg="The cgroupv2 manager is set to systemd but there is no systemd user session available"',
  'time="2026-04-08T15:48:28Z" level=warning msg="For using systemd, you may need to log in using a user session"',
  'time="2026-04-08T15:48:28Z" level=warning msg="Alternatively, you can enable lingering with: `loginctl enable-linger 1002` (possibly as root)"',
  'time="2026-04-08T15:48:28Z" level=warning msg="Falling back to --cgroup-manager=cgroupfs"',
  'time="2026-04-08T15:48:28Z" level=error msg="invalid internal status, try resetting the pause process with "podman system migrate": could not find any running process: no such process"',
].join("\n");

describe("podman command wrapper", () => {
  beforeEach(() => {
    executeCodeMock.mockReset();
    podmanEnvMock.mockClear();
  });

  it("retries once after podman stale pause-process errors in raw stderr", async () => {
    executeCodeMock
      .mockResolvedValueOnce({
        stdout: "",
        stderr: stalePodmanStderr,
        exit_code: 1,
      })
      .mockResolvedValueOnce({
        stdout: "stopped abc\n",
        stderr: "",
        exit_code: 0,
      })
      .mockResolvedValueOnce({
        stdout: "container-id\n",
        stderr: "",
        exit_code: 0,
      });

    const result = await podman(["run", "--rm", "example"], { timeout: 30 });

    expect(result).toEqual({
      stdout: "container-id\n",
      stderr: "",
      exit_code: 0,
    });
    expect(executeCodeMock).toHaveBeenCalledTimes(3);
    expect(executeCodeMock.mock.calls[0][0]).toMatchObject({
      command: "podman",
      args: ["run", "--rm", "example"],
      err_on_exit: false,
      env: {
        XDG_RUNTIME_DIR: "/tmp/podman-test-runtime",
        CONTAINERS_CGROUP_MANAGER: "cgroupfs",
      },
    });
    expect(executeCodeMock.mock.calls[1][0]).toMatchObject({
      command: "podman",
      args: ["system", "migrate"],
      err_on_exit: true,
    });
    expect(executeCodeMock.mock.calls[2][0]).toMatchObject({
      command: "podman",
      args: ["run", "--rm", "example"],
      err_on_exit: false,
    });
  });

  it("does not retry unrelated podman failures", async () => {
    executeCodeMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "boom",
      exit_code: 125,
    });

    await expect(podman(["ps", "-a"], { timeout: 30 })).rejects.toMatch("boom");
    expect(executeCodeMock).toHaveBeenCalledTimes(1);
  });
});
