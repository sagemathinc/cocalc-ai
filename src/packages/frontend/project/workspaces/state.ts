import { useCallback, useEffect, useMemo, useState } from "react";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import { uuid } from "@cocalc/util/misc";
import type {
  ProjectWorkspaceState,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceSelection,
  WorkspaceTheme,
  WorkspaceUpdatePatch,
} from "./types";

const STORAGE_VERSION = 1;
const STORAGE_EVENT = "cocalc-project-workspaces-changed";

function recordsKey(account_id: string, project_id: string): string[] {
  return ["workspaces", account_id, project_id, "records"];
}

function selectionKey(account_id: string, project_id: string): string[] {
  return ["workspaces", account_id, project_id, "selection"];
}

function normalizePath(path: string): string {
  let next = `${path ?? ""}`.trim();
  if (!next.startsWith("/")) {
    next = `/${next}`;
  }
  if (next.length > 1) {
    next = next.replace(/\/+$/g, "");
  }
  return next || "/";
}

function defaultTheme(root_path: string, title?: string): WorkspaceTheme {
  const trimmedTitle = `${title ?? ""}`.trim();
  const root = normalizePath(root_path);
  const fallbackTitle = root === "/" ? "/" : root.split("/").filter(Boolean).at(-1) ?? root;
  return {
    title: trimmedTitle || fallbackTitle,
    description: "",
    color: null,
    accent_color: null,
    icon: null,
    image_blob: null,
  };
}

function normalizeRecord(record: WorkspaceRecord): WorkspaceRecord {
  return {
    ...record,
    root_path: normalizePath(record.root_path),
    theme: {
      title: `${record.theme?.title ?? ""}`.trim() || defaultTheme(record.root_path).title,
      description: `${record.theme?.description ?? ""}`,
      color: record.theme?.color ?? null,
      accent_color: record.theme?.accent_color ?? null,
      icon: record.theme?.icon ?? null,
      image_blob: record.theme?.image_blob ?? null,
    },
    pinned: record.pinned === true,
    last_used_at:
      typeof record.last_used_at === "number" && Number.isFinite(record.last_used_at)
        ? record.last_used_at
        : null,
    last_active_path:
      typeof record.last_active_path === "string" && record.last_active_path.trim()
        ? normalizePath(record.last_active_path)
        : null,
    chat_path: record.chat_path ?? null,
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

function sortRecords(records: WorkspaceRecord[]): WorkspaceRecord[] {
  return [...records].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aUsed = a.last_used_at ?? 0;
    const bUsed = b.last_used_at ?? 0;
    if (aUsed !== bUsed) return bUsed - aUsed;
    return a.theme.title.localeCompare(b.theme.title);
  });
}

function loadRecords(account_id: string, project_id: string): WorkspaceRecord[] {
  const raw = LS.get<WorkspaceRecord[]>(recordsKey(account_id, project_id));
  if (!Array.isArray(raw)) return [];
  return sortRecords(raw.map(normalizeRecord));
}

function loadSelection(
  account_id: string,
  project_id: string,
  records: WorkspaceRecord[],
): WorkspaceSelection {
  const raw = LS.get<WorkspaceSelection>(selectionKey(account_id, project_id));
  if (!raw || typeof raw !== "object") return { kind: "all" };
  if (raw.kind === "workspace") {
    return records.some((record) => record.workspace_id === raw.workspace_id)
      ? raw
      : { kind: "all" };
  }
  return raw.kind === "unscoped" ? { kind: "unscoped" } : { kind: "all" };
}

function persist(
  account_id: string,
  project_id: string,
  records: WorkspaceRecord[],
  selection: WorkspaceSelection,
): void {
  LS.set(recordsKey(account_id, project_id), records);
  LS.set(selectionKey(account_id, project_id), selection);
  window.dispatchEvent(
    new CustomEvent(STORAGE_EVENT, {
      detail: { account_id, project_id, version: STORAGE_VERSION },
    }),
  );
}

export function pathMatchesRoot(path: string, root_path: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root_path);
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
  const normalizedPath = normalizePath(path);
  let best: WorkspaceRecord | null = null;
  for (const record of records) {
    if (!pathMatchesRoot(normalizedPath, record.root_path)) continue;
    if (!best || record.root_path.length > best.root_path.length) {
      best = record;
    }
  }
  return best;
}

export function selectionMatchesPath(
  selection: WorkspaceSelection,
  records: WorkspaceRecord[],
  path: string,
): boolean {
  if (selection.kind === "all") return true;
  const resolved = resolveWorkspaceForPath(records, path);
  if (selection.kind === "unscoped") return resolved == null;
  return resolved?.workspace_id === selection.workspace_id;
}

export function useProjectWorkspaces(
  account_id: string | undefined,
  project_id: string,
): ProjectWorkspaceState {
  const canPersist = typeof account_id === "string" && account_id.trim().length > 0;
  const [records, setRecords] = useState<WorkspaceRecord[]>(() =>
    canPersist ? loadRecords(account_id!, project_id) : [],
  );
  const [selection, setSelectionState] = useState<WorkspaceSelection>(() =>
    canPersist ? loadSelection(account_id!, project_id, records) : { kind: "all" },
  );

  useEffect(() => {
    if (!canPersist) {
      setRecords([]);
      setSelectionState({ kind: "all" });
      return;
    }
    const nextRecords = loadRecords(account_id!, project_id);
    setRecords(nextRecords);
    setSelectionState(loadSelection(account_id!, project_id, nextRecords));
  }, [account_id, project_id, canPersist]);

  useEffect(() => {
    if (!canPersist) return;
    const onStorage = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {};
      if (detail.account_id !== account_id || detail.project_id !== project_id) {
        return;
      }
      const nextRecords = loadRecords(account_id!, project_id);
      setRecords(nextRecords);
      setSelectionState(loadSelection(account_id!, project_id, nextRecords));
    };
    window.addEventListener(STORAGE_EVENT, onStorage as EventListener);
    return () => {
      window.removeEventListener(STORAGE_EVENT, onStorage as EventListener);
    };
  }, [account_id, project_id, canPersist]);

  const current = useMemo(() => {
    if (selection.kind !== "workspace") return null;
    return (
      records.find((record) => record.workspace_id === selection.workspace_id) ?? null
    );
  }, [records, selection]);

  const setSelection = useCallback(
    (next: WorkspaceSelection) => {
      setSelectionState(next);
      if (canPersist) {
        persist(account_id!, project_id, records, next);
      }
    },
    [account_id, project_id, records, canPersist],
  );

  const createWorkspace = useCallback(
    (input: WorkspaceCreateInput) => {
      const now = Date.now();
      const record: WorkspaceRecord = normalizeRecord({
        workspace_id: uuid(),
        project_id,
        root_path: input.root_path,
        theme: {
          ...defaultTheme(input.root_path, input.title),
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
            ? normalizePath(input.last_active_path)
            : null,
        chat_path: input.chat_path ?? null,
        created_at: now,
        updated_at: now,
        source: input.source ?? "manual",
      });
      const nextRecords = sortRecords([...records.filter((x) => x.root_path !== record.root_path), record]);
      const nextSelection: WorkspaceSelection = {
        kind: "workspace",
        workspace_id: record.workspace_id,
      };
      setRecords(nextRecords);
      setSelectionState(nextSelection);
      if (canPersist) {
        persist(account_id!, project_id, nextRecords, nextSelection);
      }
      return record;
    },
    [account_id, project_id, records, canPersist],
  );

  const updateWorkspace = useCallback(
    (workspace_id: string, patch: WorkspaceUpdatePatch) => {
      let updated: WorkspaceRecord | null = null;
      const nextRecords = sortRecords(
        records.map((record) => {
          if (record.workspace_id !== workspace_id) return record;
          updated = normalizeRecord({
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
            updated_at: Date.now(),
            source: patch.source ?? record.source,
          });
          return updated;
        }),
      );
      setRecords(nextRecords);
      const nextSelection =
        selection.kind === "workspace" && selection.workspace_id === workspace_id && !nextRecords.some((r) => r.workspace_id === workspace_id)
          ? ({ kind: "all" } as WorkspaceSelection)
          : selection;
      setSelectionState(nextSelection);
      if (canPersist) {
        persist(account_id!, project_id, nextRecords, nextSelection);
      }
      return updated;
    },
    [account_id, project_id, records, selection, canPersist],
  );

  const deleteWorkspace = useCallback(
    (workspace_id: string) => {
      const nextRecords = records.filter((record) => record.workspace_id !== workspace_id);
      const nextSelection =
        selection.kind === "workspace" && selection.workspace_id === workspace_id
          ? ({ kind: "all" } as WorkspaceSelection)
          : selection;
      setRecords(nextRecords);
      setSelectionState(nextSelection);
      if (canPersist) {
        persist(account_id!, project_id, nextRecords, nextSelection);
      }
    },
    [account_id, project_id, records, selection, canPersist],
  );

  const touchWorkspace = useCallback(
    (workspace_id: string) => {
      const next = updateWorkspace(workspace_id, { last_used_at: Date.now() });
      return next;
    },
    [updateWorkspace],
  );

  const resolve = useCallback(
    (path: string) => resolveWorkspaceForPath(records, path),
    [records],
  );

  const matchesPath = useCallback(
    (path: string) => selectionMatchesPath(selection, records, path),
    [selection, records],
  );

  const filterPaths = useCallback(
    (paths: readonly string[]) => paths.filter((path) => selectionMatchesPath(selection, records, path)),
    [selection, records],
  );

  return {
    records,
    selection,
    current,
    filterPaths,
    matchesPath,
    resolveWorkspaceForPath: resolve,
    setSelection,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    touchWorkspace,
  };
}

export function defaultWorkspaceTitle(path: string): string {
  return defaultTheme(path).title;
}
