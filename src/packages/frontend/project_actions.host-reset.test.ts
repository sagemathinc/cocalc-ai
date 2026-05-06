import { Map as ImmutableMap } from "immutable";

import { resetOpenFileRuntimeAfterHostReset } from "./project_actions";

describe("ProjectActions host restart file runtime reset", () => {
  it("clears all open file components, removes each sync runtime once, and reboots all open files with the active editor first", async () => {
    const openFiles = ImmutableMap<string, any>({
      "/display-a.ipynb": ImmutableMap({
        component: { redux_name: "old-a", Editor: "EditorA", other: true },
      }),
      "/display-b.ipynb": ImmutableMap({
        component: { redux_name: "old-b", Editor: "EditorB" },
      }),
      "/same-sync.txt": ImmutableMap({
        component: { redux_name: "old-c", Editor: "EditorC" },
      }),
    });
    const components = new Map<string, any>([
      [
        "/display-a.ipynb",
        { redux_name: "old-a", Editor: "EditorA", other: true },
      ],
      ["/display-b.ipynb", { redux_name: "old-b", Editor: "EditorB" }],
      ["/same-sync.txt", { redux_name: "old-c", Editor: "EditorC" }],
    ]);
    const setComponent = jest.fn((path: string, component: any) => {
      components.set(path, component);
    });
    const removeNamedRuntime = jest.fn().mockResolvedValue(undefined);
    const removeRuntime = jest.fn().mockResolvedValue(undefined);
    const beforeRebootstrap = jest.fn().mockResolvedValue(undefined);
    const rebootstrapPath = jest.fn().mockResolvedValue(undefined);

    await resetOpenFileRuntimeAfterHostReset({
      openFiles,
      activeProjectTab: "editor-/display-b.ipynb",
      getSyncPath: (path) =>
        path === "/same-sync.txt" ? "/display-a.ipynb" : path,
      getComponent: (path) => components.get(path),
      setComponent,
      removeNamedRuntime,
      removeRuntime,
      beforeRebootstrap,
      rebootstrapPath,
    });

    expect(setComponent).toHaveBeenCalledTimes(3);
    expect(components.get("/display-a.ipynb")).toEqual({
      redux_name: undefined,
      Editor: undefined,
      other: true,
    });
    expect(components.get("/display-b.ipynb")).toEqual({
      redux_name: undefined,
      Editor: undefined,
    });
    expect(components.get("/same-sync.txt")).toEqual({
      redux_name: undefined,
      Editor: undefined,
    });
    expect(removeNamedRuntime.mock.calls).toEqual([
      ["old-a"],
      ["old-b"],
      ["old-c"],
    ]);
    expect(removeRuntime.mock.calls).toEqual([
      ["/display-a.ipynb"],
      ["/display-b.ipynb"],
    ]);
    expect(beforeRebootstrap).toHaveBeenCalledTimes(1);
    expect(rebootstrapPath.mock.calls).toEqual([
      ["/display-b.ipynb", { noFocus: false }],
      ["/display-a.ipynb", { noFocus: true }],
      ["/same-sync.txt", { noFocus: true }],
    ]);
  });

  it("reboots open files without stealing focus when the active tab is not an editor", async () => {
    const openFiles = ImmutableMap<string, any>({
      "/notes.md": ImmutableMap({
        component: { redux_name: "old", Editor: "Editor" },
      }),
    });
    const components = new Map<string, any>([
      ["/notes.md", { redux_name: "old", Editor: "Editor" }],
    ]);
    const rebootstrapPath = jest.fn();

    await resetOpenFileRuntimeAfterHostReset({
      openFiles,
      activeProjectTab: "files",
      getSyncPath: (path) => path,
      getComponent: (path) => components.get(path),
      setComponent: (path, component) => {
        components.set(path, component);
      },
      removeNamedRuntime: jest.fn(),
      removeRuntime: jest.fn(),
      beforeRebootstrap: jest.fn(),
      rebootstrapPath,
    });

    expect(rebootstrapPath).toHaveBeenCalledWith("/notes.md", {
      noFocus: true,
    });
  });
});
