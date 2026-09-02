/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

describe("app runtime state serialization", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    jest.resetModules();
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  test("serializes concurrent running-service updates and drops legacy exposures", async () => {
    process.env.HOME = "/tmp/cocalc-state-test";

    const files = new Map<string, string>();
    let concurrentReads = 0;
    let maxConcurrentReads = 0;

    jest.doMock("node:fs/promises", () => ({
      mkdir: jest.fn(async () => undefined),
      readFile: jest.fn(async (path: string) => {
        concurrentReads += 1;
        maxConcurrentReads = Math.max(maxConcurrentReads, concurrentReads);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentReads -= 1;
        const value = files.get(path);
        if (value == null) {
          const err: NodeJS.ErrnoException = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        }
        return value;
      }),
      writeFile: jest.fn(async (path: string, data: string) => {
        files.set(path, data);
      }),
      rename: jest.fn(async (from: string, to: string) => {
        const value = files.get(from);
        if (value == null) {
          const err: NodeJS.ErrnoException = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        }
        files.set(to, value);
        files.delete(from);
      }),
    }));

    const state = await import("./state");

    files.set(
      "/tmp/cocalc-state-test/.local/share/cocalc/apps/runtime-state.json",
      JSON.stringify({
        version: 1,
        exposures: {
          legacy: { mode: "public", auth_front: "none" },
        },
        running_services: {},
      }),
    );

    await Promise.all([
      state.setRunningServicePort("code-server", 43339),
      state.setRunningServicePort("jupyterlab", 43340),
    ]);

    expect(maxConcurrentReads).toBe(1);
    await expect(state.appIdForRunningServicePort(43339)).resolves.toBe(
      "code-server",
    );
    await expect(state.appIdForRunningServicePort(43340)).resolves.toBe(
      "jupyterlab",
    );
    const persisted = JSON.parse(
      files.get(
        "/tmp/cocalc-state-test/.local/share/cocalc/apps/runtime-state.json",
      )!,
    );
    expect(persisted.exposures).toBeUndefined();
  });
});
