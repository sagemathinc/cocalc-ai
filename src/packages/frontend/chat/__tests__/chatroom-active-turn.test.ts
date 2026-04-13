import * as immutable from "immutable";
import {
  getLatestThreadMessageDate,
  hasActiveAcpTurnForComposer,
  latestThreadAcpInterrupted,
  splitCompletedCodexTurnNotifications,
} from "../chatroom";

describe("hasActiveAcpTurnForComposer", () => {
  it("ignores stale ACP generating flags when acpState is no longer active", () => {
    expect(
      hasActiveAcpTurnForComposer({
        isSelectedThreadAI: true,
        selectedThreadId: "thread-1",
        acpState: immutable.Map<string, string>(),
        selectedThreadMessages: [
          {
            event: "chat",
            sender_id: "assistant",
            generating: true,
            acp_account_id: "acct-1",
            thread_id: "thread-1",
            message_id: "msg-1",
            date: "2026-03-11T08:00:00.000Z",
            history: [],
          },
        ],
      }),
    ).toBe(false);
  });

  it("returns true while an ACP turn is still active", () => {
    expect(
      hasActiveAcpTurnForComposer({
        isSelectedThreadAI: true,
        selectedThreadId: "thread-1",
        acpState: immutable
          .Map<string, string>()
          .set("message:msg-1", "running"),
        selectedThreadMessages: [
          {
            event: "chat",
            sender_id: "assistant",
            generating: true,
            acp_account_id: "acct-1",
            thread_id: "thread-1",
            message_id: "msg-1",
            date: "2026-03-11T08:00:00.000Z",
            history: [],
          },
        ],
      }),
    ).toBe(true);
  });

  it("ignores non-ACP generating rows for queue/send-now state", () => {
    expect(
      hasActiveAcpTurnForComposer({
        isSelectedThreadAI: true,
        selectedThreadId: "thread-1",
        acpState: immutable.Map<string, string>(),
        selectedThreadMessages: [
          {
            event: "chat",
            sender_id: "assistant",
            generating: true,
            thread_id: "thread-1",
            message_id: "msg-1",
            date: "2026-03-11T08:00:00.000Z",
            history: [],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("getLatestThreadMessageDate", () => {
  it("returns the newest dated message in a thread", () => {
    expect(
      getLatestThreadMessageDate([
        {
          event: "chat",
          sender_id: "user",
          date: "2026-03-11T08:00:00.000Z",
          history: [],
        },
        {
          event: "chat",
          sender_id: "assistant",
          date: "2026-03-11T08:01:00.000Z",
          history: [],
        },
      ]),
    ).toBe(`${Date.parse("2026-03-11T08:01:00.000Z")}`);
  });
});

describe("latestThreadAcpInterrupted", () => {
  it("returns true when the latest ACP thread message was interrupted", () => {
    expect(
      latestThreadAcpInterrupted([
        {
          event: "chat",
          sender_id: "assistant",
          date: "2026-03-11T08:00:00.000Z",
          acp_account_id: "acct-1",
          acp_interrupted: false,
          history: [],
        },
        {
          event: "chat",
          sender_id: "assistant",
          date: "2026-03-11T08:01:00.000Z",
          acp_account_id: "acct-1",
          acp_interrupted: true,
          history: [],
        },
      ]),
    ).toBe(true);
  });
});

describe("splitCompletedCodexTurnNotifications", () => {
  it("moves finished watched turns into the completed queue", () => {
    expect(
      splitCompletedCodexTurnNotifications({
        watches: [
          {
            threadKey: "thread-1",
            threadId: "thread-1",
            threadLabel: "Thread 1",
          },
          {
            threadKey: "thread-2",
            threadId: "thread-2",
            threadLabel: "Thread 2",
          },
        ],
        snapshots: new Map([
          [
            "thread-1",
            { active: true, interrupted: false, newestMessageDate: "101" },
          ],
          [
            "thread-2",
            { active: false, interrupted: false, newestMessageDate: "202" },
          ],
        ]),
      }),
    ).toEqual({
      remainingWatches: [
        {
          threadKey: "thread-1",
          threadId: "thread-1",
          threadLabel: "Thread 1",
        },
      ],
      completedNotifications: [
        {
          threadKey: "thread-2",
          threadId: "thread-2",
          threadLabel: "Thread 2",
          newestMessageDate: "202",
        },
      ],
    });
  });

  it("clears interrupted watched turns without notifying", () => {
    expect(
      splitCompletedCodexTurnNotifications({
        watches: [
          {
            threadKey: "thread-1",
            threadId: "thread-1",
            threadLabel: "Thread 1",
          },
        ],
        snapshots: new Map([
          [
            "thread-1",
            { active: false, interrupted: true, newestMessageDate: "202" },
          ],
        ]),
      }),
    ).toEqual({
      remainingWatches: [],
      completedNotifications: [],
    });
  });
});
