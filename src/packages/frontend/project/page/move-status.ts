import type { MoveLroState } from "@cocalc/frontend/project/move-ops";

export function shouldRenderMoveStatus(
  moveLro?: MoveLroState,
  moveReopenRequired?: boolean,
): boolean {
  if (!moveLro) return false;
  const summary = moveLro.summary;
  if (summary?.dismissed_at != null) return false;
  return summary?.status !== "succeeded" || !!moveReopenRequired;
}
