import {
  isFileServerNotInitializedError,
  isTransientDisconnectSaveError,
  saveToDiskWithFileServerRetry,
} from "../actions-base";

describe("saveToDiskWithFileServerRetry", () => {
  it("retries transient file-server initialization failures silently", async () => {
    const save = jest
      .fn()
      .mockRejectedValueOnce(new Error("file server not initialized"))
      .mockRejectedValueOnce(
        new Error(
          "Error saving file to disk '/home/user/work/2026.chat' -- Error: file server not initialized",
        ),
      )
      .mockResolvedValueOnce(undefined);
    const wait = jest.fn(async () => undefined);

    await saveToDiskWithFileServerRetry({
      retryDelaysMs: [10, 20, 30],
      save,
      wait,
    });

    expect(save).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
  });

  it("does not retry unrelated save failures", async () => {
    const err = new Error("permission denied");
    const save = jest.fn().mockRejectedValue(err);
    const wait = jest.fn(async () => undefined);

    await expect(
      saveToDiskWithFileServerRetry({
        retryDelaysMs: [10, 20],
        save,
        wait,
      }),
    ).rejects.toBe(err);

    expect(save).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("surfaces persistent file-server initialization failures after the retry budget", async () => {
    const err = new Error("file server not initialized");
    const save = jest.fn().mockRejectedValue(err);
    const wait = jest.fn(async () => undefined);

    await expect(
      saveToDiskWithFileServerRetry({
        retryDelaysMs: [10, 20],
        save,
        wait,
      }),
    ).rejects.toBe(err);

    expect(save).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("detects wrapped file-server initialization messages", () => {
    expect(
      isFileServerNotInitializedError(
        "Error saving file to disk '/home/user/a.chat' -- Error: file server not initialized",
      ),
    ).toBe(true);
    expect(isFileServerNotInitializedError(new Error("timeout"))).toBe(false);
  });

  it("retries a save that failed only because the connection dropped", async () => {
    const save = jest
      .fn()
      .mockRejectedValueOnce(new Error("socket has been disconnected"))
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValueOnce(undefined);
    const wait = jest.fn(async () => undefined);

    await saveToDiskWithFileServerRetry({
      retryDelaysMs: [10, 20, 30],
      save,
      wait,
    });

    expect(save).toHaveBeenCalledTimes(3);
  });

  it("recognizes connection drops but not other failures", () => {
    expect(
      isTransientDisconnectSaveError(
        new Error("Error: socket has been disconnected"),
      ),
    ).toBe(true);
    expect(isTransientDisconnectSaveError("socket is disconnected")).toBe(true);
    expect(isTransientDisconnectSaveError(new Error("disconnected"))).toBe(
      true,
    );
    expect(isTransientDisconnectSaveError(new Error("permission denied"))).toBe(
      false,
    );
    expect(
      isTransientDisconnectSaveError(new Error("disk quota exceeded")),
    ).toBe(false);
  });
});
