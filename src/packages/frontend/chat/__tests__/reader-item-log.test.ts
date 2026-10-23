import {
  isOpenAttention,
  readerItemAttention,
  readerItemThreadIndex,
  readerItemWorking,
} from "../reader-item-log";
import { readerItems } from "../reader-model";

const person = (id: string, ms: number) =>
  ({
    message_id: id,
    sender_id: "acct",
    date: new Date(ms),
    history: [{ content: id, author_id: "acct" }],
  }) as any;
const agent = (id: string, ms: number, parent: string, extra = {}) =>
  ({
    message_id: id,
    sender_id: "codex",
    date: new Date(ms),
    parent_message_id: parent,
    acp_thread_id: "t",
    history: [{ content: id, author_id: "codex" }],
    ...extra,
  }) as any;

const items = readerItems([
  person("p1", 1000),
  agent("a1", 2000, "p1"),
  person("p2", 3000),
  agent("a2", 4000, "p2", { generating: true }),
]);

test("the log shows only the item's messages", () => {
  const index = readerItemThreadIndex("thread-key", items[0]);
  const entry = index.get("thread-key")!;
  expect([...entry.messageKeys]).toEqual(["1000", "2000"]);
  expect(entry.newestTime).toBe(2000);
});

test("a question goes with its message's item, else with the newest", () => {
  const record = (id: string, message_date?: string) =>
    ({ attention_id: id, message_date, state: "pending" }) as any;
  const byItem = readerItemAttention(
    [
      record("q1", new Date(2000).toISOString()),
      record("q2"),
      record("q3", new Date(99999).toISOString()),
    ],
    items,
  );
  expect(byItem.get("p1")!.map((r) => r.attention_id)).toEqual(["q1"]);
  expect(byItem.get("p2")!.map((r) => r.attention_id)).toEqual(["q2", "q3"]);
});

test("open questions and running turns", () => {
  expect(isOpenAttention({ state: "pending" } as any)).toBe(true);
  expect(
    isOpenAttention({ state: "pending", response_submitted_at: 1 } as any),
  ).toBe(false);
  expect(isOpenAttention({ state: "answered" } as any)).toBe(false);
  // The running turn the panel found, not a flag on the row.
  expect(readerItemWorking(items[1])).toBe(false);
  expect(readerItemWorking(items[1], items[1].messages[1])).toBe(true);
  expect(readerItemWorking(items[0], items[1].messages[1])).toBe(false);
});
