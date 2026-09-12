/** @jest-environment jsdom */

import { EventEmitter } from "events";

const registerReconnectResource = jest.fn();
const projectConat = jest.fn();
const mockJupyterClient = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      registerReconnectResource,
      projectConat,
    },
  },
}));

jest.mock("@cocalc/conat/project/jupyter/run-code", () => ({
  jupyterClient: mockJupyterClient,
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { JupyterActions } from "../browser-actions";

describe("JupyterActions reconnect coordination", () => {
  beforeEach(() => {
    registerReconnectResource.mockReset();
    registerReconnectResource.mockReturnValue({
      requestReconnect: jest.fn(),
      close: jest.fn(),
    });
    projectConat.mockReset();
    mockJupyterClient.mockReset();
  });

  it("captures the project id when open tracing starts before initialization", () => {
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    actions.runDebug = jest.fn();

    actions.noteOpenInitStart({ project_id: "project-1" });

    expect(actions.openUxTrace.options.project_id).toBe("project-1");
    clearTimeout(actions.openUxIncompleteTimer);
  });

  it("registers a reconnect resource that waits for live syncdb recovery", async () => {
    const wait_until_live_connected = jest.fn(async () => {});
    const wait_until_ready = jest.fn(async () => {});
    const target: any = {
      isClosed: jest.fn(() => false),
      syncdb: {
        is_live_connected: () => false,
        wait_until_live_connected,
        get_state: () => "ready",
      },
      wait_until_ready,
      isSyncdbLiveConnected: JupyterActions.prototype["isSyncdbLiveConnected"],
    };

    JupyterActions.prototype["initReconnectResource"].call(target);

    expect(registerReconnectResource).toHaveBeenCalledTimes(1);
    const options = registerReconnectResource.mock.calls[0][0];
    expect(options.canReconnect()).toBe(true);
    expect(options.isConnected()).toBe(false);
    await options.reconnect();
    expect(wait_until_live_connected).toHaveBeenCalled();
    expect(wait_until_ready).toHaveBeenCalled();
  });

  it("drops only the kernel execution client when the project runtime changes", () => {
    class ProjectStore extends EventEmitter {
      get = () => undefined;
    }
    const projectStore = new ProjectStore();
    const closeJupyterClient = jest.fn();
    const clearRunQueue = jest.fn();
    const clear_all_cell_run_state = jest.fn();
    const target: any = {
      project_id: "project-1",
      redux: {
        getProjectStore: jest.fn(() => projectStore),
      },
      isClosed: jest.fn(() => false),
      closeJupyterClient,
      clearRunQueue,
      clear_all_cell_run_state,
    };
    target.handleProjectRuntimeChange = (notice) =>
      JupyterActions.prototype["handleProjectRuntimeChange"].call(
        target,
        notice,
      );
    JupyterActions.prototype["initProjectRuntimeWatcher"].call(target);
    projectStore.emit("runtime-recovery", {
      id: "project-1:runtime-2",
      reason: "project_runtime_changed",
      occurred_at: Date.now(),
    });

    expect(closeJupyterClient).toHaveBeenCalledWith("project_runtime_changed");
    expect(clearRunQueue).toHaveBeenCalled();
    expect(clear_all_cell_run_state).toHaveBeenCalled();
    expect(target.runningNow).toBe(false);
  });

  it("shares a connecting Jupyter client between concurrent startup callers", async () => {
    let finishReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      finishReady = resolve;
    });
    const socket = new EventEmitter() as EventEmitter & {
      state: string;
      waitUntilReady: jest.Mock;
    };
    socket.state = "connecting";
    socket.waitUntilReady = jest.fn(() => ready);
    const close = jest.fn();
    const client = { socket, close };
    mockJupyterClient.mockReturnValue(client);
    projectConat.mockResolvedValue({ state: "disconnected" });

    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    actions.project_id = "project-1";
    actions.syncdbPath = ".notebook.ipynb.sage-jupyter2";
    actions._state = "ready";
    actions.waitUntilProjectIsRunning = jest.fn(async () => {});

    const first = actions.getJupyterClient();
    const second = actions.getJupyterClient();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(projectConat).toHaveBeenCalledTimes(1);
    expect(mockJupyterClient).toHaveBeenCalledTimes(1);
    expect(socket.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    socket.state = "ready";
    finishReady();

    await expect(first).resolves.toBe(client);
    await expect(second).resolves.toBe(client);
    expect(close).not.toHaveBeenCalled();

    await actions.close();
  });

  it.each(["editor", "transport"])(
    "abandons kernel startup when the %s closes during routing",
    async (closing) => {
      let finishRouting!: (client: any) => void;
      projectConat.mockImplementationOnce(
        () => new Promise((resolve) => (finishRouting = resolve)),
      );
      const actions: any = new JupyterActions("jupyter-test", {
        getStore: jest.fn(() => undefined),
        removeActions: jest.fn(),
      } as any);
      actions._state = "ready";
      actions.waitUntilProjectIsRunning = jest.fn(async () => {});
      const pending = actions.getJupyterClient();
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (closing === "editor") await actions.close();
      const transport = {
        state: closing === "transport" ? "closed" : "connected",
        close: jest.fn(),
      };
      mockJupyterClient.mockImplementation(() => {
        throw Error("closed");
      });
      finishRouting(transport);

      await expect(pending).resolves.toBeNull();
      expect(mockJupyterClient).not.toHaveBeenCalled();
      // This transport is shared with other editors, not owned by these actions.
      expect(transport.close).not.toHaveBeenCalled();

      if (closing === "transport") {
        const socket = Object.assign(new EventEmitter(), {
          state: "ready",
          waitUntilReady: jest.fn(async () => {}),
        });
        const client = { socket, close: jest.fn() };
        projectConat.mockResolvedValue({ state: "disconnected" });
        mockJupyterClient.mockReturnValue(client);
        await expect(actions.getJupyterClient()).resolves.toBe(client);
        await actions.close();
      }
    },
  );

  it("does not flush live-run replay after the actions close", async () => {
    let finishReplay!: () => void;
    const replay = new Promise<void>((resolve) => {
      finishReplay = resolve;
    });
    let markReplayStarted!: () => void;
    const replayStarted = new Promise<void>((resolve) => {
      markReplayStarted = resolve;
    });
    let finishSubscription!: () => void;
    const subscription = {
      close: jest.fn(() => finishSubscription()),
      [Symbol.asyncIterator]() {
        return this;
      },
      next: jest.fn(
        () =>
          new Promise<IteratorResult<never>>((resolve) => {
            finishSubscription = () =>
              resolve({ done: true, value: undefined });
          }),
      ),
    };
    projectConat.mockResolvedValue({
      subscribe: jest.fn(async () => subscription),
    });
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    actions.project_id = "project-1";
    actions.liveRunPath = "notebook.ipynb";
    actions._state = "ready";
    actions.replaySharedLiveRuns = jest.fn(() => {
      markReplayStarted();
      return replay;
    });
    const runDebug = jest.fn();
    actions.runDebug = runDebug;

    const pending = actions.ensureLiveRunSubscription();
    await replayStarted;
    expect(actions.replaySharedLiveRuns).toHaveBeenCalledTimes(1);

    await actions.close();
    finishReplay();

    await expect(pending).resolves.toBeUndefined();
    expect(runDebug).not.toHaveBeenCalledWith(
      "liveRun.batch.buffer.flush",
      expect.anything(),
    );
  });

  it("stops a pending file deletion check when the actions close", async () => {
    let finishExists!: (exists: boolean) => void;
    const exists = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishExists = resolve;
        }),
    );
    const syncdb: any = {
      fs: { exists },
      opts: {
        deletedCheckInterval: 1,
        deletedThreshold: 10,
      },
      emit: jest.fn(),
    };
    let closed = false;
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    actions.isClosed = () => closed;
    actions.isIpynbDeleted = false;
    actions.path = "notebook.ipynb";
    actions.syncdb = syncdb;

    const checking = actions.signalIfFileDeleted();
    expect(exists).toHaveBeenCalledWith("notebook.ipynb");

    closed = true;
    delete syncdb.opts;
    delete actions.syncdb;
    finishExists(false);

    await expect(checking).resolves.toBeUndefined();
    expect(syncdb.emit).not.toHaveBeenCalled();
  });

  it("falls back to kernel selection when the account store is unavailable", () => {
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    actions.store = {
      get: jest.fn(() => undefined),
    };
    actions.show_select_kernel = jest.fn();
    actions.setState = jest.fn();

    expect(() => actions.initKernel()).not.toThrow();
    expect(actions.show_select_kernel).toHaveBeenCalledWith("bad kernel");
    expect(actions.setState).toHaveBeenCalledWith({
      check_select_kernel_init: true,
    });
  });

  it("stops kernel initialization after the Jupyter store is removed", () => {
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(),
      removeActions: jest.fn(),
    } as any);
    actions.store = undefined;
    actions.show_select_kernel = jest.fn();
    actions.setState = jest.fn();

    expect(() => actions.initKernel()).not.toThrow();
    expect(actions.show_select_kernel).not.toHaveBeenCalled();
    expect(actions.setState).not.toHaveBeenCalled();
  });

  it("stops a debounced contents update after the Jupyter store is removed", () => {
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(),
      removeActions: jest.fn(),
    } as any);
    actions._state = "closed";
    actions.store = undefined;

    expect(() => actions.updateContentsNow()).not.toThrow();
  });

  it("does not fetch kernels after actions teardown removes redux and store", async () => {
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(),
      removeActions: jest.fn(),
    } as any);
    actions._state = "closed";
    delete actions.redux;
    delete actions.store;
    actions.waitUntilProjectIsRunning = jest.fn();

    await expect(actions.fetch_jupyter_kernels()).resolves.toBeUndefined();
    expect(actions.waitUntilProjectIsRunning).not.toHaveBeenCalled();
  });

  it("stops kernel selection after Jupyter resources are removed", async () => {
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(),
      removeActions: jest.fn(),
    } as any);
    actions.isClosed = jest.fn(() => false);
    actions.syncdb = undefined;
    actions.store = undefined;
    actions.restart = jest.fn();
    actions.halt = jest.fn();
    actions._set = jest.fn();

    await expect(actions.set_kernel("python3")).resolves.toBeUndefined();
    expect(actions._set).not.toHaveBeenCalled();
    expect(actions.restart).not.toHaveBeenCalled();
    expect(actions.halt).not.toHaveBeenCalled();
  });
});
