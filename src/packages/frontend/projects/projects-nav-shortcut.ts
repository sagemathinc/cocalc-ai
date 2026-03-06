import { shouldSuppressGlobalShortcuts } from "@cocalc/frontend/keyboard/boundary";

export function shouldOpenProjectsNavShortcut(event: KeyboardEvent): boolean {
  return (
    !shouldSuppressGlobalShortcuts(event) &&
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === "p"
  );
}
