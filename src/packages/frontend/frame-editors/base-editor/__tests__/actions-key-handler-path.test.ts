import { fromJS } from "immutable";
import { BaseEditorActions } from "../actions-base";

describe("BaseEditorActions.set_active_key_handler", () => {
  it("uses the active display path when the tab is a symlink alias", () => {
    const setActiveKeyHandler = jest.fn();
    const projectStore = fromJS({
      active_project_tab: "editor-/home/wstein/x.tasks",
      open_files: {
        "/home/wstein/x.tasks": {
          sync_path: "/home/wstein/wstein.tasks",
        },
      },
    });
    const handler = jest.fn();
    const target: any = {
      redux: {
        getActions: (name: string) =>
          name === "page"
            ? { set_active_key_handler: setActiveKeyHandler }
            : undefined,
        getProjectStore: () => projectStore,
      },
      project_id: "project-1",
      path: "/home/wstein/wstein.tasks",
    };

    BaseEditorActions.prototype.set_active_key_handler.call(target, handler);

    expect(setActiveKeyHandler).toHaveBeenCalledWith(
      handler,
      "project-1",
      "/home/wstein/x.tasks",
    );
    expect(target._key_handler).toBe(handler);
  });

  it("keeps the canonical path when there is no active alias", () => {
    const setActiveKeyHandler = jest.fn();
    const projectStore = fromJS({
      active_project_tab: "editor-/home/wstein/other.tasks",
      open_files: {
        "/home/wstein/other.tasks": {
          sync_path: "/home/wstein/other.tasks",
        },
      },
    });
    const handler = jest.fn();
    const target: any = {
      redux: {
        getActions: (name: string) =>
          name === "page"
            ? { set_active_key_handler: setActiveKeyHandler }
            : undefined,
        getProjectStore: () => projectStore,
      },
      project_id: "project-1",
      path: "/home/wstein/wstein.tasks",
    };

    BaseEditorActions.prototype.set_active_key_handler.call(target, handler);

    expect(setActiveKeyHandler).toHaveBeenCalledWith(
      handler,
      "project-1",
      "/home/wstein/wstein.tasks",
    );
  });
});
