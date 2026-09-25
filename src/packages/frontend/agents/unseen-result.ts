import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const memory = new Map<string, boolean>();
export function resultKey(
  account: string,
  project: string,
  path: string,
  thread: string,
) {
  return `cocalc-unseen-agent-result:${JSON.stringify([account, project, path, thread])}`;
}
export function hasUnseenResult(key: string): boolean {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
export function setUnseenResult(key: string, unseen: boolean) {
  memory.set(key, unseen);
  try {
    if (unseen) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {}
  listeners.forEach((listener) => listener());
}
export function useUnseenResult(key: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const storage = (event: StorageEvent) => {
        if (event.key === key || event.key === null) {
          memory.delete(key);
          listener();
        }
      };
      window.addEventListener("storage", storage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", storage);
      };
    },
    () => hasUnseenResult(key),
  );
}
