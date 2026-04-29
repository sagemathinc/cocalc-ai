/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
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

  function lastRenderedMessageProps(messageId: string) {
    for (let i = renderedMessages.length - 1; i >= 0; i -= 1) {
      if (renderedMessages[i].message?.message_id === messageId) {
        return renderedMessages[i];
      }
    }
    return undefined;
  }

  it("renders immediate steer rows inline while the anchored Codex turn is still running", () => {
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

    const userProps = lastRenderedMessageProps("user-1");
    expect(userProps?.attachedSteers).toBeUndefined();
    const assistantProps = lastRenderedMessageProps("assistant-1");
    expect(assistantProps?.expandedCodexActivity).toBe(true);
    expect(assistantProps?.activitySteers).toEqual([
      expect.objectContaining({
        messageId: "steer-1",
        date: 3000,
        text: "actually say hello",
        state: "sending",
      }),
    ]);
  });

  it("attaches steer messages back to the original prompt once the Codex turn is done", () => {
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
                generating: false,
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

    expect(screen.queryByText("Guidance sent")).toBeNull();
    const userProps = lastRenderedMessageProps("user-1");
    expect(userProps?.attachedSteers).toEqual([
      expect.objectContaining({
        messageId: "steer-1",
        date: 3000,
        text: "actually say hello",
        state: "sent",
      }),
      expect.objectContaining({
        messageId: "steer-2",
        date: 4000,
        text: "also add punctuation",
        state: "sent",
      }),
    ]);
  });

  it("keeps steer attached to the assistant turn after completion when that activity stays expanded", () => {
    const messages = new Map([
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
    ]) as any;

    const { rerender } = render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map([["message:steer-1", "sending"]]) as any}
        messages={messages}
      />,
    );

    messages.set("2000", {
      ...messages.get("2000"),
      generating: false,
    });
    messages.set("3000", {
      ...messages.get("3000"),
      acp_state: "sent",
    });

    rerender(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map([["message:steer-1", "sent"]]) as any}
        messages={messages}
      />,
    );

    const userProps = lastRenderedMessageProps("user-1");
    expect(userProps?.attachedSteers).toEqual([]);
    const assistantProps = lastRenderedMessageProps("assistant-1");
    expect(assistantProps?.expandedCodexActivity).toBe(true);
    expect(assistantProps?.activitySteers).toEqual([
      expect.objectContaining({
        messageId: "steer-1",
        date: 3000,
        text: "actually say hello",
        state: "sent",
      }),
    ]);
  });

  it("auto-expands only the newest live assistant turn in a thread", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map([["thread:thread-1", "running"]]) as any}
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                message_id: "user-1",
                thread_id: "thread-1",
                sender_id: "acct-1",
                history: [{ content: "first prompt" }],
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
                generating: false,
                history: [{ content: "first answer" }],
              },
            ],
            [
              "3000",
              {
                date: 3000,
                message_id: "user-2",
                thread_id: "thread-1",
                sender_id: "acct-1",
                history: [{ content: "second prompt" }],
              },
            ],
            [
              "4000",
              {
                date: 4000,
                message_id: "assistant-2",
                thread_id: "thread-1",
                parent_message_id: "user-2",
                sender_id: "acct-codex",
                acp_account_id: "acct-codex",
                generating: true,
                history: [{ content: "second answer" }],
              },
            ],
          ]) as any
        }
      />,
    );

    expect(lastRenderedMessageProps("assistant-1")?.expandedCodexActivity).toBe(
      false,
    );
    expect(lastRenderedMessageProps("assistant-2")?.expandedCodexActivity).toBe(
      true,
    );
  });
});
