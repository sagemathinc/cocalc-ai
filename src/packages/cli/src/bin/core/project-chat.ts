import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import {
  buildThreadConfigRecord,
  deriveAcpLogRefs,
  type ChatThreadConfigRecord,
  type ChatThreadLoopConfig,
} from "@cocalc/chat";
import { akv } from "@cocalc/conat/sync/akv";
import { automationAcp } from "@cocalc/conat/ai/acp/client";
import type {
  AcpAutomationConfig,
  AcpAutomationRequest,
  AcpAutomationResponse,
  AcpStreamMessage,
} from "@cocalc/conat/ai/acp/types";
import type { CodexSessionConfig } from "@cocalc/util/ai/codex";

type ProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type ThreadConfigPatch = Partial<
  Pick<
    ChatThreadConfigRecord,
    | "name"
    | "agent_kind"
    | "agent_model"
    | "agent_mode"
    | "acp_config"
    | "archived"
  >
> & {
  loop_config?: ChatThreadConfigRecord["loop_config"] | null;
  loop_state?: ChatThreadConfigRecord["loop_state"] | null;
  automation_config?: ChatThreadConfigRecord["automation_config"] | null;
  automation_state?: ChatThreadConfigRecord["automation_state"] | null;
};

type ProjectChatAutomationAction = AcpAutomationRequest["action"] | "status";

type ProjectChatOpsDeps<Ctx, Project extends ProjectIdentity> = {
  resolveProjectConatClient: (
    ctx: Ctx,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<{
    project: Project;
    client: any;
  }>;
};

function normalizeThreadConfigRecord(
  value: unknown,
): Partial<ChatThreadConfigRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Partial<ChatThreadConfigRecord>;
}

function getThreadConfigRecord(
  rows: any[],
  threadId: string,
): ChatThreadConfigRecord | undefined {
  const cleanThreadId = `${threadId ?? ""}`.trim();
  if (!cleanThreadId) return undefined;
  const row = rows.find(
    (value) =>
      value?.event === "chat-thread-config" &&
      `${value?.thread_id ?? ""}`.trim() === cleanThreadId,
  );
  return row ? (row as ChatThreadConfigRecord) : undefined;
}

function listThreadConfigRecords(rows: any[]): ChatThreadConfigRecord[] {
  return rows.filter((row) => row?.event === "chat-thread-config");
}

function listChatRowsForThread(rows: any[], threadId: string): any[] {
  const cleanThreadId = `${threadId ?? ""}`.trim();
  if (!cleanThreadId) return [];
  return rows.filter(
    (row) =>
      row?.event === "chat" &&
      `${row?.thread_id ?? ""}`.trim() === cleanThreadId,
  );
}

function getChatRowForThreadMessage(
  rows: any[],
  threadId: string,
  messageId?: string,
): any | undefined {
  const cleanMessageId = `${messageId ?? ""}`.trim();
  const chatRows = listChatRowsForThread(rows, threadId);
  if (cleanMessageId) {
    return chatRows.find(
      (row) => `${row?.message_id ?? ""}`.trim() === cleanMessageId,
    );
  }
  for (let i = chatRows.length - 1; i >= 0; i -= 1) {
    const row = chatRows[i];
    const logStore = `${row?.acp_log_store ?? ""}`.trim();
    const logKey = `${row?.acp_log_key ?? ""}`.trim();
    if (logStore && logKey) {
      return row;
    }
  }
  return undefined;
}

function summarizeThread(
  row: ChatThreadConfigRecord,
  rows: any[],
): Record<string, unknown> {
  const thread_id = `${row.thread_id ?? ""}`.trim();
  const messages = rows.filter(
    (value) =>
      value?.event === "chat" &&
      `${value?.thread_id ?? ""}`.trim() === thread_id,
  );
  return {
    thread_id,
    name: row.name ?? null,
    agent_kind: row.agent_kind ?? null,
    agent_model: row.agent_model ?? null,
    agent_mode: row.agent_mode ?? null,
    acp_config: row.acp_config ?? null,
    loop_config: row.loop_config ?? null,
    loop_state: row.loop_state ?? null,
    automation_config: row.automation_config ?? null,
    automation_state: row.automation_state ?? null,
    archived: !!row.archived,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
    chat_rows: messages.length,
  };
}

function replaceThreadConfigRecord(
  rows: any[],
  record: ChatThreadConfigRecord,
): any[] {
  const cleanThreadId = `${record.thread_id ?? ""}`.trim();
  const next = rows.filter(
    (row) =>
      !(
        row?.event === "chat-thread-config" &&
        `${row?.thread_id ?? ""}`.trim() === cleanThreadId
      ),
  );
  next.push(record);
  return next;
}

function isMissingFileError(err: unknown): boolean {
  const message = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return message.includes("enoent") || message.includes("no such file");
}

async function readChatRows({
  client,
  project_id,
  path,
}: {
  client: any;
  project_id: string;
  path: string;
}): Promise<any[]> {
  let raw = "";
  try {
    raw = String(await client.fs({ project_id }).readFile(path, "utf8"));
  } catch (err) {
    if (isMissingFileError(err)) {
      return [];
    }
    throw err;
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeChatRows({
  client,
  project_id,
  path,
  rows,
}: {
  client: any;
  project_id: string;
  path: string;
  rows: any[];
}): Promise<void> {
  const content =
    rows.map((row) => JSON.stringify(row)).join("\n") +
    (rows.length ? "\n" : "");
  await client.fs({ project_id }).writeFile(path, content);
}

export function mergeThreadConfigRecord(opts: {
  existing?: ChatThreadConfigRecord;
  threadId: string;
  accountId: string;
  patch: ThreadConfigPatch;
}): ChatThreadConfigRecord {
  const { existing, threadId, accountId, patch } = opts;
  const base = normalizeThreadConfigRecord(existing);
  return buildThreadConfigRecord({
    ...(base as any),
    thread_id: threadId,
    updated_by: accountId,
    updated_at: new Date().toISOString(),
    ...patch,
  });
}

async function withProjectChatFile<Ctx, Project extends ProjectIdentity, T>({
  deps,
  ctx,
  projectIdentifier,
  chatPath,
  ensureParentDir,
  cwd,
  fn,
}: {
  deps: ProjectChatOpsDeps<Ctx, Project>;
  ctx: Ctx;
  projectIdentifier?: string;
  chatPath: string;
  ensureParentDir?: boolean;
  cwd?: string;
  fn: (args: { project: Project; client: any; rows: any[] }) => Promise<T>;
}): Promise<T> {
  const path = `${chatPath ?? ""}`.trim();
  if (!path) {
    throw new Error("--path is required");
  }
  const { project, client } = await deps.resolveProjectConatClient(
    ctx,
    projectIdentifier,
    cwd,
  );
  if (ensureParentDir) {
    await client.fs({ project_id: project.project_id }).mkdir(dirname(path), {
      recursive: true,
    });
  }
  const rows = await readChatRows({
    client,
    project_id: project.project_id,
    path,
  });
  return await fn({ project, client, rows });
}

export function createProjectChatOps<Ctx, Project extends ProjectIdentity>(
  deps: ProjectChatOpsDeps<Ctx, Project>,
) {
  async function projectChatThreadCreateData({
    ctx,
    projectIdentifier,
    path,
    threadId,
    name,
    agentKind,
    agentModel,
    agentMode,
    acpConfig,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    threadId?: string;
    name?: string;
    agentKind?: "acp" | "llm" | "none";
    agentModel?: string;
    agentMode?: "interactive" | "single_turn";
    acpConfig?: CodexSessionConfig;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectChatFile({
      deps,
      ctx,
      projectIdentifier,
      chatPath: path,
      ensureParentDir: true,
      cwd,
      fn: async ({ project, client, rows }) => {
        const nextThreadId = `${threadId ?? ""}`.trim() || randomUUID();
        if (getThreadConfigRecord(rows, nextThreadId)) {
          throw new Error(`thread '${nextThreadId}' already exists`);
        }
        const record = buildThreadConfigRecord({
          thread_id: nextThreadId,
          updated_by: (ctx as any).accountId,
          updated_at: new Date().toISOString(),
          ...(name?.trim() ? { name: name.trim() } : undefined),
          ...(agentKind ? { agent_kind: agentKind } : undefined),
          ...(agentMode ? { agent_mode: agentMode } : undefined),
          ...(agentModel?.trim()
            ? { agent_model: agentModel.trim() }
            : undefined),
          ...(acpConfig ? { acp_config: acpConfig } : undefined),
        });
        const nextRows = replaceThreadConfigRecord(rows, record);
        await writeChatRows({
          client,
          project_id: project.project_id,
          path,
          rows: nextRows,
        });
        return {
          project_id: project.project_id,
          path,
          created: true,
          thread: summarizeThread(record, nextRows),
        };
      },
    });
  }

  async function projectChatThreadStatusData({
    ctx,
    projectIdentifier,
    path,
    threadId,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    threadId?: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectChatFile({
      deps,
      ctx,
      projectIdentifier,
      chatPath: path,
      cwd,
      fn: async ({ project, rows }) => {
        const cleanThreadId = `${threadId ?? ""}`.trim();
        if (cleanThreadId) {
          const row = getThreadConfigRecord(rows, cleanThreadId);
          if (!row) {
            throw new Error(`thread '${cleanThreadId}' not found`);
          }
          return {
            project_id: project.project_id,
            path,
            thread: summarizeThread(row, rows),
          };
        }
        return {
          project_id: project.project_id,
          path,
          threads: listThreadConfigRecords(rows).map((row) =>
            summarizeThread(row, rows),
          ),
        };
      },
    });
  }

  async function projectChatLoopSetData({
    ctx,
    projectIdentifier,
    path,
    threadId,
    config,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    threadId: string;
    config: ChatThreadLoopConfig;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectChatFile({
      deps,
      ctx,
      projectIdentifier,
      chatPath: path,
      cwd,
      fn: async ({ project, client, rows }) => {
        const existing = getThreadConfigRecord(rows, threadId);
        if (!existing) {
          throw new Error(`thread '${threadId}' not found`);
        }
        const next = mergeThreadConfigRecord({
          existing,
          threadId,
          accountId: (ctx as any).accountId,
          patch: {
            loop_config: config,
            loop_state: null,
          },
        });
        const nextRows = replaceThreadConfigRecord(rows, next);
        await writeChatRows({
          client,
          project_id: project.project_id,
          path,
          rows: nextRows,
        });
        return {
          project_id: project.project_id,
          path,
          thread: summarizeThread(next, nextRows),
        };
      },
    });
  }

  async function projectChatLoopClearData({
    ctx,
    projectIdentifier,
    path,
    threadId,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    threadId: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectChatFile({
      deps,
      ctx,
      projectIdentifier,
      chatPath: path,
      cwd,
      fn: async ({ project, client, rows }) => {
        const existing = getThreadConfigRecord(rows, threadId);
        if (!existing) {
          throw new Error(`thread '${threadId}' not found`);
        }
        const next = mergeThreadConfigRecord({
          existing,
          threadId,
          accountId: (ctx as any).accountId,
          patch: {
            loop_config: null,
            loop_state: null,
          },
        });
        const nextRows = replaceThreadConfigRecord(rows, next);
        await writeChatRows({
          client,
          project_id: project.project_id,
          path,
          rows: nextRows,
        });
        return {
          project_id: project.project_id,
          path,
          thread: summarizeThread(next, nextRows),
        };
      },
    });
  }

  async function projectChatAutomationData({
    ctx,
    projectIdentifier,
    path,
    threadId,
    action,
    config,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    threadId: string;
    action: ProjectChatAutomationAction;
    config?: AcpAutomationConfig | null;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectChatFile({
      deps,
      ctx,
      projectIdentifier,
      chatPath: path,
      cwd,
      fn: async ({ project, client, rows }) => {
        const row = getThreadConfigRecord(rows, threadId);
        if (!row) {
          throw new Error(`thread '${threadId}' not found`);
        }
        const response = (await automationAcp(
          {
            project_id: project.project_id,
            account_id: (ctx as any).accountId,
            path,
            thread_id: threadId,
            action,
            ...(config ? { config } : undefined),
          } as AcpAutomationRequest,
          client,
        )) as AcpAutomationResponse;
        return {
          project_id: project.project_id,
          path,
          thread_id: threadId,
          ok: !!response.ok,
          config:
            response.config ??
            (action === "status" ? row.automation_config : null) ??
            null,
          state:
            response.state ??
            (action === "status" ? row.automation_state : null) ??
            null,
          record: response.record ?? null,
        };
      },
    });
  }

  async function projectChatActivityData({
    ctx,
    projectIdentifier,
    path,
    threadId,
    messageId,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    threadId: string;
    messageId?: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectChatFile({
      deps,
      ctx,
      projectIdentifier,
      chatPath: path,
      cwd,
      fn: async ({ project, client, rows }) => {
        const row = getChatRowForThreadMessage(rows, threadId, messageId);
        const cleanMessageId = `${messageId ?? ""}`.trim();
        if (!row) {
          if (cleanMessageId) {
            throw new Error(
              `message '${cleanMessageId}' not found in thread '${threadId}'`,
            );
          }
          throw new Error(
            `thread '${threadId}' has no persisted Codex activity log`,
          );
        }
        const resolvedMessageId = `${row?.message_id ?? ""}`.trim();
        if (!resolvedMessageId) {
          throw new Error(`selected chat row does not have a message id`);
        }
        const explicitStore = `${row?.acp_log_store ?? ""}`.trim();
        const explicitKey = `${row?.acp_log_key ?? ""}`.trim();
        const refs =
          explicitStore && explicitKey
            ? {
                store: explicitStore,
                key: explicitKey,
              }
            : deriveAcpLogRefs({
                project_id: project.project_id,
                path,
                thread_id: threadId,
                message_id: resolvedMessageId,
              });
        const store = akv<AcpStreamMessage[]>({
          project_id: project.project_id,
          name: refs.store,
          client,
        });
        const events = await store.get(refs.key);
        const persistedAt = await store.time(refs.key);
        return {
          project_id: project.project_id,
          path,
          thread_id: threadId,
          message_id: resolvedMessageId,
          log_store: refs.store,
          log_key: refs.key,
          persisted: events != null,
          persisted_at: persistedAt?.toISOString() ?? null,
          event_count: Array.isArray(events) ? events.length : 0,
          events: events ?? [],
        };
      },
    });
  }

  return {
    projectChatThreadCreateData,
    projectChatThreadStatusData,
    projectChatLoopSetData,
    projectChatLoopClearData,
    projectChatAutomationData,
    projectChatActivityData,
  };
}
