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

type ProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type ProjectTasksOpsDeps<Ctx, Project extends ProjectIdentity> = {
  resolveProjectConatClient: (
    ctx: Ctx,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<{ project: Project; client: ConatClient }>;
};

type SessionEntry<Project extends ProjectIdentity> = {
  project: Project;
  session: TasksSession;
};

const LIVE_TASKS_SESSION_OPEN_TIMEOUT_MS = 15_000;

type AcquireProjectTasksSessionOptions = OpenTasksSessionOptions & {
  projectIdentifier?: string;
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

export function resolveTasksSessionCacheEntry<Project extends ProjectIdentity>({
  projectId,
  path,
  readOnly,
  sessionPromises,
}: {
  projectId: string;
  path: string;
  readOnly?: boolean;
  sessionPromises: Map<string, Promise<SessionEntry<Project>>>;
}): {
  key: string;
  readOnly: boolean;
} {
  if (readOnly === true) {
    const writableKey = sessionCacheKey({
      project_id: projectId,
      path,
      readOnly: false,
    });
    if (sessionPromises.has(writableKey)) {
      return {
        key: writableKey,
        readOnly: false,
      };
    }
  }
  const effectiveReadOnly = readOnly === true;
  return {
    key: sessionCacheKey({
      project_id: projectId,
      path,
      readOnly: effectiveReadOnly,
    }),
    readOnly: effectiveReadOnly,
  };
}

function normalizeProjectIdentifier(input?: string): string | undefined {
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

function compactTaskRows(
  tasks: readonly TaskRecord[],
): Array<Record<string, unknown>> {
  return tasks.map(compactTaskRecord);
}

export function createProjectTasksOps<Ctx, Project extends ProjectIdentity>(
  deps: ProjectTasksOpsDeps<Ctx, Project>,
) {
  const sessionPromises = new Map<string, Promise<SessionEntry<Project>>>();
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
    options: AcquireProjectTasksSessionOptions,
  ): Promise<SessionEntry<Project>> {
    const projectIdentifier = normalizeProjectIdentifier(
      options.projectIdentifier,
    );
    const path = normalizeTasksPath(options.path);
    const { project, client } = await deps.resolveProjectConatClient(
      ctx,
      projectIdentifier,
      options.cwd,
    );
    const cacheEntry = resolveTasksSessionCacheEntry({
      projectId: project.project_id,
      path,
      readOnly: options.readOnly,
      sessionPromises,
    });
    const { key } = cacheEntry;
    const existing = sessionPromises.get(key);
    if (existing) {
      return await existing;
    }

    const sessionPromise = (async () => {
      const session = await openSyncDBTasksSession({
        client,
        projectId: project.project_id,
        path,
        persistent: true,
        fileUseInterval: 0,
        ...(cacheEntry.readOnly ? { readOnly: true } : {}),
        openTimeoutMs: LIVE_TASKS_SESSION_OPEN_TIMEOUT_MS,
      });
      return { project, session };
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

  async function acquireProjectTasksSession(
    ctx: Ctx,
    options: AcquireProjectTasksSessionOptions,
  ): Promise<{
    project: Project;
    session: TasksSession;
    path: string;
    release: () => Promise<void>;
  }> {
    const projectIdentifier = normalizeProjectIdentifier(
      options.projectIdentifier,
    );
    const { project } = await deps.resolveProjectConatClient(
      ctx,
      projectIdentifier,
      options.cwd,
    );
    const path = normalizeTasksPath(options.path);
    const cacheEntry = resolveTasksSessionCacheEntry({
      projectId: project.project_id,
      path,
      readOnly: options.readOnly,
      sessionPromises,
    });
    const { key } = cacheEntry;
    const release = await sessionLeases.acquire(key);
    try {
      const entry = await getOrCreateSessionEntry(ctx, {
        ...options,
        projectIdentifier,
        path,
      });
      return {
        project: entry.project,
        session: entry.session,
        path,
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function withProjectTasksSession<T>(
    ctx: Ctx,
    options: AcquireProjectTasksSessionOptions,
    fn: (args: {
      project: Project;
      session: TasksSession;
      path: string;
    }) => Promise<T>,
  ): Promise<T> {
    const { project, session, path, release } =
      await acquireProjectTasksSession(ctx, options);
    try {
      return await fn({ project, session, path });
    } finally {
      await release();
    }
  }

  async function projectTasksListData({
    ctx,
    projectIdentifier,
    path,
    query,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    query?: TaskQuery;
    cwd?: string;
  }): Promise<Array<Record<string, unknown>>> {
    return await withProjectTasksSession(
      ctx,
      { projectIdentifier, path, cwd, readOnly: true },
      async ({ session }) => {
        const snapshot = await session.getSnapshot(query);
        return compactTaskRows(snapshot.tasks);
      },
    );
  }

  async function projectTasksGetData({
    ctx,
    projectIdentifier,
    path,
    taskId,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    taskId: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectTasksSession(
      ctx,
      { projectIdentifier, path, cwd, readOnly: true },
      async ({ project, session, path }) => {
        const task = await session.getTask(taskId);
        if (!task) {
          throw new Error(`Task '${taskId}' not found`);
        }
        return {
          project_id: project.project_id,
          path,
          task: compactTaskRecord(task),
        };
      },
    );
  }

  async function projectTasksSetDoneData({
    ctx,
    projectIdentifier,
    path,
    taskId,
    done,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    taskId: string;
    done: boolean;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectTasksSession(
      ctx,
      { projectIdentifier, path, cwd },
      async ({ project, session, path }) => {
        const result = await session.setDone(taskId, done);
        const task = await session.getTask(taskId);
        return {
          project_id: project.project_id,
          path,
          task_id: taskId,
          changed_task_ids: result.changedTaskIds,
          revision: result.revision ?? null,
          task: task ? compactTaskRecord(task) : null,
        };
      },
    );
  }

  async function projectTasksAppendData({
    ctx,
    projectIdentifier,
    path,
    taskId,
    text,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    taskId: string;
    text: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectTasksSession(
      ctx,
      { projectIdentifier, path, cwd },
      async ({ project, session, path }) => {
        const result = await session.appendToDescription(taskId, text);
        const task = await session.getTask(taskId);
        return {
          project_id: project.project_id,
          path,
          task_id: taskId,
          changed_task_ids: result.changedTaskIds,
          revision: result.revision ?? null,
          task: task ? compactTaskRecord(task) : null,
        };
      },
    );
  }

  async function projectTasksUpdateData({
    ctx,
    projectIdentifier,
    path,
    taskId,
    changes,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    taskId: string;
    changes: Partial<TaskMutableFields>;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectTasksSession(
      ctx,
      { projectIdentifier, path, cwd },
      async ({ project, session, path }) => {
        const result = await session.updateTask(taskId, changes);
        const task = await session.getTask(taskId);
        return {
          project_id: project.project_id,
          path,
          task_id: taskId,
          changed_task_ids: result.changedTaskIds,
          revision: result.revision ?? null,
          task: task ? compactTaskRecord(task) : null,
        };
      },
    );
  }

  async function projectTasksAddData({
    ctx,
    projectIdentifier,
    path,
    input,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    input?: TaskCreateInput;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    return await withProjectTasksSession(
      ctx,
      { projectIdentifier, path, cwd },
      async ({ project, session, path }) => {
        const task = await session.createTask(input);
        return {
          project_id: project.project_id,
          path,
          task: compactTaskRecord(task),
        };
      },
    );
  }

  return {
    acquireProjectTasksSession,
    withProjectTasksSession,
    projectTasksListData,
    projectTasksGetData,
    projectTasksSetDoneData,
    projectTasksAppendData,
    projectTasksUpdateData,
    projectTasksAddData,
  };
}
