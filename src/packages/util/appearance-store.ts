/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  APPEARANCE_ACCOUNT_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
  parseStoredAppearance,
  readStoredAppearance,
  resolveAppearance,
  serializeAppearance,
  type AppearancePreference,
  type AppearanceStorageReader,
  type ResolvedAppearance,
} from "./appearance";

export interface AppearanceSnapshot {
  preference: AppearancePreference;
  resolved: ResolvedAppearance;
  saving: boolean;
  saveError?: string;
}

export type SaveAppearance = (
  preference: AppearancePreference,
) => Promise<void>;

export interface AppearanceStoreOptions {
  storage?: AppearanceStorageReader & {
    setItem(key: string, value: string): void;
  };
  systemDark?: boolean;
  accountHint?: string;
  legacy?: "essential" | "scratchpad";
}

// An external store shared by small entry-specific React adapters. No DOM, React,
// authentication, or account client is loaded by importing or constructing it.
export function createAppearanceStore(options: AppearanceStoreOptions = {}) {
  const storage = options.storage;
  let systemDark = options.systemDark ?? false;
  let accountId: string | undefined;
  let cacheAccountId = options.accountHint;
  let save: SaveAppearance | undefined;
  let epoch = 0;
  let revision = 0;
  let pending = false;
  let observedChoice = false;
  let incoming: AppearancePreference | undefined;
  let queue = Promise.resolve();
  let selectedBeforeAccount = false;
  const listeners = new Set<() => void>();
  let snapshot: AppearanceSnapshot = {
    preference: readStoredAppearance(
      storage,
      options.accountHint,
      options.legacy,
    ),
    resolved: "light",
    saving: false,
  };
  snapshot.resolved = resolveAppearance(snapshot.preference, systemDark);

  function publish(next: Partial<AppearanceSnapshot>) {
    const updated = { ...snapshot, ...next };
    updated.resolved = resolveAppearance(updated.preference, systemDark);
    if (
      updated.preference === snapshot.preference &&
      updated.resolved === snapshot.resolved &&
      updated.saving === snapshot.saving &&
      updated.saveError === snapshot.saveError
    )
      return;
    snapshot = updated;
    for (const listener of listeners) listener();
  }

  function persist(preference: AppearancePreference, id?: string) {
    try {
      storage?.setItem(
        id ? APPEARANCE_ACCOUNT_STORAGE_KEY : APPEARANCE_STORAGE_KEY,
        serializeAppearance(preference, id),
      );
    } catch {
      // Local storage is optional. Account saves and in-memory changes still work.
    }
  }

  // Commit only the visitor's legacy preference, never an account cache into the
  // visitor slot. Explicit System must prevent another entry from reimporting it.
  if (options.legacy)
    persist(readStoredAppearance(storage, undefined, options.legacy));

  function choose(preference: AppearancePreference): Promise<void> {
    const currentRevision = ++revision;
    const currentEpoch = epoch;
    const writer = save;
    const id = accountId;
    selectedBeforeAccount = id == null;
    pending = writer != null && id != null;
    observedChoice = false;
    persist(preference, id);
    publish({ preference, saving: pending, saveError: undefined });
    if (!writer || !id) return Promise.resolve();

    // Serialize writes and skip obsolete queued choices. A slow previous write
    // cannot become the final persisted preference after a newer click.
    queue = queue.then(async () => {
      if (epoch !== currentEpoch || revision !== currentRevision) return;
      try {
        await writer(preference);
        if (epoch !== currentEpoch || revision !== currentRevision) return;
        pending = false;
        const reconciled = observedChoice && incoming ? incoming : preference;
        persist(reconciled, id);
        publish({ preference: reconciled, saving: false });
      } catch {
        if (epoch !== currentEpoch || revision !== currentRevision) return;
        pending = false;
        publish({
          saving: false,
          saveError:
            "Appearance changed here, but could not be saved to your account. Select an appearance to retry.",
        });
      }
    });
    return queue;
  }

  function receiveAccount(
    id: string | undefined,
    preference?: AppearancePreference,
    writer?: SaveAppearance,
  ) {
    const changedAccount = id !== accountId;
    const clearedHint = id == null && cacheAccountId != null;
    cacheAccountId = id;
    save = id ? writer : undefined;
    if (changedAccount || clearedHint) {
      accountId = id;
      epoch++;
      revision++;
      pending = false;
      observedChoice = false;
      incoming = undefined;
      queue = Promise.resolve();
      const preserveRecentClick =
        id != null && id === options.accountHint && selectedBeforeAccount;
      selectedBeforeAccount = false;
      if (preserveRecentClick && writer) {
        void choose(snapshot.preference);
        return;
      }
      const next = id
        ? (preference ?? readStoredAppearance(storage, id))
        : readStoredAppearance(storage);
      if (id) persist(next, id);
      publish({ preference: next, saving: false, saveError: undefined });
    }
    if (id == null || preference == null) return;
    incoming = preference;
    if (pending) {
      if (preference === snapshot.preference) observedChoice = true;
      return;
    }
    // Keep an unsaved explicit local selection visible until retry or logout.
    if (snapshot.saveError) return;
    persist(preference, id);
    publish({ preference });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    choose,
    receiveAccount,
    setSystemDark(dark: boolean) {
      systemDark = dark;
      publish({});
    },
    receiveStorageChange(key: string | null) {
      if (
        key != null &&
        key !== APPEARANCE_STORAGE_KEY &&
        key !== APPEARANCE_ACCOUNT_STORAGE_KEY
      )
        return;
      if (pending || snapshot.saveError) return;
      if (cacheAccountId) {
        if (key === APPEARANCE_STORAGE_KEY) return;
        try {
          const cached = parseStoredAppearance(
            storage?.getItem(APPEARANCE_ACCOUNT_STORAGE_KEY) ?? null,
          );
          if (cached?.account_id === cacheAccountId)
            publish({ preference: cached.preference });
        } catch {
          /* Keep the active choice if storage became unavailable. */
        }
      } else if (key !== APPEARANCE_ACCOUNT_STORAGE_KEY) {
        publish({ preference: readStoredAppearance(storage) });
      }
    },
  };
}

export type AppearanceStore = ReturnType<typeof createAppearanceStore>;
