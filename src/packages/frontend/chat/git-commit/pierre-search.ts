import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { LegacyFileLocations } from "./legacy-locations";

export const PIERRE_SEARCH_CSS = `[data-cocalc-find-match] { outline: 1px dashed ${UI_COLORS.warning}; outline-offset: -1px; box-shadow: inset 3px 0 ${UI_COLORS.warning}; }`;

export function pierreSearchLines(
  files: readonly LegacyFileLocations[],
  matches: ReadonlyMap<number, ReadonlySet<number>>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  files.forEach((file, index) => {
    const lines = new Set<string>();
    for (const rowIndex of matches.get(index) ?? []) {
      const row = file.lines[rowIndex];
      if (!row?.commentable) continue;
      if (row.oldLineNumber != null) lines.add(`old:${row.oldLineNumber}`);
      if (row.newLineNumber != null) lines.add(`new:${row.newLineNumber}`);
    }
    result.set(file.fileId, lines);
  });
  return result;
}

export function highlightPierreSearch(
  host: HTMLElement,
  matches?: ReadonlySet<string>,
): void {
  for (const row of host.shadowRoot?.querySelectorAll<HTMLElement>(
    "[data-line]",
  ) ?? []) {
    const side =
      row.dataset.lineType === "change-deletion" ||
      row.closest("[data-deletions]")
        ? "old"
        : "new";
    row.toggleAttribute(
      "data-cocalc-find-match",
      !!matches?.has(`${side}:${row.dataset.line}`),
    );
  }
}
