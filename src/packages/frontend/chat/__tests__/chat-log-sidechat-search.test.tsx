/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react";
import { ChatLog } from "../chat-log";

const mockScrollToIndex = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (arg1: any, arg2?: string) => {
    if (arg1 === "page" && arg2 === "active_top_tab") {
      return "project-2";
    }
    if (
      typeof arg1 === "object" &&
      arg1?.project_id === "project-1" &&
      arg2 === "active_project_tab"
    ) {
      return "editor-some-other.chat";
    }
    if (arg1 === "account" && arg2 === "account_id") {
      return "acct-1";
    }
    if (arg1 === "users" && arg2 === "user_map") {
      return undefined;
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/components/stateful-virtuoso", () => {
  const React = require("react");
  return React.forwardRef((_props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: mockScrollToIndex,
      scrollIntoView: jest.fn(),
      getState: jest.fn(),
    }));
    return <div data-testid="virtuoso" />;
  });
});

jest.mock("@cocalc/frontend/jupyter/cell-list", () => ({
  DivTempHeight: ({ children }: any) => <>{children}</>,
}));

jest.mock("../drawer-overlay-state", () => ({
  useAnyChatOverlayOpen: () => false,
}));

jest.mock("../message", () => ({
  __esModule: true,
  default: () => <div>message</div>,
}));

jest.mock("../composing", () => ({
  __esModule: true,
  default: () => null,
}));

describe("ChatLog sidechat search jumps", () => {
  beforeEach(() => {
    mockScrollToIndex.mockClear();
  });

  it("scrolls to a search match in sidechat even when it is not the active editor tab", async () => {
    render(
      <ChatLog
        project_id="project-1"
        path=".local/share/cocalc/navigator.chat"
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                sender_id: "acct-1",
                history: [{ content: "first 123 message" }],
              },
            ],
            [
              "2000",
              {
                date: 2000,
                sender_id: "acct-1",
                history: [{ content: "second message" }],
              },
            ],
          ]) as any
        }
        mode="sidechat"
        actions={{} as any}
        selectedThread="thread-1"
        searchJumpDate="1000"
        searchJumpToken={1}
      />,
    );

    await waitFor(() =>
      expect(mockScrollToIndex).toHaveBeenCalledWith({
        index: 0,
        align: "center",
      }),
    );
  });
});
