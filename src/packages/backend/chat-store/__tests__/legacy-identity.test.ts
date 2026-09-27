import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateLegacyChatIdentities } from "../../collaborators/legacy-identity";
import { resolveChatIdentityRows } from "@cocalc/util/collaboration-chat-identity";
import {
  rotateChatStore,
  withChatIdentityArchive,
  readChatIdentityArchive,
  readChatStoreArchived,
  readChatStoreArchivedHit,
  searchChatStoreCombined,
  deleteChatStoreData,
} from "../sqlite-offload";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-identity-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const chat_path = path.join(directory, "legacy.chat"),
    db_path = path.join(directory, "archive.sqlite");
  const rootDate = "2026-09-27T00:00:00.000Z";
  const original = Array.from({ length: 3 }, (_, i) => ({
    event: "chat",
    sender_id: "alice",
    date: new Date(Date.parse(rootDate) + i).toISOString(),
    ...(i ? { reply_to: rootDate } : {}),
    history: [{ author_id: "alice", content: `needle ${i}`, date: rootDate }],
  }));
  await fs.writeFile(
    chat_path,
    original.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  await rotateChatStore({
    chat_path,
    db_path,
    keep_recent_messages: 1,
    force: true,
  });
  const rows: any[] = (await fs.readFile(chat_path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const db = {
    get: () => rows,
    set: (marker) => {
      const i = rows.findIndex(
        (row) =>
          row.event === marker.event && row.thread_id === marker.thread_id,
      );
      if (i < 0) rows.push(marker);
      else rows[i] = marker;
    },
    commit: () => {},
    save: async () => {},
    save_to_disk: async () => {
      await fs.writeFile(
        chat_path,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
    },
  };
  const sql = new DatabaseSync(db_path);
  const raw = () =>
    sql.prepare("SELECT row_json FROM archived_rows ORDER BY row_id").all();
  return { chat_path, db_path, rows, original, db, sql, raw };
}

test("archived legacy roots/replies get indexed IDs without payload rewrites; query/hydrate/delete agree", async () => {
  const f = await fixture();
  const before = f.raw();
  try {
    await withChatIdentityArchive(f, async (archive) => {
      expect(() => readChatStoreArchived(f)).toThrow("migration");
      expect(() => deleteChatStoreData({ ...f, scope: "chat" })).toThrow(
        "migration",
      );
      await migrateLegacyChatIdentities({
        db: f.db,
        migration_id: archive.migration_id,
        archived_rows: archive.rows,
        history_complete: true,
        assertCurrent: async () => {},
        projectArchive: archive.project,
      });
    });
    expect(f.raw()).toEqual(before);
    const all = resolveChatIdentityRows([
      ...f.rows,
      ...readChatIdentityArchive(f),
    ]);
    expect(new Set(all.messages.map((row) => row.thread_id)).size).toBe(1);
    const thread_id = all.messages[0].thread_id;
    const archived = readChatStoreArchived({ ...f, thread_id });
    expect(archived.rows).toHaveLength(2);
    const hit = readChatStoreArchivedHit({
      ...f,
      thread_id,
      message_id: archived.rows[0].message_id,
    });
    expect(hit.row?.row).toEqual(f.original[1]);
    const search = await searchChatStoreCombined({
      ...f,
      query: "needle",
      thread_id,
      include_head: true,
    });
    expect(search.hits).toHaveLength(3);
    expect(
      search.hits.every(
        (hit) => !!hit.message_id && hit.thread_id === thread_id,
      ),
    ).toBe(true);
    await rotateChatStore({ ...f, keep_recent_messages: 0, force: true });
    expect(readChatStoreArchived({ ...f, thread_id }).rows).toHaveLength(3);
    expect(f.raw().slice(0, 2)).toEqual(before);
    deleteChatStoreData({
      ...f,
      scope: "messages",
      message_ids: [archived.rows[0].message_id!],
    });
    expect(readChatStoreArchived({ ...f, thread_id }).rows).toHaveLength(2);
  } finally {
    f.sql.close();
  }
});

test("failed publication stays fenced and resumes the same durable archive operation", async () => {
  const f = await fixture();
  let operation = "";
  try {
    await expect(
      withChatIdentityArchive(f, async (archive) => {
        operation = archive.migration_id;
        await migrateLegacyChatIdentities({
          db: f.db,
          migration_id: operation,
          archived_rows: archive.rows,
          history_complete: true,
          assertCurrent: async () => {},
          projectArchive: async (markers) => {
            await archive.project(markers);
            throw Error("publication interrupted");
          },
        });
      }),
    ).rejects.toThrow("publication interrupted");
    expect(() => readChatIdentityArchive(f)).toThrow("migration");
    await withChatIdentityArchive(f, async (archive) => {
      expect(archive.migration_id).toBe(operation);
      await migrateLegacyChatIdentities({
        db: f.db,
        migration_id: operation,
        archived_rows: archive.rows,
        history_complete: true,
        assertCurrent: async () => {},
        projectArchive: archive.project,
      });
    });
    expect(readChatIdentityArchive(f)).toHaveLength(2);
  } finally {
    f.sql.close();
  }
});

test("failed SQLite completion releases the process lease for durable retry", async () => {
  const f = await fixture();
  let operation = "";
  try {
    f.sql.exec(`
      CREATE TRIGGER reject_identity_completion
      BEFORE UPDATE OF active ON legacy_identity_migrations
      WHEN NEW.active=0
      BEGIN SELECT RAISE(ABORT, 'completion interrupted'); END;
    `);
    await expect(
      withChatIdentityArchive(f, async (archive) => {
        operation = archive.migration_id;
        await migrateLegacyChatIdentities({
          db: f.db,
          migration_id: operation,
          archived_rows: archive.rows,
          history_complete: true,
          assertCurrent: async () => {},
          projectArchive: archive.project,
        });
      }),
    ).rejects.toThrow("completion interrupted");
    expect(() => readChatIdentityArchive(f)).toThrow("migration");
    f.sql.exec("DROP TRIGGER reject_identity_completion");
    await withChatIdentityArchive(f, async (archive) => {
      expect(archive.migration_id).toBe(operation);
      await migrateLegacyChatIdentities({
        db: f.db,
        migration_id: operation,
        archived_rows: archive.rows,
        history_complete: true,
        assertCurrent: async () => {},
        projectArchive: archive.project,
      });
    });
    expect(readChatIdentityArchive(f)).toHaveLength(2);
  } finally {
    f.sql.close();
  }
});
