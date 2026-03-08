import type { TasksSession } from "@cocalc/app-tasks";
import { SyncDBTasksSession } from "@cocalc/app-tasks";

export function createFrontendTasksSession(syncdb: any): TasksSession {
  return new SyncDBTasksSession(syncdb as any);
}
