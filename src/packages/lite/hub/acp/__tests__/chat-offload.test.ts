import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  deleteChatStoreData,
  getChatStoreStats,
  listChatStoreSegments,
  readChatStoreArchived,
  rotateChatStore,
  searchChatStoreArchived,
  vacuumChatStore,
} from "../../sqlite/chat-offload";

function makeChatRow({
  date,
  message_id,
  thread_id = "thread-1",
  content,
  generating = false,
}: {
  date: string;
  message_id: string;
  thread_id?: string;
  content: string;
  generating?: boolean;
}) {
  return {
    event: "chat",
    sender_id: "00000000-1000-4000-8000-000000000001",
    date,
    message_id,
    thread_id,
    history: [
      {
        author_id: "00000000-1000-4000-8000-000000000001",
        date,
        content,
      },
    ],
    generating,
  };
}

describe("chat offload sqlite store", () => {
  it("rotates old rows, supports read/search/delete/vacuum", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chat-offload-"));
    const chatPath = path.join(tmp, "test.chat");
    const dbPath = path.join(tmp, "offload.sqlite3");
    const rows = [
      makeChatRow({
        date: "2026-02-20T00:00:00.000Z",
        message_id: "m1",
        content: "alpha first message",
      }),
      makeChatRow({
        date: "2026-02-20T00:01:00.000Z",
        message_id: "m2",
        thread_id: "thread-2",
        content: "beta second message",
      }),
      makeChatRow({
        date: "2026-02-20T00:02:00.000Z",
        message_id: "m3",
        content: "gamma third message",
      }),
      makeChatRow({
        date: "2026-02-20T00:03:00.000Z",
        message_id: "m4",
        content: "delta fourth message",
      }),
    ];
    await fs.writeFile(
      chatPath,
      rows.map((x) => JSON.stringify(x)).join("\n") + "\n",
      "utf8",
    );

    const before = await getChatStoreStats({ chat_path: chatPath, db_path: dbPath });
    expect(before.head_chat_rows).toBe(4);
    expect(before.archived_rows).toBe(0);

    const rotated = await rotateChatStore({
      chat_path: chatPath,
      db_path: dbPath,
      keep_recent_messages: 2,
      max_head_bytes: 1,
      max_head_messages: 1,
      require_idle: true,
    });
    expect(rotated.rotated).toBe(true);
    expect(rotated.archived_rows).toBe(2);

    const segments = listChatStoreSegments({ chat_path: chatPath, db_path: dbPath });
    expect(segments.segments.length).toBe(1);

    const archived = readChatStoreArchived({
      chat_path: chatPath,
      db_path: dbPath,
      limit: 10,
    });
    expect(archived.rows.length).toBe(2);
    expect(archived.rows.some((x) => x.message_id === "m1")).toBe(true);
    const archivedThread1 = readChatStoreArchived({
      chat_path: chatPath,
      db_path: dbPath,
      thread_id: "thread-1",
      limit: 10,
    });
    expect(archivedThread1.rows.length).toBe(1);
    expect(archivedThread1.rows[0].message_id).toBe("m1");

    const search = searchChatStoreArchived({
      chat_path: chatPath,
      db_path: dbPath,
      query: "alpha",
      limit: 10,
    });
    expect(search.hits.length).toBe(1);
    expect(search.hits[0].message_id).toBe("m1");
    const searchThread2 = searchChatStoreArchived({
      chat_path: chatPath,
      db_path: dbPath,
      query: "beta",
      thread_id: "thread-2",
      limit: 10,
    });
    expect(searchThread2.hits.length).toBe(1);
    expect(searchThread2.hits[0].message_id).toBe("m2");

    const del = deleteChatStoreData({
      chat_path: chatPath,
      db_path: dbPath,
      scope: "messages",
      message_ids: ["m1"],
    });
    expect(del.deleted_rows).toBe(1);

    const afterDelete = readChatStoreArchived({
      chat_path: chatPath,
      db_path: dbPath,
      limit: 10,
    });
    expect(afterDelete.rows.length).toBe(1);
    expect(afterDelete.rows[0].message_id).toBe("m2");

    const vacuum = vacuumChatStore({ chat_path: chatPath, db_path: dbPath });
    expect(vacuum.before_bytes).toBeGreaterThan(0);
    expect(vacuum.after_bytes).toBeGreaterThan(0);

    const finalStats = await getChatStoreStats({
      chat_path: chatPath,
      db_path: dbPath,
    });
    expect(finalStats.archived_rows).toBe(1);
    expect(finalStats.head_chat_rows).toBe(2);
  });

  it("resumes pending rotate rewrite after transient rename failure", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chat-offload-resume-"));
    const chatPath = path.join(tmp, "resume.chat");
    const dbPath = path.join(tmp, "offload.sqlite3");
    const rows = [
      makeChatRow({
        date: "2026-02-20T00:00:00.000Z",
        message_id: "r1",
        content: "first",
      }),
      makeChatRow({
        date: "2026-02-20T00:01:00.000Z",
        message_id: "r2",
        content: "second",
      }),
      makeChatRow({
        date: "2026-02-20T00:02:00.000Z",
        message_id: "r3",
        content: "third",
      }),
    ];
    await fs.writeFile(
      chatPath,
      rows.map((x) => JSON.stringify(x)).join("\n") + "\n",
      "utf8",
    );

    const renameSpy = jest
      .spyOn(fs, "rename")
      .mockImplementationOnce(async () => {
        throw new Error("rename failed");
      });

    const first = await rotateChatStore({
      chat_path: chatPath,
      db_path: dbPath,
      keep_recent_messages: 1,
      max_head_bytes: 1,
      max_head_messages: 1,
      require_idle: true,
    });
    expect(first.rotated).toBe(true);
    expect(first.maintenance_status).toBe("segment_written");
    expect(first.rewrite_warning).toContain("rename failed");

    // Stats call should auto-resume the pending rotate op and rewrite head.
    const afterResume = await getChatStoreStats({
      chat_path: chatPath,
      db_path: dbPath,
    });
    expect(afterResume.head_chat_rows).toBe(1);
    expect(afterResume.pending_rotate_op_id).toBeUndefined();

    renameSpy.mockRestore();
  });
});
