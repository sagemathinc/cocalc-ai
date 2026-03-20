/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client as CoreConatClient } from "./core/client";
import type { DKV, DKVOptions } from "./sync/dkv";
import { uuid } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";

export const WORKSPACES_STORE_VERSION = 1;
export const WORKSPACES_STORE_VERSION_KEY = "version";
export const WORKSPACES_STORE_RECORDS_KEY = "records";
export const WORKSPACES_STORE_ORDER_KEY = "order";

export type WorkspaceTheme = {
  title: string;
  description: string;
  color: string | null;
  accent_color: string | null;
  icon: string | null;
  image_blob: string | null;
};

export type WorkspaceSource = "manual" | "git-root" | "inferred";

export type WorkspaceNoticeLevel = "info" | "success" | "warning" | "error";

export type WorkspaceNotice = {
  title: string;
  text: string;
  level: WorkspaceNoticeLevel;
  updated_at: number;
};

export type WorkspaceRecord = {
  workspace_id: string;
  project_id: string;
  root_path: string;
  theme: WorkspaceTheme;
  pinned: boolean;
  strong_theme?: boolean;
  editor_theme?: string | null;
  terminal_theme?: string | null;
  last_used_at: number | null;
  last_active_path: string | null;
  chat_path: string | null;
  notice_thread_id: string | null;
  notice: WorkspaceNotice | null;
  activity_viewed_at: number | null;
  activity_running_at: number | null;
  created_at: number;
  updated_at: number;
  source: WorkspaceSource;
};

export type WorkspaceSelection =
  | { kind: "all" }
  | { kind: "unscoped" }
  | { kind: "workspace"; workspace_id: string };

export type WorkspaceCreateInput = {
  root_path: string;
  title?: string;
  description?: string;
  color?: string | null;
  accent_color?: string | null;
  icon?: string | null;
  image_blob?: string | null;
  pinned?: boolean;
  strong_theme?: boolean;
  editor_theme?: string | null;
  terminal_theme?: string | null;
  chat_path?: string | null;
  notice_thread_id?: string | null;
  notice?: Partial<WorkspaceNotice> | null;
  activity_viewed_at?: number | null;
  activity_running_at?: number | null;
  last_active_path?: string | null;
  source?: WorkspaceSource;
};

export type WorkspaceUpdatePatch = Partial<{
  root_path: string;
  theme: Partial<WorkspaceTheme>;
  pinned: boolean;
  strong_theme: boolean;
  editor_theme: string | null;
  terminal_theme: string | null;
  chat_path: string | null;
  notice_thread_id: string | null;
  notice: Partial<WorkspaceNotice> | null;
  activity_viewed_at: number | null;
  activity_running_at: number | null;
  last_used_at: number | null;
  last_active_path: string | null;
  source: WorkspaceSource;
}>;

export type WorkspaceStore = DKV<WorkspaceRecord[] | string[] | number>;

type WorkspaceStoreOpenOptions = Omit<DKVOptions, "client">;

// Frontend code does not pass the low-level core Conat client directly. It uses
// the higher-level `webapp_client.conat_client` wrapper from
// `src/packages/frontend/conat/client.ts`, which exposes `dkv(...)` directly.
// Backend and CLI callers pass the core client from `conat/core/client.ts`,
// which exposes the same functionality under `client.sync.dkv(...)`.
export interface WorkspaceFrontendConatClient {
  dkv<T>(opts: WorkspaceStoreOpenOptions): Promise<DKV<T>>;
}

export type WorkspaceStoreClient =
  | CoreConatClient
  | WorkspaceFrontendConatClient;

export function workspaceStoreName(account_id: string): string {
  return `workspaces/${account_id}`;
}

export function sanitizeWorkspaceAccountId(accountId: string): string {
  return `${accountId ?? ""}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export const DEFAULT_WORKSPACE_CHAT_BASE = ".local/share/cocalc";

export function defaultWorkspaceChatRelativePath(opts: {
  account_id: string;
  workspace_id: string;
  baseDir?: string;
}): string {
  const baseDir = `${opts.baseDir ?? DEFAULT_WORKSPACE_CHAT_BASE}`.trim();
  if (!baseDir) {
    throw new Error("workspace chat baseDir must be non-empty");
  }
  return `${baseDir}/workspaces/${sanitizeWorkspaceAccountId(opts.account_id)}/${opts.workspace_id}.chat`;
}

export function defaultWorkspaceChatPath(opts: {
  account_id: string;
  workspace_id: string;
  homeDirectory: string;
  baseDir?: string;
}): string {
  return normalizeAbsolutePath(
    defaultWorkspaceChatRelativePath({
      account_id: opts.account_id,
      workspace_id: opts.workspace_id,
      baseDir: opts.baseDir,
    }),
    opts.homeDirectory,
  );
}

export async function openWorkspaceStore({
  client,
  project_id,
  account_id,
}: {
  client: WorkspaceStoreClient;
  project_id: string;
  account_id: string;
}): Promise<WorkspaceStore> {
  const opts = {
    project_id,
    name: workspaceStoreName(account_id),
  };
  const store = hasFrontendConatClient(client)
    ? await client.dkv<WorkspaceRecord[] | string[] | number>(opts)
    : await client.sync.dkv<WorkspaceRecord[] | string[] | number>(opts);
  store.setMaxListeners(100);
  return store;
}

function hasFrontendConatClient(
  client: WorkspaceStoreClient,
): client is WorkspaceFrontendConatClient {
  return "dkv" in client;
}

export function normalizeWorkspacePath(path: string): string {
  let next = `${path ?? ""}`.trim();
  if (!next.startsWith("/")) {
    next = `/${next}`;
  }
  if (next.length > 1) {
    next = next.replace(/\/+$/g, "");
  }
  return next || "/";
}

export function defaultWorkspaceTheme(
  root_path: string,
  title?: string,
): WorkspaceTheme {
  const trimmedTitle = `${title ?? ""}`.trim();
  const root = normalizeWorkspacePath(root_path);
  const fallbackTitle =
    root === "/" ? "/" : (root.split("/").filter(Boolean).at(-1) ?? root);
  return {
    title: trimmedTitle || fallbackTitle,
    description: "",
    color: null,
    accent_color: null,
    icon: null,
    image_blob: null,
  };
}

export function defaultWorkspaceTitle(path: string): string {
  return defaultWorkspaceTheme(path).title;
}

export function normalizeWorkspaceRecord(
  record: WorkspaceRecord,
): WorkspaceRecord {
  return {
    ...record,
    root_path: normalizeWorkspacePath(record.root_path),
    theme: {
      title:
        `${record.theme?.title ?? ""}`.trim() ||
        defaultWorkspaceTheme(record.root_path).title,
      description: `${record.theme?.description ?? ""}`,
      color: record.theme?.color ?? null,
      accent_color: record.theme?.accent_color ?? null,
      icon: record.theme?.icon ?? null,
      image_blob: record.theme?.image_blob ?? null,
    },
    pinned: record.pinned === true,
    strong_theme: record.strong_theme === true,
    editor_theme:
      typeof record.editor_theme === "string" && record.editor_theme.trim()
        ? record.editor_theme.trim()
        : null,
    terminal_theme:
      typeof record.terminal_theme === "string" && record.terminal_theme.trim()
        ? record.terminal_theme.trim()
        : null,
    last_used_at:
      typeof record.last_used_at === "number" &&
      Number.isFinite(record.last_used_at)
        ? record.last_used_at
        : null,
    last_active_path:
      typeof record.last_active_path === "string" &&
      record.last_active_path.trim()
        ? normalizeWorkspacePath(record.last_active_path)
        : null,
    chat_path:
      typeof record.chat_path === "string" && record.chat_path.trim()
        ? record.chat_path.trim()
        : null,
    notice_thread_id:
      typeof record.notice_thread_id === "string" &&
      record.notice_thread_id.trim()
        ? record.notice_thread_id.trim()
        : null,
    notice:
      record.notice != null &&
      typeof record.notice === "object" &&
      `${record.notice.text ?? ""}`.trim()
        ? {
            title: `${record.notice.title ?? ""}`.trim(),
            text: `${record.notice.text ?? ""}`.trim(),
            level:
              record.notice.level === "success" ||
              record.notice.level === "warning" ||
              record.notice.level === "error"
                ? record.notice.level
                : "info",
            updated_at:
              typeof record.notice.updated_at === "number" &&
              Number.isFinite(record.notice.updated_at)
                ? record.notice.updated_at
                : Date.now(),
          }
        : null,
    activity_viewed_at:
      typeof record.activity_viewed_at === "number" &&
      Number.isFinite(record.activity_viewed_at)
        ? record.activity_viewed_at
        : null,
    activity_running_at:
      typeof record.activity_running_at === "number" &&
      Number.isFinite(record.activity_running_at)
        ? record.activity_running_at
        : null,
    created_at:
      typeof record.created_at === "number" &&
      Number.isFinite(record.created_at)
        ? record.created_at
        : Date.now(),
    updated_at:
      typeof record.updated_at === "number" &&
      Number.isFinite(record.updated_at)
        ? record.updated_at
        : Date.now(),
    source: record.source ?? "manual",
  };
}

function legacyWorkspaceSort(records: WorkspaceRecord[]): WorkspaceRecord[] {
  return [...records].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aUsed = a.last_used_at ?? 0;
    const bUsed = b.last_used_at ?? 0;
    if (aUsed !== bUsed) return bUsed - aUsed;
    return a.theme.title.localeCompare(b.theme.title);
  });
}

export function defaultWorkspaceOrder(records: WorkspaceRecord[]): string[] {
  return legacyWorkspaceSort(records).map(({ workspace_id }) => workspace_id);
}

export function normalizeWorkspaceOrder(
  order: readonly string[] | undefined | null,
  records: WorkspaceRecord[],
  missingOrder?: readonly string[],
): string[] {
  const validIds = new Set(records.map(({ workspace_id }) => workspace_id));
  const next: string[] = [];
  const seen = new Set<string>();
  for (const workspace_id of order ?? []) {
    if (!validIds.has(workspace_id) || seen.has(workspace_id)) continue;
    seen.add(workspace_id);
    next.push(workspace_id);
  }
  const fallback = missingOrder ?? defaultWorkspaceOrder(records);
  for (const workspace_id of fallback) {
    if (!validIds.has(workspace_id) || seen.has(workspace_id)) continue;
    seen.add(workspace_id);
    next.push(workspace_id);
  }
  return next;
}

export function sortWorkspaceRecords(
  records: WorkspaceRecord[],
  order?: readonly string[],
): WorkspaceRecord[] {
  const normalizedOrder = normalizeWorkspaceOrder(order, records);
  const index = new Map(
    normalizedOrder.map((workspace_id, i) => [workspace_id, i] as const),
  );
  return [...records].sort((a, b) => {
    return (
      (index.get(a.workspace_id) ?? Number.MAX_SAFE_INTEGER) -
      (index.get(b.workspace_id) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

export function normalizeWorkspaceSelection(
  selection: WorkspaceSelection | undefined | null,
  records: WorkspaceRecord[],
): WorkspaceSelection {
  if (!selection || typeof selection !== "object") return { kind: "all" };
  if (selection.kind === "workspace") {
    return records.some(
      (record) => record.workspace_id === selection.workspace_id,
    )
      ? selection
      : { kind: "all" };
  }
  return selection.kind === "unscoped" ? { kind: "unscoped" } : { kind: "all" };
}

export function coerceWorkspaceSelection(
  selection: WorkspaceSelection | undefined | null,
): WorkspaceSelection {
  if (!selection || typeof selection !== "object") return { kind: "all" };
  if (selection.kind === "workspace") {
    return typeof selection.workspace_id === "string" &&
      selection.workspace_id.trim().length > 0
      ? { kind: "workspace", workspace_id: selection.workspace_id.trim() }
      : { kind: "all" };
  }
  return selection.kind === "unscoped" ? { kind: "unscoped" } : { kind: "all" };
}

export function pathMatchesWorkspaceRoot(
  path: string,
  root_path: string,
): boolean {
  const normalizedPath = normalizeWorkspacePath(path);
  const normalizedRoot = normalizeWorkspacePath(root_path);
  if (normalizedRoot === "/") return true;
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

export function pathMatchesWorkspace(
  record: Pick<WorkspaceRecord, "root_path" | "chat_path">,
  path: string,
): boolean {
  const normalizedPath = normalizeWorkspacePath(path);
  const normalizedChatPath =
    typeof record.chat_path === "string" && record.chat_path.trim()
      ? normalizeWorkspacePath(record.chat_path.trim())
      : null;
  return (
    normalizedChatPath === normalizedPath ||
    pathMatchesWorkspaceRoot(normalizedPath, record.root_path)
  );
}

export function resolveWorkspaceForPath(
  records: WorkspaceRecord[],
  path: string,
): WorkspaceRecord | null {
  const normalizedPath = normalizeWorkspacePath(path);
  let best: WorkspaceRecord | null = null;
  for (const record of records) {
    if (!pathMatchesWorkspace(record, normalizedPath)) continue;
    if (!best || record.root_path.length > best.root_path.length) {
      best = record;
    }
  }
  return best;
}

export function selectionMatchesWorkspacePath(
  selection: WorkspaceSelection,
  records: WorkspaceRecord[],
  path: string,
): boolean {
  if (selection.kind === "all") return true;
  const resolved = resolveWorkspaceForPath(records, path);
  if (selection.kind === "unscoped") return resolved == null;
  return resolved?.workspace_id === selection.workspace_id;
}

export function selectionForWorkspacePath(
  records: WorkspaceRecord[],
  path: string,
): WorkspaceSelection {
  const resolved = resolveWorkspaceForPath(records, path);
  return resolved
    ? { kind: "workspace", workspace_id: resolved.workspace_id }
    : { kind: "unscoped" };
}

export function readWorkspaceRecordsFromStore(
  store: WorkspaceStore,
): WorkspaceRecord[] {
  const raw = store.get(WORKSPACES_STORE_RECORDS_KEY);
  if (!Array.isArray(raw)) return [];
  const records = raw
    .filter(
      (value): value is WorkspaceRecord =>
        typeof value === "object" && value != null && !Array.isArray(value),
    )
    .map(normalizeWorkspaceRecord);
  return sortWorkspaceRecords(
    records,
    readWorkspaceOrderFromStore(store, records),
  );
}

export function readStoredWorkspaceRecords(
  store: WorkspaceStore,
): WorkspaceRecord[] {
  return readWorkspaceRecordsFromStore(store);
}

export function readWorkspaceOrderFromStore(
  store: WorkspaceStore,
  records?: WorkspaceRecord[],
): string[] {
  const nextRecords = records ?? readWorkspaceRecordsFromStore(store);
  const raw = store.get(WORKSPACES_STORE_ORDER_KEY);
  return normalizeWorkspaceOrder(
    Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === "string")
      : undefined,
    nextRecords,
  );
}

export function writeWorkspaceRecordsToStore(
  store: WorkspaceStore,
  records: WorkspaceRecord[],
  order?: readonly string[],
): void {
  const normalizedOrder = normalizeWorkspaceOrder(order, records);
  store.setMany({
    [WORKSPACES_STORE_VERSION_KEY]: WORKSPACES_STORE_VERSION,
    [WORKSPACES_STORE_RECORDS_KEY]: records,
    [WORKSPACES_STORE_ORDER_KEY]: normalizedOrder,
  });
}

export function hasWorkspaceStoreState(store: WorkspaceStore): boolean {
  return (
    store.get(WORKSPACES_STORE_VERSION_KEY) != null ||
    store.get(WORKSPACES_STORE_RECORDS_KEY) != null
  );
}

export function createStoredWorkspaceRecord(
  store: WorkspaceStore,
  {
    project_id,
    input,
    now,
    workspace_id,
  }: {
    project_id: string;
    input: WorkspaceCreateInput;
    now?: number;
    workspace_id?: string;
  },
): WorkspaceRecord {
  const currentRecords = readWorkspaceRecordsFromStore(store);
  const currentOrder = readWorkspaceOrderFromStore(store, currentRecords);
  const record = createWorkspaceRecord({
    project_id,
    input,
    now,
    workspace_id,
  });
  const nextRecords = createWorkspaceRecords(currentRecords, record, [
    ...currentOrder,
    record.workspace_id,
  ]);
  writeWorkspaceRecordsToStore(store, nextRecords, [
    ...currentOrder,
    record.workspace_id,
  ]);
  return record;
}

export function updateStoredWorkspaceRecord(
  store: WorkspaceStore,
  workspace_id: string,
  patch: WorkspaceUpdatePatch,
  now = Date.now(),
): WorkspaceRecord | null {
  const currentRecords = readWorkspaceRecordsFromStore(store);
  const currentOrder = readWorkspaceOrderFromStore(store, currentRecords);
  const { records, updated } = updateWorkspaceRecords(
    currentRecords,
    workspace_id,
    patch,
    now,
  );
  writeWorkspaceRecordsToStore(store, records, currentOrder);
  return updated;
}

export function deleteStoredWorkspaceRecord(
  store: WorkspaceStore,
  workspace_id: string,
): WorkspaceRecord[] {
  const currentRecords = readWorkspaceRecordsFromStore(store);
  const currentOrder = readWorkspaceOrderFromStore(store, currentRecords);
  const records = deleteWorkspaceRecords(currentRecords, workspace_id);
  writeWorkspaceRecordsToStore(
    store,
    records,
    currentOrder.filter((id) => id !== workspace_id),
  );
  return records;
}

export function touchStoredWorkspaceRecord(
  store: WorkspaceStore,
  workspace_id: string,
  at = Date.now(),
): WorkspaceRecord | null {
  const currentRecords = readWorkspaceRecordsFromStore(store);
  const currentOrder = readWorkspaceOrderFromStore(store, currentRecords);
  const { records, updated } = touchWorkspaceRecords(
    currentRecords,
    workspace_id,
    at,
  );
  writeWorkspaceRecordsToStore(store, records, currentOrder);
  return updated;
}

export function resolveWorkspaceIdentifier(
  records: WorkspaceRecord[],
  identifier: string,
): WorkspaceRecord | null {
  const value = `${identifier ?? ""}`.trim();
  if (!value) return null;
  const byId = records.find((record) => record.workspace_id === value);
  if (byId) return byId;
  const normalizedPath = normalizeWorkspacePath(value);
  return (
    records.find((record) => record.root_path === normalizedPath) ??
    records.find((record) => record.chat_path?.trim() === normalizedPath) ??
    null
  );
}

export function createWorkspaceRecord({
  project_id,
  input,
  now = Date.now(),
  workspace_id = uuid(),
}: {
  project_id: string;
  input: WorkspaceCreateInput;
  now?: number;
  workspace_id?: string;
}): WorkspaceRecord {
  return normalizeWorkspaceRecord({
    workspace_id,
    project_id,
    root_path: input.root_path,
    theme: {
      ...defaultWorkspaceTheme(input.root_path, input.title),
      description: `${input.description ?? ""}`,
      color: input.color ?? null,
      accent_color: input.accent_color ?? null,
      icon: input.icon ?? null,
      image_blob: input.image_blob ?? null,
    },
    pinned: input.pinned === true,
    strong_theme: input.strong_theme === true,
    editor_theme:
      typeof input.editor_theme === "string" && input.editor_theme.trim()
        ? input.editor_theme.trim()
        : null,
    terminal_theme:
      typeof input.terminal_theme === "string" && input.terminal_theme.trim()
        ? input.terminal_theme.trim()
        : null,
    last_used_at: now,
    last_active_path:
      typeof input.last_active_path === "string" &&
      input.last_active_path.trim()
        ? normalizeWorkspacePath(input.last_active_path)
        : null,
    chat_path: input.chat_path ?? null,
    notice_thread_id:
      typeof input.notice_thread_id === "string" &&
      input.notice_thread_id.trim()
        ? input.notice_thread_id.trim()
        : null,
    notice:
      input.notice != null && `${input.notice.text ?? ""}`.trim()
        ? {
            title: `${input.notice.title ?? ""}`.trim(),
            text: `${input.notice.text ?? ""}`.trim(),
            level:
              input.notice.level === "success" ||
              input.notice.level === "warning" ||
              input.notice.level === "error"
                ? input.notice.level
                : "info",
            updated_at:
              typeof input.notice.updated_at === "number" &&
              Number.isFinite(input.notice.updated_at)
                ? input.notice.updated_at
                : now,
          }
        : null,
    activity_viewed_at:
      typeof input.activity_viewed_at === "number" &&
      Number.isFinite(input.activity_viewed_at)
        ? input.activity_viewed_at
        : null,
    activity_running_at:
      typeof input.activity_running_at === "number" &&
      Number.isFinite(input.activity_running_at)
        ? input.activity_running_at
        : null,
    created_at: now,
    updated_at: now,
    source: input.source ?? "manual",
  });
}

export function createWorkspaceRecords(
  records: WorkspaceRecord[],
  record: WorkspaceRecord,
  order?: readonly string[],
): WorkspaceRecord[] {
  return sortWorkspaceRecords(
    [...records.filter((x) => x.root_path !== record.root_path), record],
    order,
  );
}

export function updateWorkspaceRecords(
  records: WorkspaceRecord[],
  workspace_id: string,
  patch: WorkspaceUpdatePatch,
  now = Date.now(),
  order?: readonly string[],
): { records: WorkspaceRecord[]; updated: WorkspaceRecord | null } {
  let updated: WorkspaceRecord | null = null;
  const nextRecords = sortWorkspaceRecords(
    records.map((record) => {
      if (record.workspace_id !== workspace_id) return record;
      updated = normalizeWorkspaceRecord({
        ...record,
        root_path: patch.root_path ?? record.root_path,
        theme: {
          ...record.theme,
          ...(patch.theme ?? {}),
        },
        pinned: patch.pinned ?? record.pinned,
        strong_theme: patch.strong_theme ?? record.strong_theme,
        editor_theme:
          patch.editor_theme === undefined
            ? record.editor_theme
            : patch.editor_theme,
        terminal_theme:
          patch.terminal_theme === undefined
            ? record.terminal_theme
            : patch.terminal_theme,
        chat_path: patch.chat_path ?? record.chat_path,
        notice_thread_id:
          patch.notice_thread_id === undefined
            ? record.notice_thread_id
            : patch.notice_thread_id,
        notice:
          patch.notice === undefined
            ? record.notice
            : patch.notice == null || !`${patch.notice.text ?? ""}`.trim()
              ? null
              : {
                  title:
                    patch.notice.title === undefined
                      ? (record.notice?.title ?? "")
                      : `${patch.notice.title ?? ""}`.trim(),
                  text: `${patch.notice.text ?? ""}`.trim(),
                  level:
                    patch.notice.level === "success" ||
                    patch.notice.level === "warning" ||
                    patch.notice.level === "error"
                      ? patch.notice.level
                      : patch.notice.level === "info"
                        ? "info"
                        : (record.notice?.level ?? "info"),
                  updated_at:
                    typeof patch.notice.updated_at === "number" &&
                    Number.isFinite(patch.notice.updated_at)
                      ? patch.notice.updated_at
                      : now,
                },
        activity_viewed_at:
          patch.activity_viewed_at === undefined
            ? record.activity_viewed_at
            : patch.activity_viewed_at,
        activity_running_at:
          patch.activity_running_at === undefined
            ? record.activity_running_at
            : patch.activity_running_at,
        last_used_at:
          patch.last_used_at === undefined
            ? record.last_used_at
            : patch.last_used_at,
        last_active_path:
          patch.last_active_path === undefined
            ? record.last_active_path
            : patch.last_active_path,
        updated_at: now,
        source: patch.source ?? record.source,
      });
      return updated;
    }),
    order,
  );
  return { records: nextRecords, updated };
}

export function deleteWorkspaceRecords(
  records: WorkspaceRecord[],
  workspace_id: string,
): WorkspaceRecord[] {
  return records.filter((record) => record.workspace_id !== workspace_id);
}

export function touchWorkspaceRecords(
  records: WorkspaceRecord[],
  workspace_id: string,
  at = Date.now(),
  order?: readonly string[],
): { records: WorkspaceRecord[]; updated: WorkspaceRecord | null } {
  return updateWorkspaceRecords(
    records,
    workspace_id,
    { last_used_at: at },
    at,
    order,
  );
}

export function reorderWorkspaceRecords(
  records: WorkspaceRecord[],
  order: readonly string[],
): WorkspaceRecord[] {
  return sortWorkspaceRecords(records, order);
}
