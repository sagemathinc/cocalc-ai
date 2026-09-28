/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createStorageAdmissionController } from "./storage-admission";

describe("storage admission controller", () => {
  let now = 1_000_000;
  let full = 0;
  let starting = 0;
  let stopping = 0;

  const create = (mode: "disabled" | "observe" | "enforce" = "enforce") =>
    createStorageAdmissionController({
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

  it("keeps recovery blocked while lifecycle work is active", () => {
    const controller = create();
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

  it("allows both maintenance kinds at sustained 2.3% without relaxing recovery or scavengers", () => {
    const controller = create();
    full = 10;
    controller.sample();
    full = 2.3;
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
