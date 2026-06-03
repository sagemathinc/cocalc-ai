/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  collectReduxHookSubscriptionDiagnostics,
  redux,
  redux_name,
} from "@cocalc/frontend/app-framework";
import { is_valid_uuid_string } from "@cocalc/util/misc";

export const SYNCDOC_DIAGNOSTICS_STORAGE_KEY = "cocalc.debug.syncdoc";
const MAX_DIAGNOSTIC_EVENTS = 250;

interface DiagnosticEvent {
  at: string;
  event: string;
  payload?: any;
}

const diagnosticEvents: DiagnosticEvent[] = [];

interface DiagnosticsOptions {
  conatClient?: any;
}

function storageFlagEnabled(key: string): boolean {
  try {
    const value = globalThis.localStorage?.getItem(key)?.trim().toLowerCase();
    if (!value) return false;
    return !["0", "false", "off", "no"].includes(value);
  } catch {
    return false;
  }
}

export function syncdocDiagnosticsEnabled(): boolean {
  return storageFlagEnabled(SYNCDOC_DIAGNOSTICS_STORAGE_KEY);
}

export function syncdocDiagnosticLog(event: string, payload?: any): void {
  diagnosticEvents.push({
    at: new Date().toISOString(),
    event,
    payload,
  });
  if (diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) {
    diagnosticEvents.splice(0, diagnosticEvents.length - MAX_DIAGNOSTIC_EVENTS);
  }
  if (!syncdocDiagnosticsEnabled()) return;
  console.warn("[syncdoc-diagnostics]", event, payload ?? "");
}

function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function toArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value?.toArray === "function") return value.toArray();
  if (typeof value?.toJS === "function") {
    const js = value.toJS();
    return Array.isArray(js) ? js : [];
  }
  return [];
}

function toPlain(value: any): any {
  if (value == null) return value;
  if (typeof value?.toJS === "function") return value.toJS();
  return value;
}

function summarizeLocalViewState(
  store: any,
): Record<string, unknown> | undefined {
  const localViewState = safeCall(() => store.get("local_view_state"));
  if (localViewState == null) return;
  return {
    active_id: safeCall(() => localViewState.get("active_id")),
    full_id: safeCall(() => localViewState.get("full_id")),
    frame_tree: toPlain(safeCall(() => localViewState.get("frame_tree"))),
  };
}

function summarizeEditorStore(store: any): Record<string, unknown> | undefined {
  if (store == null) return;
  return {
    is_loaded: safeCall(() => store.get("is_loaded")),
    read_only: safeCall(() => store.get("read_only")),
    read_only_preview: safeCall(() => store.get("read_only_preview")),
    rtc_status: safeCall(() => store.get("rtc_status")),
    status: safeCall(() => store.get("status")),
    has_unsaved_changes: safeCall(() => store.get("has_unsaved_changes")),
    has_uncommitted_changes: safeCall(() =>
      store.get("has_uncommitted_changes"),
    ),
    syncdbReady: safeCall(() => store.get("syncdbReady")),
    readStateVersion: safeCall(() => store.get("readStateVersion")),
    visible: safeCall(() => store.get("visible")),
    valuePreview: safeCall(() => {
      const value = store.get("value");
      return typeof value === "string" ? value.slice(0, 80) : undefined;
    }),
    local_view_state: summarizeLocalViewState(store),
  };
}

function summarizeOpenFile(openFiles: any, displayPath: string): any {
  const info = safeCall(() => openFiles?.get?.(displayPath));
  if (info == null) return undefined;
  const plain = toPlain(info);
  return {
    ext: plain?.ext,
    sync_path: plain?.sync_path,
    display_path: plain?.display_path,
    chatState: plain?.chatState,
    fragmentId: plain?.fragmentId,
    componentKeys:
      plain?.component != null && typeof plain.component === "object"
        ? Object.keys(plain.component)
        : undefined,
  };
}

function projectIdFromStoreName(name: string): string | undefined {
  if (!name.startsWith("project-")) return;
  const project_id = name.slice("project-".length);
  return is_valid_uuid_string(project_id) ? project_id : undefined;
}

function collectProjectDiagnostics() {
  const stores = (redux as any)._stores ?? {};
  const projects: any[] = [];
  for (const [name, projectStore] of Object.entries<any>(stores)) {
    const project_id = projectIdFromStoreName(name);
    if (!project_id) continue;
    const activeTab = safeCall(() => projectStore.get("active_project_tab"));
    const openFiles = safeCall(() => projectStore.get("open_files"));
    const openFilesOrder = toArray(
      safeCall(() => projectStore.get("open_files_order")),
    );
    const files = openFilesOrder.map((displayPath) => {
      const openFile = summarizeOpenFile(openFiles, displayPath);
      const syncPath =
        typeof openFile?.sync_path === "string" && openFile.sync_path.length > 0
          ? openFile.sync_path
          : displayPath;
      const editorActions =
        safeCall(() => redux.getEditorActions(project_id, syncPath)) ??
        safeCall(() => redux.getActions(redux_name(project_id, syncPath)));
      const editorStore = safeCall(() =>
        redux.getEditorStore(project_id, syncPath),
      );
      return {
        displayPath,
        syncPath,
        active: activeTab === `editor-${displayPath}`,
        openFile,
        hasEditorActions: editorActions != null,
        editorActionsName: editorActions?.name,
        editorActionsClosed: safeCall(() => editorActions?.isClosed?.()),
        editorStore: summarizeEditorStore(editorStore),
        editorDiagnostics: safeCall(() => editorActions?.debugSyncdocState?.()),
      };
    });
    projects.push({
      project_id,
      active_project_tab: activeTab,
      open_files_order: openFilesOrder,
      files,
    });
  }
  return projects;
}

function collectReduxListenerDiagnostics() {
  const stores = (redux as any)._stores ?? {};
  const all = Object.entries<any>(stores).map(([name, store]) => {
    const changeListeners = safeCall(() => store.listenerCount?.("change"));
    return {
      name,
      changeListeners:
        typeof changeListeners === "number" ? changeListeners : undefined,
      maxListeners: safeCall(() => store.getMaxListeners?.()),
    };
  });
  const withChangeListeners = all.filter(
    ({ changeListeners }) =>
      typeof changeListeners === "number" && changeListeners > 0,
  );
  withChangeListeners.sort(
    (a, b) => (b.changeListeners ?? 0) - (a.changeListeners ?? 0),
  );
  return {
    storeCount: all.length,
    storesWithChangeListeners: withChangeListeners.length,
    totalChangeListeners: withChangeListeners.reduce(
      (sum, { changeListeners }) => sum + (changeListeners ?? 0),
      0,
    ),
    topChangeListenerStores: withChangeListeners.slice(0, 25),
  };
}

export function collectSyncdocDiagnostics({
  conatClient,
}: DiagnosticsOptions = {}) {
  return {
    capturedAt: new Date().toISOString(),
    browser: {
      online: typeof navigator === "undefined" ? undefined : navigator.onLine,
      visibility:
        typeof document === "undefined" ? undefined : document.visibilityState,
      focused:
        typeof document === "undefined" ||
        typeof document.hasFocus !== "function"
          ? undefined
          : document.hasFocus(),
    },
    conat: safeCall(() => conatClient?.debugReconnectState?.()),
    redux: {
      listeners: collectReduxListenerDiagnostics(),
      hooks: collectReduxHookSubscriptionDiagnostics(),
    },
    projects: collectProjectDiagnostics(),
    recentEvents: diagnosticEvents.slice(),
  };
}

export function installSyncdocDiagnostics({
  conatClient,
}: DiagnosticsOptions = {}): void {
  if (typeof window === "undefined") return;
  const snapshot = () => collectSyncdocDiagnostics({ conatClient });
  (window as any).cocalcSyncDiagnostics = snapshot;
  (window as any).ccSyncDiagnostics = snapshot;
  const cc = (window as any).cc;
  if (cc != null) {
    cc.syncdocDiagnostics = snapshot;
  }
}
