import { Map as ImmutableMap } from "immutable";

import { resetOpenFileRuntimeAfterHostReset } from "./project_actions";

describe("ProjectActions host restart file runtime reset", () => {
  it("clears all open file components, removes each sync runtime once, and reboots the active editor", async () => {
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
    const removeRuntime = jest.fn().mockResolvedValue(undefined);
    const rebootstrapPath = jest.fn().mockResolvedValue(undefined);

    await resetOpenFileRuntimeAfterHostReset({
      openFiles,
      activeProjectTab: "editor-/display-b.ipynb",
      getSyncPath: (path) =>
        path === "/same-sync.txt" ? "/display-a.ipynb" : path,
      getComponent: (path) => components.get(path),
      setComponent,
      removeRuntime,
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
    expect(removeRuntime.mock.calls).toEqual([
      ["/display-a.ipynb"],
      ["/display-b.ipynb"],
    ]);
    expect(rebootstrapPath).toHaveBeenCalledWith("/display-b.ipynb");
  });

  it("does not reboot when the active tab is not an editor", async () => {
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
      removeRuntime: jest.fn(),
      rebootstrapPath,
    });

    expect(rebootstrapPath).not.toHaveBeenCalled();
  });
});
