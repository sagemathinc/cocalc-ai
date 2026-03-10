/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { dkv, type DKV } from "./sync/dkv";
import { uuid } from "@cocalc/util/misc";

export const WORKSPACES_STORE_VERSION = 1;
export const WORKSPACES_STORE_VERSION_KEY = "version";
export const WORKSPACES_STORE_RECORDS_KEY = "records";

export type WorkspaceTheme = {
  title: string;
  description: string;
  color: string | null;
  accent_color: string | null;
  icon: string | null;
  image_blob: string | null;
};

export type WorkspaceSource = "manual" | "git-root" | "inferred";

export type WorkspaceRecord = {
  workspace_id: string;
  project_id: string;
  root_path: string;
  theme: WorkspaceTheme;
  pinned: boolean;
  last_used_at: number | null;
  last_active_path: string | null;
  chat_path: string | null;
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
  chat_path?: string | null;
  last_active_path?: string | null;
  source?: WorkspaceSource;
};

export type WorkspaceUpdatePatch = Partial<{
  root_path: string;
  theme: Partial<WorkspaceTheme>;
  pinned: boolean;
  chat_path: string | null;
  last_used_at: number | null;
  last_active_path: string | null;
  source: WorkspaceSource;
}>;

export type WorkspaceStore = DKV<WorkspaceRecord[] | number>;

export function workspaceStoreName(account_id: string): string {
  return `workspaces/${account_id}`;
}

export function sanitizeWorkspaceAccountId(accountId: string): string {
  return `${accountId ?? ""}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export async function openWorkspaceStore({
  client,
  project_id,
  account_id,
}: {
  client: unknown;
  project_id: string;
  account_id: string;
}): Promise<WorkspaceStore> {
  const store = await dkv<WorkspaceRecord[] | number>({
    client: client as any,
    project_id,
    name: workspaceStoreName(account_id),
  });
  store.setMaxListeners(100);
  return store;
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
    root === "/" ? "/" : root.split("/").filter(Boolean).at(-1) ?? root;
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
    created_at:
      typeof record.created_at === "number" && Number.isFinite(record.created_at)
        ? record.created_at
        : Date.now(),
    updated_at:
      typeof record.updated_at === "number" && Number.isFinite(record.updated_at)
        ? record.updated_at
        : Date.now(),
    source: record.source ?? "manual",
  };
}

export function sortWorkspaceRecords(
  records: WorkspaceRecord[],
): WorkspaceRecord[] {
  return [...records].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aUsed = a.last_used_at ?? 0;
    const bUsed = b.last_used_at ?? 0;
    if (aUsed !== bUsed) return bUsed - aUsed;
    return a.theme.title.localeCompare(b.theme.title);
  });
}

export function normalizeWorkspaceSelection(
  selection: WorkspaceSelection | undefined | null,
  records: WorkspaceRecord[],
): WorkspaceSelection {
  if (!selection || typeof selection !== "object") return { kind: "all" };
  if (selection.kind === "workspace") {
    return records.some((record) => record.workspace_id === selection.workspace_id)
      ? selection
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

export function resolveWorkspaceForPath(
  records: WorkspaceRecord[],
  path: string,
): WorkspaceRecord | null {
  const normalizedPath = normalizeWorkspacePath(path);
  for (const record of records) {
    const chatPath = record.chat_path?.trim();
    if (chatPath && chatPath === normalizedPath) {
      return record;
    }
  }
  let best: WorkspaceRecord | null = null;
  for (const record of records) {
    if (!pathMatchesWorkspaceRoot(normalizedPath, record.root_path)) continue;
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
  return sortWorkspaceRecords(raw.map(normalizeWorkspaceRecord));
}

export function writeWorkspaceRecordsToStore(
  store: WorkspaceStore,
  records: WorkspaceRecord[],
): void {
  store.setMany({
    [WORKSPACES_STORE_VERSION_KEY]: WORKSPACES_STORE_VERSION,
    [WORKSPACES_STORE_RECORDS_KEY]: records,
  });
}

export function hasWorkspaceStoreState(store: WorkspaceStore): boolean {
  return (
    store.get(WORKSPACES_STORE_VERSION_KEY) != null ||
    store.get(WORKSPACES_STORE_RECORDS_KEY) != null
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
    last_used_at: now,
    last_active_path:
      typeof input.last_active_path === "string" && input.last_active_path.trim()
        ? normalizeWorkspacePath(input.last_active_path)
        : null,
    chat_path: input.chat_path ?? null,
    created_at: now,
    updated_at: now,
    source: input.source ?? "manual",
  });
}

export function createWorkspaceRecords(
  records: WorkspaceRecord[],
  record: WorkspaceRecord,
): WorkspaceRecord[] {
  return sortWorkspaceRecords([
    ...records.filter((x) => x.root_path !== record.root_path),
    record,
  ]);
}

export function updateWorkspaceRecords(
  records: WorkspaceRecord[],
  workspace_id: string,
  patch: WorkspaceUpdatePatch,
  now = Date.now(),
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
        chat_path: patch.chat_path ?? record.chat_path,
        last_used_at:
          patch.last_used_at === undefined ? record.last_used_at : patch.last_used_at,
        last_active_path:
          patch.last_active_path === undefined
            ? record.last_active_path
            : patch.last_active_path,
        updated_at: now,
        source: patch.source ?? record.source,
      });
      return updated;
    }),
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
): { records: WorkspaceRecord[]; updated: WorkspaceRecord | null } {
  return updateWorkspaceRecords(records, workspace_id, { last_used_at: at }, at);
}
