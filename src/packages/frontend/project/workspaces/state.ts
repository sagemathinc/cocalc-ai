import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { uuid } from "@cocalc/util/misc";
import type { DKV } from "@cocalc/conat/sync/dkv";
import type {
  ProjectWorkspaceState,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceSelection,
  WorkspaceTheme,
  WorkspaceUpdatePatch,
} from "./types";

const STORAGE_VERSION = 1;
const STORE_VERSION_KEY = "version";
const STORE_RECORDS_KEY = "records";
const STORE_SELECTION_KEY = "selection";

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

function normalizeSelection(
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

function storeName(account_id: string): string {
  return `workspaces/${account_id}`;
}

type WorkspaceStore = DKV<WorkspaceRecord[] | WorkspaceSelection | number>;

async function initStore(
  account_id: string,
  project_id: string,
): Promise<WorkspaceStore> {
  const store = await webapp_client.conat_client.dkv<
    WorkspaceRecord[] | WorkspaceSelection | number
  >({
    project_id,
    name: storeName(account_id),
  });
  store.setMaxListeners(100);
  return store;
}

function readRecordsFromStore(store: WorkspaceStore): WorkspaceRecord[] {
  const raw = store.get(STORE_RECORDS_KEY);
  if (!Array.isArray(raw)) return [];
  return sortRecords(raw.map(normalizeRecord));
}

function readSelectionFromStore(
  store: WorkspaceStore,
  records: WorkspaceRecord[],
): WorkspaceSelection {
  return normalizeSelection(
    store.get(STORE_SELECTION_KEY) as WorkspaceSelection | undefined,
    records,
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
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [selection, setSelectionState] = useState<WorkspaceSelection>({ kind: "all" });
  const storeRef = useRef<WorkspaceStore | null>(null);
  const recordsRef = useRef(records);
  const selectionRef = useRef(selection);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    if (!canPersist) {
      storeRef.current?.close?.();
      storeRef.current = null;
      setRecords([]);
      setSelectionState({ kind: "all" });
    }
  }, [account_id, project_id, canPersist]);

  useEffect(() => {
    if (!canPersist) return;
    let closed = false;
    let store: WorkspaceStore | null = null;
    let onChange:
      | ((event: {
          key: string;
          value?: WorkspaceRecord[] | WorkspaceSelection | number;
        }) => void)
      | null = null;

    const initialize = async () => {
      try {
        store = await initStore(account_id!, project_id);
        if (closed || store == null) {
          store?.close?.();
          return;
        }
        storeRef.current = store;

        const storeRecords = readRecordsFromStore(store);
        const storeSelection = readSelectionFromStore(store, storeRecords);
        const hasStoreState =
          store.get(STORE_VERSION_KEY) != null ||
          store.get(STORE_RECORDS_KEY) != null ||
          store.get(STORE_SELECTION_KEY) != null;

        const hasSeedState =
          recordsRef.current.length > 0 ||
          selectionRef.current.kind !== "all";

        if (!hasStoreState && hasSeedState) {
          store.setMany({
            [STORE_VERSION_KEY]: STORAGE_VERSION,
            [STORE_RECORDS_KEY]: recordsRef.current,
            [STORE_SELECTION_KEY]: selectionRef.current,
          });
        } else {
          setRecords(storeRecords);
          setSelectionState(storeSelection);
        }

        onChange = (event) => {
          if (
            event.key !== STORE_RECORDS_KEY &&
            event.key !== STORE_SELECTION_KEY &&
            event.key !== STORE_VERSION_KEY
          ) {
            return;
          }
          const nextRecords = readRecordsFromStore(store!);
          const nextSelection = readSelectionFromStore(store!, nextRecords);
          setRecords(nextRecords);
          setSelectionState(nextSelection);
        };

        store.on("change", onChange);
      } catch (err) {
        console.warn(`workspace store initialization warning -- ${err}`);
      }
    };

    void initialize();

    return () => {
      closed = true;
      if (storeRef.current === store) {
        storeRef.current = null;
      }
      if (store != null && onChange != null) {
        store.off("change", onChange);
      }
      if (store != null) {
        store.close();
      }
    };
  }, [account_id, project_id, canPersist]);

  const persistState = useCallback(
    (
      nextRecords: WorkspaceRecord[],
      nextSelection: WorkspaceSelection,
    ) => {
      if (!canPersist || storeRef.current == null) {
        return;
      }
      storeRef.current.setMany({
        [STORE_VERSION_KEY]: STORAGE_VERSION,
        [STORE_RECORDS_KEY]: nextRecords,
        [STORE_SELECTION_KEY]: nextSelection,
      });
    },
    [canPersist],
  );

  const current = useMemo(() => {
    if (selection.kind !== "workspace") return null;
    return (
      records.find((record) => record.workspace_id === selection.workspace_id) ?? null
    );
  }, [records, selection]);

  const setSelection = useCallback(
    (next: WorkspaceSelection) => {
      setSelectionState(next);
      persistState(records, next);
    },
    [records, persistState],
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
      persistState(nextRecords, nextSelection);
      return record;
    },
    [project_id, records, persistState],
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
      persistState(nextRecords, nextSelection);
      return updated;
    },
    [records, selection, persistState],
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
      persistState(nextRecords, nextSelection);
    },
    [records, selection, persistState],
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
