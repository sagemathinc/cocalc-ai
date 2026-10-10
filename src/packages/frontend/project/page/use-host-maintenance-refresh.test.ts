/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, renderHook } from "@testing-library/react";

import {
  MAINTENANCE_DISCOVERY_MS,
  MAINTENANCE_IN_PROGRESS_REFRESH_MS,
  MAINTENANCE_SCHEDULED_REFRESH_MS,
  useHostMaintenanceRefresh,
} from "./use-host-maintenance-refresh";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useHostMaintenanceRefresh", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("finds a window announced after the page opened, and follows it", () => {
    const refresh = jest.fn();
    const { rerender } = renderHook(
      ({ state }: { state?: string }) =>
        useHostMaintenanceRefresh({
          host_id: "host-1",
          maintenanceState: state,
          active: true,
          hostUnavailable: false,
          refresh,
        }),
      { initialProps: { state: undefined as string | undefined } },
    );
    // No notice yet: an open page still looks, within a bounded time.
    act(() => jest.advanceTimersByTime(MAINTENANCE_DISCOVERY_MS));
    expect(refresh).toHaveBeenCalledWith("host-1");

    // An operator announced a window: it is now followed more closely.
    refresh.mockClear();
    rerender({ state: "scheduled" });
    act(() => jest.advanceTimersByTime(MAINTENANCE_SCHEDULED_REFRESH_MS));
    expect(refresh).toHaveBeenCalledTimes(1);

    refresh.mockClear();
    rerender({ state: "in_progress" });
    act(() => jest.advanceTimersByTime(MAINTENANCE_IN_PROGRESS_REFRESH_MS));
    expect(refresh).toHaveBeenCalledTimes(1);

    // Cleared: back to discovery, so the banner goes away and a later window
    // is still found.
    refresh.mockClear();
    rerender({ state: undefined });
    act(() => jest.advanceTimersByTime(MAINTENANCE_DISCOVERY_MS));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not poll a hidden tab, and refreshes when it becomes visible", () => {
    const refresh = jest.fn();
    renderHook(() =>
      useHostMaintenanceRefresh({
        host_id: "host-1",
        active: true,
        hostUnavailable: false,
        refresh,
      }),
    );
    act(() => setVisibility("hidden"));
    act(() => jest.advanceTimersByTime(3 * MAINTENANCE_DISCOVERY_MS));
    expect(refresh).not.toHaveBeenCalled();
    act(() => setVisibility("visible"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for inactive pages and while the host is down", () => {
    const refresh = jest.fn();
    renderHook(() =>
      useHostMaintenanceRefresh({
        host_id: "host-1",
        active: false,
        hostUnavailable: false,
        refresh,
      }),
    );
    renderHook(() =>
      useHostMaintenanceRefresh({
        host_id: "host-1",
        active: true,
        hostUnavailable: true,
        refresh,
      }),
    );
    act(() => jest.advanceTimersByTime(2 * MAINTENANCE_DISCOVERY_MS));
    expect(refresh).not.toHaveBeenCalled();
  });
});
