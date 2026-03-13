import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WORKSPACES_STORE_RECORDS_KEY,
  WORKSPACES_STORE_ORDER_KEY,
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
  readWorkspaceOrderFromStore,
  readStoredWorkspaceRecords,
  readWorkspaceRecordsFromStore,
  reorderWorkspaceRecords,
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
  loadSessionWorkspaceRecord,
  persistSessionSelection,
  persistSessionWorkspaceRecord,
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

function sameSelection(a: WorkspaceSelection, b: WorkspaceSelection): boolean {
  return (
    a.kind === b.kind &&
    (a.kind !== "workspace" ||
      a.workspace_id ===
        (b as WorkspaceSelection & { workspace_id?: string }).workspace_id)
  );
}

export function useProjectWorkspaces(
  account_id: string | undefined,
  project_id: string,
): ProjectWorkspaceState {
  const canPersist =
    typeof account_id === "string" && account_id.trim().length > 0;
  const [loading, setLoading] = useState(canPersist);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [order, setOrderState] = useState<string[]>([]);
  const [selection, setSelectionState] = useState<WorkspaceSelection>(() =>
    loadSessionSelection(project_id),
  );
  const [cachedWorkspaceRecord, setCachedWorkspaceRecord] =
    useState<WorkspaceRecord | null>(() => loadSessionWorkspaceRecord(project_id));
  const storeRef = useRef<Awaited<
    ReturnType<typeof openWorkspaceStore>
  > | null>(null);
  const recordsRef = useRef(records);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  useEffect(() => {
    const nextSelection = readSelectionForProject(project_id, records);
    if (sameSelection(selection, nextSelection)) return;
    setSelectionState(nextSelection);
  }, [project_id, records, selection]);

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
      setCachedWorkspaceRecord(loadSessionWorkspaceRecord(project_id));
    }
  }, [account_id, project_id, canPersist]);

  useEffect(() => {
    if (selection.kind !== "workspace") {
      if (cachedWorkspaceRecord != null) {
        setCachedWorkspaceRecord(null);
        persistSessionWorkspaceRecord(project_id, null);
      }
      return;
    }
    const actual =
      records.find((record) => record.workspace_id === selection.workspace_id) ??
      null;
    if (actual != null) {
      if (
        cachedWorkspaceRecord?.workspace_id !== actual.workspace_id ||
        cachedWorkspaceRecord.updated_at !== actual.updated_at
      ) {
        setCachedWorkspaceRecord(actual);
        persistSessionWorkspaceRecord(project_id, actual);
      }
      return;
    }
    if (!loading && cachedWorkspaceRecord != null) {
      setCachedWorkspaceRecord(null);
      persistSessionWorkspaceRecord(project_id, null);
    }
  }, [project_id, selection, records, loading, cachedWorkspaceRecord]);

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
        const storeOrder = readWorkspaceOrderFromStore(store, storeRecords);
        const storeSelection = readSelectionForProject(
          project_id,
          storeRecords,
        );
        const hasStoreState = hasWorkspaceStoreState(store);

        const hasSeedState = recordsRef.current.length > 0;

        if (!hasStoreState && hasSeedState) {
          writeWorkspaceRecordsToStore(store, recordsRef.current, order);
        } else {
          setRecords(storeRecords);
          setOrderState(storeOrder);
          setSelectionState(storeSelection);
        }

        onChange = (event) => {
          if (
            event.key !== WORKSPACES_STORE_RECORDS_KEY &&
            event.key !== WORKSPACES_STORE_ORDER_KEY &&
            event.key !== WORKSPACES_STORE_VERSION_KEY
          ) {
            return;
          }
          const nextRecords = readWorkspaceRecordsFromStore(store!);
          const nextOrder = readWorkspaceOrderFromStore(store!, nextRecords);
          const nextSelection = readSelectionForProject(
            project_id,
            nextRecords,
          );
          setRecords(nextRecords);
          setOrderState(nextOrder);
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
    (nextRecords: WorkspaceRecord[], nextOrder: string[]) => {
      if (!canPersist || storeRef.current == null) {
        return;
      }
      writeWorkspaceRecordsToStore(storeRef.current, nextRecords, nextOrder);
    },
    [canPersist],
  );

  const current = useMemo(() => {
    if (selection.kind !== "workspace") return null;
    const actual =
      records.find(
        (record) => record.workspace_id === selection.workspace_id,
      ) ?? null;
    if (actual != null) return actual;
    if (
      loading &&
      cachedWorkspaceRecord?.workspace_id === selection.workspace_id
    ) {
      return cachedWorkspaceRecord;
    }
    return null;
  }, [records, selection, loading, cachedWorkspaceRecord]);

  const setSelection = useCallback(
    (next: WorkspaceSelection) => {
      const normalized = normalizeWorkspaceSelection(next, recordsRef.current);
      const changed = !sameSelection(selection, normalized);
      if (
        changed &&
        normalized.kind === "workspace" &&
        normalized.workspace_id.trim()
      ) {
        const updated =
          storeRef.current != null
            ? touchStoredWorkspaceRecord(
                storeRef.current,
                normalized.workspace_id,
              )
            : null;
        const nextRecords =
          storeRef.current != null
            ? readStoredWorkspaceRecords(storeRef.current)
            : touchWorkspaceRecords(
                recordsRef.current,
                normalized.workspace_id,
                Date.now(),
                order,
              ).records;
        const nextOrder =
          storeRef.current != null
            ? readWorkspaceOrderFromStore(storeRef.current, nextRecords)
            : order;
        setRecords(nextRecords);
        setOrderState(nextOrder);
        if (storeRef.current == null && updated == null) {
          persistState(nextRecords, nextOrder);
        }
      }
      setSelectionState(normalized);
      persistSessionSelection(project_id, normalized);
    },
    [order, persistState, project_id, selection],
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
          : createWorkspaceRecords(records, record, [
              ...order,
              record.workspace_id,
            ]);
      const nextOrder =
        storeRef.current != null
          ? readWorkspaceOrderFromStore(storeRef.current, nextRecords)
          : [
              ...order.filter((id) => id !== record.workspace_id),
              record.workspace_id,
            ];
      const nextSelection: WorkspaceSelection = {
        kind: "workspace",
        workspace_id: record.workspace_id,
      };
      setRecords(nextRecords);
      setOrderState(nextOrder);
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
      if (storeRef.current == null) {
        persistState(nextRecords, nextOrder);
      }
      return record;
    },
    [order, persistState, project_id, records],
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
          : updateWorkspaceRecords(
              records,
              workspace_id,
              patch,
              Date.now(),
              order,
            ).records;
      const nextOrder =
        storeRef.current != null
          ? readWorkspaceOrderFromStore(storeRef.current, nextRecords)
          : order;
      setRecords(nextRecords);
      setOrderState(nextOrder);
      const nextSelection =
        selection.kind === "workspace" &&
        selection.workspace_id === workspace_id &&
        !nextRecords.some((r) => r.workspace_id === workspace_id)
          ? ({ kind: "all" } as WorkspaceSelection)
          : selection;
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
      if (storeRef.current == null) {
        persistState(nextRecords, nextOrder);
      }
      return updated;
    },
    [order, project_id, records, selection, persistState],
  );

  const deleteWorkspace = useCallback(
    (workspace_id: string) => {
      const nextRecords =
        storeRef.current != null
          ? deleteStoredWorkspaceRecord(storeRef.current, workspace_id)
          : deleteWorkspaceRecords(records, workspace_id);
      const nextOrder =
        storeRef.current != null
          ? readWorkspaceOrderFromStore(storeRef.current, nextRecords)
          : order.filter((id) => id !== workspace_id);
      const nextSelection =
        selection.kind === "workspace" &&
        selection.workspace_id === workspace_id
          ? ({ kind: "all" } as WorkspaceSelection)
          : selection;
      setRecords(nextRecords);
      setOrderState(nextOrder);
      setSelectionState(nextSelection);
      persistSessionSelection(project_id, nextSelection);
      if (storeRef.current == null) {
        persistState(nextRecords, nextOrder);
      }
    },
    [order, project_id, records, selection, persistState],
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
          : touchWorkspaceRecords(records, workspace_id, Date.now(), order)
              .records;
      const nextOrder =
        storeRef.current != null
          ? readWorkspaceOrderFromStore(storeRef.current, nextRecords)
          : order;
      setRecords(nextRecords);
      setOrderState(nextOrder);
      if (storeRef.current == null) {
        persistState(nextRecords, nextOrder);
      }
      return updated;
    },
    [order, records, persistState],
  );

  const reorderWorkspaces = useCallback(
    (nextOrderInput: string[]) => {
      const nextOrder = nextOrderInput.filter(
        (id, i) => nextOrderInput.indexOf(id) === i,
      );
      const nextRecords = reorderWorkspaceRecords(
        recordsRef.current,
        nextOrder,
      );
      setRecords(nextRecords);
      setOrderState(nextOrder);
      if (storeRef.current != null) {
        writeWorkspaceRecordsToStore(storeRef.current, nextRecords, nextOrder);
      } else {
        persistState(nextRecords, nextOrder);
      }
    },
    [persistState],
  );

  const resolve = useCallback(
    (path: string) => resolveWorkspaceForPath(records, path),
    [records],
  );

  const matchesPath = useCallback(
    (path: string) => {
      if (selection.kind === "workspace" && current != null) {
        return pathMatchesRoot(path, current.root_path);
      }
      return selectionMatchesPath(selection, records, path);
    },
    [selection, records, current],
  );

  const filterPaths = useCallback(
    (paths: readonly string[]) => paths.filter((path) => matchesPath(path)),
    [matchesPath],
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
    reorderWorkspaces,
    deleteWorkspace,
    touchWorkspace,
  };
}

export function defaultWorkspaceTitle(path: string): string {
  return defaultWorkspaceTitleCore(path);
}
