import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import type {
  ChatMessageRecordV2,
  ChatThreadConfigRecord,
  ChatThreadRecord,
  ChatThreadStateRecord,
} from "@cocalc/chat";

import { importChatBundle } from "./chat-import";

async function mkdtemp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

async function findImportedSessionFile(
  sessionsRoot: string,
  suffix: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(sessionsRoot, entry.name);
    if (entry.isDirectory()) {
      const found = await findImportedSessionFile(full, suffix);
      if (found) return found;
      continue;
    }
    if (entry.isFile() && full.endsWith(suffix)) {
      return full;
    }
  }
  return undefined;
}

function readJsonl(filePath: string): Promise<any[]> {
  return fs.readFile(filePath, "utf8").then((content) =>
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}

describe("chat import", () => {
  it("imports threads, rebinds assets to blobs, and forks bundled Codex context", async () => {
    const tmp = await mkdtemp("cocalc-import-chat-");
    const bundleDir = path.join(tmp, "bundle");
    const targetPath = path.join(tmp, "imported.chat");
    const codexHome = path.join(tmp, ".codex");
    const originalCodexHome = process.env.COCALC_CODEX_HOME;
    const sessionJsonl =
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: "seed-session", cwd: "/tmp/project", model: "gpt-5.4" },
      })}\n` +
      `${JSON.stringify({
        type: "message",
        payload: { role: "assistant", content: "seed state" },
      })}\n`;
    const sessionSha256 = createHash("sha256")
      .update(sessionJsonl)
      .digest("hex");

    const uploadCalls: Array<{
      filename: string;
      content: Uint8Array;
      contentType?: string;
      projectId?: string;
    }> = [];
    const forkCalls: Array<{
      seedSessionId: string;
      projectId: string;
      accountId?: string;
    }> = [];

    try {
      process.env.COCALC_CODEX_HOME = codexHome;
      await writeJson(path.join(bundleDir, "manifest.json"), {
        format: "cocalc-export",
        version: 1,
        kind: "chat",
        exported_at: "2026-04-09T00:00:00.000Z",
        source: { path: "restored.chat" },
      });
      await writeJson(path.join(bundleDir, "threads/index.json"), [
        {
          thread_id: "thread-old",
          thread_path: "threads/thread-old/thread.json",
          messages_path: "threads/thread-old/messages.jsonl",
        },
      ]);
      await writeJson(path.join(bundleDir, "threads/thread-old/thread.json"), {
        thread_id: "thread-old",
        title: "Imported Codex Thread",
        archived: false,
        pinned: true,
        agent_kind: "acp",
        agent_model: "gpt-5.4",
        agent_mode: "interactive",
        acp_config: {
          model: "gpt-5.4",
          sessionId: "seed-session",
        },
        root_message_id: "message-root",
        created_at: "2026-04-01T00:00:00.000Z",
        created_by: "user-1",
        transcript_path: "threads/thread-old/transcript.md",
        messages_path: "threads/thread-old/messages.jsonl",
        asset_refs: [
          {
            originalRef: "/blobs/example.png?uuid=blob-old",
            path: "assets/example.png",
            sha256: "asset-sha",
            contentType: "image/png",
          },
        ],
        codex_context: {
          session_id: "seed-session",
          meta_path: "threads/thread-old/codex/meta.json",
          session_path: "threads/thread-old/codex/session.jsonl",
          sha256: sessionSha256,
        },
      });
      await writeJsonl(
        path.join(bundleDir, "threads/thread-old/messages.jsonl"),
        [
          {
            event: "chat-message",
            message_kind: "message",
            message_id: "message-root",
            thread_id: "thread-old",
            timestamp: "2026-04-01T00:00:00.000Z",
            sender_id: "user-1",
            content: "hello ![](../../assets/example.png)",
            content_format: "markdown",
          },
          {
            event: "chat-message",
            message_kind: "message",
            message_id: "message-reply",
            thread_id: "thread-old",
            parent_message_id: "message-root",
            timestamp: "2026-04-01T00:01:00.000Z",
            sender_id: "codex",
            content: "reused image ../../assets/example.png",
            content_format: "markdown",
            acp_usage: { total_tokens: 42 },
          },
        ],
      );
      await writeJson(
        path.join(bundleDir, "threads/thread-old/codex/meta.json"),
        {
          format: "cocalc-codex-context",
          version: 1,
          session_id: "seed-session",
          sha256: sessionSha256,
        },
      );
      await fs.mkdir(path.join(bundleDir, "assets"), { recursive: true });
      await fs.writeFile(
        path.join(bundleDir, "assets/example.png"),
        Buffer.from("asset-bytes"),
      );
      await fs.mkdir(path.join(bundleDir, "threads/thread-old/codex"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(bundleDir, "threads/thread-old/codex/session.jsonl"),
        sessionJsonl,
        "utf8",
      );

      const result = await importChatBundle({
        sourcePath: bundleDir,
        targetPath,
        projectId: "project-1",
        accountId: "account-1",
        uploadBlob: async (input) => {
          uploadCalls.push(input);
          return {
            uuid: "blob-new",
            url: "/blobs/example.png?uuid=blob-new",
          };
        },
        forkCodexSession: async (input) => {
          forkCalls.push(input);
          return { sessionId: "forked-session-1" };
        },
      });

      expect(result).toMatchObject({
        target_path: targetPath,
        created_thread_count: 1,
        created_message_count: 2,
        asset_count: 1,
        codex_context_count: 1,
        warning_count: 0,
      });
      expect(uploadCalls).toHaveLength(1);
      expect(uploadCalls[0]).toMatchObject({
        filename: "example.png",
        contentType: "image/png",
        projectId: "project-1",
      });
      expect(forkCalls).toEqual([
        {
          seedSessionId: "seed-session",
          projectId: "project-1",
          accountId: "account-1",
        },
      ]);

      const importedSessionFile = await findImportedSessionFile(
        path.join(codexHome, "sessions"),
        "-seed-session.jsonl",
      );
      expect(importedSessionFile).toBeTruthy();
      expect(await fs.readFile(importedSessionFile!, "utf8")).toContain(
        '"seed state"',
      );

      const rows = await readJsonl(targetPath);
      expect(rows).toHaveLength(5);
      const threadRow = rows.find(
        (row) => row.event === "chat-thread",
      ) as ChatThreadRecord;
      const configRow = rows.find(
        (row) => row.event === "chat-thread-config",
      ) as ChatThreadConfigRecord;
      const stateRow = rows.find(
        (row) => row.event === "chat-thread-state",
      ) as ChatThreadStateRecord;
      const messageRows = rows.filter(
        (row) => row.event === "chat",
      ) as ChatMessageRecordV2[];

      expect(threadRow.thread_id).not.toBe("thread-old");
      expect(configRow.thread_id).toBe(threadRow.thread_id);
      expect(stateRow.thread_id).toBe(threadRow.thread_id);
      expect(configRow.name).toBe("Imported Codex Thread");
      expect(configRow.acp_config).toMatchObject({
        model: "gpt-5.4",
        sessionId: "forked-session-1",
      });
      expect(messageRows).toHaveLength(2);
      expect(
        messageRows.every((row) => row.thread_id === threadRow.thread_id),
      ).toBe(true);
      expect(messageRows[0].message_id).not.toBe("message-root");
      expect(messageRows[0].history[0].content).toContain(
        "/blobs/example.png?uuid=blob-new",
      );
      expect(messageRows[1].history[0].content).toContain(
        "/blobs/example.png?uuid=blob-new",
      );
      expect(messageRows[1].acp_usage).toEqual({ total_tokens: 42 });
      expect(messageRows.every((row) => row.acp_thread_id == null)).toBe(true);
    } finally {
      if (originalCodexHome == null) {
        delete process.env.COCALC_CODEX_HOME;
      } else {
        process.env.COCALC_CODEX_HOME = originalCodexHome;
      }
    }
  });
});
