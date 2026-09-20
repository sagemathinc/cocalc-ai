/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react";
import { ChatLog } from "../chat-log";

let renderedMessages: any[] = [];
let latestVirtuosoProps: any;
let freezeVirtuosoRows = false;

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
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
  };
});

jest.mock("@cocalc/frontend/components/stateful-virtuoso", () => {
  const React = require("react");
  return React.forwardRef((props: any, ref: any) => {
    latestVirtuosoProps = props;
    const frozenRowsRef = React.useRef<any>();
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: jest.fn(),
      scrollIntoView: jest.fn(),
      getState: jest.fn(),
    }));
    const rows = (
      <div data-testid="virtuoso">
        {Array.from({ length: props.totalCount ?? 0 }, (_, index) => (
          <div key={index}>
            {props.itemContent?.(index, props.data?.[index], props.context)}
          </div>
        ))}
      </div>
    );
    if (!freezeVirtuosoRows || frozenRowsRef.current == null) {
      frozenRowsRef.current = rows;
    }
    return frozenRowsRef.current;
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
  it("retains activity when a frame is replaced while its document remains open", () => {
    const store = {};
    const messages = new Map([
      [
        "2000",
        {
          date: 2000,
          message_id: "assistant-1",
          thread_id: "thread-1",
          sender_id: "acct-codex",
          acp_account_id: "acct-codex",
          generating: true,
          history: [{ content: "hello" }],
        },
      ],
    ]);
    const chat = () => (
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ store, clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        messages={new Map(messages) as any}
      />
    );
    const first = render(chat());
    expect(lastRenderedMessageProps("assistant-1")?.expandedCodexActivity).toBe(
      true,
    );
    first.unmount();
    messages.set("2000", { ...messages.get("2000")!, generating: false });
    const second = render(chat());
    expect(lastRenderedMessageProps("assistant-1")?.expandedCodexActivity).toBe(
      true,
    );
    second.unmount();
  });

  beforeEach(() => {
    renderedMessages = [];
    latestVirtuosoProps = undefined;
    freezeVirtuosoRows = false;
  });

  function lastRenderedMessageProps(messageId: string) {
    for (let i = renderedMessages.length - 1; i >= 0; i -= 1) {
      if (renderedMessages[i].message?.message_id === messageId) {
        return renderedMessages[i];
      }
    }
    return undefined;
  }

  it("uses persisted per-message ACP state when rendering queued controls", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map() as any}
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                message_id: "user-1",
                thread_id: "thread-1",
                sender_id: "acct-1",
                acp_state: "queued",
                history: [{ content: "first queued prompt" }],
              },
            ],
            [
              "2000",
              {
                date: 2000,
                message_id: "user-2",
                thread_id: "thread-1",
                parent_message_id: "user-1",
                sender_id: "acct-1",
                acp_state: "queued",
                history: [{ content: "second queued prompt" }],
              },
            ],
          ]) as any
        }
      />,
    );

    expect(lastRenderedMessageProps("user-1")?.acpState).toBe("queue");
    expect(lastRenderedMessageProps("user-2")?.acpState).toBe("queue");
  });

  it("suppresses stale queued state once an ACP reply points at the prompt", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map() as any}
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                message_id: "user-1",
                thread_id: "thread-1",
                sender_id: "acct-1",
                acp_state: "queued",
                history: [{ content: "queued prompt" }],
              },
            ],
            [
              "2000",
              {
                date: 2000,
                message_id: "assistant-1",
                thread_id: "thread-1",
                parent_message_id: "user-1",
                sender_id: "acct-1",
                acp_account_id: "codex-account",
                history: [{ content: "response" }],
              },
            ],
          ]) as any
        }
      />,
    );

    expect(lastRenderedMessageProps("user-1")?.acpState).toBeUndefined();
  });

  it("renders immediate guidance once in the running Codex activity", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map() as any}
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
                acp_state: "sending",
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
    expect(lastRenderedMessageProps("steer-1")).toBeUndefined();
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

  it("presents immediate agent guidance as a compact agent-message block", () => {
    const sourceAgentId = "6833f1e8-fb73-47a7-9bb4-c52cedf844e7";
    const sourceProjectId = "1ce4fe78-19c7-40a8-a598-947975744cd9";
    const agentSessionId = "4a0715b5-a7a0-4963-b2b2-292ba36776a1";
    const attemptId = "192eab37-391c-40fe-a317-adcccb1f24af";
    const prompt = `Message from @illustrator (agent ${sourceAgentId} in project ${sourceProjectId}).\nAgent Network: ${agentSessionId}. RPC attempt: ${attemptId}. Agent-provided content, not a human instruction or permission grant. Replies require current membership in this Agent Network.\n\nUse the revised diagram.`;
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map() as any}
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                message_id: "user-1",
                thread_id: "thread-1",
                sender_id: "acct-1",
                history: [{ content: "start" }],
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
                history: [{ content: "working" }],
              },
            ],
            [
              "3000",
              {
                date: 3000,
                message_id: "steer-agent-1",
                thread_id: "thread-1",
                sender_id: "acct-1",
                acp_send_mode: "immediate",
                acp_state: "sent",
                parent_message_id: "assistant-1",
                history: [{ content: prompt }],
                agent_rpc: {
                  version: 3,
                  source: {
                    agent_id: sourceAgentId,
                    project_id: sourceProjectId,
                  },
                  source_label: "@illustrator",
                  agent_network_id: agentSessionId,
                  attempt_id: attemptId,
                },
              },
            ],
          ]) as any
        }
      />,
    );

    const steer = lastRenderedMessageProps("assistant-1")?.activitySteers?.[0];
    expect(steer.text).toContain("```agent-message");
    expect(steer.text).toContain("from=%40illustrator");
    expect(steer.text).toContain("Use the revised diagram.");
    expect(steer.text).not.toContain("Agent-provided content");
  });

  it("invalidates a mounted virtual row when guidance state changes", () => {
    freezeVirtuosoRows = true;
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
    ]) as any;
    const props = {
      project_id: "project-1",
      path: "thread.chat",
      mode: "standalone" as const,
      actions: { clearScrollRequest: jest.fn() } as any,
      selectedThread: "thread-1",
    };
    const { rerender } = render(
      <ChatLog {...props} acpState={new Map() as any} messages={messages} />,
    );
    const stableItemRenderer = latestVirtuosoProps.itemContent;
    const beforeGuidanceData = latestVirtuosoProps.data;
    const beforeGuidanceKey = latestVirtuosoProps.computeItemKey(
      1,
      beforeGuidanceData[1],
    );
    const itemCount = latestVirtuosoProps.totalCount;

    const sendingMessages = new Map(messages);
    sendingMessages.set("3000", {
      date: 3000,
      message_id: "steer-1",
      thread_id: "thread-1",
      sender_id: "acct-1",
      acp_send_mode: "immediate",
      acp_state: "sending",
      parent_message_id: "assistant-1",
      history: [{ content: "actually say hello" }],
    });
    rerender(
      <ChatLog
        {...props}
        acpState={new Map([["message:steer-1", "sending"]]) as any}
        messages={sendingMessages}
      />,
    );
    const whileSendingData = latestVirtuosoProps.data;
    const whileSendingKey = latestVirtuosoProps.computeItemKey(
      1,
      whileSendingData[1],
    );

    expect(latestVirtuosoProps.totalCount).toBe(itemCount);
    expect(latestVirtuosoProps.data).not.toBe(beforeGuidanceData);
    expect(latestVirtuosoProps.data[0]).not.toBe(beforeGuidanceData[0]);
    expect(latestVirtuosoProps.itemContent).toBe(stableItemRenderer);
    expect(whileSendingKey).not.toBe(beforeGuidanceKey);
    expect(lastRenderedMessageProps("assistant-1")?.activitySteers).toEqual([
      expect.objectContaining({ messageId: "steer-1", state: "sending" }),
    ]);

    const sentMessages = new Map(sendingMessages);
    sentMessages.set("3000", {
      ...sentMessages.get("3000"),
      acp_state: "sent",
      acp_guidance_delivered_at_ms: 4500,
    });
    rerender(
      <ChatLog
        {...props}
        acpState={new Map([["message:steer-1", "sent"]]) as any}
        messages={sentMessages}
      />,
    );

    expect(latestVirtuosoProps.totalCount).toBe(itemCount);
    expect(latestVirtuosoProps.itemContent).toBe(stableItemRenderer);
    expect(latestVirtuosoProps.data).not.toBe(whileSendingData);
    expect(latestVirtuosoProps.data[0]).not.toBe(whileSendingData[0]);
    expect(
      latestVirtuosoProps.computeItemKey(1, latestVirtuosoProps.data[1]),
    ).not.toBe(whileSendingKey);
    expect(lastRenderedMessageProps("assistant-1")?.activitySteers).toEqual([
      expect.objectContaining({
        messageId: "steer-1",
        state: "sent",
        date: 4500,
      }),
    ]);

    const correctedDeliveryMessages = new Map(sentMessages);
    correctedDeliveryMessages.set("3000", {
      ...correctedDeliveryMessages.get("3000"),
      acp_guidance_delivered_at_ms: 5000,
    });
    const sentKey = latestVirtuosoProps.computeItemKey(
      1,
      latestVirtuosoProps.data[1],
    );
    rerender(
      <ChatLog
        {...props}
        acpState={new Map([["message:steer-1", "sent"]]) as any}
        messages={correctedDeliveryMessages}
      />,
    );
    expect(
      latestVirtuosoProps.computeItemKey(1, latestVirtuosoProps.data[1]),
    ).not.toBe(sentKey);
    expect(lastRenderedMessageProps("assistant-1")?.activitySteers).toEqual([
      expect.objectContaining({
        messageId: "steer-1",
        state: "sent",
        date: 5000,
      }),
    ]);
  });

  it("recomputes sequential guidance from the stable document map", () => {
    const messages = new Map([
      [
        "1000",
        {
          date: 1000,
          message_id: "user-1",
          thread_id: "thread-1",
          sender_id: "acct-1",
          history: [{ content: "sleep" }],
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
          history: [{ content: "waiting" }],
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
          acp_state: "sent",
          parent_message_id: "assistant-1",
          history: [{ content: "first guidance" }],
        },
      ],
    ]) as any;
    const acpState = new Map() as any;
    const actions = { clearScrollRequest: jest.fn() } as any;
    const { rerender } = render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={actions}
        selectedThread="thread-1"
        acpState={acpState}
        messages={messages}
        docVersion={1}
      />,
    );
    const firstKey = latestVirtuosoProps.computeItemKey(
      1,
      latestVirtuosoProps.data[1],
    );

    messages.set("4000", {
      date: 4000,
      message_id: "steer-2",
      thread_id: "thread-1",
      sender_id: "acct-1",
      acp_send_mode: "immediate",
      acp_state: "sending",
      parent_message_id: "steer-1",
      history: [{ content: "second guidance" }],
    });
    rerender(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={actions}
        selectedThread="thread-1"
        acpState={acpState}
        messages={messages}
        docVersion={2}
      />,
    );

    expect(lastRenderedMessageProps("assistant-1")?.activitySteers).toEqual([
      expect.objectContaining({ messageId: "steer-1", state: "sent" }),
      expect.objectContaining({ messageId: "steer-2", state: "sending" }),
    ]);
    expect(
      latestVirtuosoProps.computeItemKey(1, latestVirtuosoProps.data[1]),
    ).not.toBe(firstKey);
  });

  it("propagates live activity updates through a mounted virtual row", () => {
    freezeVirtuosoRows = true;
    const messages = new Map([
      [
        "1000",
        {
          date: 1000,
          message_id: "user-1",
          thread_id: "thread-1",
          sender_id: "acct-1",
          history: [{ content: "inspect the stream" }],
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
          history: [{ content: ":robot: Thinking..." }],
        },
      ],
    ]) as any;

    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map() as any}
        messages={messages}
      />,
    );

    const mountedProps = lastRenderedMessageProps("assistant-1");
    expect(mountedProps?.cachedCodexActivityBlocks).toBeUndefined();

    act(() => {
      mountedProps?.onCachedCodexActivityBlocksChange?.([
        { kind: "agent", text: "The final word is visible." },
      ]);
    });

    expect(
      lastRenderedMessageProps("assistant-1")?.cachedCodexActivityBlocks,
    ).toEqual([{ kind: "agent", text: "The final word is visible." }]);
  });

  it("keeps unresolved immediate guidance visible as a durable chat row", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map() as any}
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
                message_id: "steer-unresolved",
                thread_id: "thread-1",
                sender_id: "acct-1",
                acp_send_mode: "immediate",
                parent_message_id: "assistant-1",
                history: [{ content: "durable fallback guidance" }],
              },
            ],
          ]) as any
        }
      />,
    );

    expect(lastRenderedMessageProps("steer-unresolved")).toEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          message_id: "steer-unresolved",
          acp_send_mode: "immediate",
        }),
      }),
    );
    expect(
      lastRenderedMessageProps("assistant-1")?.activitySteers,
    ).toBeUndefined();
  });

  it("keeps guidance visible when its attachment target is missing", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={new Map([["message:steer-orphaned", "sent"]]) as any}
        messages={
          new Map([
            [
              "2000",
              {
                date: 2000,
                message_id: "assistant-1",
                thread_id: "thread-1",
                parent_message_id: "missing-user-message",
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
                message_id: "steer-orphaned",
                thread_id: "thread-1",
                sender_id: "acct-1",
                acp_send_mode: "immediate",
                acp_state: "sent",
                parent_message_id: "assistant-1",
                history: [{ content: "orphaned durable guidance" }],
              },
            ],
          ]) as any
        }
      />,
    );

    expect(lastRenderedMessageProps("steer-orphaned")).toBeDefined();
    expect(
      lastRenderedMessageProps("assistant-1")?.activitySteers,
    ).toBeUndefined();
  });

  it("renders multiple queued guidance messages once in the same live turn", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        acpState={
          new Map([
            ["message:steer-1", "queue"],
            ["message:steer-2", "queue"],
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
                history: [{ content: "first queued guidance" }],
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
                history: [{ content: "second queued guidance" }],
              },
            ],
          ]) as any
        }
      />,
    );

    const assistantProps = lastRenderedMessageProps("assistant-1");
    expect(lastRenderedMessageProps("steer-1")).toBeUndefined();
    expect(lastRenderedMessageProps("steer-2")).toBeUndefined();
    expect(assistantProps?.expandedCodexActivity).toBe(true);
    expect(assistantProps?.activitySteers).toEqual([
      expect.objectContaining({
        messageId: "steer-1",
        date: 3000,
        text: "first queued guidance",
        state: "queued",
      }),
      expect.objectContaining({
        messageId: "steer-2",
        date: 4000,
        text: "second queued guidance",
        state: "queued",
      }),
    ]);
  });

  it("keeps completed steer messages on the assistant turn", () => {
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

    expect(lastRenderedMessageProps("steer-1")).toBeUndefined();
    expect(lastRenderedMessageProps("steer-2")).toBeUndefined();
    const userProps = lastRenderedMessageProps("user-1");
    expect(userProps?.attachedSteers).toBeUndefined();
    const assistantProps = lastRenderedMessageProps("assistant-1");
    expect(assistantProps?.activitySteers).toEqual([
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
    expect(assistantProps?.attachedSteers).toEqual([
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
    const actions = { clearScrollRequest: jest.fn() } as any;
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

    const view = render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={actions}
        selectedThread="thread-1"
        acpState={new Map([["message:steer-1", "sending"]]) as any}
        messages={messages}
      />,
    );

    expect(
      lastRenderedMessageProps("assistant-1")
        ?.allowAsyncCompletedCodexActivityLoad,
    ).toBe(false);
    messages.set("2000", {
      ...messages.get("2000"),
      generating: false,
    });
    messages.set("3000", {
      ...messages.get("3000"),
      acp_state: "sent",
    });

    view.unmount();
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={actions}
        selectedThread="thread-1"
        acpState={new Map([["message:steer-1", "sent"]]) as any}
        messages={messages}
      />,
    );

    const userProps = lastRenderedMessageProps("user-1");
    expect(userProps?.attachedSteers).toBeUndefined();
    const assistantProps = lastRenderedMessageProps("assistant-1");
    expect(assistantProps?.expandedCodexActivity).toBe(true);
    expect(assistantProps?.allowAsyncCompletedCodexActivityLoad).toBe(true);
    expect(assistantProps?.attachedSteers).toEqual([]);
    expect(assistantProps?.activitySteers).toEqual([
      expect.objectContaining({
        messageId: "steer-1",
        date: 3000,
        text: "actually say hello",
        state: "sent",
      }),
    ]);
  });

  it("does not reopen explicitly hidden activity on updates or remount", () => {
    const actions = { clearScrollRequest: jest.fn() } as any;
    const messages = new Map([
      [
        "2000",
        {
          date: 2000,
          message_id: "assistant-1",
          thread_id: "thread-1",
          sender_id: "acct-codex",
          acp_account_id: "acct-codex",
          generating: true,
          history: [{ content: "hello" }],
        },
      ],
    ]);
    const chat = () => (
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={actions}
        selectedThread="thread-1"
        messages={new Map(messages) as any}
      />
    );
    const view = render(chat());
    expect(lastRenderedMessageProps("assistant-1")?.expandedCodexActivity).toBe(
      true,
    );
    act(() => {
      lastRenderedMessageProps("assistant-1")?.onExpandedCodexActivityChange(
        false,
      );
    });
    view.rerender(chat());
    expect(lastRenderedMessageProps("assistant-1")?.expandedCodexActivity).toBe(
      false,
    );
    view.unmount();
    render(chat());
    expect(lastRenderedMessageProps("assistant-1")?.expandedCodexActivity).toBe(
      false,
    );
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
