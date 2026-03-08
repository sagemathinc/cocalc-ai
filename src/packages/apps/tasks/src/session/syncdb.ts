import type { Client as ConatClient } from "@cocalc/conat/core/client";
import {
  syncdb as createConatSyncDB,
  type SyncDBOptions,
} from "@cocalc/conat/sync-doc/syncdb";
import type { SyncDB } from "@cocalc/sync/editor/db";
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
  removeTasks,
  searchTasks,
  setTaskDone,
  updateTask,
} from "../operations";

const TASKS_SYNCDB_PRIMARY_KEYS = ["task_id"];
const TASKS_SYNCDB_STRING_COLS = ["desc"];

interface TaskSyncDBLike {
  wait_until_ready(): Promise<void>;
  isClosed(): boolean;
  close(): void | Promise<void>;
  get(where?: unknown): unknown;
  get_one(where?: unknown): unknown;
  set(obj: unknown): void;
  delete(where?: unknown): void;
  commit(): boolean;
}

export interface SyncDBTasksSessionOptions {
  readOnly?: boolean;
}

export interface OpenSyncDBTasksSessionOptions
  extends OpenTasksSessionOptions,
    SyncDBTasksSessionProviderOptions {}

export interface SyncDBTasksSessionProviderOptions {
  client: ConatClient;
  projectId?: string;
  service?: string;
  changeThrottle?: number;
  persistent?: boolean;
  fileUseInterval?: number;
}

export class SyncDBTasksSession implements TasksSession {
  private closed = false;

  constructor(
    private readonly syncdb: TaskSyncDBLike,
    private readonly options: SyncDBTasksSessionOptions = {},
  ) {}

  static async open(
    syncdb: TaskSyncDBLike,
    options: SyncDBTasksSessionOptions = {},
    openTimeoutMs?: number,
  ): Promise<SyncDBTasksSession> {
    await waitForTasksSyncDBReady(syncdb, openTimeoutMs);
    return new SyncDBTasksSession(syncdb, options);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.syncdb.close();
  }

  async getSnapshot(query?: TaskQuery): Promise<TaskListSnapshot> {
    const snapshot = this.readSnapshot();
    return listTasks(snapshot, query);
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    this.assertOpen();
    return normalizeTaskRecord(this.syncdb.get_one({ task_id: taskId }));
  }

  async search(query: TaskQuery): Promise<TasksSearchResult> {
    const snapshot = this.readSnapshot();
    return searchTasks(snapshot, query);
  }

  async createTask(input?: TaskCreateInput): Promise<TaskRecord> {
    this.assertWritable();
    const snapshot = this.readSnapshot();
    const result = createTask(snapshot, input);
    this.persistResult(result.snapshot, result.changedTaskIds);
    return result.task;
  }

  async patchTasks(patches: readonly TaskPatch[]) {
    this.assertWritable();
    const snapshot = this.readSnapshot();
    const result = patchTasks(snapshot, patches);
    this.persistResult(result.snapshot, result.changedTaskIds);
    return {
      changedTaskIds: result.changedTaskIds,
      revision: result.revision,
    };
  }

  async removeTasks(taskIds: readonly string[]) {
    this.assertWritable();
    const snapshot = this.readSnapshot();
    const result = removeTasks(snapshot, taskIds);
    this.persistResult(result.snapshot, result.changedTaskIds);
    return {
      changedTaskIds: result.changedTaskIds,
      revision: result.revision,
    };
  }

  async setDone(taskId: string, done: boolean) {
    this.assertWritable();
    const snapshot = this.readSnapshot();
    const result = setTaskDone(snapshot, taskId, done);
    this.persistResult(result.snapshot, result.changedTaskIds);
    return {
      changedTaskIds: result.changedTaskIds,
      revision: result.revision,
    };
  }

  async updateTask(taskId: string, changes: Partial<TaskMutableFields>) {
    this.assertWritable();
    const snapshot = this.readSnapshot();
    const result = updateTask(snapshot, taskId, changes);
    this.persistResult(result.snapshot, result.changedTaskIds);
    return {
      changedTaskIds: result.changedTaskIds,
      revision: result.revision,
    };
  }

  async appendToDescription(taskId: string, text: string) {
    this.assertWritable();
    const snapshot = this.readSnapshot();
    const result = appendToDescription(snapshot, taskId, text);
    this.persistResult(result.snapshot, result.changedTaskIds);
    return {
      changedTaskIds: result.changedTaskIds,
      revision: result.revision,
    };
  }

  private readSnapshot(): TaskListSnapshot {
    this.assertOpen();
    return createTaskSnapshot(normalizeTaskRows(this.syncdb.get()));
  }

  private persistResult(
    snapshot: TaskListSnapshot,
    changedTaskIds: readonly string[],
  ): void {
    for (const taskId of changedTaskIds) {
      const task = getTask(snapshot, taskId);
      if (task == null) {
        this.syncdb.delete({ task_id: taskId });
      } else {
        this.syncdb.set(task);
      }
    }
    this.syncdb.commit();
  }

  private assertOpen(): void {
    if (this.closed || this.syncdb.isClosed()) {
      throw new Error("Tasks session is closed");
    }
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.options.readOnly) {
      throw new Error("Tasks session is read-only");
    }
  }
}

export class SyncDBTasksSessionProvider implements TasksSessionProvider {
  constructor(private readonly options: SyncDBTasksSessionProviderOptions) {}

  async openTasksSession(
    options: OpenTasksSessionOptions,
  ): Promise<TasksSession> {
    const projectId = options.projectId ?? this.options.projectId;
    if (!projectId) {
      throw new Error(
        "projectId is required to open a syncdb-backed tasks session",
      );
    }
    const syncdb = createTasksSyncDB({
      client: this.options.client,
      projectId,
      path: options.path,
      service: this.options.service,
      changeThrottle: this.options.changeThrottle,
      persistent: this.options.persistent,
      fileUseInterval: this.options.fileUseInterval,
    });
    return await SyncDBTasksSession.open(syncdb, {
      readOnly: options.readOnly,
    }, options.openTimeoutMs);
  }
}

export async function openSyncDBTasksSession(
  options: OpenSyncDBTasksSessionOptions,
): Promise<TasksSession> {
  const provider = new SyncDBTasksSessionProvider(options);
  return await provider.openTasksSession(options);
}

export function createTasksSyncDB({
  client,
  projectId,
  path,
  service,
  changeThrottle,
  persistent,
  fileUseInterval,
}: {
  client: ConatClient;
  projectId: string;
  path: string;
  service?: string;
  changeThrottle?: number;
  persistent?: boolean;
  fileUseInterval?: number;
}): SyncDB {
  const options: SyncDBOptions = {
    client,
    project_id: projectId,
    path,
    primary_keys: TASKS_SYNCDB_PRIMARY_KEYS,
    string_cols: TASKS_SYNCDB_STRING_COLS,
    ...(service ? { service } : {}),
    ...(changeThrottle != null ? { change_throttle: changeThrottle } : {}),
    ...(persistent != null ? { persistent } : {}),
    ...(fileUseInterval != null
      ? { file_use_interval: fileUseInterval }
      : {}),
  };
  return createConatSyncDB(options);
}

function normalizeTaskRows(value: unknown): TaskRecord[] {
  const rows = normalizeDbValue(value);
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row) => normalizeTaskRecord(row))
    .filter((row): row is TaskRecord => row != null);
}

async function waitForTasksSyncDBReady(
  syncdb: TaskSyncDBLike,
  openTimeoutMs?: number,
): Promise<void> {
  const timeoutMs =
    openTimeoutMs != null && Number.isFinite(openTimeoutMs) && openTimeoutMs > 0
      ? openTimeoutMs
      : undefined;
  if (timeoutMs == null) {
    await syncdb.wait_until_ready();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      syncdb.wait_until_ready(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `timeout waiting for live tasks session to become ready (${timeoutMs}ms)`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function normalizeTaskRecord(value: unknown): TaskRecord | undefined {
  const row = normalizeDbValue(value);
  if (row == null || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const task = row as Record<string, unknown>;
  if (typeof task.task_id !== "string" || task.task_id.length === 0) {
    return undefined;
  }
  return {
    task_id: task.task_id,
    ...(typeof task.desc === "string" ? { desc: task.desc } : {}),
    ...(typeof task.position === "number" ? { position: task.position } : {}),
    ...(typeof task.due_date === "number" ? { due_date: task.due_date } : {}),
    ...(typeof task.done === "boolean" ? { done: task.done } : {}),
    ...(typeof task.deleted === "boolean" ? { deleted: task.deleted } : {}),
    ...(typeof task.last_edited === "number"
      ? { last_edited: task.last_edited }
      : {}),
    ...(typeof task.color === "string" ? { color: task.color } : {}),
    ...(typeof task.hideBody === "boolean"
      ? { hideBody: task.hideBody }
      : {}),
  };
}

function normalizeDbValue(value: unknown): unknown {
  if (value != null && typeof value === "object") {
    if (typeof (value as any).toJS === "function") {
      return (value as any).toJS();
    }
    if (typeof (value as any).toJSON === "function") {
      return (value as any).toJSON();
    }
  }
  return value;
}
