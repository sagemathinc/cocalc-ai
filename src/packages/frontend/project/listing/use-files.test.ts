import {
  getListingSnapshot,
  isRetryableListingError,
  isStaleFilesystemClientError,
} from "./use-files";

describe("isRetryableListingError", () => {
  it("treats closed and disconnected listing failures as retryable", () => {
    expect(isRetryableListingError(new Error("closed"))).toBe(true);
    expect(isRetryableListingError("Error: closed")).toBe(true);
    expect(
      isRetryableListingError(new Error("socket has been disconnected")),
    ).toBe(true);
  });

  it("treats project-host bootstrap failures as retryable", () => {
    expect(
      isRetryableListingError(
        new Error('once: "ready" not emitted before "closed"'),
      ),
    ).toBe(true);
    expect(
      isRetryableListingError(
        new Error("failed to sign in - missing project-host bearer token"),
      ),
    ).toBe(true);
    expect(
      isRetryableListingError(
        new Error('once: timeout of 4000ms waiting for "info"'),
      ),
    ).toBe(true);
    expect(
      isRetryableListingError(
        new Error(
          "rootfs is not mounted; cannot access absolute path '/home'. Start the project and try again.",
        ),
      ),
    ).toBe(true);
  });

  it("does not retry ordinary listing failures", () => {
    expect(isRetryableListingError(new Error("permission denied"))).toBe(false);
  });
});

describe("isStaleFilesystemClientError", () => {
  it("recognizes errors that mean the filesystem client should be replaced", () => {
    expect(isStaleFilesystemClientError(new Error("closed"))).toBe(true);
    expect(
      isStaleFilesystemClientError(new Error("socket has been disconnected")),
    ).toBe(true);
    expect(
      isStaleFilesystemClientError(
        new Error('once: timeout of 4000ms waiting for "info"'),
      ),
    ).toBe(true);
  });

  it("does not replace the filesystem client for generic retryable errors", () => {
    expect(isStaleFilesystemClientError(new Error("timeout"))).toBe(false);
    expect(isStaleFilesystemClientError(new Error("failed to sign in"))).toBe(
      false,
    );
  });
});

describe("hedged initial directory listings", () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("uses one request when the first listing is fast", async () => {
    jest.useFakeTimers();
    const getListing = jest.fn(async () => ({
      files: { "quick.txt": { mtime: 1, size: 2 } },
    }));

    const result = await getListingSnapshot({
      fs: { getListing, listing: jest.fn() as any },
      hedge: true,
      path: "/home/user",
    });

    expect(result.attempts).toBe(1);
    expect(getListing).toHaveBeenCalledTimes(1);
  });

  it("accepts a hedged request when the first request stalls", async () => {
    jest.useFakeTimers();
    const pending: Array<{
      resolve: (value: { files: Record<string, any> }) => void;
    }> = [];
    const getListing = jest.fn(
      () =>
        new Promise<{ files: Record<string, any> }>((resolve) => {
          pending.push({ resolve });
        }),
    );
    const result = getListingSnapshot({
      fs: { getListing, listing: jest.fn() as any },
      hedge: true,
      path: "/home/user",
    });

    await Promise.resolve();
    expect(getListing).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    expect(getListing).toHaveBeenCalledTimes(2);
    pending[1].resolve({ files: { "winner.txt": { mtime: 1, size: 2 } } });

    await expect(result).resolves.toMatchObject({
      attempts: 2,
      files: { "winner.txt": { mtime: 1, size: 2 } },
    });
  });

  it("does not hedge a non-retryable failure", async () => {
    jest.useFakeTimers();
    const getListing = jest.fn(async () => {
      throw new Error("permission denied");
    });

    await expect(
      getListingSnapshot({
        fs: { getListing, listing: jest.fn() as any },
        hedge: true,
        path: "/home/user",
      }),
    ).rejects.toThrow("permission denied");
    expect(getListing).toHaveBeenCalledTimes(1);
  });

  it("caps stalled listings at one twelve-second deadline", async () => {
    jest.useFakeTimers();
    const getListing = jest.fn(
      async () =>
        await new Promise<{ files: Record<string, any> }>(() => undefined),
    );
    const result = getListingSnapshot({
      fs: { getListing, listing: jest.fn() as any },
      hedge: true,
      path: "/home/user",
    }).catch((err) => err);

    jest.advanceTimersByTime(12_000);
    await expect(result).resolves.toMatchObject({ code: 408 });
    expect(getListing).toHaveBeenCalledTimes(3);
  });
});
