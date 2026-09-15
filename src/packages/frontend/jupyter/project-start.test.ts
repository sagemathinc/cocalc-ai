import { EventEmitter } from "events";

jest.mock("@cocalc/frontend/lite", () => ({ lite: false }));

import { ensureProjectRunningForJupyter } from "./project-start";

class ProjectsStore extends EventEmitter {
  private state: string | undefined;
  private project: any;

  constructor(state: string | undefined, project?: any) {
    super();
    this.state = state;
    this.project = project;
  }

  get_state = (_project_id: string) => this.state;
  getIn = () => this.project;

  setState(state: string) {
    this.state = state;
    this.emit("change");
  }
}

function projectStateFromStore(store: ProjectsStore) {
  return jest.fn(async () => ({ state: store.get_state("project-1") as any }));
}

describe("ensureProjectRunningForJupyter", () => {
  it("does not read disposed redux or fetch state after editor teardown", async () => {
    const getProjectState = jest.fn();
    await expect(
      ensureProjectRunningForJupyter({
        redux: undefined as any,
        project_id: "project-1",
        isClosed: () => true,
        getProjectState,
      }),
    ).resolves.toEqual({ started: false, wasRunning: false });
    expect(getProjectState).not.toHaveBeenCalled();
  });

  it("stops polling when the editor closes during the state request", async () => {
    let closed = false;
    const store = new ProjectsStore("stopped");
    const getStore = jest.fn(() => store);
    const start_project = jest.fn();
    const getProjectState = jest.fn(async () => {
      closed = true;
      return { state: "stopped" as const };
    });
    await ensureProjectRunningForJupyter({
      redux: { getStore, getActions: () => ({ start_project }) },
      project_id: "project-1",
      isClosed: () => closed,
      getProjectState,
    });
    expect(start_project).not.toHaveBeenCalled();
    expect(getProjectState).toHaveBeenCalledTimes(1);
  });

  it("reports an already running project without starting it", async () => {
    const store = new ProjectsStore("running");
    const getProjectState = projectStateFromStore(store);
    const start_project = jest.fn();

    const result = await ensureProjectRunningForJupyter({
      redux: {
        getStore: () => store as any,
        getActions: () => ({ start_project }),
      },
      project_id: "project-1",
      isClosed: () => false,
      getProjectState,
    });

    expect(start_project).not.toHaveBeenCalled();
    expect(result).toEqual({
      initialState: "running",
      started: false,
      wasRunning: true,
    });
  });

  it.each(["running", "stopped", undefined])(
    "does not read disposed state when an in-flight poll returns %s",
    async (state) => {
      let closed = false;
      const store = new ProjectsStore("starting");
      const getState = jest.spyOn(store, "get_state");
      const getStore = jest.fn(() => store);
      const start_project = jest.fn();
      let pollStarted!: () => void;
      const polling = new Promise<void>((resolve) => (pollStarted = resolve));
      let finish!: (result: any) => void;
      const stateRequest = new Promise<any>((resolve) => (finish = resolve));
      const getProjectState = jest
        .fn()
        .mockResolvedValueOnce({ state: "starting" })
        .mockImplementationOnce(() => {
          pollStarted();
          return stateRequest;
        });

      const pending = ensureProjectRunningForJupyter({
        redux: { getStore, getActions: () => ({ start_project }) },
        project_id: "project-1",
        isClosed: () => closed,
        getProjectState,
      });
      await polling;
      closed = true;
      getState.mockImplementation(() => {
        throw Error("disposed store");
      });
      finish(state == null ? undefined : { state });

      await expect(pending).resolves.toEqual({
        initialState: "starting",
        started: false,
        wasRunning: false,
      });
      expect(getState).not.toHaveBeenCalled();
      expect(getStore).toHaveBeenCalledTimes(1);
      expect(start_project).not.toHaveBeenCalled();
      expect(getProjectState).toHaveBeenCalledTimes(2);
    },
  );

  it("starts a stopped project before waiting for the notebook runtime", async () => {
    const store = new ProjectsStore("stopped");
    const getProjectState = projectStateFromStore(store);
    const start_project = jest.fn(async (_project_id: string) => {
      store.setState("starting");
      setTimeout(() => {
        store.setState("running");
      }, 0);
    });

    const result = await ensureProjectRunningForJupyter({
      redux: {
        getStore: () => store as any,
        getActions: () => ({ start_project }),
      },
      project_id: "project-1",
      isClosed: () => false,
      getProjectState,
    });

    expect(start_project).toHaveBeenCalledWith("project-1", {
      autostart: true,
    });
    expect(result).toEqual({
      initialState: "stopped",
      started: true,
      wasRunning: false,
    });
    expect(store.get_state("project-1")).toBe("running");
  });

  it("does not issue another start request when the project is already starting", async () => {
    const store = new ProjectsStore("starting");
    const getProjectState = projectStateFromStore(store);
    const start_project = jest.fn();
    setTimeout(() => {
      store.setState("running");
    }, 0);

    const result = await ensureProjectRunningForJupyter({
      redux: {
        getStore: () => store as any,
        getActions: () => ({ start_project }),
      },
      project_id: "project-1",
      isClosed: () => false,
      getProjectState,
    });

    expect(start_project).not.toHaveBeenCalled();
    expect(result).toEqual({
      initialState: "starting",
      started: false,
      wasRunning: false,
    });
    expect(store.get_state("project-1")).toBe("running");
  });

  it("uses fresh project state instead of stale local running state", async () => {
    const store = new ProjectsStore("running");
    const freshStates = ["stopped", "running"];
    const getProjectState = jest.fn(async () => ({
      state: (freshStates.shift() ?? "running") as any,
    }));
    const start_project = jest.fn();

    const result = await ensureProjectRunningForJupyter({
      redux: {
        getStore: () => store as any,
        getActions: () => ({ start_project }),
      },
      project_id: "project-1",
      isClosed: () => false,
      getProjectState,
    });

    expect(start_project).toHaveBeenCalledWith("project-1", {
      autostart: true,
    });
    expect(result).toEqual({
      initialState: "stopped",
      started: true,
      wasRunning: false,
    });
    expect(getProjectState).toHaveBeenCalledTimes(2);
  });

  it("does not autostart when automatic starts are disabled", async () => {
    const store = new ProjectsStore("stopped", { autostart_enabled: false });
    const getProjectState = projectStateFromStore(store);
    const start_project = jest.fn();

    await expect(
      ensureProjectRunningForJupyter({
        redux: {
          getStore: () => store as any,
          getActions: () => ({ start_project }),
        },
        project_id: "project-1",
        isClosed: () => false,
        getProjectState,
      }),
    ).rejects.toThrow("Automatic starts are disabled");

    expect(start_project).not.toHaveBeenCalled();
  });
});
