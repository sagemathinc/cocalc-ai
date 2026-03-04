/*
Browser session automation bridge for frontend clients.

This module publishes a per-browser conat service and periodically heartbeats
browser session metadata to hub.system so CLI tools can discover and target a
specific live browser session.
*/

import { redux } from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import type { WebappClient } from "@cocalc/frontend/client/client";
import type { HubApi } from "@cocalc/conat/hub/api";
import {
  BrowserExtensionsRuntime,
} from "../extensions-runtime";
import { executeBrowserAction } from "./action-engine";
import {
  asFiniteNonNegative,
  asFinitePositive,
  asStringArray,
  asText,
  normalizeTerminalFrameArgs,
  normalizeTerminalFrameCommand,
  requireAbsolutePath,
  requireAbsolutePathOrList,
  sanitizePathList,
  splitAbsolutePath,
  terminalCommandSuffix,
  toNotifyMessage,
  toSerializableValue,
} from "./common-utils";
import { BROWSER_EXEC_API_DECLARATION } from "./exec-api-declaration";
import { buildSessionSnapshot, flattenOpenFiles } from "./snapshot";
import {
  asPlain,
  createExecId,
  enforceActionPolicy,
  isAllowedActionName,
  resolveExecMode,
  sanitizeBashOptions,
  sanitizeCellIdList,
  sanitizeCellUpdates,
  sanitizeNotifyOptions,
  sanitizeTerminalHistoryOptions,
  sanitizeTerminalSpawnOptions,
  simplifyNotebookOutput,
  type BrowserBashOptions,
  type BrowserExecMode,
  type BrowserNotifyType,
  type BrowserTerminalHistoryOptions,
  type BrowserTerminalSpawnOptions,
} from "./exec-utils";
import {
  closeFileInProject,
  getEditorActionsForPath,
  getJupyterActionsForPath,
  openFileInProject,
} from "./project-open-helpers";
import { createManagedSyncDocLeases } from "./syncdoc-leases";
import {
  type BrowserExecApi,
  type BrowserExecOutput,
  type BrowserExtensionApiSummary,
  type BrowserFsDirent,
  type BrowserFsDustOptions,
  type BrowserFsExecOutput,
  type BrowserFsFdOptions,
  type BrowserFsFindOptions,
  type BrowserFsRipgrepOptions,
  type BrowserFsStat,
  type BrowserInstallHelloOptions,
  type BrowserTerminalFrameInfo,
  type BrowserTerminalSessionInfo,
} from "./api-types";
import { createBrowserRuntimeObservability } from "./runtime-observability";
import {
  createBrowserSessionService,
  type BrowserAtomicActionRequest,
  type BrowserActionName,
  type BrowserActionResult,
  type BrowserAutomationPosture,
  type BrowserExecPolicyV1,
  type BrowserExecOperation,
  type BrowserOpenFileInfo,
  type BrowserSessionServiceApi,
} from "@cocalc/conat/service/browser-session";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import {
  terminalClient,
  type TerminalClient as ProjectTerminalClient,
} from "@cocalc/conat/project/terminal";
import { isValidUUID } from "@cocalc/util/misc";
import type { ConatService } from "@cocalc/conat/service";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { termPath } from "@cocalc/util/terminal/names";
import quickjsAsyncifyVariant from "@jitl/quickjs-wasmfile-release-asyncify";
import {
  memoizePromiseFactory,
  newQuickJSAsyncWASMModuleFromVariant,
} from "quickjs-emscripten-core";

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_RETRY_MS = 4_000;
const MAX_EXEC_CODE_LENGTH = 100_000;
const MAX_EXEC_OPS = 256;
const EXEC_OP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SANDBOX_ACTIONS = 512;
const MAX_SANDBOX_ACTION_JSON_LENGTH = 100_000;

const getQuickJSAsyncifyModule = memoizePromiseFactory(async () => {
  return await newQuickJSAsyncWASMModuleFromVariant(quickjsAsyncifyVariant);
});

export type BrowserSessionAutomation = {
  start: (account_id: string) => Promise<void>;
  stop: () => Promise<void>;
};


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
  const runtimeObservability = createBrowserRuntimeObservability();
  const syncDocLeases = createManagedSyncDocLeases({ conat });
  const extensionsRuntime = new BrowserExtensionsRuntime();

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
      const lease = await syncDocLeases.acquireManagedSyncDoc({
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
    configureNetworkTrace: async (opts) =>
      runtimeObservability.configureNetworkTrace(opts),
    listNetworkTrace: async (opts) =>
      runtimeObservability.listNetworkTrace(opts),
    clearNetworkTrace: async () => runtimeObservability.clearNetworkTrace(),
    listRuntimeEvents: async (opts) =>
      runtimeObservability.listRuntimeEvents(opts),
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
        await syncDocLeases.closeAllManagedSyncDocs();
        extensionsRuntime.clear();
        if (service) {
          service.close();
          service = undefined;
        }
      });
      runtimeObservability.reset();
      runtimeObservability.onStart();
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
      runtimeObservability.reset();
      runtimeObservability.stop();
      await syncDocLeases.closeAllManagedSyncDocs();
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
