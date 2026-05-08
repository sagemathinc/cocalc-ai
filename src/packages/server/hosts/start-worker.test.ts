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
