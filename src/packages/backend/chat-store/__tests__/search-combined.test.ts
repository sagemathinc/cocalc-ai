import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchChatStoreCombined, rotateChatStore } from "../sqlite-offload";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-search-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const row = (i: number, thread_id = "a") => ({
  event: "chat",
  thread_id,
  message_id: `m${i}`,
  date: new Date(1700000000000 + i * 1000).toISOString(),
  history: [{ content: `needle message ${i}` }],
});

test("merges saved head and archived hits newest first, scoped to one thread", async () => {
  const chat_path = path.join(dir, "test.chat"),
    db_path = path.join(dir, "offload.db");
  await fs.writeFile(
    chat_path,
    [row(1), row(2, "other"), row(3), row(4)]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  await rotateChatStore({
    chat_path,
    db_path,
    keep_recent_messages: 1,
    force: true,
  });
  const result = await searchChatStoreCombined({
    chat_path,
    db_path,
    query: "needle",
    thread_id: "a",
    limit: 10,
  });
  expect(result.includes_head).toBe(true);
  expect(result.hits.map((h) => h.message_id)).toEqual(["m4", "m3", "m1"]);
  expect(result.hits[0].segment_id).toBe("head");
  expect(result.hits[1].segment_id).not.toBe("head");
});

test("rejects unscoped or oversized queries and heads", async () => {
  const chat_path = path.join(dir, "test.chat");
  await expect(
    searchChatStoreCombined({ chat_path, query: "x" }),
  ).rejects.toThrow("thread scope");
  await expect(
    searchChatStoreCombined({
      chat_path,
      query: "x".repeat(257),
      thread_id: "a",
    }),
  ).rejects.toThrow("1-256");
  await fs.writeFile(chat_path, "x".repeat(8 * 1024 * 1024 + 1));
  await expect(
    searchChatStoreCombined({ chat_path, query: "x", thread_id: "a" }),
  ).rejects.toThrow("size limit");
});
