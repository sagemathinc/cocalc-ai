import { EventEmitter } from "events";

jest.mock("@cocalc/frontend/lite", () => ({ lite: false }));

import { ensureProjectRunningForJupyter } from "./project-start";

class ProjectsStore extends EventEmitter {
  private state: string | undefined;

  constructor(state: string | undefined) {
    super();
    this.state = state;
  }

  get_state = (_project_id: string) => this.state;

  setState(state: string) {
    this.state = state;
    this.emit("change");
  }
}

describe("ensureProjectRunningForJupyter", () => {
  it("starts a stopped project before waiting for the notebook runtime", async () => {
    const store = new ProjectsStore("stopped");
    const start_project = jest.fn(async (_project_id: string) => {
      store.setState("starting");
      setTimeout(() => {
        store.setState("running");
      }, 0);
    });

    await ensureProjectRunningForJupyter({
      redux: {
        getStore: () => store as any,
        getActions: () => ({ start_project }),
      },
      project_id: "project-1",
      isClosed: () => false,
    });

    expect(start_project).toHaveBeenCalledWith("project-1");
    expect(store.get_state("project-1")).toBe("running");
  });

  it("does not issue another start request when the project is already starting", async () => {
    const store = new ProjectsStore("starting");
    const start_project = jest.fn();
    setTimeout(() => {
      store.setState("running");
    }, 0);

    await ensureProjectRunningForJupyter({
      redux: {
        getStore: () => store as any,
        getActions: () => ({ start_project }),
      },
      project_id: "project-1",
      isClosed: () => false,
    });

    expect(start_project).not.toHaveBeenCalled();
    expect(store.get_state("project-1")).toBe("running");
  });
});
