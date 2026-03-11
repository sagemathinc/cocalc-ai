import * as immutable from "immutable";
import { hasActiveAcpTurnForComposer } from "../chatroom";

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
