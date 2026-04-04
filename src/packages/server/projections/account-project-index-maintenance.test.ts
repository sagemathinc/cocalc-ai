/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getAccountProjectIndexProjectionMaintenanceStatus,
  resetAccountProjectIndexProjectionMaintenanceStateForTests,
  runAccountProjectIndexProjectionMaintenanceTick,
  runAccountProjectIndexProjectionPass,
} from "./account-project-index-maintenance";

describe("runAccountProjectIndexProjectionPass", () => {
  beforeEach(() => {
    resetAccountProjectIndexProjectionMaintenanceStateForTests();
  });

  it("drains multiple batches until a partial batch is reached", async () => {
    const drain = jest
      .fn()
      .mockResolvedValueOnce({
        bay_id: "bay-7",
        dry_run: false,
        requested_limit: 3,
        scanned_events: 3,
        applied_events: 3,
        inserted_rows: 4,
        deleted_rows: 1,
        event_types: {
          "project.summary_changed": 2,
          "project.membership_changed": 1,
        },
      })
      .mockResolvedValueOnce({
        bay_id: "bay-7",
        dry_run: false,
        requested_limit: 3,
        scanned_events: 1,
        applied_events: 1,
        inserted_rows: 2,
        deleted_rows: 0,
        event_types: {
          "project.created": 1,
        },
      });
    expect(
      await runAccountProjectIndexProjectionPass({
        bay_id: "bay-7",
        batch_limit: 3,
        max_batches_per_tick: 5,
        drain,
      }),
    ).toEqual({
      bay_id: "bay-7",
      batches: 2,
      scanned_events: 4,
      applied_events: 4,
      inserted_rows: 6,
      deleted_rows: 1,
      event_types: {
        "project.summary_changed": 2,
        "project.membership_changed": 1,
        "project.created": 1,
      },
    });
    expect(drain).toHaveBeenNthCalledWith(1, {
      bay_id: "bay-7",
      limit: 3,
      dry_run: false,
    });
    expect(drain).toHaveBeenNthCalledWith(2, {
      bay_id: "bay-7",
      limit: 3,
      dry_run: false,
    });
  });

  it("stops after the configured max batch count", async () => {
    const drain = jest.fn().mockResolvedValue({
      bay_id: "bay-0",
      dry_run: false,
      requested_limit: 2,
      scanned_events: 2,
      applied_events: 2,
      inserted_rows: 1,
      deleted_rows: 0,
      event_types: {
        "project.summary_changed": 2,
      },
    });
    const result = await runAccountProjectIndexProjectionPass({
      batch_limit: 2,
      max_batches_per_tick: 2,
      drain,
    });
    expect(result.batches).toBe(2);
    expect(result.scanned_events).toBe(4);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("records maintenance success state after a tick", async () => {
    const pass_runner = jest.fn(async () => ({
      bay_id: "bay-7",
      batches: 1,
      scanned_events: 2,
      applied_events: 2,
      inserted_rows: 3,
      deleted_rows: 1,
      event_types: {
        "project.summary_changed": 2,
      },
    }));
    await expect(
      runAccountProjectIndexProjectionMaintenanceTick({
        pass_runner,
      }),
    ).resolves.toEqual({
      bay_id: "bay-7",
      batches: 1,
      scanned_events: 2,
      applied_events: 2,
      inserted_rows: 3,
      deleted_rows: 1,
      event_types: {
        "project.summary_changed": 2,
      },
    });

    const status = getAccountProjectIndexProjectionMaintenanceStatus();
    expect(status.running).toBe(false);
    expect(status.last_result).toEqual({
      bay_id: "bay-7",
      batches: 1,
      scanned_events: 2,
      applied_events: 2,
      inserted_rows: 3,
      deleted_rows: 1,
      event_types: {
        "project.summary_changed": 2,
      },
    });
    expect(status.last_success_at).not.toBeNull();
    expect(status.last_error).toBeNull();
    expect(status.consecutive_failures).toBe(0);
  });

  it("records maintenance errors after a failed tick", async () => {
    await expect(
      runAccountProjectIndexProjectionMaintenanceTick({
        pass_runner: jest.fn(async () => {
          throw new Error("projection tick failed");
        }),
      }),
    ).rejects.toThrow("projection tick failed");

    const status = getAccountProjectIndexProjectionMaintenanceStatus();
    expect(status.running).toBe(false);
    expect(status.last_result).toBeNull();
    expect(status.last_error_at).not.toBeNull();
    expect(status.last_error).toContain("projection tick failed");
    expect(status.consecutive_failures).toBe(1);
  });
});
