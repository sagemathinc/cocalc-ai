import podman from "./command";

const executeCodeMock = jest.fn();

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (...args: any[]) => executeCodeMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => () => ({
  debug: jest.fn(),
  warn: jest.fn(),
}));

describe("podman command wrapper", () => {
  beforeEach(() => {
    executeCodeMock.mockReset();
  });

  it("retries once after podman stale pause-process errors", async () => {
    executeCodeMock
      .mockRejectedValueOnce(
        'command \'podman\' exited with nonzero code 1 -- stderr=\'time="..." level=error msg="invalid internal status, try resetting the pause process with "podman system migrate": could not find any running process: no such process"\'',
      )
      .mockResolvedValueOnce({ stdout: "stopped abc\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "container-id\n", stderr: "" });

    const result = await podman(["run", "--rm", "example"], { timeout: 30 });

    expect(result).toEqual({ stdout: "container-id\n", stderr: "" });
    expect(executeCodeMock).toHaveBeenCalledTimes(3);
    expect(executeCodeMock.mock.calls[0][0]).toMatchObject({
      command: "podman",
      args: ["run", "--rm", "example"],
      err_on_exit: true,
    });
    expect(executeCodeMock.mock.calls[1][0]).toMatchObject({
      command: "podman",
      args: ["system", "migrate"],
      err_on_exit: true,
    });
    expect(executeCodeMock.mock.calls[2][0]).toMatchObject({
      command: "podman",
      args: ["run", "--rm", "example"],
      err_on_exit: true,
    });
  });

  it("does not retry unrelated podman failures", async () => {
    executeCodeMock.mockRejectedValueOnce(
      new Error(
        "command 'podman' exited with nonzero code 125 -- stderr='boom'",
      ),
    );

    await expect(podman(["ps", "-a"], { timeout: 30 })).rejects.toThrow("boom");
    expect(executeCodeMock).toHaveBeenCalledTimes(1);
  });
});
