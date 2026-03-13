/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { ActiveFileSort } from "@cocalc/frontend/project_store";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { waitForPersistAccountId } from "./persist-account-id";

interface ExplorerSettings {
  sortColumn?: string;
  sortDescending?: boolean;
  showDirectoryTree?: boolean;
  flyoutSortColumn?: string;
  flyoutSortDescending?: boolean;
}

interface SettingsDKV {
  get(key: string): ExplorerSettings | undefined;
  set(key: string, value: ExplorerSettings): void;
  close?(): void;
}

const DKV_NAME = "explorer-settings";

const DEFAULT_FLYOUT_SORT: ActiveFileSort = {
  column_name: "time",
  is_descending: false,
};

interface UseSettingsDKVResult {
  dkvRef: React.MutableRefObject<SettingsDKV | null>;
  initializedRef: React.MutableRefObject<boolean>;
  markDirtyBeforeInit: () => void;
}

function useSettingsDKV(
  project_id: string,
  onRestore: ((saved: ExplorerSettings | undefined) => void) | null,
): UseSettingsDKVResult {
  const dkvRef = useRef<SettingsDKV | null>(null);
  const initializedRef = useRef(false);
  const dirtyRef = useRef(false);
  const firstRenderRef = useRef(true);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  const markDirtyBeforeInit = useCallback(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    if (!initializedRef.current) {
      dirtyRef.current = true;
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    let conatDkv: SettingsDKV | null = null;

    (async () => {
      if (!isMounted) return;

      const account_id = await waitForPersistAccountId();
      if (!isMounted) return;
      try {
        conatDkv = (await webapp_client.conat_client.dkv<ExplorerSettings>({
          account_id,
          name: DKV_NAME,
        })) as unknown as SettingsDKV;
        if (!isMounted) {
          conatDkv.close?.();
          return;
        }

        dkvRef.current = conatDkv;
        if (!dirtyRef.current) {
          onRestoreRef.current?.(conatDkv.get(project_id));
        }
      } catch {
        // ignore DKV failures
      } finally {
        if (isMounted) {
          initializedRef.current = true;
        } else {
          conatDkv?.close?.();
        }
      }
    })();

    return () => {
      isMounted = false;
      dkvRef.current?.close?.();
      dkvRef.current = null;
      initializedRef.current = false;
      dirtyRef.current = false;
      firstRenderRef.current = true;
    };
  }, [project_id]);

  return { dkvRef, initializedRef, markDirtyBeforeInit };
}

export function useExplorerSettings(project_id: string): void {
  const show_directory_tree =
    useTypedRedux({ project_id }, "show_directory_tree") ?? false;

  const { dkvRef, initializedRef, markDirtyBeforeInit } = useSettingsDKV(
    project_id,
    (saved) => {
      const actions = redux.getProjectActions(project_id);
      actions?.setState({
        ...(saved?.showDirectoryTree != null
          ? { show_directory_tree: saved.showDirectoryTree }
          : {}),
      });
    },
  );

  useEffect(markDirtyBeforeInit, [markDirtyBeforeInit, show_directory_tree]);

  useEffect(() => {
    if (!initializedRef.current || !dkvRef.current) return;
    try {
      const current = dkvRef.current.get(project_id) ?? {};
      if (current.showDirectoryTree !== show_directory_tree) {
        dkvRef.current.set(project_id, {
          ...current,
          showDirectoryTree: show_directory_tree,
        });
      }
    } catch {
      // ignore DKV failures
    }
  }, [dkvRef, initializedRef, project_id, show_directory_tree]);
}

export function useFlyoutSettings(
  project_id: string,
): [ActiveFileSort, React.Dispatch<React.SetStateAction<ActiveFileSort>>] {
  const [flyoutSort, setFlyoutSort] =
    useState<ActiveFileSort>(DEFAULT_FLYOUT_SORT);

  const { dkvRef, initializedRef, markDirtyBeforeInit } = useSettingsDKV(
    project_id,
    (saved) => {
      if (!saved?.flyoutSortColumn) return;
      setFlyoutSort({
        column_name: saved.flyoutSortColumn,
        is_descending: saved.flyoutSortDescending ?? false,
      });
    },
  );

  useEffect(markDirtyBeforeInit, [flyoutSort, markDirtyBeforeInit]);

  useEffect(() => {
    if (!initializedRef.current || !dkvRef.current) return;
    try {
      const current = dkvRef.current.get(project_id) ?? {};
      if (
        current.flyoutSortColumn !== flyoutSort.column_name ||
        current.flyoutSortDescending !== flyoutSort.is_descending
      ) {
        dkvRef.current.set(project_id, {
          ...current,
          flyoutSortColumn: flyoutSort.column_name,
          flyoutSortDescending: flyoutSort.is_descending,
        });
      }
    } catch {
      // ignore DKV failures
    }
  }, [dkvRef, flyoutSort, initializedRef, project_id]);

  return [flyoutSort, setFlyoutSort];
}
