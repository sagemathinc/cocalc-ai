/** @jest-environment jsdom */

import { getSortedDates } from "../sorted-dates";
import { orderLinearThreadMessages } from "../utils";
import type { ChatMessageTyped } from "../types";

function message(id: string, time: number, parent?: string): ChatMessageTyped {
  return {
    event: "chat",
    sender_id: "user",
    message_id: id,
    thread_id: "thread",
    parent_message_id: parent,
    date: new Date(time).toISOString(),
    history: [],
  };
}

function ids(rows: ChatMessageTyped[]): (string | undefined)[] {
  return orderLinearThreadMessages(rows).map((row) => row.message_id);
}

describe("linear chat message ordering", () => {
  const branchedHistory = () => [
    message("root", 1),
    message("main", 2, "root"),
    message("old-side-prompt", 3, "root"),
    {
      ...message("old-interrupted-reply", 4, "old-side-prompt"),
      acp_interrupted: true,
    },
    message("latest-prompt", 5, "main"),
    message("latest-reply", 6, "latest-prompt"),
  ];

  it("does not put an old interrupted branch after newer conversation", () => {
    const rows = branchedHistory();
    expect(ids(rows)).toEqual(rows.map((row) => row.message_id));
    expect(ids(rows).at(-1)).toBe("latest-reply");
  });

  it("renders a new turn at the end even if it was attached to an old branch", () => {
    const rows = [
      message("root", 1),
      message("old-side-prompt", 2, "root"),
      message("old-interrupted-reply", 3, "old-side-prompt"),
      message("latest-prompt", 4, "root"),
      message("latest-reply", 5, "latest-prompt"),
      message("new-prompt", 7, "old-interrupted-reply"),
      message("new-reply", 8, "new-prompt"),
    ];
    const messages = new Map(rows.map((row) => [row.message_id!, row]));
    const { dates } = getSortedDates(messages, "user");
    expect(dates).toEqual(rows.map((row) => `${Date.parse(`${row.date}`)}`));
    expect(ids(rows).at(-1)).toBe("new-reply");
  });

  it("keeps a reply after its parent despite clock skew", () => {
    const rows = [
      message("root", 0),
      message("user-x", 1, "root"),
      message("user-y", 2, "assistant-x"),
      message("user-z", 3, "assistant-y"),
      message("assistant-x", 4, "user-x"),
      message("assistant-y", 5, "user-y"),
      message("assistant-z", 6, "user-z"),
    ];
    expect(ids(rows)).toEqual([
      "root",
      "user-x",
      "assistant-x",
      "user-y",
      "assistant-y",
      "user-z",
      "assistant-z",
    ]);
  });

  it("orders missing-parent and self-parent rows without losing messages", () => {
    expect(
      ids([
        message("late", 3, "missing"),
        message("self", 2, "self"),
        message("early", 1, "archived-parent"),
      ]),
    ).toEqual(["early", "self", "late"]);
  });

  it("handles cycles deterministically and retains every row once", () => {
    const rows = [
      message("a", 1, "b"),
      message("b", 2, "a"),
      message("c", 3, "b"),
    ];
    const ordered = ids(rows);
    expect(new Set(ordered)).toEqual(new Set(["a", "b", "c"]));
    expect(ordered).toHaveLength(3);
    expect(ids(rows.slice().reverse())).toEqual(ordered);
  });

  it("uses message ids to break timestamp ties without mutating input", () => {
    const rows = [message("b", 1), message("a", 1)];
    rows.forEach(Object.freeze);
    Object.freeze(rows);
    expect(ids(rows)).toEqual(["a", "b"]);
    expect(rows.map((row) => row.message_id)).toEqual(["b", "a"]);
  });

  it("handles deep parent chains without overflowing the stack", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) =>
      message(`${i}`, 20_000 - i, i > 0 ? `${i - 1}` : undefined),
    );
    expect(ids(rows)).toEqual(rows.map((row) => row.message_id));
  });
});
