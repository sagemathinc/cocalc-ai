/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { _test, createStorageAdmissionController } from "./storage-admission";

describe("storage admission controller", () => {
  let now = 1_000_000;
  let full = 0;
  let starting = 0;
  let stopping = 0;

  const create = (
    mode: "disabled" | "observe" | "enforce" = "enforce",
    extra: Parameters<typeof createStorageAdmissionController>[0] = {},
  ) =>
    createStorageAdmissionController({
      ...extra,
      mode,
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        host_io_full_avg10: full,
        project_pool_io_full_avg10: full / 2,
        starting_projects: starting,
        stopping_projects: stopping,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
      }),
      recoveryMs: 60_000,
    });

  beforeEach(() => {
    now = 1_000_000;
    full = 0;
    starting = 0;
    stopping = 0;
  });

  it("enters contention after two samples and emergency immediately", () => {
    const controller = create();
    full = 5;
    expect(controller.sample().pressure_state).toBe("normal");
    now += 5_000;
    expect(controller.sample().pressure_state).toBe("contended");
    full = 10;
    now += 5_000;
    expect(controller.sample()).toMatchObject({
      pressure_state: "emergency",
      transition_count: 2,
      host_io_full_avg10: 10,
      project_pool_io_full_avg10: 5,
      uncontained_io_full_avg10: 5,
    });
  });

  it("separates intentional project-pool throttling from uncontained pressure", () => {
    const controller = create();
    full = 10;
    const status = controller.sample();
    expect(status).toMatchObject({
      pressure_state: "emergency",
      effective_io_full_avg10: 10,
      uncontained_io_full_avg10: 5,
    });
  });

  it("does not classify BEES-only waits as actionable host pressure", () => {
    const controller = createStorageAdmissionController({
      mode: "enforce",
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        host_io_full_avg10: 22,
        project_pool_io_full_avg10: 0,
        bees_io_full_avg10: 22,
        starting_projects: 0,
        stopping_projects: 0,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
      }),
    });

    expect(controller.sample()).toMatchObject({
      pressure_state: "normal",
      host_io_full_avg10: 22,
      project_pool_io_full_avg10: 0,
      bees_io_full_avg10: 22,
      uncontained_io_full_avg10: 0,
      effective_io_full_avg10: 0,
    });
  });

  it("does not classify throttled maintenance waits as host pressure", () => {
    // A rustic backup in cocalc-maintenance stalls on that cgroup's io.max
    // even on an idle disk, so root PSI tracks the backup's own stall.
    const controller = createStorageAdmissionController({
      mode: "enforce",
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        host_io_full_avg10: 46.5,
        project_pool_io_full_avg10: 0,
        bees_io_full_avg10: 0,
        maintenance_io_full_avg10: 69,
        maintenance_io_capped: true,
        maintenance_disks_idle: true,
        starting_projects: 0,
        stopping_projects: 0,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
      }),
      contendedSamples: 1,
    });

    expect(controller.sample()).toMatchObject({
      pressure_state: "normal",
      host_io_full_avg10: 46.5,
      maintenance_io_full_avg10: 69,
      uncontained_io_full_avg10: 0,
      effective_io_full_avg10: 0,
    });
    expect(controller.backgroundDeferralReason()).toBeUndefined();
  });

  it("preserves host pressure above maintenance waits", () => {
    const controller = createStorageAdmissionController({
      mode: "enforce",
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        host_io_full_avg10: 30,
        project_pool_io_full_avg10: 3,
        maintenance_io_full_avg10: 12,
        maintenance_io_capped: true,
        maintenance_disks_idle: true,
        starting_projects: 0,
        stopping_projects: 0,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
      }),
    });

    expect(controller.sample()).toMatchObject({
      pressure_state: "emergency",
      uncontained_io_full_avg10: 18,
      effective_io_full_avg10: 18,
    });
  });

  it("still counts project-pool pressure while maintenance is throttled", () => {
    const controller = createStorageAdmissionController({
      mode: "enforce",
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        host_io_full_avg10: 25,
        project_pool_io_full_avg10: 15,
        maintenance_io_full_avg10: 25,
        maintenance_io_capped: true,
        maintenance_disks_idle: true,
        starting_projects: 0,
        stopping_projects: 0,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
      }),
    });

    expect(controller.sample()).toMatchObject({
      pressure_state: "emergency",
      uncontained_io_full_avg10: 0,
      effective_io_full_avg10: 15,
    });
  });

  it("counts maintenance stalls as pressure when no io.max cap is set", () => {
    // I/O policy disabled or observe: bootstrap clears cocalc-maintenance's
    // io.max, so a backup stalling there is waiting on a saturated disk.
    const controller = createStorageAdmissionController({
      mode: "enforce",
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        host_io_full_avg10: 46.5,
        project_pool_io_full_avg10: 0,
        bees_io_full_avg10: 0,
        maintenance_io_full_avg10: 69,
        maintenance_io_capped: false,
        starting_projects: 0,
        stopping_projects: 0,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
      }),
    });

    expect(controller.sample()).toMatchObject({
      pressure_state: "emergency",
      maintenance_io_full_avg10: 69,
      maintenance_io_capped: false,
      uncontained_io_full_avg10: 46.5,
      effective_io_full_avg10: 46.5,
    });
  });

  it("counts a capped maintenance stall while a disk it uses is busy", () => {
    // Review on #1100: the cap covers only the project disks, while rustic
    // also writes its cache on the uncapped root disk, and cgroup PSI covers
    // every device. A cap alone does not prove the stall is the throttle.
    const controller = createStorageAdmissionController({
      mode: "enforce",
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        host_io_full_avg10: 46.5,
        project_pool_io_full_avg10: 0,
        bees_io_full_avg10: 0,
        maintenance_io_full_avg10: 69,
        maintenance_io_capped: true,
        maintenance_disks_idle: false,
        starting_projects: 0,
        stopping_projects: 0,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
      }),
    });

    expect(controller.sample()).toMatchObject({
      pressure_state: "emergency",
      maintenance_disks_idle: false,
      uncontained_io_full_avg10: 46.5,
      effective_io_full_avg10: 46.5,
    });
  });

  it("attributes a maintenance stall to its throttle only when every disk it used was idle", () => {
    const {
      parseDiskstatsBusyMs,
      parseIoStatIos,
      maintenanceStallOnIdleDisks,
    } = _test;
    const activity = (at_ms: number, diskstats: string, iostat: string) => ({
      at_ms,
      busy_ms: parseDiskstatsBusyMs(diskstats),
      maintenance_ios: parseIoStatIos(iostat),
    });
    const disk = (sda: number, sdb: number) =>
      `   8       0 sda 1 0 0 0 1 0 0 0 0 ${sda} ${sda} 0 0 0 0 0 0\n` +
      `   8      16 sdb 1 0 0 0 1 0 0 0 0 ${sdb} ${sdb} 0 0 0 0 0 0\n`;
    const stat = (sda: number, sdb: number) =>
      `8:0 rbytes=1 wbytes=1 rios=${sda} wios=0 dbytes=0 dios=0\n` +
      `8:16 rbytes=1 wbytes=1 rios=${sdb} wios=0 dbytes=0 dios=0\n`;
    expect(parseDiskstatsBusyMs(disk(5, 7)).get("8:16")).toBe(7);
    expect(parseIoStatIos(stat(2, 9)).get("8:16")).toBe(9);
    const start = activity(0, disk(0, 0), stat(0, 0));
    // Alpha host1: the backup reads the capped project disk at 8% busy.
    expect(
      maintenanceStallOnIdleDisks(
        start,
        activity(5_000, disk(0, 400), stat(0, 1200)),
        0.5,
      ),
    ).toBe(true);
    // Also writing its cache on a saturated root disk: real contention.
    expect(
      maintenanceStallOnIdleDisks(
        start,
        activity(5_000, disk(4_900, 400), stat(300, 1200)),
        0.5,
      ),
    ).toBe(false);
    // A busy disk maintenance did not use does not matter.
    expect(
      maintenanceStallOnIdleDisks(
        start,
        activity(5_000, disk(4_900, 400), stat(0, 1200)),
        0.5,
      ),
    ).toBe(true);
    // No I/O completed, no previous sample, or an unknown device: not proven.
    expect(
      maintenanceStallOnIdleDisks(
        start,
        activity(5_000, disk(0, 0), stat(0, 0)),
        0.5,
      ),
    ).toBe(false);
    expect(
      maintenanceStallOnIdleDisks(
        undefined,
        activity(5_000, disk(0, 0), stat(0, 1)),
        0.5,
      ),
    ).toBe(false);
    expect(
      maintenanceStallOnIdleDisks(
        start,
        activity(5_000, disk(0, 0), stat(0, 0) + "8:32 rios=5 wios=0\n"),
        0.5,
      ),
    ).toBe(false);
  });

  it("recognizes a finite io.max cap", () => {
    const capped = _test.ioMaxCapped;
    expect(
      capped("8:16 rbps=11744051 wbps=5242880 riops=240 wiops=120\n"),
    ).toBe(true);
    expect(capped("8:16 rbps=max wbps=max riops=240 wiops=max\n")).toBe(true);
    expect(capped("8:16 rbps=max wbps=max riops=max wiops=max\n")).toBe(false);
    expect(capped("")).toBe(false);
  });

  it("preserves host pressure above BEES and project-pool waits", () => {
    const controller = createStorageAdmissionController({
      mode: "enforce",
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        host_io_full_avg10: 18,
        project_pool_io_full_avg10: 4,
        bees_io_full_avg10: 11,
        starting_projects: 0,
        stopping_projects: 0,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
      }),
      contendedSamples: 1,
    });

    expect(controller.sample()).toMatchObject({
      pressure_state: "contended",
      uncontained_io_full_avg10: 7,
      effective_io_full_avg10: 7,
    });
  });

  it("requires a healthy recovery interval before returning to normal", () => {
    const controller = create();
    full = 10;
    controller.sample();
    full = 0.5;
    now += 5_000;
    expect(controller.sample().pressure_state).toBe("recovery");
    now += 59_999;
    expect(controller.sample().pressure_state).toBe("recovery");
    now += 1;
    expect(controller.sample().pressure_state).toBe("normal");
  });

  it("keeps protective I/O policy through recovery hysteresis", () => {
    const transitions: string[] = [];
    const controller = createStorageAdmissionController({
      mode: "enforce",
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        host_io_full_avg10: full,
        project_pool_io_full_avg10: full / 2,
        starting_projects: 0,
        stopping_projects: 0,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
      }),
      recoveryMs: 60_000,
      onPressureStateChange: (state) => transitions.push(state),
    });
    full = 10;
    controller.sample();
    full = 0;
    now += 5_000;
    controller.sample();
    now += 60_000;
    controller.sample();
    expect(transitions).toEqual(["emergency", "recovery", "normal"]);
  });

  it("leaves recovery at low stall even while projects keep starting and stopping", () => {
    // 2026-10-16: busy prod hosts at 1-2% stall with constant lifecycle work
    // sat in recovery for hours, deferring scheduled snapshots.
    const controller = create();
    full = 10;
    controller.sample();
    full = 2;
    starting = 1;
    now += 5_000;
    expect(controller.sample().pressure_state).toBe("recovery");
    now += 60_000;
    expect(controller.sample().pressure_state).toBe("normal");
    // Background work still waits for the lifecycle work itself.
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }),
    ).toMatchObject({ admitted: false, reason: "lifecycle_active" });
  });

  it("stays in recovery between the exit and contended thresholds", () => {
    const controller = create();
    full = 10;
    controller.sample();
    full = 3;
    for (let i = 0; i < 10; i++) {
      now += 60_000;
      expect(controller.sample().pressure_state).toBe("recovery");
    }
  });

  it("can still require quiet lifecycle to leave recovery", () => {
    const controller = create("enforce", {
      recoveryRequiresQuietLifecycle: true,
      recoveryFullAvg10: 1,
    });
    full = 10;
    controller.sample();
    full = 0;
    starting = 1;
    now += 5_000;
    expect(controller.sample().pressure_state).toBe("recovery");
    now += 120_000;
    expect(controller.sample().pressure_state).toBe("recovery");
    starting = 0;
    controller.sample();
    now += 60_000;
    expect(controller.sample().pressure_state).toBe("normal");
  });

  it("paces scheduled snapshots through recovery, one at a time", () => {
    const controller = create();
    full = 10;
    controller.sample();
    full = 3;
    now += 5_000;
    expect(controller.sample().pressure_state).toBe("recovery");
    const first = controller.admit({
      operation_kind: "scheduled_snapshot",
      project_id: "p1",
    });
    expect(first).toMatchObject({
      admitted: true,
      would_defer: true,
      reason: "io_pressure_recovery",
      recovery_paced: true,
      starvation_override: false,
    });
    // One at a time, and backups are not paced.
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }).admitted,
    ).toBe(false);
    expect(
      controller.admit({ operation_kind: "scheduled_backup" }).admitted,
    ).toBe(false);
    first.release();
    // Then at the pace.
    now += 19_999;
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }).admitted,
    ).toBe(false);
    now += 1;
    const second = controller.admit({ operation_kind: "scheduled_snapshot" });
    expect(second.recovery_paced).toBe(true);
    second.release();
    expect(controller.getStatus()).toMatchObject({
      recovery_paced_total: 2,
      // The snapshot while one ran, the backup, and the one before the pace.
      deferred_by_reason: { io_pressure_recovery: 3 },
    });
  });

  it("keeps overdue snapshot overrides on the same recovery pace", () => {
    const controller = create();
    full = 10;
    controller.sample();
    full = 3;
    now += 5_000;
    controller.sample();
    expect(controller.getStatus().recovery_snapshot_next_at).toBe(
      new Date(now).toISOString(),
    );
    const paced = controller.admit({ operation_kind: "scheduled_snapshot" });
    expect(paced.recovery_paced).toBe(true);
    paced.release();
    const pacedAt = now;
    expect(controller.getStatus().recovery_snapshot_next_at).toBe(
      new Date(pacedAt + 20_000).toISOString(),
    );
    // An overdue snapshot cannot start between paced ones...
    now += 5_000;
    expect(
      controller.admit({
        operation_kind: "scheduled_snapshot",
        allow_starvation_override: true,
      }),
    ).toMatchObject({ admitted: false, starvation_override: false });
    // ...nor a backup override (still allowed) restart the snapshot clock.
    const backup = controller.admit({
      operation_kind: "scheduled_backup",
      allow_starvation_override: true,
    });
    expect(backup.starvation_override).toBe(true);
    backup.release();
    now = pacedAt + 20_000;
    const override = controller.admit({
      operation_kind: "scheduled_snapshot",
      allow_starvation_override: true,
    });
    expect(override.starvation_override).toBe(true);
    override.release();
    // The override restarted the shared clock.
    now += 10_000;
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }).admitted,
    ).toBe(false);
    now += 10_000;
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }).recovery_paced,
    ).toBe(true);
  });

  it("gives the recovery slot only to the snapshot the caller allows", () => {
    const controller = create();
    full = 10;
    controller.sample();
    full = 3;
    now += 5_000;
    controller.sample();
    for (const allow_starvation_override of [false, true]) {
      expect(
        controller.admit({
          operation_kind: "scheduled_snapshot",
          allow_starvation_override,
          allow_recovery_pace: false,
        }),
      ).toMatchObject({
        admitted: false,
        recovery_paced: false,
        starvation_override: false,
      });
    }
    // Withheld attempts leave the slot open for the head.
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }).recovery_paced,
    ).toBe(true);
  });

  it("does not pace a snapshot alongside scheduled work that is still running", () => {
    const controller = create();
    // A backup admitted while normal keeps running into recovery.
    const backup = controller.admit({ operation_kind: "scheduled_backup" });
    expect(backup.admitted).toBe(true);
    full = 10;
    controller.sample();
    full = 3;
    now += 5_000;
    expect(controller.sample().pressure_state).toBe("recovery");
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }),
    ).toMatchObject({ admitted: false, recovery_paced: false });
    backup.release();
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }).recovery_paced,
    ).toBe(true);
  });

  it.each([
    ["contended", 6, 0],
    ["emergency", 12, 0],
    ["lifecycle", 3, 1],
  ] as const)(
    "never paces snapshots past a %s gate",
    (_name, level, lifecycle) => {
      const controller = create();
      full = 10;
      controller.sample();
      full = 3;
      now += 5_000;
      controller.sample();
      full = level;
      starting = lifecycle;
      now += 5_000;
      controller.sample();
      controller.sample();
      expect(
        controller.admit({ operation_kind: "scheduled_snapshot" }),
      ).toMatchObject({ admitted: false, recovery_paced: false });
    },
  );

  it("reports time spent in each pressure state", () => {
    const controller = create();
    now += 10_000;
    full = 10;
    controller.sample();
    now += 30_000;
    full = 0;
    controller.sample();
    now += 5_000;
    controller.sample();
    expect(controller.getStatus().state_ms_total).toEqual({
      normal: 10_000,
      emergency: 30_000,
      recovery: 5_000,
      contended: 0,
    });
  });

  it("enforces background deferral but preserves interactive work", () => {
    const controller = create("enforce");
    starting = 1;
    const scheduled = controller.admit({
      operation_kind: "scheduled_snapshot",
      project_id: "project-1",
    });
    expect(scheduled).toMatchObject({
      admitted: false,
      would_defer: true,
      reason: "lifecycle_active",
    });
    const interactive = controller.admit({
      operation_kind: "interactive_snapshot",
      project_id: "project-1",
    });
    expect(interactive).toMatchObject({
      admitted: true,
      would_defer: false,
    });
    expect(controller.getStatus()).toMatchObject({
      deferred_total: 1,
      admitted_total: 1,
      active_by_priority: { interactive: 1 },
    });
    interactive.release();
    expect(controller.getStatus().active_by_priority.interactive).toBe(0);
  });

  it("keeps a short quiet window after lifecycle work finishes", () => {
    const controller = create("enforce");
    starting = 1;
    controller.sample();
    starting = 0;
    now += 1_000;
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }),
    ).toMatchObject({ admitted: false, reason: "lifecycle_settle" });
    now += 1_000;
    expect(
      controller.admit({ operation_kind: "scheduled_snapshot" }),
    ).toMatchObject({ admitted: true });
  });

  it("reports would-defer decisions without blocking in observe mode", () => {
    const controller = create("observe");
    stopping = 1;
    const ticket = controller.admit({
      operation_kind: "scheduled_backup",
      project_id: "project-1",
    });
    expect(ticket).toMatchObject({
      admitted: true,
      would_defer: true,
      reason: "lifecycle_active",
    });
    expect(controller.getStatus()).toMatchObject({
      admitted_total: 1,
      deferred_total: 0,
      observed_deferral_total: 1,
    });
    ticket.release();
  });

  it("reevaluates pressure for every operation", () => {
    const controller = create("enforce");
    const first = controller.admit({
      operation_kind: "scheduled_backup",
      project_id: "project-1",
    });
    expect(first.admitted).toBe(true);
    first.release();
    full = 10;
    now += 5_000;
    const second = controller.admit({
      operation_kind: "scheduled_backup",
      project_id: "project-2",
    });
    expect(second).toMatchObject({
      admitted: false,
      reason: "io_pressure_emergency",
    });
  });

  it.each(["scheduled_snapshot", "scheduled_backup"] as const)(
    "preserves lifecycle, settle and emergency gates for overdue %s",
    (operation_kind) => {
      const controller = create("enforce");
      starting = 1;
      expect(
        controller.admit({
          operation_kind,
          project_id: "project-0",
          allow_starvation_override: true,
        }),
      ).toMatchObject({
        admitted: false,
        starvation_override: false,
        reason: "lifecycle_active",
      });
      expect(
        controller.backgroundDeferralReason({
          allow_starvation_override: true,
        }),
      ).toBe("lifecycle_active");
      starting = 0;
      now += 1_000;
      expect(
        controller.admit({
          operation_kind,
          project_id: "project-1",
          allow_starvation_override: true,
        }),
      ).toMatchObject({
        admitted: false,
        would_defer: true,
        reason: "lifecycle_settle",
        starvation_override: false,
      });
      expect(
        controller.backgroundDeferralReason({
          allow_starvation_override: true,
        }),
      ).toBe("lifecycle_settle");

      starting = 0;
      full = 10;
      now += 5_000;
      expect(
        controller.admit({
          operation_kind,
          project_id: "project-2",
          allow_starvation_override: true,
        }),
      ).toMatchObject({
        admitted: false,
        would_defer: true,
        reason: "io_pressure_emergency",
        starvation_override: false,
      });
      expect(
        controller.backgroundDeferralReason({
          allow_starvation_override: true,
        }),
      ).toBe("io_pressure_emergency");
    },
  );

  it("allows both maintenance kinds at sustained 3.5% without relaxing recovery or scavengers", () => {
    const controller = create("enforce", { recoverySnapshotIntervalMs: 0 });
    full = 10;
    controller.sample();
    full = 3.5;
    for (let i = 0; i < 12; i++) {
      now += 5 * 60_000;
      expect(controller.sample().pressure_state).toBe("recovery");
      for (const operation_kind of [
        "scheduled_snapshot",
        "scheduled_backup",
      ] as const) {
        expect(controller.admit({ operation_kind }).admitted).toBe(false);
        const ticket = controller.admit({
          operation_kind,
          allow_starvation_override: true,
        });
        expect(ticket).toMatchObject({
          admitted: true,
          starvation_override: true,
        });
        expect(
          controller.backgroundDeferralReason({
            allow_starvation_override: true,
          }),
        ).toBeUndefined();
        expect(
          controller.admit({ operation_kind, allow_starvation_override: true })
            .admitted,
        ).toBe(false);
        ticket.release();
        ticket.release();
      }
      expect(
        controller.admit({
          operation_kind: "orphan_cleanup",
          allow_starvation_override: true,
        }).admitted,
      ).toBe(false);
    }
  });

  it("rechecks emergency and lifecycle safety at mutation boundaries", () => {
    const controller = create();
    full = 6;
    controller.sample();
    controller.sample();
    const ticket = controller.admit({
      operation_kind: "scheduled_snapshot",
      allow_starvation_override: true,
    });
    expect(ticket.starvation_override).toBe(true);
    full = 10;
    expect(
      controller.backgroundDeferralReason({ allow_starvation_override: true }),
    ).toBe("io_pressure_emergency");
    full = 2.3;
    starting = 1;
    expect(
      controller.backgroundDeferralReason({ allow_starvation_override: true }),
    ).toBe("lifecycle_active");
    ticket.release();
  });

  it("does not overlap an existing scheduled operation or block interactive work", () => {
    const controller = create();
    const normal = controller.admit({ operation_kind: "scheduled_backup" });
    full = 6;
    controller.sample();
    controller.sample();
    expect(
      controller.admit({
        operation_kind: "scheduled_snapshot",
        allow_starvation_override: true,
      }).admitted,
    ).toBe(false);
    normal.release();
    const escape = controller.admit({
      operation_kind: "scheduled_snapshot",
      allow_starvation_override: true,
    });
    expect(escape.starvation_override).toBe(true);
    const interactive = controller.admit({
      operation_kind: "interactive_backup",
    });
    expect(interactive.admitted).toBe(true);
    interactive.release();
    escape.release();
  });

  it("fails background admission closed when pressure cannot be sampled", () => {
    const controller = createStorageAdmissionController({
      mode: "enforce",
      now: () => now,
      readInputs: () => ({
        sampled_at_ms: now,
        starting_projects: 0,
        stopping_projects: 0,
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
        error: "host I/O pressure is unavailable",
      }),
    });
    expect(
      controller.admit({
        operation_kind: "scheduled_snapshot",
        project_id: "project-1",
        allow_starvation_override: true,
      }),
    ).toMatchObject({
      admitted: false,
      would_defer: true,
      reason: "io_pressure_unavailable",
    });
  });
});
