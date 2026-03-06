/** @jest-environment jsdom */

const mockHandoffProjectNavigationFromLocalOwner = jest.fn();
const mockMatchProjectNavigationCommand = jest.fn();

jest.mock("@cocalc/frontend/project/page/keyboard-navigation", () => ({
  handoffProjectNavigationFromLocalOwner: (...args: any[]) =>
    mockHandoffProjectNavigationFromLocalOwner(...args),
  matchProjectNavigationCommand: (...args: any[]) =>
    mockMatchProjectNavigationCommand(...args),
}));

import { handleEditableMarkdownProjectNavigationKeydown } from "../editable-markdown";

describe("editable markdown project navigation shortcuts", () => {
  beforeEach(() => {
    mockHandoffProjectNavigationFromLocalOwner.mockReset();
    mockMatchProjectNavigationCommand.mockReset();
  });

  it("hands reserved frame navigation to the shared project handler", () => {
    mockMatchProjectNavigationCommand.mockReturnValue("focusNextFrame");
    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();
    const projectActions = { activate_next_file_tab: jest.fn() };
    const event = {
      key: "F6",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      defaultPrevented: false,
      preventDefault,
      stopPropagation,
    };
    const active = document.createElement("div");

    expect(
      handleEditableMarkdownProjectNavigationKeydown({
        event,
        projectId: "project-1",
        frameId: "frame-b",
        actions: {
          get_frame_ids_in_order: () => ["frame-a", "frame-b"],
          _get_project_actions: () => projectActions,
        },
        blurActiveElement: active,
      }),
    ).toBe("focusNextFrame");

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(mockHandoffProjectNavigationFromLocalOwner).toHaveBeenCalledWith(
      "focusNextFrame",
      "project-1",
      expect.objectContaining({
        blurActiveElement: active,
        currentFrameId: "frame-b",
        projectActions,
      }),
    );
  });

  it("ignores non-navigation keys and missing project ids", () => {
    mockMatchProjectNavigationCommand.mockReturnValue(undefined);
    const event = {
      key: "j",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };

    expect(
      handleEditableMarkdownProjectNavigationKeydown({
        event,
        projectId: "project-1",
        frameId: "frame-a",
      }),
    ).toBeUndefined();
    expect(mockHandoffProjectNavigationFromLocalOwner).not.toHaveBeenCalled();

    mockMatchProjectNavigationCommand.mockReturnValue("focusNextFrame");
    expect(
      handleEditableMarkdownProjectNavigationKeydown({
        event,
        frameId: "frame-a",
      }),
    ).toBeUndefined();
    expect(mockHandoffProjectNavigationFromLocalOwner).not.toHaveBeenCalled();
  });
});
