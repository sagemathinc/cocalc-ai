import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WORKSPACES_STORE_RECORDS_KEY,
  WORKSPACES_STORE_VERSION_KEY,
  createStoredWorkspaceRecord,
  createWorkspaceRecord,
  createWorkspaceRecords,
  defaultWorkspaceTitle as defaultWorkspaceTitleCore,
  deleteWorkspaceRecords,
  deleteStoredWorkspaceRecord,
  hasWorkspaceStoreState,
  normalizeWorkspaceSelection,
  openWorkspaceStore,
  pathMatchesWorkspaceRoot,
  readStoredWorkspaceRecords,
  readWorkspaceRecordsFromStore,
  resolveWorkspaceForPath as resolveWorkspaceForPathCore,
  selectionForWorkspacePath as selectionForWorkspacePathCore,
  selectionMatchesWorkspacePath,
  touchWorkspaceRecords,
  touchStoredWorkspaceRecord,
  updateWorkspaceRecords,
  updateStoredWorkspaceRecord,
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
import {
  loadSessionSelection,
  persistSessionSelection,
  WORKSPACE_SELECTION_EVENT,
} from "./selection-runtime";

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
  const canPersist =
    typeof account_id === "string" && account_id.trim().length > 0;
  const [loading, setLoading] = useState(canPersist);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [selection, setSelectionState] = useState<WorkspaceSelection>(() =>
    loadSessionSelection(project_id),
  );
  const storeRef = useRef<Awaited<
    ReturnType<typeof openWorkspaceStore>
  > | null>(null);
  const recordsRef = useRef(records);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onSelection = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          project_id?: string;
          selection?: WorkspaceSelection;
        }>
      ).detail;
      if (`${detail?.project_id ?? ""}` !== project_id) return;
      const nextSelection = normalizeWorkspaceSelection(
        detail?.selection,
        recordsRef.current,
      );
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
    };
    window.addEventListener(
      WORKSPACE_SELECTION_EVENT,
      onSelection as EventListener,
    );
    return () => {
      window.removeEventListener(
        WORKSPACE_SELECTION_EVENT,
        onSelection as EventListener,
      );
    };
  }, [project_id]);

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
      | ((event: { key: string; value?: WorkspaceRecord[] | number }) => void)
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
        const storeSelection = readSelectionForProject(
          project_id,
          storeRecords,
        );
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
          const nextSelection = readSelectionForProject(
            project_id,
            nextRecords,
          );
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
      records.find(
        (record) => record.workspace_id === selection.workspace_id,
      ) ?? null
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
      const record: WorkspaceRecord =
        storeRef.current != null
          ? createStoredWorkspaceRecord(storeRef.current, {
              project_id,
              input,
            })
          : createWorkspaceRecord({ project_id, input });
      const nextRecords =
        storeRef.current != null
          ? readStoredWorkspaceRecords(storeRef.current)
          : createWorkspaceRecords(records, record);
      const nextSelection: WorkspaceSelection = {
        kind: "workspace",
        workspace_id: record.workspace_id,
      };
      setRecords(nextRecords);
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
      if (storeRef.current == null) {
        persistState(nextRecords);
      }
      return record;
    },
    [project_id, records, persistState],
  );

  const updateWorkspace = useCallback(
    (workspace_id: string, patch: WorkspaceUpdatePatch) => {
      const updated =
        storeRef.current != null
          ? updateStoredWorkspaceRecord(storeRef.current, workspace_id, patch)
          : null;
      const nextRecords =
        storeRef.current != null
          ? readStoredWorkspaceRecords(storeRef.current)
          : updateWorkspaceRecords(records, workspace_id, patch).records;
      setRecords(nextRecords);
      const nextSelection =
        selection.kind === "workspace" &&
        selection.workspace_id === workspace_id &&
        !nextRecords.some((r) => r.workspace_id === workspace_id)
          ? ({ kind: "all" } as WorkspaceSelection)
          : selection;
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
      if (storeRef.current == null) {
        persistState(nextRecords);
      }
      return updated;
    },
    [project_id, records, selection, persistState],
  );

  const deleteWorkspace = useCallback(
    (workspace_id: string) => {
      const nextRecords =
        storeRef.current != null
          ? deleteStoredWorkspaceRecord(storeRef.current, workspace_id)
          : deleteWorkspaceRecords(records, workspace_id);
      const nextSelection =
        selection.kind === "workspace" &&
        selection.workspace_id === workspace_id
          ? ({ kind: "all" } as WorkspaceSelection)
          : selection;
      setRecords(nextRecords);
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
      if (storeRef.current == null) {
        persistState(nextRecords);
      }
    },
    [project_id, records, selection, persistState],
  );

  const touchWorkspace = useCallback(
    (workspace_id: string) => {
      const updated =
        storeRef.current != null
          ? touchStoredWorkspaceRecord(storeRef.current, workspace_id)
          : null;
      const nextRecords =
        storeRef.current != null
          ? readStoredWorkspaceRecords(storeRef.current)
          : touchWorkspaceRecords(records, workspace_id).records;
      setRecords(nextRecords);
      if (storeRef.current == null) {
        persistState(nextRecords);
      }
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
    (paths: readonly string[]) =>
      paths.filter((path) => selectionMatchesPath(selection, records, path)),
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
