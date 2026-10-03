/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { CollectionView } from "./collection";

export interface CollectionPreferences {
  view: CollectionView;
  order: string[];
}

export function normalizeCollectionPreferences(
  value: unknown,
): CollectionPreferences {
  try {
    const plain = (value as any)?.toJS?.() ?? value;
    const data = typeof plain === "string" ? JSON.parse(plain) : plain;
    return {
      view: data?.view === "grid" ? "grid" : "list",
      order: Array.isArray(data?.order)
        ? [
            ...new Set<string>(
              data.order.filter((id) => typeof id === "string"),
            ),
          ]
        : [],
    };
  } catch {
    return { view: "list", order: [] };
  }
}

/** Account settings store only IDs/view preferences, never authorized metadata. */
export function useCollectionPreferences(collection: string) {
  const accountId = useTypedRedux("account", "account_id");
  const settings = useTypedRedux("account", "other_settings");
  const setting = `workspace_collection_${collection}_v1`;
  const persisted = normalizeCollectionPreferences(settings?.get?.(setting));
  const key = `${accountId}:${setting}`;
  const [local, setLocal] = useState<{
    key: string;
    value: CollectionPreferences;
  }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const state = useRef({
    key,
    value: persisted,
    pending: 0,
    failed: false,
    sequence: 0,
  });
  const queue = useRef(Promise.resolve());
  if (state.current.key !== key)
    state.current = {
      key,
      value: persisted,
      pending: 0,
      failed: false,
      sequence: 0,
    };
  const value = local?.key === key ? local.value : persisted;
  const persistedKey = JSON.stringify(persisted);
  useEffect(() => {
    if (!state.current.pending && !state.current.failed)
      state.current.value = persisted;
  }, [key, persistedKey]);

  function save(next: CollectionPreferences) {
    const current = state.current;
    current.value = next;
    current.pending++;
    const sequence = ++current.sequence;
    setLocal({ key, value: next });
    setFailure(undefined);
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (
          state.current !== current ||
          redux.getStore("account")?.get("account_id") !== accountId
        )
          throw Error(
            "Account changed before collection preferences could be saved",
          );
        await redux
          .getActions("account")
          .set_other_settings_and_wait(setting, JSON.stringify(next));
      })
      .then(() => {
        if (state.current === current && sequence === current.sequence)
          current.failed = false;
      })
      .catch((error) => {
        if (state.current === current && sequence === current.sequence) {
          current.failed = true;
          setFailure({
            key,
            message: `Collection changes were not saved: ${String(error)}`,
          });
        }
      })
      .finally(() => {
        current.pending--;
        if (
          state.current === current &&
          current.pending === 0 &&
          !current.failed
        )
          setLocal(undefined);
      });
  }
  return {
    value,
    error: failure?.key === key ? failure.message : undefined,
    setView: (view: CollectionView) => save({ ...state.current.value, view }),
    setOrder: (order: string[]) => save({ ...state.current.value, order }),
    retry: () => save(state.current.value),
  };
}
