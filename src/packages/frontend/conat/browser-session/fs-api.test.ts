import { createBrowserExecFsApi } from "./fs-api";

describe("createBrowserExecFsApi", () => {
  it("times out stalled fs bootstrap and allows a later retry", async () => {
    const fsClient = {
      stat: jest.fn(async (path: string) => ({ path, ok: true })),
    };
    const loadFsClient = jest.fn(async () => fsClient);
    let attempts = 0;
    const withTimeoutImpl = jest.fn(async (promise: Promise<any>) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("timeout");
      }
      return await promise;
    });

    const fsApi = createBrowserExecFsApi({
      loadFsClient,
      bootstrapTimeoutMs: 3210,
      withTimeoutImpl,
    });

    await expect((fsApi as any).stat("/home/user")).rejects.toThrow(
      "browser-session fs bootstrap timed out after 3210ms",
    );

    await expect((fsApi as any).stat("/home/user")).resolves.toEqual({
      path: "/home/user",
      ok: true,
    });

    expect(loadFsClient).toHaveBeenCalledTimes(2);
    expect(fsClient.stat).toHaveBeenCalledTimes(1);
  });

  it("reuses a successful fs bootstrap across method calls", async () => {
    const fsClient = {
      cwd: "/home/user",
      stat: jest.fn(async () => ({ ok: true })),
    };
    const loadFsClient = jest.fn(async () => fsClient);

    const fsApi = createBrowserExecFsApi({
      loadFsClient,
      withTimeoutImpl: async (promise: Promise<any>) => await promise,
    });

    await expect((fsApi as any).stat("/home/user")).resolves.toEqual({
      ok: true,
    });
    await expect((fsApi as any).cwd()).resolves.toBe("/home/user");

    expect(loadFsClient).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled fs method call with a clear error", async () => {
    const fsClient = {
      stat: jest.fn(() => new Promise(() => undefined)),
    };
    const loadFsClient = jest.fn(async () => fsClient);
    const withTimeoutImpl = jest.fn(
      async (promise: Promise<any>, timeoutMs) => {
        if (timeoutMs === 4321) {
          return await promise;
        }
        throw new Error("timeout");
      },
    );

    const fsApi = createBrowserExecFsApi({
      loadFsClient,
      bootstrapTimeoutMs: 4321,
      callTimeoutMs: 6789,
      withTimeoutImpl,
    });

    await expect((fsApi as any).stat("/home/user")).rejects.toThrow(
      "browser-session fs call 'stat' timed out after 6789ms",
    );

    expect(loadFsClient).toHaveBeenCalledTimes(1);
    expect(fsClient.stat).toHaveBeenCalledTimes(1);
  });
});
