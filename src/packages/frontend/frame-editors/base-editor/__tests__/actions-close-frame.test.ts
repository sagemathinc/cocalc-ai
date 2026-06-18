import { fromJS } from "immutable";
import { BaseEditorActions } from "../actions-base";

describe("BaseEditorActions.close_frame", () => {
  it("closes the file tab when the last frame is closed", () => {
    const closeTab = jest.fn();
    const resetLocalViewState = jest.fn();
    const emit = jest.fn();
    const target: any = {
      path: "/home/user/test.md",
      _tree_is_single_leaf: () => true,
      _get_frame_node: () => fromJS({ type: "cm" }),
      reset_local_view_state: resetLocalViewState,
      store: { emit },
      _get_project_actions: () => ({ close_tab: closeTab }),
    };

    BaseEditorActions.prototype.close_frame.call(target, "frame-1");

    expect(resetLocalViewState).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("close-frame", {
      id: "frame-1",
      type: "cm",
      closingFile: true,
    });
    expect(closeTab).toHaveBeenCalledWith("/home/user/test.md");
  });

  it("clears chat state before closing the file tab for a lone chat frame", () => {
    const closeTab = jest.fn();
    const closeChat = jest.fn();
    const target: any = {
      path: "/home/user/test.chat",
      _tree_is_single_leaf: () => true,
      _get_frame_node: () => fromJS({ type: "chat" }),
      reset_local_view_state: jest.fn(),
      closeChat,
      store: { emit: jest.fn() },
      _get_project_actions: () => ({ close_tab: closeTab }),
    };

    BaseEditorActions.prototype.close_frame.call(target, "frame-1");

    expect(closeChat).toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith("/home/user/test.chat");
  });

  it("closes the terminal instance before closing the file tab for a lone terminal frame", () => {
    const closeTab = jest.fn();
    const closeTerminal = jest.fn();
    const emit = jest.fn();
    const target: any = {
      path: "/home/user/test.term",
      _tree_is_single_leaf: () => true,
      _get_frame_node: () => fromJS({ type: "terminal" }),
      reset_local_view_state: jest.fn(),
      terminals: { close_terminal: closeTerminal },
      store: { emit },
      redux: {
        getProjectStore: () => undefined,
      },
      _get_project_actions: () => ({ close_tab: closeTab }),
    };

    BaseEditorActions.prototype.close_frame.call(target, "frame-1");

    expect(closeTerminal).toHaveBeenCalledWith("frame-1");
    expect(emit).toHaveBeenCalledWith("close-frame", {
      id: "frame-1",
      type: "terminal",
      closingFile: true,
    });
    expect(closeTab).toHaveBeenCalledWith("/home/user/test.term");
    expect(closeTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      closeTab.mock.invocationCallOrder[0],
    );
  });

  it("closes the active display tab when the editor path is a terminal sync identity", () => {
    const closeTab = jest.fn();
    const closeTerminal = jest.fn();
    const syncPath = "/home/user/.test.term-0";
    const displayPath = "/home/user/test.term";
    const projectStore = fromJS({
      active_project_tab: `editor-${displayPath}`,
      open_files: {
        [displayPath]: {
          sync_path: syncPath,
        },
      },
    });
    const target: any = {
      path: syncPath,
      project_id: "project-1",
      _tree_is_single_leaf: () => true,
      _get_frame_node: () => fromJS({ type: "terminal" }),
      reset_local_view_state: jest.fn(),
      terminals: { close_terminal: closeTerminal },
      store: { emit: jest.fn() },
      redux: {
        getProjectStore: () => projectStore,
      },
      _get_project_actions: () => ({ close_tab: closeTab }),
    };

    BaseEditorActions.prototype.close_frame.call(target, "frame-1");

    expect(closeTerminal).toHaveBeenCalledWith("frame-1");
    expect(closeTab).toHaveBeenCalledWith(displayPath);
    expect(closeTab).not.toHaveBeenCalledWith(syncPath);
  });
});
