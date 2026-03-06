import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type Json = Record<string, any>;

export interface MigrateArchivedParentIdsOptions {
  db_path: string;
  dry_run?: boolean;
  no_backup?: boolean;
}

export interface MigrateArchivedParentIdsReport {
  chats_seen: number;
  threads_seen: number;
  archived_rows_seen: number;
  rows_updated: number;
  parent_ids_assigned: number;
  parent_ids_cleared: number;
  legacy_reply_to_message_ids_removed: number;
  backup_path?: string;
}

type ArchivedMessage = {
  row_id: number;
  chat_id: string;
  thread_id: string;
  message_id: string;
  date_ms: number;
  row: Json;
  is_explicit_root: boolean;
};

function openDb(dbPath: string): DatabaseSync {
  return new DatabaseSync(path.resolve(dbPath));
}

function parseJson(value: string): Json | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function createBackupPath(dbPath: string): string {
  return `${dbPath}.bak.${Date.now()}`;
}

function currentParentMessageId(row: Json): string | undefined {
  if (
    typeof row.parent_message_id === "string" &&
    row.parent_message_id.trim().length > 0
  ) {
    return row.parent_message_id.trim();
  }
  if (
    typeof row.reply_to_message_id === "string" &&
    row.reply_to_message_id.trim().length > 0
  ) {
    return row.reply_to_message_id.trim();
  }
  return undefined;
}

export async function migrateArchivedParentMessageIds(
  options: MigrateArchivedParentIdsOptions,
): Promise<MigrateArchivedParentIdsReport> {
  const dbPath = path.resolve(options.db_path);
  if (!options.dry_run && !options.no_backup) {
    const backupPath = createBackupPath(dbPath);
    await fs.copyFile(dbPath, backupPath);
    const report = await migrateArchivedParentMessageIdsInternal(options, backupPath);
    return report;
  }
  return migrateArchivedParentMessageIdsInternal(options);
}

async function migrateArchivedParentMessageIdsInternal(
  options: MigrateArchivedParentIdsOptions,
  backupPath?: string,
): Promise<MigrateArchivedParentIdsReport> {
  const db = openDb(options.db_path);
  const rows = db
    .prepare(
      `SELECT row_id, chat_id, thread_id, message_id, COALESCE(date_ms, 0) as date_ms, row_json
         FROM archived_rows
        WHERE thread_id IS NOT NULL
          AND thread_id <> ''
          AND message_id IS NOT NULL
          AND message_id <> ''
        ORDER BY chat_id, thread_id, date_ms ASC, row_id ASC`,
    )
    .all() as Array<{
    row_id: number;
    chat_id: string;
    thread_id: string;
    message_id: string;
    date_ms: number;
    row_json: string;
  }>;

  const byChatThread = new Map<string, ArchivedMessage[]>();
  const chats = new Set<string>();
  for (const entry of rows) {
    const row = parseJson(entry.row_json);
    if (!row) continue;
    const key = `${entry.chat_id}\u0000${entry.thread_id}`;
    chats.add(entry.chat_id);
    const bucket = byChatThread.get(key) ?? [];
    bucket.push({
      row_id: entry.row_id,
      chat_id: entry.chat_id,
      thread_id: entry.thread_id,
      message_id: entry.message_id,
      date_ms: Number(entry.date_ms ?? 0),
      row,
      is_explicit_root:
        row.reply_to == null || `${row.reply_to ?? ""}`.trim().length === 0,
    });
    byChatThread.set(key, bucket);
  }

  let rowsUpdated = 0;
  let parentIdsAssigned = 0;
  let parentIdsCleared = 0;
  let legacyReplyIdsRemoved = 0;
  const updates: Array<{ row_id: number; row_json: string }> = [];

  for (const threadRows of byChatThread.values()) {
    if (!threadRows.length) continue;
    const explicitRoot = threadRows.find((row) => row.is_explicit_root);
    const root = explicitRoot ?? threadRows[0];
    for (const item of threadRows) {
      let changed = false;
      const currentParent = currentParentMessageId(item.row);
      if (item.message_id === root.message_id) {
        if (item.row.parent_message_id != null) {
          delete item.row.parent_message_id;
          parentIdsCleared += 1;
          changed = true;
        }
        if (item.row.reply_to_message_id != null) {
          delete item.row.reply_to_message_id;
          legacyReplyIdsRemoved += 1;
          changed = true;
        }
      } else {
        if (currentParent !== root.message_id) {
          item.row.parent_message_id = root.message_id;
          parentIdsAssigned += 1;
          changed = true;
        } else if (item.row.parent_message_id !== root.message_id) {
          item.row.parent_message_id = root.message_id;
          parentIdsAssigned += 1;
          changed = true;
        }
        if (item.row.reply_to_message_id != null) {
          delete item.row.reply_to_message_id;
          legacyReplyIdsRemoved += 1;
          changed = true;
        }
      }
      if (changed) {
        rowsUpdated += 1;
        updates.push({
          row_id: item.row_id,
          row_json: JSON.stringify(item.row),
        });
      }
    }
  }

  if (!options.dry_run && updates.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = db.prepare("UPDATE archived_rows SET row_json = ? WHERE row_id = ?");
      for (const update of updates) {
        stmt.run(update.row_json, update.row_id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  db.close();

  return {
    chats_seen: chats.size,
    threads_seen: byChatThread.size,
    archived_rows_seen: rows.length,
    rows_updated: rowsUpdated,
    parent_ids_assigned: parentIdsAssigned,
    parent_ids_cleared: parentIdsCleared,
    legacy_reply_to_message_ids_removed: legacyReplyIdsRemoved,
    backup_path: backupPath,
  };
}
