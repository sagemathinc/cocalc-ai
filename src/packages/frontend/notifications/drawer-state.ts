import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
export function setNotificationsOpen(value: boolean) {
  open = value;
  listeners.forEach((listener) => listener());
}
export function useNotificationsOpen() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => open,
  );
}
