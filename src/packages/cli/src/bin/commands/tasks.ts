import { Command } from "commander";

import type {
  TaskMutableFields,
  TaskQuery,
  TaskSortColumn,
  TaskSortDirection,
} from "@cocalc/app-tasks";

export type TasksCommandDeps = {
  withContext: any;
  workspaceTasksListData: any;
  workspaceTasksGetData: any;
  workspaceTasksSetDoneData: any;
  workspaceTasksAppendData: any;
  workspaceTasksUpdateData: any;
  workspaceTasksAddData: any;
};

type TasksListCliOptions = {
  workspace?: string;
  includeDone?: boolean;
  includeDeleted?: boolean;
  search?: string;
  limit?: string;
  sort?: string;
  dir?: string;
};

type TasksGetCliOptions = {
  workspace?: string;
  taskId?: string;
};

type TasksSetDoneCliOptions = {
  workspace?: string;
  taskId?: string;
  done?: string;
};

type TasksAppendCliOptions = {
  workspace?: string;
  taskId?: string;
  text?: string;
};

type TasksUpdateCliOptions = {
  workspace?: string;
  taskId?: string;
  desc?: string;
  due?: string;
  color?: string;
  position?: string;
  hideBody?: string;
  deleted?: string;
};

type TasksAddCliOptions = {
  workspace?: string;
  desc?: string;
  due?: string;
  color?: string;
  position?: string;
  hideBody?: string;
  done?: string;
  deleted?: string;
};

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

Paths are workspace-relative. If --workspace is omitted, the command uses:

1. COCALC_PROJECT_ID, if set
2. the current workspace context from 'cocalc ws use'
`,
    );

  tasks
    .command("list <path>")
    .description("list tasks from a live .tasks document")
    .option(
      "--workspace <workspace>",
      "workspace id/title (defaults to COCALC_PROJECT_ID or current workspace context)",
    )
    .option("--include-done", "include done tasks")
    .option("--include-deleted", "include deleted tasks")
    .option("--search <text>", "filter tasks by search text")
    .option("--limit <n>", "limit results")
    .option("--sort <column>", "sort column (Custom|Due|Changed)")
    .option("--dir <direction>", "sort direction (asc|desc)")
    .action(async (path: string, opts: TasksListCliOptions, command: Command) => {
      await deps.withContext(command, "tasks list", async (ctx) => {
        const query: TaskQuery = {
          includeDone: opts.includeDone === true,
          includeDeleted: opts.includeDeleted === true,
          search: opts.search?.trim() || undefined,
          limit: parseOptionalNumber(opts.limit, "--limit"),
          sort: parseSort(opts.sort, opts.dir),
        };
        return await deps.workspaceTasksListData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
          query,
        });
      });
    });

  tasks
    .command("get <path>")
    .description("fetch one task by id from a live .tasks document")
    .requiredOption("--task-id <taskId>", "task id")
    .option(
      "--workspace <workspace>",
      "workspace id/title (defaults to COCALC_PROJECT_ID or current workspace context)",
    )
    .action(async (path: string, opts: TasksGetCliOptions, command: Command) => {
      await deps.withContext(command, "tasks get", async (ctx) => {
        return await deps.workspaceTasksGetData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
          taskId: requireTaskId(opts.taskId),
        });
      });
    });

  tasks
    .command("set-done <path>")
    .description("mark a task done or not done through the live tasks session")
    .requiredOption("--task-id <taskId>", "task id")
    .option("--done <bool>", "true or false", "true")
    .option(
      "--workspace <workspace>",
      "workspace id/title (defaults to COCALC_PROJECT_ID or current workspace context)",
    )
    .action(async (path: string, opts: TasksSetDoneCliOptions, command: Command) => {
      await deps.withContext(command, "tasks set-done", async (ctx) => {
        return await deps.workspaceTasksSetDoneData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
          taskId: requireTaskId(opts.taskId),
          done: parseOptionalBoolean(opts.done) ?? true,
        });
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
      "--workspace <workspace>",
      "workspace id/title (defaults to COCALC_PROJECT_ID or current workspace context)",
    )
    .action(async (path: string, opts: TasksAppendCliOptions, command: Command) => {
      await deps.withContext(command, "tasks append", async (ctx) => {
        const text = `${opts.text ?? ""}`;
        if (!text.trim()) {
          throw new Error("--text is required");
        }
        return await deps.workspaceTasksAppendData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
          taskId: requireTaskId(opts.taskId),
          text,
        });
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
      "--workspace <workspace>",
      "workspace id/title (defaults to COCALC_PROJECT_ID or current workspace context)",
    )
    .action(async (path: string, opts: TasksUpdateCliOptions, command: Command) => {
      await deps.withContext(command, "tasks update", async (ctx) => {
        const changes = buildUpdateChanges(opts);
        assertHasUpdates(changes);
        return await deps.workspaceTasksUpdateData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
          taskId: requireTaskId(opts.taskId),
          changes,
        });
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
      "--workspace <workspace>",
      "workspace id/title (defaults to COCALC_PROJECT_ID or current workspace context)",
    )
    .action(async (path: string, opts: TasksAddCliOptions, command: Command) => {
      await deps.withContext(command, "tasks add", async (ctx) => {
        return await deps.workspaceTasksAddData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
          input: buildCreateInput(opts),
        });
      });
    });

  return tasks;
}
