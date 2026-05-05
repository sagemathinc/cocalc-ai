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
