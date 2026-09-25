import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export function ThreadPanelToolbar({
  showInline,
  portal,
  render,
}: {
  showInline: boolean;
  portal?: HTMLElement | null;
  render: () => ReactNode;
}) {
  if (portal != null) return createPortal(render(), portal);
  // null means the requested portal is not mounted yet, not inline fallback.
  return portal === undefined && showInline ? <>{render()}</> : null;
}
