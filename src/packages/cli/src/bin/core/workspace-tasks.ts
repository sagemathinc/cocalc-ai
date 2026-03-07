import {
  openSyncDBTasksSession,
  type OpenTasksSessionOptions,
  type TaskCreateInput,
  type TaskMutableFields,
  type TaskQuery,
  type TaskRecord,
  type TasksSession,
} from "@cocalc/app-tasks";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import { isAbsolute, resolve as resolvePath } from "node:path";

type WorkspaceIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type WorkspaceTasksOpsDeps<Ctx, Workspace extends WorkspaceIdentity> = {
  resolveWorkspaceConatClient: (
    ctx: Ctx,
    workspaceIdentifier?: string,
    cwd?: string,
  ) => Promise<{ workspace: Workspace; client: ConatClient }>;
};

type SessionEntry<Workspace extends WorkspaceIdentity> = {
  workspace: Workspace;
  session: TasksSession;
};

const LIVE_TASKS_SESSION_OPEN_TIMEOUT_MS = 15_000;

type AcquireWorkspaceTasksSessionOptions = OpenTasksSessionOptions & {
  workspaceIdentifier?: string;
  cwd?: string;
};

function sessionCacheKey(opts: {
  project_id: string;
  path: string;
  readOnly?: boolean;
}): string {
  return JSON.stringify({
    project_id: opts.project_id,
    path: opts.path,
    readOnly: opts.readOnly === true,
  });
}

function normalizeWorkspaceIdentifier(input?: string): string | undefined {
  const explicit = `${input ?? ""}`.trim();
  if (explicit) return explicit;
  return undefined;
}

function normalizeTasksPath(path: string): string {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("tasks path is required");
  }
  if (isAbsolute(trimmed)) {
    return resolvePath(trimmed);
  }
  return resolvePath(process.env.HOME?.trim() || process.cwd(), trimmed);
}

function compactTaskRecord(task: TaskRecord): Record<string, unknown> {
  return {
    task_id: task.task_id,
    done: task.done === true,
    deleted: task.deleted === true,
    due_date: task.due_date ?? null,
    last_edited: task.last_edited ?? null,
    color: task.color ?? null,
    hideBody: task.hideBody === true,
    desc: task.desc ?? "",
  };
}

function compactTaskRows(tasks: readonly TaskRecord[]): Array<Record<string, unknown>> {
  return tasks.map(compactTaskRecord);
}

export function createWorkspaceTasksOps<
  Ctx,
  Workspace extends WorkspaceIdentity,
>(deps: WorkspaceTasksOpsDeps<Ctx, Workspace>) {
  const sessionPromises = new Map<string, Promise<SessionEntry<Workspace>>>();
  const sessionLeases = new RefcountLeaseManager<string>({
    delayMs: 30_000,
    disposer: async (key) => {
      const entryPromise = sessionPromises.get(key);
      sessionPromises.delete(key);
      if (!entryPromise) return;
      try {
        const entry = await entryPromise;
        await entry.session.close();
      } catch {
        // ignore cleanup failures
      }
    },
  });

  async function getOrCreateSessionEntry(
    ctx: Ctx,
    options: AcquireWorkspaceTasksSessionOptions,
  ): Promise<SessionEntry<Workspace>> {
    const workspaceIdentifier = normalizeWorkspaceIdentifier(
      options.workspaceIdentifier,
    );
    const path = normalizeTasksPath(options.path);
    const { workspace, client } = await deps.resolveWorkspaceConatClient(
      ctx,
      workspaceIdentifier,
      options.cwd,
    );
    const key = sessionCacheKey({
      project_id: workspace.project_id,
      path,
      readOnly: options.readOnly,
    });
    const existing = sessionPromises.get(key);
    if (existing) {
      return await existing;
    }

    const sessionPromise = (async () => {
      const session = await openSyncDBTasksSession({
        client,
        projectId: workspace.project_id,
        path,
        readOnly: options.readOnly,
        openTimeoutMs: LIVE_TASKS_SESSION_OPEN_TIMEOUT_MS,
      });
      return { workspace, session };
    })();

    sessionPromises.set(key, sessionPromise);
    try {
      return await sessionPromise;
    } catch (error) {
      if (sessionPromises.get(key) === sessionPromise) {
        sessionPromises.delete(key);
      }
      throw error;
    }
  }

  async function acquireWorkspaceTasksSession(
    ctx: Ctx,
    options: AcquireWorkspaceTasksSessionOptions,
  ): Promise<{
    workspace: Workspace;
    session: TasksSession;
    path: string;
    release: () => Promise<void>;
  }> {
    const workspaceIdentifier = normalizeWorkspaceIdentifier(
      options.workspaceIdentifier,
    );
    const { workspace } = await deps.resolveWorkspaceConatClient(
      ctx,
      workspaceIdentifier,
      options.cwd,
    );
    const path = normalizeTasksPath(options.path);
    const key = sessionCacheKey({
      project_id: workspace.project_id,
      path,
      readOnly: options.readOnly,
    });
    const release = await sessionLeases.acquire(key);
    try {
      const entry = await getOrCreateSessionEntry(ctx, {
        ...options,
        workspaceIdentifier,
        path,
      });
      return {
        workspace: entry.workspace,
        session: entry.session,
        path,
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function withWorkspaceTasksSession<T>(
    ctx: Ctx,
    options: AcquireWorkspaceTasksSessionOptions,
    fn: (args: {
      workspace: Workspace;
      session: TasksSession;
      path: string;
    }) => Promise<T>,
  ): Promise<T> {
    const { workspace, session, path, release } =
      await acquireWorkspaceTasksSession(ctx, options);
    try {
      return await fn({ workspace, session, path });
    } finally {
      await release();
    }
  }

  async function workspaceTasksListData({
    ctx,
    workspaceIdentifier,
    path,
    query,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path: string;
    query?: TaskQuery;
    cwd?: string;
  }): Promise<Array<Record<string, unknown>>> {
    return await withWorkspaceTasksSession(
      ctx,
      { workspaceIdentifier, path, cwd, readOnly: true },
      async ({ session }) => {
        const snapshot = await session.getSnapshot(query);
        return compactTaskRows(snapshot.tasks);
      },
    );
  }

  async function workspaceTasksGetData({
    ctx,
    workspaceIdentifier,
    path,
    taskId,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path: string;
    taskId: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withWorkspaceTasksSession(
      ctx,
      { workspaceIdentifier, path, cwd, readOnly: true },
      async ({ workspace, session, path }) => {
        const task = await session.getTask(taskId);
        if (!task) {
          throw new Error(`Task '${taskId}' not found`);
        }
        return {
          workspace_id: workspace.project_id,
          path,
          task: compactTaskRecord(task),
        };
      },
    );
  }

  async function workspaceTasksSetDoneData({
    ctx,
    workspaceIdentifier,
    path,
    taskId,
    done,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path: string;
    taskId: string;
    done: boolean;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withWorkspaceTasksSession(
      ctx,
      { workspaceIdentifier, path, cwd },
      async ({ workspace, session, path }) => {
        const result = await session.setDone(taskId, done);
        const task = await session.getTask(taskId);
        return {
          workspace_id: workspace.project_id,
          path,
          task_id: taskId,
          changed_task_ids: result.changedTaskIds,
          revision: result.revision ?? null,
          task: task ? compactTaskRecord(task) : null,
        };
      },
    );
  }

  async function workspaceTasksAppendData({
    ctx,
    workspaceIdentifier,
    path,
    taskId,
    text,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path: string;
    taskId: string;
    text: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withWorkspaceTasksSession(
      ctx,
      { workspaceIdentifier, path, cwd },
      async ({ workspace, session, path }) => {
        const result = await session.appendToDescription(taskId, text);
        const task = await session.getTask(taskId);
        return {
          workspace_id: workspace.project_id,
          path,
          task_id: taskId,
          changed_task_ids: result.changedTaskIds,
          revision: result.revision ?? null,
          task: task ? compactTaskRecord(task) : null,
        };
      },
    );
  }

  async function workspaceTasksUpdateData({
    ctx,
    workspaceIdentifier,
    path,
    taskId,
    changes,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path: string;
    taskId: string;
    changes: Partial<TaskMutableFields>;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withWorkspaceTasksSession(
      ctx,
      { workspaceIdentifier, path, cwd },
      async ({ workspace, session, path }) => {
        const result = await session.updateTask(taskId, changes);
        const task = await session.getTask(taskId);
        return {
          workspace_id: workspace.project_id,
          path,
          task_id: taskId,
          changed_task_ids: result.changedTaskIds,
          revision: result.revision ?? null,
          task: task ? compactTaskRecord(task) : null,
        };
      },
    );
  }

  async function workspaceTasksAddData({
    ctx,
    workspaceIdentifier,
    path,
    input,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path: string;
    input?: TaskCreateInput;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withWorkspaceTasksSession(
      ctx,
      { workspaceIdentifier, path, cwd },
      async ({ workspace, session, path }) => {
        const task = await session.createTask(input);
        return {
          workspace_id: workspace.project_id,
          path,
          task: compactTaskRecord(task),
        };
      },
    );
  }

  return {
    acquireWorkspaceTasksSession,
    withWorkspaceTasksSession,
    workspaceTasksListData,
    workspaceTasksGetData,
    workspaceTasksSetDoneData,
    workspaceTasksAppendData,
    workspaceTasksUpdateData,
    workspaceTasksAddData,
  };
}
