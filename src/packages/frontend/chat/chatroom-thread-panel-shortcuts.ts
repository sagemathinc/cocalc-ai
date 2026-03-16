import { shouldSuppressGlobalShortcuts } from "@cocalc/frontend/keyboard/boundary";

export function shouldOpenThreadSearchShortcut(
  event: KeyboardEvent,
  anyOverlayOpen: boolean,
): boolean {
  if (anyOverlayOpen) return false;
  if (shouldSuppressGlobalShortcuts(event)) return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return event.key.toLowerCase() === "f";
}
