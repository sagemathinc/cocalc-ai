import type {
  TaskCreateInput,
  TaskListSnapshot,
  TaskMutationResult,
  TaskMutableFields,
  TaskPatch,
  TaskQuery,
  TaskRecord,
  TasksSearchResult,
} from "./model";

export interface OpenTasksSessionOptions {
  projectId?: string;
  path: string;
  readOnly?: boolean;
  openTimeoutMs?: number;
}

export interface TasksSession {
  close(): Promise<void>;
  getSnapshot(query?: TaskQuery): Promise<TaskListSnapshot>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  search(query: TaskQuery): Promise<TasksSearchResult>;
  createTask(input?: TaskCreateInput): Promise<TaskRecord>;
  patchTasks(patches: readonly TaskPatch[]): Promise<TaskMutationResult>;
  removeTasks(taskIds: readonly string[]): Promise<TaskMutationResult>;
  setDone(taskId: string, done: boolean): Promise<TaskMutationResult>;
  updateTask(
    taskId: string,
    changes: Partial<TaskMutableFields>,
  ): Promise<TaskMutationResult>;
  appendToDescription(taskId: string, text: string): Promise<TaskMutationResult>;
}

export interface TasksSessionProvider {
  openTasksSession(options: OpenTasksSessionOptions): Promise<TasksSession>;
}
