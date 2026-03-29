/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ChatRoomModals, getDefaultForkName } from "../chatroom-modals";

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    useCallback: React.useCallback,
    useEffect: React.useEffect,
    useMemo: React.useMemo,
    useState: React.useState,
  };
});

jest.mock("@cocalc/frontend/project/workspaces/chat-defaults", () => ({
  defaultWorkingDirectoryForChat: () => "/home/wstein",
  useWorkspaceChatWorkingDirectory: () => undefined,
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({ project_id: "project-1" }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  ThemeEditorModal: () => null,
}));

jest.mock("@cocalc/frontend/components/help-icon", () => ({
  HelpIcon: ({ children }) => <>{children}</>,
}));

jest.mock("../thread-image-upload", () => ({
  ThreadImageUpload: () => null,
}));

describe("chatroom fork modal defaults", () => {
  it("builds the initial fork title without a follow-up effect", () => {
    expect(getDefaultForkName("Original chat")).toBe("Fork of Original chat");
    expect(getDefaultForkName("  Original chat  ")).toBe(
      "Fork of Original chat",
    );
    expect(getDefaultForkName("")).toBe("Fork of chat");
    expect(getDefaultForkName(undefined)).toBe("Fork of chat");
  });

  it("disables the fork confirm action while a fork is already running", async () => {
    let resolveFork: (() => void) | undefined;
    const forkPromise = new Promise<void>((resolve) => {
      resolveFork = resolve;
    });
    const actions: any = {
      forkThread: jest.fn(() => forkPromise),
      getThreadMetadata: jest.fn(() => ({})),
    };
    let handlers: any;

    render(
      <ChatRoomModals
        actions={actions}
        path="project/chat/test.chat"
        onHandlers={(next) => {
          handlers = next;
        }}
      />,
    );

    await waitFor(() => expect(handlers?.openForkModal).toBeDefined());

    act(() => {
      handlers.openForkModal("thread-1", "Original chat", true);
    });

    const forkButton = await screen.findByRole("button", { name: "Fork" });
    fireEvent.click(forkButton);

    await waitFor(() => {
      expect(actions.forkThread).toHaveBeenCalledTimes(1);
      expect((forkButton as HTMLButtonElement).disabled).toBe(true);
    });

    fireEvent.click(forkButton);
    expect(actions.forkThread).toHaveBeenCalledTimes(1);

    resolveFork?.();

    await waitFor(() => {
      expect(screen.queryByText("Fork chat")).toBeNull();
    });
  });
});
