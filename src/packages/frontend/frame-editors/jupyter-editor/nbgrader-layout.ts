import type { Map } from "immutable";

export const NBGRADER_CLASSIC_REASON =
  "Studio is unavailable for nbgrader notebooks because it does not display assignment grading information.";

export function hasNbgraderMetadata(cells?: Map<string, any>): boolean {
  return !!cells?.some((cell) => cell.hasIn(["metadata", "nbgrader"]));
}
