/** @jest-environment jsdom */

import { render } from "@testing-library/react";
import { ChatLog } from "../chat-log";

let renderedMessages: any[] = [];

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (arg1: any, arg2?: string) => {
    if (arg1 === "page" && arg2 === "active_top_tab") {
      return "project-1";
    }
    if (
      typeof arg1 === "object" &&
      arg1?.project_id === "project-1" &&
      arg2 === "active_project_tab"
    ) {
      return "editor-thread.chat";
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
  return React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: jest.fn(),
      scrollIntoView: jest.fn(),
      getState: jest.fn(),
    }));
    return (
      <div data-testid="virtuoso">
        {Array.from({ length: props.totalCount ?? 0 }, (_, index) => (
          <div key={index}>{props.itemContent?.(index)}</div>
        ))}
      </div>
    );
  });
});

jest.mock("@cocalc/frontend/jupyter/div-temp-height", () => ({
  DivTempHeight: ({ children }: any) => <>{children}</>,
}));

jest.mock("../drawer-overlay-state", () => ({
  setChatOverlayOpen: jest.fn(),
  useAnyChatOverlayOpen: () => false,
}));

jest.mock("../message", () => ({
  __esModule: true,
  default: (props: any) => {
    renderedMessages.push(props);
    return <div>{props.message?.message_id ?? "message"}</div>;
  },
}));

jest.mock("../composing", () => ({
  __esModule: true,
  default: () => null,
}));

describe("ChatLog immediate steer rendering", () => {
  beforeEach(() => {
    renderedMessages = [];
  });

  it("hides immediate steer rows and attaches their state to the original user prompt", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map([["message:steer-1", "sending"]]) as any}
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                message_id: "user-1",
                thread_id: "thread-1",
                sender_id: "acct-1",
                history: [{ content: "say hi" }],
              },
            ],
            [
              "2000",
              {
                date: 2000,
                message_id: "assistant-1",
                thread_id: "thread-1",
                parent_message_id: "user-1",
                sender_id: "acct-codex",
                acp_account_id: "acct-codex",
                generating: true,
                history: [{ content: "hello" }],
              },
            ],
            [
              "3000",
              {
                date: 3000,
                message_id: "steer-1",
                thread_id: "thread-1",
                sender_id: "acct-1",
                acp_send_mode: "immediate",
                parent_message_id: "assistant-1",
                history: [{ content: "actually say hello" }],
              },
            ],
          ]) as any
        }
      />,
    );

    expect(renderedMessages).toHaveLength(2);
    expect(
      renderedMessages.find((props) => props.message?.message_id === "steer-1"),
    ).toBeUndefined();

    const userProps = renderedMessages.find(
      (props) => props.message?.message_id === "user-1",
    );
    expect(userProps?.attachedSteers).toEqual([
      {
        messageId: "steer-1",
        date: 3000,
        text: "actually say hello",
        state: "sending",
      },
    ]);
  });

  it("attaches later steer messages to the original prompt even when they reply to an earlier steer", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={
          new Map([
            ["message:steer-1", "sent"],
            ["message:steer-2", "sent"],
          ]) as any
        }
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                message_id: "user-1",
                thread_id: "thread-1",
                sender_id: "acct-1",
                history: [{ content: "say hi" }],
              },
            ],
            [
              "2000",
              {
                date: 2000,
                message_id: "assistant-1",
                thread_id: "thread-1",
                parent_message_id: "user-1",
                sender_id: "acct-codex",
                acp_account_id: "acct-codex",
                generating: true,
                history: [{ content: "hello" }],
              },
            ],
            [
              "3000",
              {
                date: 3000,
                message_id: "steer-1",
                thread_id: "thread-1",
                sender_id: "acct-1",
                acp_send_mode: "immediate",
                parent_message_id: "assistant-1",
                acp_state: "sent",
                history: [{ content: "actually say hello" }],
              },
            ],
            [
              "4000",
              {
                date: 4000,
                message_id: "steer-2",
                thread_id: "thread-1",
                sender_id: "acct-1",
                acp_send_mode: "immediate",
                parent_message_id: "steer-1",
                acp_state: "sent",
                history: [{ content: "also add punctuation" }],
              },
            ],
          ]) as any
        }
      />,
    );

    const userProps = renderedMessages.find(
      (props) => props.message?.message_id === "user-1",
    );
    expect(userProps?.attachedSteers).toEqual([
      {
        messageId: "steer-1",
        date: 3000,
        text: "actually say hello",
        state: "sent",
      },
      {
        messageId: "steer-2",
        date: 4000,
        text: "also add punctuation",
        state: "sent",
      },
    ]);
  });
});
