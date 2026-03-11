import { projectsReadyForSessionRestore, restoreSessionState } from "./session";

function makeStore(values: Record<string, unknown>) {
  return {
    get(key: string) {
      return values[key];
    },
  };
}

describe("projectsReadyForSessionRestore", () => {
  it("uses open_projects readiness in lite mode", () => {
    const store = makeStore({
      open_projects: ["project-1"],
      project_map: null,
    });
    expect(
      projectsReadyForSessionRestore(store, {
        minimal: false,
        liteMode: true,
      }),
    ).toBe(true);
  });

  it("still requires project_map outside lite/minimal mode", () => {
    const store = makeStore({
      open_projects: ["project-1"],
      project_map: null,
    });
    expect(
      projectsReadyForSessionRestore(store, {
        minimal: false,
        liteMode: false,
      }),
    ).toBe(false);
  });
});

describe("restoreSessionState", () => {
  it("awaits project restore work and keeps restore opens out of browser history", async () => {
    const events: string[] = [];
    let allowProjectOpenResolve!: () => void;
    const projectOpenGate = new Promise<void>((resolve) => {
      allowProjectOpenResolve = resolve;
    });
    const openProject = jest.fn(async (opts) => {
      events.push(`open_project:${opts.project_id}`);
      await projectOpenGate;
      events.push(`open_project_done:${opts.project_id}`);
    });
    const openFile = jest.fn(async (opts) => {
      events.push(`open_file:${opts.path}`);
    });
    const redux = {
      getActions(name: string) {
        expect(name).toBe("projects");
        return { open_project: openProject };
      },
      getProjectActions(project_id: string) {
        expect(project_id).toBe("project-1");
        return { open_file: openFile };
      },
    } as any;

    const restore = restoreSessionState(redux, [
      { "project-1": ["a.txt", "b.txt"] },
    ]);
    await Promise.resolve();

    expect(openProject).toHaveBeenCalledWith({
      project_id: "project-1",
      switch_to: false,
      restore_session: false,
      change_history: false,
    });
    expect(openFile).not.toHaveBeenCalled();

    allowProjectOpenResolve();
    await restore;

    expect(openFile).toHaveBeenNthCalledWith(1, {
      path: "a.txt",
      foreground: false,
      foreground_project: false,
      change_history: false,
    });
    expect(openFile).toHaveBeenNthCalledWith(2, {
      path: "b.txt",
      foreground: false,
      foreground_project: false,
      change_history: false,
    });
    expect(events).toEqual([
      "open_project:project-1",
      "open_project_done:project-1",
      "open_file:a.txt",
      "open_file:b.txt",
    ]);
  });
});
