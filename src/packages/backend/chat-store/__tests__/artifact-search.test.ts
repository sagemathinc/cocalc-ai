import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  searchChatArtifacts,
  searchChatStore,
  rotateChatStore,
} from "../sqlite-offload";
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-search-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const publication = (id: string, thread = "t", time = 1) => ({
  event: "chat-artifact-publication",
  thread_id: thread,
  artifact_id: id,
  date: "1970-01-01T00:00:00.000Z",
  sender_id: `${id}:${thread}:${time}`,
  operation_id: `op${time}`,
  message_id: "m",
  published_at: new Date(time).toISOString(),
  snapshot: {
    title: `Notebook ${id}`,
    markdown: "primes",
    file: { path: `/a/${id}.ipynb` },
  },
});

test("saved publications are deduplicated, scoped and paginated without opening chats", async () => {
  const chat_path = path.join(dir, "a.chat");
  await fs.writeFile(
    chat_path,
    [
      publication("a"),
      publication("a", "t", 2),
      publication("b", "t", 3),
      publication("other", "other"),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const result = await searchChatArtifacts({
    chat_path,
    query: "",
    thread_id: "t",
    limit: 1,
  });
  expect(result.includes_artifacts).toBe(true);
  expect(result.total_hits).toBe(2);
  expect(result.next_offset).toBe(1);
  expect(result.hits[0].artifact_id).toBe("b");
  const next = await searchChatArtifacts({
    chat_path,
    query: "",
    thread_id: "t",
    limit: 1,
    offset: 1,
  });
  expect(next.hits[0]).toMatchObject({
    artifact_id: "a",
    operation_id: "op2",
    artifact_kind: "file",
  });
  expect(next.next_offset).toBeUndefined();
});

test("current metadata is searchable and unpublished records are not discovery results", async () => {
  const chat_path = path.join(dir, "a.chat");
  await fs.writeFile(
    chat_path,
    [
      publication("a"),
      {
        event: "chat-artifact",
        thread_id: "t",
        artifact_id: "a",
        title: "Updated",
        input: "new text",
        file: { path: "/new.csv" },
      },
      {
        event: "chat-artifact",
        thread_id: "t",
        artifact_id: "draft",
        title: "Updated",
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  expect(
    (
      await searchChatArtifacts({
        chat_path,
        query: "updated new.csv",
        thread_id: "t",
      })
    ).hits,
  ).toHaveLength(1);
  expect(
    (await searchChatArtifacts({ chat_path, query: "primes", thread_id: "t" }))
      .hits,
  ).toHaveLength(0);
});

test("artifact discovery rejects oversized heads and requires a bounded thread", async () => {
  const chat_path = path.join(dir, "a.chat");
  await fs.writeFile(chat_path, " ".repeat(8 * 1024 * 1024 + 1));
  await expect(
    searchChatArtifacts({ chat_path, query: "", thread_id: "t" }),
  ).rejects.toThrow("size limit");
  await expect(
    searchChatStore({ chat_path, query: "", artifacts: true }, "account"),
  ).rejects.toThrow("Invalid");
  await expect(
    searchChatStore(
      { chat_path, query: "x".repeat(257), artifacts: true, thread_id: "t" },
      "account",
    ),
  ).rejects.toThrow("Invalid");
});

test("message offload retains artifact discovery records", async () => {
  const chat_path = path.join(dir, "a.chat");
  await fs.writeFile(
    chat_path,
    [
      publication("a"),
      ...[1, 2, 3].map((i) => ({
        event: "chat",
        thread_id: "t",
        message_id: `m${i}`,
        date: new Date(i * 1000).toISOString(),
        history: [{ content: "message" }],
      })),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  await rotateChatStore({
    chat_path,
    db_path: path.join(dir, "a.db"),
    force: true,
    keep_recent_messages: 1,
  });
  expect(
    (await searchChatArtifacts({ chat_path, query: "", thread_id: "t" }))
      .hits[0].artifact_id,
  ).toBe("a");
});
