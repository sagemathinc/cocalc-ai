import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
export function isSettingsDrawerOpen() {
  return open;
}
export function setSettingsDrawerOpen(value: boolean) {
  open = value;
  listeners.forEach((listener) => listener());
}
export function useSettingsDrawerOpen() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, isSettingsDrawerOpen);
}
