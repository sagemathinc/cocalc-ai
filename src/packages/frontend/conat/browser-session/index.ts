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
  BrowserExtensionsRuntime,
  type BrowserExtensionSummary,
  type BrowserInstallHelloWorldOptions,
} from "../extensions-runtime";
import { executeBrowserAction } from "./action-engine";
import { BROWSER_EXEC_API_DECLARATION } from "./exec-api-declaration";
import {
  createBrowserSessionService,
  type BrowserAtomicActionRequest,
  type BrowserActionName,
  type BrowserActionResult,
  type BrowserAutomationPosture,
  type BrowserExecPolicyV1,
  type BrowserExecOperation,
  type BrowserOpenFileInfo,
  type BrowserRuntimeEvent,
  type BrowserRuntimeEventKind,
  type BrowserRuntimeEventLevel,
  type BrowserNetworkTraceDirection,
  type BrowserNetworkTraceEvent,
  type BrowserNetworkTracePhase,
  type BrowserNetworkTraceProtocol,
  type BrowserSessionServiceApi,
} from "@cocalc/conat/service/browser-session";
import {
  onConatTrace,
  type Client as ConatClient,
  type ConatTraceEvent,
} from "@cocalc/conat/core/client";
import {
  terminalClient,
  type TerminalClient as ProjectTerminalClient,
} from "@cocalc/conat/project/terminal";
import { isValidUUID } from "@cocalc/util/misc";
import type { ConatService } from "@cocalc/conat/service";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { client_db } from "@cocalc/util/db-schema/client-db";
import { termPath } from "@cocalc/util/terminal/names";
import quickjsAsyncifyVariant from "@jitl/quickjs-wasmfile-release-asyncify";
import {
  memoizePromiseFactory,
  newQuickJSAsyncWASMModuleFromVariant,
} from "quickjs-emscripten-core";

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_RETRY_MS = 4_000;
const MAX_OPEN_PROJECTS = 64;
const MAX_OPEN_FILES_PER_PROJECT = 256;
const MAX_EXEC_CODE_LENGTH = 100_000;
const MAX_EXEC_OPS = 256;
const EXEC_OP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RUNTIME_EVENTS = 5_000;
const MAX_RUNTIME_MESSAGE_LENGTH = 2_000;
const MAX_NETWORK_TRACE_EVENTS = 50_000;
const MAX_NETWORK_TRACE_PREVIEW_CHARS = 4_000;
const MAX_NETWORK_TRACE_INTERNAL_SUBJECTS = 2_000;
const NETWORK_TRACE_INTERNAL_SUBJECT_TTL_MS = 10 * 60 * 1000;
const ALL_NETWORK_TRACE_PROTOCOLS: BrowserNetworkTraceProtocol[] = [
  "conat",
  "http",
  "ws",
];
const MAX_SANDBOX_ACTIONS = 512;
const MAX_SANDBOX_ACTION_JSON_LENGTH = 100_000;
const BROWSER_EXEC_POLICY_VERSION = 1;
type BrowserNotifyType = "error" | "default" | "success" | "info" | "warning";
type BrowserSyncDocType = "string" | "db" | "immer";
type BrowserExecMode = "raw_js" | "quickjs_wasm";

const getQuickJSAsyncifyModule = memoizePromiseFactory(async () => {
  return await newQuickJSAsyncWASMModuleFromVariant(quickjsAsyncifyVariant);
});


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

function normalizePosture(value: unknown): BrowserAutomationPosture {
  const v = `${value ?? ""}`.trim().toLowerCase();
  return v === "prod" ? "prod" : "dev";
}

function normalizePolicy(policy: unknown): BrowserExecPolicyV1 | undefined {
  if (!policy || typeof policy !== "object") {
    return undefined;
  }
  const row = policy as Record<string, unknown>;
  const version = Number(row.version ?? BROWSER_EXEC_POLICY_VERSION);
  if (version !== BROWSER_EXEC_POLICY_VERSION) {
    throw Error(
      `unsupported browser exec policy version '${row.version ?? ""}' (expected ${BROWSER_EXEC_POLICY_VERSION})`,
    );
  }
  const asStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value
      .map((x) => `${x ?? ""}`.trim())
      .filter((x) => x.length > 0);
    return out.length > 0 ? out : undefined;
  };
  const allow_raw_exec =
    row.allow_raw_exec == null ? undefined : !!row.allow_raw_exec;
  const allowed_project_ids = asStringArray(row.allowed_project_ids);
  const allowed_origins = asStringArray(row.allowed_origins);
  const allowed_actions = asStringArray(row.allowed_actions)?.filter(
    (x): x is BrowserActionName => isAllowedActionName(x),
  );
  return {
    version: BROWSER_EXEC_POLICY_VERSION,
    ...(allow_raw_exec != null ? { allow_raw_exec } : {}),
    ...(allowed_project_ids ? { allowed_project_ids } : {}),
    ...(allowed_origins ? { allowed_origins } : {}),
    ...(allowed_actions?.length ? { allowed_actions } : {}),
  };
}

function isAllowedActionName(value: unknown): value is BrowserActionName {
  const clean = `${value ?? ""}`.trim();
  return (
    clean === "click" ||
    clean === "click_at" ||
    clean === "drag" ||
    clean === "type" ||
    clean === "press" ||
    clean === "reload" ||
    clean === "navigate" ||
    clean === "scroll_by" ||
    clean === "scroll_to" ||
    clean === "wait_for_selector" ||
    clean === "wait_for_url" ||
    clean === "batch"
  );
}

function enforcePolicyScope({
  project_id,
  posture,
  policy,
}: {
  project_id: string;
  posture?: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}): {
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
} {
  const normalizedPosture = normalizePosture(posture);
  const normalizedPolicy = normalizePolicy(policy);

  const allowedProjects = normalizedPolicy?.allowed_project_ids ?? [];
  if (allowedProjects.length > 0 && !allowedProjects.includes(project_id)) {
    throw Error(
      `browser exec denied by policy: project '${project_id}' not in allowed_project_ids`,
    );
  }

  const allowedOrigins = normalizedPolicy?.allowed_origins ?? [];
  if (allowedOrigins.length > 0) {
    const currentOrigin =
      typeof location !== "undefined" ? `${location.origin ?? ""}`.trim() : "";
    if (!currentOrigin || !allowedOrigins.includes(currentOrigin)) {
      throw Error(
        `browser exec denied by policy: origin '${currentOrigin || "<unknown>"}' not in allowed_origins`,
      );
    }
  }

  return { posture: normalizedPosture, ...(normalizedPolicy ? { policy: normalizedPolicy } : {}) };
}

function enforceExecPolicy({
  project_id,
  posture,
  policy,
}: {
  project_id: string;
  posture?: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}): {
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
} {
  return enforcePolicyScope({ project_id, posture, policy });
}

function resolveExecMode({
  project_id,
  posture,
  policy,
}: {
  project_id: string;
  posture?: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}): {
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
  mode: BrowserExecMode;
} {
  const scoped = enforceExecPolicy({ project_id, posture, policy });
  const mode: BrowserExecMode =
    scoped.posture === "prod" && !scoped.policy?.allow_raw_exec
      ? "quickjs_wasm"
      : "raw_js";
  return { ...scoped, mode };
}

function enforceActionPolicy({
  project_id,
  action_name,
  posture,
  policy,
}: {
  project_id: string;
  action_name: BrowserActionName;
  posture?: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}): {
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
} {
  const scoped = enforcePolicyScope({ project_id, posture, policy });
  if (scoped.posture !== "prod") {
    return scoped;
  }
  const allowed = scoped.policy?.allowed_actions ?? [];
  if (allowed.length > 0 && !allowed.includes(action_name)) {
    throw Error(
      `browser action denied by policy: action '${action_name}' not in allowed_actions`,
    );
  }
  return scoped;
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

function truncateRuntimeMessage(text: string): string {
  if (text.length <= MAX_RUNTIME_MESSAGE_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_RUNTIME_MESSAGE_LENGTH)}…`;
}

function safeStringifyForRuntimeLog(value: unknown): string {
  try {
    if (value instanceof Error) {
      const msg = `${value.name || "Error"}: ${value.message || ""}`.trim();
      if (value.stack) {
        return `${msg}\n${value.stack}`;
      }
      return msg;
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || value == null) {
      return `${value}`;
    }
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, next) => {
      if (typeof next === "object" && next != null) {
        if (seen.has(next as object)) {
          return "[Circular]";
        }
        seen.add(next as object);
      }
      if (typeof next === "bigint") {
        return `${next}n`;
      }
      if (typeof next === "function") {
        return `[Function ${next.name || "anonymous"}]`;
      }
      return next;
    });
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

function sanitizeTerminalSpawnOptions(
  options: unknown,
): BrowserTerminalSpawnOptions {
  if (options == null || typeof options !== "object") {
    return {};
  }
  const row = options as {
    command?: unknown;
    args?: unknown;
    cwd?: unknown;
    env?: unknown;
    env0?: unknown;
    rows?: unknown;
    cols?: unknown;
    timeout?: unknown;
    handleFlowControl?: unknown;
  };
  const command =
    row.command == null ? undefined : `${row.command ?? ""}`.trim() || undefined;
  const args = Array.isArray(row.args)
    ? row.args.map((x) => `${x ?? ""}`)
    : undefined;
  const cwd = row.cwd == null ? undefined : requireAbsolutePath(row.cwd, "cwd");
  const env =
    row.env != null && typeof row.env === "object"
      ? (row.env as Record<string, string>)
      : undefined;
  const env0 =
    row.env0 != null && typeof row.env0 === "object"
      ? (row.env0 as Record<string, string>)
      : undefined;
  const rows = asFinitePositive(row.rows);
  const cols = asFinitePositive(row.cols);
  const timeout = asFinitePositive(row.timeout);
  const handleFlowControl =
    row.handleFlowControl == null ? undefined : !!row.handleFlowControl;
  return {
    ...(command ? { command } : {}),
    ...(args != null ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(env0 ? { env0 } : {}),
    ...(rows != null ? { rows: Math.max(2, Math.floor(rows)) } : {}),
    ...(cols != null ? { cols: Math.max(2, Math.floor(cols)) } : {}),
    ...(timeout != null ? { timeout } : {}),
    ...(handleFlowControl != null ? { handleFlowControl } : {}),
  };
}

function sanitizeTerminalHistoryOptions(
  options: unknown,
): BrowserTerminalHistoryOptions {
  if (options == null || typeof options !== "object") {
    return {};
  }
  const row = options as { max_chars?: unknown };
  const max_chars = asFinitePositive(row.max_chars);
  return {
    ...(max_chars != null ? { max_chars: Math.floor(max_chars) } : {}),
  };
}

function normalizeTerminalFrameCommand(value: unknown): string | undefined {
  const command = `${value ?? ""}`.trim();
  return command.length > 0 ? command : undefined;
}

function normalizeTerminalFrameArgs(value: unknown): string[] {
  return asStringArray(value);
}

function terminalCommandSuffix(command?: string): string {
  return command ? `-${command.replace(/\//g, "-")}` : "";
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

type BrowserTerminalSpawnOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  env0?: Record<string, string>;
  rows?: number;
  cols?: number;
  timeout?: number;
  handleFlowControl?: boolean;
};

type BrowserTerminalHistoryOptions = {
  max_chars?: number;
};

type BrowserTerminalFrameInfo = {
  parent_path: string;
  frame_id: string;
  type: string;
  active: boolean;
  number?: number;
  command?: string;
  args?: string[];
  title?: string;
  session_path?: string;
};

type BrowserTerminalSessionInfo = {
  session_path: string;
  command: string;
  args: string[];
  pid?: number;
  history_chars?: number;
};

type BrowserExtensionApiSummary = BrowserExtensionSummary;
type BrowserInstallHelloOptions = BrowserInstallHelloWorldOptions;

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
  terminal: {
    listOpen: () => Promise<BrowserTerminalFrameInfo[]>;
    openSplit: (
      path: string,
      opts?: {
        direction?: "row" | "col";
        anchor_frame_id?: string;
        command?: string;
        args?: string[];
        no_focus?: boolean;
        first?: boolean;
      },
    ) => Promise<BrowserTerminalFrameInfo>;
    spawn: (
      session_path: string,
      options?: BrowserTerminalSpawnOptions,
    ) => Promise<BrowserTerminalSessionInfo>;
    write: (
      session_path: string,
      data: string,
      opts?: { kind?: "user" | "auto" },
    ) => Promise<{ ok: true }>;
    history: (
      session_path: string,
      opts?: BrowserTerminalHistoryOptions,
    ) => Promise<string>;
    state: (session_path: string) => Promise<"running" | "off">;
    cwd: (session_path: string) => Promise<string | undefined>;
    resize: (
      session_path: string,
      opts: { rows: number; cols: number },
    ) => Promise<{ ok: true }>;
    destroy: (session_path: string) => Promise<{ ok: true }>;
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
  extensions: {
    list: () => BrowserExtensionApiSummary[];
    installHelloWorld: (
      options?: BrowserInstallHelloOptions,
    ) => Promise<BrowserExtensionApiSummary>;
    uninstall: (id: string) => { ok: true; id: string };
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

type BrowserExecPendingOperation = BrowserExecOperation & {
  code: string;
  posture: BrowserAutomationPosture;
  mode: BrowserExecMode;
  policy?: BrowserExecPolicyV1;
};

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
    BrowserExecPendingOperation
  >();
  const runtimeEvents: BrowserRuntimeEvent[] = [];
  let runtimeEventSeq = 0;
  let runtimeEventsDropped = 0;
  const networkTraceEvents: BrowserNetworkTraceEvent[] = [];
  let networkTraceSeq = 0;
  let networkTraceDropped = 0;
  let stopConatTraceListener: (() => void) | undefined;
  const internalTraceReplySubjects = new Map<string, number>();
  const INTERNAL_TRACE_METHODS = new Set<string>([
    "listNetworkTrace",
    "configureNetworkTrace",
    "clearNetworkTrace",
  ]);
  const networkTraceConfig: {
    enabled: boolean;
    include_decoded: boolean;
    include_internal: boolean;
    protocols: BrowserNetworkTraceProtocol[];
    max_events: number;
    max_preview_chars: number;
    subject_prefixes: string[];
    addresses: string[];
  } = {
    enabled: false,
    include_decoded: false,
    include_internal: false,
    protocols: [...ALL_NETWORK_TRACE_PROTOCOLS],
    max_events: 5_000,
    max_preview_chars: MAX_NETWORK_TRACE_PREVIEW_CHARS,
    subject_prefixes: [],
    addresses: [],
  };
  const managedSyncDocs = new Map<
    string,
    {
      refcount: number;
      syncdoc?: any;
      opening?: Promise<any>;
    }
  >();
  const extensionsRuntime = new BrowserExtensionsRuntime();

  const appendRuntimeEvent = ({
    kind,
    level,
    message,
    source,
    line,
    column,
    stack,
  }: {
    kind: BrowserRuntimeEventKind;
    level: BrowserRuntimeEventLevel;
    message: string;
    source?: string;
    line?: number;
    column?: number;
    stack?: string;
  }): void => {
    const text = truncateRuntimeMessage(`${message ?? ""}`.trim() || "<empty>");
    runtimeEventSeq += 1;
    runtimeEvents.push({
      seq: runtimeEventSeq,
      ts: new Date().toISOString(),
      kind,
      level,
      message: text,
      ...(source ? { source } : {}),
      ...(line != null ? { line } : {}),
      ...(column != null ? { column } : {}),
      ...(stack ? { stack: truncateRuntimeMessage(stack) } : {}),
      ...(typeof location !== "undefined" && location.href
        ? { url: `${location.href}` }
        : {}),
    });
    if (runtimeEvents.length > MAX_RUNTIME_EVENTS) {
      const drop = runtimeEvents.length - MAX_RUNTIME_EVENTS;
      runtimeEvents.splice(0, drop);
      runtimeEventsDropped += drop;
    }
  };

  const installRuntimeCapture = (): void => {
    const g = globalThis as any;
    g.__cocalc_browser_runtime_capture_emit = appendRuntimeEvent;
    if (g.__cocalc_browser_runtime_capture_installed) {
      return;
    }
    g.__cocalc_browser_runtime_capture_installed = true;

    const originalConsole = {
      trace: console.trace,
      debug: console.debug,
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const bindMethod = (name: keyof typeof originalConsole): ((...args: any[]) => void) => {
      const original = originalConsole[name];
      if (typeof original !== "function") {
        return (..._args: any[]) => {};
      }
      return (...args: any[]) => {
        try {
          const level = name as BrowserRuntimeEventLevel;
          const message = args
            .map((x) => safeStringifyForRuntimeLog(x))
            .filter((x) => x.length > 0)
            .join(" ");
          const emit = (globalThis as any).__cocalc_browser_runtime_capture_emit;
          emit?.({
            kind: "console",
            level,
            message,
          });
        } catch {
          // ignore capture failures
        }
        try {
          (original as any).apply(console, args);
        } catch {
          // ignore console errors
        }
      };
    };
    console.trace = bindMethod("trace");
    console.debug = bindMethod("debug");
    console.log = bindMethod("log");
    console.info = bindMethod("info");
    console.warn = bindMethod("warn");
    console.error = bindMethod("error");

    globalThis.addEventListener("error", (event: ErrorEvent) => {
      try {
        const emit = (globalThis as any).__cocalc_browser_runtime_capture_emit;
        emit?.({
          kind: "uncaught_error",
          level: "error",
          message:
            `${event?.message ?? ""}`.trim() ||
            safeStringifyForRuntimeLog((event as any)?.error),
          source: `${event?.filename ?? ""}`.trim() || undefined,
          line:
            Number.isFinite(Number(event?.lineno ?? NaN))
              ? Number(event?.lineno)
              : undefined,
          column:
            Number.isFinite(Number(event?.colno ?? NaN))
              ? Number(event?.colno)
              : undefined,
          stack:
            `${(event as any)?.error?.stack ?? ""}`.trim() || undefined,
        });
      } catch {
        // ignore capture failures
      }
    });
    globalThis.addEventListener(
      "unhandledrejection",
      (event: PromiseRejectionEvent) => {
        try {
          const reason = (event as any)?.reason;
          const message = safeStringifyForRuntimeLog(reason);
          const emit = (globalThis as any).__cocalc_browser_runtime_capture_emit;
          emit?.({
            kind: "unhandled_rejection",
            level: "error",
            message: message.trim() || "<unhandled rejection>",
            stack:
              typeof reason === "object" && reason != null
                ? `${(reason as any)?.stack ?? ""}`.trim() || undefined
                : undefined,
          });
        } catch {
          // ignore capture failures
        }
      },
    );
  };
  installRuntimeCapture();

  const pruneInternalTraceReplySubjects = (now: number = Date.now()): void => {
    for (const [subject, expiry] of internalTraceReplySubjects.entries()) {
      if (expiry <= now) {
        internalTraceReplySubjects.delete(subject);
      }
    }
    if (internalTraceReplySubjects.size <= MAX_NETWORK_TRACE_INTERNAL_SUBJECTS) {
      return;
    }
    const entries = [...internalTraceReplySubjects.entries()].sort(
      (a, b) => a[1] - b[1],
    );
    const extra =
      internalTraceReplySubjects.size - MAX_NETWORK_TRACE_INTERNAL_SUBJECTS;
    for (let i = 0; i < extra; i += 1) {
      internalTraceReplySubjects.delete(entries[i][0]);
    }
  };

  const rememberInternalTraceReplySubject = (subject: string): void => {
    const clean = `${subject ?? ""}`.trim();
    if (!clean) return;
    const now = Date.now();
    pruneInternalTraceReplySubjects(now);
    internalTraceReplySubjects.set(
      clean,
      now + NETWORK_TRACE_INTERNAL_SUBJECT_TTL_MS,
    );
  };

  const isInternalTraceReplySubject = (subject: string): boolean => {
    const clean = `${subject ?? ""}`.trim();
    if (!clean) return false;
    const now = Date.now();
    const expiry = internalTraceReplySubjects.get(clean);
    if (expiry == null) {
      return false;
    }
    if (expiry <= now) {
      internalTraceReplySubjects.delete(clean);
      return false;
    }
    return true;
  };

  const extractInternalTraceMethodName = (
    decodedPreview: unknown,
  ): string | undefined => {
    const text = `${decodedPreview ?? ""}`.trim();
    if (!text) return undefined;
    try {
      const row = JSON.parse(text) as { name?: unknown };
      const name = `${row?.name ?? ""}`.trim();
      return name || undefined;
    } catch {
      return undefined;
    }
  };

  const getReplySubjectFromHeaders = (headers: unknown): string | undefined => {
    if (!headers || typeof headers !== "object") {
      return undefined;
    }
    const row = headers as Record<string, unknown>;
    const reply = `${row["CN-Reply"] ?? ""}`.trim();
    return reply || undefined;
  };

  const removeBufferedEventsByChunkAndSubject = ({
    chunk_id,
    subject,
  }: {
    chunk_id?: string;
    subject: string;
  }): void => {
    const chunkId = `${chunk_id ?? ""}`.trim();
    if (!chunkId) return;
    for (let i = networkTraceEvents.length - 1; i >= 0; i -= 1) {
      const event = networkTraceEvents[i];
      if (
        `${event.chunk_id ?? ""}`.trim() === chunkId &&
        `${event.subject ?? ""}`.trim() === subject
      ) {
        networkTraceEvents.splice(i, 1);
      }
    }
  };

  const isProtocolEnabled = (protocol: BrowserNetworkTraceProtocol): boolean =>
    networkTraceConfig.protocols.includes(protocol);

  const toUrlOrigin = (value: unknown): string => {
    const text = `${value ?? ""}`.trim();
    if (!text) return "";
    try {
      return new URL(text, globalThis?.location?.href).origin;
    } catch {
      return "";
    }
  };

  const toByteLength = (value: unknown): number | undefined => {
    if (value == null) return undefined;
    if (typeof value === "string") {
      return value.length;
    }
    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    if (ArrayBuffer.isView(value)) {
      return value.byteLength;
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      return value.size;
    }
    return undefined;
  };

  const safeDecodedPreview = (value: unknown): string | undefined => {
    const text = safeStringifyForRuntimeLog(value).trim();
    if (!text) return undefined;
    return truncateRuntimeMessage(text).slice(
      0,
      Math.max(1, networkTraceConfig.max_preview_chars),
    );
  };

  type PendingNetworkTraceEvent = Omit<BrowserNetworkTraceEvent, "seq" | "ts" | "url">;

  const appendBufferedNetworkTraceEvent = (
    event: PendingNetworkTraceEvent,
  ): void => {
    if (!networkTraceConfig.enabled) {
      return;
    }
    if (!isProtocolEnabled(event.protocol)) {
      return;
    }
    const subject = `${event.subject ?? ""}`.trim();
    if (event.protocol === "conat" && !networkTraceConfig.include_internal) {
      if (isInternalTraceReplySubject(subject)) {
        return;
      }
      if (
        `${event.phase ?? ""}`.trim() === "recv_message" &&
        subject.includes(".browser-session")
      ) {
        const methodName = extractInternalTraceMethodName(event.decoded_preview);
        if (methodName != null && INTERNAL_TRACE_METHODS.has(methodName)) {
          const replySubject = getReplySubjectFromHeaders(event.headers);
          if (replySubject) {
            rememberInternalTraceReplySubject(replySubject);
          }
          removeBufferedEventsByChunkAndSubject({
            chunk_id: `${event.chunk_id ?? ""}`.trim() || undefined,
            subject,
          });
          return;
        }
      }
    }
    if (networkTraceConfig.subject_prefixes.length > 0) {
      const ok = networkTraceConfig.subject_prefixes.some((prefix) =>
        subject.startsWith(prefix),
      );
      if (!ok) {
        return;
      }
    }
    const address = `${event.address ?? ""}`.trim();
    if (
      networkTraceConfig.addresses.length > 0 &&
      !networkTraceConfig.addresses.includes(address)
    ) {
      return;
    }
    const decodedPreviewRaw = `${event.decoded_preview ?? ""}`.trim();
    const decoded_preview =
      networkTraceConfig.include_decoded && decodedPreviewRaw
        ? decodedPreviewRaw
        : undefined;
    networkTraceSeq += 1;
    networkTraceEvents.push({
      ...event,
      ...(decoded_preview ? { decoded_preview } : { decoded_preview: undefined }),
      seq: networkTraceSeq,
      ts: new Date().toISOString(),
      ...(typeof location !== "undefined" && location.href
        ? { url: `${location.href}` }
        : {}),
    });
    if (networkTraceEvents.length > networkTraceConfig.max_events) {
      const drop = networkTraceEvents.length - networkTraceConfig.max_events;
      networkTraceEvents.splice(0, drop);
      networkTraceDropped += drop;
    }
  };

  const appendConatNetworkTraceEvent = (event: ConatTraceEvent): void => {
    const direction = `${event.direction ?? ""}`.trim() as BrowserNetworkTraceDirection;
    const phase = `${event.phase ?? ""}`.trim() as BrowserNetworkTracePhase;
    appendBufferedNetworkTraceEvent({
      protocol: "conat",
      direction,
      phase,
      ...(event.client_id ? { client_id: `${event.client_id}` } : {}),
      ...(event.address ? { address: `${event.address}` } : {}),
      ...(event.subject ? { subject: `${event.subject}` } : {}),
      ...(event.chunk_id ? { chunk_id: `${event.chunk_id}` } : {}),
      ...(event.chunk_seq != null ? { chunk_seq: Number(event.chunk_seq) } : {}),
      ...(event.chunk_done != null ? { chunk_done: !!event.chunk_done } : {}),
      ...(event.chunk_bytes != null ? { chunk_bytes: Number(event.chunk_bytes) } : {}),
      ...(event.raw_bytes != null ? { raw_bytes: Number(event.raw_bytes) } : {}),
      ...(event.encoding != null ? { encoding: Number(event.encoding) } : {}),
      ...(event.headers ? { headers: event.headers as Record<string, unknown> } : {}),
      ...(event.decoded_preview ? { decoded_preview: `${event.decoded_preview}` } : {}),
      ...(event.decode_error ? { decode_error: `${event.decode_error}` } : {}),
      ...(event.message ? { message: `${event.message}` } : {}),
    });
  };

  const ensureConatTraceListener = (): void => {
    if (!networkTraceConfig.enabled || !isProtocolEnabled("conat")) {
      if (stopConatTraceListener) {
        stopConatTraceListener();
        stopConatTraceListener = undefined;
      }
      return;
    }
    if (stopConatTraceListener) {
      return;
    }
    stopConatTraceListener = onConatTrace((event) => {
      try {
        appendConatNetworkTraceEvent(event);
      } catch {
        // ignore trace buffering errors
      }
    });
  };

  const installNetworkTransportCapture = (): void => {
    const g = globalThis as any;
    if (g.__cocalc_browser_network_capture_installed) {
      return;
    }
    g.__cocalc_browser_network_capture_installed = true;

    const emitHttp = (event: PendingNetworkTraceEvent): void => {
      try {
        appendBufferedNetworkTraceEvent(event);
      } catch {
        // ignore capture failures
      }
    };
    const emitWs = (event: PendingNetworkTraceEvent): void => {
      try {
        appendBufferedNetworkTraceEvent(event);
      } catch {
        // ignore capture failures
      }
    };

    const originalFetch = typeof g.fetch === "function" ? g.fetch.bind(g) : undefined;
    if (originalFetch) {
      g.fetch = async (...args: any[]) => {
        const input = args[0];
        const init = args[1];
        const method = `${init?.method ?? input?.method ?? "GET"}`.toUpperCase();
        const target_url = `${input?.url ?? input ?? ""}`.trim();
        const started = Date.now();
        emitHttp({
          protocol: "http",
          direction: "send",
          phase: "http_request",
          address: toUrlOrigin(target_url),
          target_url,
          method,
          chunk_bytes: toByteLength(init?.body),
          ...(networkTraceConfig.include_decoded
            ? { decoded_preview: safeDecodedPreview(init?.body) }
            : {}),
        });
        try {
          const resp = await originalFetch(...args);
          const duration_ms = Date.now() - started;
          const contentLength = Number(resp?.headers?.get?.("content-length"));
          emitHttp({
            protocol: "http",
            direction: "recv",
            phase: "http_response",
            address: toUrlOrigin(resp?.url ?? target_url),
            target_url: `${resp?.url ?? target_url}`,
            method,
            status: Number(resp?.status),
            duration_ms,
            raw_bytes: Number.isFinite(contentLength) ? contentLength : undefined,
            message: `${resp?.status ?? ""} ${resp?.statusText ?? ""}`.trim(),
          });
          return resp;
        } catch (err) {
          emitHttp({
            protocol: "http",
            direction: "recv",
            phase: "http_error",
            address: toUrlOrigin(target_url),
            target_url,
            method,
            duration_ms: Date.now() - started,
            message: `${err}`,
          });
          throw err;
        }
      };
    }

    const OriginalXHR = g.XMLHttpRequest;
    if (typeof OriginalXHR === "function") {
      const open0 = OriginalXHR.prototype.open;
      const send0 = OriginalXHR.prototype.send;
      const setRequestHeader0 = OriginalXHR.prototype.setRequestHeader;
      OriginalXHR.prototype.open = function (...args: any[]) {
        (this as any).__cocalc_trace_method = `${args[0] ?? "GET"}`.toUpperCase();
        (this as any).__cocalc_trace_target_url = `${args[1] ?? ""}`.trim();
        (this as any).__cocalc_trace_headers = {};
        (this as any).__cocalc_trace_finished = false;
        return open0.apply(this, args);
      };
      OriginalXHR.prototype.setRequestHeader = function (name: string, value: string) {
        try {
          const h = ((this as any).__cocalc_trace_headers ??= {});
          h[`${name ?? ""}`] = `${value ?? ""}`;
        } catch {}
        return setRequestHeader0.apply(this, [name, value]);
      };
      OriginalXHR.prototype.send = function (...args: any[]) {
        const method = `${(this as any).__cocalc_trace_method ?? "GET"}`;
        const target_url = `${(this as any).__cocalc_trace_target_url ?? ""}`.trim();
        const started = Date.now();
        emitHttp({
          protocol: "http",
          direction: "send",
          phase: "http_request",
          address: toUrlOrigin(target_url),
          target_url,
          method,
          chunk_bytes: toByteLength(args[0]),
          headers: (this as any).__cocalc_trace_headers,
          ...(networkTraceConfig.include_decoded
            ? { decoded_preview: safeDecodedPreview(args[0]) }
            : {}),
        });
        const emitDone = (phase: BrowserNetworkTracePhase, message?: string) => {
          if ((this as any).__cocalc_trace_finished) {
            return;
          }
          (this as any).__cocalc_trace_finished = true;
          const contentLength = Number(this.getResponseHeader?.("content-length"));
          emitHttp({
            protocol: "http",
            direction: "recv",
            phase,
            address: toUrlOrigin(this.responseURL || target_url),
            target_url: `${this.responseURL || target_url}`,
            method,
            status: Number(this.status),
            duration_ms: Date.now() - started,
            raw_bytes: Number.isFinite(contentLength) ? contentLength : undefined,
            message,
          });
        };
        this.addEventListener(
          "loadend",
          () => emitDone("http_response", `${this.status ?? ""}`.trim()),
          { once: true },
        );
        this.addEventListener("error", () => emitDone("http_error", "xhr error"), {
          once: true,
        });
        this.addEventListener("timeout", () => emitDone("http_error", "xhr timeout"), {
          once: true,
        });
        this.addEventListener("abort", () => emitDone("http_error", "xhr abort"), {
          once: true,
        });
        return send0.apply(this, args);
      };
    }

    const OriginalWebSocket = g.WebSocket;
    if (typeof OriginalWebSocket === "function") {
      const PatchedWebSocket = function (this: any, url: any, protocols?: any) {
        const ws =
          protocols === undefined
            ? new OriginalWebSocket(url)
            : new OriginalWebSocket(url, protocols);
        const target_url = `${url ?? ""}`.trim();
        const address = toUrlOrigin(target_url);
        ws.addEventListener("open", () => {
          emitWs({
            protocol: "ws",
            direction: "recv",
            phase: "ws_open",
            address,
            target_url,
          });
        });
        ws.addEventListener("message", (ev: MessageEvent) => {
          emitWs({
            protocol: "ws",
            direction: "recv",
            phase: "ws_message",
            address,
            target_url,
            chunk_bytes: toByteLength(ev.data),
            ...(networkTraceConfig.include_decoded
              ? { decoded_preview: safeDecodedPreview(ev.data) }
              : {}),
          });
        });
        ws.addEventListener("close", (ev: CloseEvent) => {
          emitWs({
            protocol: "ws",
            direction: "recv",
            phase: "ws_close",
            address,
            target_url,
            status: Number(ev.code),
            message: `${ev.reason ?? ""}`.trim() || `ws close code=${ev.code}`,
          });
        });
        ws.addEventListener("error", () => {
          emitWs({
            protocol: "ws",
            direction: "recv",
            phase: "ws_error",
            address,
            target_url,
            message: "ws error",
          });
        });
        const send0 = ws.send.bind(ws);
        ws.send = (data: any) => {
          emitWs({
            protocol: "ws",
            direction: "send",
            phase: "ws_send",
            address,
            target_url,
            chunk_bytes: toByteLength(data),
            ...(networkTraceConfig.include_decoded
              ? { decoded_preview: safeDecodedPreview(data) }
              : {}),
          });
          return send0(data);
        };
        return ws;
      } as any;
      PatchedWebSocket.prototype = OriginalWebSocket.prototype;
      Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
      g.WebSocket = PatchedWebSocket;
    }
  };
  installNetworkTransportCapture();

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

  const getExecOp = (exec_id: string): BrowserExecPendingOperation => {
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

  const getEditorActionsForPath = async ({
    project_id,
    path,
    foreground = false,
    foreground_project = false,
    timeout_ms = 15_000,
  }: {
    project_id: string;
    path: string;
    foreground?: boolean;
    foreground_project?: boolean;
    timeout_ms?: number;
  }): Promise<any> => {
    if (!isValidUUID(project_id)) {
      throw Error("project_id must be a UUID");
    }
    const cleanPath = requireAbsolutePath(path);
    await openFileInProject({
      project_id,
      path: cleanPath,
      foreground,
      foreground_project,
    });
    const started = Date.now();
    while (Date.now() - started < timeout_ms) {
      const editorActions = redux.getEditorActions(project_id, cleanPath) as any;
      if (editorActions != null) {
        return editorActions;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(`editor actions unavailable for ${cleanPath}`);
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
    const editorActions = await getEditorActionsForPath({
      project_id,
      path: cleanPath,
      foreground: false,
      foreground_project: false,
    });
    const jupyterActions = editorActions?.jupyter_actions;
    if (jupyterActions == null) {
      throw Error(`jupyter actions unavailable for ${cleanPath}`);
    }
    if (typeof jupyterActions.wait_until_ready === "function") {
      await jupyterActions.wait_until_ready();
    }
    return jupyterActions;
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
    const heldTerminalClients = new Map<string, ProjectTerminalClient>();

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

    const toTerminalSessionPath = ({
      parentPath,
      node,
    }: {
      parentPath: string;
      node: any;
    }): string | undefined => {
      const number = Number(node?.get?.("number"));
      if (!Number.isFinite(number) || number < 0) {
        return undefined;
      }
      const command = normalizeTerminalFrameCommand(node?.get?.("command"));
      const cmd = terminalCommandSuffix(command);
      return termPath({
        path: requireAbsolutePath(parentPath),
        number: Math.floor(number),
        cmd,
      });
    };

    const listOpenTerminalFramesForPath = async (
      path: string,
    ): Promise<BrowserTerminalFrameInfo[]> => {
      assertExecNotCanceled(isCanceled);
      const cleanPath = requireAbsolutePath(path);
      const editorActions = redux.getEditorActions(project_id, cleanPath) as any;
      if (
        editorActions == null ||
        typeof editorActions._get_leaf_ids !== "function" ||
        typeof editorActions._get_frame_node !== "function"
      ) {
        return [];
      }
      const leafs = editorActions._get_leaf_ids() as Record<string, unknown>;
      const activeFrameId =
        typeof editorActions._get_active_id === "function"
          ? `${editorActions._get_active_id() ?? ""}`.trim()
          : "";
      const out: BrowserTerminalFrameInfo[] = [];
      for (const frame_id in leafs) {
        const node = editorActions._get_frame_node(frame_id);
        const type = `${node?.get?.("type") ?? ""}`;
        if (!type.startsWith("terminal")) continue;
        const command = normalizeTerminalFrameCommand(node?.get?.("command"));
        const args = normalizeTerminalFrameArgs(node?.get?.("args"));
        const title = `${node?.get?.("title") ?? ""}`.trim() || undefined;
        const number = Number(node?.get?.("number"));
        const session_path = toTerminalSessionPath({ parentPath: cleanPath, node });
        out.push({
          parent_path: cleanPath,
          frame_id,
          type,
          active: activeFrameId === frame_id,
          ...(Number.isFinite(number) ? { number: Math.floor(number) } : {}),
          ...(command ? { command } : {}),
          ...(args.length > 0 ? { args } : {}),
          ...(title ? { title } : {}),
          ...(session_path ? { session_path } : {}),
        });
      }
      return out;
    };

    const sanitizeTerminalDirection = (
      value: unknown,
    ): "row" | "col" => {
      return `${value ?? "col"}`.trim() === "row" ? "row" : "col";
    };

    const getHeldTerminalClient = async (
      session_path: string,
      options?: BrowserTerminalSpawnOptions,
    ): Promise<{
      session_path: string;
      client: ProjectTerminalClient;
      command: string;
      args: string[];
      history: string;
      pid?: number;
    }> => {
      assertExecNotCanceled(isCanceled);
      const cleanSessionPath = requireAbsolutePath(session_path, "session_path");
      const clean = sanitizeTerminalSpawnOptions(options);
      const command = clean.command ?? "bash";
      const args = clean.args ?? [];
      let entry = heldTerminalClients.get(cleanSessionPath);
      if (!entry) {
        entry = terminalClient({
          project_id,
          client: conat(),
        });
        heldTerminalClients.set(cleanSessionPath, entry);
      }
      const history = await entry.spawn(command, args, {
        id: cleanSessionPath,
        ...(clean.cwd ? { cwd: clean.cwd } : {}),
        ...(clean.env ? { env: clean.env } : {}),
        ...(clean.env0 ? { env0: clean.env0 } : {}),
        ...(clean.rows != null ? { rows: clean.rows } : {}),
        ...(clean.cols != null ? { cols: clean.cols } : {}),
        ...(clean.timeout != null ? { timeout: clean.timeout } : {}),
        ...(clean.handleFlowControl != null
          ? { handleFlowControl: clean.handleFlowControl }
          : {}),
      });
      assertExecNotCanceled(isCanceled);
      return {
        session_path: cleanSessionPath,
        client: entry,
        command,
        args,
        history: `${history ?? ""}`,
        ...(Number.isFinite(entry.pid) ? { pid: entry.pid } : {}),
      };
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
      const terminals = [...heldTerminalClients.values()];
      heldTerminalClients.clear();
      for (const terminal of terminals) {
        try {
          terminal.close();
        } catch {
          // ignore terminal close failures during cleanup
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
      terminal: {
        listOpen: async (): Promise<BrowserTerminalFrameInfo[]> => {
          assertExecNotCanceled(isCanceled);
          const snapshot = buildSessionSnapshot(client);
          const openFiles = flattenOpenFiles(snapshot.open_projects).filter(
            (file) => file.project_id === project_id,
          );
          const seen = new Set<string>();
          const out: BrowserTerminalFrameInfo[] = [];
          for (const file of openFiles) {
            const path = requireAbsolutePath(file.path);
            if (seen.has(path)) continue;
            seen.add(path);
            const rows = await listOpenTerminalFramesForPath(path);
            out.push(...rows);
          }
          return out;
        },
        openSplit: async (
          path: string,
          opts?: {
            direction?: "row" | "col";
            anchor_frame_id?: string;
            command?: string;
            args?: string[];
            no_focus?: boolean;
            first?: boolean;
          },
        ): Promise<BrowserTerminalFrameInfo> => {
          assertExecNotCanceled(isCanceled);
          const cleanPath = requireAbsolutePath(path);
          const direction = sanitizeTerminalDirection(opts?.direction);
          const command = normalizeTerminalFrameCommand(opts?.command);
          const args = Array.isArray(opts?.args)
            ? opts.args.map((x) => `${x ?? ""}`)
            : undefined;
          const editorActions = await getEditorActionsForPath({
            project_id,
            path: cleanPath,
            foreground: true,
            foreground_project: true,
          });
          const anchor_frame_id = `${opts?.anchor_frame_id ?? ""}`.trim();
          const targetId =
            anchor_frame_id ||
            (typeof editorActions?._get_active_id === "function"
              ? `${editorActions._get_active_id() ?? ""}`.trim()
              : "");
          if (!targetId) {
            throw Error("unable to determine anchor frame for split");
          }
          const frame_id = editorActions.split_frame(
            direction,
            targetId,
            "terminal",
            {
              ...(command ? { command } : {}),
              ...(args != null ? { args } : {}),
            },
            !!opts?.first,
            !!opts?.no_focus,
          );
          if (!frame_id) {
            throw Error(`unable to create terminal split for ${cleanPath}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          const rows = await listOpenTerminalFramesForPath(cleanPath);
          const row = rows.find((x) => x.frame_id === frame_id);
          if (row != null) {
            return row;
          }
          return {
            parent_path: cleanPath,
            frame_id,
            type: "terminal",
            active: !opts?.no_focus,
          };
        },
        spawn: async (
          session_path: string,
          options?: BrowserTerminalSpawnOptions,
        ): Promise<BrowserTerminalSessionInfo> => {
          assertExecNotCanceled(isCanceled);
          const attached = await getHeldTerminalClient(session_path, options);
          return {
            session_path: attached.session_path,
            command: attached.command,
            args: attached.args,
            ...(attached.pid != null ? { pid: attached.pid } : {}),
            history_chars: attached.history.length,
          };
        },
        write: async (
          session_path: string,
          data: string,
          opts?: { kind?: "user" | "auto" },
        ): Promise<{ ok: true }> => {
          assertExecNotCanceled(isCanceled);
          const payload = `${data ?? ""}`;
          if (!payload.length) {
            throw Error("data must be specified");
          }
          const attached = await getHeldTerminalClient(session_path);
          const kind = opts?.kind === "auto" ? "auto" : "user";
          attached.client.socket.write(
            kind === "auto" ? { data: payload, kind } : payload,
          );
          return { ok: true };
        },
        history: async (
          session_path: string,
          opts?: BrowserTerminalHistoryOptions,
        ): Promise<string> => {
          assertExecNotCanceled(isCanceled);
          const attached = await getHeldTerminalClient(session_path);
          const history = `${await attached.client.history()}`;
          const cleanOpts = sanitizeTerminalHistoryOptions(opts);
          if (
            cleanOpts.max_chars != null &&
            cleanOpts.max_chars > 0 &&
            history.length > cleanOpts.max_chars
          ) {
            return history.slice(history.length - cleanOpts.max_chars);
          }
          return history;
        },
        state: async (session_path: string): Promise<"running" | "off"> => {
          assertExecNotCanceled(isCanceled);
          const attached = await getHeldTerminalClient(session_path);
          return await attached.client.state();
        },
        cwd: async (session_path: string): Promise<string | undefined> => {
          assertExecNotCanceled(isCanceled);
          const attached = await getHeldTerminalClient(session_path);
          const cwd = await attached.client.cwd();
          const clean = `${cwd ?? ""}`.trim();
          return clean.length > 0 ? clean : undefined;
        },
        resize: async (
          session_path: string,
          opts: { rows: number; cols: number },
        ): Promise<{ ok: true }> => {
          assertExecNotCanceled(isCanceled);
          const rows = asFinitePositive(opts?.rows);
          const cols = asFinitePositive(opts?.cols);
          if (rows == null || cols == null) {
            throw Error("rows and cols must be positive numbers");
          }
          const attached = await getHeldTerminalClient(session_path);
          await attached.client.resize({
            rows: Math.floor(rows),
            cols: Math.floor(cols),
          });
          return { ok: true };
        },
        destroy: async (session_path: string): Promise<{ ok: true }> => {
          assertExecNotCanceled(isCanceled);
          const cleanSessionPath = requireAbsolutePath(
            session_path,
            "session_path",
          );
          const attached = await getHeldTerminalClient(cleanSessionPath);
          await attached.client.destroy();
          try {
            attached.client.close();
          } catch {
            // ignore close race
          }
          heldTerminalClients.delete(cleanSessionPath);
          return { ok: true };
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
      extensions: {
        list: (): BrowserExtensionApiSummary[] => {
          assertExecNotCanceled(isCanceled);
          return extensionsRuntime.list();
        },
        installHelloWorld: async (
          options?: BrowserInstallHelloOptions,
        ): Promise<BrowserExtensionApiSummary> => {
          assertExecNotCanceled(isCanceled);
          return await extensionsRuntime.installHelloWorld(options);
        },
        uninstall: (id: string): { ok: true; id: string } => {
          assertExecNotCanceled(isCanceled);
          return extensionsRuntime.uninstall(id);
        },
      },
    };
    return { api, cleanup };
  };

  const executeBrowserScriptRaw = async ({
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

  const executeBrowserScriptQuickJSSandbox = async ({
    project_id,
    code,
    policy,
    isCanceled,
  }: {
    project_id: string;
    code: string;
    policy?: BrowserExecPolicyV1;
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

    const QuickJS = await getQuickJSAsyncifyModule();
    const vm = QuickJS.newContext();
    let actionCount = 0;
    const actionResults: BrowserActionResult[] = [];
    try {
      const executeAction = vm.newAsyncifiedFunction(
        "__exec_action_json",
        async (payloadHandle) => {
          assertExecNotCanceled(isCanceled);
          const payloadJson = vm.getString(payloadHandle);
          if (payloadJson.length > MAX_SANDBOX_ACTION_JSON_LENGTH) {
            throw Error(
              `sandbox action payload is too large (${payloadJson.length} chars); max ${MAX_SANDBOX_ACTION_JSON_LENGTH}`,
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(payloadJson);
          } catch (err) {
            throw Error(`sandbox action payload must be valid JSON: ${err}`);
          }
          if (!parsed || typeof parsed !== "object") {
            throw Error("sandbox action payload must be an object");
          }
          const row = parsed as Record<string, unknown>;
          const name = `${row.name ?? ""}`.trim();
          if (!isAllowedActionName(name) || name === "batch") {
            throw Error(
              `sandbox action name '${name || "<empty>"}' is not supported`,
            );
          }
          if (actionCount >= MAX_SANDBOX_ACTIONS) {
            throw Error(
              `sandbox action count exceeded max ${MAX_SANDBOX_ACTIONS}`,
            );
          }
          const action = parsed as BrowserAtomicActionRequest;
          enforceActionPolicy({
            project_id,
            action_name: name as BrowserActionName,
            posture: "prod",
            policy,
          });
          const result = await executeBrowserAction({ project_id, action });
          actionCount += 1;
          actionResults.push(result);
          return vm.newString(JSON.stringify(toSerializableValue(result)));
        },
      );
      executeAction.consume((fn) =>
        vm.setProp(vm.global, "__exec_action_json", fn),
      );

      const sandboxMeta = vm.newString(
        JSON.stringify({
          project_id,
          page_url: `${location.href ?? ""}`,
          origin: `${location.origin ?? ""}`,
        }),
      );
      vm.setProp(vm.global, "__sandbox_meta_json", sandboxMeta);
      sandboxMeta.dispose();

      const prelude = `
(() => {
  const __meta = JSON.parse(globalThis.__sandbox_meta_json || "{}");
  const __exec = (name, payload) =>
    JSON.parse(globalThis.__exec_action_json(JSON.stringify({ name, ...(payload || {}) })));
  const api = Object.freeze({
    projectId: __meta.project_id,
    pageUrl: __meta.page_url,
    origin: __meta.origin,
    action: (name, payload = {}) => __exec(name, payload),
    navigate: (url, opts = {}) => __exec("navigate", { url, ...opts }),
    click: (selector, opts = {}) => __exec("click", { selector, ...opts }),
    clickAt: (x, y, opts = {}) => __exec("click_at", { x, y, ...opts }),
    drag: (x1, y1, x2, y2, opts = {}) => __exec("drag", { x1, y1, x2, y2, ...opts }),
    type: (selector, text, opts = {}) => __exec("type", { selector, text, ...opts }),
    press: (key, opts = {}) => __exec("press", { key, ...opts }),
    reload: (opts = {}) => __exec("reload", opts),
    scrollBy: (dy, dx = 0, opts = {}) => __exec("scroll_by", { dy, dx, ...opts }),
    scrollTo: (opts = {}) => __exec("scroll_to", opts),
    waitForSelector: (selector, opts = {}) => __exec("wait_for_selector", { selector, ...opts }),
    waitForUrl: (opts = {}) => __exec("wait_for_url", opts),
  });
  globalThis.api = api;
})();`;
      const preludeResult = vm.evalCode(prelude);
      if (preludeResult.error) {
        const message = vm.dump(preludeResult.error);
        if (preludeResult.error.alive) {
          preludeResult.error.dispose();
        }
        throw Error(`failed to initialize quickjs sandbox api: ${message}`);
      }
      if (preludeResult.value.alive) {
        preludeResult.value.dispose();
      }

      const scriptResult = await vm.evalCodeAsync(
        `(() => { ${script}\n})()`,
      );
      let sandboxValue: unknown;
      if (scriptResult.error) {
        const message = vm.dump(scriptResult.error);
        if (scriptResult.error.alive) {
          scriptResult.error.dispose();
        }
        throw Error(`quickjs sandbox execution failed: ${message}`);
      } else {
        sandboxValue = vm.dump(scriptResult.value);
        if (scriptResult.value.alive) {
          scriptResult.value.dispose();
        }
      }

      return toSerializableValue({
        mode: "quickjs_wasm",
        script_result: toSerializableValue(sandboxValue),
        action_count: actionCount,
        ...(actionResults.length > 0 ? { actions: actionResults } : {}),
      });
    } finally {
      vm.dispose();
    }
  };

  const executeBrowserScript = async ({
    project_id,
    code,
    mode,
    policy,
    isCanceled,
  }: {
    project_id: string;
    code: string;
    mode: BrowserExecMode;
    policy?: BrowserExecPolicyV1;
    isCanceled?: () => boolean;
  }): Promise<unknown> => {
    if (mode === "quickjs_wasm") {
      return await executeBrowserScriptQuickJSSandbox({
        project_id,
        code,
        policy,
        isCanceled,
      });
    }
    return await executeBrowserScriptRaw({ project_id, code, isCanceled });
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

  const toPublicExecOp = (op: BrowserExecPendingOperation): BrowserExecOperation => {
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

  const runExecOperation = async (op: BrowserExecPendingOperation) => {
    if (op.status !== "pending") return;
    op.status = "running";
    op.started_at = new Date().toISOString();
    try {
      const result = await executeBrowserScript({
        project_id: op.project_id,
        code: op.code,
        mode: op.mode,
        policy: op.policy,
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
    configureNetworkTrace: async (opts) => {
      if (opts != null && typeof opts === "object") {
        if (opts.enabled != null) {
          networkTraceConfig.enabled = !!opts.enabled;
        }
        if (opts.include_decoded != null) {
          networkTraceConfig.include_decoded = !!opts.include_decoded;
        }
        if (opts.include_internal != null) {
          networkTraceConfig.include_internal = !!opts.include_internal;
        }
        if (Array.isArray(opts.protocols)) {
          const next = opts.protocols
            .map((x) => `${x ?? ""}`.trim().toLowerCase())
            .filter(
              (x): x is BrowserNetworkTraceProtocol =>
                x === "conat" || x === "http" || x === "ws",
            );
          networkTraceConfig.protocols =
            next.length > 0 ? [...new Set(next)] : [...ALL_NETWORK_TRACE_PROTOCOLS];
        }
        if (opts.max_events != null && Number.isFinite(Number(opts.max_events))) {
          networkTraceConfig.max_events = Math.max(
            100,
            Math.min(MAX_NETWORK_TRACE_EVENTS, Math.floor(Number(opts.max_events))),
          );
          if (networkTraceEvents.length > networkTraceConfig.max_events) {
            const drop = networkTraceEvents.length - networkTraceConfig.max_events;
            networkTraceEvents.splice(0, drop);
            networkTraceDropped += drop;
          }
        }
        if (
          opts.max_preview_chars != null &&
          Number.isFinite(Number(opts.max_preview_chars))
        ) {
          networkTraceConfig.max_preview_chars = Math.max(
            32,
            Math.min(20_000, Math.floor(Number(opts.max_preview_chars))),
          );
        }
        if (Array.isArray(opts.subject_prefixes)) {
          networkTraceConfig.subject_prefixes = opts.subject_prefixes
            .map((x) => `${x ?? ""}`.trim())
            .filter((x) => x.length > 0);
        }
        if (Array.isArray(opts.addresses)) {
          networkTraceConfig.addresses = opts.addresses
            .map((x) => `${x ?? ""}`.trim())
            .filter((x) => x.length > 0);
        }
      }
      ensureConatTraceListener();
      return {
        enabled: networkTraceConfig.enabled,
        include_decoded: networkTraceConfig.include_decoded,
        include_internal: networkTraceConfig.include_internal,
        protocols: [...networkTraceConfig.protocols],
        max_events: networkTraceConfig.max_events,
        max_preview_chars: networkTraceConfig.max_preview_chars,
        subject_prefixes: [...networkTraceConfig.subject_prefixes],
        addresses: [...networkTraceConfig.addresses],
        buffered: networkTraceEvents.length,
        dropped: networkTraceDropped,
        next_seq: networkTraceSeq,
      };
    },
    listNetworkTrace: async (opts) => {
      const after_seq = Number(opts?.after_seq ?? 0);
      const limitRaw = Number(opts?.limit ?? 200);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(MAX_NETWORK_TRACE_EVENTS, Math.floor(limitRaw)))
        : 200;
      const protocols =
        Array.isArray(opts?.protocols) && opts?.protocols.length > 0
          ? new Set(
              opts.protocols
                .map((x) => `${x ?? ""}`.trim().toLowerCase())
                .filter((x) => x.length > 0),
            )
          : opts?.protocol
            ? new Set([`${opts.protocol ?? ""}`.trim().toLowerCase()])
            : undefined;
      const direction = `${opts?.direction ?? ""}`.trim().toLowerCase();
      const phases =
        Array.isArray(opts?.phases) && opts?.phases.length > 0
          ? new Set(opts.phases.map((x) => `${x ?? ""}`.trim()))
          : undefined;
      const subjectPrefix = `${opts?.subject_prefix ?? ""}`.trim();
      const address = `${opts?.address ?? ""}`.trim();
      const includeDecoded =
        opts?.include_decoded == null
          ? networkTraceConfig.include_decoded
          : !!opts.include_decoded;
      const filtered = networkTraceEvents.filter((event) => {
        if (Number.isFinite(after_seq) && event.seq <= after_seq) {
          return false;
        }
        if (protocols && !protocols.has(`${event.protocol ?? ""}`)) {
          return false;
        }
        if (direction && event.direction !== direction) {
          return false;
        }
        if (phases && !phases.has(`${event.phase ?? ""}`)) {
          return false;
        }
        if (subjectPrefix && !`${event.subject ?? ""}`.startsWith(subjectPrefix)) {
          return false;
        }
        if (address && `${event.address ?? ""}` !== address) {
          return false;
        }
        return true;
      });
      const events = filtered
        .slice(Math.max(0, filtered.length - limit))
        .map((event) =>
          includeDecoded
            ? event
            : ({
                ...event,
                decoded_preview: undefined,
              }),
        );
      return {
        events,
        next_seq: networkTraceSeq,
        dropped: networkTraceDropped,
        total_buffered: networkTraceEvents.length,
      };
    },
    clearNetworkTrace: async () => {
      const cleared = networkTraceEvents.length;
      networkTraceEvents.length = 0;
      networkTraceDropped = 0;
      internalTraceReplySubjects.clear();
      return { ok: true, cleared, next_seq: networkTraceSeq };
    },
    listRuntimeEvents: async (opts) => {
      const after_seq = Number(opts?.after_seq ?? 0);
      const limitRaw = Number(opts?.limit ?? 200);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(5_000, Math.floor(limitRaw)))
        : 200;
      const kinds = new Set<BrowserRuntimeEventKind>(
        Array.isArray(opts?.kinds)
          ? opts.kinds
              .map((x) => `${x ?? ""}`.trim())
              .filter((x): x is BrowserRuntimeEventKind =>
                x === "console" ||
                x === "uncaught_error" ||
                x === "unhandled_rejection",
              )
          : [],
      );
      const levels = new Set<BrowserRuntimeEventLevel>(
        Array.isArray(opts?.levels)
          ? opts.levels
              .map((x) => `${x ?? ""}`.trim())
              .filter((x): x is BrowserRuntimeEventLevel =>
                x === "trace" ||
                x === "debug" ||
                x === "log" ||
                x === "info" ||
                x === "warn" ||
                x === "error",
              )
          : [],
      );
      const filtered = runtimeEvents.filter((event) => {
        if (Number.isFinite(after_seq) && event.seq <= after_seq) {
          return false;
        }
        if (kinds.size > 0 && !kinds.has(event.kind)) {
          return false;
        }
        if (levels.size > 0 && !levels.has(event.level)) {
          return false;
        }
        return true;
      });
      const events = filtered.slice(Math.max(0, filtered.length - limit));
      return {
        events,
        next_seq: runtimeEventSeq,
        dropped: runtimeEventsDropped,
        total_buffered: runtimeEvents.length,
      };
    },
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
    exec: async ({ project_id, code, posture, policy }) => {
      const enforced = resolveExecMode({ project_id, posture, policy });
      return {
        ok: true,
        result: await executeBrowserScript({
          project_id,
          code,
          mode: enforced.mode,
          policy: enforced.policy,
        }),
      };
    },
    action: async ({ project_id, action, posture, policy }) => {
      const actionName = `${(action as any)?.name ?? ""}`.trim() as BrowserActionName;
      if (!actionName) {
        throw Error("action.name must be specified");
      }
      enforceActionPolicy({
        project_id,
        action_name: actionName,
        posture,
        policy,
      });
      if (actionName === "batch") {
        const steps = Array.isArray((action as any)?.actions)
          ? ((action as any).actions as Array<{ name?: string }>)
          : [];
        for (let i = 0; i < steps.length; i++) {
          const stepName = `${steps[i]?.name ?? ""}`.trim() as BrowserActionName;
          if (!stepName || stepName === "batch") {
            throw Error(
              `invalid batch step ${i}: action name must be a non-empty non-batch action`,
            );
          }
          enforceActionPolicy({
            project_id,
            action_name: stepName,
            posture,
            policy,
          });
        }
      }
      return {
        ok: true,
        result: await executeBrowserAction({ project_id, action }),
      };
    },
    startExec: async ({ project_id, code, posture, policy }) => {
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
      const enforced = resolveExecMode({ project_id, posture, policy });
      const exec_id = createExecId();
      const op: BrowserExecPendingOperation = {
        exec_id,
        project_id,
        status: "pending",
        created_at: new Date().toISOString(),
        code: script,
        posture: enforced.posture,
        mode: enforced.mode,
        ...(enforced.policy ? { policy: enforced.policy } : {}),
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
        extensionsRuntime.clear();
        if (service) {
          service.close();
          service = undefined;
        }
      });
      runtimeEvents.length = 0;
      runtimeEventSeq = 0;
      runtimeEventsDropped = 0;
      networkTraceEvents.length = 0;
      networkTraceSeq = 0;
      networkTraceDropped = 0;
      internalTraceReplySubjects.clear();
      ensureConatTraceListener();
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
      runtimeEvents.length = 0;
      runtimeEventSeq = 0;
      runtimeEventsDropped = 0;
      networkTraceEvents.length = 0;
      networkTraceSeq = 0;
      networkTraceDropped = 0;
      internalTraceReplySubjects.clear();
      if (stopConatTraceListener) {
        stopConatTraceListener();
        stopConatTraceListener = undefined;
      }
      await closeAllManagedSyncDocs();
      extensionsRuntime.clear();
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
