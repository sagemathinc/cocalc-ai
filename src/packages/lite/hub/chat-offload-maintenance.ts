import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import getLogger from "@cocalc/backend/logger";
import { rotateChatStore } from "./sqlite/chat-offload";

const logger = getLogger("lite:hub:chat-offload-maintenance");

const ENABLED =
  `${process.env.COCALC_CHAT_OFFLOAD_AUTOROTATE ?? "1"}`.trim() !== "0";
const INTERVAL_MS = clampInt(
  process.env.COCALC_CHAT_OFFLOAD_BG_INTERVAL_MS,
  120_000,
  10_000,
  30 * 60_000,
);
const QUIET_MS = clampInt(
  process.env.COCALC_CHAT_OFFLOAD_BG_QUIET_MS,
  20_000,
  1_000,
  10 * 60_000,
);
const CHECK_COOLDOWN_MS = clampInt(
  process.env.COCALC_CHAT_OFFLOAD_BG_COOLDOWN_MS,
  5 * 60_000,
  10_000,
  60 * 60_000,
);
const BATCH_LIMIT = clampInt(
  process.env.COCALC_CHAT_OFFLOAD_BG_BATCH_LIMIT,
  3,
  1,
  100,
);
const LIST_LIMIT = clampInt(
  process.env.COCALC_CHAT_OFFLOAD_BG_LIST_LIMIT,
  250,
  10,
  5000,
);

const KEEP_RECENT_MESSAGES = 500;
const MAX_HEAD_BYTES = 2 * 1024 * 1024;
const MAX_HEAD_MESSAGES = 500;

let timer: NodeJS.Timeout | undefined;
let running = false;

const lastCheckByPath = new Map<string, { checkedAt: number; mtimeMs: number }>();
type ChatRegistryRow = { chat_path?: string };

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function resolveDbPath(): string {
  const configured = `${process.env.COCALC_CHAT_OFFLOAD_DB ?? ""}`.trim();
  if (configured) return path.resolve(configured);
  const home = `${process.env.HOME ?? ""}`.trim() || process.cwd();
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "cocalc",
      "chats",
      "offload-v1.sqlite3",
    );
  }
  return path.join(home, ".local", "share", "cocalc", "chats", "offload-v1.sqlite3");
}

function listKnownChats(): string[] {
  const dbPath = resolveDbPath();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { open: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT chat_path
           FROM chat_registry
          ORDER BY COALESCE(last_rotated_at_ms, 0) ASC, updated_at_ms DESC
          LIMIT ?`,
      )
      .all(LIST_LIMIT) as unknown as ChatRegistryRow[];
    return rows
      .map((row) => `${row.chat_path ?? ""}`.trim())
      .filter((chatPath) => chatPath.length > 0);
  } finally {
    db.close();
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const chats = listKnownChats();
    if (!chats.length) return;
    const now = Date.now();
    let checked = 0;
    let rotated = 0;
    for (const chatPathValue of chats) {
      if (checked >= BATCH_LIMIT) break;
      const chatPath = `${chatPathValue ?? ""}`.trim();
      if (!chatPath || !path.isAbsolute(chatPath)) continue;
      let stat;
      try {
        stat = await fs.stat(chatPath);
      } catch {
        continue;
      }
      const mtimeMs = Number(stat.mtimeMs ?? 0);
      if (!Number.isFinite(mtimeMs)) continue;
      if (now - mtimeMs < QUIET_MS) continue;
      const prev = lastCheckByPath.get(chatPath);
      if (
        prev &&
        prev.mtimeMs === mtimeMs &&
        now - prev.checkedAt < CHECK_COOLDOWN_MS
      ) {
        continue;
      }
      checked += 1;
      lastCheckByPath.set(chatPath, { checkedAt: now, mtimeMs });
      try {
        const result = await rotateChatStore({
          chat_path: chatPath,
          keep_recent_messages: KEEP_RECENT_MESSAGES,
          max_head_bytes: MAX_HEAD_BYTES,
          max_head_messages: MAX_HEAD_MESSAGES,
          require_idle: true,
          force: false,
        });
        if (result.rotated) {
          rotated += 1;
          logger.info("background chat offload rotation completed", {
            chatPath,
            segment_id: result.segment_id,
            archived_rows: result.archived_rows,
            head_bytes_before: result.head_bytes_before,
            head_bytes_after: result.head_bytes_after,
            rewrite_warning: result.rewrite_warning,
          });
        }
      } catch (err) {
        logger.warn("background chat offload rotation failed", {
          chatPath,
          err: `${err}`,
        });
      }
    }
    if (checked > 0 || rotated > 0) {
      logger.debug("background chat offload maintenance tick", {
        checked,
        rotated,
        knownChats: chats.length,
      });
    }
  } catch (err) {
    logger.warn("background chat offload maintenance tick failed", {
      err: `${err}`,
    });
  } finally {
    running = false;
  }
}

export function startChatOffloadBackgroundMaintenance(): void {
  if (!ENABLED) {
    logger.debug("background chat offload maintenance disabled");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  timer.unref?.();
  void tick();
  logger.info("background chat offload maintenance started", {
    interval_ms: INTERVAL_MS,
    quiet_ms: QUIET_MS,
    check_cooldown_ms: CHECK_COOLDOWN_MS,
    batch_limit: BATCH_LIMIT,
    list_limit: LIST_LIMIT,
  });
}

export function stopChatOffloadBackgroundMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
