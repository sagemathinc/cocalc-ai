import { useState, useSyncExternalStore } from "react";

type Flags = Record<string, boolean>;
type Update = (previous: Flags) => Flags;

function createStore() {
  let snapshot = { expanded: {} as Flags, explicit: {} as Flags };
  const listeners = new Set<() => void>();
  const update = (key: keyof typeof snapshot, change: Update) => {
    const next = change(snapshot[key]);
    if (next === snapshot[key]) return;
    snapshot = { ...snapshot, [key]: next };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setExpanded: (change: Update) => update("expanded", change),
    setExplicit: (change: Update) => update("explicit", change),
  };
}

// The document actions outlive thread/virtual-row mounts but are released when
// the chat closes. Persist only visibility flags here, never streamed events.
const stores = new WeakMap<object, ReturnType<typeof createStore>>();

export function useActivityVisibility(document?: object) {
  // Public/time-travel viewers have no actions. Keep their state private to
  // this mounted viewer instead of sharing a global fallback document key.
  const [localStore] = useState(createStore);
  let store = document == null ? localStore : stores.get(document);
  if (!store && document != null) {
    store = createStore();
    stores.set(document, store);
  }
  store ??= localStore;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return {
    ...snapshot,
    setExpanded: store.setExpanded,
    setExplicit: store.setExplicit,
  };
}
