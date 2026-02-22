/** @jest-environment jsdom */

import { getThreadRootDate } from "../utils";

describe("getThreadRootDate thread_id fallback", () => {
  it("resolves root by thread_id when reply_to is stale", () => {
    const rootDate = new Date("2026-02-21T22:00:00.000Z");
    const staleReplyTo = new Date("2026-02-21T21:00:00.000Z").toISOString();
    const replyDate = new Date("2026-02-21T22:00:05.000Z");
    const messages = new Map<string, any>([
      [
        `${rootDate.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: rootDate,
          message_id: "root-1",
          thread_id: "thread-1",
          history: [],
        },
      ],
      [
        `${replyDate.valueOf()}`,
        {
          event: "chat",
          sender_id: "u2",
          date: replyDate,
          message_id: "reply-1",
          thread_id: "thread-1",
          // intentionally wrong date
          reply_to: staleReplyTo,
          history: [],
        },
      ],
    ]);

    const root = getThreadRootDate({
      date: replyDate.valueOf(),
      messages: messages as any,
    });
    expect(root).toBe(rootDate.valueOf());
  });
});

