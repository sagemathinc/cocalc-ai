/*
Browser session automation bridge for frontend clients.

This module publishes a per-browser conat service and periodically heartbeats
browser session metadata to hub.system so CLI tools can discover and target a
specific live browser session.
*/

import { redux, project_redux_name } from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import type { WebappClient } from "@cocalc/frontend/client/client";
import type { HubApi } from "@cocalc/conat/hub/api";
import type { BrowserOpenProjectState } from "@cocalc/conat/hub/api/system";
import {
  createBrowserSessionService,
  type BrowserExecOperation,
  type BrowserOpenFileInfo,
  type BrowserSessionServiceApi,
} from "@cocalc/conat/service/browser-session";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { isValidUUID } from "@cocalc/util/misc";
import type { ConatService } from "@cocalc/conat/service";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { client_db } from "@cocalc/util/db-schema/client-db";

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_RETRY_MS = 4_000;
const MAX_OPEN_PROJECTS = 64;
const MAX_OPEN_FILES_PER_PROJECT = 256;
const MAX_EXEC_CODE_LENGTH = 100_000;
const MAX_EXEC_OPS = 256;
const EXEC_OP_TTL_MS = 24 * 60 * 60 * 1000;
type BrowserNotifyType = "error" | "default" | "success" | "info" | "warning";
type BrowserSyncDocType = "string" | "db" | "immer";

const BROWSER_EXEC_API_DECLARATION = `/**
 * Browser exec API available via 'cocalc browser exec'.
 *
 * Quick start:
 *   pnpm cli browser exec-api
 *   pnpm cli browser exec <workspace> 'const files = api.listOpenFiles(); return files;'
 *
 * Useful snippets:
 *   // Close all currently open markdown files in this workspace:
 *   const md = api.listOpenFiles().filter((x) => x.path.endsWith(".md"));
 *   await api.closeFiles(md.map((x) => x.path));
 *
 *   // Find notebooks containing "elliptic curve" and open the newest 3:
 *   const out = await api.fs.ripgrep("/root", "elliptic curve", { options: ["-l"] });
 *   const files = Buffer.from(out.stdout).toString().trim().split("\\n").filter(Boolean);
 *   const stats = await Promise.all(files.map(async (p) => ({ p, s: await api.fs.stat(p) })));
 *   stats.sort((a, b) => (b.s?.mtimeMs ?? 0) - (a.s?.mtimeMs ?? 0));
 *   await api.openFiles(stats.slice(0, 3).map((x) => x.p));
 *
 * Notes:
 * - paths are absolute (e.g. "/home/user/file.txt")
 * - api.projectId is the workspace id passed to browser exec
 */
export type BrowserOpenFileInfo = {
  project_id: string;
  title?: string;
  path: string;
};

export type BrowserNotebookCell = {
  id: string;
  cell_type: string;
  input: string;
  output: unknown;
};

export type BrowserNotifyType =
  | "error"
  | "default"
  | "success"
  | "info"
  | "warning";

export type BrowserNotifyOptions = {
  type?: BrowserNotifyType;
  title?: string;
  timeout?: number;
  block?: boolean;
};

export type BrowserExecOutput = {
  stdout: unknown;
  stderr: unknown;
  exit_code?: number;
  code?: number | null;
  status?: string;
  job_id?: string;
  pid?: number;
  elapsed_s?: number;
  stats?: unknown;
  truncated?: boolean;
};

export type BrowserBashOptions = {
  cwd?: string;
  path?: string;
  timeout?: number;
  max_output?: number;
  err_on_exit?: boolean;
  env?: Record<string, string>;
  filesystem?: boolean;
};

export type BrowserFsExecOutput = {
  stdout: Buffer | string;
  stderr: Buffer | string;
  code: number | null;
  truncated?: boolean;
};

export type BrowserFsFindOptions = {
  timeout?: number;
  options?: string[];
  darwin?: string[];
  linux?: string[];
  maxSize?: number;
};

export type BrowserFsFdOptions = BrowserFsFindOptions & {
  pattern?: string;
};

export type BrowserFsRipgrepOptions = BrowserFsFindOptions;
export type BrowserFsDustOptions = BrowserFsFindOptions;

export type BrowserFsDirent = {
  name: string;
  parentPath: string;
  path: string;
  type?: number;
};

export type BrowserFsStat = {
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  atimeMs?: number;
  mode?: number;
};

export type BrowserExecApi = {
  projectId: string;
  workspaceId: string;
  listOpenFiles: () => BrowserOpenFileInfo[];
  listOpenFilesAll: () => BrowserOpenFileInfo[];
  openFiles: (
    paths: unknown,
    opts?: { background?: boolean },
  ) => Promise<{ opened: number; paths: string[] }>;
  closeFiles: (paths: unknown) => Promise<{ closed: number; paths: string[] }>;
  notebook: {
    listCells: (path: string) => Promise<BrowserNotebookCell[]>;
    runCells: (
      path: string,
      ids?: unknown,
    ) => Promise<{ ran: number; mode: "all" | "selected"; ids: string[] }>;
    setCells: (
      path: string,
      updates: unknown,
    ) => Promise<{ updated: number; ids: string[] }>;
  };
  notify: {
    show: (
      message: unknown,
      opts?: BrowserNotifyOptions,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    info: (
      message: unknown,
      opts?: Omit<BrowserNotifyOptions, "type">,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    success: (
      message: unknown,
      opts?: Omit<BrowserNotifyOptions, "type">,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    warning: (
      message: unknown,
      opts?: Omit<BrowserNotifyOptions, "type">,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    error: (
      message: unknown,
      opts?: Omit<BrowserNotifyOptions, "type">,
    ) => { ok: true; type: BrowserNotifyType; message: string };
  };
  /**
   * File API closely mirrors CoCalc's async Node-like fs client.
   *
   * Notes:
   * - readFile(path, encoding) returns string if encoding is provided; otherwise Buffer.
   * - find/fd/ripgrep/dust return command-style output
   *   with stdout, stderr, code and optional truncated fields.
   */
  fs: {
    exists: (path: string) => Promise<boolean>;
    readFile: (
      path: string,
      encoding?: string,
      lock?: number,
    ) => Promise<string | Buffer>;
    writeFile: (path: string, data: string | Buffer, saveLast?: boolean) => Promise<void>;
    readdir: (
      path: string,
      options?: { withFileTypes?: boolean },
    ) => Promise<string[] | BrowserFsDirent[]>;
    stat: (path: string) => Promise<BrowserFsStat>;
    lstat: (path: string) => Promise<BrowserFsStat>;
    mkdir: (
      path: string,
      options?: { recursive?: boolean; mode?: string | number },
    ) => Promise<void>;
    rm: (
      path: string | string[],
      options?: {
        recursive?: boolean;
        force?: boolean;
        maxRetries?: number;
        retryDelay?: number;
      },
    ) => Promise<void>;
    rename: (oldPath: string, newPath: string) => Promise<void>;
    copyFile: (src: string, dest: string) => Promise<void>;
    cp: (
      src: string | string[],
      dest: string,
      options?: {
        dereference?: boolean;
        errorOnExist?: boolean;
        force?: boolean;
        preserveTimestamps?: boolean;
        recursive?: boolean;
        verbatimSymlinks?: boolean;
        reflink?: boolean;
        timeout?: number;
      },
    ) => Promise<void>;
    move: (
      src: string | string[],
      dest: string,
      options?: { overwrite?: boolean },
    ) => Promise<void>;
    find: (path: string, options?: BrowserFsFindOptions) => Promise<BrowserFsExecOutput>;
    fd: (path: string, options?: BrowserFsFdOptions) => Promise<BrowserFsExecOutput>;
    ripgrep: (
      path: string,
      pattern: string,
      options?: BrowserFsRipgrepOptions,
    ) => Promise<BrowserFsExecOutput>;
    dust: (path: string, options?: BrowserFsDustOptions) => Promise<BrowserFsExecOutput>;
  };
  bash: {
    run: (script: string, options?: BrowserBashOptions) => Promise<BrowserExecOutput>;
    start: (script: string, options?: BrowserBashOptions) => Promise<BrowserExecOutput>;
    get: (
      job_id: string,
      options?: { async_stats?: boolean; async_await?: boolean; timeout?: number },
    ) => Promise<BrowserExecOutput>;
    wait: (
      job_id: string,
      options?: { async_stats?: boolean; timeout?: number },
    ) => Promise<BrowserExecOutput>;
  };
  timetravel: {
    providers: () => Promise<{
      patchflow: boolean;
      snapshots: boolean;
      backups: boolean;
      git: boolean;
    }>;
    patchflow: {
      listVersions: (path: string) => Promise<
        {
          id: string;
          patch_time?: number;
          wall_time?: number;
          version_number?: number;
          account_id?: string;
          user_id?: number;
        }[]
      >;
      getText: (path: string, version: string) => Promise<string>;
    };
    snapshots: {
      listVersions: (path: string) => Promise<
        {
          id: string;
          wall_time?: number;
          mtime_ms?: number;
        }[]
      >;
      getText: (path: string, snapshot: string) => Promise<string>;
    };
    backups: {
      listVersions: (path: string) => Promise<
        {
          id: string;
          wall_time?: number;
          mtime?: number;
          size?: number;
        }[]
      >;
      getText: (path: string, backup_id: string) => Promise<string>;
    };
    git: {
      listVersions: (path: string) => Promise<
        {
          hash: string;
          wall_time?: number;
          author_name?: string;
          author_email?: string;
          subject?: string;
        }[]
      >;
      getText: (path: string, commit: string) => Promise<string>;
    };
  };
};`;

function asStringArray(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => `${v ?? ""}`.trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value.toArray === "function") {
    return asStringArray(value.toArray());
  }
  const out: string[] = [];
  if (typeof value.forEach === "function") {
    value.forEach((v) => {
      const s = `${v ?? ""}`.trim();
      if (s.length > 0) out.push(s);
    });
  }
  return out;
}

function toAbsolutePath(path: string): string {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getActiveProjectIdFallback(openProjectIds: string[]): string | undefined {
  const activeTopTab = `${redux.getStore("page")?.get("active_top_tab") ?? ""}`;
  if (isValidUUID(activeTopTab)) {
    return activeTopTab;
  }
  return openProjectIds[0];
}

function collectOpenProjects(): BrowserOpenProjectState[] {
  const projectsStore = redux.getStore("projects");
  const openProjectIds = asStringArray(projectsStore?.get("open_projects")).slice(
    0,
    MAX_OPEN_PROJECTS,
  );
  const out: BrowserOpenProjectState[] = [];
  for (const project_id of openProjectIds) {
    if (!isValidUUID(project_id)) continue;
    const projectStore = redux.getStore(project_redux_name(project_id));
    if (!projectStore) continue;
    const files = asStringArray(projectStore.get("open_files_order"))
      .map(toAbsolutePath)
      .slice(0, MAX_OPEN_FILES_PER_PROJECT);
    const title = `${projectsStore?.getIn(["project_map", project_id, "title"]) ?? ""}`.trim();
    out.push({
      project_id,
      ...(title ? { title } : {}),
      open_files: files,
    });
  }
  return out;
}

function flattenOpenFiles(open_projects: BrowserOpenProjectState[]): BrowserOpenFileInfo[] {
  const files: BrowserOpenFileInfo[] = [];
  for (const project of open_projects) {
    for (const path of project.open_files ?? []) {
      const absolute_path = toAbsolutePath(path);
      files.push({
        project_id: project.project_id,
        ...(project.title ? { title: project.title } : {}),
        // path is now absolute across frontend/backend/cli.
        path: absolute_path,
      });
    }
  }
  return files;
}

function sanitizePathList(paths: unknown): string[] {
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths
    .map((path) => `${path ?? ""}`.trim())
    .filter((path) => path.length > 0);
}

function asFinitePositive(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(`${value}`);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return num;
}

function asFiniteNonNegative(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(`${value}`);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return num;
}

function requireAbsolutePath(path: unknown, label = "path"): string {
  const cleanPath = `${path ?? ""}`.trim();
  if (!cleanPath) {
    throw Error(`${label} must be specified`);
  }
  if (!cleanPath.startsWith("/")) {
    throw Error(`${label} must be absolute`);
  }
  return cleanPath;
}

function requireAbsolutePathOrList(
  value: unknown,
  label = "path",
): string | string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw Error(`${label} must be a non-empty array`);
    }
    return value.map((x, i) => requireAbsolutePath(x, `${label}[${i}]`));
  }
  return requireAbsolutePath(value, label);
}

function splitAbsolutePath(path: string): { dir: string; base: string } {
  const cleanPath = requireAbsolutePath(path);
  if (cleanPath === "/") {
    throw Error("path cannot be '/'");
  }
  const i = cleanPath.lastIndexOf("/");
  if (i < 0) {
    throw Error("path must be absolute");
  }
  const dir = i === 0 ? "/" : cleanPath.slice(0, i);
  const base = cleanPath.slice(i + 1);
  if (!base) {
    throw Error("path must reference a file");
  }
  return { dir, base };
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return Buffer.from(value as any).toString();
  } catch {
    return `${value}`;
  }
}

function sanitizeBashOptions(opts: unknown): BrowserBashOptions {
  if (opts == null || typeof opts !== "object") {
    return {};
  }
  const row = opts as {
    cwd?: unknown;
    path?: unknown;
    timeout?: unknown;
    max_output?: unknown;
    err_on_exit?: unknown;
    env?: unknown;
    filesystem?: unknown;
  };
  const cwd = row.cwd == null ? undefined : requireAbsolutePath(row.cwd, "cwd");
  const path = row.path == null ? undefined : requireAbsolutePath(row.path, "path");
  const timeout = asFinitePositive(row.timeout);
  const max_output = asFinitePositive(row.max_output);
  const env =
    row.env != null && typeof row.env === "object"
      ? (row.env as Record<string, string>)
      : undefined;
  const err_on_exit =
    row.err_on_exit == null ? undefined : !!row.err_on_exit;
  const filesystem =
    row.filesystem == null ? undefined : !!row.filesystem;
  return {
    ...(cwd != null ? { cwd } : {}),
    ...(path != null ? { path } : {}),
    ...(timeout != null ? { timeout } : {}),
    ...(max_output != null ? { max_output } : {}),
    ...(err_on_exit != null ? { err_on_exit } : {}),
    ...(env != null ? { env } : {}),
    ...(filesystem != null ? { filesystem } : {}),
  };
}

function toNotifyMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return `${value}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return `${value ?? ""}`;
  }
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n =
    typeof value === "number" ? value : Number.parseFloat(`${value ?? ""}`);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function sanitizeNotifyOptions(
  opts: unknown,
): {
  type?: BrowserNotifyType;
  title?: string;
  timeout?: number;
  block?: boolean;
} {
  if (opts == null || typeof opts !== "object") {
    return {};
  }
  const row = opts as {
    type?: unknown;
    title?: unknown;
    timeout?: unknown;
    block?: unknown;
  };
  const maybeType = `${row.type ?? ""}`.trim() as BrowserNotifyType;
  const type: BrowserNotifyType | undefined =
    maybeType === "error" ||
    maybeType === "default" ||
    maybeType === "success" ||
    maybeType === "info" ||
    maybeType === "warning"
      ? maybeType
      : undefined;
  const title =
    row.title == null ? undefined : `${row.title}`.trim() || undefined;
  const timeout = asOptionalFiniteNumber(row.timeout);
  const block = row.block == null ? undefined : !!row.block;
  return {
    ...(type ? { type } : {}),
    ...(title ? { title } : {}),
    ...(timeout != null ? { timeout } : {}),
    ...(block != null ? { block } : {}),
  };
}

function toSerializableValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return `${value}`;
  }
}

function buildSessionSnapshot(client: WebappClient): {
  browser_id: string;
  session_name?: string;
  url?: string;
  active_project_id?: string;
  open_projects: BrowserOpenProjectState[];
} {
  const open_projects = collectOpenProjects();
  const active_project_id = getActiveProjectIdFallback(
    open_projects.map((x) => x.project_id),
  );
  const session_name =
    typeof document !== "undefined" ? document.title?.trim() || undefined : undefined;
  const url = typeof location !== "undefined" ? location.href : undefined;
  return {
    browser_id: client.browser_id,
    ...(session_name ? { session_name } : {}),
    ...(url ? { url } : {}),
    ...(active_project_id ? { active_project_id } : {}),
    open_projects,
  };
}

export type BrowserSessionAutomation = {
  start: (account_id: string) => Promise<void>;
  stop: () => Promise<void>;
};

type BrowserExecOutput = {
  stdout: unknown;
  stderr: unknown;
  exit_code?: number;
  code?: number | null;
  status?: string;
  job_id?: string;
  pid?: number;
  elapsed_s?: number;
  stats?: unknown;
  truncated?: boolean;
};

type BrowserBashOptions = {
  cwd?: string;
  path?: string;
  timeout?: number;
  max_output?: number;
  err_on_exit?: boolean;
  env?: Record<string, string>;
  filesystem?: boolean;
};

type BrowserFsExecOutput = {
  stdout: Buffer | string;
  stderr: Buffer | string;
  code: number | null;
  truncated?: boolean;
};

type BrowserFsFindOptions = {
  timeout?: number;
  options?: string[];
  darwin?: string[];
  linux?: string[];
  maxSize?: number;
};

type BrowserFsFdOptions = BrowserFsFindOptions & {
  pattern?: string;
};

type BrowserFsRipgrepOptions = BrowserFsFindOptions;
type BrowserFsDustOptions = BrowserFsFindOptions;

type BrowserFsDirent = {
  name: string;
  parentPath: string;
  path: string;
  type?: number;
};

type BrowserFsStat = {
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  atimeMs?: number;
  mode?: number;
};

type BrowserExecApi = {
  projectId: string;
  workspaceId: string;
  listOpenFiles: () => BrowserOpenFileInfo[];
  listOpenFilesAll: () => BrowserOpenFileInfo[];
  openFiles: (
    paths: unknown,
    opts?: { background?: boolean },
  ) => Promise<{ opened: number; paths: string[] }>;
  closeFiles: (paths: unknown) => Promise<{ closed: number; paths: string[] }>;
  notebook: {
    listCells: (
      path: string,
    ) => Promise<
      {
        id: string;
        cell_type: string;
        input: string;
        output: unknown;
      }[]
    >;
    runCells: (
      path: string,
      ids?: unknown,
    ) => Promise<{ ran: number; mode: "all" | "selected"; ids: string[] }>;
    setCells: (
      path: string,
      updates: unknown,
    ) => Promise<{ updated: number; ids: string[] }>;
  };
  notify: {
    show: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    info: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    success: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    warning: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    error: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
  };
  fs: {
    exists: (path: string) => Promise<boolean>;
    readFile: (
      path: string,
      encoding?: string,
      lock?: number,
    ) => Promise<string | Buffer>;
    writeFile: (path: string, data: string | Buffer, saveLast?: boolean) => Promise<void>;
    readdir: (
      path: string,
      options?: { withFileTypes?: boolean },
    ) => Promise<string[] | BrowserFsDirent[]>;
    stat: (path: string) => Promise<BrowserFsStat>;
    lstat: (path: string) => Promise<BrowserFsStat>;
    mkdir: (
      path: string,
      options?: { recursive?: boolean; mode?: string | number },
    ) => Promise<void>;
    rm: (
      path: string | string[],
      options?: {
        recursive?: boolean;
        force?: boolean;
        maxRetries?: number;
        retryDelay?: number;
      },
    ) => Promise<void>;
    rename: (oldPath: string, newPath: string) => Promise<void>;
    copyFile: (src: string, dest: string) => Promise<void>;
    cp: (
      src: string | string[],
      dest: string,
      options?: {
        dereference?: boolean;
        errorOnExist?: boolean;
        force?: boolean;
        preserveTimestamps?: boolean;
        recursive?: boolean;
        verbatimSymlinks?: boolean;
        reflink?: boolean;
        timeout?: number;
      },
    ) => Promise<void>;
    move: (
      src: string | string[],
      dest: string,
      options?: { overwrite?: boolean },
    ) => Promise<void>;
    find: (path: string, options?: BrowserFsFindOptions) => Promise<BrowserFsExecOutput>;
    fd: (path: string, options?: BrowserFsFdOptions) => Promise<BrowserFsExecOutput>;
    ripgrep: (
      path: string,
      pattern: string,
      options?: BrowserFsRipgrepOptions,
    ) => Promise<BrowserFsExecOutput>;
    dust: (path: string, options?: BrowserFsDustOptions) => Promise<BrowserFsExecOutput>;
  };
  bash: {
    run: (script: string, options?: BrowserBashOptions) => Promise<BrowserExecOutput>;
    start: (script: string, options?: BrowserBashOptions) => Promise<BrowserExecOutput>;
    get: (
      job_id: string,
      options?: { async_stats?: boolean; async_await?: boolean; timeout?: number },
    ) => Promise<BrowserExecOutput>;
    wait: (
      job_id: string,
      options?: { async_stats?: boolean; timeout?: number },
    ) => Promise<BrowserExecOutput>;
  };
  timetravel: {
    providers: () => Promise<{
      patchflow: boolean;
      snapshots: boolean;
      backups: boolean;
      git: boolean;
    }>;
    patchflow: {
      listVersions: (path: string) => Promise<
        {
          id: string;
          patch_time?: number;
          wall_time?: number;
          version_number?: number;
          account_id?: string;
          user_id?: number;
        }[]
      >;
      getText: (path: string, version: string) => Promise<string>;
    };
    snapshots: {
      listVersions: (path: string) => Promise<
        {
          id: string;
          wall_time?: number;
          mtime_ms?: number;
        }[]
      >;
      getText: (path: string, snapshot: string) => Promise<string>;
    };
    backups: {
      listVersions: (path: string) => Promise<
        {
          id: string;
          wall_time?: number;
          mtime?: number;
          size?: number;
        }[]
      >;
      getText: (path: string, backup_id: string) => Promise<string>;
    };
    git: {
      listVersions: (path: string) => Promise<
        {
          hash: string;
          wall_time?: number;
          author_name?: string;
          author_email?: string;
          subject?: string;
        }[]
      >;
      getText: (path: string, commit: string) => Promise<string>;
    };
  };
};

function asPlain(value: any): any {
  if (value != null && typeof value.toJS === "function") {
    return value.toJS();
  }
  return value;
}

function trunc(value: string, max = 4000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function simplifyNotebookOutputMessage(message: any): Record<string, unknown> {
  const obj = asPlain(message) ?? {};
  const data = asPlain(obj.data) ?? {};
  const plainText = (() => {
    if (typeof obj.text === "string" && obj.text.length > 0) return obj.text;
    const textPlain = data["text/plain"];
    if (typeof textPlain === "string" && textPlain.length > 0) return textPlain;
    if (Array.isArray(textPlain) && textPlain.length > 0) {
      return textPlain.join("");
    }
    if (Array.isArray(obj.traceback) && obj.traceback.length > 0) {
      return obj.traceback.join("\n");
    }
    return undefined;
  })();

  const out: Record<string, unknown> = {};
  if (obj.output_type != null) out.output_type = obj.output_type;
  if (obj.msg_type != null) out.msg_type = obj.msg_type;
  if (obj.name != null) out.name = obj.name;
  if (obj.execution_count != null) out.execution_count = obj.execution_count;
  if (obj.ename != null) out.ename = obj.ename;
  if (obj.evalue != null) out.evalue = obj.evalue;
  if (plainText != null) out.text = trunc(`${plainText}`);
  if (data != null && typeof data === "object") {
    const dataTypes = Object.keys(data);
    if (dataTypes.length > 0) out.data_types = dataTypes;
  }
  if (obj.metadata != null) out.metadata = asPlain(obj.metadata);
  return out;
}

function simplifyNotebookOutput(output: any): unknown {
  const obj = asPlain(output);
  if (obj == null) return null;
  if (typeof obj !== "object") {
    return { count: 1, messages: [{ text: trunc(`${obj}`) }] };
  }
  const entries = Object.entries(obj);
  const messages = entries
    .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10))
    .map(([, value]) => simplifyNotebookOutputMessage(value));
  return { count: messages.length, messages };
}

function sanitizeCellIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => `${x ?? ""}`.trim())
    .filter((x) => x.length > 0);
}

function sanitizeCellUpdates(
  value: unknown,
): {
  id: string;
  input: string;
}[] {
  if (!Array.isArray(value)) return [];
  const updates: { id: string; input: string }[] = [];
  for (const item of value) {
    const row = item as { id?: unknown; input?: unknown };
    const id = `${row?.id ?? ""}`.trim();
    if (!id) {
      continue;
    }
    const input = `${row?.input ?? ""}`;
    updates.push({ id, input });
  }
  return updates;
}

function createExecId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g?.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createBrowserSessionAutomation({
  client,
  hub,
  conat,
}: {
  client: WebappClient;
  hub: HubApi;
  conat: () => ConatClient;
}): BrowserSessionAutomation {
  let service: ConatService | undefined;
  let accountId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let inFlight: Promise<void> | undefined;
  const execOps = new Map<
    string,
    BrowserExecOperation & { code: string }
  >();
  const managedSyncDocs = new Map<
    string,
    {
      refcount: number;
      syncdoc?: any;
      opening?: Promise<any>;
    }
  >();

  const closeManagedSyncDoc = async (key: string): Promise<void> => {
    const entry = managedSyncDocs.get(key);
    if (!entry) return;
    if (entry.opening != null) {
      try {
        await entry.opening;
      } catch {
        // ignore open errors on close path
      }
    }
    managedSyncDocs.delete(key);
    try {
      await entry.syncdoc?.close?.();
    } catch {
      // ignore close errors
    }
  };

  const closeAllManagedSyncDocs = async (): Promise<void> => {
    const keys = [...managedSyncDocs.keys()];
    for (const key of keys) {
      await closeManagedSyncDoc(key);
    }
  };

  const parseDocTypeFromSyncstring = (raw: unknown): {
    type: BrowserSyncDocType;
    opts?: Record<string, unknown>;
  } => {
    if (typeof raw !== "string" || raw.trim() === "") {
      return { type: "string" };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { type: "string" };
    }
    const typeRaw = `${parsed?.type ?? "string"}`.toLowerCase();
    const type: BrowserSyncDocType =
      typeRaw === "db" ? "db" : typeRaw.includes("immer") ? "immer" : "string";
    const opts =
      parsed?.opts != null && typeof parsed.opts === "object"
        ? (parsed.opts as Record<string, unknown>)
        : undefined;
    return { type, opts };
  };

  const toStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.map((x) => `${x ?? ""}`).filter((x) => x.length > 0);
    }
    if (value instanceof Set) {
      return [...value].map((x) => `${x ?? ""}`).filter((x) => x.length > 0);
    }
    return [];
  };

  const getSyncDocTypeForPath = async ({
    project_id,
    path,
  }: {
    project_id: string;
    path: string;
  }): Promise<{ type: BrowserSyncDocType; opts?: Record<string, unknown> }> => {
    const string_id = client_db.sha1(project_id, path);
    const syncstrings = await conat().sync.synctable({
      query: {
        syncstrings: [{ project_id, path, string_id, doctype: null }],
      },
      stream: false,
      atomic: false,
      immutable: false,
      noInventory: true,
    });
    try {
      const getOne =
        (syncstrings as any).get_one ?? (syncstrings as any).getOne;
      const row =
        typeof getOne === "function" ? getOne.call(syncstrings) : undefined;
      return parseDocTypeFromSyncstring(row?.doctype);
    } finally {
      try {
        syncstrings?.close?.();
      } catch {
        // ignore close errors
      }
    }
  };

  const openSyncDocDirectly = async ({
    project_id,
    path,
  }: {
    project_id: string;
    path: string;
  }): Promise<any> => {
    const cleanPath = requireAbsolutePath(path);
    const { type, opts } = await getSyncDocTypeForPath({
      project_id,
      path: cleanPath,
    });
    const commonOpts = {
      project_id,
      path: cleanPath,
      noSaveToDisk: true,
      noAutosave: true,
      firstReadLockTimeout: 1,
    };
    const primary_keys = toStringArray((opts as any)?.primary_keys ?? (opts as any)?.primaryKeys);
    const string_cols = toStringArray((opts as any)?.string_cols ?? (opts as any)?.stringCols);
    const sync = conat().sync;
    const syncdoc =
      type === "immer" && primary_keys.length > 0
        ? sync.immer({ ...commonOpts, primary_keys, string_cols })
        : type === "db" && primary_keys.length > 0
          ? sync.db({ ...commonOpts, primary_keys, string_cols })
          : sync.string(commonOpts);
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const state =
        typeof syncdoc?.get_state === "function"
          ? syncdoc.get_state()
          : "ready";
      if (state === "ready") {
        return syncdoc;
      }
      if (state === "closed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      await syncdoc?.close?.();
    } catch {
      // ignore close errors
    }
    throw Error(`syncdoc not ready for ${cleanPath}`);
  };

  const acquireManagedSyncDoc = async ({
    project_id,
    path,
    isCanceled,
  }: {
    project_id: string;
    path: string;
    isCanceled?: () => boolean;
  }): Promise<{ syncdoc: any; release: () => Promise<void> }> => {
    const cleanPath = requireAbsolutePath(path);
    const key = `${project_id}:${cleanPath}`;
    let entry = managedSyncDocs.get(key);
    if (!entry) {
      entry = { refcount: 0 };
      managedSyncDocs.set(key, entry);
    }
    entry.refcount += 1;

    if (!entry.syncdoc) {
      if (!entry.opening) {
        entry.opening = (async () => {
          const doc = await openSyncDocDirectly({
            project_id,
            path: cleanPath,
          });
          entry!.syncdoc = doc;
          return doc;
        })().finally(() => {
          if (entry != null) {
            delete entry.opening;
          }
        });
      }
      try {
        await entry.opening;
      } catch (err) {
        entry.refcount = Math.max(0, entry.refcount - 1);
        if (entry.refcount <= 0) {
          managedSyncDocs.delete(key);
        }
        throw err;
      }
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      const current = managedSyncDocs.get(key);
      if (!current) return;
      current.refcount = Math.max(0, current.refcount - 1);
      if (current.refcount <= 0 && !current.opening) {
        await closeManagedSyncDoc(key);
      }
    };

    if (isCanceled?.()) {
      await release();
      throw Error("execution canceled");
    }
    return { syncdoc: entry.syncdoc, release };
  };

  const pruneExecOps = () => {
    const now = Date.now();
    for (const [exec_id, op] of execOps.entries()) {
      if (
        op.finished_at != null &&
        now - new Date(op.finished_at).getTime() > EXEC_OP_TTL_MS
      ) {
        execOps.delete(exec_id);
      }
    }
    if (execOps.size <= MAX_EXEC_OPS) return;
    const ordered = [...execOps.values()].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (const op of ordered) {
      if (execOps.size <= MAX_EXEC_OPS) break;
      execOps.delete(op.exec_id);
    }
  };

  const getExecOp = (exec_id: string): BrowserExecOperation & { code: string } => {
    const clean = `${exec_id ?? ""}`.trim();
    if (!clean) {
      throw Error("exec_id must be specified");
    }
    const op = execOps.get(clean);
    if (!op) {
      throw Error(`exec operation '${clean}' not found`);
    }
    return op;
  };

  const openFileInProject = async ({
    project_id,
    path,
    foreground = true,
    foreground_project = true,
  }: {
    project_id: string;
    path: string;
    foreground?: boolean;
    foreground_project?: boolean;
  }): Promise<{ ok: true }> => {
    if (!isValidUUID(project_id)) {
      throw Error("project_id must be a UUID");
    }
    const cleanPath = `${path ?? ""}`.trim();
    if (!cleanPath) {
      throw Error("path must be specified");
    }
    const projectsActions = redux.getActions("projects") as any;
    if (!projectsActions?.open_project) {
      throw Error("projects actions unavailable");
    }
    await projectsActions.open_project({
      project_id,
      switch_to: !!foreground_project,
      restore_session: false,
    });
    const projectActions = redux.getProjectActions(project_id) as any;
    if (!projectActions?.open_file) {
      throw Error(`project actions unavailable for ${project_id}`);
    }
    await projectActions.open_file({
      path: cleanPath,
      foreground: !!foreground,
      foreground_project: !!foreground_project,
    });
    return { ok: true };
  };

  const closeFileInProject = async ({
    project_id,
    path,
  }: {
    project_id: string;
    path: string;
  }): Promise<{ ok: true }> => {
    if (!isValidUUID(project_id)) {
      throw Error("project_id must be a UUID");
    }
    const cleanPath = `${path ?? ""}`.trim();
    if (!cleanPath) {
      throw Error("path must be specified");
    }
    const projectActions = redux.getProjectActions(project_id) as any;
    if (!projectActions?.close_file) {
      throw Error(`project actions unavailable for ${project_id}`);
    }
    projectActions.close_file(cleanPath);
    return { ok: true };
  };

  const getJupyterActionsForPath = async ({
    project_id,
    path,
  }: {
    project_id: string;
    path: string;
  }): Promise<any> => {
    if (!isValidUUID(project_id)) {
      throw Error("project_id must be a UUID");
    }
    const cleanPath = `${path ?? ""}`.trim();
    if (!cleanPath) {
      throw Error("notebook path must be specified");
    }
    if (!cleanPath.startsWith("/")) {
      throw Error("notebook path must be absolute");
    }
    if (!cleanPath.toLowerCase().endsWith(".ipynb")) {
      throw Error("notebook path must end with .ipynb");
    }
    await openFileInProject({
      project_id,
      path: cleanPath,
      foreground: false,
      foreground_project: false,
    });
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const editorActions = redux.getEditorActions(project_id, cleanPath) as any;
      const jupyterActions = editorActions?.jupyter_actions;
      if (jupyterActions != null) {
        if (typeof jupyterActions.wait_until_ready === "function") {
          await jupyterActions.wait_until_ready();
        }
        return jupyterActions;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(`jupyter actions unavailable for ${cleanPath}`);
  };

  const assertExecNotCanceled = (isCanceled?: () => boolean) => {
    if (isCanceled?.()) {
      throw Error("execution canceled");
    }
  };

  const createExecApi = (
    project_id: string,
    isCanceled?: () => boolean,
  ): { api: BrowserExecApi; cleanup: () => Promise<void> } => {
    const fsApi = conat().fs({ project_id });
    const heldSyncDocs = new Map<
      string,
      { syncdoc: any; release: () => Promise<void> }
    >();

    const notify = (
      forcedType: BrowserNotifyType | undefined,
      message: unknown,
      opts?: unknown,
    ): { ok: true; type: BrowserNotifyType; message: string } => {
      assertExecNotCanceled(isCanceled);
      const cleanMessage = toNotifyMessage(message).trim();
      if (!cleanMessage) {
        throw Error("notification message must be non-empty");
      }
      const cleanOpts = sanitizeNotifyOptions(opts);
      const type = forcedType ?? cleanOpts.type ?? "default";
      alert_message({
        type,
        message: cleanMessage,
        ...(cleanOpts.title ? { title: cleanOpts.title } : {}),
        ...(cleanOpts.timeout != null ? { timeout: cleanOpts.timeout } : {}),
        ...(cleanOpts.block != null ? { block: cleanOpts.block } : {}),
      });
      return { ok: true, type, message: cleanMessage };
    };

    const runBash = async (
      script: unknown,
      options?: unknown,
      async_call?: boolean,
    ): Promise<BrowserExecOutput> => {
      assertExecNotCanceled(isCanceled);
      const command = `${script ?? ""}`;
      if (!command.trim()) {
        throw Error("script must be specified");
      }
      const clean = sanitizeBashOptions(options);
      if (clean.cwd && clean.path && clean.cwd !== clean.path) {
        throw Error("if both cwd and path are set, they must match");
      }
      const result = await client.project_client.exec({
        project_id,
        command,
        bash: true,
        timeout: clean.timeout ?? 30,
        max_output: clean.max_output,
        err_on_exit: clean.err_on_exit ?? false,
        env: clean.env,
        filesystem: clean.filesystem,
        path: clean.path ?? clean.cwd,
        ...(async_call ? { async_call: true } : {}),
      });
      assertExecNotCanceled(isCanceled);
      return asPlain(result) as BrowserExecOutput;
    };

    const runGit = async (
      path: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const { dir } = splitAbsolutePath(path);
      const result = await client.project_client.exec({
        project_id,
        command: "git",
        args,
        bash: false,
        path: dir,
        timeout: 30,
        err_on_exit: true,
      });
      return {
        stdout: asText((result as any)?.stdout),
        stderr: asText((result as any)?.stderr),
      };
    };

    const getHeldSyncDoc = async (path: string): Promise<any> => {
      const cleanPath = requireAbsolutePath(path);
      const key = `${project_id}:${cleanPath}`;
      const existing = heldSyncDocs.get(key);
      if (existing?.syncdoc != null) {
        return existing.syncdoc;
      }
      const lease = await acquireManagedSyncDoc({
        project_id,
        path: cleanPath,
        isCanceled,
      });
      heldSyncDocs.set(key, lease);
      return lease.syncdoc;
    };

    const cleanup = async (): Promise<void> => {
      const releases = [...heldSyncDocs.values()].map((x) => x.release);
      heldSyncDocs.clear();
      for (const release of releases) {
        try {
          await release();
        } catch {
          // ignore release failures during cleanup
        }
      }
    };

    const api: BrowserExecApi = {
      projectId: project_id,
      workspaceId: project_id,
      listOpenFiles: (): BrowserOpenFileInfo[] => {
        assertExecNotCanceled(isCanceled);
        const snapshot = buildSessionSnapshot(client);
        return flattenOpenFiles(snapshot.open_projects).filter(
          (file) => file.project_id === project_id,
        );
      },
      listOpenFilesAll: (): BrowserOpenFileInfo[] => {
        assertExecNotCanceled(isCanceled);
        const snapshot = buildSessionSnapshot(client);
        return flattenOpenFiles(snapshot.open_projects);
      },
      openFiles: async (
        paths: unknown,
        opts?: { background?: boolean },
      ): Promise<{ opened: number; paths: string[] }> => {
        assertExecNotCanceled(isCanceled);
        const cleanPaths = sanitizePathList(paths);
        for (const [index, path] of cleanPaths.entries()) {
          assertExecNotCanceled(isCanceled);
          const foreground = !opts?.background && index === 0;
          await openFileInProject({
            project_id,
            path,
            foreground,
            foreground_project: foreground,
          });
        }
        return { opened: cleanPaths.length, paths: cleanPaths };
      },
      closeFiles: async (
        paths: unknown,
      ): Promise<{ closed: number; paths: string[] }> => {
        assertExecNotCanceled(isCanceled);
        const cleanPaths = sanitizePathList(paths);
        for (const path of cleanPaths) {
          assertExecNotCanceled(isCanceled);
          await closeFileInProject({ project_id, path });
        }
        return { closed: cleanPaths.length, paths: cleanPaths };
      },
      notebook: {
        listCells: async (
          path: string,
        ): Promise<
          {
            id: string;
            cell_type: string;
            input: string;
            output: unknown;
          }[]
        > => {
          assertExecNotCanceled(isCanceled);
          const jupyterActions = await getJupyterActionsForPath({
            project_id,
            path,
          });
          assertExecNotCanceled(isCanceled);
          const store = jupyterActions.store;
          const cellIds = asStringArray(store.get("cell_list"));
          return cellIds.map((id) => {
            const cell = store.getIn(["cells", id]);
            return {
              id,
              cell_type: `${cell?.get("cell_type") ?? "code"}`,
              input: `${cell?.get("input") ?? ""}`,
              output: simplifyNotebookOutput(cell?.get("output")),
            };
          });
        },
        runCells: async (
          path: string,
          ids?: unknown,
        ): Promise<{ ran: number; mode: "all" | "selected"; ids: string[] }> => {
          assertExecNotCanceled(isCanceled);
          const jupyterActions = await getJupyterActionsForPath({
            project_id,
            path,
          });
          assertExecNotCanceled(isCanceled);
          const store = jupyterActions.store;
          const existingCellIds = new Set(asStringArray(store.get("cell_list")));
          const wanted = sanitizeCellIdList(ids);
          if (wanted.length === 0) {
            const all = asStringArray(store.get("cell_list"));
            await jupyterActions.runCells(all);
            return { ran: all.length, mode: "all", ids: all };
          }
          for (const id of wanted) {
            if (!existingCellIds.has(id)) {
              throw Error(`no cell with id '${id}'`);
            }
          }
          await jupyterActions.runCells(wanted);
          return { ran: wanted.length, mode: "selected", ids: wanted };
        },
        setCells: async (
          path: string,
          updates: unknown,
        ): Promise<{ updated: number; ids: string[] }> => {
          assertExecNotCanceled(isCanceled);
          const cleanUpdates = sanitizeCellUpdates(updates);
          if (cleanUpdates.length === 0) {
            return { updated: 0, ids: [] };
          }
          const jupyterActions = await getJupyterActionsForPath({
            project_id,
            path,
          });
          assertExecNotCanceled(isCanceled);
          const store = jupyterActions.store;
          const existingCellIds = new Set(asStringArray(store.get("cell_list")));
          for (const update of cleanUpdates) {
            if (!existingCellIds.has(update.id)) {
              throw Error(`no cell with id '${update.id}'`);
            }
          }
          for (const update of cleanUpdates) {
            assertExecNotCanceled(isCanceled);
            jupyterActions.set_cell_input(update.id, update.input, false);
          }
          jupyterActions.syncdb?.commit?.();
          return {
            updated: cleanUpdates.length,
            ids: cleanUpdates.map((x) => x.id),
          };
        },
      },
      notify: {
        show: (message: unknown, opts?: unknown) =>
          notify(undefined, message, opts),
        info: (message: unknown, opts?: unknown) => notify("info", message, opts),
        success: (message: unknown, opts?: unknown) =>
          notify("success", message, opts),
        warning: (message: unknown, opts?: unknown) =>
          notify("warning", message, opts),
        error: (message: unknown, opts?: unknown) =>
          notify("error", message, opts),
      },
      fs: {
        exists: async (path: string): Promise<boolean> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const exists = await fsApi.exists(cleanPath);
          assertExecNotCanceled(isCanceled);
          return !!exists;
        },
        readFile: async (
          path: string,
          encoding?: string,
          lock?: number,
        ): Promise<string | Buffer> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const lockMs = asFiniteNonNegative(lock);
          const data = await fsApi.readFile(cleanPath, encoding, lockMs) as
            | string
            | Buffer;
          assertExecNotCanceled(isCanceled);
          return data;
        },
        writeFile: async (
          path: string,
          data: string | Buffer,
          saveLast?: boolean,
        ): Promise<void> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          await fsApi.writeFile(cleanPath, data, saveLast);
          assertExecNotCanceled(isCanceled);
        },
        readdir: async (
          path: string,
          options?: { withFileTypes?: boolean },
        ): Promise<string[] | BrowserFsDirent[]> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const value = await fsApi.readdir(cleanPath, options);
          assertExecNotCanceled(isCanceled);
          return value as string[] | BrowserFsDirent[];
        },
        stat: async (path: string): Promise<BrowserFsStat> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const value = await fsApi.stat(cleanPath) as BrowserFsStat;
          assertExecNotCanceled(isCanceled);
          return value;
        },
        lstat: async (path: string): Promise<BrowserFsStat> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const value = await fsApi.lstat(cleanPath) as BrowserFsStat;
          assertExecNotCanceled(isCanceled);
          return value;
        },
        mkdir: async (
          path: string,
          options?: { recursive?: boolean; mode?: string | number },
        ): Promise<void> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          await fsApi.mkdir(cleanPath, options);
          assertExecNotCanceled(isCanceled);
        },
        rm: async (
          path: string | string[],
          options?: {
            recursive?: boolean;
            force?: boolean;
            maxRetries?: number;
            retryDelay?: number;
          },
        ): Promise<void> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePathOrList(path);
          await fsApi.rm(cleanPath, options);
          assertExecNotCanceled(isCanceled);
        },
        rename: async (oldPath: string, newPath: string): Promise<void> => {
          assertExecNotCanceled(isCanceled);
          const cleanOld = requireAbsolutePath(oldPath, "oldPath");
          const cleanNew = requireAbsolutePath(newPath, "newPath");
          await fsApi.rename(cleanOld, cleanNew);
          assertExecNotCanceled(isCanceled);
        },
        copyFile: async (src: string, dest: string): Promise<void> => {
          assertExecNotCanceled(isCanceled);
          const cleanSrc = requireAbsolutePath(src, "src");
          const cleanDest = requireAbsolutePath(dest, "dest");
          await fsApi.copyFile(cleanSrc, cleanDest);
          assertExecNotCanceled(isCanceled);
        },
        cp: async (
          src: string | string[],
          dest: string,
          options?: {
            dereference?: boolean;
            errorOnExist?: boolean;
            force?: boolean;
            preserveTimestamps?: boolean;
            recursive?: boolean;
            verbatimSymlinks?: boolean;
            reflink?: boolean;
            timeout?: number;
          },
        ): Promise<void> => {
          assertExecNotCanceled(isCanceled);
          const cleanSrc = requireAbsolutePathOrList(src, "src");
          const cleanDest = requireAbsolutePath(dest, "dest");
          await fsApi.cp(cleanSrc, cleanDest, options);
          assertExecNotCanceled(isCanceled);
        },
        move: async (
          src: string | string[],
          dest: string,
          options?: { overwrite?: boolean },
        ): Promise<void> => {
          assertExecNotCanceled(isCanceled);
          const cleanSrc = requireAbsolutePathOrList(src, "src");
          const cleanDest = requireAbsolutePath(dest, "dest");
          await fsApi.move(cleanSrc, cleanDest, options);
          assertExecNotCanceled(isCanceled);
        },
        find: async (
          path: string,
          options?: BrowserFsFindOptions,
        ): Promise<BrowserFsExecOutput> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const value = await fsApi.find(cleanPath, options);
          assertExecNotCanceled(isCanceled);
          return value as BrowserFsExecOutput;
        },
        fd: async (
          path: string,
          options?: BrowserFsFdOptions,
        ): Promise<BrowserFsExecOutput> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const value = await fsApi.fd(cleanPath, options);
          assertExecNotCanceled(isCanceled);
          return value as BrowserFsExecOutput;
        },
        ripgrep: async (
          path: string,
          pattern: string,
          options?: BrowserFsRipgrepOptions,
        ): Promise<BrowserFsExecOutput> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const cleanPattern = `${pattern ?? ""}`.trim();
          if (!cleanPattern) {
            throw Error("pattern must be specified");
          }
          const value = await fsApi.ripgrep(cleanPath, cleanPattern, options);
          assertExecNotCanceled(isCanceled);
          return value as BrowserFsExecOutput;
        },
        dust: async (
          path: string,
          options?: BrowserFsDustOptions,
        ): Promise<BrowserFsExecOutput> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const value = await fsApi.dust(cleanPath, options);
          assertExecNotCanceled(isCanceled);
          return value as BrowserFsExecOutput;
        },
      },
      bash: {
        run: async (
          script: string,
          options?: BrowserBashOptions,
        ): Promise<BrowserExecOutput> => {
          return await runBash(script, options, false);
        },
        start: async (
          script: string,
          options?: BrowserBashOptions,
        ): Promise<BrowserExecOutput> => {
          return await runBash(script, options, true);
        },
        get: async (
          job_id: string,
          options?: {
            async_stats?: boolean;
            async_await?: boolean;
            timeout?: number;
          },
        ): Promise<BrowserExecOutput> => {
          assertExecNotCanceled(isCanceled);
          const cleanJobId = `${job_id ?? ""}`.trim();
          if (!cleanJobId) {
            throw Error("job_id must be specified");
          }
          const timeout = asFinitePositive(options?.timeout);
          const result = await client.project_client.exec({
            project_id,
            async_get: cleanJobId,
            async_stats: options?.async_stats,
            async_await: options?.async_await,
            ...(timeout != null ? { timeout } : {}),
          });
          assertExecNotCanceled(isCanceled);
          return asPlain(result) as BrowserExecOutput;
        },
        wait: async (
          job_id: string,
          options?: {
            async_stats?: boolean;
            timeout?: number;
          },
        ): Promise<BrowserExecOutput> => {
          assertExecNotCanceled(isCanceled);
          const cleanJobId = `${job_id ?? ""}`.trim();
          if (!cleanJobId) {
            throw Error("job_id must be specified");
          }
          const timeout = asFinitePositive(options?.timeout);
          const result = await client.project_client.exec({
            project_id,
            async_get: cleanJobId,
            async_stats: options?.async_stats,
            async_await: true,
            ...(timeout != null ? { timeout } : {}),
          });
          assertExecNotCanceled(isCanceled);
          return asPlain(result) as BrowserExecOutput;
        },
      },
      timetravel: {
        providers: async (): Promise<{
          patchflow: boolean;
          snapshots: boolean;
          backups: boolean;
          git: boolean;
        }> => {
          assertExecNotCanceled(isCanceled);
          const projectsApi = (client.conat_client as any)?.hub?.projects ?? {};
          return {
            patchflow: true,
            snapshots: typeof projectsApi.getSnapshotFileText === "function",
            backups:
              typeof projectsApi.findBackupFiles === "function" &&
              typeof projectsApi.getBackupFileText === "function",
            git: true,
          };
        },
        patchflow: {
          listVersions: async (
            path: string,
          ): Promise<
            {
              id: string;
              patch_time?: number;
              wall_time?: number;
              version_number?: number;
              account_id?: string;
              user_id?: number;
            }[]
          > => {
            assertExecNotCanceled(isCanceled);
            const cleanPath = requireAbsolutePath(path);
            const syncdoc = await getHeldSyncDoc(cleanPath);
            const versions = Array.isArray(syncdoc?.versions?.())
              ? syncdoc.versions()
              : [];
            const out: {
              id: string;
              patch_time?: number;
              wall_time?: number;
              version_number?: number;
              account_id?: string;
              user_id?: number;
            }[] = [];
            for (const raw of versions) {
              const id = `${raw ?? ""}`.trim();
              if (!id) continue;
              const row: {
                id: string;
                patch_time?: number;
                wall_time?: number;
                version_number?: number;
                account_id?: string;
                user_id?: number;
              } = { id };
              try {
                const t = Number(syncdoc.patchTime?.(id));
                if (Number.isFinite(t)) row.patch_time = t;
              } catch {}
              try {
                const t = Number(syncdoc.wallTime?.(id));
                if (Number.isFinite(t)) row.wall_time = t;
              } catch {}
              try {
                const n = Number(syncdoc.historyVersionNumber?.(id));
                if (Number.isFinite(n)) row.version_number = n;
              } catch {}
              try {
                const account_id = syncdoc.account_id?.(id);
                if (typeof account_id === "string" && account_id.trim()) {
                  row.account_id = account_id;
                }
              } catch {}
              try {
                const user_id = Number(syncdoc.user_id?.(id));
                if (Number.isFinite(user_id)) row.user_id = user_id;
              } catch {}
              out.push(row);
            }
            return out;
          },
          getText: async (path: string, version: string): Promise<string> => {
            assertExecNotCanceled(isCanceled);
            const cleanPath = requireAbsolutePath(path);
            const cleanVersion = `${version ?? ""}`.trim();
            if (!cleanVersion) {
              throw Error("version must be specified");
            }
            const syncdoc = await getHeldSyncDoc(cleanPath);
            const doc = syncdoc.version?.(cleanVersion);
            if (doc == null) {
              throw Error(`unknown patchflow version '${cleanVersion}'`);
            }
            if (typeof doc.to_str === "function") {
              return `${doc.to_str()}`;
            }
            return `${doc}`;
          },
        },
        snapshots: {
          listVersions: async (
            path: string,
          ): Promise<
            {
              id: string;
              wall_time?: number;
              mtime_ms?: number;
            }[]
          > => {
            assertExecNotCanceled(isCanceled);
            const cleanPath = requireAbsolutePath(path);
            const { base } = splitAbsolutePath(cleanPath);
            const docDepth = cleanPath.split("/").filter(Boolean).length + 1;
            const { stdout } = await fsApi.find(SNAPSHOTS, {
              options: [
                "-mindepth",
                `${docDepth}`,
                "-maxdepth",
                `${docDepth}`,
                "-type",
                "f",
                "-name",
                base,
                "-printf",
                "%T@\t%P\n",
              ],
            });
            const latestMtimeBySnapshot = new Map<string, number>();
            for (const row of asText(stdout).split("\n")) {
              if (!row) continue;
              const i = row.indexOf("\t");
              if (i <= 0) continue;
              const mtime = Number(row.slice(0, i));
              if (!Number.isFinite(mtime)) continue;
              const rel = row.slice(i + 1);
              const j = rel.indexOf("/");
              if (j <= 0) continue;
              const snapshot = rel.slice(0, j).trim();
              const docpath = rel.slice(j + 1);
              if (!snapshot || docpath !== cleanPath) continue;
              const mtimeMs = Math.round(mtime * 1000);
              const prev = latestMtimeBySnapshot.get(snapshot);
              if (prev == null || mtimeMs > prev) {
                latestMtimeBySnapshot.set(snapshot, mtimeMs);
              }
            }
            const ordered = Array.from(latestMtimeBySnapshot.entries())
              .map(([id, mtime_ms]) => ({ id, mtime_ms }))
              .sort((a, b) => a.id.localeCompare(b.id));
            const filtered: { id: string; mtime_ms: number }[] = [];
            let lastMtimeMs: number | undefined = undefined;
            for (const row of ordered) {
              if (lastMtimeMs !== row.mtime_ms) {
                filtered.push(row);
                lastMtimeMs = row.mtime_ms;
              }
            }
            return filtered.map((row) => {
              const wall_time = Date.parse(row.id);
              return {
                id: row.id,
                ...(Number.isFinite(wall_time) ? { wall_time } : {}),
                mtime_ms: row.mtime_ms,
              };
            });
          },
          getText: async (path: string, snapshot: string): Promise<string> => {
            assertExecNotCanceled(isCanceled);
            const cleanPath = requireAbsolutePath(path);
            const cleanSnapshot = `${snapshot ?? ""}`.trim();
            if (!cleanSnapshot) {
              throw Error("snapshot must be specified");
            }
            const getSnapshotFileText = (client.conat_client as any)?.hub?.projects
              ?.getSnapshotFileText;
            if (typeof getSnapshotFileText !== "function") {
              throw Error("snapshot provider unavailable");
            }
            const resp = await getSnapshotFileText({
              project_id,
              snapshot: cleanSnapshot,
              path: cleanPath,
            });
            return `${resp?.content ?? ""}`;
          },
        },
        backups: {
          listVersions: async (
            path: string,
          ): Promise<
            {
              id: string;
              wall_time?: number;
              mtime?: number;
              size?: number;
            }[]
          > => {
            assertExecNotCanceled(isCanceled);
            const cleanPath = requireAbsolutePath(path);
            const findBackupFiles = (client.conat_client as any)?.hub?.projects
              ?.findBackupFiles;
            if (typeof findBackupFiles !== "function") {
              throw Error("backup provider unavailable");
            }
            const raw = await findBackupFiles({
              project_id,
              glob: [cleanPath],
            });
            const rows = (Array.isArray(raw) ? raw : [])
              .filter((x: any) => !x?.isDir && x?.path === cleanPath)
              .map((x: any) => {
                const t = new Date(x?.time as any).getTime();
                return {
                  id: `${x?.id ?? ""}`.trim(),
                  wall_time: Number.isFinite(t) ? t : 0,
                  mtime: Number(x?.mtime ?? 0),
                  size: Number(x?.size ?? 0),
                };
              })
              .filter((x: any) => x.id.length > 0)
              .sort((a: any, b: any) =>
                a.wall_time !== b.wall_time
                  ? a.wall_time - b.wall_time
                  : a.id.localeCompare(b.id),
              );
            const filtered: {
              id: string;
              wall_time: number;
              mtime: number;
              size: number;
            }[] = [];
            let lastSig: string | undefined = undefined;
            for (const row of rows) {
              const sig = `${row.mtime}:${row.size}`;
              if (sig === lastSig) continue;
              lastSig = sig;
              filtered.push(row);
            }
            return filtered;
          },
          getText: async (path: string, backup_id: string): Promise<string> => {
            assertExecNotCanceled(isCanceled);
            const cleanPath = requireAbsolutePath(path);
            const cleanBackupId = `${backup_id ?? ""}`.trim();
            if (!cleanBackupId) {
              throw Error("backup_id must be specified");
            }
            const getBackupFileText = (client.conat_client as any)?.hub?.projects
              ?.getBackupFileText;
            if (typeof getBackupFileText !== "function") {
              throw Error("backup provider unavailable");
            }
            const resp = await getBackupFileText({
              project_id,
              id: cleanBackupId,
              path: cleanPath,
            });
            return `${resp?.content ?? ""}`;
          },
        },
        git: {
          listVersions: async (
            path: string,
          ): Promise<
            {
              hash: string;
              wall_time?: number;
              author_name?: string;
              author_email?: string;
              subject?: string;
            }[]
          > => {
            assertExecNotCanceled(isCanceled);
            const cleanPath = requireAbsolutePath(path);
            const { base } = splitAbsolutePath(cleanPath);
            const { stdout } = await runGit(cleanPath, [
              "log",
              "--follow",
              "--date=raw",
              "--pretty=format:%H%x1f%at%x1f%an%x1f%ae%x1f%s",
              "--",
              base,
            ]);
            const out: {
              hash: string;
              wall_time?: number;
              author_name?: string;
              author_email?: string;
              subject?: string;
            }[] = [];
            for (const line of stdout.split("\n")) {
              if (!line) continue;
              const [hash, ts, author_name, author_email, subject] =
                line.split("\x1f");
              const cleanHash = `${hash ?? ""}`.trim();
              if (!cleanHash) continue;
              const seconds = Number(ts);
              const wall_time = Number.isFinite(seconds) ? seconds * 1000 : undefined;
              out.push({
                hash: cleanHash,
                ...(wall_time != null ? { wall_time } : {}),
                ...(author_name ? { author_name } : {}),
                ...(author_email ? { author_email } : {}),
                ...(subject ? { subject } : {}),
              });
            }
            return out;
          },
          getText: async (path: string, commit: string): Promise<string> => {
            assertExecNotCanceled(isCanceled);
            const cleanPath = requireAbsolutePath(path);
            const { base } = splitAbsolutePath(cleanPath);
            const cleanCommit = `${commit ?? ""}`.trim();
            if (!cleanCommit) {
              throw Error("commit must be specified");
            }
            const { stdout } = await runGit(cleanPath, [
              "show",
              `${cleanCommit}:./${base}`,
            ]);
            return stdout;
          },
        },
      },
    };
    return { api, cleanup };
  };

  const executeBrowserScript = async ({
    project_id,
    code,
    isCanceled,
  }: {
    project_id: string;
    code: string;
    isCanceled?: () => boolean;
  }): Promise<unknown> => {
    if (!isValidUUID(project_id)) {
      throw Error("project_id must be a UUID");
    }
    const script = `${code ?? ""}`;
    if (!script.trim()) {
      throw Error("code must be specified");
    }
    if (script.length > MAX_EXEC_CODE_LENGTH) {
      throw Error(
        `code is too long (${script.length} chars); max ${MAX_EXEC_CODE_LENGTH}`,
      );
    }
    assertExecNotCanceled(isCanceled);
    const { api, cleanup } = createExecApi(project_id, isCanceled);
    const evaluator = new Function(
      "api",
      `"use strict"; return (async () => { ${script}\n})();`,
    ) as (api: BrowserExecApi) => Promise<unknown>;
    try {
      const result = await evaluator(api);
      assertExecNotCanceled(isCanceled);
      return toSerializableValue(result);
    } finally {
      await cleanup();
    }
  };

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const heartbeat = async () => {
    if (closed || !accountId) return;
    if (inFlight) {
      await inFlight;
      return;
    }
    inFlight = (async () => {
      const snapshot = buildSessionSnapshot(client);
      await hub.system.upsertBrowserSession({
        browser_id: snapshot.browser_id,
        session_name: snapshot.session_name,
        url: snapshot.url,
        active_project_id: snapshot.active_project_id,
        open_projects: snapshot.open_projects,
      });
    })().finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  };

  const scheduleHeartbeat = (delayMs = HEARTBEAT_INTERVAL_MS) => {
    if (closed || !accountId) return;
    clearTimer();
    timer = setTimeout(async () => {
      try {
        await heartbeat();
        scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
      } catch (err) {
        console.warn(`browser-session heartbeat failed: ${err}`);
        scheduleHeartbeat(HEARTBEAT_RETRY_MS);
      }
    }, delayMs);
  };

  const toPublicExecOp = (
    op: BrowserExecOperation & { code: string },
  ): BrowserExecOperation => {
    const {
      exec_id,
      project_id,
      status,
      created_at,
      started_at,
      finished_at,
      cancel_requested,
      error,
      result,
    } = op;
    return {
      exec_id,
      project_id,
      status,
      created_at,
      ...(started_at ? { started_at } : {}),
      ...(finished_at ? { finished_at } : {}),
      ...(cancel_requested ? { cancel_requested } : {}),
      ...(error ? { error } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  };

  const runExecOperation = async (op: BrowserExecOperation & { code: string }) => {
    if (op.status !== "pending") return;
    op.status = "running";
    op.started_at = new Date().toISOString();
    try {
      const result = await executeBrowserScript({
        project_id: op.project_id,
        code: op.code,
        isCanceled: () => !!op.cancel_requested,
      });
      if (op.cancel_requested) {
        op.status = "canceled";
        delete op.result;
      } else {
        op.status = "succeeded";
        op.result = result;
      }
      delete op.error;
    } catch (err) {
      if (op.cancel_requested) {
        op.status = "canceled";
        delete op.result;
        delete op.error;
      } else {
        op.status = "failed";
        op.error = `${err}`;
        delete op.result;
      }
    } finally {
      op.finished_at = new Date().toISOString();
      pruneExecOps();
    }
  };

  const impl: BrowserSessionServiceApi = {
    getExecApiDeclaration: async () => BROWSER_EXEC_API_DECLARATION,
    getSessionInfo: async () => buildSessionSnapshot(client),
    listOpenFiles: async () => {
      const snapshot = buildSessionSnapshot(client);
      return flattenOpenFiles(snapshot.open_projects);
    },
    openFile: async ({ project_id, path, foreground = true, foreground_project = true }) =>
      await openFileInProject({
        project_id,
        path,
        foreground,
        foreground_project,
      }),
    closeFile: async ({ project_id, path }) =>
      await closeFileInProject({ project_id, path }),
    exec: async ({ project_id, code }) => ({
      ok: true,
      result: await executeBrowserScript({ project_id, code }),
    }),
    startExec: async ({ project_id, code }) => {
      const script = `${code ?? ""}`;
      if (!script.trim()) {
        throw Error("code must be specified");
      }
      if (script.length > MAX_EXEC_CODE_LENGTH) {
        throw Error(
          `code is too long (${script.length} chars); max ${MAX_EXEC_CODE_LENGTH}`,
        );
      }
      if (!isValidUUID(project_id)) {
        throw Error("project_id must be a UUID");
      }
      const exec_id = createExecId();
      const op: BrowserExecOperation & { code: string } = {
        exec_id,
        project_id,
        status: "pending",
        created_at: new Date().toISOString(),
        code: script,
      };
      execOps.set(exec_id, op);
      pruneExecOps();
      void runExecOperation(op);
      return { exec_id, status: op.status };
    },
    getExec: async ({ exec_id }) => {
      pruneExecOps();
      return toPublicExecOp(getExecOp(exec_id));
    },
    cancelExec: async ({ exec_id }) => {
      const op = getExecOp(exec_id);
      op.cancel_requested = true;
      if (op.status === "pending") {
        op.status = "canceled";
        op.finished_at = new Date().toISOString();
        delete op.result;
        delete op.error;
      }
      return { ok: true, exec_id: op.exec_id, status: op.status };
    },
  };

  return {
    start: async (nextAccountId: string) => {
      const cleanAccountId = `${nextAccountId ?? ""}`.trim();
      if (!cleanAccountId) return;
      if (accountId === cleanAccountId && service) {
        scheduleHeartbeat(0);
        return;
      }
      await Promise.resolve().then(async () => {
        await closeAllManagedSyncDocs();
        if (service) {
          service.close();
          service = undefined;
        }
      });
      closed = false;
      accountId = cleanAccountId;
      service = createBrowserSessionService({
        account_id: cleanAccountId,
        browser_id: client.browser_id,
        client: conat(),
        impl,
      });
      try {
        await heartbeat();
      } catch (err) {
        console.warn(`browser-session initial heartbeat failed: ${err}`);
      }
      scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
    },

    stop: async () => {
      closed = true;
      clearTimer();
      execOps.clear();
      await closeAllManagedSyncDocs();
      if (service) {
        service.close();
        service = undefined;
      }
      const currentAccountId = accountId;
      accountId = undefined;
      if (!currentAccountId) return;
      try {
        await hub.system.removeBrowserSession({
          browser_id: client.browser_id,
        });
      } catch {
        // ignore disconnect races and best-effort cleanup failures.
      }
    },
  };
}
