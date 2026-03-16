import { dirname } from "node:path";

import {
  buildChatMessageRecordV2,
  buildThreadConfigRecord,
  CHAT_SCHEMA_V2,
  type ChatThreadConfigRecord,
} from "@cocalc/chat";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import type {
  Configuration,
  MainConfiguration,
} from "@cocalc/comm/project-configuration";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import {
  defaultWorkspaceChatPath,
  openWorkspaceStore,
  readStoredWorkspaceRecords,
  resolveWorkspaceIdentifier,
  updateStoredWorkspaceRecord,
  type WorkspaceRecord,
} from "@cocalc/conat/workspaces";
import { projectApiClient } from "@cocalc/conat/project/api";
import { uuid } from "@cocalc/util/misc";

type ProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type WorkspaceChatOpsDeps<Ctx, Project extends ProjectIdentity> = {
  resolveProjectConatClient: (
    ctx: Ctx,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<{ project: Project; client: ConatClient }>;
};

type WorkspaceNoticeThreadState = {
  workspace: WorkspaceRecord;
  chat_path: string;
  assigned: boolean;
  notice_thread_id: string;
  created_thread: boolean;
};

function requireWorkspaceRecord(
  records: WorkspaceRecord[],
  identifier: string,
): WorkspaceRecord {
  const record = resolveWorkspaceIdentifier(records, identifier);
  if (!record) {
    throw new Error(`workspace '${identifier}' not found`);
  }
  return record;
}

function asMainConfiguration(config: Configuration): MainConfiguration {
  return config as MainConfiguration;
}

async function resolveProjectHomeDirectory({
  client,
  project_id,
}: {
  client: ConatClient;
  project_id: string;
}): Promise<string> {
  const config = asMainConfiguration(
    await projectApiClient({ client, project_id }).system.configuration("main"),
  );
  const homeDirectory = `${config?.capabilities?.homeDirectory ?? ""}`.trim();
  if (!homeDirectory) {
    throw new Error(
      `project ${project_id} does not expose a home directory in system.configuration("main")`,
    );
  }
  return homeDirectory;
}

function normalizeExistingThreadConfig(
  value: unknown,
): Partial<ChatThreadConfigRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Partial<ChatThreadConfigRecord>;
}

function threadExists(syncdb: any, thread_id: string): boolean {
  const cleanThreadId = `${thread_id ?? ""}`.trim();
  if (!cleanThreadId) return false;
  const config = syncdb.get_one?.({
    event: "chat-thread-config",
    thread_id: cleanThreadId,
  });
  if (config) return true;
  const rows = syncdb.get?.({
    event: "chat",
    thread_id: cleanThreadId,
  });
  return Array.isArray(rows) && rows.length > 0;
}

function latestParentMessageId(
  syncdb: any,
  thread_id: string,
): string | undefined {
  const rows = Array.isArray(
    syncdb.get?.({
      event: "chat",
      thread_id,
    }),
  )
    ? syncdb.get({
        event: "chat",
        thread_id,
      })
    : [];
  const sorted = [...rows]
    .filter((row) => row?.event === "chat")
    .sort((a, b) => {
      const aDate = Date.parse(`${a?.date ?? ""}`);
      const bDate = Date.parse(`${b?.date ?? ""}`);
      if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) {
        return aDate - bDate;
      }
      return `${a?.message_id ?? ""}`.localeCompare(`${b?.message_id ?? ""}`);
    });
  const latest = sorted.at(-1);
  const messageId = `${latest?.message_id ?? ""}`.trim();
  return messageId || undefined;
}

async function ensureWorkspaceChatTarget({
  client,
  project_id,
  account_id,
  workspace,
}: {
  client: ConatClient;
  project_id: string;
  account_id: string;
  workspace: WorkspaceRecord;
}): Promise<{
  workspace: WorkspaceRecord;
  chat_path: string;
  assigned: boolean;
}> {
  const existing = `${workspace.chat_path ?? ""}`.trim();
  if (existing) {
    return {
      workspace,
      chat_path: existing,
      assigned: false,
    };
  }
  const homeDirectory = await resolveProjectHomeDirectory({
    client,
    project_id,
  });
  const chat_path = defaultWorkspaceChatPath({
    account_id,
    workspace_id: workspace.workspace_id,
    homeDirectory,
  });
  const store = await openWorkspaceStore({
    client,
    project_id,
    account_id,
  });
  try {
    const updated = updateStoredWorkspaceRecord(store, workspace.workspace_id, {
      chat_path,
    }) ?? {
      ...workspace,
      chat_path,
    };
    await store.save();
    return {
      workspace: updated,
      chat_path,
      assigned: true,
    };
  } finally {
    store.close();
  }
}

async function ensureWorkspaceNoticeThread({
  client,
  project_id,
  account_id,
  accountIdForChat,
  workspace,
  chat_path,
}: {
  client: ConatClient;
  project_id: string;
  account_id: string;
  accountIdForChat: string;
  workspace: WorkspaceRecord;
  chat_path: string;
}): Promise<WorkspaceNoticeThreadState> {
  await client
    .fs({ project_id })
    .mkdir(dirname(chat_path), { recursive: true });
  const syncdb = await acquireChatSyncDB({
    client,
    project_id,
    path: chat_path,
    persistent: true,
  });
  try {
    const existingThreadId = `${workspace.notice_thread_id ?? ""}`.trim();
    if (existingThreadId && threadExists(syncdb, existingThreadId)) {
      return {
        workspace,
        chat_path,
        assigned: false,
        notice_thread_id: existingThreadId,
        created_thread: false,
      };
    }
    const notice_thread_id = uuid();
    const updatedAt = new Date().toISOString();
    syncdb.delete?.({
      event: "chat-thread-config",
      thread_id: notice_thread_id,
    });
    syncdb.set(
      buildThreadConfigRecord({
        thread_id: notice_thread_id,
        updated_by: accountIdForChat,
        updated_at: updatedAt,
        name: "Workspace notices",
        schema_version: CHAT_SCHEMA_V2,
      }),
    );
    syncdb.commit();
    await syncdb.save();
    const store = await openWorkspaceStore({
      client,
      project_id,
      account_id,
    });
    try {
      const updated = updateStoredWorkspaceRecord(
        store,
        workspace.workspace_id,
        {
          notice_thread_id,
        },
      ) ?? {
        ...workspace,
        notice_thread_id,
      };
      await store.save();
      return {
        workspace: updated,
        chat_path,
        assigned: false,
        notice_thread_id,
        created_thread: true,
      };
    } finally {
      store.close();
    }
  } finally {
    await releaseChatSyncDB(project_id, chat_path);
  }
}

export function createWorkspaceChatOps<Ctx, Project extends ProjectIdentity>(
  deps: WorkspaceChatOpsDeps<Ctx, Project>,
) {
  async function appendWorkspaceMessageData({
    ctx,
    projectIdentifier,
    workspaceIdentifier,
    text,
    cwd,
    tag,
  }: {
    ctx: Ctx & { accountId: string };
    projectIdentifier?: string;
    workspaceIdentifier: string;
    text: string;
    cwd?: string;
    tag?: string;
  }): Promise<{
    project: Project;
    workspace: WorkspaceRecord;
    chat_path: string;
    assigned: boolean;
    notice_thread_id: string;
    created_thread: boolean;
    timestamp: string;
    message_id: string;
  }> {
    const cleanText = `${text ?? ""}`.trim();
    if (!cleanText) {
      throw new Error("workspace message text must be non-empty");
    }
    const { project, client } = await deps.resolveProjectConatClient(
      ctx,
      projectIdentifier,
      cwd,
    );
    const store = await openWorkspaceStore({
      client,
      project_id: project.project_id,
      account_id: ctx.accountId,
    });
    let workspace: WorkspaceRecord;
    try {
      workspace = requireWorkspaceRecord(
        readStoredWorkspaceRecords(store),
        workspaceIdentifier,
      );
    } finally {
      store.close();
    }
    const chatTarget = await ensureWorkspaceChatTarget({
      client,
      project_id: project.project_id,
      account_id: ctx.accountId,
      workspace,
    });
    const noticeTarget = await ensureWorkspaceNoticeThread({
      client,
      project_id: project.project_id,
      account_id: ctx.accountId,
      accountIdForChat: ctx.accountId,
      workspace: chatTarget.workspace,
      chat_path: chatTarget.chat_path,
    });

    const timestamp = new Date().toISOString();
    const message_id = uuid();
    const syncdb = await acquireChatSyncDB({
      client,
      project_id: project.project_id,
      path: noticeTarget.chat_path,
      persistent: true,
    });
    try {
      const parent_message_id = latestParentMessageId(
        syncdb,
        noticeTarget.notice_thread_id,
      );
      const message = buildChatMessageRecordV2({
        sender_id: ctx.accountId,
        date: timestamp,
        prevHistory: [],
        content: cleanText,
        generating: false,
        message_id,
        thread_id: noticeTarget.notice_thread_id,
        parent_message_id,
      });
      const row = tag?.trim()
        ? { ...message, tag: tag.trim() }
        : { ...message };
      syncdb.set(row);

      const existingConfig = normalizeExistingThreadConfig(
        syncdb.get_one?.({
          event: "chat-thread-config",
          thread_id: noticeTarget.notice_thread_id,
        }),
      );
      syncdb.delete?.({
        event: "chat-thread-config",
        thread_id: noticeTarget.notice_thread_id,
      });
      syncdb.set({
        ...existingConfig,
        ...buildThreadConfigRecord({
          thread_id: noticeTarget.notice_thread_id,
          updated_by: ctx.accountId,
          updated_at: timestamp,
          name: `${existingConfig.name ?? ""}`.trim() || "Workspace notices",
          latest_chat_date_ms: Date.parse(timestamp),
          schema_version: CHAT_SCHEMA_V2,
        }),
      });
      syncdb.commit();
      await syncdb.save();
    } finally {
      await releaseChatSyncDB(project.project_id, noticeTarget.chat_path);
    }

    const finalStore = await openWorkspaceStore({
      client,
      project_id: project.project_id,
      account_id: ctx.accountId,
    });
    try {
      const updated =
        updateStoredWorkspaceRecord(
          finalStore,
          noticeTarget.workspace.workspace_id,
          {
            last_used_at: Date.now(),
          },
        ) ?? noticeTarget.workspace;
      await finalStore.save();
      return {
        project,
        workspace: updated,
        chat_path: noticeTarget.chat_path,
        assigned: chatTarget.assigned,
        notice_thread_id: noticeTarget.notice_thread_id,
        created_thread: noticeTarget.created_thread,
        timestamp,
        message_id,
      };
    } finally {
      finalStore.close();
    }
  }

  return {
    appendWorkspaceMessageData,
  };
}
