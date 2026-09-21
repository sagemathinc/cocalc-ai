import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  searchChatStoreCombined,
  searchChatStoreArchived,
  rotateChatStore,
} from "../sqlite-offload";
import { chatSearchIndex } from "@cocalc/util/chat-search";

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

test.each([
  ["building", "BUILD", 0],
  ["Build error", "build error", 0],
  ["error then build", "build error", -1],
  ["build error", '"build error"', -1],
  ["build", "build OR error", -1],
  ["abc", "%", -1],
  ["abc", "_", -1],
  ["build", "build*", -1],
  ["École", "ÉCOLE", 0],
  ["École", "ecole", -1],
  ["<b>plain</b>", "b", -1],
  ["build", "  build  ", 0],
])("literal matcher: %s / %s", (content, query, expected) => {
  expect(chatSearchIndex(String(content), String(query))).toBe(expected);
});

test("oversized archive rows produce an explicit error instead of no matches", async () => {
  const chat_path = path.join(dir, "large.chat");
  const db_path = path.join(dir, "large.db");
  await fs.writeFile(
    chat_path,
    [row(1), row(2), row(3)].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  await rotateChatStore({
    chat_path,
    db_path,
    keep_recent_messages: 1,
    force: true,
  });
  const db = new DatabaseSync(db_path);
  try {
    db.prepare("UPDATE archived_rows SET row_json = ?").run(
      "x".repeat(8 * 1024 * 1024 + 1),
    );
  } finally {
    db.close();
  }
  expect(() =>
    searchChatStoreArchived({
      chat_path,
      db_path,
      thread_id: "a",
      query: "missing",
    }),
  ).toThrow("search size limit");
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

test.each([
  "build",
  "BUILD ERROR",
  "error build",
  '"build error"',
  "build OR error",
  "%",
  "_",
  "*",
  "ÉCOLE",
  "ecole",
  "b",
  "metadata-only",
  "old-edit",
  "  build  ",
])("matching stays identical after offload: %s", async (query) => {
  const chat_path = path.join(dir, "matching.chat");
  const db_path = path.join(dir, "matching.db");
  const bodies = [
    "root",
    "building",
    "Build error",
    "error then build",
    'say "build error"',
    "build OR error",
    "100%",
    "a_b",
    "build*",
    "École",
    "<b>plain</b>",
    "keeper",
  ];
  const messages = bodies.map((content, i) => ({
    ...row(i),
    sender_id: "metadata-only",
    history: [{ content }, { content: "old-edit" }],
  }));
  await fs.writeFile(
    chat_path,
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
  );
  const opts = { chat_path, db_path, thread_id: "a", query, limit: 100 };
  const expected = messages
    .filter((m) => chatSearchIndex(m.history[0].content, query) >= 0)
    .reverse()
    .map((m) => m.message_id);
  expect(
    (await searchChatStoreCombined(opts)).hits.map((h) => h.message_id),
  ).toEqual(expected);
  await rotateChatStore({
    chat_path,
    db_path,
    keep_recent_messages: 1,
    force: true,
  });
  expect(
    (await searchChatStoreCombined(opts)).hits.map((h) => h.message_id),
  ).toEqual(expected);
  expect(searchChatStoreArchived(opts).hits.map((h) => h.message_id)).toEqual(
    expected.filter((id) => id !== "m0" && id !== "m11"),
  );
});
