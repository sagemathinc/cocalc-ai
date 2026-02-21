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
        path: absolute_path.startsWith("/") ? absolute_path.slice(1) : absolute_path,
        absolute_path,
      });
    }
  }
  return files;
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
    openFile: async ({
      project_id,
      path,
      foreground = true,
      foreground_project = true,
    }) => {
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
