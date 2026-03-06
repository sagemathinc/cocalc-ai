/** @jest-environment jsdom */

import {
  FILE_TAB_STRIP_ATTRIBUTE as FILE_TAB_STRIP_ATTR,
  PROJECT_PAGE_ATTRIBUTE,
  focusProjectFileTabStrip,
  getAdjacentOpenFilePath,
  matchProjectNavigationCommand,
  runProjectNavigationCommand,
} from "./keyboard-navigation";

function keydownEvent(
  overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key: "F6",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  } as KeyboardEvent;
}

function setupProjectRoot() {
  const root = document.createElement("div");
  root.setAttribute(PROJECT_PAGE_ATTRIBUTE, "project-1");

  const tabStrip = document.createElement("div");
  tabStrip.setAttribute(FILE_TAB_STRIP_ATTR, "project-1");
  const activeTab = document.createElement("button");
  activeTab.setAttribute("role", "tab");
  activeTab.setAttribute("aria-selected", "true");
  activeTab.textContent = "active";
  tabStrip.appendChild(activeTab);
  root.appendChild(tabStrip);

  const flyout = document.createElement("div");
  flyout.setAttribute("data-cocalc-keyboard-boundary", "flyout");
  const flyoutButton = document.createElement("button");
  flyoutButton.textContent = "flyout";
  flyout.appendChild(flyoutButton);
  root.appendChild(flyout);

  const sideChat = document.createElement("div");
  sideChat.setAttribute("data-cocalc-keyboard-boundary", "side-chat");
  const sideChatButton = document.createElement("button");
  sideChatButton.textContent = "chat";
  sideChat.appendChild(sideChatButton);
  root.appendChild(sideChat);

  document.body.appendChild(root);
  return { activeTab, root, sideChatButton };
}

describe("project keyboard navigation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("chooses adjacent file tabs from the current editor tab", () => {
    expect(
      getAdjacentOpenFilePath(
        ["a.ipynb", "b.ipynb", "c.ipynb"],
        "editor-b.ipynb",
        1,
      ),
    ).toBe("c.ipynb");
    expect(
      getAdjacentOpenFilePath(
        ["a.ipynb", "b.ipynb", "c.ipynb"],
        "editor-a.ipynb",
        -1,
      ),
    ).toBe("c.ipynb");
  });

  it("falls back to the first or last open file from non-editor tabs", () => {
    expect(
      getAdjacentOpenFilePath(["a.ipynb", "b.ipynb"], "files", 1),
    ).toBe("a.ipynb");
    expect(
      getAdjacentOpenFilePath(["a.ipynb", "b.ipynb"], "files", -1),
    ).toBe("b.ipynb");
  });

  it("matches browser-safe navigation bindings", () => {
    expect(matchProjectNavigationCommand(keydownEvent())).toBe("focusNextFrame");
    expect(
      matchProjectNavigationCommand(keydownEvent({ shiftKey: true })),
    ).toBe("focusPreviousFrame");
    expect(
      matchProjectNavigationCommand(keydownEvent({ ctrlKey: true })),
    ).toBe("activateNextFileTab");
    expect(
      matchProjectNavigationCommand(
        keydownEvent({ ctrlKey: true, shiftKey: true }),
      ),
    ).toBe("activatePreviousFileTab");
  });

  it("limits ctrl-tab aliases to the electron host profile", () => {
    expect(
      matchProjectNavigationCommand(
        keydownEvent({ key: "Tab", ctrlKey: true }),
        "browser",
      ),
    ).toBeUndefined();
    expect(
      matchProjectNavigationCommand(
        keydownEvent({ key: "Tab", ctrlKey: true }),
        "electron",
      ),
    ).toBe("activateNextFileTab");
  });

  it("focuses the active tab in the file-tab strip", () => {
    const { activeTab, root } = setupProjectRoot();

    expect(focusProjectFileTabStrip(root)).toBe(true);
    expect(document.activeElement).toBe(activeTab);
  });

  it("cycles editor frames before leaving the editor region", () => {
    setupProjectRoot();
    const setActiveId = jest.fn();

    const handled = runProjectNavigationCommand("focusNextFrame", {
      activeProjectTab: "editor-a.ipynb",
      editorActions: {
        get_active_frame_id: () => "frame-a",
        get_frame_ids_in_order: () => ["frame-a", "frame-b"],
        set_active_id: setActiveId,
      },
      projectRoot: document.body,
    });

    expect(handled).toBe(true);
    expect(setActiveId).toHaveBeenCalledWith("frame-b", true);
  });

  it("moves from the final editor frame to the next visible boundary", () => {
    const { sideChatButton } = setupProjectRoot();
    const setActiveId = jest.fn();

    const handled = runProjectNavigationCommand("focusNextFrame", {
      activeProjectTab: "editor-a.ipynb",
      editorActions: {
        get_active_frame_id: () => "frame-b",
        get_frame_ids_in_order: () => ["frame-a", "frame-b"],
        set_active_id: setActiveId,
      },
      projectRoot: document.body,
    });

    expect(handled).toBe(true);
    expect(setActiveId).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(sideChatButton);
  });

  it("wraps from a boundary back to the tab strip", () => {
    const { activeTab, sideChatButton } = setupProjectRoot();
    sideChatButton.focus();

    const handled = runProjectNavigationCommand("focusNextFrame", {
      activeProjectTab: "editor-a.ipynb",
      editorActions: {
        get_active_frame_id: () => "frame-b",
        get_frame_ids_in_order: () => ["frame-a", "frame-b"],
        set_active_id: jest.fn(),
      },
      projectRoot: document.body,
    });

    expect(handled).toBe(true);
    expect(document.activeElement).toBe(activeTab);
  });

  it("keeps focus in the tab strip after direct file-tab activation from the strip", () => {
    const { activeTab } = setupProjectRoot();
    activeTab.focus();
    const activateNext = jest.fn().mockReturnValue(true);
    const focusStrip = jest.fn().mockReturnValue(true);

    const handled = runProjectNavigationCommand("activateNextFileTab", {
      projectActions: {
        activate_next_file_tab: activateNext,
        focus_file_tab_strip: focusStrip,
      },
      projectRoot: document.body,
    });

    expect(handled).toBe(true);
    expect(activateNext).toHaveBeenCalled();
    expect(focusStrip).toHaveBeenCalled();
  });
});
