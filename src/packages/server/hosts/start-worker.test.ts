/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { __test__ } from "./start-worker";

describe("hosts start-worker bootstrap wait failure detection", () => {
  const since = new Date("2026-05-05T00:10:00.000Z").getTime();

  test("fails when current bootstrap status reports error", () => {
    expect(
      __test__.currentBootstrapFailure({
        since,
        row: {
          metadata: {
            bootstrap: {
              status: "error",
              updated_at: "2026-05-05T00:10:46.000Z",
              message: "bootstrap download failed",
            },
          },
        },
      }),
    ).toBe("bootstrap download failed");
  });

  test("ignores stale bootstrap errors from before the current start", () => {
    expect(
      __test__.currentBootstrapFailure({
        since,
        row: {
          metadata: {
            bootstrap: {
              status: "error",
              updated_at: "2026-05-04T23:59:59.000Z",
              message: "old bootstrap error",
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  test("fails on lifecycle error recorded during the current start", () => {
    expect(
      __test__.currentBootstrapFailure({
        since,
        row: {
          metadata: {
            bootstrap_lifecycle: {
              summary_status: "error",
              last_reconcile_started_at: "2026-05-05T00:10:20.000Z",
              last_error: "bootstrap reconcile failed",
            },
          },
        },
      }),
    ).toBe("bootstrap reconcile failed");
  });
});

describe("hosts start-worker project-host upgrade convergence detection", () => {
  test("keeps a planned transition until a scheduled restart reports ready", () => {
    expect(
      __test__.projectHostRestartWasScheduled({
        results: [
          { component: "conat-router", action: "restarted" },
          { component: "project-host", action: "restart_scheduled" },
        ],
      }),
    ).toBe(true);
    expect(
      __test__.projectHostRestartWasScheduled({
        results: [{ component: "project-host", action: "noop" }],
      }),
    ).toBe(false);
  });

  test("recovers an explicit project-host target from the upgrade request", () => {
    expect(
      __test__.requestedProjectHostUpgradeVersion([
        { artifact: "project", version: "project-v2" },
        { artifact: "project-host", version: " ph-v2 " },
      ]),
    ).toBe("ph-v2");
  });

  test("does not invent a target version for a channel upgrade", () => {
    expect(
      __test__.requestedProjectHostUpgradeVersion([
        { artifact: "project-host", channel: "latest" },
      ]),
    ).toBeUndefined();
  });

  test("detects a completed project-host upgrade once installed and last-known-good match the target", () => {
    expect(
      __test__.completedProjectHostUpgradeVersion({
        targetVersion: "ph-v2",
        row: {
          version: "ph-v2",
          metadata: {
            software: {
              project_host: "ph-v2",
            },
            host_agent: {
              project_host: {
                last_known_good_version: "ph-v2",
              },
            },
          },
        },
      }),
    ).toBe("ph-v2");
  });

  test("does not suppress rollback when the host is still on the previous last-known-good version", () => {
    expect(
      __test__.completedProjectHostUpgradeVersion({
        targetVersion: "ph-v2",
        row: {
          version: "ph-v2",
          metadata: {
            software: {
              project_host: "ph-v2",
            },
            host_agent: {
              project_host: {
                last_known_good_version: "ph-v1",
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  test("detects a completed latest-channel project-host upgrade without an explicit target version", () => {
    expect(
      __test__.completedProjectHostUpgradeVersion({
        previousVersion: "ph-v1",
        row: {
          version: "ph-v2",
          metadata: {
            software: {
              project_host: "ph-v2",
            },
            host_agent: {
              project_host: {
                last_known_good_version: "ph-v2",
              },
            },
          },
        },
      }),
    ).toBe("ph-v2");
  });

  test("does not treat the previous last-known-good version as a recovered latest-channel upgrade", () => {
    expect(
      __test__.completedProjectHostUpgradeVersion({
        previousVersion: "ph-v1",
        row: {
          version: "ph-v1",
          metadata: {
            software: {
              project_host: "ph-v1",
            },
            host_agent: {
              project_host: {
                last_known_good_version: "ph-v1",
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  test("suppresses rollback when the host already runs the rollback version", () => {
    expect(
      __test__.redundantProjectHostRollbackReason({
        rollbackVersion: "ph-v2",
        row: {
          metadata: {
            software: {
              project_host: "ph-v2",
            },
          },
        },
      }),
    ).toBe("host_already_running_rollback_version");
  });

  test("allows rollback when the host reports a different installed version", () => {
    expect(
      __test__.redundantProjectHostRollbackReason({
        rollbackVersion: "ph-v1",
        row: {
          metadata: {
            software: {
              project_host: "ph-v2",
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe("hosts start-worker wait cancellation", () => {
  test("completion is scoped to the exact queued work, host and action", async () => {
    const attempt = {
      ...__test__.hostReadinessAttempt(
        "host-start",
        {},
        { metadata: { machine: { cloud: "gcp" } } },
        1000,
      )!,
      workId: "work-new",
    };
    const query = jest.fn(async () => ({
      rows: [{ state: "done", updated_at: new Date(2001) }],
    }));
    expect(await __test__.loadHostActionCompletion("h", attempt, query)).toBe(
      2001,
    );
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("WHERE id=$1 AND vm_id=$2 AND action=$3"),
      ["work-new", "h", "start"],
    ]);
    for (const state of ["queued", "in_progress"]) {
      expect(
        await __test__.loadHostActionCompletion("h", attempt, async () => ({
          rows: [{ state, updated_at: new Date(2001) }],
        })),
      ).toBeUndefined();
    }
    await expect(
      __test__.loadHostActionCompletion("h", attempt, async () => ({
        rows: [{ state: "failed", error: "provider failed" }],
      })),
    ).rejects.toThrow("provider failed");
    await expect(
      __test__.loadHostActionCompletion("h", attempt, async () => ({
        rows: [],
      })),
    ).rejects.toThrow("work not found");
  });

  test("work failure is surfaced even while host status remains starting", async () => {
    const readinessAttempt = __test__.hostReadinessAttempt(
      "host-start",
      {},
      { metadata: { machine: { cloud: "gcp" } } },
      1000,
    )!;
    await expect(
      __test__.waitForHostStatus({
        host_id: "h",
        desired: ["running"],
        readinessAttempt,
        loadStatus: async () => ({ status: "starting" }),
        loadActionCompletion: async () => {
          throw new Error("provider failed");
        },
        onUpdate: async () => {},
      }),
    ).rejects.toThrow("provider failed");
  });

  test("cancellation interrupts the managed readiness wait", async () => {
    const readinessAttempt = __test__.hostReadinessAttempt(
      "host-start",
      {},
      { metadata: { machine: { cloud: "gcp" } } },
      1000,
    )!;
    let checks = 0;
    await expect(
      __test__.waitForHostStatus({
        host_id: "h",
        desired: ["running"],
        readinessAttempt,
        loadStatus: async () => ({ status: "running", last_seen: new Date() }),
        loadActionCompletion: async () => undefined,
        shouldCancel: async () => ++checks >= 2,
        onUpdate: async () => {},
        delayFn: async () => {},
      }),
    ).rejects.toMatchObject({ code: "host-op-canceled" });
  });

  test("retry ignores an old lifecycle error despite new request timestamps", async () => {
    const since = Date.now();
    const old = new Date(since - 1000).toISOString();
    const fresh = new Date(since + 1).toISOString();
    let reads = 0;
    const loadStatus = async () => {
      if (++reads > 2) throw new Error("unexpected extra poll");
      return {
        status: reads === 1 ? "starting" : "running",
        metadata: {
          last_action_at: fresh,
          bootstrap: { status: "queued", updated_at: fresh },
          bootstrap_lifecycle: {
            summary_status: "error",
            last_error: "old toolkit error",
            last_reconcile_started_at: old,
            last_reconcile_finished_at: old,
          },
        },
      };
    };
    await __test__.waitForHostStatus({
      host_id: "h",
      desired: ["running"],
      bootstrapFailureSince: since,
      loadStatus,
      onUpdate: async () => {},
      delayFn: async () => {},
    });
    expect(reads).toBe(2);
  });

  test("late completion of an older lifecycle attempt is not a new failure", () => {
    expect(
      __test__.currentBootstrapFailure({
        since: 2000,
        row: {
          metadata: {
            bootstrap_lifecycle: {
              summary_status: "error",
              last_error: "old error",
              last_reconcile_started_at: new Date(1000).toISOString(),
              last_reconcile_finished_at: new Date(3000).toISOString(),
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  test("running provider cannot hide a current bootstrap failure", async () => {
    await expect(
      __test__.waitForHostStatus({
        host_id: "h",
        desired: ["running"],
        bootstrapFailureSince: 1000,
        onUpdate: async () => {},
        loadStatus: async () => ({
          status: "running",
          metadata: {
            bootstrap: {
              status: "error",
              updated_at: new Date(2000).toISOString(),
              message: "new error",
            },
          },
        }),
      }),
    ).rejects.toThrow("new error");
  });

  test("restart waits for its work completion and a different VM boot", async () => {
    const attempt = __test__.hostReadinessAttempt(
      "host-restart",
      {},
      {
        metadata: {
          machine: { cloud: "gcp" },
          host_boot_id: "old-boot",
          host_session_id: "old-session",
        },
      },
      1000,
    )!;
    const rows = [
      { last_seen: new Date(2001), metadata: { host_boot_id: "old-boot" } },
      {
        last_seen: new Date(2002),
        metadata: { host_boot_id: "old-boot", host_session_id: "new-session" },
      },
      { last_seen: new Date(2003), metadata: { host_boot_id: "new-boot" } },
    ];
    let reads = 0;
    await __test__.waitForHostStatus({
      host_id: "h",
      desired: ["running"],
      readinessAttempt: attempt,
      loadStatus: async () => {
        if (reads >= rows.length) throw new Error("unexpected extra poll");
        return { status: "running", ...rows[reads++] };
      },
      loadActionCompletion: async () => (reads === 1 ? undefined : 2000),
      onUpdate: async () => {},
      delayFn: async () => {},
    });
    expect(reads).toBe(3);
  });

  test("start permits an unchanged boot but requires a post-completion heartbeat", () => {
    const attempt = __test__.hostReadinessAttempt(
      "host-start",
      {},
      { metadata: { machine: { cloud: "gcp" } } },
      1000,
    )!;
    for (const last_seen of [
      undefined,
      "invalid",
      new Date(1999),
      new Date(2000),
    ]) {
      expect(__test__.hostApplicationReady({ last_seen }, attempt, 2000)).toBe(
        false,
      );
    }
    expect(
      __test__.hostApplicationReady(
        { last_seen: new Date(2001) },
        attempt,
        2000,
      ),
    ).toBe(true);
    expect(
      __test__.hostApplicationReady({ last_seen: new Date(2001) }, attempt),
    ).toBe(false);
  });

  test("self-host restart requires a replacement process, not a physical reboot", () => {
    const attempt = __test__.hostReadinessAttempt(
      "host-restart",
      { mode: "hard" },
      {
        metadata: {
          machine: { cloud: "self-host" },
          host_boot_id: "same-boot",
          host_session_id: "old",
        },
      },
      1000,
    )!;
    expect(attempt.action).toBe("hard_restart");
    for (const host_session_id of [undefined, "old", "new"]) {
      expect(
        __test__.hostApplicationReady(
          {
            last_seen: new Date(2001),
            metadata: {
              host_boot_id: "same-boot",
              host_session_id,
            },
          },
          attempt,
          2000,
        ),
      ).toBe(host_session_id === "new");
    }
  });

  test.each(["gcp", "hyperstack", "lambda"])(
    "%s recovery reboot remains dispatchable without a boot baseline",
    (cloud) => {
      for (const host_boot_id of [undefined, "", "   "]) {
        const attempt = __test__.hostReadinessAttempt(
          "host-restart",
          { mode: "hard" },
          {
            metadata: {
              machine: { cloud },
              host_boot_id,
              host_session_id: "old-session",
            },
          },
          1000,
        )!;
        expect(attempt.action).toBe("hard_restart");
        expect(attempt.requiresIdentityChange).toBe(true);
        expect(
          __test__.hostApplicationReady(
            { last_seen: new Date(2001), metadata: { host_boot_id: "first" } },
            attempt,
            2000,
          ),
        ).toBe(false);
      }
    },
  );

  test("Lambda start of an existing VM rejects old-process heartbeats after API acknowledgement", () => {
    const row = {
      metadata: {
        machine: { cloud: "lambda" },
        runtime: { instance_id: "vm" },
        host_boot_id: "old-boot",
        host_session_id: "old-session",
      },
    };
    const attempt = __test__.hostReadinessAttempt("host-start", {}, row, 1000)!;
    expect(attempt.action).toBe("start");
    expect(attempt.requiresIdentityChange).toBe(true);
    expect(
      __test__.hostApplicationReady(
        { ...row, last_seen: new Date(2001) },
        attempt,
        2000,
      ),
    ).toBe(false);
    expect(
      __test__.hostApplicationReady(
        {
          last_seen: new Date(2001),
          metadata: {
            host_boot_id: "old-boot",
            host_session_id: "new-session",
          },
        },
        attempt,
        2000,
      ),
    ).toBe(false);
    expect(
      __test__.hostApplicationReady(
        {
          last_seen: new Date(2001),
          metadata: {
            host_boot_id: "new-boot",
            host_session_id: "new-session",
          },
        },
        attempt,
        2000,
      ),
    ).toBe(true);
    const unobservedAttempt = __test__.hostReadinessAttempt(
      "host-start",
      {},
      {
        metadata: { ...row.metadata, host_boot_id: undefined },
      },
      1000,
    )!;
    expect(unobservedAttempt.requiresIdentityChange).toBe(true);
    expect(
      __test__.hostApplicationReady(
        { ...row, last_seen: new Date(2001) },
        unobservedAttempt,
        2000,
      ),
    ).toBe(false);
  });

  test.each([
    ["gcp", "host-restart"],
    ["hyperstack", "host-restart"],
    ["lambda", "host-restart"],
    ["lambda", "host-start"],
    ["self-host", "host-restart"],
  ] as const)(
    "%s %s acknowledges first-bootstrap recovery without claiming readiness",
    async (cloud, kind) => {
      const failedHost = {
        status: "error",
        metadata: {
          machine: { cloud },
          runtime: { instance_id: "existing-vm" },
          bootstrap: {
            status: "error",
            updated_at: new Date(500).toISOString(),
            message: "old toolkit error",
          },
        },
      };
      // Building the attempt must not block the subsequent provider dispatch.
      const attempt = __test__.hostReadinessAttempt(
        kind,
        {},
        failedHost,
        1000,
      )!;
      attempt.workId = "recovery-work";
      let polls = 0;
      const result = __test__.waitForHostStatus({
        host_id: "h",
        desired: ["running"],
        readinessAttempt: attempt,
        bootstrapFailureSince: 1000,
        loadStatus: async () => {
          if (++polls > 2) throw new Error("unverified recovery must not hang");
          return {
            ...failedHost,
            status: "running",
            last_seen: new Date(2001),
            metadata: {
              ...failedHost.metadata,
              host_boot_id: "first-registration",
              host_session_id: "first-session",
            },
          };
        },
        loadActionCompletion: async () => (polls === 1 ? undefined : 2000),
        onUpdate: async () => {},
        delayFn: async () => {},
      });
      await expect(result).rejects.toMatchObject({
        message: expect.stringContaining("recovery request acknowledged"),
        result: {
          cloud_work_id: "recovery-work",
          provider_action: kind === "host-start" ? "start" : "restart",
          provider_request_acknowledged: true,
          readiness: "unverified",
          reason: "missing_pre_operation_identity",
        },
      });
      expect(polls).toBe(2);
    },
  );

  test("unobserved recovery preserves provider failure instead of reporting acknowledgement", async () => {
    const attempt = __test__.hostReadinessAttempt(
      "host-restart",
      {},
      { metadata: { machine: { cloud: "gcp" } } },
      1000,
    )!;
    await expect(
      __test__.waitForHostStatus({
        host_id: "h",
        desired: ["running"],
        readinessAttempt: attempt,
        loadStatus: async () => ({ status: "restarting" }),
        loadActionCompletion: async () => {
          throw new Error("provider rejected recovery");
        },
        onUpdate: async () => {},
      }),
    ).rejects.toThrow("provider rejected recovery");
  });

  test("Hyperstack acknowledgement alone is insufficient even with fresh session telemetry", () => {
    const attempt = __test__.hostReadinessAttempt(
      "host-restart",
      { mode: "hard" },
      {
        metadata: { machine: { cloud: "hyperstack" }, host_boot_id: "old" },
      },
      1000,
    )!;
    for (const host_boot_id of [undefined, "old", "new"]) {
      expect(
        __test__.hostApplicationReady(
          {
            last_seen: new Date(2001),
            metadata: {
              host_boot_id,
              host_session_id: "new-session",
            },
          },
          attempt,
          2000,
        ),
      ).toBe(host_boot_id === "new");
    }
    // First registration without a baseline cannot prove a reboot occurred.
    expect(
      __test__.hostApplicationReady(
        { last_seen: new Date(2001) },
        {
          ...attempt,
          previousBootId: undefined,
        },
        2000,
      ),
    ).toBe(false);
  });

  test("Lambda new provisioning and explicit reprovision do not require a prior identity", () => {
    for (const metadata of [
      { machine: { cloud: "lambda" } },
      {
        machine: { cloud: "lambda" },
        runtime: { instance_id: "old" },
        reprovision_required: true,
      },
    ]) {
      const attempt = __test__.hostReadinessAttempt(
        "host-start",
        {},
        { metadata },
        1000,
      )!;
      expect(attempt.requiresIdentityChange).toBe(false);
      expect(
        __test__.hostApplicationReady(
          { last_seen: new Date(2001) },
          attempt,
          2000,
        ),
      ).toBe(true);
    }
  });

  test("local and no-provider no-op paths do not require a boot change", () => {
    for (const cloud of [undefined, "local"]) {
      expect(
        __test__.hostReadinessAttempt(
          "host-restart",
          {},
          { metadata: { machine: { cloud } } },
          1000,
        ),
      ).toBeUndefined();
    }
    expect(
      __test__.hostReadinessAttempt("host-stop", {}, {}, 1000),
    ).toBeUndefined();
  });

  test("stops waiting when the host op is canceled mid-wait", async () => {
    let checks = 0;
    await expect(
      __test__.waitForHostStatus({
        host_id: "host-1",
        desired: ["running"],
        onUpdate: async () => {},
        shouldCancel: async () => {
          checks += 1;
          return checks >= 2;
        },
        loadStatus: async () => ({
          status: "starting",
          metadata: {},
        }),
        delayFn: async () => {},
        pollMs: 0,
      }),
    ).rejects.toMatchObject({ code: "host-op-canceled" });
  });
});

describe("hosts start-worker billing drain completion metadata", () => {
  test("marks billing-enforced drains as stopped with a succeeded final backup", () => {
    const metadata = __test__.billingEnforcementDrainCompleteMetadata(
      {
        desired_state: "running",
        billing: {
          funding_mode: "account-prepaid",
          funding_lane: "prepaid",
          enforcement: {
            state: "draining",
            reason: "prepaid balance is exhausted",
            final_backup_status: "running",
          },
        },
      },
      new Date("2026-06-25T00:00:00.000Z"),
    );

    expect(metadata.desired_state).toBe("stopped");
    expect(metadata.billing.stop_reason).toBe("prepaid balance is exhausted");
    expect(metadata.billing.stop_requested_at).toBe("2026-06-25T00:00:00.000Z");
    expect(metadata.billing.enforcement).toEqual(
      expect.objectContaining({
        state: "stopped_billing_blocked",
        reason: "prepaid balance is exhausted",
        final_backup_status: "succeeded",
        final_backup_completed_at: "2026-06-25T00:00:00.000Z",
        grace_until: "2026-06-28T00:00:00.000Z",
        deprovision_after: "2026-06-28T00:00:00.000Z",
      }),
    );
  });

  test("preserves recovery data without a deprovision deadline when a billing drain fails", () => {
    const metadata = __test__.billingEnforcementDrainFailedMetadata(
      {
        desired_state: "running",
        billing: {
          funding_mode: "account-prepaid",
          funding_lane: "prepaid",
          enforcement: {
            state: "draining",
            reason: "prepaid balance is exhausted",
            final_backup_status: "running",
            grace_until: "2026-06-28T00:00:00.000Z",
            deprovision_after: "2026-06-28T00:00:00.000Z",
          },
        },
      },
      new Error("final backup failed"),
      new Date("2026-06-25T00:00:00.000Z"),
    );

    expect(metadata.desired_state).toBe("stopped");
    expect(metadata.billing.stop_reason).toBe("prepaid balance is exhausted");
    expect(metadata.billing.stop_requested_at).toBe("2026-06-25T00:00:00.000Z");
    expect(metadata.billing.enforcement).toEqual(
      expect.objectContaining({
        state: "stopped_billing_blocked",
        reason: "prepaid balance is exhausted",
        final_backup_status: "failed",
        final_backup_failed_at: "2026-06-25T00:00:00.000Z",
        final_backup_error: "Error: final backup failed",
      }),
    );
    expect(metadata.billing.enforcement).not.toHaveProperty("grace_until");
    expect(metadata.billing.enforcement).not.toHaveProperty(
      "deprovision_after",
    );
    expect(metadata.billing.enforcement).not.toHaveProperty(
      "final_backup_completed_at",
    );
  });

  test("builds a deduplicated admin alert for failed billing drains", () => {
    const alert = __test__.billingEnforcementDrainFailureAdminAlert({
      host_id: "host-1",
      account_id: "account-1",
      op_id: "op-1",
      error: new Error(
        "failed to drain workspace project-1: final backup failed",
      ),
      final_backup_status: "failed",
    });

    expect(alert.subject).toBe("Dedicated host billing drain failed (host-1)");
    expect(alert.body).toContain("project-1");
    expect(alert.body).toContain("The compute stop request succeeded.");
    expect(alert.body).toContain("provider disk were retained");
    expect(alert.body).toContain("Automatic disk deprovisioning is disabled");
    expect(alert.dedupMinutes).toBe(24 * 60);
    expect(alert.dedupBySubject).toBe(true);
  });

  test("preserves successful-backup messaging when only the compute stop fails", () => {
    const alert = __test__.billingEnforcementDrainFailureAdminAlert({
      host_id: "host-1",
      account_id: "account-1",
      op_id: "op-1",
      error: new Error("cloud stop failed"),
      stop_error: new Error("provider unavailable"),
      final_backup_status: "succeeded",
    });

    expect(alert.body).toContain("Final backup status: succeeded");
    expect(alert.body).toContain("Normal backup-backed disk grace");
    expect(alert.body).toContain(
      "compute stop request also failed: Error: provider unavailable",
    );
    expect(alert.body).not.toContain(
      "Automatic disk deprovisioning is disabled",
    );
  });
});
