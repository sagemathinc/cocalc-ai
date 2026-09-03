import { codexNotificationFragment } from "./codex-notification-target";

describe("codexNotificationFragment", () => {
  it("adds durable thread and attention targets to legacy fragments", () => {
    expect(
      codexNotificationFragment({
        notice_type: "codex_attention",
        fragment_id: "chat=1234",
        thread_id: "thread-1",
        attention_id: "attention-1",
      }),
    ).toEqual({
      chat: "1234",
      thread: "thread-1",
      attention: "attention-1",
    });
  });

  it("does not reinterpret unrelated notification metadata", () => {
    expect(
      codexNotificationFragment({
        notice_type: "project_access_request",
        fragment_id: "chat=1234",
        thread_id: "thread-1",
        attention_id: "attention-1",
      }),
    ).toEqual({ chat: "1234" });
  });

  it("recovers the chat target for local attention delivery", () => {
    expect(
      codexNotificationFragment({
        notice_type: "codex_attention",
        message_date: "2026-09-03T21:09:14.619Z",
        thread_id: "thread-1",
        attention_id: "attention-1",
      }),
    ).toEqual({
      chat: "1788469754619",
      thread: "thread-1",
      attention: "attention-1",
    });
  });
});
