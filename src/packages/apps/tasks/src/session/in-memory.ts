import type {
  OpenTasksSessionOptions,
  TasksSession,
  TasksSessionProvider,
} from "../contracts/session";
import type {
  TaskCreateInput,
  TaskListSnapshot,
  TaskMutableFields,
  TaskPatch,
  TaskQuery,
  TaskRecord,
  TasksSearchResult,
} from "../contracts/model";
import {
  appendToDescription,
  createTask,
  createTaskSnapshot,
  getTask,
  listTasks,
  patchTasks,
  searchTasks,
  setTaskDone,
  updateTask,
} from "../operations";

export interface InMemoryTasksSessionOptions extends OpenTasksSessionOptions {
  initialSnapshot?: TaskListSnapshot;
  initialTasks?: readonly TaskRecord[];
  revision?: string;
}

export class InMemoryTasksSession implements TasksSession {
  private snapshot: TaskListSnapshot;
  private closed = false;

  constructor(options: InMemoryTasksSessionOptions) {
    this.snapshot =
      options.initialSnapshot ??
      createTaskSnapshot(options.initialTasks ?? [], options.revision);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async getSnapshot(query?: TaskQuery): Promise<TaskListSnapshot> {
    this.assertOpen();
    return listTasks(this.snapshot, query);
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    this.assertOpen();
    return getTask(this.snapshot, taskId);
  }

  async search(query: TaskQuery): Promise<TasksSearchResult> {
    this.assertOpen();
    return searchTasks(this.snapshot, query);
  }

  async createTask(input?: TaskCreateInput): Promise<TaskRecord> {
    this.assertOpen();
    const result = createTask(this.snapshot, input);
    this.snapshot = result.snapshot;
    return result.task;
  }

  async patchTasks(patches: readonly TaskPatch[]) {
    this.assertOpen();
    const result = patchTasks(this.snapshot, patches);
    this.snapshot = result.snapshot;
    return {
      changedTaskIds: result.changedTaskIds,
      revision: result.revision,
    };
  }

  async setDone(taskId: string, done: boolean) {
    this.assertOpen();
    const result = setTaskDone(this.snapshot, taskId, done);
    this.snapshot = result.snapshot;
    return {
      changedTaskIds: result.changedTaskIds,
      revision: result.revision,
    };
  }

  async updateTask(taskId: string, changes: Partial<TaskMutableFields>) {
    this.assertOpen();
    const result = updateTask(this.snapshot, taskId, changes);
    this.snapshot = result.snapshot;
    return {
      changedTaskIds: result.changedTaskIds,
      revision: result.revision,
    };
  }

  async appendToDescription(taskId: string, text: string) {
    this.assertOpen();
    const result = appendToDescription(this.snapshot, taskId, text);
    this.snapshot = result.snapshot;
    return {
      changedTaskIds: result.changedTaskIds,
      revision: result.revision,
    };
  }

  private assertOpen() {
    if (this.closed) {
      throw new Error("Tasks session is closed");
    }
  }
}

export class InMemoryTasksSessionProvider implements TasksSessionProvider {
  constructor(private readonly options: Omit<InMemoryTasksSessionOptions, "path"> = {}) {}

  async openTasksSession(
    options: OpenTasksSessionOptions,
  ): Promise<TasksSession> {
    return new InMemoryTasksSession({
      ...this.options,
      ...options,
    });
  }
}

export function createInMemoryTasksSession(
  options: InMemoryTasksSessionOptions,
): TasksSession {
  return new InMemoryTasksSession(options);
}
