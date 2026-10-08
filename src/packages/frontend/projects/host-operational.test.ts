/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  expectsProjectHostConnection,
  getHostRecoveryDisplay,
  getProjectLifecycleView,
  hostUnavailableBannerDelay,
  isHostRecoveryTransient,
  normalizeProjectStateForDisplay,
} from "./host-operational";

describe("projects host operational display state", () => {
  it("only expects a host connection while a runtime is active or preparing", () => {
    expect(
      expectsProjectHostConnection({
        projectState: "opened",
        runtimePreparing: false,
      }),
    ).toBe(false);
    expect(
      expectsProjectHostConnection({
        projectState: "running",
        runtimePreparing: false,
      }),
    ).toBe(true);
    expect(
      expectsProjectHostConnection({
        projectState: "opened",
        runtimePreparing: true,
      }),
    ).toBe(true);
  });

  it("suppresses brief unconfirmed project-host disconnects", () => {
    const now = new Date("2026-08-12T19:00:05.000Z").getTime();
    expect(
      hostUnavailableBannerDelay({
        candidate: true,
        recoveryActive: false,
        unavailableSince: "2026-08-12T19:00:03.000Z",
        now,
      }),
    ).toBe(3_000);
    expect(
      hostUnavailableBannerDelay({
        candidate: true,
        recoveryActive: false,
        unavailableSince: "2026-08-12T19:00:00.000Z",
        now,
      }),
    ).toBe(0);
  });

  it("shows confirmed recovery immediately and hides on reconnection", () => {
    expect(
      hostUnavailableBannerDelay({
        candidate: true,
        recoveryActive: true,
      }),
    ).toBe(0);
    expect(
      hostUnavailableBannerDelay({
        candidate: false,
        recoveryActive: true,
      }),
    ).toBeUndefined();
  });

  it("describes automatic spot recovery with an alternate machine type", () => {
    expect(
      getHostRecoveryDisplay({
        desired_state: "running",
        desired_pricing_model: "spot",
        effective_pricing_model: "spot",
        recovery_phase: "retrying_spot",
        machine: { machine_type: "t2d-standard-16" },
        spot_recovery_state: {
          phase: "retrying_spot",
          active_machine_type: "n2d-standard-16",
        },
      }),
    ).toMatchObject({
      active: true,
      title: "Project host is restarting on alternate Spot capacity",
      etaMinutes: 3,
    });
  });

  it("shows honest elapsed recovery timing using host history", () => {
    expect(
      getHostRecoveryDisplay(
        {
          desired_state: "running",
          desired_pricing_model: "spot",
          effective_pricing_model: "spot",
          recovery_phase: "retrying_spot",
          unavailable_since: "2026-08-12T11:59:00.000Z",
          recovery_duration_estimate_ms: 4 * 60_000,
          spot_recovery_state: { phase: "retrying_spot" },
        },
        new Date("2026-08-12T12:00:00.000Z").getTime(),
      ),
    ).toMatchObject({
      active: true,
      startedAt: "2026-08-12T11:59:00.000Z",
      timingDescription: expect.stringContaining("about 4 minutes"),
    });
  });

  it("keeps the browser-observed disconnect as the stable incident start", () => {
    expect(
      getHostRecoveryDisplay(
        {
          desired_state: "running",
          desired_pricing_model: "spot",
          recovery_phase: "retrying_spot",
          last_seen: "2026-08-12T12:01:00.000Z",
          unavailable_since: "2026-08-12T12:02:00.000Z",
          spot_recovery_state: {
            phase: "retrying_spot",
            outage_started_at: "2026-08-12T12:02:00.000Z",
          },
        },
        new Date("2026-08-12T12:04:00.000Z").getTime(),
        "2026-08-12T12:00:00.000Z",
      ),
    ).toMatchObject({
      active: true,
      startedAt: "2026-08-12T12:00:00.000Z",
      timingDescription: expect.stringContaining("longer than the usual"),
    });
  });

  it("does not replace the current browser incident with stale fallback metadata", () => {
    expect(
      getHostRecoveryDisplay(
        {
          desired_state: "running",
          desired_pricing_model: "spot",
          effective_pricing_model: "on_demand",
          recovery_phase: "running_standard_fallback",
          last_seen: null,
          spot_recovery_state: {
            phase: "running_standard_fallback",
            outage_started_at: "2026-08-12T16:45:30.652Z",
            standard_hold_until: "2026-08-13T16:45:30.652Z",
          },
        },
        new Date("2026-08-12T17:14:45.000Z").getTime(),
        "2026-08-12T17:12:35.000Z",
      ),
    ).toMatchObject({
      active: true,
      startedAt: "2026-08-12T17:12:35.000Z",
    });
  });

  it("keeps the outage start after the replacement VM starts heartbeating", () => {
    // los-angeles-1, 2026-10-08: the Standard VM was already sending
    // heartbeats, so filtering by last_seen left "Recovery is in progress"
    // with no indication of when the 4-minute recovery started.
    expect(
      getHostRecoveryDisplay(
        {
          desired_state: "running",
          desired_pricing_model: "spot",
          effective_pricing_model: "on_demand",
          recovery_phase: "running_standard_fallback",
          last_seen: "2026-10-08T20:13:40.000Z",
          spot_recovery_state: {
            phase: "running_standard_fallback",
            outage_started_at: "2026-10-08T20:11:05.000Z",
            verification_started_at: "2026-10-08T20:12:20.000Z",
          },
        },
        new Date("2026-10-08T20:14:00.000Z").getTime(),
      ),
    ).toMatchObject({
      active: true,
      title: "Project host is restarting on guaranteed capacity",
      startedAt: "2026-10-08T20:11:05.000Z",
    });
  });

  it("uses the current start attempt when the outage start is stale", () => {
    expect(
      getHostRecoveryDisplay(
        {
          desired_state: "running",
          desired_pricing_model: "spot",
          effective_pricing_model: "on_demand",
          recovery_phase: "running_standard_fallback",
          last_seen: "2026-10-08T20:13:40.000Z",
          spot_recovery_state: {
            phase: "running_standard_fallback",
            outage_started_at: "2026-10-08T09:00:00.000Z",
            verification_started_at: "2026-10-08T20:12:20.000Z",
          },
        },
        new Date("2026-10-08T20:14:00.000Z").getTime(),
      ),
    ).toMatchObject({ startedAt: "2026-10-08T20:12:20.000Z" });
  });

  it("does not describe idle spot hosts as recovering", () => {
    expect(
      getHostRecoveryDisplay({
        desired_state: "running",
        desired_pricing_model: "spot",
        recovery_phase: "idle",
      }),
    ).toEqual({ active: false });
  });

  it("distinguishes transient recovery from terminal host states", () => {
    expect(
      isHostRecoveryTransient({
        status: "starting",
        desired_state: "running",
      }),
    ).toBe(true);
    expect(
      isHostRecoveryTransient({
        status: "off",
        desired_state: "running",
        recovery_phase: "running_standard_fallback",
      }),
    ).toBe(true);
    expect(
      isHostRecoveryTransient({
        status: "deprovisioned",
        desired_state: "off",
      }),
    ).toBe(false);
    expect(
      isHostRecoveryTransient({
        status: "error",
        desired_state: "running",
      }),
    ).toBe(false);
  });

  it("keeps running projects running when host heartbeat is stale", () => {
    const hostInfo = {
      status: "running",
      last_seen: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      reason_unavailable: "Host heartbeat is stale; host appears offline.",
    };

    expect(
      normalizeProjectStateForDisplay({
        projectState: "running",
        hostId: "host-1",
        hostInfo,
      }),
    ).toBe("running");
  });

  it("downgrades running projects when the host is explicitly off", () => {
    const hostInfo = {
      status: "off",
      last_seen: new Date().toISOString(),
      reason_unavailable: "Host is off; it must be running.",
    };

    expect(
      normalizeProjectStateForDisplay({
        projectState: "running",
        hostId: "host-1",
        hostInfo,
      }),
    ).toBe("opened");
  });

  it("keeps running projects running when host info is missing", () => {
    expect(
      normalizeProjectStateForDisplay({
        projectState: "running",
        hostId: "host-1",
        hostInfo: undefined,
      }),
    ).toBe("running");
  });

  it("classifies archived projects from indexed backups", () => {
    expect(
      getProjectLifecycleView({
        projectState: "archived",
        lastBackup: new Date().toISOString(),
      }),
    ).toMatchObject({
      kind: "archived",
      isArchived: true,
      isArchivedLike: true,
      canShowFilesystem: false,
    });
  });

  it("classifies new projects from missing indexed backups", () => {
    expect(
      getProjectLifecycleView({
        projectState: "archived",
        lastBackup: null,
      }),
    ).toMatchObject({
      kind: "new",
      isNew: true,
      isArchived: false,
      isArchivedLike: true,
      canShowFilesystem: false,
    });
  });

  it("keeps raw archived state authoritative while backup metadata loads", () => {
    expect(
      getProjectLifecycleView({
        projectState: "archived",
        lastBackup: undefined,
      }),
    ).toMatchObject({
      kind: "unknown",
      displayState: undefined,
      isRawArchived: true,
      isArchived: false,
      isArchivedLike: true,
    });
  });
});
