/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useSyncExternalStore } from "react";
import { getBrowserAppearanceStore } from "@cocalc/util/appearance-browser";

export function useAppearance() {
  const store = getBrowserAppearanceStore();
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return { ...snapshot, setPreference: store.choose };
}
