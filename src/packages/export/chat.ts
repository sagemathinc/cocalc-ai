import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { findSessionFile, readPortableSessionHistory } from "@cocalc/ai/acp";
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
  includeCodexContext?: boolean;
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

export type ChatExportSenderType = "user" | "agent" | "system" | "unknown";

export interface ChatExportParticipant {
  sender_id: string;
  sender_type: ChatExportSenderType;
  sender_label: string;
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
  codex_context_path?: string;
}

export interface ChatExportCodexContext {
  session_id: string;
  meta_path: string;
  session_path: string;
  sha256: string;
  exported_session_path?: string;
  trimmed?: boolean;
  original_bytes?: number;
  exported_bytes?: number;
  total_compactions?: number;
}

export interface ChatExportMessageRow {
  event: "chat-message";
  message_kind: "message";
  message_id: string;
  thread_id: string;
  parent_message_id?: string;
  timestamp: string;
  edited_at?: string;
  sender_id: string;
  sender_type: ChatExportSenderType;
  sender_label: string;
  content: string;
  content_format: "markdown";
  generating?: boolean;
  feedback?: Record<string, unknown>;
  acp_thread_id?: string | null;
  acp_usage?: unknown;
  acp_account_id?: string;
  inline_code_links?: InlineCodeLink[];
}

export interface ChatExportThreadData {
  thread_id: string;
  title: string;
  archived: boolean;
  pinned: boolean;
  thread_color?: string;
  thread_accent_color?: string;
  thread_icon?: string;
  thread_image?: string;
  agent_kind?: string;
  agent_model?: string;
  agent_mode?: string;
  acp_config?: unknown;
  runtime_state?: string;
  active_message_id?: string;
  root_message_id?: string;
  created_at?: string;
  created_by?: string;
  first_message_at?: string;
  last_message_at?: string;
  participants?: ChatExportParticipant[];
  message_count: number;
  live_message_count: number;
  offloaded_message_count: number;
  transcript_path: string;
  messages_path: string;
  asset_refs?: ChatExportAssetIndexEntry[];
  codex_context?: ChatExportCodexContext;
  warnings?: ChatExportWarning[];
}

export interface ChatExportWarning {
  code:
    | "blob_fetch_failed"
    | "codex_context_missing"
    | "codex_context_read_failed";
  thread_id: string;
  message: string;
  original_ref?: string;
  fetch_url?: string;
  session_id?: string;
}

type ChatRow = any;
type ChatThreadConfigRow = ChatThreadConfigRecord & { archived?: boolean };
type SourceChatMessageRow = {
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
};

type ThreadAggregate = {
  threadId: string;
  config?: ChatThreadConfigRow;
  state?: ChatThreadStateRecord;
  thread?: ChatThreadRecord;
  liveMessages: SourceChatMessageRow[];
  archivedMessages: SourceChatMessageRow[];
  dedupedMessages: SourceChatMessageRow[];
  title: string;
  archived: boolean;
  pinned: boolean;
  rootMessageId?: string;
  firstMessageAt?: string;
  lastMessageAt?: string;
  assetRefs: ChatExportAssetIndexEntry[];
  codexContext?: ChatExportCodexContext;
  warnings: ChatExportWarning[];
};

type BlobReference = {
  originalRef: string;
  fetchUrl: string;
  filename: string;
};

const BLOB_MARKDOWN = /!\[[^\]]*\]\(((?:https?:\/\/[^)]+)?\/blobs\/[^)]+)\)/gi;
const BLOB_HTML =
  /<img[^>]+src=["']((?:https?:\/\/[^"']+)?\/blobs\/[^"']+)["'][^>]*>/gi;
const DEFAULT_ARCHIVED_PAGE_SIZE = 500;

export async function collectChatExport(
  options: ChatExportOptions,
): Promise<ExportBundle> {
  const liveRows = await readChatRows(options.chatPath);
  const liveMessages = liveRows
    .filter(isChatMessageRow)
    .map(normalizeMessageRow);
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
      thread: threadRows.find(
        (row) => normalizeString(row.thread_id) === threadId,
      ),
      liveMessages: liveMessages.filter(
        (row) => normalizeString(row.thread_id) === threadId,
      ),
      archivedMessages: [],
      dedupedMessages: [],
      title: "",
      archived: false,
      pinned: false,
      assetRefs: [],
      warnings: [],
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
    aggregate.dedupedMessages = orderLinearThreadMessages(
      aggregate.dedupedMessages,
    );
    aggregate.rootMessageId =
      aggregate.thread?.root_message_id ||
      aggregate.dedupedMessages.find(
        (row) => !normalizeString(row.parent_message_id),
      )?.message_id ||
      aggregate.dedupedMessages[0]?.message_id;
    aggregate.title = deriveThreadTitle(aggregate);
    aggregate.archived = aggregate.config?.archived === true;
    aggregate.pinned = aggregate.config?.pin === true;
    aggregate.firstMessageAt = aggregate.dedupedMessages[0]?.date;
    aggregate.lastMessageAt = aggregate.dedupedMessages.length
      ? aggregate.dedupedMessages[aggregate.dedupedMessages.length - 1]?.date
      : undefined;
  }

  const assetResult = options.includeBlobs
    ? await collectChatAssets({
        threads,
        blobBaseUrl: normalizeString(options.blobBaseUrl),
        blobBearerToken: normalizeString(options.blobBearerToken),
      })
    : { assetIndex: [], warnings: [] };
  const { assetIndex, warnings } = assetResult;
  const codexContextResult = options.includeCodexContext
    ? await collectChatCodexContexts({ threads })
    : { files: [], count: 0, warnings: [] };
  const allWarnings = [...warnings, ...codexContextResult.warnings];

  const sortedAggregates = sortThreads(Array.from(threads.values()));
  const senderDirectory = buildSenderDirectory(sortedAggregates);

  const files: ExportFile[] = [
    {
      path: "README.md",
      content: renderChatExportReadme({
        includeBlobs: options.includeBlobs === true,
        includeCodexContext: options.includeCodexContext === true,
      }),
      contentType: "text/markdown; charset=utf-8",
    },
  ];
  const threadIndex: ChatExportIndexEntry[] = [];
  for (const aggregate of sortedAggregates) {
    const threadDir = `threads/${aggregate.threadId}`;
    const transcriptPath = `${threadDir}/transcript.md`;
    const threadPath = `${threadDir}/thread.json`;
    const messagesPath = `${threadDir}/messages.jsonl`;
    const blobReplacements = buildBlobReplacementMap(aggregate);
    const transcript = renderThreadTranscript(
      aggregate,
      senderDirectory,
      blobReplacements,
    );
    const exportedMessages = aggregate.dedupedMessages.map((message) =>
      toExportMessageRow(message, senderDirectory, blobReplacements),
    );
    const threadData: ChatExportThreadData = {
      thread_id: aggregate.threadId,
      title: aggregate.title,
      archived: aggregate.archived,
      pinned: aggregate.pinned,
      thread_color: normalizeString(aggregate.config?.thread_color),
      thread_accent_color: normalizeString(
        aggregate.config?.thread_accent_color,
      ),
      thread_icon: normalizeString(aggregate.config?.thread_icon),
      thread_image: rewriteMaybeBlobRef(
        normalizeString(aggregate.config?.thread_image),
        blobReplacements,
      ),
      agent_kind: normalizeString(aggregate.config?.agent_kind),
      agent_model: normalizeString(aggregate.config?.agent_model),
      agent_mode: normalizeString(aggregate.config?.agent_mode),
      acp_config: aggregate.config?.acp_config,
      runtime_state: normalizeString(aggregate.state?.state),
      active_message_id: normalizeString(aggregate.state?.active_message_id),
      root_message_id: aggregate.rootMessageId,
      created_at: normalizeString(aggregate.thread?.created_at),
      created_by: normalizeString(aggregate.thread?.created_by),
      first_message_at: aggregate.firstMessageAt,
      last_message_at: aggregate.lastMessageAt,
      participants: collectThreadParticipants(aggregate, senderDirectory),
      message_count: aggregate.dedupedMessages.length,
      live_message_count: aggregate.liveMessages.length,
      offloaded_message_count: aggregate.archivedMessages.length,
      transcript_path: transcriptPath,
      messages_path: messagesPath,
      asset_refs: aggregate.assetRefs.length ? aggregate.assetRefs : undefined,
      codex_context: aggregate.codexContext,
      warnings: aggregate.warnings.length ? aggregate.warnings : undefined,
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
      codex_context_path: aggregate.codexContext?.session_path,
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
        content: `${exportedMessages
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
        contentType: "application/x-ndjson; charset=utf-8",
      },
    );
  }

  files.push(...codexContextResult.files);

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
  if (allWarnings.length) {
    files.push({
      path: "warnings.json",
      content: `${JSON.stringify(allWarnings, null, 2)}\n`,
      contentType: "application/json; charset=utf-8",
    });
  }

  return {
    rootDir: defaultChatExportRootDir(options.chatPath),
    manifest: normalizeExportManifest({
      format: "cocalc-export",
      version: 1,
      kind: "chat",
      exported_at: options.exportedAt ?? new Date().toISOString(),
      entrypoints: {
        human_overview: "README.md",
        machine_index: "threads/index.json",
        canonical_data: ["threads/<thread_id>/messages.jsonl"],
        derived_views: ["threads/<thread_id>/transcript.md"],
        assets_index: assetIndex.length ? "assets/index.json" : undefined,
        warnings: allWarnings.length ? "warnings.json" : undefined,
        codex_context_data:
          codexContextResult.count > 0
            ? ["threads/<thread_id>/codex/session.jsonl"]
            : undefined,
      },
      agent_hints: {
        local_first: true,
        reconstruction_source: "threads/<thread_id>/messages.jsonl",
        derived_files_are_optional: true,
        excludes_activity_logs: options.includeCodexContext !== true,
        includes_codex_context: options.includeCodexContext === true,
      },
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
        include_codex_context: options.includeCodexContext === true,
      },
      thread_count: threadIndex.length,
      message_count: threadIndex.reduce(
        (sum, entry) => sum + entry.message_count,
        0,
      ),
      codex_context_count: codexContextResult.count,
      asset_count: assetIndex.length,
      warning_count: allWarnings.length,
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

function renderChatExportReadme({
  includeBlobs,
  includeCodexContext,
}: {
  includeBlobs: boolean;
  includeCodexContext: boolean;
}): string {
  const warningLines = [
    includeBlobs
      ? "- If `warnings.json` exists, some blob fetches failed and those references were left unchanged."
      : undefined,
    includeCodexContext
      ? "- If Codex context was included, raw resumable session state lives under `threads/<thread_id>/codex/`."
      : "- Codex context was not included, so importing this archive elsewhere will not restore resumable Codex state.",
  ]
    .filter((line): line is string => !!line)
    .join("\n");
  return `# Chat Export

This archive is designed for both people and agents.

Start here:

- Read \`manifest.json\` for top-level metadata and entrypoints.
- Use \`threads/index.json\` to discover exported threads.
- Treat \`threads/<thread_id>/messages.jsonl\` as the canonical machine-readable message stream for each thread.
- Treat \`threads/<thread_id>/transcript.md\` as a derived, human-readable rendering.

Important properties:

- Selected threads include archived/offloaded chat messages.
- The canonical chat export excludes CoCalc activity/thinking logs.
- Blob references are ${includeBlobs ? "copied into `assets/` and rewritten to local paths." : "left as external references because blobs were not included."}
${warningLines}

Recommended agent workflow:

1. Inspect \`manifest.json\` and \`threads/index.json\`.
2. Work from \`messages.jsonl\` for analysis, transformation, or reconstruction.
3. Use \`transcript.md\` when a quick human-readable view is helpful.
4. If you need to rebuild a chat later, prefer the canonical JSONL over the derived transcript.
`;
}

function defaultChatExportRootDir(chatPath: string): string {
  const stem = path.parse(chatPath).name.trim();
  const sanitized = stem
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "chat";
}

function buildBlobReplacementMap(
  aggregate: ThreadAggregate,
): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const asset of aggregate.assetRefs) {
    replacements.set(asset.originalRef, `../../${asset.path}`);
  }
  return replacements;
}

function buildSenderDirectory(
  threads: ThreadAggregate[],
): Map<string, ChatExportParticipant> {
  const directory = new Map<string, ChatExportParticipant>();
  let nextUserNumber = 1;
  for (const aggregate of threads) {
    for (const message of aggregate.dedupedMessages) {
      const senderId = normalizeString(message.sender_id) ?? "unknown";
      if (directory.has(senderId)) continue;
      const senderType = classifySenderType(senderId);
      const senderLabel =
        senderType === "user"
          ? `user-${nextUserNumber++}`
          : senderId || "unknown";
      directory.set(senderId, {
        sender_id: senderId,
        sender_type: senderType,
        sender_label: senderLabel,
      });
    }
  }
  return directory;
}

function classifySenderType(senderId: string): ChatExportSenderType {
  if (!senderId) return "unknown";
  if (senderId === "system") return "system";
  if (/^user[-_:]/i.test(senderId)) return "user";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      senderId,
    )
  ) {
    return "user";
  }
  return "agent";
}

function senderParticipantFor(
  senderDirectory: Map<string, ChatExportParticipant>,
  senderId: string | undefined,
): ChatExportParticipant {
  const normalized = normalizeString(senderId) ?? "unknown";
  return (
    senderDirectory.get(normalized) ?? {
      sender_id: normalized,
      sender_type: classifySenderType(normalized),
      sender_label: normalized || "unknown",
    }
  );
}

function collectThreadParticipants(
  aggregate: ThreadAggregate,
  senderDirectory: Map<string, ChatExportParticipant>,
): ChatExportParticipant[] | undefined {
  const seen = new Set<string>();
  const participants: ChatExportParticipant[] = [];
  for (const message of aggregate.dedupedMessages) {
    const sender = senderParticipantFor(senderDirectory, message.sender_id);
    if (seen.has(sender.sender_id)) continue;
    seen.add(sender.sender_id);
    participants.push(sender);
  }
  return participants.length ? participants : undefined;
}

function getSessionsRootForExport(): string | undefined {
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

function readSessionMetaFromJsonl(
  content: Uint8Array,
  filePath: string,
): { payload: Record<string, unknown> } {
  const text = new TextDecoder("utf8").decode(content);
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    throw new Error(`empty session file ${filePath}`);
  }
  const parsed = JSON.parse(firstLine) as {
    type?: string;
    payload?: Record<string, unknown>;
  };
  if (parsed?.type !== "session_meta" || parsed.payload == null) {
    throw new Error(`invalid session meta in ${filePath}`);
  }
  return { payload: parsed.payload };
}

async function collectChatCodexContexts({
  threads,
}: {
  threads: Map<string, ThreadAggregate>;
}): Promise<{
  files: ExportFile[];
  count: number;
  warnings: ChatExportWarning[];
}> {
  const files: ExportFile[] = [];
  const warnings: ChatExportWarning[] = [];
  const sessionsRoot = getSessionsRootForExport();
  let count = 0;
  for (const aggregate of threads.values()) {
    const sessionId = resolveCodexSessionId(aggregate);
    if (!sessionId) {
      if (isCodexThreadAggregate(aggregate)) {
        const warning: ChatExportWarning = {
          code: "codex_context_missing",
          thread_id: aggregate.threadId,
          message:
            "Codex context was requested but this thread has no session id.",
        };
        warnings.push(warning);
        aggregate.warnings.push(warning);
      }
      continue;
    }
    if (!sessionsRoot) {
      const warning: ChatExportWarning = {
        code: "codex_context_missing",
        thread_id: aggregate.threadId,
        session_id: sessionId,
        message:
          "Codex context was requested but the local Codex session store is unavailable.",
      };
      warnings.push(warning);
      aggregate.warnings.push(warning);
      continue;
    }
    const sessionFile = await findSessionFile(sessionId, sessionsRoot);
    if (!sessionFile) {
      const warning: ChatExportWarning = {
        code: "codex_context_missing",
        thread_id: aggregate.threadId,
        session_id: sessionId,
        message: `Codex context was requested but no local session file was found for ${sessionId}.`,
      };
      warnings.push(warning);
      aggregate.warnings.push(warning);
      continue;
    }
    try {
      const portable = await readPortableSessionHistory(sessionFile, {
        force: true,
      });
      const sessionBytes = portable.content;
      const sha256 = createHash("sha256").update(sessionBytes).digest("hex");
      const meta = readSessionMetaFromJsonl(sessionBytes, sessionFile);
      const codexDir = `threads/${aggregate.threadId}/codex`;
      const metaPath = `${codexDir}/meta.json`;
      const sessionPath = `${codexDir}/session.jsonl`;
      const relativeSessionPath = normalizeRelativeSessionPath(
        sessionFile,
        sessionsRoot,
      );
      aggregate.codexContext = {
        session_id: sessionId,
        meta_path: metaPath,
        session_path: sessionPath,
        sha256,
        exported_session_path: relativeSessionPath,
        trimmed: portable.trimmed,
        original_bytes: portable.originalBytes,
        exported_bytes: portable.exportedBytes,
        total_compactions: portable.totalCompactions,
      };
      files.push(
        {
          path: metaPath,
          content: `${JSON.stringify(
            {
              format: "cocalc-codex-context",
              version: 1,
              session_id: sessionId,
              sha256,
              exported_session_path: relativeSessionPath,
              trimmed: portable.trimmed,
              original_bytes: portable.originalBytes,
              exported_bytes: portable.exportedBytes,
              total_compactions: portable.totalCompactions,
              session_meta: meta.payload,
            },
            null,
            2,
          )}\n`,
          contentType: "application/json; charset=utf-8",
        },
        {
          path: sessionPath,
          content: sessionBytes,
          contentType: "application/x-ndjson; charset=utf-8",
        },
      );
      count += 1;
    } catch (err) {
      const warning: ChatExportWarning = {
        code: "codex_context_read_failed",
        thread_id: aggregate.threadId,
        session_id: sessionId,
        message: `Failed to export Codex context: ${err instanceof Error ? err.message : String(err)}`,
      };
      warnings.push(warning);
      aggregate.warnings.push(warning);
    }
  }
  return { files, count, warnings };
}

function isCodexThreadAggregate(aggregate: ThreadAggregate): boolean {
  if (normalizeString(aggregate.config?.agent_kind) === "acp") {
    return true;
  }
  if (aggregate.config?.acp_config != null) {
    return true;
  }
  return aggregate.dedupedMessages.some(
    (message) => normalizeString(message.acp_thread_id) != null,
  );
}

function resolveCodexSessionId(aggregate: ThreadAggregate): string | undefined {
  const configSessionId = normalizeString(
    (aggregate.config?.acp_config as { sessionId?: string } | undefined)
      ?.sessionId,
  );
  if (configSessionId) return configSessionId;
  for (let i = aggregate.dedupedMessages.length - 1; i >= 0; i -= 1) {
    const sessionId = normalizeString(
      aggregate.dedupedMessages[i]?.acp_thread_id,
    );
    if (sessionId) return sessionId;
  }
  return undefined;
}

function normalizeRelativeSessionPath(
  sessionFile: string,
  sessionsRoot: string,
): string | undefined {
  const relative = path.relative(sessionsRoot, sessionFile).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../")) {
    return undefined;
  }
  return relative;
}

function toExportMessageRow(
  message: SourceChatMessageRow,
  senderDirectory: Map<string, ChatExportParticipant>,
  blobReplacements: Map<string, string>,
): ChatExportMessageRow {
  const sender = senderParticipantFor(senderDirectory, message.sender_id);
  const current = currentHistoryEntry(message);
  return {
    event: "chat-message",
    message_kind: "message",
    message_id: normalizeString(message.message_id) ?? messageKey(message),
    thread_id: normalizeString(message.thread_id) ?? "unknown-thread",
    parent_message_id: normalizeString(message.parent_message_id),
    timestamp: message.date,
    edited_at:
      current && current.date !== message.date
        ? normalizeDate(current.date)
        : undefined,
    sender_id: sender.sender_id,
    sender_type: sender.sender_type,
    sender_label: sender.sender_label,
    content: rewriteBlobRefs(current?.content ?? "", blobReplacements),
    content_format: "markdown",
    generating: message.generating === true ? true : undefined,
    feedback: message.feedback,
    acp_thread_id: normalizeString(message.acp_thread_id) ?? undefined,
    acp_usage: message.acp_usage,
    acp_account_id: normalizeString(message.acp_account_id) ?? undefined,
    inline_code_links: Array.isArray(message.inline_code_links)
      ? message.inline_code_links
      : undefined,
  };
}

function rewriteMaybeBlobRef(
  value: string | undefined,
  replacements: Map<string, string>,
): string | undefined {
  const normalized = normalizeString(value);
  return normalized ? rewriteBlobRefs(normalized, replacements) : undefined;
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
}): Promise<{
  assetIndex: ChatExportAssetIndexEntry[];
  warnings: ChatExportWarning[];
}> {
  assetContentByPath.clear();
  const assetByOriginal = new Map<string, ChatExportAssetIndexEntry>();
  const assetByPath = new Map<
    string,
    { path: string; sha256: string; contentType?: string }
  >();
  const warnings: ChatExportWarning[] = [];
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
        let fetched;
        try {
          fetched = await fetchBlobAsset(ref, blobBearerToken);
        } catch (err) {
          const warning: ChatExportWarning = {
            code: "blob_fetch_failed",
            thread_id: aggregate.threadId,
            original_ref: ref.originalRef,
            fetch_url: ref.fetchUrl,
            message: `${err}`,
          };
          warnings.push(warning);
          aggregate.warnings.push(warning);
          continue;
        }
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
  return {
    assetIndex: Array.from(assetByOriginal.values()).sort((a, b) =>
      a.originalRef.localeCompare(b.originalRef),
    ),
    warnings,
  };
}

function rewriteBlobRefs(
  content: string,
  replacements: Map<string, string>,
): string {
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
    throw new Error(
      `failed to fetch blob ${ref.originalRef}: HTTP ${response.status}`,
    );
  }
  const content = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(content).digest("hex");
  const headerContentType = normalizeContentType(
    response.headers.get("content-type"),
  );
  const sniffed = sniffBlobType(content);
  const contentType =
    headerContentType && headerContentType !== "application/octet-stream"
      ? headerContentType
      : sniffed.contentType;
  const ext =
    sanitizeExtension(path.extname(ref.filename)) ||
    extensionForContentType(contentType) ||
    sniffed.extension ||
    ".bin";
  return {
    path: `assets/${sha256}${ext}`,
    sha256,
    contentType,
    content,
  };
}

function sanitizeExtension(ext: string): string {
  const trimmed = `${ext ?? ""}`.trim().toLowerCase();
  if (!trimmed) return "";
  return /^[.][a-z0-9._-]+$/.test(trimmed) && /[a-z]/.test(trimmed)
    ? trimmed
    : "";
}

function normalizeContentType(
  contentType: string | null | undefined,
): string | undefined {
  const normalized = `${contentType ?? ""}`.trim().toLowerCase();
  if (!normalized) return undefined;
  const head = normalized.split(";")[0]?.trim();
  return head || undefined;
}

function extensionForContentType(contentType: string | undefined): string {
  switch (contentType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/avif":
      return ".avif";
    case "image/bmp":
      return ".bmp";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return ".ico";
    case "image/svg+xml":
      return ".svg";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

function sniffBlobType(content: Uint8Array): {
  contentType?: string;
  extension?: string;
} {
  if (
    content.length >= 8 &&
    content[0] === 0x89 &&
    content[1] === 0x50 &&
    content[2] === 0x4e &&
    content[3] === 0x47 &&
    content[4] === 0x0d &&
    content[5] === 0x0a &&
    content[6] === 0x1a &&
    content[7] === 0x0a
  ) {
    return { contentType: "image/png", extension: ".png" };
  }
  if (
    content.length >= 3 &&
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[2] === 0xff
  ) {
    return { contentType: "image/jpeg", extension: ".jpg" };
  }
  if (content.length >= 6) {
    const prefix = new TextDecoder("ascii").decode(content.slice(0, 12));
    if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) {
      return { contentType: "image/gif", extension: ".gif" };
    }
    if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") {
      return { contentType: "image/webp", extension: ".webp" };
    }
    if (prefix.startsWith("%PDF-")) {
      return { contentType: "application/pdf", extension: ".pdf" };
    }
  }
  return {};
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
  const absolute =
    trimmed.startsWith("http://") || trimmed.startsWith("https://");
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

function normalizeMessageRow(row: ChatMessage): SourceChatMessageRow {
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

function normalizeHistory(
  history: MessageHistory[] | undefined,
): MessageHistory[] {
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
  messages: SourceChatMessageRow[];
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
        aggregate.archivedMessages.push(
          normalizeMessageRow(row.row as ChatMessage),
        );
      }
      if (result.next_offset == null) break;
      offset = result.next_offset;
    }
  }
}

function dedupeMessages(
  messages: SourceChatMessageRow[],
): SourceChatMessageRow[] {
  const byKey = new Map<string, SourceChatMessageRow>();
  for (const message of messages) {
    byKey.set(messageKey(message), message);
  }
  return Array.from(byKey.values());
}

function messageKey(message: SourceChatMessageRow): string {
  return (
    normalizeString(message.message_id) ??
    `${normalizeString(message.thread_id) ?? "no-thread"}:${message.date}:${message.sender_id}`
  );
}

function orderLinearThreadMessages(
  messages: SourceChatMessageRow[],
): SourceChatMessageRow[] {
  if (messages.length <= 1) return messages.slice();
  const sorted = messages.slice().sort(compareMessages);
  const byId = new Map<string, SourceChatMessageRow>();
  for (const message of sorted) {
    const id = normalizeString(message.message_id);
    if (id) byId.set(id, message);
  }
  const children = new Map<string, SourceChatMessageRow[]>();
  const anchors: SourceChatMessageRow[] = [];
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
  const ordered: SourceChatMessageRow[] = [];
  const visit = (message: SourceChatMessageRow) => {
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

function compareMessages(
  a: SourceChatMessageRow,
  b: SourceChatMessageRow,
): number {
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
    (message) =>
      normalizeString(message.message_id) === aggregate.rootMessageId,
  );
  const content = newestContent(root ?? aggregate.dedupedMessages[0]);
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized) {
    const words = normalized.split(" ");
    const short = words.slice(0, 8).join(" ");
    return words.length > 8 ? `${short}…` : short;
  }
  const last = aggregate.lastMessageAt
    ? new Date(aggregate.lastMessageAt)
    : undefined;
  return last && Number.isFinite(last.valueOf())
    ? last.toLocaleString()
    : "Untitled Chat";
}

function currentHistoryEntry(
  message: SourceChatMessageRow | undefined,
): MessageHistory | undefined {
  return Array.isArray(message?.history) ? message?.history[0] : undefined;
}

function newestContent(message: SourceChatMessageRow | undefined): string {
  const first = currentHistoryEntry(message);
  return `${first?.content ?? ""}`;
}

function sortThreads(threads: ThreadAggregate[]): ThreadAggregate[] {
  return threads.slice().sort((a, b) => {
    const aMs = dateNumber(
      a.lastMessageAt ?? a.config?.updated_at ?? a.thread?.created_at,
    );
    const bMs = dateNumber(
      b.lastMessageAt ?? b.config?.updated_at ?? b.thread?.created_at,
    );
    if (aMs !== bMs) return bMs - aMs;
    return a.title.localeCompare(b.title);
  });
}

function renderThreadTranscript(
  aggregate: ThreadAggregate,
  senderDirectory: Map<string, ChatExportParticipant>,
  blobReplacements: Map<string, string>,
): string {
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
    const sender = senderParticipantFor(senderDirectory, message.sender_id);
    lines.push(
      `## ${index + 1}. ${escapeHeading(sender.sender_label)} (${message.date})`,
    );
    lines.push("");
    lines.push(
      `- Message ID: \`${normalizeString(message.message_id) ?? ""}\``,
    );
    lines.push(`- Sender: ${sender.sender_label}`);
    lines.push(`- Sender Type: ${sender.sender_type}`);
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
