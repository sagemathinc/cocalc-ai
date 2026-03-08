import type {
  TaskCreateInput,
  TaskMutableFields,
  TaskQuery,
  TaskRecord,
  TasksSession,
} from "@cocalc/app-tasks";

type WorkspaceIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type TasksDocumentBindingOptions = {
  workspaceIdentifier?: string;
  path: string;
  cwd?: string;
};

type WithWorkspaceTasksSession<Ctx, Workspace extends WorkspaceIdentity> = <T>(
  ctx: Ctx,
  options: TasksDocumentBindingOptions & {
    readOnly?: boolean;
  },
  fn: (args: {
    workspace: Workspace;
    session: TasksSession;
    path: string;
  }) => Promise<T>,
) => Promise<T>;

export interface BoundTasksDocument<Workspace extends WorkspaceIdentity> {
  readonly workspaceIdentifier?: string;
  readonly path: string;
  readonly cwd?: string;

  getSnapshot(query?: TaskQuery): Promise<{
    workspace: Workspace;
    path: string;
    tasks: TaskRecord[];
    revision?: string | number | null;
  }>;

  getTask(taskId: string): Promise<{
    workspace: Workspace;
    path: string;
    task?: TaskRecord;
  }>;

  setDone(taskId: string, done: boolean): Promise<{
    workspace: Workspace;
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;

  appendToDescription(taskId: string, text: string): Promise<{
    workspace: Workspace;
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;

  updateTask(taskId: string, changes: Partial<TaskMutableFields>): Promise<{
    workspace: Workspace;
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;

  createTask(input?: TaskCreateInput): Promise<{
    workspace: Workspace;
    path: string;
    task: TaskRecord;
  }>;

  withSession<T>(
    fn: (args: {
      workspace: Workspace;
      session: TasksSession;
      path: string;
    }) => Promise<T>,
  ): Promise<T>;
}

export interface TasksApi<Ctx, Workspace extends WorkspaceIdentity> {
  bindDocument(
    ctx: Ctx,
    options: TasksDocumentBindingOptions,
  ): BoundTasksDocument<Workspace>;
}

export function createTasksApi<Ctx, Workspace extends WorkspaceIdentity>({
  withWorkspaceTasksSession,
}: {
  withWorkspaceTasksSession: WithWorkspaceTasksSession<Ctx, Workspace>;
}): TasksApi<Ctx, Workspace> {
  function bindDocument(
    ctx: Ctx,
    options: TasksDocumentBindingOptions,
  ): BoundTasksDocument<Workspace> {
    const binding = {
      workspaceIdentifier: options.workspaceIdentifier,
      path: options.path,
      cwd: options.cwd,
    } as const;

    const withSession = async <T>(
      fn: (args: {
        workspace: Workspace;
        session: TasksSession;
        path: string;
      }) => Promise<T>,
      readOnly?: boolean,
    ): Promise<T> =>
      await withWorkspaceTasksSession(
        ctx,
        {
          workspaceIdentifier: binding.workspaceIdentifier,
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
          async ({ workspace, session, path }) => {
            const snapshot = await session.getSnapshot(query);
            return {
              workspace,
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
          async ({ workspace, session, path }) => ({
            workspace,
            path,
            task: await session.getTask(taskId),
          }),
          true,
        );
      },
      async setDone(taskId: string, done: boolean) {
        return await withSession(async ({ workspace, session, path }) => {
          const result = await session.setDone(taskId, done);
          return {
            workspace,
            path,
            changedTaskIds: result.changedTaskIds,
            revision: result.revision ?? null,
            task: await session.getTask(taskId),
          };
        });
      },
      async appendToDescription(taskId: string, text: string) {
        return await withSession(async ({ workspace, session, path }) => {
          const result = await session.appendToDescription(taskId, text);
          return {
            workspace,
            path,
            changedTaskIds: result.changedTaskIds,
            revision: result.revision ?? null,
            task: await session.getTask(taskId),
          };
        });
      },
      async updateTask(taskId: string, changes: Partial<TaskMutableFields>) {
        return await withSession(async ({ workspace, session, path }) => {
          const result = await session.updateTask(taskId, changes);
          return {
            workspace,
            path,
            changedTaskIds: result.changedTaskIds,
            revision: result.revision ?? null,
            task: await session.getTask(taskId),
          };
        });
      },
      async createTask(input?: TaskCreateInput) {
        return await withSession(async ({ workspace, session, path }) => ({
          workspace,
          path,
          task: await session.createTask(input),
        }));
      },
      async withSession<T>(
        fn: (args: {
          workspace: Workspace;
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
