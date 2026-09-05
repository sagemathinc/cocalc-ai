/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { appearanceAccountCookie, APPEARANCE_SYSTEM_QUERY } from "./appearance";
import {
  createAppearanceStore,
  type AppearanceStore,
} from "./appearance-store";

export function createBrowserAppearanceStore(
  browser: Window,
  legacy?: "essential" | "scratchpad",
) {
  let storage: Storage | undefined;
  try {
    storage = browser.localStorage;
  } catch {
    /* Private/blocked storage. */
  }
  let media: MediaQueryList | undefined;
  let accountHint: string | undefined;
  try {
    media = browser.matchMedia?.(APPEARANCE_SYSTEM_QUERY);
  } catch {
    /* Unsupported media API. */
  }
  try {
    accountHint = appearanceAccountCookie(
      browser.document.cookie,
      browser.location.pathname,
    );
  } catch {
    /* Cookies may be disabled. */
  }
  const store = createAppearanceStore({
    storage,
    systemDark: media?.matches,
    accountHint,
    legacy,
  });
  const apply = () => {
    const { resolved } = store.getSnapshot();
    const root = browser.document.documentElement;
    root.dataset.cocalcTheme = resolved;
    root.style.colorScheme = resolved;
  };
  const onMedia = (event: MediaQueryListEvent) =>
    store.setSystemDark(event.matches);
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea != null && event.storageArea !== storage) return;
    store.receiveStorageChange(event.key);
  };
  const unsubscribe = store.subscribe(apply);
  media?.addEventListener("change", onMedia);
  browser.addEventListener("storage", onStorage);
  apply();
  return {
    store,
    dispose() {
      unsubscribe();
      media?.removeEventListener("change", onMedia);
      browser.removeEventListener("storage", onStorage);
    },
  };
}

let browserStore: ReturnType<typeof createBrowserAppearanceStore> | undefined;
const serverStore = createAppearanceStore();

// Entry teardown (including tests/HMR) must release the OS and storage listeners.
export function disposeBrowserAppearanceStore(): void {
  browserStore?.dispose();
  browserStore = undefined;
}

// Lazy initialization keeps server imports safe and gives every provider in an
// entry the same root owner. Merely importing this module changes nothing.
export function getBrowserAppearanceStore(
  legacy?: "essential" | "scratchpad",
): AppearanceStore {
  if (typeof window === "undefined") return serverStore;
  const entry = window.document.body?.dataset.cocalcEntry;
  browserStore ??= createBrowserAppearanceStore(
    window,
    legacy ?? (entry === "scratchpad" ? "scratchpad" : undefined),
  );
  return browserStore.store;
}
