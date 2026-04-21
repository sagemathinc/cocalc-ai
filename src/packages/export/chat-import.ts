import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path, { dirname, resolve } from "node:path";

import {
  buildChatMessageRecordV2,
  buildThreadConfigRecord,
  buildThreadRecord,
  buildThreadStateRecord,
  CHAT_SCHEMA_V2,
  type ChatMessageRecordV2,
  type ChatThreadConfigRecord,
  type InlineCodeLink,
} from "@cocalc/chat";

import {
  normalizeIsoDate,
  normalizeString,
  parseJsonlRows,
  stringifyJsonlRows,
} from "./jsonl";
import { loadExportBundleSource } from "./read-bundle";

export interface ChatImportOptions {
  sourcePath: string;
  targetPath?: string;
  projectId?: string;
  accountId?: string;
  apiBaseUrl?: string;
  blobBearerToken?: string;
  uploadBlob?: (input: {
    filename: string;
    content: Uint8Array;
    contentType?: string;
    projectId?: string;
  }) => Promise<{ uuid: string; url: string }>;
  forkCodexSession?: (input: {
    seedSessionId: string;
    projectId: string;
    accountId?: string;
  }) => Promise<{ sessionId: string }>;
}

export interface ChatImportWarning {
  code:
    | "asset_missing"
    | "asset_rebinding_skipped"
    | "codex_context_skipped"
    | "codex_context_missing";
  thread_id?: string;
  message: string;
}

export interface ChatImportResult {
  target_path: string;
  created_thread_count: number;
  created_message_count: number;
  asset_count: number;
  codex_context_count: number;
  warning_count: number;
  warnings: ChatImportWarning[];
  thread_ids: string[];
}

interface ImportedAssetRef {
  originalRef: string;
  path: string;
  sha256: string;
  contentType?: string;
}

interface ImportedCodexContext {
  session_id: string;
  meta_path: string;
  session_path: string;
  sha256?: string;
}

interface ImportedThreadData {
  thread_id: string;
  title?: string;
  archived?: boolean;
  pinned?: boolean;
  thread_color?: string;
  thread_accent_color?: string;
  thread_icon?: string;
  thread_image?: string;
  agent_kind?: "acp" | "llm" | "none" | string;
  agent_model?: string;
  agent_mode?: "interactive" | "single_turn" | string;
  acp_config?: Record<string, unknown>;
  runtime_state?: string;
  active_message_id?: string;
  root_message_id?: string;
  created_at?: string;
  created_by?: string;
  first_message_at?: string;
  last_message_at?: string;
  message_count?: number;
  transcript_path?: string;
  messages_path?: string;
  asset_refs?: ImportedAssetRef[];
  codex_context?: ImportedCodexContext;
}

interface ImportedMessageRow {
  event?: string;
  message_kind?: string;
  message_id?: string;
  thread_id?: string;
  parent_message_id?: string;
  timestamp?: string;
  edited_at?: string;
  sender_id?: string;
  content?: string;
  feedback?: Record<string, unknown>;
  acp_usage?: unknown;
  acp_account_id?: string;
  inline_code_links?: unknown[];
}

interface ImportedThreadIndexEntry {
  thread_id?: string;
  thread_path?: string;
  messages_path?: string;
}

export async function importChatBundle(
  options: ChatImportOptions,
): Promise<ChatImportResult> {
  const source = await loadExportBundleSource(resolve(options.sourcePath));
  if (source.manifest.kind !== "chat") {
    throw new Error(
      `expected a chat export bundle, got kind=${JSON.stringify(source.manifest.kind)}`,
    );
  }
  const rawTargetPath =
    normalizeString(options.targetPath) ??
    normalizeString(source.manifest?.source?.path);
  if (!rawTargetPath) {
    throw new Error(
      "unable to determine import target; pass --target explicitly",
    );
  }
  const targetPath = resolve(rawTargetPath);
  const index = JSON.parse(await source.readText("threads/index.json")) as
    | ImportedThreadIndexEntry[]
    | undefined;
  const threadEntries = Array.isArray(index) ? index : [];
  if (!threadEntries.length) {
    throw new Error("chat export bundle does not contain any threads");
  }

  const warnings: ChatImportWarning[] = [];
  const importedRows: any[] = [];
  const importedThreadIds: string[] = [];
  const uploadCache = new Map<string, string>();
  let assetCount = 0;
  let codexContextCount = 0;

  for (const entry of threadEntries) {
    const sourceThreadId = normalizeString(entry.thread_id);
    if (!sourceThreadId) {
      throw new Error("threads/index.json contains an entry without thread_id");
    }
    const threadPath =
      normalizeString(entry.thread_path) ??
      `threads/${sourceThreadId}/thread.json`;
    const messagesPath =
      normalizeString(entry.messages_path) ??
      `threads/${sourceThreadId}/messages.jsonl`;
    const threadData = JSON.parse(
      await source.readText(threadPath),
    ) as ImportedThreadData;
    const exportedMessages = parseJsonlRows(
      await source.readText(messagesPath),
      messagesPath,
    ).filter(isImportedMessageRow);

    const newThreadId = randomUUID();
    importedThreadIds.push(newThreadId);

    const messageIdMap = new Map<string, string>();
    for (const row of exportedMessages) {
      const oldMessageId = normalizeString(row.message_id) ?? randomUUID();
      if (!messageIdMap.has(oldMessageId)) {
        messageIdMap.set(oldMessageId, randomUUID());
      }
    }

    const assetReplacements = await importThreadAssets({
      source,
      threadData,
      uploadCache,
      options,
      warnings,
      threadId: sourceThreadId,
    });
    assetCount = uploadCache.size;

    const forkedSessionId = await importThreadCodexContext({
      source,
      threadData,
      options,
      warnings,
      threadId: sourceThreadId,
    });
    if (forkedSessionId) {
      codexContextCount += 1;
    }

    const rootOriginalId =
      normalizeString(threadData.root_message_id) ??
      normalizeString(exportedMessages[0]?.message_id) ??
      randomUUID();
    const rootMessageId = messageIdMap.get(rootOriginalId) ?? randomUUID();
    const now = new Date().toISOString();
    const lastMessageAt =
      normalizeIsoDate(
        exportedMessages[exportedMessages.length - 1]?.timestamp ??
          threadData.last_message_at,
      ) ?? now;
    const latestChatDateMs = new Date(lastMessageAt).valueOf();

    importedRows.push(
      buildThreadRecord({
        thread_id: newThreadId,
        root_message_id: rootMessageId,
        created_by: normalizeString(threadData.created_by) ?? "__import__",
        created_at: normalizeIsoDate(threadData.created_at) ?? now,
        schema_version: CHAT_SCHEMA_V2,
      }),
    );

    const importedConfig = buildImportedCodexConfig(
      threadData.acp_config,
      forkedSessionId,
    );
    importedRows.push(
      buildThreadConfigRecord({
        thread_id: newThreadId,
        updated_by: "__import__",
        updated_at: now,
        name: normalizeString(threadData.title) ?? "Imported chat",
        thread_color: normalizeString(threadData.thread_color),
        thread_accent_color: normalizeString(threadData.thread_accent_color),
        thread_icon: normalizeString(threadData.thread_icon),
        thread_image: rewriteImportedAssetRefs(
          normalizeString(threadData.thread_image),
          assetReplacements,
        ),
        pin: threadData.pinned === true,
        archived: threadData.archived === true,
        latest_chat_date_ms: Number.isFinite(latestChatDateMs)
          ? latestChatDateMs
          : undefined,
        agent_kind:
          importedConfig != null
            ? "acp"
            : (normalizeImportedAgentKind(threadData.agent_kind) ?? undefined),
        agent_model: normalizeString(threadData.agent_model),
        agent_mode: normalizeImportedAgentMode(threadData.agent_mode),
        acp_config: importedConfig,
      }),
    );

    importedRows.push(
      buildThreadStateRecord({
        thread_id: newThreadId,
        state: "idle",
        updated_at: now,
      }),
    );

    for (const row of exportedMessages) {
      const oldMessageId = normalizeString(row.message_id) ?? randomUUID();
      const messageId = messageIdMap.get(oldMessageId) ?? randomUUID();
      const parentMessageId =
        messageIdMap.get(normalizeString(row.parent_message_id) ?? "") ??
        undefined;
      const timestamp = normalizeIsoDate(row.timestamp) ?? now;
      const message = buildChatMessageRecordV2({
        sender_id: normalizeString(row.sender_id) ?? "unknown",
        date: timestamp,
        prevHistory: [],
        content:
          rewriteImportedAssetRefs(`${row.content ?? ""}`, assetReplacements) ??
          "",
        generating: false,
        message_id: messageId,
        thread_id: newThreadId,
        parent_message_id: parentMessageId,
        historyAuthorId: normalizeString(row.sender_id) ?? "unknown",
        historyEntryDate: normalizeIsoDate(row.edited_at) ?? timestamp,
        acp_usage: row.acp_usage,
        acp_account_id: normalizeString(row.acp_account_id) ?? undefined,
        inline_code_links: Array.isArray(row.inline_code_links)
          ? (row.inline_code_links as InlineCodeLink[])
          : undefined,
      });
      copyImportedMessageFields(message, row);
      importedRows.push(message);
    }
  }

  const result: ChatImportResult = {
    target_path: targetPath,
    created_thread_count: importedThreadIds.length,
    created_message_count: importedRows.filter((row) => row?.event === "chat")
      .length,
    asset_count: assetCount,
    codex_context_count: codexContextCount,
    warning_count: warnings.length,
    warnings,
    thread_ids: importedThreadIds,
  };

  const existingText = await readMaybeMissing(targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    joinJsonl(existingText, stringifyJsonlRows(importedRows)),
    "utf8",
  );

  return result;
}

function isImportedMessageRow(row: any): row is ImportedMessageRow {
  return row?.event === "chat-message" && row?.message_kind === "message";
}

function copyImportedMessageFields(
  message: ChatMessageRecordV2,
  row: ImportedMessageRow,
): void {
  if (row.feedback && typeof row.feedback === "object") {
    message.feedback = row.feedback;
  }
}

function normalizeImportedAgentKind(
  value: unknown,
): ChatThreadConfigRecord["agent_kind"] | undefined {
  return value === "acp" || value === "llm" || value === "none"
    ? value
    : undefined;
}

function normalizeImportedAgentMode(
  value: unknown,
): ChatThreadConfigRecord["agent_mode"] | undefined {
  return value === "interactive" || value === "single_turn" ? value : undefined;
}

function buildImportedCodexConfig(
  raw: unknown,
  sessionId: string | undefined,
): Record<string, unknown> | undefined {
  const next =
    raw && typeof raw === "object"
      ? { ...(raw as Record<string, unknown>) }
      : ({} as Record<string, unknown>);
  if (sessionId) {
    next.sessionId = sessionId;
  } else {
    delete next.sessionId;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

async function importThreadAssets({
  source,
  threadData,
  uploadCache,
  options,
  warnings,
  threadId,
}: {
  source: Awaited<ReturnType<typeof loadExportBundleSource>>;
  threadData: ImportedThreadData;
  uploadCache: Map<string, string>;
  options: ChatImportOptions;
  warnings: ChatImportWarning[];
  threadId: string;
}): Promise<Map<string, string>> {
  const replacements = new Map<string, string>();
  for (const asset of threadData.asset_refs ?? []) {
    let url = uploadCache.get(asset.path);
    if (!url) {
      let bytes: Uint8Array;
      try {
        bytes = await source.readBytes(asset.path);
      } catch (err) {
        warnings.push({
          code: "asset_missing",
          thread_id: threadId,
          message: `Missing asset ${asset.path}: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const uploaded = await uploadImportedBlob({
        filename: path.basename(asset.path) || "asset.bin",
        content: bytes,
        contentType: asset.contentType,
        projectId: options.projectId,
        apiBaseUrl: options.apiBaseUrl,
        blobBearerToken: options.blobBearerToken,
        uploadBlob: options.uploadBlob,
      });
      url = uploaded.url;
      uploadCache.set(asset.path, url);
    }
    replacements.set(`../../${asset.path}`, url);
    replacements.set(asset.path, url);
  }
  return replacements;
}

async function uploadImportedBlob({
  filename,
  content,
  contentType,
  projectId,
  apiBaseUrl,
  blobBearerToken,
  uploadBlob,
}: {
  filename: string;
  content: Uint8Array;
  contentType?: string;
  projectId?: string;
  apiBaseUrl?: string;
  blobBearerToken?: string;
  uploadBlob?: ChatImportOptions["uploadBlob"];
}): Promise<{ uuid: string; url: string }> {
  if (uploadBlob) {
    return await uploadBlob({
      filename,
      content,
      contentType,
      projectId,
    });
  }
  const baseUrl = normalizeString(apiBaseUrl);
  if (!baseUrl) {
    throw new Error(
      "asset import requires apiBaseUrl/COCALC_API_URL or a custom uploadBlob callback",
    );
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([Buffer.from(content)], {
      type: contentType || "application/octet-stream",
    }),
    filename,
  );
  const endpoint = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/blobs`;
  if (normalizeString(projectId)) {
    endpoint.searchParams.set("project_id", normalizeString(projectId)!);
  }
  const headers: Record<string, string> = {};
  if (normalizeString(blobBearerToken)) {
    headers.Authorization = `Bearer ${normalizeString(blobBearerToken)!}`;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
    headers,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  const json = (await response.json()) as { uuid?: string };
  const uuid = normalizeString(json?.uuid);
  if (!uuid) {
    throw new Error("blob upload did not return a uuid");
  }
  return {
    uuid,
    url: toUploadedBlobUrl(baseUrl, filename, uuid),
  };
}

async function importThreadCodexContext({
  source,
  threadData,
  options,
  warnings,
  threadId,
}: {
  source: Awaited<ReturnType<typeof loadExportBundleSource>>;
  threadData: ImportedThreadData;
  options: ChatImportOptions;
  warnings: ChatImportWarning[];
  threadId: string;
}): Promise<string | undefined> {
  const codexContext = threadData.codex_context;
  if (!codexContext) return undefined;
  const projectId = normalizeString(options.projectId);
  if (!projectId) {
    warnings.push({
      code: "codex_context_skipped",
      thread_id: threadId,
      message:
        "Codex context was included, but import did not have a project id for session forking.",
    });
    return undefined;
  }
  if (!options.forkCodexSession) {
    warnings.push({
      code: "codex_context_skipped",
      thread_id: threadId,
      message:
        "Codex context was included, but import did not have a session fork callback.",
    });
    return undefined;
  }
  const sessionId = normalizeString(codexContext.session_id);
  if (!sessionId) {
    warnings.push({
      code: "codex_context_missing",
      thread_id: threadId,
      message: "Codex context metadata is missing a session id.",
    });
    return undefined;
  }
  const sessionBytes = await source.readBytes(codexContext.session_path);
  const seedSessionId = await installImportedCodexSeed({
    sessionId,
    expectedSha256: normalizeString(codexContext.sha256),
    content: sessionBytes,
  });
  const { sessionId: forkedSessionId } = await options.forkCodexSession({
    seedSessionId,
    projectId,
    accountId: normalizeString(options.accountId),
  });
  return forkedSessionId;
}

async function installImportedCodexSeed({
  sessionId,
  expectedSha256,
  content,
}: {
  sessionId: string;
  expectedSha256?: string;
  content: Uint8Array;
}): Promise<string> {
  const sessionsRoot = getSessionsRootForImport();
  if (!sessionsRoot) {
    throw new Error("local Codex session store is unavailable");
  }
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (expectedSha256 && expectedSha256 !== actualSha256) {
    throw new Error(
      `Codex context checksum mismatch for ${sessionId}: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
  const existing = await findSessionFileForImport(sessionId, sessionsRoot);
  if (existing) {
    const existingBytes = new Uint8Array(await readFile(existing));
    const existingSha256 = createHash("sha256")
      .update(existingBytes)
      .digest("hex");
    if (existingSha256 !== actualSha256) {
      throw new Error(
        `local Codex session ${sessionId} already exists with different content`,
      );
    }
    return sessionId;
  }
  const now = new Date();
  const dir = path.join(
    sessionsRoot,
    "imported",
    `${now.getUTCFullYear()}`,
    `${`${now.getUTCMonth() + 1}`.padStart(2, "0")}`,
    `${`${now.getUTCDate()}`.padStart(2, "0")}`,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `imported-${sessionId}.jsonl`), content);
  return sessionId;
}

function getSessionsRootForImport(): string | undefined {
  if (process.env.COCALC_CODEX_HOME) {
    return path.join(process.env.COCALC_CODEX_HOME, "sessions");
  }
  if (process.env.COCALC_ORIGINAL_HOME) {
    return path.join(process.env.COCALC_ORIGINAL_HOME, ".codex", "sessions");
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, ".codex", "sessions");
  }
  return undefined;
}

async function findSessionFileForImport(
  sessionId: string,
  sessionsRoot: string,
): Promise<string | undefined> {
  const suffix = `-${sessionId}.jsonl`;
  return await walkForSessionImportFile(sessionsRoot, suffix);
}

async function walkForSessionImportFile(
  dir: string,
  suffix: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return undefined;
    }
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await walkForSessionImportFile(full, suffix);
      if (found) return found;
      continue;
    }
    if (entry.isFile() && full.endsWith(suffix)) {
      return full;
    }
  }
  return undefined;
}

function rewriteImportedAssetRefs(
  value: string | undefined,
  replacements: Map<string, string>,
): string | undefined {
  if (value == null) return value;
  let next = `${value}`;
  for (const [from, to] of replacements.entries()) {
    next = next.split(from).join(to);
  }
  return next;
}

async function readMaybeMissing(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

function joinJsonl(existing: string, next: string): string {
  if (!existing) return next;
  if (!next) return existing;
  return existing.endsWith("\n")
    ? `${existing}${next}`
    : `${existing}\n${next}`;
}

function toUploadedBlobUrl(
  apiBaseUrl: string,
  filename: string,
  uuid: string,
): string {
  const base = new URL(apiBaseUrl);
  const prefix = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
  return `${prefix}/blobs/${encodeURIComponent(filename)}?uuid=${encodeURIComponent(uuid)}`;
}
