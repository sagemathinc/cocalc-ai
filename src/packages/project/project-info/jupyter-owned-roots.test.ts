/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

describe("jupyter owned roots bridge", () => {
  afterEach(async () => {
    const { closeOwnedProcessRegistry } = await import("./owned-process-registry");
    closeOwnedProcessRegistry();
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("maps spawn/exit/close lifecycle events to owned roots", async () => {
    let observer:
      | ((event: {
          event: "spawn" | "exit" | "close";
          identity: string;
          path: string;
          pid?: number;
        }) => void)
      | undefined;

    jest.doMock("@cocalc/jupyter/kernel", () => ({
      setKernelLifecycleObserver: (fn) => {
        observer = fn;
      },
    }));

    const { ensureJupyterOwnedRootBridge } = await import("./jupyter-owned-roots");
    const { getOwnedProcessRegistry } = await import("./owned-process-registry");

    ensureJupyterOwnedRootBridge();
    expect(typeof observer).toBe("function");

    observer?.({
      event: "spawn",
      identity: "kernel-1",
      path: "notes.ipynb",
      pid: 1234,
    });
    const registry = getOwnedProcessRegistry();
    const root = registry.getRootForPid(1234);
    expect(root?.kind).toBe("jupyter");
    expect(root?.path).toBe("notes.ipynb");
    expect(root?.session_id).toBe("kernel-1");
    expect(root?.exited_at).toBeUndefined();

    observer?.({
      event: "exit",
      identity: "kernel-1",
      path: "notes.ipynb",
      pid: 1234,
    });
    expect(root?.exited_at).toBeDefined();

    observer?.({
      event: "close",
      identity: "kernel-1",
      path: "notes.ipynb",
      pid: 1234,
    });
    expect(registry.listRoots()).toHaveLength(0);
  });
});

