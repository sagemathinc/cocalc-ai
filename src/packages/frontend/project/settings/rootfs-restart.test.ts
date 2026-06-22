import { queueRootfsChangeRestart } from "./rootfs-restart";

describe("queueRootfsChangeRestart", () => {
  it("marks restart queued and awaits the project restart", async () => {
    const setRestartQueuedAt = jest.fn();
    const restartProject = jest.fn(async () => {});

    await queueRootfsChangeRestart({
      project_id: "project-1",
      restartProject,
      setRestartQueuedAt,
    });

    expect(restartProject).toHaveBeenCalledWith("project-1");
    expect(setRestartQueuedAt).toHaveBeenCalledTimes(1);
    expect(setRestartQueuedAt.mock.calls[0][0]).toEqual(expect.any(String));
  });

  it("clears queued state and surfaces restart failures", async () => {
    const setRestartQueuedAt = jest.fn();
    const restartProject = jest.fn(async () => {
      throw new Error("run slots unavailable");
    });

    await expect(
      queueRootfsChangeRestart({
        project_id: "project-1",
        restartProject,
        setRestartQueuedAt,
      }),
    ).rejects.toThrow(
      "Image changed, but project restart failed: Error: run slots unavailable",
    );

    expect(setRestartQueuedAt.mock.calls[0][0]).toEqual(expect.any(String));
    expect(setRestartQueuedAt.mock.calls.at(-1)?.[0]).toBe("");
  });
});
