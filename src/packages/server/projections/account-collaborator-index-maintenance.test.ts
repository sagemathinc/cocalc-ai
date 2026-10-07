/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getAccountCollaboratorIndexProjectionMaintenanceStatus,
  publishAccountCollaboratorFeedEvents,
  resetAccountCollaboratorIndexProjectionMaintenanceStateForTests,
  runAccountCollaboratorIndexProjectionMaintenanceTick,
  runAccountCollaboratorIndexProjectionPass,
} from "./account-collaborator-index-maintenance";

describe("runAccountCollaboratorIndexProjectionPass", () => {
  beforeEach(() => {
    resetAccountCollaboratorIndexProjectionMaintenanceStateForTests();
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
        inserted_rows: 6,
        deleted_rows: 2,
        feed_events: [],
        event_types: {
          "project.membership_changed": 2,
          "project.created": 1,
        },
      })
      .mockResolvedValueOnce({
        bay_id: "bay-7",
        dry_run: false,
        requested_limit: 3,
        scanned_events: 1,
        applied_events: 1,
        inserted_rows: 2,
        deleted_rows: 1,
        feed_events: [],
        event_types: {
          "project.deleted": 1,
        },
      });
    expect(
      await runAccountCollaboratorIndexProjectionPass({
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
      inserted_rows: 8,
      deleted_rows: 3,
      feed_events: [],
      event_types: {
        "project.membership_changed": 2,
        "project.created": 1,
        "project.deleted": 1,
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

  it("records maintenance success state after a tick", async () => {
    const pass_runner = jest.fn(async () => ({
      bay_id: "bay-7",
      batches: 1,
      scanned_events: 2,
      applied_events: 2,
      inserted_rows: 4,
      deleted_rows: 1,
      feed_events: [
        {
          type: "collaborator.upsert" as const,
          ts: 1,
          account_id: "acct-1",
          collaborator: {
            account_id: "acct-2",
            first_name: "Collab",
            last_name: "Two",
            name: "Collab Two",
            last_active: null,
            profile: null,
            common_project_count: 3,
            updated_at: null,
          },
        },
      ],
      event_types: {
        "project.membership_changed": 2,
      },
    }));
    const publisher = jest.fn(async () => undefined);
    await expect(
      runAccountCollaboratorIndexProjectionMaintenanceTick({
        pass_runner,
        publisher,
      }),
    ).resolves.toEqual({
      bay_id: "bay-7",
      batches: 1,
      scanned_events: 2,
      applied_events: 2,
      inserted_rows: 4,
      deleted_rows: 1,
      feed_events: [
        {
          type: "collaborator.upsert" as const,
          ts: 1,
          account_id: "acct-1",
          collaborator: {
            account_id: "acct-2",
            first_name: "Collab",
            last_name: "Two",
            name: "Collab Two",
            last_active: null,
            profile: null,
            common_project_count: 3,
            updated_at: null,
          },
        },
      ],
      event_types: {
        "project.membership_changed": 2,
      },
    });

    const status = getAccountCollaboratorIndexProjectionMaintenanceStatus();
    expect(status.running).toBe(false);
    expect(status.last_result).toEqual({
      bay_id: "bay-7",
      batches: 1,
      scanned_events: 2,
      applied_events: 2,
      inserted_rows: 4,
      deleted_rows: 1,
      feed_event_count: 1,
      event_types: {
        "project.membership_changed": 2,
      },
    });
    expect(publisher).toHaveBeenCalledWith({
      account_id: "acct-1",
      event: expect.objectContaining({
        type: "collaborator.upsert",
      }),
    });
    expect(status.last_success_at).not.toBeNull();
    expect(status.last_error).toBeNull();
    expect(status.consecutive_failures).toBe(0);
  });

  it("records maintenance errors after a failed tick", async () => {
    await expect(
      runAccountCollaboratorIndexProjectionMaintenanceTick({
        pass_runner: jest.fn(async () => {
          throw new Error("collaborator projection tick failed");
        }),
      }),
    ).rejects.toThrow("collaborator projection tick failed");

    const status = getAccountCollaboratorIndexProjectionMaintenanceStatus();
    expect(status.running).toBe(false);
    expect(status.last_result).toBeNull();
    expect(status.last_error_at).not.toBeNull();
    expect(status.last_error).toContain("collaborator projection tick failed");
    expect(status.consecutive_failures).toBe(1);
  });
});

function upsertEvent(i: number) {
  return {
    type: "collaborator.upsert" as const,
    ts: i,
    account_id: `acct-${i}`,
    collaborator: {
      account_id: `peer-${i}`,
      first_name: null,
      last_name: null,
      name: null,
      last_active: null,
      profile: null,
      common_project_count: 1,
      updated_at: null,
    },
  };
}

describe("account collaborator feed publishing", () => {
  beforeEach(() => {
    resetAccountCollaboratorIndexProjectionMaintenanceStateForTests();
  });

  it("publishes in bounded chunks and yields between them", async () => {
    const events = Array.from({ length: 7 }, (_, i) => upsertEvent(i));
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const publisher = jest.fn(async ({ account_id }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(account_id);
      await Promise.resolve();
      inFlight -= 1;
    });
    let immediates = 0;
    const realSetImmediate = global.setImmediate;
    const spy = jest.spyOn(global, "setImmediate").mockImplementation(((
      fn: (...args: any[]) => void,
    ) => {
      immediates += 1;
      return realSetImmediate(fn);
    }) as any);
    try {
      await publishAccountCollaboratorFeedEvents(events, {
        publisher,
        chunk_size: 3,
      });
    } finally {
      spy.mockRestore();
    }
    expect(publisher).toHaveBeenCalledTimes(7);
    expect(order).toEqual(events.map((event) => event.account_id));
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(immediates).toBe(2);
  });

  it("keeps feed events out of status and still publishes all of them", async () => {
    const feed_events = Array.from({ length: 250 }, (_, i) => upsertEvent(i));
    const publisher = jest.fn(async () => undefined);
    const result = await runAccountCollaboratorIndexProjectionMaintenanceTick({
      pass_runner: jest.fn(async () => ({
        bay_id: "bay-7",
        batches: 1,
        scanned_events: 1,
        applied_events: 1,
        inserted_rows: 250,
        deleted_rows: 250,
        feed_events,
        event_types: { "project.membership_changed": 1 },
      })),
      publisher,
      publish_chunk_size: 100,
    });
    expect(result?.feed_events).toHaveLength(250);
    expect(publisher).toHaveBeenCalledTimes(250);
    const status = getAccountCollaboratorIndexProjectionMaintenanceStatus();
    expect(status.last_result).not.toHaveProperty("feed_events");
    expect(status.last_result?.feed_event_count).toBe(250);
  });

  it("does not fail a committed tick when feed publishing throws", async () => {
    await expect(
      runAccountCollaboratorIndexProjectionMaintenanceTick({
        pass_runner: jest.fn(async () => ({
          bay_id: "bay-7",
          batches: 1,
          scanned_events: 1,
          applied_events: 1,
          inserted_rows: 1,
          deleted_rows: 0,
          feed_events: [upsertEvent(1)],
          event_types: { "project.membership_changed": 1 },
        })),
        publisher: jest.fn(async () => {
          throw new Error("conat down");
        }),
      }),
    ).resolves.not.toBeNull();
    const status = getAccountCollaboratorIndexProjectionMaintenanceStatus();
    expect(status.last_error).toBeNull();
    expect(status.consecutive_failures).toBe(0);
    expect(status.running).toBe(false);
  });
});
