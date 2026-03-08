import type {
  OpenTasksSessionOptions,
  TaskCreateInput,
  TaskMutableFields,
  TaskQuery,
  TaskRecord,
  TasksSession,
} from "@cocalc/app-tasks";
import { openSyncDBTasksSession } from "@cocalc/app-tasks";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  openCurrentProjectConnection,
  type CurrentProjectIdentity,
} from "./current-project";

type ProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type TasksDocumentBindingOptions = {
  projectIdentifier?: string;
  path: string;
  cwd?: string;
};

type WithProjectTasksSession<Ctx, Project extends ProjectIdentity> = <T>(
  ctx: Ctx,
  options: TasksDocumentBindingOptions & {
    readOnly?: boolean;
  },
  fn: (args: {
    project: Project;
    session: TasksSession;
    path: string;
  }) => Promise<T>,
) => Promise<T>;

export interface OpenTasksApiOptions {
  apiBaseUrl?: string;
  bearer?: string;
  projectId?: string;
  timeoutMs?: number;
  sessionOpenTimeoutMs?: number;
}

export interface OpenedTasksApi extends TasksApi<undefined, ProjectIdentity> {
  readonly project: ProjectIdentity;
  readonly apiBaseUrl: string;
  close(): Promise<void>;
}

export interface BoundTasksDocument<Project extends ProjectIdentity> {
  readonly projectIdentifier?: string;
  readonly path: string;
  readonly cwd?: string;

  getSnapshot(query?: TaskQuery): Promise<{
    project: Project;
    path: string;
    tasks: TaskRecord[];
    revision?: string | number | null;
  }>;

  getTask(taskId: string): Promise<{
    project: Project;
    path: string;
    task?: TaskRecord;
  }>;

  setDone(taskId: string, done: boolean): Promise<{
    project: Project;
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;

  appendToDescription(taskId: string, text: string): Promise<{
    project: Project;
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;

  updateTask(taskId: string, changes: Partial<TaskMutableFields>): Promise<{
    project: Project;
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;

  createTask(input?: TaskCreateInput): Promise<{
    project: Project;
    path: string;
    task: TaskRecord;
  }>;

  withSession<T>(
    fn: (args: {
      project: Project;
      session: TasksSession;
      path: string;
    }) => Promise<T>,
  ): Promise<T>;
}

export interface TasksApi<Ctx, Project extends ProjectIdentity> {
  bindDocument(
    ctx: Ctx,
    options: TasksDocumentBindingOptions,
  ): BoundTasksDocument<Project>;
}

export function createTasksApi<Ctx, Project extends ProjectIdentity>({
  withProjectTasksSession,
}: {
  withProjectTasksSession: WithProjectTasksSession<Ctx, Project>;
}): TasksApi<Ctx, Project> {
  function bindDocument(
    ctx: Ctx,
    options: TasksDocumentBindingOptions,
  ): BoundTasksDocument<Project> {
    const binding = {
      projectIdentifier: options.projectIdentifier,
      path: options.path,
      cwd: options.cwd,
    } as const;

    const withSession = async <T>(
      fn: (args: {
        project: Project;
        session: TasksSession;
        path: string;
      }) => Promise<T>,
      readOnly?: boolean,
    ): Promise<T> =>
      await withProjectTasksSession(
        ctx,
        {
          projectIdentifier: binding.projectIdentifier,
          path: binding.path,
          cwd: binding.cwd,
          ...(readOnly ? { readOnly: true } : {}),
        },
        fn,
      );

    return {
      ...binding,
      async getSnapshot(query?: TaskQuery) {
        return await withSession(
          async ({ project, session, path }) => {
            const snapshot = await session.getSnapshot(query);
            return {
              project,
              path,
              tasks: [...snapshot.tasks],
              revision: snapshot.revision ?? null,
            };
          },
          true,
        );
      },
      async getTask(taskId: string) {
        return await withSession(
          async ({ project, session, path }) => ({
            project,
            path,
            task: await session.getTask(taskId),
          }),
          true,
        );
      },
      async setDone(taskId: string, done: boolean) {
        return await withSession(async ({ project, session, path }) => {
          const result = await session.setDone(taskId, done);
          return {
            project,
            path,
            changedTaskIds: result.changedTaskIds,
            revision: result.revision ?? null,
            task: await session.getTask(taskId),
          };
        });
      },
      async appendToDescription(taskId: string, text: string) {
        return await withSession(async ({ project, session, path }) => {
          const result = await session.appendToDescription(taskId, text);
          return {
            project,
            path,
            changedTaskIds: result.changedTaskIds,
            revision: result.revision ?? null,
            task: await session.getTask(taskId),
          };
        });
      },
      async updateTask(taskId: string, changes: Partial<TaskMutableFields>) {
        return await withSession(async ({ project, session, path }) => {
          const result = await session.updateTask(taskId, changes);
          return {
            project,
            path,
            changedTaskIds: result.changedTaskIds,
            revision: result.revision ?? null,
            task: await session.getTask(taskId),
          };
        });
      },
      async createTask(input?: TaskCreateInput) {
        return await withSession(async ({ project, session, path }) => ({
          project,
          path,
          task: await session.createTask(input),
        }));
      },
      async withSession<T>(
        fn: (args: {
          project: Project;
          session: TasksSession;
          path: string;
        }) => Promise<T>,
      ) {
        return await withSession(fn);
      },
    };
  }

  return { bindDocument };
}

const DEFAULT_SESSION_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_LEASE_MS = 30_000;

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

export async function openTasksApi(
  options: OpenTasksApiOptions = {},
): Promise<OpenedTasksApi> {
  const { apiBaseUrl, projectId, client, project } =
    await openCurrentProjectConnection(options);

  const sessionPromises = new Map<
    string,
    Promise<{
      project: CurrentProjectIdentity;
      session: TasksSession;
      path: string;
    }>
  >();
  let closed = false;
  const sessionLeases = new RefcountLeaseManager<string>({
    delayMs: DEFAULT_SESSION_LEASE_MS,
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

  const withProjectTasksSession: WithProjectTasksSession<
    undefined,
    ProjectIdentity
  > = async (ctx, docOptions, fn) => {
    void ctx;
    if (closed) {
      throw new Error("tasks api is closed");
    }
    const path = normalizeTasksPath(docOptions.path);
    const key = JSON.stringify({
      project_id: projectId,
      path,
      readOnly: docOptions.readOnly === true,
    });
    const release = await sessionLeases.acquire(key);
    try {
      let entryPromise = sessionPromises.get(key);
      if (!entryPromise) {
        const created = (async () => {
          const session = await openSyncDBTasksSession({
            client,
            projectId,
            path,
            readOnly: docOptions.readOnly,
            openTimeoutMs:
              options.sessionOpenTimeoutMs ?? DEFAULT_SESSION_OPEN_TIMEOUT_MS,
          } satisfies OpenTasksSessionOptions & {
            client: ConatClient;
          });
          return { project, session, path };
        })();
        sessionPromises.set(key, created);
        entryPromise = created;
        try {
          await created;
        } catch (error) {
          if (sessionPromises.get(key) === created) {
            sessionPromises.delete(key);
          }
          throw error;
        }
      }
      const entry = await entryPromise;
      return await fn(entry);
    } finally {
      await release();
    }
  };

  const api = createTasksApi<undefined, ProjectIdentity>({
    withProjectTasksSession,
  });

  return {
    ...api,
    project,
    apiBaseUrl,
    async close() {
      if (closed) return;
      closed = true;
      const pending = Array.from(sessionPromises.values());
      sessionPromises.clear();
      await Promise.allSettled(
        pending.map(async (promise) => {
          const entry = await promise;
          await entry.session.close();
        }),
      );
      client.close();
    },
  };
}
