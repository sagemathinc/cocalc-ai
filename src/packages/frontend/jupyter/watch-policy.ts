export type InitialWatchSourceReason =
  | "rtc_empty"
  | "rtc_timestamp_missing"
  | "disk_newer_than_rtc"
  | "rtc_newer_or_equal"
  | "disk_mtime_unavailable";

export interface InitialWatchSourceDecision {
  loadFromDisk: boolean;
  reason: InitialWatchSourceReason;
}

/**
 * Decide whether ipynb watch startup should force an initial full load from disk.
 *
 * Authority rule:
 * - If RTC has no cells yet, bootstrap from disk.
 * - If RTC has cells and a newer-or-equal change timestamp, keep RTC state.
 * - If disk mtime is newer than RTC state, reload from disk (external editor/git).
 *
 * This prevents both classes of bugs:
 * - clobbering unsaved RTC edits with stale disk content
 * - showing stale RTC state when disk changed later outside CoCalc.
 */
export function decideInitialWatchSource({
  hasRtcCells,
  rtcLastChangedMs,
  diskMtimeMs,
}: {
  hasRtcCells: boolean;
  rtcLastChangedMs?: number;
  diskMtimeMs?: number;
}): InitialWatchSourceDecision {
  if (!hasRtcCells) {
    return { loadFromDisk: true, reason: "rtc_empty" };
  }

  const hasRtcTimestamp =
    typeof rtcLastChangedMs === "number" &&
    Number.isFinite(rtcLastChangedMs) &&
    rtcLastChangedMs > 0;
  if (!hasRtcTimestamp) {
    return { loadFromDisk: true, reason: "rtc_timestamp_missing" };
  }

  const hasDiskTimestamp =
    typeof diskMtimeMs === "number" && Number.isFinite(diskMtimeMs) && diskMtimeMs > 0;
  if (!hasDiskTimestamp) {
    return { loadFromDisk: false, reason: "disk_mtime_unavailable" };
  }

  if ((diskMtimeMs as number) > (rtcLastChangedMs as number)) {
    return { loadFromDisk: true, reason: "disk_newer_than_rtc" };
  }

  return { loadFromDisk: false, reason: "rtc_newer_or_equal" };
}

export function shouldInitialWatchLoadFromDisk(params: {
  hasRtcCells: boolean;
  rtcLastChangedMs?: number;
  diskMtimeMs?: number;
}): boolean {
  return decideInitialWatchSource(params).loadFromDisk;
}
