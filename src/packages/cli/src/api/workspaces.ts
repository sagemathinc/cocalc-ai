import { isAbsolute, resolve as resolvePath } from "node:path";

import type { Client as ConatClient } from "@cocalc/conat/core/client";
import {
  createStoredWorkspaceRecord,
  deleteStoredWorkspaceRecord,
  openWorkspaceStore,
  readStoredWorkspaceRecords,
  resolveWorkspaceForPath,
  resolveWorkspaceIdentifier,
  type WorkspaceNoticeLevel,
  type WorkspaceRecord,
  type WorkspaceUpdatePatch,
  updateStoredWorkspaceRecord,
} from "@cocalc/conat/workspaces";
import { createWorkspaceChatOps } from "../bin/core/workspace-chat";

export type WorkspaceProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export type WorkspaceApiBindingOptions = {
  projectIdentifier?: string;
  cwd?: string;
};

type ResolveProjectConatClient<
  Ctx,
  Project extends WorkspaceProjectIdentity,
> = (
  ctx: Ctx,
  projectIdentifier?: string,
  cwd?: string,
) => Promise<{ project: Project; client: ConatClient }>;

export type WorkspaceSummary = {
  workspace_id: string;
  project_id: string;
  root_path: string;
  title: string;
  description: string;
  color: string | null;
  accent_color: string | null;
  icon: string | null;
  image_blob: string | null;
  pinned: boolean;
  last_used_at: number | null;
  last_active_path: string | null;
  chat_path: string | null;
  notice_thread_id: string | null;
  notice: WorkspaceRecord["notice"];
  source: WorkspaceRecord["source"] | null;
};

export type WorkspaceCreateOptions = WorkspaceApiBindingOptions & {
  rootPath: string;
  title?: string;
  description?: string;
  color?: string | null;
  accentColor?: string | null;
  icon?: string | null;
  imageBlob?: string | null;
  pinned?: boolean;
};

export type WorkspaceUpdateOptions = WorkspaceApiBindingOptions & {
  workspace: string;
  rootPath?: string;
  title?: string;
  description?: string;
  color?: string | null;
  accentColor?: string | null;
  icon?: string | null;
  imageBlob?: string | null;
  pinned?: boolean;
  chatPath?: string | null;
};

export type WorkspaceResolveOptions = WorkspaceApiBindingOptions & {
  path: string;
};

export type WorkspaceNoticeOptions = WorkspaceApiBindingOptions & {
  workspace: string;
  text: string;
  title?: string;
  level?: WorkspaceNoticeLevel;
};

export type WorkspaceClearNoticeOptions = WorkspaceApiBindingOptions & {
  workspace: string;
};

export type WorkspaceMessageOptions = WorkspaceApiBindingOptions & {
  workspace: string;
  text: string;
  tag?: string;
};

export interface WorkspacesApi<Ctx, Project extends WorkspaceProjectIdentity> {
  list(
    ctx: Ctx,
    options?: WorkspaceApiBindingOptions,
  ): Promise<{
    project: Project;
    workspaces: WorkspaceSummary[];
  }>;
  resolve(
    ctx: Ctx,
    options: WorkspaceResolveOptions,
  ): Promise<{
    project: Project;
    path: string;
    workspace: WorkspaceSummary | null;
  }>;
  create(
    ctx: Ctx,
    options: WorkspaceCreateOptions,
  ): Promise<{
    project: Project;
    workspace: WorkspaceSummary;
  }>;
  update(
    ctx: Ctx,
    options: WorkspaceUpdateOptions,
  ): Promise<{
    project: Project;
    workspace: WorkspaceSummary;
  }>;
  delete(
    ctx: Ctx,
    options: WorkspaceApiBindingOptions & { workspace: string },
  ): Promise<{
    project: Project;
    workspace_id: string;
    deleted: true;
  }>;
  notify(
    ctx: Ctx,
    options: WorkspaceNoticeOptions,
  ): Promise<{
    project: Project;
    workspace: WorkspaceSummary;
  }>;
  clearNotice(
    ctx: Ctx,
    options: WorkspaceClearNoticeOptions,
  ): Promise<{
    project: Project;
    workspace: WorkspaceSummary;
  }>;
  message(
    ctx: Ctx & { accountId: string },
    options: WorkspaceMessageOptions,
  ): Promise<{
    project: Project;
    workspace: WorkspaceSummary;
    chat_path: string;
    notice_thread_id: string;
    created_thread: boolean;
    assigned: boolean;
    timestamp: string;
    message_id: string;
  }>;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeWorkspacePath(path: string, cwd?: string): string {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("workspace path must be non-empty");
  }
  if (isAbsolute(trimmed)) {
    return resolvePath(trimmed);
  }
  return resolvePath(process.env.HOME?.trim() || cwd || process.cwd(), trimmed);
}

function workspaceSummary(record: WorkspaceRecord): WorkspaceSummary {
  return {
    workspace_id: record.workspace_id,
    project_id: record.project_id,
    root_path: record.root_path,
    title: record.theme?.title ?? "",
    description: record.theme?.description ?? "",
    color: record.theme?.color ?? null,
    accent_color: record.theme?.accent_color ?? null,
    icon: record.theme?.icon ?? null,
    image_blob: record.theme?.image_blob ?? null,
    pinned: record.pinned === true,
    last_used_at: record.last_used_at ?? null,
    last_active_path: record.last_active_path ?? null,
    chat_path: record.chat_path ?? null,
    notice_thread_id: record.notice_thread_id ?? null,
    notice: record.notice ?? null,
    source: record.source ?? null,
  };
}

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

function buildThemePatch(
  options: Pick<
    WorkspaceUpdateOptions,
    "title" | "description" | "color" | "accentColor" | "icon" | "imageBlob"
  >,
): WorkspaceUpdatePatch["theme"] | undefined {
  const theme: WorkspaceUpdatePatch["theme"] = {};
  if (options.title !== undefined) theme.title = options.title;
  if (options.description !== undefined)
    theme.description = options.description;
  if (options.color !== undefined) theme.color = options.color ?? null;
  if (options.accentColor !== undefined)
    theme.accent_color = options.accentColor ?? null;
  if (options.icon !== undefined) theme.icon = options.icon ?? null;
  if (options.imageBlob !== undefined)
    theme.image_blob = options.imageBlob ?? null;
  return Object.keys(theme).length > 0 ? theme : undefined;
}

export function createWorkspacesApi<
  Ctx extends { accountId: string },
  Project extends WorkspaceProjectIdentity,
>({
  resolveProjectConatClient,
}: {
  resolveProjectConatClient: ResolveProjectConatClient<Ctx, Project>;
}): WorkspacesApi<Ctx, Project> {
  const { appendWorkspaceMessageData } = createWorkspaceChatOps({
    resolveProjectConatClient,
  });

  return {
    async list(ctx, options = {}) {
      const { project, client } = await resolveProjectConatClient(
        ctx,
        options.projectIdentifier,
        options.cwd,
      );
      const store = await openWorkspaceStore({
        client,
        project_id: project.project_id,
        account_id: ctx.accountId,
      });
      try {
        return {
          project,
          workspaces: readStoredWorkspaceRecords(store).map(workspaceSummary),
        };
      } finally {
        store.close();
      }
    },

    async resolve(ctx, options) {
      const { project, client } = await resolveProjectConatClient(
        ctx,
        options.projectIdentifier,
        options.cwd,
      );
      const path = normalizeWorkspacePath(options.path, options.cwd);
      const store = await openWorkspaceStore({
        client,
        project_id: project.project_id,
        account_id: ctx.accountId,
      });
      try {
        const record = resolveWorkspaceForPath(
          readStoredWorkspaceRecords(store),
          path,
        );
        return {
          project,
          path,
          workspace: record ? workspaceSummary(record) : null,
        };
      } finally {
        store.close();
      }
    },

    async create(ctx, options) {
      const { project, client } = await resolveProjectConatClient(
        ctx,
        options.projectIdentifier,
        options.cwd,
      );
      const store = await openWorkspaceStore({
        client,
        project_id: project.project_id,
        account_id: ctx.accountId,
      });
      try {
        const record = createStoredWorkspaceRecord(store, {
          project_id: project.project_id,
          input: {
            root_path: normalizeWorkspacePath(options.rootPath, options.cwd),
            title: normalizeOptionalString(options.title),
            description: options.description ?? "",
            color: options.color ?? null,
            accent_color: options.accentColor ?? null,
            icon: options.icon ?? null,
            image_blob: options.imageBlob ?? null,
            pinned: options.pinned === true,
          },
        });
        await store.save();
        return {
          project,
          workspace: workspaceSummary(record),
        };
      } finally {
        store.close();
      }
    },

    async update(ctx, options) {
      const { project, client } = await resolveProjectConatClient(
        ctx,
        options.projectIdentifier,
        options.cwd,
      );
      const store = await openWorkspaceStore({
        client,
        project_id: project.project_id,
        account_id: ctx.accountId,
      });
      try {
        const current = requireWorkspaceRecord(
          readStoredWorkspaceRecords(store),
          options.workspace,
        );
        const updated = updateStoredWorkspaceRecord(
          store,
          current.workspace_id,
          {
            ...(options.rootPath !== undefined
              ? {
                  root_path: normalizeWorkspacePath(
                    options.rootPath,
                    options.cwd,
                  ),
                }
              : {}),
            ...(buildThemePatch(options)
              ? { theme: buildThemePatch(options) }
              : {}),
            ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
            ...(options.chatPath !== undefined
              ? {
                  chat_path:
                    options.chatPath == null
                      ? null
                      : normalizeWorkspacePath(options.chatPath, options.cwd),
                }
              : {}),
          },
        );
        if (!updated) {
          throw new Error(`workspace '${options.workspace}' not found`);
        }
        await store.save();
        return {
          project,
          workspace: workspaceSummary(updated),
        };
      } finally {
        store.close();
      }
    },

    async delete(ctx, options) {
      const { project, client } = await resolveProjectConatClient(
        ctx,
        options.projectIdentifier,
        options.cwd,
      );
      const store = await openWorkspaceStore({
        client,
        project_id: project.project_id,
        account_id: ctx.accountId,
      });
      try {
        const current = requireWorkspaceRecord(
          readStoredWorkspaceRecords(store),
          options.workspace,
        );
        deleteStoredWorkspaceRecord(store, current.workspace_id);
        await store.save();
        return {
          project,
          workspace_id: current.workspace_id,
          deleted: true as const,
        };
      } finally {
        store.close();
      }
    },

    async notify(ctx, options) {
      const cleanText = `${options.text ?? ""}`.trim();
      if (!cleanText) {
        throw new Error("workspace notice text must be non-empty");
      }
      const { project, client } = await resolveProjectConatClient(
        ctx,
        options.projectIdentifier,
        options.cwd,
      );
      const store = await openWorkspaceStore({
        client,
        project_id: project.project_id,
        account_id: ctx.accountId,
      });
      try {
        const current = requireWorkspaceRecord(
          readStoredWorkspaceRecords(store),
          options.workspace,
        );
        const updated = updateStoredWorkspaceRecord(
          store,
          current.workspace_id,
          {
            notice: {
              title: `${options.title ?? ""}`.trim(),
              text: cleanText,
              level: options.level ?? "info",
            },
          },
        );
        if (!updated) {
          throw new Error(`workspace '${options.workspace}' not found`);
        }
        await store.save();
        return {
          project,
          workspace: workspaceSummary(updated),
        };
      } finally {
        store.close();
      }
    },

    async clearNotice(ctx, options) {
      const { project, client } = await resolveProjectConatClient(
        ctx,
        options.projectIdentifier,
        options.cwd,
      );
      const store = await openWorkspaceStore({
        client,
        project_id: project.project_id,
        account_id: ctx.accountId,
      });
      try {
        const current = requireWorkspaceRecord(
          readStoredWorkspaceRecords(store),
          options.workspace,
        );
        const updated = updateStoredWorkspaceRecord(
          store,
          current.workspace_id,
          {
            notice: null,
          },
        );
        if (!updated) {
          throw new Error(`workspace '${options.workspace}' not found`);
        }
        await store.save();
        return {
          project,
          workspace: workspaceSummary(updated),
        };
      } finally {
        store.close();
      }
    },

    async message(ctx, options) {
      const result = await appendWorkspaceMessageData({
        ctx,
        projectIdentifier: options.projectIdentifier,
        workspaceIdentifier: options.workspace,
        text: options.text,
        cwd: options.cwd,
        tag: options.tag,
      });
      return {
        project: result.project,
        workspace: workspaceSummary(result.workspace),
        chat_path: result.chat_path,
        notice_thread_id: result.notice_thread_id,
        created_thread: result.created_thread,
        assigned: result.assigned,
        timestamp: result.timestamp,
        message_id: result.message_id,
      };
    },
  };
}
