/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { getLogger } from "@cocalc/conat/logger";
import type { ImmerDB } from "@cocalc/sync/editor/immer-db";

const logger = getLogger("frontend:chat:close-syncdb");
export const CHAT_CLOSE_SAVE_TIMEOUT_MS = 30_000;
export const CHAT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_SAVE_ATTEMPTS = 3;

type ChatSyncDB = Pick<
  ImmerDB,
  | "get_state"
  | "has_unsaved_changes"
  | "is_read_only"
  | "save_to_disk"
  | "close"
  | "path"
  | "project_id"
>;

const closing = new WeakMap<ChatSyncDB, Promise<void>>();

async function bounded(
  work: Promise<unknown> | void,
  timeoutMs: number,
  operation: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`chat teardown ${operation} timed out`)),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function needsSave(syncdb: ChatSyncDB): boolean {
  return (
    syncdb.get_state() === "ready" &&
    !syncdb.is_read_only() &&
    syncdb.has_unsaved_changes() === true
  );
}

async function saveThenClose(syncdb: ChatSyncDB): Promise<void> {
  const deadline = Date.now() + CHAT_CLOSE_SAVE_TIMEOUT_MS;
  try {
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
      if (!needsSave(syncdb)) break;
      try {
        await bounded(syncdb.save_to_disk(), deadline - Date.now(), "save");
      } catch (error) {
        if (attempt === MAX_SAVE_ATTEMPTS - 1 || Date.now() >= deadline)
          throw error;
        // An older in-flight save can reject because newer edits arrived, or
        // routing can reconnect while draining. Retry without a busy loop.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // save_to_disk reuses an in-flight promise. That write may predate the
      // last message, so successful completion alone does not mean clean.
    }
    if (needsSave(syncdb)) {
      throw Error("chat remained dirty after bounded teardown saves");
    }
  } catch (error) {
    // Conat retains the edits; ready-unsaved recovery retries on reopen.
    logger.warn("chat disk save during teardown failed", {
      project_id: syncdb.project_id,
      path: syncdb.path,
      error: `${error}`,
    });
  } finally {
    try {
      await bounded(syncdb.close(), CHAT_CLOSE_TIMEOUT_MS, "close");
    } catch (error) {
      logger.warn("chat syncdb close failed", {
        project_id: syncdb.project_id,
        path: syncdb.path,
        error: `${error}`,
      });
    }
  }
}

/** Drain only this owned instance, never a later chat opened at the same path. */
export function closeChatSyncdb(syncdb: ChatSyncDB): Promise<void> {
  let pending = closing.get(syncdb);
  if (!pending) {
    pending = Promise.resolve().then(() => saveThenClose(syncdb));
    closing.set(syncdb, pending);
  }
  return pending;
}
