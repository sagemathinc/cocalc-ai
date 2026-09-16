/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { act, renderHook } from "@testing-library/react";
import { EventEmitter } from "events";
import { Map } from "immutable";
import { getHostRecoveryDisplay } from "@cocalc/frontend/projects/host-operational";
import { useProjectPageHostState } from "./use-project-page-host-state";

const mockClient = Object.assign(new EventEmitter(), {
  isProjectHostConnected: jest.fn(() => false),
});
const mockEnsureHostInfo = jest.fn();
let mockHostInfo = Map<string, Map<string, any>>();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    get conat_client() {
      return mockClient;
    },
  },
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({
      get: (key: string) => (key === "host_info" ? mockHostInfo : Map()),
    }),
    getActions: () => ({ ensure_host_info: mockEnsureHostInfo }),
  },
  useTypedRedux: (_store: string, key: string) =>
    key === "host_info" ? mockHostInfo : Map(),
}));

const STOPPED_AT = "2026-09-16T10:00:00.000Z";
const STARTED_AT = "2026-09-16T10:10:00.000Z";

function setHostStatus(status: string, hostId = "host-1") {
  // Match the immutable resolveHostConnection record consumed by the page.
  const normalizedStatus = status.trim().toLowerCase();
  const running = normalizedStatus === "running";
  mockHostInfo = mockHostInfo.set(
    hostId,
    Map({
      status,
      online: running,
      reason_unavailable: running
        ? undefined
        : `Host is ${normalizedStatus}; it must be running.`,
      unavailable_since: STOPPED_AT,
    }),
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(STOPPED_AT));
  jest.clearAllMocks();
  mockClient.isProjectHostConnected.mockReturnValue(false);
  mockHostInfo = Map();
});

afterEach(() => {
  jest.useRealTimers();
});

it.each(["starting", "restarting", " STARTING "])(
  "resets stopped time on %s through the page's real host hooks",
  (status) => {
    setHostStatus("off");
    const { result, rerender } = renderHook(() =>
      useProjectPageHostState("host-1"),
    );
    expect(mockEnsureHostInfo).toHaveBeenCalledWith("host-1");
    act(() => {
      mockClient.emit("project-host-disconnected", "host-1");
    });
    expect(result.current.projectHostConnection.unavailableSince).toBe(
      STOPPED_AT,
    );

    jest.setSystemTime(new Date(STARTED_AT));
    setHostStatus(status);
    rerender();
    // The availability evaluator intentionally omits status on this path.
    expect(result.current.hostOperational.status).toBeUndefined();
    expect(result.current.hostOperational.state).toBe("unavailable");
    expect(result.current.projectHostConnection).toEqual({
      connected: false,
      observed: true,
      unavailableSince: STARTED_AT,
    });
    const recovery = () =>
      getHostRecoveryDisplay(
        result.current.hostInfo,
        Date.now(),
        result.current.projectHostConnection.unavailableSince,
      );
    expect(recovery().startedAt).toBe(STARTED_AT);
    expect(recovery().timingDescription).not.toContain("taking longer");

    jest.setSystemTime(new Date("2026-09-16T10:11:00.000Z"));
    setHostStatus(status);
    rerender();
    setHostStatus("restarting");
    rerender();
    act(() => {
      mockClient.emit("project-host-disconnected", "host-1");
    });
    expect(recovery().startedAt).toBe(STARTED_AT);

    act(() => {
      mockClient.emit("project-host-connected", "host-1");
    });
    expect(result.current.projectHostConnection).toEqual({
      connected: true,
      observed: true,
    });
    setHostStatus("running");
    rerender();
    act(() => {
      mockClient.emit("project-host-disconnected", "host-1");
    });
    expect(recovery().startedAt).toBe("2026-09-16T10:11:00.000Z");

    setHostStatus("off");
    rerender();
    jest.setSystemTime(new Date("2026-09-16T10:20:00.000Z"));
    setHostStatus("starting");
    rerender();
    expect(recovery().startedAt).toBe("2026-09-16T10:20:00.000Z");
  },
);

it("isolates host changes and cleans up connection listeners", () => {
  setHostStatus("starting");
  setHostStatus("starting", "host-2");
  const { result, rerender, unmount } = renderHook(
    ({ hostId }) => useProjectPageHostState(hostId),
    { initialProps: { hostId: "host-1" } },
  );
  jest.setSystemTime(new Date(STARTED_AT));
  rerender({ hostId: "host-2" });
  expect(result.current.projectHostConnection.unavailableSince).toBe(
    STARTED_AT,
  );
  expect(mockClient.listenerCount("project-host-connected")).toBe(1);
  expect(mockClient.listenerCount("project-host-disconnected")).toBe(1);
  act(() => {
    mockClient.emit("project-host-connected", "host-1");
  });
  expect(result.current.projectHostConnection.connected).toBe(false);
  unmount();
  expect(mockClient.listenerCount("project-host-connected")).toBe(0);
  expect(mockClient.listenerCount("project-host-disconnected")).toBe(0);
});

it("preserves disabled host-info fetching for public directory shares", () => {
  renderHook(() => useProjectPageHostState("host-1", { enabled: false }));
  expect(mockEnsureHostInfo).not.toHaveBeenCalled();
});
