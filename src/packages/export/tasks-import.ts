import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { normalizeString, parseJsonlRows, readJsonlRows } from "./jsonl";
import { loadExportBundleSource } from "./read-bundle";

export interface TaskImportOptions {
  sourcePath: string;
  targetPath?: string;
  dryRun?: boolean;
}

interface TaskRow {
  task_id: string;
  desc?: string;
  position?: number;
  last_edited?: number;
  due_date?: number;
  done?: boolean;
  deleted?: boolean;
  color?: string;
  hideBody?: boolean;
}

interface ExportTaskRow {
  event?: string;
  message_kind?: string;
  task_id?: string;
  timestamp?: string;
  due_at?: string;
  content?: string;
  content_format?: string;
  done?: boolean;
  deleted?: boolean;
  position?: number;
  hashtags?: string[];
  color?: string;
  hide_body?: boolean;
}

type ConflictRecord = {
  task_id: string;
  reason: string;
  fields?: string[];
};

export interface TaskImportResult {
  target_path: string;
  created: number;
  updated: number;
  unchanged: number;
  preserved: number;
  conflict_count: number;
  conflicts: ConflictRecord[];
  task_count: number;
  dry_run: boolean;
}

export async function importTaskBundle(
  options: TaskImportOptions,
): Promise<TaskImportResult> {
  const source = await loadExportBundleSource(resolve(options.sourcePath));
  if (source.manifest.kind !== "tasks") {
    throw new Error(
      `expected a tasks export bundle, got kind=${JSON.stringify(source.manifest.kind)}`,
    );
  }
  const rawTargetPath =
    normalizeString(options.targetPath) ??
    normalizeString(source.manifest?.source?.path);
  if (!rawTargetPath) {
    throw new Error(
      "unable to determine import target; pass --target explicitly",
    );
  }
  const targetPath = resolve(rawTargetPath);

  const baseRows = parseJsonlRows(
    await source.readText("document.jsonl"),
    "document.jsonl",
  )
    .filter(isTaskRow)
    .map(normalizeTaskRow);
  const desiredRows = parseJsonlRows(
    await source.readText("tasks.jsonl"),
    "tasks.jsonl",
  )
    .filter(isExportTaskRow)
    .map(normalizeExportTaskRow);

  rejectLocalAssetRefs(
    baseRows.map((row) => row.desc),
    "document.jsonl",
  );
  rejectLocalAssetRefs(
    desiredRows.map((row) => row.content),
    "tasks.jsonl",
  );

  let currentRows: TaskRow[] = [];
  try {
    currentRows = (await readJsonlRows(targetPath))
      .filter(isTaskRow)
      .map(normalizeTaskRow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("ENOENT")) {
      throw err;
    }
  }

  const baseMap = new Map(baseRows.map((row) => [row.task_id, row]));
  const currentMap = new Map(currentRows.map((row) => [row.task_id, row]));
  const touched = new Set<string>();
  const now = Date.now();
  let nextAppendPosition = determineNextPosition(currentRows);

  const nextMap = new Map(currentRows.map((row) => [row.task_id, { ...row }]));
  const conflicts: ConflictRecord[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const desired of desiredRows) {
    const taskId = normalizeString(desired.task_id) ?? randomUUID();
    const base = baseMap.get(taskId);
    const current = currentMap.get(taskId);
    const desiredNative = toDesiredNativeRow(desired, taskId, {
      base,
      current,
      nextAppendPosition,
    });
    if (desiredNative.position == null) {
      desiredNative.position = nextAppendPosition;
      nextAppendPosition += 1;
    } else if (desiredNative.position >= nextAppendPosition) {
      nextAppendPosition = desiredNative.position + 1;
    }

    const mergePlan = planTaskMerge(taskId, base, current, desiredNative);
    if (mergePlan.type === "conflict") {
      conflicts.push(mergePlan.conflict);
      continue;
    }
    if (mergePlan.type === "skip") {
      touched.add(taskId);
      unchanged += 1;
      continue;
    }
    if (mergePlan.type === "keep-current") {
      touched.add(taskId);
      nextMap.set(taskId, mergePlan.row);
      unchanged += 1;
      continue;
    }

    touched.add(taskId);
    if (mergePlan.type === "create") {
      nextMap.set(taskId, {
        ...mergePlan.row,
        task_id: taskId,
        last_edited: now,
      });
      created += 1;
      continue;
    }

    if (mergePlan.type !== "update") {
      throw new Error(`unsupported task merge plan ${(mergePlan as any).type}`);
    }

    nextMap.set(taskId, {
      ...mergePlan.row,
      task_id: taskId,
      last_edited: now,
    });
    updated += 1;
  }

  const preserved = Array.from(currentMap.keys()).filter(
    (taskId) => !touched.has(taskId),
  ).length;
  const mergedRows = Array.from(nextMap.values()).sort(compareTasks);

  const result: TaskImportResult = {
    target_path: targetPath,
    created,
    updated,
    unchanged,
    preserved,
    conflict_count: conflicts.length,
    conflicts,
    task_count: mergedRows.length,
    dry_run: options.dryRun === true,
  };

  if (conflicts.length > 0) {
    if (options.dryRun === true) {
      return result;
    }
    const sample = conflicts
      .slice(0, 5)
      .map((conflict) => `${conflict.task_id}:${conflict.reason}`)
      .join(", ");
    throw new Error(
      `refusing to import tasks due to ${conflicts.length} conflicting task updates (${sample})`,
    );
  }

  if (options.dryRun !== true) {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(
      targetPath,
      `${mergedRows.map((row) => JSON.stringify(serializeTaskRow(row))).join("\n")}\n`,
      "utf8",
    );
  }

  return result;
}

function isTaskRow(row: any): row is TaskRow {
  return typeof normalizeString(row?.task_id) === "string";
}

function isExportTaskRow(row: any): row is ExportTaskRow {
  return row != null && typeof row === "object" && row.event === "task";
}

function normalizeTaskRow(row: TaskRow): TaskRow {
  return {
    task_id: normalizeString(row.task_id) ?? "",
    desc: `${row.desc ?? ""}`,
    position:
      typeof row.position === "number" && Number.isFinite(row.position)
        ? row.position
        : undefined,
    last_edited:
      typeof row.last_edited === "number" && Number.isFinite(row.last_edited)
        ? row.last_edited
        : undefined,
    due_date:
      typeof row.due_date === "number" && Number.isFinite(row.due_date)
        ? row.due_date
        : undefined,
    done: row.done === true,
    deleted: row.deleted === true,
    color: normalizeString(row.color),
    hideBody: row.hideBody === true,
  };
}

function normalizeExportTaskRow(row: ExportTaskRow): ExportTaskRow {
  return {
    event: "task",
    message_kind: "task",
    task_id: normalizeString(row.task_id),
    timestamp: normalizeString(row.timestamp),
    due_at: normalizeString(row.due_at),
    content: `${row.content ?? ""}`,
    content_format: "markdown",
    done: row.done === true,
    deleted: row.deleted === true,
    position:
      typeof row.position === "number" && Number.isFinite(row.position)
        ? row.position
        : undefined,
    color: normalizeString(row.color),
    hide_body: row.hide_body === true,
  };
}

function toDesiredNativeRow(
  row: ExportTaskRow,
  taskId: string,
  context: {
    base?: TaskRow;
    current?: TaskRow;
    nextAppendPosition: number;
  },
): TaskRow {
  return {
    task_id: taskId,
    desc: `${row.content ?? ""}`,
    position:
      typeof row.position === "number"
        ? row.position
        : (context.base?.position ?? context.current?.position),
    due_date: parseIsoToMs(row.due_at),
    done: row.done === true,
    deleted: row.deleted === true,
    color: normalizeString(row.color),
    hideBody: row.hide_body === true,
    last_edited: context.current?.last_edited ?? context.base?.last_edited,
  };
}

function parseIsoToMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.valueOf() : undefined;
}

type TaskMergePlan =
  | { type: "conflict"; conflict: ConflictRecord }
  | { type: "skip" }
  | { type: "keep-current"; row: TaskRow }
  | { type: "create"; row: TaskRow }
  | { type: "update"; row: TaskRow };

function planTaskMerge(
  taskId: string,
  base: TaskRow | undefined,
  current: TaskRow | undefined,
  desired: TaskRow,
): TaskMergePlan {
  if (base == null) {
    if (current != null && !taskSnapshotEqual(current, desired)) {
      return {
        type: "conflict",
        conflict: { task_id: taskId, reason: "id_collision" },
      };
    }
    if (current != null) {
      return { type: "keep-current", row: current };
    }
    return { type: "create", row: desired };
  }

  if (current == null) {
    if (taskSnapshotEqual(base, desired)) {
      return { type: "skip" };
    }
    return {
      type: "conflict",
      conflict: { task_id: taskId, reason: "missing_in_target" },
    };
  }

  const fields = conflictingFields(base, current, desired);
  if (fields.length > 0) {
    return {
      type: "conflict",
      conflict: { task_id: taskId, reason: "concurrent_edit", fields },
    };
  }
  if (taskSnapshotEqual(base, desired) || taskSnapshotEqual(current, desired)) {
    return { type: "keep-current", row: current };
  }
  return { type: "update", row: mergeTaskRows(base, current, desired) };
}

function conflictingFields(
  base: TaskRow,
  current: TaskRow,
  desired: TaskRow,
): string[] {
  const fields: string[] = [];
  for (const field of MANAGED_FIELDS) {
    const baseValue = snapshotField(base, field);
    const currentValue = snapshotField(current, field);
    const desiredValue = snapshotField(desired, field);
    const currentChanged = !fieldValueEqual(baseValue, currentValue);
    const desiredChanged = !fieldValueEqual(baseValue, desiredValue);
    if (
      currentChanged &&
      desiredChanged &&
      !fieldValueEqual(currentValue, desiredValue)
    ) {
      fields.push(field);
    }
  }
  return fields;
}

const MANAGED_FIELDS = [
  "desc",
  "position",
  "due_date",
  "done",
  "deleted",
  "color",
  "hideBody",
] as const;

type ManagedField = (typeof MANAGED_FIELDS)[number];

function snapshotField(row: TaskRow, field: ManagedField): unknown {
  return row[field];
}

function taskSnapshotEqual(a: TaskRow, b: TaskRow): boolean {
  return MANAGED_FIELDS.every((field) =>
    fieldValueEqual(snapshotField(a, field), snapshotField(b, field)),
  );
}

function mergeTaskRows(
  base: TaskRow,
  current: TaskRow,
  desired: TaskRow,
): TaskRow {
  const merged: TaskRow = { ...current };
  for (const field of MANAGED_FIELDS) {
    const baseValue = snapshotField(base, field);
    const desiredValue = snapshotField(desired, field);
    const desiredChanged = !fieldValueEqual(baseValue, desiredValue);
    if (desiredChanged) {
      merged[field] = desired[field] as any;
    }
  }
  return merged;
}

function fieldValueEqual(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  return a === b;
}

function determineNextPosition(rows: TaskRow[]): number {
  const positions = rows
    .map((row) => row.position)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  if (positions.length === 0) return 0;
  return Math.max(...positions) + 1;
}

function compareTasks(a: TaskRow, b: TaskRow): number {
  const posA =
    typeof a.position === "number" ? a.position : Number.POSITIVE_INFINITY;
  const posB =
    typeof b.position === "number" ? b.position : Number.POSITIVE_INFINITY;
  if (posA !== posB) return posA - posB;
  const editedA = typeof a.last_edited === "number" ? a.last_edited : 0;
  const editedB = typeof b.last_edited === "number" ? b.last_edited : 0;
  if (editedA !== editedB) return editedA - editedB;
  return a.task_id.localeCompare(b.task_id);
}

function rejectLocalAssetRefs(
  values: Array<string | undefined>,
  fileName: string,
): void {
  for (const value of values) {
    if (value != null && /(^|[(/"\s])assets\/[A-Za-z0-9._-]+/.test(value)) {
      throw new Error(
        `tasks import does not yet support rebinding local exported assets (${fileName} contains assets/ references)`,
      );
    }
  }
}

function serializeTaskRow(row: TaskRow): TaskRow {
  return {
    task_id: row.task_id,
    ...(row.desc != null ? { desc: row.desc } : {}),
    ...(typeof row.position === "number" ? { position: row.position } : {}),
    ...(typeof row.last_edited === "number"
      ? { last_edited: row.last_edited }
      : {}),
    ...(typeof row.due_date === "number" ? { due_date: row.due_date } : {}),
    ...(row.done === true ? { done: true } : {}),
    ...(row.deleted === true ? { deleted: true } : {}),
    ...(row.color ? { color: row.color } : {}),
    ...(row.hideBody === true ? { hideBody: true } : {}),
  };
}
