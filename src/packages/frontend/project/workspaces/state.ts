import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WORKSPACES_STORE_RECORDS_KEY,
  WORKSPACES_STORE_VERSION_KEY,
  createWorkspaceRecord,
  createWorkspaceRecords,
  defaultWorkspaceTitle as defaultWorkspaceTitleCore,
  deleteWorkspaceRecords,
  hasWorkspaceStoreState,
  normalizeWorkspaceSelection,
  openWorkspaceStore,
  pathMatchesWorkspaceRoot,
  readWorkspaceRecordsFromStore,
  resolveWorkspaceForPath as resolveWorkspaceForPathCore,
  selectionForWorkspacePath as selectionForWorkspacePathCore,
  selectionMatchesWorkspacePath,
  touchWorkspaceRecords,
  updateWorkspaceRecords,
  type WorkspaceStore,
  writeWorkspaceRecordsToStore,
} from "@cocalc/conat/workspaces";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  ProjectWorkspaceState,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceSelection,
  WorkspaceUpdatePatch,
} from "./types";

const SESSION_SELECTION_PREFIX = "project-workspace-selection";

function sessionSelectionKey(project_id: string): string {
  return `${SESSION_SELECTION_PREFIX}:${project_id}`;
}

function loadSessionSelection(project_id: string): WorkspaceSelection {
  if (typeof sessionStorage === "undefined") return { kind: "all" };
  try {
    const raw = sessionStorage.getItem(sessionSelectionKey(project_id));
    if (!raw) return { kind: "all" };
    const parsed = JSON.parse(raw);
    if (parsed?.kind === "workspace" && typeof parsed.workspace_id === "string") {
      return { kind: "workspace", workspace_id: parsed.workspace_id };
    }
    if (parsed?.kind === "unscoped") {
      return { kind: "unscoped" };
    }
  } catch (err) {
    console.warn(`workspace selection sessionStorage warning -- ${err}`);
  }
  return { kind: "all" };
}

function persistSessionSelection(
  project_id: string,
  selection: WorkspaceSelection,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      sessionSelectionKey(project_id),
      JSON.stringify(selection),
    );
  } catch (err) {
    console.warn(`workspace selection sessionStorage warning -- ${err}`);
  }
}

function readSelectionForProject(
  project_id: string,
  records: WorkspaceRecord[],
): WorkspaceSelection {
  return normalizeWorkspaceSelection(loadSessionSelection(project_id), records);
}

export function pathMatchesRoot(path: string, root_path: string): boolean {
  return pathMatchesWorkspaceRoot(path, root_path);
}

export function resolveWorkspaceForPath(
  records: WorkspaceRecord[],
  path: string,
): WorkspaceRecord | null {
  return resolveWorkspaceForPathCore(records, path);
}

export function selectionMatchesPath(
  selection: WorkspaceSelection,
  records: WorkspaceRecord[],
  path: string,
): boolean {
  return selectionMatchesWorkspacePath(selection, records, path);
}

export function selectionForPath(
  records: WorkspaceRecord[],
  path: string,
): WorkspaceSelection {
  return selectionForWorkspacePathCore(records, path);
}

export function useProjectWorkspaces(
  account_id: string | undefined,
  project_id: string,
): ProjectWorkspaceState {
  const canPersist = typeof account_id === "string" && account_id.trim().length > 0;
  const [loading, setLoading] = useState(canPersist);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [selection, setSelectionState] = useState<WorkspaceSelection>(() =>
    loadSessionSelection(project_id),
  );
  const storeRef = useRef<Awaited<ReturnType<typeof openWorkspaceStore>> | null>(null);
  const recordsRef = useRef(records);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  useEffect(() => {
    if (!canPersist) {
      storeRef.current?.close?.();
      storeRef.current = null;
      setLoading(false);
      setRecords([]);
      setSelectionState(loadSessionSelection(project_id));
    }
  }, [account_id, project_id, canPersist]);

  useEffect(() => {
    if (!canPersist) return;
    setLoading(true);
    let closed = false;
    let store: WorkspaceStore | null = null;
    let onChange:
      | ((event: {
          key: string;
          value?: WorkspaceRecord[] | number;
        }) => void)
      | null = null;

    const initialize = async () => {
      try {
        store = await openWorkspaceStore({
          client: webapp_client.conat_client,
          account_id: account_id!,
          project_id,
        });
        if (closed || store == null) {
          store?.close?.();
          return;
        }
        storeRef.current = store;

        const storeRecords = readWorkspaceRecordsFromStore(store);
        const storeSelection = readSelectionForProject(project_id, storeRecords);
        const hasStoreState = hasWorkspaceStoreState(store);

        const hasSeedState = recordsRef.current.length > 0;

        if (!hasStoreState && hasSeedState) {
          writeWorkspaceRecordsToStore(store, recordsRef.current);
        } else {
          setRecords(storeRecords);
          setSelectionState(storeSelection);
        }

        onChange = (event) => {
          if (
            event.key !== WORKSPACES_STORE_RECORDS_KEY &&
            event.key !== WORKSPACES_STORE_VERSION_KEY
          ) {
            return;
          }
          const nextRecords = readWorkspaceRecordsFromStore(store!);
          const nextSelection = readSelectionForProject(project_id, nextRecords);
          setRecords(nextRecords);
          setSelectionState(nextSelection);
        };

        store.on("change", onChange);
      } catch (err) {
        console.warn(`workspace store initialization warning -- ${err}`);
      } finally {
        if (!closed) {
          setLoading(false);
        }
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
    (nextRecords: WorkspaceRecord[]) => {
      if (!canPersist || storeRef.current == null) {
        return;
      }
      writeWorkspaceRecordsToStore(storeRef.current, nextRecords);
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
      persistSessionSelection(project_id, next);
    },
    [project_id],
  );

  const createWorkspace = useCallback(
    (input: WorkspaceCreateInput) => {
      const record: WorkspaceRecord = createWorkspaceRecord({ project_id, input });
      const nextRecords = createWorkspaceRecords(records, record);
      const nextSelection: WorkspaceSelection = {
        kind: "workspace",
        workspace_id: record.workspace_id,
      };
      setRecords(nextRecords);
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
      persistState(nextRecords);
      return record;
    },
    [project_id, records, persistState],
  );

  const updateWorkspace = useCallback(
    (workspace_id: string, patch: WorkspaceUpdatePatch) => {
      const { records: nextRecords, updated } = updateWorkspaceRecords(
        records,
        workspace_id,
        patch,
      );
      setRecords(nextRecords);
      const nextSelection =
        selection.kind === "workspace" && selection.workspace_id === workspace_id && !nextRecords.some((r) => r.workspace_id === workspace_id)
          ? ({ kind: "all" } as WorkspaceSelection)
          : selection;
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
      persistState(nextRecords);
      return updated;
    },
    [project_id, records, selection, persistState],
  );

  const deleteWorkspace = useCallback(
    (workspace_id: string) => {
      const nextRecords = deleteWorkspaceRecords(records, workspace_id);
      const nextSelection =
        selection.kind === "workspace" && selection.workspace_id === workspace_id
          ? ({ kind: "all" } as WorkspaceSelection)
          : selection;
      setRecords(nextRecords);
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
      persistState(nextRecords);
    },
    [project_id, records, selection, persistState],
  );

  const touchWorkspace = useCallback(
    (workspace_id: string) => {
      const { records: nextRecords, updated } = touchWorkspaceRecords(
        records,
        workspace_id,
      );
      setRecords(nextRecords);
      persistState(nextRecords);
      return updated;
    },
    [records, persistState],
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
    loading,
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
  return defaultWorkspaceTitleCore(path);
}
