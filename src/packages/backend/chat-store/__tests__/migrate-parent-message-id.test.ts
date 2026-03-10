import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrateArchivedParentMessageIds } from "../migrate-parent-message-id";

function createDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE archived_rows (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      date_ms INTEGER,
      row_json TEXT NOT NULL
    );
  `);
  return db;
}

describe("migrateArchivedParentMessageIds", () => {
  it("canonicalizes archived legacy rows to parent_message_id", async () => {
    const tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), "archived-parent-ids-"),
    );
    const dbPath = path.join(tmp, "offload.sqlite3");
    const db = createDb(dbPath);
    const root = {
      event: "chat",
      sender_id: "user-1",
      date: "2026-02-20T00:00:00.000Z",
      message_id: "root-1",
      thread_id: "thread-1",
      history: [
        {
          author_id: "user-1",
          content: "root",
          date: "2026-02-20T00:00:00.000Z",
        },
      ],
    };
    const reply = {
      event: "chat",
      sender_id: "user-2",
      date: "2026-02-20T00:01:00.000Z",
      message_id: "reply-1",
      thread_id: "thread-1",
      reply_to: "2026-02-20T00:00:00.000Z",
      reply_to_message_id: "root-1",
      history: [
        {
          author_id: "user-2",
          content: "reply",
          date: "2026-02-20T00:01:00.000Z",
        },
      ],
    };
    const insert = db.prepare(
      "INSERT INTO archived_rows(chat_id, thread_id, message_id, date_ms, row_json) VALUES(?, ?, ?, ?, ?)",
    );
    insert.run(
      "chat-1",
      "thread-1",
      "root-1",
      Date.parse(root.date),
      JSON.stringify(root),
    );
    insert.run(
      "chat-1",
      "thread-1",
      "reply-1",
      Date.parse(reply.date),
      JSON.stringify(reply),
    );
    db.close();

    const report = await migrateArchivedParentMessageIds({
      db_path: dbPath,
      no_backup: true,
    });
    expect(report.rows_updated).toBe(1);
    expect(report.parent_ids_assigned).toBe(1);
    expect(report.legacy_reply_to_message_ids_removed).toBe(1);

    const verifyDb = new DatabaseSync(dbPath);
    const rows = verifyDb
      .prepare(
        "SELECT message_id, row_json FROM archived_rows ORDER BY row_id ASC",
      )
      .all() as Array<{ message_id: string; row_json: string }>;
    const rootRow = JSON.parse(rows[0].row_json);
    const replyRow = JSON.parse(rows[1].row_json);
    expect(rootRow.parent_message_id).toBeUndefined();
    expect(rootRow.reply_to_message_id).toBeUndefined();
    expect(replyRow.parent_message_id).toBe("root-1");
    expect(replyRow.reply_to_message_id).toBeUndefined();
    verifyDb.close();
  });
});
