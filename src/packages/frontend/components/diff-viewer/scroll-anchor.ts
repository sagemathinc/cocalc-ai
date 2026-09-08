import type { DiffScrollAnchor } from "./review-model";

const PREFIX = "cocalc:review-scroll:v1:";

export function readScrollAnchor(scope: string): DiffScrollAnchor | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (!raw || raw.length > 32_000) return;
    const anchor = JSON.parse(raw);
    const location = anchor?.location;
    if (
      location?.targetId !== scope ||
      typeof location.fileId !== "string" ||
      !["old", "new"].includes(location.side) ||
      !Number.isSafeInteger(location.line) ||
      location.line < 1 ||
      !Number.isFinite(anchor.offset) ||
      Math.abs(anchor.offset) > 10_000
    )
      return;
    return anchor;
  } catch {
    return;
  }
}

export function writeScrollAnchor(anchor: DiffScrollAnchor): void {
  try {
    localStorage.setItem(
      PREFIX + anchor.location.targetId,
      JSON.stringify(anchor),
    );
  } catch {
    /* Optional view state. */
  }
}

// Inspect only mounted code rows, never annotations or virtualized placeholders.
export function capturePierreScrollAnchor(
  viewport: HTMLElement,
  scope: string,
  headerHeight: number,
): DiffScrollAnchor | undefined {
  const bounds = viewport.getBoundingClientRect();
  const top = bounds.top + headerHeight;
  let first: { anchor: DiffScrollAnchor; top: number } | undefined;
  for (const host of viewport.querySelectorAll("diffs-container")) {
    const fileId = host.querySelector<HTMLElement>("[data-review-file-id]")
      ?.dataset.reviewFileId;
    if (!fileId || !host.shadowRoot) continue;
    for (const row of host.shadowRoot.querySelectorAll<HTMLElement>(
      "[data-line]",
    )) {
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= top || rect.top >= bounds.bottom)
        continue;
      const line = Number(row.dataset.line);
      if (!Number.isSafeInteger(line) || line < 1) continue;
      const side =
        row.dataset.lineType === "change-deletion" ||
        row.closest("[data-deletions]")
          ? "old"
          : "new";
      if (!first || rect.top < first.top)
        first = {
          top: rect.top,
          anchor: {
            location: { targetId: scope, fileId, side, line },
            offset: rect.top - top,
          },
        };
    }
  }
  return first?.anchor;
}
