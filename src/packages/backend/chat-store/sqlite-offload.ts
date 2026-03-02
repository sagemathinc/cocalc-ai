import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("lite:hub:sqlite:chat-offload");

const DEFAULT_KEEP_RECENT_MESSAGES = 500;
const DEFAULT_MAX_HEAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_HEAD_MESSAGES = 500;

type Json = Record<string, any>;

export type ChatStoreScope = "chat" | "before_date" | "thread" | "messages";

export interface EnsureChatStoreOptions {
  chat_path: string;
  db_path?: string;
}

export interface EnsureChatStoreResult {
  chat_id: string;
  db_path: string;
  created: boolean;
}

export interface ChatStoreStatsOptions {
  chat_path: string;
  db_path?: string;
}

export interface ChatStoreStatsResult {
  chat_id: string;
  chat_path: string;
  db_path: string;
  head_bytes: number;
  head_rows: number;
  head_chat_rows: number;
  archived_rows: number;
  archived_bytes: number;
  segments: number;
  keep_recent_messages: number;
  max_head_bytes: number;
  max_head_messages: number;
  last_rotated_at_ms?: number;
  pending_rotate_op_id?: string;
  pending_rotate_status?: string;
  pending_rotate_error?: string;
}

export interface RotateChatStoreOptions {
  chat_path: string;
  db_path?: string;
  keep_recent_messages?: number;
  max_head_bytes?: number;
  max_head_messages?: number;
  require_idle?: boolean;
  force?: boolean;
  dry_run?: boolean;
}

export interface RotateChatStoreResult {
  rotated: boolean;
  reason?: string;
  dry_run?: boolean;
  chat_id: string;
  maintenance_op_id?: string;
  maintenance_status?: string;
  segment_id?: string;
  segment_seq?: number;
  archived_rows?: number;
  archived_bytes?: number;
  kept_chat_rows?: number;
  head_bytes_before?: number;
  head_bytes_after?: number;
  head_rows_before?: number;
  head_rows_after?: number;
  generating_rows?: number;
  rewrite_warning?: string;
}

export interface ListChatStoreSegmentsOptions {
  chat_path: string;
  db_path?: string;
  limit?: number;
  offset?: number;
}

export interface ChatStoreSegment {
  segment_id: string;
  seq: number;
  created_at_ms: number;
  from_date_ms?: number;
  to_date_ms?: number;
  from_message_id?: string;
  to_message_id?: string;
  row_count: number;
  payload_sha256: string;
  payload_codec: string;
  payload_bytes: number;
}

export interface ListChatStoreSegmentsResult {
  chat_id: string;
  segments: ChatStoreSegment[];
}

export interface ReadArchivedOptions {
  chat_path: string;
  db_path?: string;
  before_date_ms?: number;
  thread_id?: string;
  limit?: number;
  offset?: number;
}

export interface ArchivedRow {
  row_id: number;
  segment_id: string;
  message_id?: string;
  thread_id?: string;
  sender_id?: string;
  event?: string;
  date_ms?: number;
  excerpt?: string;
  row: Json;
}

export interface ReadArchivedResult {
  chat_id: string;
  rows: ArchivedRow[];
  offset: number;
  next_offset?: number;
}

export interface ReadArchivedHitOptions {
  chat_path: string;
  db_path?: string;
  row_id?: number;
  message_id?: string;
  thread_id?: string;
}

export interface ReadArchivedHitResult {
  chat_id: string;
  row?: ArchivedRow;
}

export interface SearchArchivedOptions {
  chat_path: string;
  query: string;
  db_path?: string;
  thread_id?: string;
  exclude_thread_ids?: string[];
  limit?: number;
  offset?: number;
}

export interface SearchArchivedHit {
  row_id: number;
  segment_id: string;
  message_id?: string;
  thread_id?: string;
  date_ms?: number;
  excerpt?: string;
  snippet?: string;
}

export interface SearchArchivedResult {
  chat_id: string;
  hits: SearchArchivedHit[];
  offset: number;
  total_hits: number;
  next_offset?: number;
}

export interface DeleteChatStoreDataOptions {
  chat_path: string;
  db_path?: string;
  scope: ChatStoreScope;
  before_date_ms?: number;
  thread_id?: string;
  message_ids?: string[];
}

export interface DeleteChatStoreDataResult {
  chat_id: string;
  scope: ChatStoreScope;
  deleted_rows: number;
  deleted_segments: number;
}

export interface VacuumChatStoreOptions {
  chat_path: string;
  db_path?: string;
}

export interface VacuumChatStoreResult {
  chat_id: string;
  db_path: string;
  before_bytes: number;
  after_bytes: number;
}

type ParsedLine = {
  line: string;
  obj?: Json;
  event?: string;
  date_ms?: number;
  is_chat: boolean;
  generating: boolean;
  message_id?: string;
  thread_id?: string;
  sender_id?: string;
  excerpt?: string;
};

type RotateOpStatus = "segment_written" | "done" | "conflict";

type RotateMaintenanceOp = {
  op_id: string;
  chat_id: string;
  status: RotateOpStatus;
  source_sha256?: string;
  head_after_sha256?: string;
  head_after_jsonl?: string;
  segment_id?: string;
  updated_at_ms: number;
  error?: string;
};

const dbCache = new Map<string, DatabaseSync>();

function resolveDbPath(override?: string): string {
  if (override) return path.resolve(override);
  const envPath = `${process.env.COCALC_CHAT_OFFLOAD_DB ?? ""}`.trim();
  if (envPath) return path.resolve(envPath);
  const home = `${process.env.HOME ?? ""}`.trim() || process.cwd();
  return path.join(home, ".local", "share", "cocalc", "chats", "offload-v1.sqlite3");
}

function ensureDbDir(dbPath: string): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
}

function openDb(dbPath: string): DatabaseSync {
  const resolved = path.resolve(dbPath);
  const cached = dbCache.get(resolved);
  if (cached) return cached;
  ensureDbDir(resolved);
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_registry (
      chat_id TEXT PRIMARY KEY,
      chat_path TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_rotated_at_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS segments (
      segment_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      from_date_ms INTEGER,
      to_date_ms INTEGER,
      from_message_id TEXT,
      to_message_id TEXT,
      row_count INTEGER NOT NULL,
      payload_codec TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      payload_sha256 TEXT NOT NULL,
      FOREIGN KEY(chat_id) REFERENCES chat_registry(chat_id) ON DELETE CASCADE,
      UNIQUE(chat_id, seq)
    );
    CREATE TABLE IF NOT EXISTS maintenance_ops (
      op_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      source_sha256 TEXT,
      head_after_sha256 TEXT,
      head_after_jsonl TEXT,
      segment_id TEXT,
      error TEXT,
      FOREIGN KEY(chat_id) REFERENCES chat_registry(chat_id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES segments(segment_id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS maintenance_ops_chat_status_idx
      ON maintenance_ops(chat_id, type, status, updated_at_ms DESC);
    CREATE TABLE IF NOT EXISTS archived_rows (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      event TEXT,
      message_id TEXT,
      thread_id TEXT,
      sender_id TEXT,
      date_ms INTEGER,
      excerpt TEXT,
      row_json TEXT NOT NULL,
      FOREIGN KEY(chat_id) REFERENCES chat_registry(chat_id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES segments(segment_id) ON DELETE CASCADE,
      UNIQUE(segment_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS archived_rows_chat_date_idx
      ON archived_rows(chat_id, date_ms DESC, row_id DESC);
    CREATE INDEX IF NOT EXISTS archived_rows_chat_thread_date_idx
      ON archived_rows(chat_id, thread_id, date_ms DESC, row_id DESC);
    CREATE INDEX IF NOT EXISTS archived_rows_message_id_idx
      ON archived_rows(message_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS archived_rows_fts
      USING fts5(body, tokenize='unicode61');
  `);
  const cur = db
    .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
    .get() as { value?: string } | undefined;
  if (!cur?.value) {
    db.prepare(
      "INSERT INTO schema_meta(key, value) VALUES('schema_version', '1')",
    ).run();
  }
  dbCache.set(resolved, db);
  return db;
}

function normalizeChatPath(chatPath: string): string {
  if (!chatPath || typeof chatPath !== "string") {
    throw Error("chat_path must be a non-empty string");
  }
  return path.resolve(chatPath);
}

function parseDateMs(value: any): number | undefined {
  if (value == null) return;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const d = new Date(value);
  if (!Number.isFinite(d.valueOf())) return;
  return d.valueOf();
}

function extractExcerpt(obj: Json): string | undefined {
  const history = Array.isArray(obj?.history) ? obj.history : undefined;
  const first = history?.[0];
  if (typeof first?.content === "string" && first.content.trim()) {
    return first.content.slice(0, 500);
  }
  return;
}

function extractBody(obj: Json): string {
  if (obj?.event !== "chat") return "";
  const history = Array.isArray(obj?.history) ? obj.history : undefined;
  const first = history?.[0];
  if (typeof first?.content === "string") return first.content;
  return "";
}

function parseChatFile(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const rawLine of text.split("\n")) {
    if (!rawLine) continue;
    let obj: Json;
    try {
      obj = JSON.parse(rawLine) as Json;
    } catch {
      out.push({
        line: rawLine,
        is_chat: false,
        generating: false,
      });
      continue;
    }
    const event = typeof obj.event === "string" ? obj.event : undefined;
    const is_chat = event === "chat";
    out.push({
      line: rawLine,
      obj,
      event,
      date_ms: parseDateMs(obj.date),
      is_chat,
      generating: !!obj.generating,
      message_id:
        typeof obj.message_id === "string" ? obj.message_id : undefined,
      thread_id:
        typeof obj.thread_id === "string" ? obj.thread_id : undefined,
      sender_id: typeof obj.sender_id === "string" ? obj.sender_id : undefined,
      excerpt: extractExcerpt(obj),
    });
  }
  return out;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function getPendingRotateOp(
  db: DatabaseSync,
  chat_id: string,
): RotateMaintenanceOp | undefined {
  return db
    .prepare(
      `SELECT op_id, chat_id, status, source_sha256, head_after_sha256, head_after_jsonl,
              segment_id, updated_at_ms, error
         FROM maintenance_ops
        WHERE chat_id = ?
          AND type = 'rotate'
          AND status = 'segment_written'
        ORDER BY updated_at_ms DESC
        LIMIT 1`,
    )
    .get(chat_id) as RotateMaintenanceOp | undefined;
}

async function applyPendingRotateOp({
  db,
  chatPath,
  op,
}: {
  db: DatabaseSync;
  chatPath: string;
  op: RotateMaintenanceOp;
}): Promise<{
  applied: boolean;
  status: RotateOpStatus;
  warning?: string;
}> {
  const now = Date.now();
  if (!op.head_after_jsonl) {
    const warning = `pending rotate op ${op.op_id} has no head_after_jsonl`;
    db.prepare(
      "UPDATE maintenance_ops SET status = 'conflict', updated_at_ms = ?, error = ? WHERE op_id = ?",
    ).run(now, warning, op.op_id);
    return { applied: false, status: "conflict", warning };
  }

  let currentRaw = "";
  try {
    currentRaw = await fs.readFile(chatPath, "utf8");
  } catch {
    currentRaw = "";
  }
  const currentSha = sha256Hex(currentRaw);
  if (op.source_sha256 && currentSha !== op.source_sha256) {
    const warning = `pending rotate op ${op.op_id} source hash mismatch; chat file changed since segment write`;
    db.prepare(
      "UPDATE maintenance_ops SET status = 'conflict', updated_at_ms = ?, error = ? WHERE op_id = ?",
    ).run(now, warning, op.op_id);
    return { applied: false, status: "conflict", warning };
  }

  const temp = `${chatPath}.offload-${op.op_id}.tmp`;
  try {
    await fs.writeFile(temp, op.head_after_jsonl, "utf8");
    await fs.rename(temp, chatPath);
  } catch (err) {
    try {
      await fs.unlink(temp);
    } catch {
      // ignore cleanup errors
    }
    const warning = `pending rotate op ${op.op_id} rewrite failed: ${err}`;
    db.prepare(
      "UPDATE maintenance_ops SET updated_at_ms = ?, error = ? WHERE op_id = ?",
    ).run(now, warning, op.op_id);
    return { applied: false, status: "segment_written", warning };
  }

  db.prepare(
    "UPDATE maintenance_ops SET status = 'done', updated_at_ms = ?, error = NULL, head_after_jsonl = NULL WHERE op_id = ?",
  ).run(now, op.op_id);
  return { applied: true, status: "done" };
}

async function resumePendingRotate({
  db,
  chat_id,
  chatPath,
}: {
  db: DatabaseSync;
  chat_id: string;
  chatPath: string;
}): Promise<{
  resumed: boolean;
  op_id?: string;
  status?: RotateOpStatus;
  warning?: string;
}> {
  const pending = getPendingRotateOp(db, chat_id);
  if (!pending) return { resumed: false };
  const applied = await applyPendingRotateOp({ db, chatPath, op: pending });
  return {
    resumed: true,
    op_id: pending.op_id,
    status: applied.status,
    warning: applied.warning,
  };
}

function getOrCreateChatId(db: DatabaseSync, chatPath: string): {
  chat_id: string;
  created: boolean;
} {
  const now = Date.now();
  const existing = db
    .prepare(
      "SELECT chat_id FROM chat_registry WHERE chat_path = ?",
    )
    .get(chatPath) as { chat_id?: string } | undefined;
  if (existing?.chat_id) {
    db.prepare(
      "UPDATE chat_registry SET updated_at_ms = ? WHERE chat_id = ?",
    ).run(now, existing.chat_id);
    return { chat_id: existing.chat_id, created: false };
  }
  const chat_id = randomUUID();
  db.prepare(
    "INSERT INTO chat_registry(chat_id, chat_path, created_at_ms, updated_at_ms) VALUES(?, ?, ?, ?)",
  ).run(chat_id, chatPath, now, now);
  return { chat_id, created: true };
}

function getDbSize(dbPath: string): number {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

function deleteFtsRows(db: DatabaseSync, rowIds: number[]): void {
  if (!rowIds.length) return;
  const stmt = db.prepare("DELETE FROM archived_rows_fts WHERE rowid = ?");
  for (const rowId of rowIds) stmt.run(rowId);
}

function deleteScopeWhere({
  scope,
  before_date_ms,
  thread_id,
  message_ids,
}: {
  scope: ChatStoreScope;
  before_date_ms?: number;
  thread_id?: string;
  message_ids?: string[];
}): { where: string; params: any[] } {
  if (scope === "chat") {
    return { where: "1=1", params: [] };
  }
  if (scope === "before_date") {
    if (!Number.isFinite(before_date_ms)) {
      throw Error("before_date_ms must be provided for scope=before_date");
    }
    return { where: "date_ms IS NOT NULL AND date_ms <= ?", params: [before_date_ms] };
  }
  if (scope === "thread") {
    if (!thread_id) throw Error("thread_id must be provided for scope=thread");
    return { where: "thread_id = ?", params: [thread_id] };
  }
  if (!message_ids?.length) {
    throw Error("message_ids must be provided for scope=messages");
  }
  const placeholders = message_ids.map(() => "?").join(", ");
  return {
    where: `message_id IN (${placeholders})`,
    params: message_ids,
  };
}

export function ensureChatStore({
  chat_path,
  db_path,
}: EnsureChatStoreOptions): EnsureChatStoreResult {
  const chatPath = normalizeChatPath(chat_path);
  const dbPath = resolveDbPath(db_path);
  const db = openDb(dbPath);
  const { chat_id, created } = getOrCreateChatId(db, chatPath);
  return { chat_id, db_path: dbPath, created };
}

export async function getChatStoreStats({
  chat_path,
  db_path,
}: ChatStoreStatsOptions): Promise<ChatStoreStatsResult> {
  const chatPath = normalizeChatPath(chat_path);
  const dbPath = resolveDbPath(db_path);
  const db = openDb(dbPath);
  const { chat_id } = getOrCreateChatId(db, chatPath);
  const resumed = await resumePendingRotate({ db, chat_id, chatPath });
  if (resumed.warning) {
    logger.warn("chat offload pending rotate resume", {
      chatPath,
      chat_id,
      op_id: resumed.op_id,
      status: resumed.status,
      warning: resumed.warning,
    });
  }
  let raw = "";
  try {
    raw = await fs.readFile(chatPath, "utf8");
  } catch {
    raw = "";
  }
  const parsed = parseChatFile(raw);
  const headRows = parsed.length;
  const headChatRows = parsed.filter((x) => x.is_chat).length;
  const archived = db
    .prepare(
      "SELECT COUNT(*) as c, COALESCE(SUM(LENGTH(row_json)), 0) as b FROM archived_rows WHERE chat_id = ?",
    )
    .get(chat_id) as { c: number; b: number };
  const segments = db
    .prepare("SELECT COUNT(*) as c FROM segments WHERE chat_id = ?")
    .get(chat_id) as { c: number };
  const reg = db
    .prepare("SELECT last_rotated_at_ms FROM chat_registry WHERE chat_id = ?")
    .get(chat_id) as { last_rotated_at_ms?: number } | undefined;
  const pending = getPendingRotateOp(db, chat_id);
  return {
    chat_id,
    chat_path: chatPath,
    db_path: dbPath,
    head_bytes: Buffer.byteLength(raw),
    head_rows: headRows,
    head_chat_rows: headChatRows,
    archived_rows: Number(archived?.c ?? 0),
    archived_bytes: Number(archived?.b ?? 0),
    segments: Number(segments?.c ?? 0),
    keep_recent_messages: DEFAULT_KEEP_RECENT_MESSAGES,
    max_head_bytes: DEFAULT_MAX_HEAD_BYTES,
    max_head_messages: DEFAULT_MAX_HEAD_MESSAGES,
    last_rotated_at_ms: reg?.last_rotated_at_ms,
    pending_rotate_op_id: pending?.op_id,
    pending_rotate_status: pending?.status,
    pending_rotate_error: pending?.error,
  };
}

export async function rotateChatStore({
  chat_path,
  db_path,
  keep_recent_messages = DEFAULT_KEEP_RECENT_MESSAGES,
  max_head_bytes = DEFAULT_MAX_HEAD_BYTES,
  max_head_messages = DEFAULT_MAX_HEAD_MESSAGES,
  require_idle = true,
  force = false,
  dry_run = false,
}: RotateChatStoreOptions): Promise<RotateChatStoreResult> {
  const chatPath = normalizeChatPath(chat_path);
  const dbPath = resolveDbPath(db_path);
  const db = openDb(dbPath);
  const { chat_id } = getOrCreateChatId(db, chatPath);
  const resumed = await resumePendingRotate({ db, chat_id, chatPath });
  if (resumed.warning) {
    logger.warn("chat offload pending rotate resume", {
      chatPath,
      chat_id,
      op_id: resumed.op_id,
      status: resumed.status,
      warning: resumed.warning,
    });
  }
  const pendingAfterResume = getPendingRotateOp(db, chat_id);
  if (pendingAfterResume) {
    return {
      rotated: false,
      reason: `pending rotate operation requires recovery (${pendingAfterResume.op_id})`,
      chat_id,
      maintenance_op_id: pendingAfterResume.op_id,
      maintenance_status: pendingAfterResume.status,
    };
  }
  const raw = await fs.readFile(chatPath, "utf8");
  const parsed = parseChatFile(raw);
  const chatRows = parsed
    .map((row, idx) => ({ row, idx }))
    .filter((x) => x.row.is_chat);
  const generatingRows = chatRows.filter((x) => x.row.generating).length;
  if (require_idle && generatingRows > 0 && !force) {
    return {
      rotated: false,
      reason: `chat has ${generatingRows} generating rows`,
      chat_id,
      generating_rows: generatingRows,
      head_bytes_before: Buffer.byteLength(raw),
      head_rows_before: parsed.length,
    };
  }
  const shouldRotate =
    force ||
    Buffer.byteLength(raw) > max_head_bytes ||
    chatRows.length > max_head_messages ||
    chatRows.length > keep_recent_messages;
  if (!shouldRotate) {
    return {
      rotated: false,
      reason: "thresholds not exceeded",
      chat_id,
      generating_rows: generatingRows,
      head_bytes_before: Buffer.byteLength(raw),
      head_rows_before: parsed.length,
    };
  }
  const keepSorted = [...chatRows].sort((a, b) => {
    const ad = a.row.date_ms ?? Number.MIN_SAFE_INTEGER;
    const bd = b.row.date_ms ?? Number.MIN_SAFE_INTEGER;
    if (ad !== bd) return bd - ad;
    return b.idx - a.idx;
  });
  const keepIdx = new Set<number>();
  for (const item of keepSorted.slice(0, Math.max(0, keep_recent_messages))) {
    keepIdx.add(item.idx);
  }
  for (const item of chatRows) {
    if (item.row.generating) keepIdx.add(item.idx);
  }
  // Preserve thread root anchors for any thread that still has kept rows.
  // Without this, replies can remain in head while their root is archived,
  // causing "orphan"/date-only thread presentation in the UI.
  const rootIdxByThreadId = new Map<string, number>();
  for (const item of chatRows) {
    const threadId = `${item.row.thread_id ?? ""}`.trim();
    if (!threadId) continue;
    const replyTo = (item.row.obj as any)?.reply_to;
    if (replyTo == null || `${replyTo}`.trim() === "") {
      if (!rootIdxByThreadId.has(threadId)) {
        rootIdxByThreadId.set(threadId, item.idx);
      }
    }
  }
  const keptThreadIds = new Set<string>();
  for (const item of chatRows) {
    if (!keepIdx.has(item.idx)) continue;
    const threadId = `${item.row.thread_id ?? ""}`.trim();
    if (!threadId) continue;
    keptThreadIds.add(threadId);
  }
  for (const threadId of keptThreadIds) {
    const rootIdx = rootIdxByThreadId.get(threadId);
    if (rootIdx != null) keepIdx.add(rootIdx);
  }
  const archivedCandidates = chatRows.filter((x) => !keepIdx.has(x.idx));
  if (!archivedCandidates.length) {
    return {
      rotated: false,
      reason: "no archive candidates after keep policy",
      chat_id,
      generating_rows: generatingRows,
      head_bytes_before: Buffer.byteLength(raw),
      head_rows_before: parsed.length,
    };
  }
  const archivedSorted = archivedCandidates.sort((a, b) => {
    const ad = a.row.date_ms ?? Number.MIN_SAFE_INTEGER;
    const bd = b.row.date_ms ?? Number.MIN_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    return a.idx - b.idx;
  });
  const archivedLines = archivedSorted.map((x) => x.row.line);
  const archivedCountByThreadId = new Map<string, number>();
  for (const item of archivedSorted) {
    const threadId = `${item.row.thread_id ?? ""}`.trim();
    if (!threadId) continue;
    archivedCountByThreadId.set(
      threadId,
      (archivedCountByThreadId.get(threadId) ?? 0) + 1,
    );
  }
  const keptLines = parsed
    .map((row, idx) => ({ row, idx }))
    .filter((x) => !x.row.is_chat || keepIdx.has(x.idx))
    .map((x) => {
      if (x.row.event !== "chat-thread-config" || !x.row.obj) {
        return x.row.line;
      }
      const threadId = `${x.row.thread_id ?? ""}`.trim();
      if (!threadId) return x.row.line;
      const archivedCount = archivedCountByThreadId.get(threadId);
      if (!archivedCount) return x.row.line;
      const cfg = x.row.obj as Record<string, any>;
      const prevCount = Number(cfg.archived_chat_rows ?? 0);
      const nextCount =
        (Number.isFinite(prevCount) ? prevCount : 0) + archivedCount;
      return JSON.stringify({
        ...cfg,
        archived_chat_rows: nextCount,
      });
    });
  const archivedBytes = archivedLines.reduce(
    (sum, line) => sum + Buffer.byteLength(line),
    0,
  );
  const headBeforeBytes = Buffer.byteLength(raw);
  const headAfterRaw = keptLines.length ? `${keptLines.join("\n")}\n` : "";
  const headAfterBytes = Buffer.byteLength(headAfterRaw);
  if (dry_run) {
    return {
      rotated: true,
      dry_run: true,
      chat_id,
      archived_rows: archivedLines.length,
      archived_bytes: archivedBytes,
      kept_chat_rows: keepIdx.size,
      head_bytes_before: headBeforeBytes,
      head_bytes_after: headAfterBytes,
      head_rows_before: parsed.length,
      head_rows_after: keptLines.length,
      generating_rows: generatingRows,
    };
  }

  const segment_id = randomUUID();
  const now = Date.now();
  const fromDate = archivedSorted[0]?.row.date_ms;
  const toDate = archivedSorted[archivedSorted.length - 1]?.row.date_ms;
  const fromMessage = archivedSorted[0]?.row.message_id;
  const toMessage = archivedSorted[archivedSorted.length - 1]?.row.message_id;
  const payloadSha = sha256Hex(archivedLines.join("\n"));
  const sourceSha = sha256Hex(raw);
  const headAfterSha = sha256Hex(headAfterRaw);
  const nextSeqRow = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM segments WHERE chat_id = ?")
    .get(chat_id) as { seq: number };
  const segmentSeq = Number(nextSeqRow?.seq ?? 1);
  const maintenanceOpId = randomUUID();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO segments(
        segment_id, chat_id, seq, created_at_ms, from_date_ms, to_date_ms,
        from_message_id, to_message_id, row_count, payload_codec, payload_bytes, payload_sha256
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      segment_id,
      chat_id,
      segmentSeq,
      now,
      fromDate ?? null,
      toDate ?? null,
      fromMessage ?? null,
      toMessage ?? null,
      archivedSorted.length,
      "jsonl-v1",
      archivedBytes,
      payloadSha,
    );
    const rowStmt = db.prepare(
      `INSERT INTO archived_rows(
        chat_id, segment_id, ordinal, event, message_id, thread_id, sender_id, date_ms, excerpt, row_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ftsStmt = db.prepare("INSERT INTO archived_rows_fts(rowid, body) VALUES(?, ?)");
    for (let i = 0; i < archivedSorted.length; i++) {
      const item = archivedSorted[i].row;
      const rowInfo = rowStmt.run(
        chat_id,
        segment_id,
        i,
        item.event ?? null,
        item.message_id ?? null,
        item.thread_id ?? null,
        item.sender_id ?? null,
        item.date_ms ?? null,
        item.excerpt ?? null,
        item.line,
      ) as { lastInsertRowid?: bigint | number };
      const rowId = Number(rowInfo.lastInsertRowid ?? 0);
      if (!rowId) continue;
      const body = item.obj ? extractBody(item.obj) : "";
      if (body.trim()) {
        ftsStmt.run(rowId, body);
      }
    }
    db.prepare(
      "UPDATE chat_registry SET updated_at_ms = ?, last_rotated_at_ms = ? WHERE chat_id = ?",
    ).run(now, now, chat_id);
    db.prepare(
      `INSERT INTO maintenance_ops(
        op_id, chat_id, type, status, created_at_ms, updated_at_ms,
        source_sha256, head_after_sha256, head_after_jsonl, segment_id
      ) VALUES(?, ?, 'rotate', 'segment_written', ?, ?, ?, ?, ?, ?)`,
    ).run(
      maintenanceOpId,
      chat_id,
      now,
      now,
      sourceSha,
      headAfterSha,
      headAfterRaw,
      segment_id,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  let rewriteWarning: string | undefined;
  const applied = await applyPendingRotateOp({
    db,
    chatPath,
    op: {
      op_id: maintenanceOpId,
      chat_id,
      status: "segment_written",
      source_sha256: sourceSha,
      head_after_sha256: headAfterSha,
      head_after_jsonl: headAfterRaw,
      segment_id,
      updated_at_ms: now,
    },
  });
  if (!applied.applied) {
    rewriteWarning = applied.warning ?? "pending rotate rewrite not yet applied";
    logger.warn("chat offload rotate: archived rows committed, rewrite pending", {
      chatPath,
      chat_id,
      segment_id,
      op_id: maintenanceOpId,
      warning: rewriteWarning,
    });
  }

  return {
    rotated: true,
    chat_id,
    maintenance_op_id: maintenanceOpId,
    maintenance_status: applied.status,
    segment_id,
    segment_seq: segmentSeq,
    archived_rows: archivedLines.length,
    archived_bytes: archivedBytes,
    kept_chat_rows: keepIdx.size,
    head_bytes_before: headBeforeBytes,
    head_bytes_after: headAfterBytes,
    head_rows_before: parsed.length,
    head_rows_after: keptLines.length,
    generating_rows: generatingRows,
    rewrite_warning: rewriteWarning,
  };
}

export function listChatStoreSegments({
  chat_path,
  db_path,
  limit = 50,
  offset = 0,
}: ListChatStoreSegmentsOptions): ListChatStoreSegmentsResult {
  const chatPath = normalizeChatPath(chat_path);
  const dbPath = resolveDbPath(db_path);
  const db = openDb(dbPath);
  const { chat_id } = getOrCreateChatId(db, chatPath);
  const rows = db
    .prepare(
      `SELECT segment_id, seq, created_at_ms, from_date_ms, to_date_ms,
              from_message_id, to_message_id, row_count, payload_codec, payload_sha256, payload_bytes
         FROM segments
        WHERE chat_id = ?
        ORDER BY seq DESC
        LIMIT ? OFFSET ?`,
    )
    .all(
      chat_id,
      Math.max(1, limit),
      Math.max(0, offset),
    ) as unknown as ChatStoreSegment[];
  return { chat_id, segments: rows };
}

export function readChatStoreArchived({
  chat_path,
  db_path,
  before_date_ms,
  thread_id,
  limit = 100,
  offset = 0,
}: ReadArchivedOptions): ReadArchivedResult {
  const chatPath = normalizeChatPath(chat_path);
  const dbPath = resolveDbPath(db_path);
  const db = openDb(dbPath);
  const { chat_id } = getOrCreateChatId(db, chatPath);
  const where = ["chat_id = ?"];
  const params: any[] = [chat_id];
  if (Number.isFinite(before_date_ms)) {
    where.push("date_ms IS NOT NULL AND date_ms < ?");
    params.push(before_date_ms);
  }
  if (thread_id) {
    where.push("thread_id = ?");
    params.push(thread_id);
  }
  params.push(Math.max(1, limit), Math.max(0, offset));
  const rows = db
    .prepare(
      `SELECT row_id, segment_id, message_id, thread_id, sender_id, event, date_ms, excerpt, row_json
         FROM archived_rows
        WHERE ${where.join(" AND ")}
        ORDER BY date_ms DESC, row_id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params) as Array<
    Omit<ArchivedRow, "row"> & { row_json: string }
  >;
  const out: ArchivedRow[] = rows.map((x) => {
    let row: Json;
    try {
      row = JSON.parse(x.row_json);
    } catch {
      row = {};
    }
    return {
      row_id: x.row_id,
      segment_id: x.segment_id,
      message_id: x.message_id,
      thread_id: x.thread_id,
      sender_id: x.sender_id,
      event: x.event,
      date_ms: x.date_ms,
      excerpt: x.excerpt,
      row,
    };
  });
  return {
    chat_id,
    rows: out,
    offset: Math.max(0, offset),
    next_offset: out.length === Math.max(1, limit) ? Math.max(0, offset) + out.length : undefined,
  };
}

export function readChatStoreArchivedHit({
  chat_path,
  db_path,
  row_id,
  message_id,
  thread_id,
}: ReadArchivedHitOptions): ReadArchivedHitResult {
  const chatPath = normalizeChatPath(chat_path);
  const dbPath = resolveDbPath(db_path);
  const db = openDb(dbPath);
  const { chat_id } = getOrCreateChatId(db, chatPath);
  const normalizedMessageId = `${message_id ?? ""}`.trim();
  const normalizedThreadId = `${thread_id ?? ""}`.trim();
  let raw:
    | (Omit<ArchivedRow, "row"> & { row_json: string })
    | undefined;
  if (Number.isFinite(row_id)) {
    raw = db
      .prepare(
        `SELECT row_id, segment_id, message_id, thread_id, sender_id, event, date_ms, excerpt, row_json
           FROM archived_rows
          WHERE chat_id = ? AND row_id = ?
          LIMIT 1`,
      )
      .get(chat_id, Math.max(1, Math.floor(Number(row_id)))) as
      | (Omit<ArchivedRow, "row"> & { row_json: string })
      | undefined;
  } else if (normalizedMessageId) {
    const where = ["chat_id = ?", "message_id = ?"];
    const params: any[] = [chat_id, normalizedMessageId];
    if (normalizedThreadId) {
      where.push("thread_id = ?");
      params.push(normalizedThreadId);
    }
    raw = db
      .prepare(
        `SELECT row_id, segment_id, message_id, thread_id, sender_id, event, date_ms, excerpt, row_json
           FROM archived_rows
          WHERE ${where.join(" AND ")}
          ORDER BY date_ms DESC, row_id DESC
          LIMIT 1`,
      )
      .get(...params) as
      | (Omit<ArchivedRow, "row"> & { row_json: string })
      | undefined;
  } else {
    throw Error("either row_id or message_id must be provided");
  }
  if (!raw) return { chat_id };
  let row: Json;
  try {
    row = JSON.parse(raw.row_json);
  } catch {
    row = {};
  }
  return {
    chat_id,
    row: {
      row_id: raw.row_id,
      segment_id: raw.segment_id,
      message_id: raw.message_id,
      thread_id: raw.thread_id,
      sender_id: raw.sender_id,
      event: raw.event,
      date_ms: raw.date_ms,
      excerpt: raw.excerpt,
      row,
    },
  };
}

export function searchChatStoreArchived({
  chat_path,
  query,
  db_path,
  thread_id,
  exclude_thread_ids,
  limit = 50,
  offset = 0,
}: SearchArchivedOptions): SearchArchivedResult {
  const q = `${query ?? ""}`.trim();
  if (!q) {
    return {
      chat_id: ensureChatStore({ chat_path, db_path }).chat_id,
      hits: [],
      offset: Math.max(0, offset),
      total_hits: 0,
    };
  }
  const chatPath = normalizeChatPath(chat_path);
  const dbPath = resolveDbPath(db_path);
  const db = openDb(dbPath);
  const { chat_id } = getOrCreateChatId(db, chatPath);
  const where = ["ar.chat_id = ?"];
  const params: any[] = [chat_id];
  if (thread_id) {
    where.push("ar.thread_id = ?");
    params.push(thread_id);
  }
  const excludedThreadIds = Array.from(
    new Set(
      (exclude_thread_ids ?? [])
        .map((x) => `${x ?? ""}`.trim())
        .filter((x) => x.length > 0),
    ),
  );
  if (excludedThreadIds.length > 0) {
    const placeholders = excludedThreadIds.map(() => "?").join(", ");
    where.push(`(ar.thread_id IS NULL OR ar.thread_id NOT IN (${placeholders}))`);
    params.push(...excludedThreadIds);
  }
  const normalizedLimit = Math.max(1, limit);
  const normalizedOffset = Math.max(0, offset);
  const ftsParams = [...params, q, normalizedLimit, normalizedOffset];
  let rows: SearchArchivedHit[] = [];
  let totalHits = 0;
  try {
    rows = db
      .prepare(
        `SELECT ar.row_id, ar.segment_id, ar.message_id, ar.thread_id, ar.date_ms, ar.excerpt,
                snippet(archived_rows_fts, 0, '<b>', '</b>', '…', 16) as snippet
           FROM archived_rows_fts
           JOIN archived_rows ar ON ar.row_id = archived_rows_fts.rowid
          WHERE ${where.join(" AND ")} AND archived_rows_fts MATCH ?
          ORDER BY bm25(archived_rows_fts), ar.date_ms DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...ftsParams) as unknown as SearchArchivedHit[];
    const countRow = db
      .prepare(
        `SELECT COUNT(*) as c
           FROM archived_rows_fts
           JOIN archived_rows ar ON ar.row_id = archived_rows_fts.rowid
          WHERE ${where.join(" AND ")} AND archived_rows_fts MATCH ?`,
      )
      .get(...params, q) as { c?: number } | undefined;
    totalHits = Number(countRow?.c ?? 0);
  } catch (err) {
    logger.warn("chat-store archived FTS search failed; using fallback", {
      chatPath,
      thread_id,
      query: q,
      err: `${err}`,
    });
  }
  if (rows.length === 0) {
    // Fallback for queries that do not tokenize well in FTS (e.g. code-ish paths,
    // markdown punctuation, or malformed FTS syntax). Keep thread/chat scoping.
    const likeNeedle = `%${q.toLowerCase()}%`;
    const fallbackParams = [
      ...params,
      likeNeedle,
      likeNeedle,
      normalizedLimit,
      normalizedOffset,
    ];
    rows = db
      .prepare(
        `SELECT ar.row_id, ar.segment_id, ar.message_id, ar.thread_id, ar.date_ms, ar.excerpt, NULL as snippet
           FROM archived_rows ar
          WHERE ${where.join(" AND ")}
            AND (
              LOWER(COALESCE(ar.excerpt, '')) LIKE ?
              OR LOWER(ar.row_json) LIKE ?
            )
          ORDER BY ar.date_ms DESC, ar.row_id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...fallbackParams) as unknown as SearchArchivedHit[];
    const fallbackCount = db
      .prepare(
        `SELECT COUNT(*) as c
           FROM archived_rows ar
          WHERE ${where.join(" AND ")}
            AND (
              LOWER(COALESCE(ar.excerpt, '')) LIKE ?
              OR LOWER(ar.row_json) LIKE ?
            )`,
      )
      .get(...params, likeNeedle, likeNeedle) as { c?: number } | undefined;
    totalHits = Number(fallbackCount?.c ?? 0);
  }
  if (totalHits < rows.length) {
    totalHits = rows.length;
  }
  return {
    chat_id,
    hits: rows,
    offset: normalizedOffset,
    total_hits: totalHits,
    next_offset:
      normalizedOffset + rows.length < totalHits
        ? normalizedOffset + rows.length
        : undefined,
  };
}

export function deleteChatStoreData({
  chat_path,
  db_path,
  scope,
  before_date_ms,
  thread_id,
  message_ids,
}: DeleteChatStoreDataOptions): DeleteChatStoreDataResult {
  const chatPath = normalizeChatPath(chat_path);
  const dbPath = resolveDbPath(db_path);
  const db = openDb(dbPath);
  const { chat_id } = getOrCreateChatId(db, chatPath);
  const { where, params } = deleteScopeWhere({
    scope,
    before_date_ms,
    thread_id,
    message_ids,
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    if (scope === "chat") {
      const rowIds = db
        .prepare("SELECT row_id FROM archived_rows WHERE chat_id = ?")
        .all(chat_id) as Array<{ row_id: number }>;
      deleteFtsRows(
        db,
        rowIds.map((x) => x.row_id),
      );
      const segCount = db
        .prepare("SELECT COUNT(*) as c FROM segments WHERE chat_id = ?")
        .get(chat_id) as { c: number };
      const rowCount = db
        .prepare("SELECT COUNT(*) as c FROM archived_rows WHERE chat_id = ?")
        .get(chat_id) as { c: number };
      db.prepare("DELETE FROM chat_registry WHERE chat_id = ?").run(chat_id);
      db.exec("COMMIT");
      return {
        chat_id,
        scope,
        deleted_rows: Number(rowCount.c ?? 0),
        deleted_segments: Number(segCount.c ?? 0),
      };
    }
    const rowIds = db
      .prepare(
        `SELECT row_id FROM archived_rows WHERE chat_id = ? AND ${where}`,
      )
      .all(chat_id, ...params) as Array<{ row_id: number }>;
    deleteFtsRows(
      db,
      rowIds.map((x) => x.row_id),
    );
    const result = db
      .prepare(
        `DELETE FROM archived_rows WHERE chat_id = ? AND ${where}`,
      )
      .run(chat_id, ...params) as { changes?: number };
    const deletedRows = Number(result.changes ?? 0);
    const orphanSegs = db
      .prepare(
        `SELECT s.segment_id
           FROM segments s
          WHERE s.chat_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM archived_rows ar WHERE ar.segment_id = s.segment_id
            )`,
      )
      .all(chat_id) as Array<{ segment_id: string }>;
    let deletedSegments = 0;
    if (orphanSegs.length) {
      const placeholders = orphanSegs.map(() => "?").join(", ");
      const segRes = db
        .prepare(`DELETE FROM segments WHERE segment_id IN (${placeholders})`)
        .run(...orphanSegs.map((x) => x.segment_id)) as { changes?: number };
      deletedSegments = Number(segRes.changes ?? 0);
    }
    db.prepare(
      "UPDATE chat_registry SET updated_at_ms = ? WHERE chat_id = ?",
    ).run(Date.now(), chat_id);
    db.exec("COMMIT");
    return {
      chat_id,
      scope,
      deleted_rows: deletedRows,
      deleted_segments: deletedSegments,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function vacuumChatStore({
  chat_path,
  db_path,
}: VacuumChatStoreOptions): VacuumChatStoreResult {
  const chatPath = normalizeChatPath(chat_path);
  const dbPath = resolveDbPath(db_path);
  const db = openDb(dbPath);
  const { chat_id } = getOrCreateChatId(db, chatPath);
  const before = getDbSize(dbPath);
  db.exec("VACUUM");
  const after = getDbSize(dbPath);
  return {
    chat_id,
    db_path: dbPath,
    before_bytes: before,
    after_bytes: after,
  };
}
