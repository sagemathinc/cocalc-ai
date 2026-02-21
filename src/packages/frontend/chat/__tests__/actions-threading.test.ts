/** @jest-environment jsdom */

import { collectThreadMessages } from "../actions";

describe("ChatActions.getMessagesInThread", () => {
  it("prefers thread_id grouping when present", () => {
    const rootDate = new Date("2026-01-01T00:00:00.000Z");
    const rootIso = rootDate.toISOString();
    const messages = new Map<string, any>([
      [
        `${rootDate.valueOf()}`,
        {
          event: "chat",
          sender_id: "user-1",
          date: rootDate,
          thread_id: "thread-abc",
          message_id: "root-1",
          history: [],
        },
      ],
      [
        `${rootDate.valueOf() + 1}`,
        {
          event: "chat",
          sender_id: "user-1",
          date: new Date(rootDate.valueOf() + 1),
          thread_id: "thread-abc",
          message_id: "reply-1",
          reply_to: rootIso,
          history: [],
        },
      ],
      [
        `${rootDate.valueOf() + 2}`,
        {
          event: "chat",
          sender_id: "user-1",
          date: new Date(rootDate.valueOf() + 2),
          thread_id: "thread-abc",
          message_id: "reply-2",
          // Intentionally wrong to verify thread_id-based grouping.
          reply_to: new Date(rootDate.valueOf() - 10).toISOString(),
          history: [],
        },
      ],
      [
        `${rootDate.valueOf() + 3}`,
        {
          event: "chat",
          sender_id: "user-2",
          date: new Date(rootDate.valueOf() + 3),
          thread_id: "thread-other",
          message_id: "noise",
          // Would match legacy reply_to-only grouping.
          reply_to: rootIso,
          history: [],
        },
      ],
    ]);
    const result =
      collectThreadMessages({
        messages: messages as any,
        dateStr: rootIso,
        getMessageByDate: (date: number) => messages.get(`${date}`),
      }) ?? [];
    expect(result.map((m: any) => m.message_id)).toEqual([
      "root-1",
      "reply-1",
      "reply-2",
    ]);
  });

  it("falls back to legacy reply_to/date grouping when thread_id is missing", () => {
    const rootDate = new Date("2026-01-02T00:00:00.000Z");
    const rootIso = rootDate.toISOString();
    const messages = new Map<string, any>([
      [
        `${rootDate.valueOf()}`,
        {
          event: "chat",
          sender_id: "user-1",
          date: rootDate,
          message_id: "legacy-root",
          history: [],
        },
      ],
      [
        `${rootDate.valueOf() + 1}`,
        {
          event: "chat",
          sender_id: "user-1",
          date: new Date(rootDate.valueOf() + 1),
          message_id: "legacy-reply",
          reply_to: rootIso,
          history: [],
        },
      ],
      [
        `${rootDate.valueOf() + 2}`,
        {
          event: "chat",
          sender_id: "user-2",
          date: new Date(rootDate.valueOf() + 2),
          message_id: "other",
          reply_to: new Date(rootDate.valueOf() - 5).toISOString(),
          history: [],
        },
      ],
    ]);
    const result =
      collectThreadMessages({
        messages: messages as any,
        dateStr: rootIso,
        getMessageByDate: (date: number) => messages.get(`${date}`),
      }) ?? [];
    expect(result.map((m: any) => m.message_id)).toEqual([
      "legacy-root",
      "legacy-reply",
    ]);
  });
});
