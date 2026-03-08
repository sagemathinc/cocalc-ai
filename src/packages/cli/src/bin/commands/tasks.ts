import { Command } from "commander";

import type {
  TaskMutableFields,
  TaskQuery,
  TaskRecord,
  TaskSortColumn,
  TaskSortDirection,
} from "@cocalc/app-tasks";
import type { TasksApi } from "../../api/tasks";

export type TasksCommandDeps = {
  withContext: any;
  tasksApi: TasksApi<any, any>;
};

type TasksListCliOptions = {
  project?: string;
  includeDone?: boolean;
  includeDeleted?: boolean;
  search?: string;
  limit?: string;
  sort?: string;
  dir?: string;
};

type TasksGetCliOptions = {
  project?: string;
  taskId?: string;
};

type TasksSetDoneCliOptions = {
  project?: string;
  taskId?: string;
  done?: string;
};

type TasksAppendCliOptions = {
  project?: string;
  taskId?: string;
  text?: string;
};

type TasksUpdateCliOptions = {
  project?: string;
  taskId?: string;
  desc?: string;
  due?: string;
  color?: string;
  position?: string;
  hideBody?: string;
  deleted?: string;
};

type TasksAddCliOptions = {
  project?: string;
  desc?: string;
  due?: string;
  color?: string;
  position?: string;
  hideBody?: string;
  done?: string;
  deleted?: string;
};

function compactTaskRecord(task: TaskRecord): Record<string, unknown> {
  return {
    task_id: task.task_id,
    done: task.done === true,
    deleted: task.deleted === true,
    due_date: task.due_date ?? null,
    last_edited: task.last_edited ?? null,
    color: task.color ?? null,
    hideBody: task.hideBody === true,
    desc: task.desc ?? "",
  };
}

const TASK_SORT_COLUMNS: TaskSortColumn[] = ["Custom", "Due", "Changed"];
const TASK_SORT_DIRECTIONS: TaskSortDirection[] = ["asc", "desc"];

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`invalid boolean value '${value}'`);
}

function parseOptionalNumber(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be numeric`);
  }
  return parsed;
}

function parseOptionalDueDate(value: string | undefined): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const raw = value.trim();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `invalid --due '${value}'; use an epoch milliseconds value or parseable date string`,
    );
  }
  return timestamp;
}

function parseSort(
  column?: string,
  dir?: string,
): TaskQuery["sort"] | undefined {
  if (!column && !dir) return undefined;
  const resolvedColumn = (column?.trim() || "Custom") as TaskSortColumn;
  if (!TASK_SORT_COLUMNS.includes(resolvedColumn)) {
    throw new Error(
      `invalid --sort '${column}'; expected one of ${TASK_SORT_COLUMNS.join(", ")}`,
    );
  }
  const resolvedDir = (dir?.trim().toLowerCase() || "asc") as TaskSortDirection;
  if (!TASK_SORT_DIRECTIONS.includes(resolvedDir)) {
    throw new Error(
      `invalid --dir '${dir}'; expected one of ${TASK_SORT_DIRECTIONS.join(", ")}`,
    );
  }
  return {
    column: resolvedColumn,
    dir: resolvedDir,
  };
}

function requireTaskId(taskId: string | undefined): string {
  const resolved = `${taskId ?? ""}`.trim();
  if (!resolved) {
    throw new Error("--task-id is required");
  }
  return resolved;
}

function assertHasUpdates(changes: Partial<TaskMutableFields>): void {
  if (Object.keys(changes).length === 0) {
    throw new Error("no task updates specified");
  }
}

function buildUpdateChanges(opts: TasksUpdateCliOptions): Partial<TaskMutableFields> {
  const changes: Partial<TaskMutableFields> = {};
  if (opts.desc != null) changes.desc = opts.desc;
  if (opts.due != null) changes.due_date = parseOptionalDueDate(opts.due);
  if (opts.color != null) changes.color = opts.color;
  if (opts.position != null) {
    changes.position = parseOptionalNumber(opts.position, "--position");
  }
  if (opts.hideBody != null) {
    changes.hideBody = parseOptionalBoolean(opts.hideBody);
  }
  if (opts.deleted != null) {
    changes.deleted = parseOptionalBoolean(opts.deleted);
  }
  return changes;
}

function buildCreateInput(opts: TasksAddCliOptions): Partial<TaskMutableFields> {
  const input: Partial<TaskMutableFields> = {};
  if (opts.desc != null) input.desc = opts.desc;
  if (opts.due != null) input.due_date = parseOptionalDueDate(opts.due);
  if (opts.color != null) input.color = opts.color;
  if (opts.position != null) {
    input.position = parseOptionalNumber(opts.position, "--position");
  }
  if (opts.hideBody != null) {
    input.hideBody = parseOptionalBoolean(opts.hideBody);
  }
  if (opts.done != null) {
    input.done = parseOptionalBoolean(opts.done);
  }
  if (opts.deleted != null) {
    input.deleted = parseOptionalBoolean(opts.deleted);
  }
  return input;
}

export function registerTasksCommand(program: Command, deps: TasksCommandDeps): Command {
  const tasks = program
    .command("tasks")
    .description("edit .tasks documents through a live collaborative session")
    .addHelpText(
      "after",
      `
These commands operate against the live sync session for a .tasks document.

- They participate in CoCalc's realtime collaboration model instead of rewriting the file on disk.
- They are intended as the fast path for focused task edits by humans and agents.
- They complement export/import: use export/import for bulk transformations, and tasks commands for targeted edits.

Paths may be absolute or project-relative. Relative paths resolve against $HOME. If --project is omitted, the command uses:

1. COCALC_PROJECT_ID, if set
2. the current project context from 'cocalc project use'
`,
    );

  tasks
    .command("list <path>")
    .description("list tasks from a live .tasks document")
    .option(
      "--project <project>",
      "project id/title (defaults to COCALC_PROJECT_ID or current project context)",
    )
    .option("--include-done", "include done tasks")
    .option("--include-deleted", "include deleted tasks")
    .option("--search <text>", "filter tasks by search text")
    .option("--limit <n>", "limit results")
    .option("--sort <column>", "sort column (Custom|Due|Changed)")
    .option("--dir <direction>", "sort direction (asc|desc)")
    .action(async (path: string, opts: TasksListCliOptions, command: Command) => {
      await deps.withContext(command, "tasks list", async (ctx) => {
        const doc = deps.tasksApi.bindDocument(ctx, {
          projectIdentifier: opts.project,
          path,
        });
        const query: TaskQuery = {
          includeDone: opts.includeDone === true,
          includeDeleted: opts.includeDeleted === true,
          search: opts.search?.trim() || undefined,
          limit: parseOptionalNumber(opts.limit, "--limit"),
          sort: parseSort(opts.sort, opts.dir),
        };
        const snapshot = await doc.getSnapshot(query);
        return snapshot.tasks.map(compactTaskRecord);
      });
    });

  tasks
    .command("get <path>")
    .description("fetch one task by id from a live .tasks document")
    .requiredOption("--task-id <taskId>", "task id")
    .option(
      "--project <project>",
      "project id/title (defaults to COCALC_PROJECT_ID or current project context)",
    )
    .action(async (path: string, opts: TasksGetCliOptions, command: Command) => {
      await deps.withContext(command, "tasks get", async (ctx) => {
        const doc = deps.tasksApi.bindDocument(ctx, {
          projectIdentifier: opts.project,
          path,
        });
        const result = await doc.getTask(requireTaskId(opts.taskId));
        if (!result.task) {
          throw new Error(`Task '${requireTaskId(opts.taskId)}' not found`);
        }
        return {
          project_id: result.project.project_id,
          path: result.path,
          task: compactTaskRecord(result.task),
        };
      });
    });

  tasks
    .command("set-done <path>")
    .description("mark a task done or not done through the live tasks session")
    .requiredOption("--task-id <taskId>", "task id")
    .option("--done <bool>", "true or false", "true")
    .option(
      "--project <project>",
      "project id/title (defaults to COCALC_PROJECT_ID or current project context)",
    )
    .action(async (path: string, opts: TasksSetDoneCliOptions, command: Command) => {
      await deps.withContext(command, "tasks set-done", async (ctx) => {
        const taskId = requireTaskId(opts.taskId);
        const doc = deps.tasksApi.bindDocument(ctx, {
          projectIdentifier: opts.project,
          path,
        });
        const result = await doc.setDone(taskId, parseOptionalBoolean(opts.done) ?? true);
        return {
          project_id: result.project.project_id,
          path: result.path,
          task_id: taskId,
          changed_task_ids: result.changedTaskIds,
          revision: result.revision ?? null,
          task: result.task ? compactTaskRecord(result.task) : null,
        };
      });
    });

  tasks
    .command("append <path>")
    .description(
      "append markdown text to a task description through the live tasks session",
    )
    .requiredOption("--task-id <taskId>", "task id")
    .requiredOption("--text <text>", "markdown text to append")
    .option(
      "--project <project>",
      "project id/title (defaults to COCALC_PROJECT_ID or current project context)",
    )
    .action(async (path: string, opts: TasksAppendCliOptions, command: Command) => {
      await deps.withContext(command, "tasks append", async (ctx) => {
        const taskId = requireTaskId(opts.taskId);
        const text = `${opts.text ?? ""}`;
        if (!text.trim()) {
          throw new Error("--text is required");
        }
        const doc = deps.tasksApi.bindDocument(ctx, {
          projectIdentifier: opts.project,
          path,
        });
        const result = await doc.appendToDescription(taskId, text);
        return {
          project_id: result.project.project_id,
          path: result.path,
          task_id: taskId,
          changed_task_ids: result.changedTaskIds,
          revision: result.revision ?? null,
          task: result.task ? compactTaskRecord(result.task) : null,
        };
      });
    });

  tasks
    .command("update <path>")
    .description("update selected fields on a task through the live tasks session")
    .requiredOption("--task-id <taskId>", "task id")
    .option("--desc <markdown>", "replace the task description")
    .option(
      "--due <dateOrEpoch>",
      "set due date (epoch ms or parseable date string)",
    )
    .option("--color <color>", "set color")
    .option("--position <n>", "set explicit position")
    .option("--hide-body <bool>", "set hideBody true/false")
    .option("--deleted <bool>", "set deleted true/false")
    .option(
      "--project <project>",
      "project id/title (defaults to COCALC_PROJECT_ID or current project context)",
    )
    .action(async (path: string, opts: TasksUpdateCliOptions, command: Command) => {
      await deps.withContext(command, "tasks update", async (ctx) => {
        const taskId = requireTaskId(opts.taskId);
        const changes = buildUpdateChanges(opts);
        assertHasUpdates(changes);
        const doc = deps.tasksApi.bindDocument(ctx, {
          projectIdentifier: opts.project,
          path,
        });
        const result = await doc.updateTask(taskId, changes);
        return {
          project_id: result.project.project_id,
          path: result.path,
          task_id: taskId,
          changed_task_ids: result.changedTaskIds,
          revision: result.revision ?? null,
          task: result.task ? compactTaskRecord(result.task) : null,
        };
      });
    });

  tasks
    .command("add <path>")
    .description("add a task through the live tasks session")
    .option("--desc <markdown>", "initial markdown description", "")
    .option(
      "--due <dateOrEpoch>",
      "set due date (epoch ms or parseable date string)",
    )
    .option("--color <color>", "set color")
    .option("--position <n>", "set explicit position")
    .option("--hide-body <bool>", "set hideBody true/false")
    .option("--done <bool>", "set done true/false")
    .option("--deleted <bool>", "set deleted true/false")
    .option(
      "--project <project>",
      "project id/title (defaults to COCALC_PROJECT_ID or current project context)",
    )
    .action(async (path: string, opts: TasksAddCliOptions, command: Command) => {
      await deps.withContext(command, "tasks add", async (ctx) => {
        const doc = deps.tasksApi.bindDocument(ctx, {
          projectIdentifier: opts.project,
          path,
        });
        const result = await doc.createTask(buildCreateInput(opts));
        return {
          project_id: result.project.project_id,
          path: result.path,
          task: compactTaskRecord(result.task),
        };
      });
    });

  return tasks;
}
