import type {
  TaskCreateInput,
  TaskListSnapshot,
  TaskMutationResult,
  TaskMutableFields,
  TaskPatch,
  TaskQuery,
  TaskRecord,
  TaskSortSpec,
  TasksSearchResult,
} from "./contracts/model";

const LAST_EDITED_THRESHOLD_MS = 30 * 1000;

export interface TaskMutationOptions {
  now?: number;
  lastEditedThresholdMs?: number;
}

export interface TaskOperationResult extends TaskMutationResult {
  snapshot: TaskListSnapshot;
}

export interface TaskCreateResult extends TaskOperationResult {
  task: TaskRecord;
}

export function createTaskSnapshot(
  tasks: readonly TaskRecord[],
  revision?: string,
): TaskListSnapshot {
  const ordered = orderTasks(tasks);
  return {
    tasks: ordered,
    revision,
    taskCount: ordered.length,
  };
}

export function orderTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort(compareTaskOrder);
}

export function getTask(
  snapshot: TaskListSnapshot,
  taskId: string,
): TaskRecord | undefined {
  return snapshot.tasks.find((task) => task.task_id === taskId);
}

export function listTasks(
  snapshot: TaskListSnapshot,
  query?: TaskQuery,
): TaskListSnapshot {
  const filtered = applyQuery(snapshot.tasks, query);
  return {
    tasks: filtered,
    revision: snapshot.revision,
    taskCount: filtered.length,
  };
}

export function searchTasks(
  snapshot: TaskListSnapshot,
  query: TaskQuery,
): TasksSearchResult {
  const matches = applyQuery(snapshot.tasks, query);
  return {
    matches,
    totalCount: matches.length,
  };
}

export function createTask(
  snapshot: TaskListSnapshot,
  input: TaskCreateInput = {},
  options: TaskMutationOptions = {},
): TaskCreateResult {
  const now = options.now ?? Date.now();
  const task: TaskRecord = {
    task_id: input.task_id ?? createTaskId(),
    position: input.position ?? getTopPosition(snapshot.tasks),
    desc: input.desc ?? "",
    ...input,
  };
  if (task.last_edited == null && shouldTouchLastEdited({}, task)) {
    task.last_edited = now;
  }
  const nextSnapshot = createTaskSnapshot([...snapshot.tasks, task], snapshot.revision);
  return {
    snapshot: nextSnapshot,
    task,
    changedTaskIds: [task.task_id],
    revision: snapshot.revision,
  };
}

export function patchTasks(
  snapshot: TaskListSnapshot,
  patches: readonly TaskPatch[],
  options: TaskMutationOptions = {},
): TaskOperationResult {
  const byId = new Map(snapshot.tasks.map((task) => [task.task_id, task]));
  const changedTaskIds = new Set<string>();

  for (const patch of patches) {
    const current = byId.get(patch.task_id);
    if (current == null) {
      throw new Error(`Task "${patch.task_id}" not found`);
    }
    const next = applyTaskChanges(current, patch.changes, options);
    if (next !== current) {
      byId.set(patch.task_id, next);
      changedTaskIds.add(patch.task_id);
    }
  }

  return {
    snapshot: createTaskSnapshot([...byId.values()], snapshot.revision),
    changedTaskIds: [...changedTaskIds],
    revision: snapshot.revision,
  };
}

export function updateTask(
  snapshot: TaskListSnapshot,
  taskId: string,
  changes: Partial<TaskMutableFields>,
  options: TaskMutationOptions = {},
): TaskOperationResult {
  return patchTasks(snapshot, [{ task_id: taskId, changes }], options);
}

export function setTaskDone(
  snapshot: TaskListSnapshot,
  taskId: string,
  done: boolean,
  options: TaskMutationOptions = {},
): TaskOperationResult {
  return updateTask(snapshot, taskId, { done }, options);
}

export function appendToDescription(
  snapshot: TaskListSnapshot,
  taskId: string,
  text: string,
  options: TaskMutationOptions = {},
): TaskOperationResult {
  const task = getTask(snapshot, taskId);
  if (task == null) {
    throw new Error(`Task "${taskId}" not found`);
  }
  const current = task.desc ?? "";
  const nextDesc = appendMarkdownText(current, text);
  return updateTask(snapshot, taskId, { desc: nextDesc }, options);
}

function applyQuery(
  tasks: readonly TaskRecord[],
  query?: TaskQuery,
): TaskRecord[] {
  const selectedHashtags = query?.selectedHashtags ?? {};
  const searchTerms = splitSearch(query?.search);
  const filtered = tasks.filter((task) =>
    matchesQuery(task, query, selectedHashtags, searchTerms),
  );
  const sorted = sortTasks(filtered, query?.sort);
  if (query?.limit != null && query.limit >= 0) {
    return sorted.slice(0, query.limit);
  }
  return sorted;
}

function matchesQuery(
  task: TaskRecord,
  query: TaskQuery | undefined,
  selectedHashtags: Readonly<Record<string, -1 | 1>>,
  searchTerms: readonly string[],
): boolean {
  if (!query?.includeDeleted && task.deleted) return false;
  if (!query?.includeDone && task.done) return false;

  const desc = (task.desc ?? "").toLowerCase();
  for (const term of searchTerms) {
    if (!desc.includes(term)) return false;
  }

  if (Object.keys(selectedHashtags).length > 0) {
    const tags = extractHashtags(desc);
    for (const [tag, state] of Object.entries(selectedHashtags)) {
      const hasTag = tags.has(tag.toLowerCase());
      if (state === 1 && !hasTag) return false;
      if (state === -1 && hasTag) return false;
    }
  }

  return true;
}

function sortTasks(
  tasks: readonly TaskRecord[],
  sort?: TaskSortSpec,
): TaskRecord[] {
  if (sort == null) {
    return orderTasks(tasks);
  }
  const sorted = [...tasks];
  sorted.sort((left, right) => {
    const cmp = compareBySort(left, right, sort);
    if (cmp !== 0) return cmp;
    return compareTaskOrder(left, right);
  });
  return sorted;
}

function compareBySort(
  left: TaskRecord,
  right: TaskRecord,
  sort: TaskSortSpec,
): number {
  const direction = sort.dir === "desc" ? -1 : 1;
  switch (sort.column) {
    case "Custom":
      return compareTaskOrder(left, right) * direction;
    case "Due":
      return compareNullableNumber(left.due_date, right.due_date) * direction;
    case "Changed":
      return (
        compareNullableNumber(left.last_edited, right.last_edited) * direction
      );
    default:
      return 0;
  }
}

function compareTaskOrder(left: TaskRecord, right: TaskRecord): number {
  const positionCmp = compareNullableNumber(left.position, right.position);
  if (positionCmp !== 0) return positionCmp;
  return left.task_id.localeCompare(right.task_id);
}

function compareNullableNumber(
  left: number | undefined,
  right: number | undefined,
): number {
  const a = left ?? Number.POSITIVE_INFINITY;
  const b = right ?? Number.POSITIVE_INFINITY;
  return a < b ? -1 : a > b ? 1 : 0;
}

function splitSearch(search?: string): string[] {
  return (search ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function extractHashtags(desc: string): Set<string> {
  const tags = new Set<string>();
  const matches = desc.matchAll(/(^|\s)#([^\s#]+)/g);
  for (const match of matches) {
    const tag = match[2]?.trim().toLowerCase();
    if (tag) tags.add(tag);
  }
  return tags;
}

function getTopPosition(tasks: readonly TaskRecord[]): number {
  if (tasks.length === 0) return 0;
  const min = tasks.reduce((value, task) => {
    if (task.position == null) return value;
    return Math.min(value, task.position);
  }, Number.POSITIVE_INFINITY);
  return Number.isFinite(min) ? min - 1 : 0;
}

function applyTaskChanges(
  task: TaskRecord,
  changes: Partial<TaskMutableFields>,
  options: TaskMutationOptions,
): TaskRecord {
  const next = { ...task, ...changes };
  if (shouldTouchLastEdited(task, next)) {
    const now = options.now ?? Date.now();
    const threshold = options.lastEditedThresholdMs ?? LAST_EDITED_THRESHOLD_MS;
    if (
      next.last_edited == null ||
      now - next.last_edited >= threshold ||
      task.last_edited == null
    ) {
      next.last_edited = now;
    }
  }
  return shallowEqualTask(task, next) ? task : next;
}

function shouldTouchLastEdited(
  before: Partial<TaskRecord>,
  after: Partial<TaskRecord>,
): boolean {
  return (
    before.desc !== after.desc ||
    before.due_date !== after.due_date ||
    before.done !== after.done
  );
}

function appendMarkdownText(desc: string, text: string): string {
  if (!text.trim()) return desc;
  if (!desc.trim()) return text;
  if (desc.endsWith("\n\n")) return `${desc}${text}`;
  if (desc.endsWith("\n")) return `${desc}\n${text}`;
  return `${desc}\n\n${text}`;
}

function shallowEqualTask(left: TaskRecord, right: TaskRecord): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function createTaskId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
