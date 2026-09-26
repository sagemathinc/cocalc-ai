/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react";
import { ChatLog } from "../chat-log";
import { getLiveResponseBlocks } from "@cocalc/chat";
import { fromJS } from "immutable";

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

jest.mock("../codex-attention-card", () => ({
  CodexAttentionCard: ({ initialRecord }: any) => (
    <section aria-label={`Question ${initialRecord.attention_id}`} />
  ),
}));

describe("ChatLog immediate steer rendering", () => {
  it("caps and centers message rows on wide viewports", () => {
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        actions={{ store: {}, clearScrollRequest: jest.fn() } as any}
        messages={
          new Map([
            [
              "2000",
              {
                date: 2000,
                message_id: "reading-width-message",
                sender_id: "acct-codex",
                history: [{ content: "A message" }],
              },
            ],
          ]) as any
        }
      />,
    );

    const row = screen.getByText("reading-width-message").parentElement;
    expect(row).toHaveStyle({ maxWidth: "1040px", width: "100%" });
    expect(row?.style.marginInline).toBe("auto");
  });

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

  function midturnMessages() {
    return new Map<string, any>([
      [
        "1000",
        {
          date: 1000,
          message_id: "user-1",
          thread_id: "thread-1",
          sender_id: "acct-1",
          history: [{ content: "Work" }],
        },
      ],
      [
        "2000",
        {
          date: 2000,
          message_id: "assistant-1",
          thread_id: "thread-1",
          parent_message_id: "user-1",
          sender_id: "codex",
          acp_account_id: "codex",
          generating: true,
          history: [{ content: "Working" }],
        },
      ],
      [
        "3000",
        {
          date: 3000,
          message_id: "network-1",
          thread_id: "thread-1",
          parent_message_id: "assistant-1",
          sender_id: "acct-1",
          agent_rpc_launch: fromJS({ state: "accepted", updated_at: 3001 }),
          agent_rpc: fromJS({
            source: { agent_id: "agent-1", project_id: "peer-project" },
            source_label: "@reviewer",
          }),
          history: [{ content: "Review ready" }],
        },
      ],
      [
        "4000",
        {
          date: 4000,
          message_id: "answer-1",
          thread_id: "thread-1",
          parent_message_id: "network-1",
          sender_id: "acct-1",
          history: [
            {
              content:
                "Answer to the earlier Codex question:\n\nPlan: " +
                "Detailed answer. ".repeat(100),
            },
          ],
        },
      ],
      [
        "5000",
        {
          date: 5000,
          message_id: "network-2",
          thread_id: "thread-1",
          parent_message_id: "answer-1",
          sender_id: "acct-1",
          agent_rpc_launch: { state: "accepted", updated_at: 5001 },
          agent_rpc: {
            source: { agent_id: "agent-2", project_id: "peer-project" },
            source_label: "@writer",
          },
          history: [{ content: "Draft ready" }],
        },
      ],
    ]);
  }

  function midturnChat(messages: Map<string, any>, extra: any = {}) {
    return (
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        mode="standalone"
        selectedThread="thread-1"
        actions={{ clearScrollRequest: jest.fn() } as any}
        messages={messages as any}
        {...extra}
      />
    );
  }

  it("intermixes durable network messages and a long Q&A answer chronologically without duplicate rows", () => {
    const messages = midturnMessages();
    const view = render(midturnChat(messages));
    const steers = lastRenderedMessageProps("assistant-1").activitySteers;
    expect(
      steers.map(({ messageId, date, state }) => ({ messageId, date, state })),
    ).toEqual([
      { messageId: "network-1", date: 3000, state: "saved" },
      { messageId: "answer-1", date: 4000, state: "saved" },
      { messageId: "network-2", date: 5000, state: "saved" },
    ]);
    for (const id of ["network-1", "answer-1", "network-2"])
      expect(screen.queryByText(id)).not.toBeInTheDocument();
    expect(steers[0].text).toContain("source=agent-1 project=peer-project");
    expect(steers[0].text).toContain("from=%40reviewer");
    expect(steers[1].text).toBe(messages.get("4000").history[0].content.trim());
    const blocks = getLiveResponseBlocks(
      [
        {
          type: "event",
          seq: 1,
          time: 2500,
          event: { type: "message", text: "Before", role: "assistant" },
        },
        {
          type: "event",
          seq: 2,
          time: 4500,
          event: { type: "message", text: "Between", role: "assistant" },
        },
        {
          type: "event",
          seq: 3,
          time: 6000,
          event: { type: "message", text: "After", role: "assistant" },
        },
      ] as any,
      steers,
    );
    expect(blocks.map(({ time }) => time)).toEqual([
      2500, 3000, 4000, 4500, 5000, 6000,
    ]);
    view.rerender(midturnChat(new Map([...messages].reverse())));
    expect(lastRenderedMessageProps("assistant-1").activitySteers).toEqual(
      steers,
    );
    expect(messages.size).toBe(5);
  });

  it.each(["pending", "unknown", "rejected"])(
    "keeps %s network launch receipts standalone with recovery",
    (state) => {
      const messages = midturnMessages();
      messages.set("3000", {
        ...messages.get("3000"),
        acp_send_mode: "immediate",
        acp_state: "sent",
        agent_rpc_launch: fromJS({
          state,
          updated_at: 3001,
          error: "launch unconfirmed",
        }),
      });
      render(midturnChat(messages));
      expect(screen.getByText("network-1")).toBeInTheDocument();
      expect(
        lastRenderedMessageProps("network-1").message.agent_rpc_launch.get(
          "state",
        ),
      ).toBe(state);
      expect(
        lastRenderedMessageProps("assistant-1").activitySteers.map(
          ({ messageId }) => messageId,
        ),
      ).toEqual(["network-1", "answer-1", "network-2"]);
      expect(lastRenderedMessageProps("network-1").compactActivityMessage).toBe(
        true,
      );
      expect(
        lastRenderedMessageProps("assistant-1").activitySteers[0].state,
      ).toBe("saved");
    },
  );

  it("uses delivered evidence rather than RPC launch acceptance or a saved row", () => {
    const messages = midturnMessages();
    messages.set("3000", {
      ...messages.get("3000"),
      acp_send_mode: "immediate",
      acp_state: "sent",
    });
    const view = render(midturnChat(messages));
    expect(
      lastRenderedMessageProps("assistant-1").activitySteers[0].state,
    ).toBe("saved");
    messages.set("3000", {
      ...messages.get("3000"),
      acp_guidance_delivered_at_ms: 3500,
    });
    view.rerender(midturnChat(new Map(messages)));
    expect(lastRenderedMessageProps("assistant-1").activitySteers[0]).toEqual(
      expect.objectContaining({
        messageId: "network-1",
        state: "sent",
        date: 3500,
      }),
    );
  });

  it("restores ordinary standalone history when the owning turn completes", () => {
    const messages = midturnMessages();
    const view = render(midturnChat(messages));
    messages.set("2000", { ...messages.get("2000"), generating: false });
    view.rerender(
      midturnChat(new Map(messages), {
        acpState: new Map([["thread:thread-1", "running"]]),
      }),
    );
    for (const id of ["network-1", "answer-1", "network-2"])
      expect(screen.getByText(id)).toBeInTheDocument();
    expect(
      lastRenderedMessageProps("assistant-1").activitySteers,
    ).toBeUndefined();
  });

  it("keeps a completed mixed timeline together across hide, reopen, and reload", () => {
    const messages = midturnMessages();
    messages.set("3500", {
      date: 3500,
      message_id: "guidance-1",
      thread_id: "thread-1",
      parent_message_id: "network-1",
      sender_id: "acct-1",
      acp_send_mode: "immediate",
      acp_state: "sent",
      history: [{ content: "Human guidance" }],
    });
    const actions = { store: {}, clearScrollRequest: jest.fn() } as any;
    const view = render(midturnChat(messages, { actions }));
    messages.set("2000", {
      ...messages.get("2000"),
      generating: false,
      history: [
        {
          content: "Final answer",
          date: new Date(6000),
          author_id: "openai-codex-agent",
        },
      ],
    });
    view.rerender(midturnChat(new Map(messages), { actions }));
    const ids = ["network-1", "guidance-1", "answer-1", "network-2"];
    expect(
      lastRenderedMessageProps("assistant-1").activitySteers.map(
        ({ messageId }) => messageId,
      ),
    ).toEqual(ids);
    act(() =>
      lastRenderedMessageProps("assistant-1").onExpandedCodexActivityChange(
        false,
      ),
    );
    expect(lastRenderedMessageProps("assistant-1").expandedCodexActivity).toBe(
      false,
    );
    expect(
      lastRenderedMessageProps("assistant-1").attachedSteers,
    ).toBeUndefined();
    expect(
      lastRenderedMessageProps("assistant-1").message.history[0].content,
    ).toBe("Final answer");
    for (const id of ids)
      expect(screen.queryByText(id)).not.toBeInTheDocument();
    act(() =>
      lastRenderedMessageProps("assistant-1").onExpandedCodexActivityChange(
        true,
      ),
    );
    expect(lastRenderedMessageProps("assistant-1").expandedCodexActivity).toBe(
      true,
    );
    expect(
      lastRenderedMessageProps("assistant-1").activitySteers.map(
        ({ messageId }) => messageId,
      ),
    ).toEqual(ids);
    view.unmount();
    render(
      midturnChat(new Map([...messages].reverse()), {
        actions: { store: {}, clearScrollRequest: jest.fn() },
      }),
    );
    expect(
      lastRenderedMessageProps("assistant-1").activitySteers.map(
        ({ messageId }) => messageId,
      ),
    ).toEqual(ids);
    for (const id of ids)
      expect(screen.queryByText(id)).not.toBeInTheDocument();
  });

  it("keeps post-completion messages out of the previous activity and preserves failed recovery", () => {
    const messages = midturnMessages();
    messages.set("2000", {
      ...messages.get("2000"),
      generating: false,
      history: [
        { content: "Final", date: 6000, author_id: "openai-codex-agent" },
      ],
    });
    messages.set("3000", {
      ...messages.get("3000"),
      agent_rpc_launch: { state: "rejected", updated_at: 3000 },
    });
    messages.set("7000", {
      date: 7000,
      message_id: "later-prompt",
      thread_id: "thread-1",
      parent_message_id: "network-2",
      sender_id: "acct-1",
      history: [{ content: "After the turn" }],
    });
    render(midturnChat(messages));
    expect(screen.getByText("later-prompt")).toBeInTheDocument();
    expect(screen.queryByText("network-1")).not.toBeInTheDocument();
    act(() =>
      lastRenderedMessageProps("assistant-1").onExpandedCodexActivityChange(
        true,
      ),
    );
    expect(screen.getByText("network-1")).toBeInTheDocument();
    expect(lastRenderedMessageProps("network-1").compactActivityMessage).toBe(
      true,
    );
    expect(
      lastRenderedMessageProps("assistant-1").attachedSteers,
    ).toBeUndefined();
    expect(
      lastRenderedMessageProps("assistant-1").activitySteers.map(
        ({ messageId }) => messageId,
      ),
    ).toEqual(["network-1", "answer-1", "network-2"]);
    act(() =>
      lastRenderedMessageProps("assistant-1").onExpandedCodexActivityChange(
        false,
      ),
    );
    expect(screen.queryByText("network-1")).not.toBeInTheDocument();
  });

  it("does not fold a post-turn prompt after a later manual edit to the final answer", () => {
    const messages = midturnMessages();
    messages.set("2000", {
      ...messages.get("2000"),
      generating: false,
      history: [
        { content: "Manual correction", author_id: "acct-1", date: 9000 },
        {
          content: "Original final answer",
          author_id: "openai-codex-agent",
          date: 6000,
        },
      ],
    });
    messages.set("7000", {
      date: 7000,
      message_id: "later-prompt",
      thread_id: "thread-1",
      parent_message_id: "network-2",
      sender_id: "acct-1",
      history: [{ content: "After the turn" }],
    });
    const view = render(midturnChat(messages));
    expect(screen.getByText("later-prompt")).toBeInTheDocument();
    expect(
      lastRenderedMessageProps("assistant-1").activitySteers.map(
        ({ messageId }) => messageId,
      ),
    ).toEqual(["network-1", "answer-1", "network-2"]);
    messages.set("2000", {
      ...messages.get("2000"),
      history: [
        {
          content: "Only a manual edit remains",
          author_id: "acct-1",
          date: 9000,
        },
      ],
    });
    view.rerender(midturnChat(new Map(messages)));
    expect(screen.getByText("later-prompt")).toBeInTheDocument();
    expect(screen.getByText("answer-1")).toBeInTheDocument();
  });

  it.each(["sending", "sent", "queue", "not-sent"])(
    "keeps a post-completion immediate %s message outside old activity",
    (state) => {
      const messages = midturnMessages();
      messages.set("2000", {
        ...messages.get("2000"),
        generating: false,
        history: [
          { content: "Final", date: 6000, author_id: "openai-codex-agent" },
        ],
      });
      messages.set("7000", {
        date: 7000,
        message_id: "late-immediate",
        thread_id: "thread-1",
        parent_message_id: "assistant-1",
        sender_id: "acct-1",
        acp_send_mode: "immediate",
        acp_state: state,
        history: [{ content: "New work after completion" }],
      });
      render(midturnChat(messages));
      expect(screen.getByText("late-immediate")).toBeInTheDocument();
      expect(
        lastRenderedMessageProps("assistant-1").activitySteers.map(
          ({ messageId }) => messageId,
        ),
      ).not.toContain("late-immediate");
    },
  );

  it("folds midturn post-only comments into collapsible activity without claiming delivery", () => {
    const messages = midturnMessages();
    messages.set("2000", {
      ...messages.get("2000"),
      generating: false,
      history: [
        { content: "Final", date: 6000, author_id: "openai-codex-agent" },
      ],
    });
    messages.set("4500", {
      date: 4500,
      message_id: "posted-comment",
      thread_id: "thread-1",
      parent_message_id: "assistant-1",
      sender_id: "acct-1",
      post_only: true,
      history: [{ content: "A note during the turn" }],
    });
    render(midturnChat(messages));
    expect(screen.queryByText("posted-comment")).not.toBeInTheDocument();
    expect(
      lastRenderedMessageProps("assistant-1").activitySteers,
    ).toContainEqual(
      expect.objectContaining({ messageId: "posted-comment", state: "saved" }),
    );
  });

  it("hides saved-pending Q&A receipts with completed activity, but keeps unanswered questions visible", () => {
    const messages = midturnMessages();
    messages.set("2000", {
      ...messages.get("2000"),
      generating: false,
      history: [
        { content: "Final", date: 6000, author_id: "openai-codex-agent" },
      ],
    });
    const records = [
      {
        attention_id: "saved",
        thread_id: "thread-1",
        message_date: new Date(2000).toISOString(),
        state: "pending",
        response_submitted_at: 4000,
      },
      {
        attention_id: "unanswered",
        thread_id: "thread-1",
        message_date: new Date(2000).toISOString(),
        state: "pending",
      },
    ];
    render(midturnChat(messages, { attentionRecords: records }));
    expect(
      screen.queryByRole("region", { name: "Question saved" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Question unanswered" }),
    ).toBeInTheDocument();
    act(() =>
      lastRenderedMessageProps("assistant-1").onExpandedCodexActivityChange(
        true,
      ),
    );
    expect(
      screen.getByRole("region", { name: "Question saved" }),
    ).toBeInTheDocument();
    act(() =>
      lastRenderedMessageProps("assistant-1").onExpandedCodexActivityChange(
        false,
      ),
    );
    expect(
      screen.queryByRole("region", { name: "Question saved" }),
    ).not.toBeInTheDocument();
  });

  it("keeps queued bodies in the current activity until their own assistant actually starts", () => {
    const messages = midturnMessages();
    messages.set("3000", { ...messages.get("3000"), acp_state: "queued" });
    messages.set("6000", {
      date: 6000,
      message_id: "next-assistant",
      thread_id: "thread-1",
      parent_message_id: "network-1",
      sender_id: "codex",
      acp_account_id: "codex",
      acp_state: "queued",
      generating: false,
      history: [{ content: ":robot: Thinking..." }],
    });
    const view = render(midturnChat(messages));
    expect(lastRenderedMessageProps("network-1").compactActivityMessage).toBe(
      true,
    );
    expect(lastRenderedMessageProps("assistant-1").activitySteers[0]).toEqual(
      expect.objectContaining({ messageId: "network-1", state: "queued" }),
    );
    messages.set("6000", {
      ...messages.get("6000"),
      acp_state: "running",
      generating: true,
      acp_started_at_ms: 6100,
    });
    view.rerender(midturnChat(new Map(messages)));
    expect(lastRenderedMessageProps("network-1").compactActivityMessage).toBe(
      false,
    );
    expect(
      lastRenderedMessageProps("assistant-1").activitySteers.some(
        ({ messageId }) => messageId === "network-1",
      ),
    ).toBe(false);
    expect(
      lastRenderedMessageProps("next-assistant").message.parent_message_id,
    ).toBe("network-1");
  });

  it("preserves queued, failed, and next-turn prompts instead of swallowing their controls", () => {
    const messages = midturnMessages();
    messages.set("3000", { ...messages.get("3000"), acp_state: "queued" });
    messages.set("4000", { ...messages.get("4000"), acp_state: "not-sent" });
    messages.set("5001", {
      date: 5001,
      message_id: "assistant-2",
      thread_id: "thread-1",
      parent_message_id: "network-2",
      acp_account_id: "codex",
      sender_id: "codex",
      generating: true,
      history: [{ content: "Next turn" }],
    });
    render(midturnChat(messages));
    for (const id of ["network-1", "answer-1", "network-2"])
      expect(screen.getByText(id)).toBeInTheDocument();
    expect(lastRenderedMessageProps("assistant-1").activitySteers).toEqual([
      expect.objectContaining({ messageId: "network-1", state: "queued" }),
      expect.objectContaining({ messageId: "answer-1", state: "not-sent" }),
    ]);
    expect(lastRenderedMessageProps("network-1").compactActivityMessage).toBe(
      true,
    );
    expect(lastRenderedMessageProps("answer-1").compactActivityMessage).toBe(
      true,
    );
    expect(lastRenderedMessageProps("network-2").compactActivityMessage).toBe(
      false,
    );
  });

  it("does not fold cross-thread ancestry or messages whose owner is outside the visible thread", () => {
    const messages = midturnMessages();
    messages.set("3000", {
      ...messages.get("3000"),
      thread_id: "other-thread",
    });
    const view = render(midturnChat(messages));
    expect(screen.getByText("network-1")).toBeInTheDocument();
    expect(screen.getByText("answer-1")).toBeInTheDocument();
    view.rerender(
      midturnChat(midturnMessages(), {
        threadIndex: new Map([
          ["thread-1", { messageKeys: new Set(["3000", "4000", "5000"]) }],
        ]),
      }),
    );
    expect(screen.getByText("network-1")).toBeInTheDocument();
    expect(screen.getByText("answer-1")).toBeInTheDocument();
  });

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
    expect(lastRenderedMessageProps("steer-1")?.compactActivityMessage).toBe(
      true,
    );
    expect(lastRenderedMessageProps("steer-2")?.compactActivityMessage).toBe(
      true,
    );
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
                history: [
                  {
                    content: "hello",
                    date: 5000,
                    author_id: "openai-codex-agent",
                  },
                ],
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
    expect(assistantProps?.attachedSteers).toBeUndefined();
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
      history: [
        { content: "hello", date: 4000, author_id: "openai-codex-agent" },
      ],
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
    expect(assistantProps?.attachedSteers).toBeUndefined();
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
