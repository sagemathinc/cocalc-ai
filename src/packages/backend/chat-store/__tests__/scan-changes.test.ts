/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  changedChatArchives,
  ensureChatStore,
  listChatStoreSegments,
  withChatIdentityArchive,
} from "../sqlite-offload";

test("archive scan selection reads bounded modification metadata; browsing does not change it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "archive-scan-"));
  const db_path = join(directory, "archive.sqlite");
  const opts = { db_path, chat_path: "/project/a.chat" };
  ensureChatStore(opts);
  const db = new DatabaseSync(db_path);
  try {
    // A registry created merely by opening a chat has no archive to scan.
    expect(
      changedChatArchives({ root: "/project", since: 0, limit: 100, db_path }),
    ).toEqual([]);
    db.prepare(
      "UPDATE chat_registry SET updated_at_ms=1000,last_rotated_at_ms=500",
    ).run();
    expect(
      changedChatArchives({
        root: "/project",
        since: 1001,
        limit: 100,
        db_path,
      }),
    ).toEqual([]);
    listChatStoreSegments(opts);
    await withChatIdentityArchive(opts, async (archive) => {
      await archive.project([]);
    });
    expect(
      changedChatArchives({
        root: "/project",
        since: 1001,
        limit: 100,
        db_path,
      }),
    ).toEqual([]);
    expect(
      changedChatArchives({
        root: "/project",
        since: 1000,
        limit: 100,
        db_path,
      }),
    ).toEqual(["/project/a.chat"]);
    expect(
      changedChatArchives({ root: "/another", since: 0, limit: 100, db_path }),
    ).toEqual([]);
    ensureChatStore({ ...opts, chat_path: "/project/b.chat" });
    db.prepare("UPDATE chat_registry SET last_rotated_at_ms=500").run();
    expect(() =>
      changedChatArchives({ root: "/project", since: 0, limit: 1, db_path }),
    ).toThrow("capacity");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
