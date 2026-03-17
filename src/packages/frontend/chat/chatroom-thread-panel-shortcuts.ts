import { shouldSuppressGlobalShortcuts } from "@cocalc/frontend/keyboard/boundary";

function containsNode(
  root: ParentNode | null,
  value: EventTarget | null,
): boolean {
  return value instanceof Node && !!root?.contains(value);
}

export function chatPanelOwnsThreadSearchShortcut(
  root: ParentNode | null,
  event: KeyboardEvent,
): boolean {
  if (containsNode(root, event.target)) return true;
  return containsNode(root, document.activeElement);
}

export function shouldOpenThreadSearchShortcut(
  event: KeyboardEvent,
  anyOverlayOpen: boolean,
  shortcutEnabled = true,
): boolean {
  if (!shortcutEnabled) return false;
  if (anyOverlayOpen) return false;
  if (shouldSuppressGlobalShortcuts(event)) return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return event.key.toLowerCase() === "f";
}
