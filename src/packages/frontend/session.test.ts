jest.mock("./app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: jest.fn(async () => {}),
}));

jest.mock("./history", () => ({ load_target: jest.fn() }));
jest.mock("@cocalc/frontend/client/handle-target", () => ({
  __esModule: true,
  default: "projects/p1/files/a.chat",
}));
jest.mock("./misc/misc", () => ({
  should_load_target_url: jest.fn(() => true),
}));

import { load_target } from "./history";
import { should_load_target_url } from "./misc/misc";

import { ensureProjectReduxRuntime } from "./app-framework/project-runtime";
import {
  getOpenFilesForSessionClose,
  getSessionState,
  projectsReadyForSessionRestore,
  restoreSessionState,
  loadSessionUrlTarget,
} from "./session";

const mockEnsureProjectReduxRuntime = jest.mocked(ensureProjectReduxRuntime);

test("startup loads the existing URL without adding history", () => {
  jest.mocked(load_target).mockClear();
  loadSessionUrlTarget();
  expect(load_target).toHaveBeenCalledWith(
    "projects/p1/files/a.chat",
    true,
    false,
  );
  jest.mocked(load_target).mockClear();
  jest.mocked(should_load_target_url).mockReturnValueOnce(false);
  loadSessionUrlTarget();
  expect(load_target).not.toHaveBeenCalled();
});

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

describe("getOpenFilesForSessionClose", () => {
  it("does not initialize a full project store for a reduced project tab", () => {
    const redux = {
      hasProjectStore: jest.fn(() => false),
      getProjectStore: jest.fn(),
    } as any;

    expect(getOpenFilesForSessionClose(redux, "project-1")).toBeUndefined();
    expect(redux.getProjectStore).not.toHaveBeenCalled();
  });

  it("returns open files from an existing full project store", () => {
    const openFiles = ["a.txt", "b.ipynb"];
    const redux = {
      hasProjectStore: jest.fn(() => true),
      getProjectStore: jest.fn(() => ({
        get: jest.fn(() => ({ toJS: () => openFiles })),
      })),
    } as any;

    expect(getOpenFilesForSessionClose(redux, "project-1")).toBe(openFiles);
  });
});

describe("getSessionState", () => {
  it("preserves reduced tabs without initializing the project runtime", () => {
    const openProjects = {
      forEach(callback: (projectId: string) => void) {
        callback("full-project");
        callback("reduced-project");
      },
    };
    const getProjectStore = jest.fn((projectId: string) => {
      expect(projectId).toBe("full-project");
      return {
        get: jest.fn(() => ({ toJS: () => ["a.txt", "b.ipynb"] })),
      };
    });
    const redux = {
      getStore: jest.fn(() => ({ get: () => openProjects })),
      hasProjectStore: jest.fn(
        (projectId: string) => projectId === "full-project",
      ),
      getProjectStore,
    } as any;

    expect(getSessionState(redux)).toEqual([
      { "full-project": ["a.txt", "b.ipynb"] },
      { "reduced-project": [] },
    ]);
    expect(getProjectStore).toHaveBeenCalledTimes(1);
  });
});

describe("restoreSessionState", () => {
  it("awaits project restore work and keeps restore opens out of browser history", async () => {
    const events: string[] = [];
    mockEnsureProjectReduxRuntime.mockImplementationOnce(async () => {
      events.push("runtime_ready");
    });
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
      wait_for_ready: false,
      change_history: false,
    });
    expect(openFile).toHaveBeenNthCalledWith(2, {
      path: "b.txt",
      foreground: false,
      foreground_project: false,
      wait_for_ready: false,
      change_history: false,
    });
    expect(events).toEqual([
      "open_project:project-1",
      "open_project_done:project-1",
      "runtime_ready",
      "open_file:a.txt",
      "open_file:b.txt",
    ]);
    expect(mockEnsureProjectReduxRuntime).toHaveBeenCalledTimes(1);
  });
});
