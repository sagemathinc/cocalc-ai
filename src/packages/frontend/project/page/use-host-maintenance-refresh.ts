/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useRef } from "react";

// How often an open, visible project page looks for a newly announced
// maintenance window (or one that was cleared) on its host. Host info is
// otherwise fetched once, when the page opens.
export const MAINTENANCE_DISCOVERY_MS = 10 * 60_000;
// While a window is announced or running, its start, end and removal are
// followed more closely.
export const MAINTENANCE_SCHEDULED_REFRESH_MS = 5 * 60_000;
export const MAINTENANCE_IN_PROGRESS_REFRESH_MS = 30_000;

export function maintenanceRefreshIntervalMs(state?: string): number {
  if (state === "scheduled") return MAINTENANCE_SCHEDULED_REFRESH_MS;
  if (state) return MAINTENANCE_IN_PROGRESS_REFRESH_MS;
  return MAINTENANCE_DISCOVERY_MS;
}

// Keep the host's maintenance notice current on an open project page. Polls
// only while the page is active and the browser tab is visible. Since nothing
// polls otherwise, it refreshes as soon as the page becomes active or the tab
// visible again. (Outages refresh separately.)
export function useHostMaintenanceRefresh({
  host_id,
  maintenanceState,
  active,
  hostUnavailable,
  refresh,
  tick,
}: {
  host_id?: string;
  maintenanceState?: string;
  active: boolean;
  hostUnavailable: boolean;
  refresh: (host_id: string) => void;
  // Re-evaluates time-dependent display (e.g. "starts in 5 minutes").
  tick?: () => void;
}): void {
  const wasActive = useRef(active);
  useEffect(() => {
    const becameActive = active && !wasActive.current;
    wasActive.current = active;
    if (!host_id || !active || hostUnavailable) return;
    const visible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";
    const update = () => {
      if (!visible()) return;
      tick?.();
      refresh(host_id);
    };
    // Switching back to a page that sat inactive: its notice may be stale.
    if (becameActive) update();
    const timer = window.setInterval(
      update,
      maintenanceRefreshIntervalMs(maintenanceState),
    );
    const onVisibility = () => {
      if (visible()) update();
    };
    document.addEventListener?.("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener?.("visibilitychange", onVisibility);
    };
  }, [host_id, maintenanceState, active, hostUnavailable]);
}
