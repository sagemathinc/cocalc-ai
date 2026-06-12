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
});
