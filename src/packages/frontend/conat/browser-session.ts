/*
Browser session automation bridge for frontend clients.

This module publishes a per-browser conat service and periodically heartbeats
browser session metadata to hub.system so CLI tools can discover and target a
specific live browser session.
*/

import { redux, project_redux_name } from "@cocalc/frontend/app-framework";
import type { WebappClient } from "@cocalc/frontend/client/client";
import type { HubApi } from "@cocalc/conat/hub/api";
import type { BrowserOpenProjectState } from "@cocalc/conat/hub/api/system";
import {
  createBrowserSessionService,
  type BrowserOpenFileInfo,
  type BrowserSessionServiceApi,
} from "@cocalc/conat/service/browser-session";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { isValidUUID } from "@cocalc/util/misc";
import type { ConatService } from "@cocalc/conat/service";

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_RETRY_MS = 4_000;
const MAX_OPEN_PROJECTS = 64;
const MAX_OPEN_FILES_PER_PROJECT = 256;
const MAX_EXEC_CODE_LENGTH = 100_000;

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

type BrowserExecApi = {
  projectId: string;
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

  const impl: BrowserSessionServiceApi = {
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
    exec: async ({ project_id, code }) => {
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

      const api: BrowserExecApi = {
        projectId: project_id,
        listOpenFiles: (): BrowserOpenFileInfo[] => {
          const snapshot = buildSessionSnapshot(client);
          return flattenOpenFiles(snapshot.open_projects).filter(
            (file) => file.project_id === project_id,
          );
        },
        listOpenFilesAll: (): BrowserOpenFileInfo[] => {
          const snapshot = buildSessionSnapshot(client);
          return flattenOpenFiles(snapshot.open_projects);
        },
        openFiles: async (
          paths: unknown,
          opts?: { background?: boolean },
        ): Promise<{ opened: number; paths: string[] }> => {
          const cleanPaths = sanitizePathList(paths);
          for (const [index, path] of cleanPaths.entries()) {
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
          const cleanPaths = sanitizePathList(paths);
          for (const path of cleanPaths) {
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
            const jupyterActions = await getJupyterActionsForPath({
              project_id,
              path,
            });
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
            const jupyterActions = await getJupyterActionsForPath({
              project_id,
              path,
            });
            const store = jupyterActions.store;
            const existingCellIds = new Set(asStringArray(store.get("cell_list")));
            const wanted = sanitizeCellIdList(ids);
            if (wanted.length === 0) {
              await jupyterActions.runCells(asStringArray(store.get("cell_list")));
              return {
                ran: asStringArray(store.get("cell_list")).length,
                mode: "all",
                ids: asStringArray(store.get("cell_list")),
              };
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
            const cleanUpdates = sanitizeCellUpdates(updates);
            if (cleanUpdates.length === 0) {
              return { updated: 0, ids: [] };
            }
            const jupyterActions = await getJupyterActionsForPath({
              project_id,
              path,
            });
            const store = jupyterActions.store;
            const existingCellIds = new Set(asStringArray(store.get("cell_list")));
            for (const update of cleanUpdates) {
              if (!existingCellIds.has(update.id)) {
                throw Error(`no cell with id '${update.id}'`);
              }
            }
            for (const update of cleanUpdates) {
              jupyterActions.set_cell_input(update.id, update.input, false);
            }
            jupyterActions.syncdb?.commit?.();
            return {
              updated: cleanUpdates.length,
              ids: cleanUpdates.map((x) => x.id),
            };
          },
        },
      };

      const evaluator = new Function(
        "api",
        `"use strict"; return (async () => { ${script}\n})();`,
      ) as (api: BrowserExecApi) => Promise<unknown>;
      const result = await evaluator(api);
      return { ok: true, result: toSerializableValue(result) };
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
