import { readFile } from "node:fs/promises";
import { Command } from "commander";

import type { ExportApi } from "../../api/export";
import type { ImportApi } from "../../api/import";
import type { TasksApi } from "../../api/tasks";
import type { TextApi } from "../../api/text";
import type { TimeTravelApi } from "../../api/timetravel";

export type ExecCommandDeps = {
  withContext: any;
  tasksApi: TasksApi<any, any>;
  textApi: TextApi<any, any>;
  timeTravelApi: TimeTravelApi<any, any>;
  exportApi: ExportApi<any>;
  importApi: ImportApi<any>;
};

const BACKEND_EXEC_API_DECLARATION = `/**
 * CoCalc backend exec API.
 *
 * Current implemented namespaces:
 * - api.tasks
 * - api.text
 * - api.timetravel
 * - api.export
 * - api.import
 *
 * Return only JSON-serializable values from scripts.
 *
 * Example:
 *   const doc = api.tasks.open({ path: "scratch/project/a.tasks" });
 *   const snapshot = await doc.getSnapshot();
 *   return snapshot.tasks;
 */

export interface TaskRecord {
  task_id: string;
  done?: boolean;
  deleted?: boolean;
  desc?: string;
  due_date?: number;
  last_edited?: number;
  color?: string;
  hideBody?: boolean;
}

export interface TasksDocument {
  readonly path: string;
  getSnapshot(query?: {
    includeDone?: boolean;
    includeDeleted?: boolean;
    search?: string;
    limit?: number;
    sort?: { column: "Custom" | "Due" | "Changed"; dir: "asc" | "desc" };
  }): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    tasks: TaskRecord[];
    revision?: string | number | null;
  }>;
  getTask(taskId: string): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    task?: TaskRecord;
  }>;
  setDone(taskId: string, done: boolean): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;
  appendToDescription(taskId: string, text: string): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;
  updateTask(
    taskId: string,
    changes: Partial<{
      desc: string;
      due_date: number;
      color: string;
      position: number;
      done: boolean;
      deleted: boolean;
      hideBody: boolean;
    }>,
  ): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;
  createTask(input?: Partial<{
    desc: string;
    due_date: number;
    color: string;
    position: number;
    done: boolean;
    deleted: boolean;
    hideBody: boolean;
  }>): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    task: TaskRecord;
  }>;
}

export interface TextDocumentAssociation {
  basename: string;
  extension: string | null;
  doctype: "syncstring" | "syncdb" | "immer";
  supportsTextApi: boolean;
  label: string;
}

export interface TextDocumentInfo {
  project: { project_id: string; title: string; host_id: string | null };
  path: string;
  association: TextDocumentAssociation;
  textLength: number;
  latestVersionId: string | null;
  hash: number | null;
}

export interface TextDocument {
  readonly path: string;
  getAssociation(): TextDocumentAssociation;
  getInfo(): Promise<TextDocumentInfo>;
  read(): Promise<TextDocumentInfo & { text: string }>;
  write(
    text: string,
    options?: {
      expectedLatestVersionId?: string | null;
      expectedHash?: number | null;
    },
  ): Promise<TextDocumentInfo>;
  append(
    text: string,
    options?: {
      expectedLatestVersionId?: string | null;
      expectedHash?: number | null;
    },
  ): Promise<TextDocumentInfo>;
  replace(
    search: string,
    replacement: string,
    options?: {
      all?: boolean;
      expectedLatestVersionId?: string | null;
      expectedHash?: number | null;
    },
  ): Promise<TextDocumentInfo & { replaceCount: number }>;
}

export interface TimeTravelVersionRecord {
  id: string;
  index: number;
  versionNumber: number | null;
  timestamp: string;
  timestampMs: number;
  wallTime: string | null;
  wallTimeMs: number | null;
  accountId: string | null;
  userId: number | null;
}

export interface TimeTravelDocument {
  readonly path: string;
  listVersions(): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    doctype: "syncstring" | "syncdb" | "immer";
    hasFullHistory: boolean;
    versions: TimeTravelVersionRecord[];
  }>;
  loadMoreHistory(): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    doctype: "syncstring" | "syncdb" | "immer";
    hasFullHistory: boolean;
    versions: TimeTravelVersionRecord[];
  }>;
  readVersion(versionId: string): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    doctype: "syncstring" | "syncdb" | "immer";
    version: TimeTravelVersionRecord;
    text: string;
  }>;
  readLive(): Promise<{
    project: { project_id: string; title: string; host_id: string | null };
    path: string;
    doctype: "syncstring" | "syncdb" | "immer";
    text: string;
    latestVersionId: string | null;
  }>;
}

export interface ExportSummary {
  kind: string;
  outputPath: string;
  bytes: number;
  assetCount: number;
  rootDir?: string;
  manifest: Record<string, unknown>;
}

export interface TaskImportResult {
  target_path: string;
  created: number;
  updated: number;
  unchanged: number;
  preserved: number;
  conflict_count: number;
  conflicts: Array<{ task_id: string; reason: string; fields?: string[] }>;
  task_count: number;
  dry_run: boolean;
}

export interface BackendExecApi {
  tasks: {
    /**
     * Open a live collaborative .tasks document.
     *
     * This uses the sync/service path, not a direct filesystem read.
     */
    open(options: {
      path: string;
      projectIdentifier?: string;
      cwd?: string;
    }): TasksDocument;
  };
  text: {
    /**
     * Resolve backend-safe file-association metadata for a path.
     */
    association(options: {
      path: string;
      cwd?: string;
    }): TextDocumentAssociation;
    /**
     * Open a live collaborative string document.
     *
     * This uses the sync/service path, not a direct filesystem read.
     */
    open(options: {
      path: string;
      projectIdentifier?: string;
      cwd?: string;
    }): TextDocument;
  };
  timetravel: {
    /**
     * Open live document history through the sync/service path.
     *
     * This works for both string and structured sync documents.
     */
    open(options: {
      path: string;
      projectIdentifier?: string;
      cwd?: string;
    }): TimeTravelDocument;
  };
  export: {
    /** Export a chat archive locally where the backend runtime runs. */
    chat(options: {
      path: string;
      out?: string;
      scope?: "current-thread" | "all-non-archived-threads" | "all-threads";
      threadId?: string;
      projectId?: string;
      offloadDbPath?: string;
      includeBlobs?: boolean;
      blobBaseUrl?: string;
      blobBearerToken?: string;
      zipLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
      cwd?: string;
    }): Promise<ExportSummary>;
    /** Export a tasks archive locally where the backend runtime runs. */
    tasks(options: {
      path: string;
      out?: string;
      includeBlobs?: boolean;
      blobBaseUrl?: string;
      blobBearerToken?: string;
      zipLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
      cwd?: string;
    }): Promise<ExportSummary>;
    /** Export a whiteboard archive locally where the backend runtime runs. */
    board(options: {
      path: string;
      out?: string;
      includeBlobs?: boolean;
      blobBaseUrl?: string;
      blobBearerToken?: string;
      zipLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
      cwd?: string;
    }): Promise<ExportSummary>;
    /** Export a slides archive locally where the backend runtime runs. */
    slides(options: {
      path: string;
      out?: string;
      includeBlobs?: boolean;
      blobBaseUrl?: string;
      blobBearerToken?: string;
      zipLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
      cwd?: string;
    }): Promise<ExportSummary>;
  };
  import: {
    /** Import a tasks bundle or extracted export directory locally where the backend runtime runs. */
    tasks(options: {
      sourcePath: string;
      targetPath?: string;
      dryRun?: boolean;
      cwd?: string;
    }): Promise<TaskImportResult>;
  };
}

declare const api: BackendExecApi;
export default api;
`;

async function readExecScriptFromStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function createBackendExecApi(ctx: any, deps: ExecCommandDeps) {
  return {
    tasks: {
      open(options: {
        path: string;
        projectIdentifier?: string;
        cwd?: string;
      }) {
        return deps.tasksApi.bindDocument(ctx, options);
      },
    },
    text: {
      association(options: { path: string; cwd?: string }) {
        return deps.textApi.association(options);
      },
      open(options: {
        path: string;
        projectIdentifier?: string;
        cwd?: string;
      }) {
        return deps.textApi.bindDocument(ctx, options);
      },
    },
    timetravel: {
      open(options: {
        path: string;
        projectIdentifier?: string;
        cwd?: string;
      }) {
        return deps.timeTravelApi.bindDocument(ctx, options);
      },
    },
    export: {
      async chat(options: any) {
        return await deps.exportApi.chat(ctx, options);
      },
      async tasks(options: any) {
        return await deps.exportApi.tasks(ctx, options);
      },
      async board(options: any) {
        return await deps.exportApi.board(ctx, options);
      },
      async slides(options: any) {
        return await deps.exportApi.slides(ctx, options);
      },
    },
    import: {
      async tasks(options: any) {
        return await deps.importApi.tasks(ctx, options);
      },
    },
  };
}

type ExecCliOptions = {
  file?: string;
  stdin?: boolean;
};

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (...args: string[]) => (...fnArgs: any[]) => Promise<any>;

export function registerExecCommand(
  program: Command,
  deps: ExecCommandDeps,
): Command {
  program
    .command("exec-api")
    .description("print the TypeScript declaration for the backend exec API")
    .action(() => {
      process.stdout.write(BACKEND_EXEC_API_DECLARATION);
      if (!BACKEND_EXEC_API_DECLARATION.endsWith("\n")) {
        process.stdout.write("\n");
      }
    });

  program
    .command("exec [code...]")
    .description(
      "execute javascript in the backend CoCalc runtime with a typed api object; provide code inline, with --file, or with --stdin",
    )
    .addHelpText(
      "after",
      `
Current implemented namespaces:
- api.tasks
- api.text
- api.timetravel

Important:
- api.text.open({ path }) uses the live collaborative sync/session path.
- api.text.association({ path }) gives backend-safe document association metadata.
- api.tasks.open({ path }) uses the live collaborative sync/session path.
- api.export.* writes archive bundles locally where the backend runtime runs.
- api.import.tasks merges a tasks bundle back into a local .tasks file.
- Live namespaces do not read document state from disk directly.
- Return JSON-serializable values from your script.

Example:
  cocalc --json exec '
    const doc = api.text.open({ path: "scratch/project/notes.md" });
    const before = await doc.read();
    const after = await doc.append("\\n\\nUpdated from backend exec.", {
      expectedLatestVersionId: before.latestVersionId,
    });
    return { doctype: before.association.doctype, textLength: after.textLength };
  '
`,
    )
    .option(
      "--file <path>",
      "read javascript from a file path (use '-' to read from stdin)",
    )
    .option("--stdin", "read javascript from stdin")
    .action(async (code: string[], opts: ExecCliOptions, command: Command) => {
      await deps.withContext(command, "exec", async (ctx) => {
        const inlineScript = (code ?? []).join(" ").trim();
        const filePath = `${opts.file ?? ""}`.trim();
        const readFromStdin = !!opts.stdin || filePath === "-";
        const readFromFile = filePath.length > 0 && filePath !== "-";
        const sourceCount =
          (inlineScript.length > 0 ? 1 : 0) +
          (readFromFile ? 1 : 0) +
          (readFromStdin ? 1 : 0);
        if (sourceCount === 0) {
          throw new Error(
            "javascript code must be provided inline, with --file <path>, or with --stdin",
          );
        }
        if (sourceCount > 1) {
          throw new Error(
            "choose exactly one script source: inline code, --file <path>, or --stdin",
          );
        }
        const script = readFromFile
          ? await readFile(filePath, "utf8")
          : readFromStdin
            ? await readExecScriptFromStdin()
            : inlineScript;
        if (!script.trim()) {
          throw new Error("javascript code must be specified");
        }

        const api = createBackendExecApi(ctx, deps);
        const runner = new AsyncFunction("api", `"use strict";\n${script}\n`);
        const result = await runner(api);
        return {
          result: result ?? null,
        };
      });
    });

  return program;
}
