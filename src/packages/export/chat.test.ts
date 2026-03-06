import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  buildChatMessageRecordV2,
  buildThreadConfigRecord,
  buildThreadRecord,
} from "@cocalc/chat";
import { rotateChatStore } from "@cocalc/backend/chat-store/sqlite-offload";

import { collectChatExport } from "./chat";

async function mkdtemp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJsonl(filePath: string, rows: any[]): Promise<void> {
  await fs.writeFile(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

function makeThreadConfig(options: {
  threadId: string;
  updatedBy?: string;
  name?: string;
  archived?: boolean;
  pin?: boolean;
}) {
  return {
    ...buildThreadConfigRecord({
      thread_id: options.threadId,
      updated_by: options.updatedBy ?? "user-1",
      name: options.name,
      pin: options.pin,
    }),
    ...(options.archived != null ? { archived: options.archived } : {}),
  };
}

describe("chat export", () => {
  it("exports live plus offloaded messages and filters archived UI threads", async () => {
    const tmp = await mkdtemp("cocalc-export-chat-");
    const chatPath = path.join(tmp, "sample.chat");
    const dbPath = path.join(tmp, "offload.sqlite3");

    const threadId1 = "thread-alpha";
    const threadId2 = "thread-beta";
    const root1 = "msg-root";
    const reply1 = "msg-reply-1";
    const reply2 = "msg-reply-2";

    await writeJsonl(chatPath, [
      buildThreadRecord({
        thread_id: threadId1,
        root_message_id: root1,
        created_by: "user-1",
        created_at: "2026-03-01T00:00:00.000Z",
      }),
      makeThreadConfig({
        threadId: threadId1,
        name: "Alpha Thread",
        pin: true,
      }),
      buildChatMessageRecordV2({
        sender_id: "user-1",
        date: "2026-03-01T00:00:00.000Z",
        prevHistory: [],
        content: "alpha root",
        generating: false,
        message_id: root1,
        thread_id: threadId1,
      }),
      buildChatMessageRecordV2({
        sender_id: "codex",
        date: "2026-03-01T00:01:00.000Z",
        prevHistory: [],
        content: "alpha reply 1",
        generating: false,
        message_id: reply1,
        thread_id: threadId1,
        parent_message_id: root1,
      }),
      buildChatMessageRecordV2({
        sender_id: "user-1",
        date: "2026-03-01T00:02:00.000Z",
        prevHistory: [],
        content: "alpha reply 2",
        generating: false,
        message_id: reply2,
        thread_id: threadId1,
        parent_message_id: reply1,
      }),
    ]);

    await rotateChatStore({
      chat_path: chatPath,
      db_path: dbPath,
      keep_recent_messages: 1,
      force: true,
      require_idle: false,
    });

    const existing = await fs.readFile(chatPath, "utf8");
    const extraRows = [
      buildThreadRecord({
        thread_id: threadId2,
        root_message_id: "msg-beta-root",
        created_by: "user-2",
        created_at: "2026-03-01T01:00:00.000Z",
      }),
      makeThreadConfig({
        threadId: threadId2,
        name: "Beta Thread",
        archived: true,
      }),
      buildChatMessageRecordV2({
        sender_id: "user-2",
        date: "2026-03-01T01:00:00.000Z",
        prevHistory: [],
        content: "beta root",
        generating: false,
        message_id: "msg-beta-root",
        thread_id: threadId2,
      }),
    ];
    await fs.writeFile(
      chatPath,
      `${existing}${extraRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );

    const bundle = await collectChatExport({
      chatPath,
      offloadDbPath: dbPath,
      scope: "all-non-archived-threads",
      projectId: "project-1",
    });

    expect(bundle.manifest.kind).toBe("chat");
    expect((bundle.manifest as any).thread_count).toBe(1);

    const threadIndex = JSON.parse(
      `${bundle.files.find((file) => file.path === "threads/index.json")?.content ?? "[]"}`,
    );
    expect(threadIndex).toHaveLength(1);
    expect(threadIndex[0].thread_id).toBe(threadId1);
    expect(threadIndex[0].message_count).toBe(3);
    expect(threadIndex[0].offloaded_message_count).toBe(1);

    const messagesJsonl = `${bundle.files.find((file) => file.path === `threads/${threadId1}/messages.jsonl`)?.content ?? ""}`
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(messagesJsonl.map((row) => row.message_id)).toEqual([
      root1,
      reply1,
      reply2,
    ]);
    expect(messagesJsonl[0]).toMatchObject({
      event: "chat-message",
      message_kind: "message",
      sender_type: "user",
      sender_label: "user-1",
      content: "alpha root",
      timestamp: "2026-03-01T00:00:00.000Z",
    });

    const transcript = `${bundle.files.find((file) => file.path === `threads/${threadId1}/transcript.md`)?.content ?? ""}`;
    expect(transcript).toContain("# Alpha Thread");
    expect(transcript).toContain("alpha root");
    expect(transcript).toContain("alpha reply 2");
    expect(transcript).not.toContain("Beta Thread");
  });

  it("includes blobs and rewrites transcript references to local assets", async () => {
    const tmp = await mkdtemp("cocalc-export-chat-blob-");
    const chatPath = path.join(tmp, "sample.chat");
    const threadId = "thread-blob";
    const blobRef = "/blobs/example?uuid=11111111-1111-4111-8111-111111111111";
    const blobData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    let server: Server | undefined;
    try {
      server = createServer((req, res) => {
        if (req.url?.startsWith("/blobs/example?uuid=11111111-1111-4111-8111-111111111111")) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/octet-stream");
          res.end(blobData);
          return;
        }
        res.statusCode = 404;
        res.end("missing");
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind blob server");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      await writeJsonl(chatPath, [
        buildThreadRecord({
          thread_id: threadId,
          root_message_id: "blob-root",
          created_by: "user-1",
        }),
        makeThreadConfig({ threadId, name: "Blob Thread" }),
        buildChatMessageRecordV2({
          sender_id: "user-1",
          date: "2026-03-01T00:00:00.000Z",
          prevHistory: [],
          content: `here is an image\n\n![](${blobRef})`,
          generating: false,
          message_id: "blob-root",
          thread_id: threadId,
        }),
      ]);

      const bundle = await collectChatExport({
        chatPath,
        scope: "current-thread",
        threadId,
        includeBlobs: true,
        blobBaseUrl: baseUrl,
      });

      expect(bundle.assets).toHaveLength(1);
      expect(bundle.assets?.[0].path).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
      expect(bundle.assets?.[0].contentType).toBe("image/png");

      const transcript = `${bundle.files.find((file) => file.path === `threads/${threadId}/transcript.md`)?.content ?? ""}`;
      expect(transcript).toContain(`../../${bundle.assets?.[0].path}`);
      expect(transcript).not.toContain(blobRef);

      const messagesJsonl = `${bundle.files.find((file) => file.path === `threads/${threadId}/messages.jsonl`)?.content ?? ""}`
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(messagesJsonl[0].content).toContain(`../../${bundle.assets?.[0].path}`);
      expect(messagesJsonl[0].content).not.toContain(blobRef);

      const assetIndex = JSON.parse(
        `${bundle.files.find((file) => file.path === "assets/index.json")?.content ?? "[]"}`,
      );
      expect(assetIndex).toHaveLength(1);
      expect(assetIndex[0].originalRef).toBe(blobRef);
      expect(assetIndex[0].path).toBe(bundle.assets?.[0].path);
      expect(assetIndex[0].contentType).toBe("image/png");
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) =>
          server!.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }
  });
});
