/**
 * Decide whether ipynb watch startup should force an initial full load from disk.
 *
 * Authority rule:
 * - If RTC already has at least one cell, RTC is authoritative. Disk may be stale
 *   (e.g. unsaved collaborative edits), so initial full-load must be skipped.
 * - If RTC has no cells, bootstrap from disk.
 */
export function shouldInitialWatchLoadFromDisk({
  hasRtcCells,
}: {
  hasRtcCells: boolean;
}): boolean {
  return !hasRtcCells;
}

