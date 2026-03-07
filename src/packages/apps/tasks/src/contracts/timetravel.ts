import type { TaskListSnapshot } from "./model";
import type { OpenTasksSessionOptions } from "./session";

export interface TasksTimeTravelVersion {
  id: string;
  timestamp: string;
  label?: string;
}

export interface TasksTimeTravelSession {
  listVersions(): Promise<readonly TasksTimeTravelVersion[]>;
  readSnapshot(versionId: string): Promise<TaskListSnapshot>;
}

export interface TasksTimeTravelProvider {
  openTasksTimeTravelSession(
    options: OpenTasksSessionOptions,
  ): Promise<TasksTimeTravelSession>;
}
