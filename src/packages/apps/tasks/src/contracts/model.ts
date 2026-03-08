export interface TaskRecord {
  task_id: string;
  desc?: string;
  position?: number;
  due_date?: number;
  done?: boolean;
  deleted?: boolean;
  last_edited?: number;
  color?: string;
  hideBody?: boolean;
}

export type TaskMutableFields = Omit<TaskRecord, "task_id">;

export type HashtagState = -1 | 1;
export type TaskSortColumn = "Custom" | "Due" | "Changed";
export type TaskSortDirection = "asc" | "desc";

export interface TaskSortSpec {
  column: TaskSortColumn;
  dir: TaskSortDirection;
}

export interface TaskQuery {
  includeDeleted?: boolean;
  includeDone?: boolean;
  search?: string;
  selectedHashtags?: Readonly<Record<string, HashtagState>>;
  sort?: TaskSortSpec;
  limit?: number;
}

export interface TaskPatch {
  task_id: string;
  changes: Partial<TaskMutableFields>;
}

export interface TaskCreateInput extends Partial<TaskMutableFields> {
  task_id?: string;
}

export interface TaskListSnapshot {
  tasks: readonly TaskRecord[];
  revision?: string;
  taskCount: number;
}

export interface TaskMutationResult {
  changedTaskIds: readonly string[];
  revision?: string;
}

export interface TasksSearchResult {
  matches: readonly TaskRecord[];
  totalCount: number;
}
