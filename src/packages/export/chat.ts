import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ChatMessage,
  ChatThreadConfigRecord,
  ChatThreadRecord,
  ChatThreadStateRecord,
  InlineCodeLink,
  MessageHistory,
} from "@cocalc/chat";
import { readChatStoreArchived } from "@cocalc/backend/chat-store/sqlite-offload";

import type { ExportBundle, ExportFile } from "./bundle";
import { normalizeExportManifest } from "./manifest";

export type ChatExportScope =
  | "current-thread"
  | "all-non-archived-threads"
  | "all-threads";

export interface ChatExportOptions {
  chatPath: string;
  scope: ChatExportScope;
  threadId?: string;
  projectId?: string | null;
  offloadDbPath?: string;
  includeBlobs?: boolean;
  blobBaseUrl?: string;
  blobBearerToken?: string;
  exportedAt?: string;
}

export interface ChatExportAssetIndexEntry {
  originalRef: string;
  path: string;
  sha256: string;
  contentType?: string;
}

export interface ChatExportIndexEntry {
  thread_id: string;
  title: string;
  archived: boolean;
  pinned: boolean;
  message_count: number;
  live_message_count: number;
  offloaded_message_count: number;
  first_message_at?: string;
  last_message_at?: string;
  transcript_path: string;
  thread_path: string;
  messages_path: string;
}

export interface ChatExportMessageRow {
  event: "chat";
  sender_id: string;
  history: MessageHistory[];
  date: string;
  schema_version?: number;
  generating?: boolean;
  editing?: string[];
  feedback?: Record<string, unknown>;
  acp_thread_id?: string | null;
  acp_usage?: unknown;
  acp_account_id?: string;
  message_id?: string;
  thread_id?: string;
  parent_message_id?: string;
  inline_code_links?: InlineCodeLink[];
}

export interface ChatExportThreadData {
  thread_id: string;
  title: string;
  archived: boolean;
  pinned: boolean;
  thread_color?: string;
  thread_icon?: string;
  thread_image?: string;
  agent_kind?: string;
  agent_model?: string;
  agent_mode?: string;
  acp_config?: unknown;
  loop_config?: unknown;
  loop_state?: unknown;
  runtime_state?: string;
  active_message_id?: string;
  root_message_id?: string;
  created_at?: string;
  created_by?: string;
  first_message_at?: string;
  last_message_at?: string;
  message_count: number;
  live_message_count: number;
  offloaded_message_count: number;
  transcript_path: string;
  messages_path: string;
  asset_refs?: ChatExportAssetIndexEntry[];
}

type ChatRow = any;
type ChatThreadConfigRow = ChatThreadConfigRecord & { archived?: boolean };

type ThreadAggregate = {
  threadId: string;
  config?: ChatThreadConfigRow;
  state?: ChatThreadStateRecord;
  thread?: ChatThreadRecord;
  liveMessages: ChatExportMessageRow[];
  archivedMessages: ChatExportMessageRow[];
  dedupedMessages: ChatExportMessageRow[];
  title: string;
  archived: boolean;
  pinned: boolean;
  rootMessageId?: string;
  firstMessageAt?: string;
  lastMessageAt?: string;
  assetRefs: ChatExportAssetIndexEntry[];
};

type BlobReference = {
  originalRef: string;
  fetchUrl: string;
  filename: string;
};

const BLOB_MARKDOWN = /!\[[^\]]*\]\(((?:https?:\/\/[^)]+)?\/blobs\/[^)]+)\)/gi;
const BLOB_HTML = /<img[^>]+src=["']((?:https?:\/\/[^"']+)?\/blobs\/[^"']+)["'][^>]*>/gi;
const DEFAULT_ARCHIVED_PAGE_SIZE = 500;

export async function collectChatExport(
  options: ChatExportOptions,
): Promise<ExportBundle> {
  const liveRows = await readChatRows(options.chatPath);
  const liveMessages = liveRows.filter(isChatMessageRow).map(normalizeMessageRow);
  const threadRows = liveRows.filter(isThreadRecordRow);
  const configRows = selectLatestByThreadId<ChatThreadConfigRow>(
    liveRows.filter(isThreadConfigRecordRow),
    threadConfigUpdatedAt,
  );
  const stateRows = selectLatestByThreadId(
    liveRows.filter(isThreadStateRecordRow),
    threadStateUpdatedAt,
  );
  const threadIds = collectThreadIds({
    messages: liveMessages,
    threadRows,
    configRows,
    stateRows,
  });
  const selectedThreadIds = selectThreadIds({
    scope: options.scope,
    requestedThreadId: normalizeString(options.threadId),
    threadIds,
    configRows,
  });

  const threads = new Map<string, ThreadAggregate>();
  for (const threadId of selectedThreadIds) {
    threads.set(threadId, {
      threadId,
      config: configRows.get(threadId),
      state: stateRows.get(threadId),
      thread: threadRows.find((row) => normalizeString(row.thread_id) === threadId),
      liveMessages: liveMessages.filter((row) => normalizeString(row.thread_id) === threadId),
      archivedMessages: [],
      dedupedMessages: [],
      title: "",
      archived: false,
      pinned: false,
      assetRefs: [],
    });
  }

  await hydrateArchivedMessages({
    threads,
    chatPath: options.chatPath,
    offloadDbPath: options.offloadDbPath,
  });

  for (const aggregate of threads.values()) {
    aggregate.dedupedMessages = dedupeMessages([
      ...aggregate.archivedMessages,
      ...aggregate.liveMessages,
    ]);
    aggregate.dedupedMessages = orderLinearThreadMessages(aggregate.dedupedMessages);
    aggregate.rootMessageId =
      aggregate.thread?.root_message_id ||
      aggregate.dedupedMessages.find((row) => !normalizeString(row.parent_message_id))
        ?.message_id ||
      aggregate.dedupedMessages[0]?.message_id;
    aggregate.title = deriveThreadTitle(aggregate);
    aggregate.archived = aggregate.config?.archived === true;
    aggregate.pinned = aggregate.config?.pin === true;
    aggregate.firstMessageAt = aggregate.dedupedMessages[0]?.date;
    aggregate.lastMessageAt = aggregate.dedupedMessages.length
      ? aggregate.dedupedMessages[aggregate.dedupedMessages.length - 1]?.date
      : undefined;
  }

  const assetIndex = options.includeBlobs
    ? await collectChatAssets({
        threads,
        blobBaseUrl: normalizeString(options.blobBaseUrl),
        blobBearerToken: normalizeString(options.blobBearerToken),
      })
    : [];

  const files: ExportFile[] = [];
  const threadIndex: ChatExportIndexEntry[] = [];
  for (const aggregate of sortThreads(Array.from(threads.values()))) {
    const threadDir = `threads/${aggregate.threadId}`;
    const transcriptPath = `${threadDir}/transcript.md`;
    const threadPath = `${threadDir}/thread.json`;
    const messagesPath = `${threadDir}/messages.jsonl`;
    const transcript = renderThreadTranscript(aggregate);
    const threadData: ChatExportThreadData = {
      thread_id: aggregate.threadId,
      title: aggregate.title,
      archived: aggregate.archived,
      pinned: aggregate.pinned,
      thread_color: normalizeString(aggregate.config?.thread_color),
      thread_icon: normalizeString(aggregate.config?.thread_icon),
      thread_image: normalizeString(aggregate.config?.thread_image),
      agent_kind: normalizeString(aggregate.config?.agent_kind),
      agent_model: normalizeString(aggregate.config?.agent_model),
      agent_mode: normalizeString(aggregate.config?.agent_mode),
      acp_config: aggregate.config?.acp_config,
      loop_config: aggregate.config?.loop_config,
      loop_state: aggregate.config?.loop_state,
      runtime_state: normalizeString(aggregate.state?.state),
      active_message_id: normalizeString(aggregate.state?.active_message_id),
      root_message_id: aggregate.rootMessageId,
      created_at: normalizeString(aggregate.thread?.created_at),
      created_by: normalizeString(aggregate.thread?.created_by),
      first_message_at: aggregate.firstMessageAt,
      last_message_at: aggregate.lastMessageAt,
      message_count: aggregate.dedupedMessages.length,
      live_message_count: aggregate.liveMessages.length,
      offloaded_message_count: aggregate.archivedMessages.length,
      transcript_path: transcriptPath,
      messages_path: messagesPath,
      asset_refs: aggregate.assetRefs.length ? aggregate.assetRefs : undefined,
    };
    threadIndex.push({
      thread_id: aggregate.threadId,
      title: aggregate.title,
      archived: aggregate.archived,
      pinned: aggregate.pinned,
      message_count: aggregate.dedupedMessages.length,
      live_message_count: aggregate.liveMessages.length,
      offloaded_message_count: aggregate.archivedMessages.length,
      first_message_at: aggregate.firstMessageAt,
      last_message_at: aggregate.lastMessageAt,
      transcript_path: transcriptPath,
      thread_path: threadPath,
      messages_path: messagesPath,
    });
    files.push(
      {
        path: transcriptPath,
        content: transcript,
        contentType: "text/markdown; charset=utf-8",
      },
      {
        path: threadPath,
        content: `${JSON.stringify(threadData, null, 2)}\n`,
        contentType: "application/json; charset=utf-8",
      },
      {
        path: messagesPath,
        content: `${aggregate.dedupedMessages
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
        contentType: "application/x-ndjson; charset=utf-8",
      },
    );
  }

  files.push({
    path: "threads/index.json",
    content: `${JSON.stringify(threadIndex, null, 2)}\n`,
    contentType: "application/json; charset=utf-8",
  });

  if (assetIndex.length) {
    files.push({
      path: "assets/index.json",
      content: `${JSON.stringify(assetIndex, null, 2)}\n`,
      contentType: "application/json; charset=utf-8",
    });
  }

  return {
    manifest: normalizeExportManifest({
      format: "cocalc-export",
      version: 1,
      kind: "chat",
      exported_at: options.exportedAt ?? new Date().toISOString(),
      source: {
        project_id: options.projectId ?? null,
        path: options.chatPath,
        includes_offloaded_messages: true,
      },
      scope: {
        mode: options.scope,
        thread_ids: threadIndex.map((entry) => entry.thread_id),
      },
      options: {
        include_blobs: options.includeBlobs === true,
      },
      thread_count: threadIndex.length,
      message_count: threadIndex.reduce((sum, entry) => sum + entry.message_count, 0),
      asset_count: assetIndex.length,
    }),
    files,
    assets: assetIndex.length
      ? Array.from(
          new Map(
            assetIndex.map(({ path, sha256, contentType }) => {
              const content = assetContentByPath.get(path);
              if (!content) {
                throw new Error(`missing blob content for ${path}`);
              }
              return [
                path,
                {
                  originalRef: path,
                  path,
                  sha256,
                  contentType,
                  content,
                },
              ] as const;
            }),
          ).values(),
        )
      : undefined,
  };
}

const assetContentByPath = new Map<string, Uint8Array>();

async function collectChatAssets({
  threads,
  blobBaseUrl,
  blobBearerToken,
}: {
  threads: Map<string, ThreadAggregate>;
  blobBaseUrl?: string;
  blobBearerToken?: string;
}): Promise<ChatExportAssetIndexEntry[]> {
  assetContentByPath.clear();
  const assetByOriginal = new Map<string, ChatExportAssetIndexEntry>();
  const assetByPath = new Map<
    string,
    { path: string; sha256: string; contentType?: string }
  >();
  for (const aggregate of threads.values()) {
    const discovered = new Map<string, BlobReference>();
    const registerBlobRefs = (content?: string) => {
      for (const ref of extractBlobReferences(content, blobBaseUrl)) {
        discovered.set(ref.originalRef, ref);
      }
    };
    for (const message of aggregate.dedupedMessages) {
      for (const history of message.history ?? []) {
        registerBlobRefs(history?.content);
      }
    }
    registerBlobRefs(normalizeString(aggregate.config?.thread_image));
    const threadAssets: ChatExportAssetIndexEntry[] = [];
    for (const ref of Array.from(discovered.values()).sort((a, b) =>
      a.originalRef.localeCompare(b.originalRef),
    )) {
      let entry = assetByOriginal.get(ref.originalRef);
      if (!entry) {
        const fetched = await fetchBlobAsset(ref, blobBearerToken);
        const stored = assetByPath.get(fetched.path);
        if (!stored) {
          assetByPath.set(fetched.path, {
            path: fetched.path,
            sha256: fetched.sha256,
            contentType: fetched.contentType,
          });
          assetContentByPath.set(fetched.path, fetched.content);
        }
        entry = {
          originalRef: ref.originalRef,
          path: fetched.path,
          sha256: fetched.sha256,
          contentType: fetched.contentType,
        };
        assetByOriginal.set(ref.originalRef, entry);
      }
      threadAssets.push(entry);
    }
    aggregate.assetRefs = threadAssets;
  }
  return Array.from(assetByOriginal.values()).sort((a, b) =>
    a.originalRef.localeCompare(b.originalRef),
  );
}

function rewriteBlobRefs(content: string, replacements: Map<string, string>): string {
  let next = `${content ?? ""}`;
  for (const [original, replacement] of replacements.entries()) {
    next = next.split(original).join(replacement);
  }
  return next;
}

async function fetchBlobAsset(
  ref: BlobReference,
  bearerToken?: string,
): Promise<{
  path: string;
  sha256: string;
  contentType?: string;
  content: Uint8Array;
}> {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const response = await fetch(ref.fetchUrl, { headers });
  if (!response.ok) {
    throw new Error(`failed to fetch blob ${ref.originalRef}: HTTP ${response.status}`);
  }
  const content = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(content).digest("hex");
  const ext = sanitizeExtension(path.extname(ref.filename));
  return {
    path: `assets/${sha256}${ext || ".bin"}`,
    sha256,
    contentType: normalizeString(response.headers.get("content-type")) ?? undefined,
    content,
  };
}

function sanitizeExtension(ext: string): string {
  const trimmed = `${ext ?? ""}`.trim().toLowerCase();
  if (!trimmed) return "";
  return /^[.][a-z0-9._-]+$/.test(trimmed) ? trimmed : "";
}

function extractBlobReferences(
  content: string | undefined,
  blobBaseUrl?: string,
): BlobReference[] {
  const text = `${content ?? ""}`.trim();
  if (!text) return [];
  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = BLOB_MARKDOWN.exec(text)) != null) {
    urls.add(match[1]);
  }
  while ((match = BLOB_HTML.exec(text)) != null) {
    urls.add(match[1]);
  }
  const refs: BlobReference[] = [];
  for (const target of urls) {
    const parsed = parseBlobReference(target, blobBaseUrl);
    if (parsed) refs.push(parsed);
  }
  BLOB_MARKDOWN.lastIndex = 0;
  BLOB_HTML.lastIndex = 0;
  return refs;
}

function parseBlobReference(
  target: string,
  blobBaseUrl?: string,
): BlobReference | undefined {
  const trimmed = `${target ?? ""}`.trim();
  if (!trimmed) return undefined;
  const absolute = trimmed.startsWith("http://") || trimmed.startsWith("https://");
  if (!absolute && !blobBaseUrl) {
    throw new Error(
      `relative blob reference requires --blob-base-url/COCALC_API_URL: ${trimmed}`,
    );
  }
  const parsed = new URL(trimmed, absolute ? undefined : blobBaseUrl);
  if (!parsed.pathname.includes("/blobs/")) return undefined;
  const uuid = normalizeString(parsed.searchParams.get("uuid"));
  if (!uuid) return undefined;
  const filename = path.basename(parsed.pathname) || `${uuid}.bin`;
  return {
    originalRef: trimmed,
    fetchUrl: parsed.toString(),
    filename,
  };
}

async function readChatRows(chatPath: string): Promise<ChatRow[]> {
  const raw = await readFile(chatPath, "utf8");
  const rows: ChatRow[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        rows.push(parsed as ChatRow);
      }
    } catch (err) {
      throw new Error(
        `invalid JSON in ${chatPath} at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return rows;
}

function isChatMessageRow(row: any): row is ChatMessage {
  return row.event === "chat";
}

function isThreadRecordRow(row: any): row is ChatThreadRecord {
  return row.event === "chat-thread";
}

function isThreadConfigRecordRow(row: any): row is ChatThreadConfigRow {
  return row.event === "chat-thread-config";
}

function isThreadStateRecordRow(row: any): row is ChatThreadStateRecord {
  return row.event === "chat-thread-state";
}

function normalizeMessageRow(row: ChatMessage): ChatExportMessageRow {
  return {
    event: "chat",
    sender_id: normalizeString(row.sender_id) ?? "",
    history: normalizeHistory(row.history),
    date: normalizeDate(row.date),
    schema_version:
      typeof row.schema_version === "number" ? row.schema_version : undefined,
    generating: row.generating === true ? true : undefined,
    editing: Array.isArray(row.editing)
      ? row.editing
          .map((value) => normalizeString(value))
          .filter((value): value is string => !!value)
      : undefined,
    feedback:
      row.feedback && typeof row.feedback === "object"
        ? (row.feedback as Record<string, unknown>)
        : undefined,
    acp_thread_id: normalizeString(row.acp_thread_id) ?? undefined,
    acp_usage: row.acp_usage,
    acp_account_id: normalizeString(row.acp_account_id) ?? undefined,
    message_id: normalizeString(row.message_id) ?? undefined,
    thread_id: normalizeString(row.thread_id) ?? undefined,
    parent_message_id: normalizeString(row.parent_message_id) ?? undefined,
    inline_code_links: Array.isArray(row.inline_code_links)
      ? (row.inline_code_links as InlineCodeLink[])
      : undefined,
  };
}

function normalizeHistory(history: MessageHistory[] | undefined): MessageHistory[] {
  if (!Array.isArray(history)) return [];
  return history
    .map((entry) => ({
      author_id: normalizeString(entry?.author_id) ?? "",
      content: `${entry?.content ?? ""}`,
      date: normalizeDate(entry?.date),
    }))
    .reverse()
    .reverse();
}

function normalizeDate(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf())
      ? parsed.toISOString()
      : new Date(0).toISOString();
  }
  if (value instanceof Date) {
    return Number.isFinite(value.valueOf())
      ? value.toISOString()
      : new Date(0).toISOString();
  }
  return new Date(0).toISOString();
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function collectThreadIds({
  messages,
  threadRows,
  configRows,
  stateRows,
}: {
  messages: ChatExportMessageRow[];
  threadRows: ChatThreadRecord[];
  configRows: Map<string, ChatThreadConfigRecord>;
  stateRows: Map<string, ChatThreadStateRecord>;
}): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const threadId = normalizeString(message.thread_id);
    if (threadId) ids.add(threadId);
  }
  for (const row of threadRows) {
    const threadId = normalizeString(row.thread_id);
    if (threadId) ids.add(threadId);
  }
  for (const threadId of configRows.keys()) ids.add(threadId);
  for (const threadId of stateRows.keys()) ids.add(threadId);
  return ids;
}

function selectLatestByThreadId<T extends { thread_id: string }>(
  rows: T[],
  getUpdatedAt: (row: T) => number,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const threadId = normalizeString(row.thread_id);
    if (!threadId) continue;
    const existing = out.get(threadId);
    if (!existing || getUpdatedAt(row) >= getUpdatedAt(existing)) {
      out.set(threadId, row);
    }
  }
  return out;
}

function threadConfigUpdatedAt(row: ChatThreadConfigRecord): number {
  return dateNumber(row.updated_at ?? row.date);
}

function threadStateUpdatedAt(row: ChatThreadStateRecord): number {
  return dateNumber(row.updated_at ?? row.date);
}

function dateNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).valueOf();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value instanceof Date) {
    return value.valueOf();
  }
  return 0;
}

function selectThreadIds({
  scope,
  requestedThreadId,
  threadIds,
  configRows,
}: {
  scope: ChatExportScope;
  requestedThreadId?: string;
  threadIds: Set<string>;
  configRows: Map<string, ChatThreadConfigRow>;
}): string[] {
  if (scope === "current-thread") {
    if (!requestedThreadId) {
      throw new Error("--thread-id is required when scope is current-thread");
    }
    return [requestedThreadId];
  }
  const all = Array.from(threadIds);
  if (scope === "all-threads") {
    return all;
  }
  return all.filter((threadId) => configRows.get(threadId)?.archived !== true);
}

async function hydrateArchivedMessages({
  threads,
  chatPath,
  offloadDbPath,
}: {
  threads: Map<string, ThreadAggregate>;
  chatPath: string;
  offloadDbPath?: string;
}): Promise<void> {
  for (const aggregate of threads.values()) {
    let offset = 0;
    for (;;) {
      const result = readChatStoreArchived({
        chat_path: chatPath,
        db_path: offloadDbPath,
        thread_id: aggregate.threadId,
        limit: DEFAULT_ARCHIVED_PAGE_SIZE,
        offset,
      });
      if (!result.rows.length) break;
      for (const row of result.rows) {
        if (!row.row || typeof row.row !== "object") continue;
        const event = (row.row as Record<string, unknown>).event;
        if (event !== "chat") continue;
        aggregate.archivedMessages.push(normalizeMessageRow(row.row as ChatMessage));
      }
      if (result.next_offset == null) break;
      offset = result.next_offset;
    }
  }
}

function dedupeMessages(messages: ChatExportMessageRow[]): ChatExportMessageRow[] {
  const byKey = new Map<string, ChatExportMessageRow>();
  for (const message of messages) {
    byKey.set(messageKey(message), message);
  }
  return Array.from(byKey.values());
}

function messageKey(message: ChatExportMessageRow): string {
  return (
    normalizeString(message.message_id) ??
    `${normalizeString(message.thread_id) ?? "no-thread"}:${message.date}:${message.sender_id}`
  );
}

function orderLinearThreadMessages(
  messages: ChatExportMessageRow[],
): ChatExportMessageRow[] {
  if (messages.length <= 1) return messages.slice();
  const sorted = messages.slice().sort(compareMessages);
  const byId = new Map<string, ChatExportMessageRow>();
  for (const message of sorted) {
    const id = normalizeString(message.message_id);
    if (id) byId.set(id, message);
  }
  const children = new Map<string, ChatExportMessageRow[]>();
  const anchors: ChatExportMessageRow[] = [];
  for (const message of sorted) {
    const parentId = normalizeString(message.parent_message_id);
    const messageId = normalizeString(message.message_id);
    if (parentId && messageId && parentId !== messageId && byId.has(parentId)) {
      const bucket = children.get(parentId) ?? [];
      bucket.push(message);
      children.set(parentId, bucket);
    } else {
      anchors.push(message);
    }
  }
  for (const bucket of children.values()) {
    bucket.sort(compareMessages);
  }
  anchors.sort(compareMessages);
  const visited = new Set<string>();
  const ordered: ChatExportMessageRow[] = [];
  const visit = (message: ChatExportMessageRow) => {
    const key = messageKey(message);
    if (visited.has(key)) return;
    visited.add(key);
    ordered.push(message);
    const id = normalizeString(message.message_id);
    if (!id) return;
    for (const child of children.get(id) ?? []) {
      visit(child);
    }
  };
  for (const message of anchors) visit(message);
  for (const message of sorted) visit(message);
  return ordered;
}

function compareMessages(a: ChatExportMessageRow, b: ChatExportMessageRow): number {
  const aMs = dateNumber(a.date);
  const bMs = dateNumber(b.date);
  if (aMs !== bMs) return aMs - bMs;
  const aId = normalizeString(a.message_id);
  const bId = normalizeString(b.message_id);
  if (aId && bId) return aId.localeCompare(bId);
  return a.sender_id.localeCompare(b.sender_id);
}

function deriveThreadTitle(aggregate: ThreadAggregate): string {
  const configured = normalizeString(aggregate.config?.name);
  if (configured) return configured;
  const root = aggregate.dedupedMessages.find(
    (message) => normalizeString(message.message_id) === aggregate.rootMessageId,
  );
  const content = newestContent(root ?? aggregate.dedupedMessages[0]);
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized) {
    const words = normalized.split(" ");
    const short = words.slice(0, 8).join(" ");
    return words.length > 8 ? `${short}…` : short;
  }
  const last = aggregate.lastMessageAt ? new Date(aggregate.lastMessageAt) : undefined;
  return last && Number.isFinite(last.valueOf())
    ? last.toLocaleString()
    : "Untitled Chat";
}

function newestContent(message: ChatExportMessageRow | undefined): string {
  const first = Array.isArray(message?.history) ? message?.history[0] : undefined;
  return `${first?.content ?? ""}`;
}

function sortThreads(threads: ThreadAggregate[]): ThreadAggregate[] {
  return threads.slice().sort((a, b) => {
    const aMs = dateNumber(a.lastMessageAt ?? a.config?.updated_at ?? a.thread?.created_at);
    const bMs = dateNumber(b.lastMessageAt ?? b.config?.updated_at ?? b.thread?.created_at);
    if (aMs !== bMs) return bMs - aMs;
    return a.title.localeCompare(b.title);
  });
}

function renderThreadTranscript(aggregate: ThreadAggregate): string {
  const blobReplacements = new Map<string, string>();
  for (const asset of aggregate.assetRefs) {
    blobReplacements.set(asset.originalRef, `../../${asset.path}`);
  }
  const lines: string[] = [];
  lines.push(`# ${escapeHeading(aggregate.title)}`);
  lines.push("");
  lines.push(`- Thread ID: \`${aggregate.threadId}\``);
  if (aggregate.rootMessageId) {
    lines.push(`- Root Message ID: \`${aggregate.rootMessageId}\``);
  }
  lines.push(`- Archived in UI: ${aggregate.archived ? "yes" : "no"}`);
  lines.push(`- Pinned: ${aggregate.pinned ? "yes" : "no"}`);
  lines.push(`- Messages: ${aggregate.dedupedMessages.length}`);
  if (aggregate.firstMessageAt) {
    lines.push(`- First Message: ${aggregate.firstMessageAt}`);
  }
  if (aggregate.lastMessageAt) {
    lines.push(`- Last Message: ${aggregate.lastMessageAt}`);
  }
  if (aggregate.config?.agent_kind) {
    lines.push(`- Agent Kind: ${aggregate.config.agent_kind}`);
  }
  if (aggregate.config?.agent_model) {
    lines.push(`- Agent Model: ${aggregate.config.agent_model}`);
  }
  if (aggregate.config?.agent_mode) {
    lines.push(`- Agent Mode: ${aggregate.config.agent_mode}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  aggregate.dedupedMessages.forEach((message, index) => {
    const authorId = normalizeString(message.history?.[0]?.author_id) ?? message.sender_id;
    lines.push(`## ${index + 1}. ${escapeHeading(authorId)} (${message.date})`);
    lines.push("");
    lines.push(`- Message ID: \`${normalizeString(message.message_id) ?? ""}\``);
    lines.push(`- Sender ID: \`${message.sender_id}\``);
    if (message.parent_message_id) {
      lines.push(`- Parent Message ID: \`${message.parent_message_id}\``);
    }
    lines.push("");
    lines.push(
      rewriteBlobRefs(newestContent(message), blobReplacements) || "(empty)",
    );
    lines.push("");
    lines.push("---");
    lines.push("");
  });
  return `${lines.join("\n")}\n`;
}

function escapeHeading(value: string): string {
  return value.replace(/^#+\s*/g, "").trim() || "Untitled";
}
