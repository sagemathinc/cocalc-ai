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

  it("removes the syncstring closed-listener before manual close", async () => {
    const handler = jest.fn();
    const removeListener = jest.fn();
    const close = jest.fn();
    const target: any = {
      _syncstring: {
        get_state: () => "closed",
        removeListener,
        close,
      },
      handleSyncstringClosed: handler,
    };

    await BaseEditorActions.prototype["close_syncstring"].call(target);

    expect(removeListener).toHaveBeenCalledWith("closed", handler);
    expect(close).toHaveBeenCalled();
  });

  it("removes the syncdb closed-listener before manual close", async () => {
    const handler = jest.fn();
    const removeListener = jest.fn();
    const close = jest.fn();
    const target: any = {
      _syncdb: {
        removeListener,
        close,
      },
      handleSyncdbClosed: handler,
    };

    await BaseEditorActions.prototype["close_syncdb"].call(target);

    expect(removeListener).toHaveBeenCalledWith("closed", handler);
    expect(close).toHaveBeenCalled();
  });
});
