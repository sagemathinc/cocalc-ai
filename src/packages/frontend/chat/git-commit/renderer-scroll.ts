import type { DiffScrollAnchor } from "@cocalc/frontend/components/diff-viewer/review-model";
import { buildGitReviewLineElementId } from "./ids";
import { legacyAnchorForLocation } from "./legacy-locations";
import type { LegacyFileLocations } from "./legacy-locations";

export function classicScrollTarget(
  files: LegacyFileLocations[],
  anchor: DiffScrollAnchor,
) {
  const candidates = files.flatMap((file, index) =>
    file.fileId === anchor.location.fileId ? [{ file, index }] : [],
  );
  if (candidates.length !== 1) return;
  const { file, index } = candidates[0];
  const { side, line } = anchor.location;
  if (!legacyAnchorForLocation(file, side, line)) return;
  const row = file.lines.findIndex(
    (meta) =>
      (side === "old" ? meta.oldLineNumber : meta.newLineNumber) === line &&
      meta.commentable,
  );
  return {
    fileIndex: index,
    rowIndex: row,
    elementId: buildGitReviewLineElementId({
      filePath: file.file.path,
      fileIndex: index,
      lineIndex: row,
    }),
  };
}

export function captureClassicScrollAnchor(
  viewport: HTMLElement,
  scope: string,
  files: LegacyFileLocations[],
): DiffScrollAnchor | undefined {
  const bounds = viewport.getBoundingClientRect();
  for (const section of viewport.querySelectorAll<HTMLElement>(
    "[data-git-diff-section]",
  )) {
    const header = section.querySelector<HTMLElement>("[data-review-file-id]");
    const file = files[Number(header?.dataset.reviewFileId)];
    if (!file) continue;
    const top = Math.max(
      bounds.top,
      header?.getBoundingClientRect().bottom ?? bounds.top,
    );
    for (const row of section.querySelectorAll<HTMLElement>(
      ".cocalc-git-diff-line",
    )) {
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= top || rect.top >= bounds.bottom)
        continue;
      const side = row.dataset.reviewNewLine != null ? "new" : "old";
      const line = Number(
        side === "new" ? row.dataset.reviewNewLine : row.dataset.reviewOldLine,
      );
      if (!Number.isSafeInteger(line) || line < 1) continue;
      return {
        location: { targetId: scope, fileId: file.fileId, side, line },
        offset: rect.top - top,
      };
    }
  }
}
