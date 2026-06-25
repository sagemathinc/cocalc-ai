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
});

describe("hosts start-worker wait cancellation", () => {
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
});
