/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let isMultiBayClusterMock: jest.Mock;
let getInterBayFabricClientMock: jest.Mock;
let createInterBayAccountNotificationFeedClientMock: jest.Mock;
let applyNotificationTargetOutboxRowToAccountNotificationIndexMock: jest.Mock;
let publishProjectedNotificationFeedUpdatesBestEffortMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: queryMock,
  }),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: (...args: any[]) => isMultiBayClusterMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: (...args: any[]) =>
    getInterBayFabricClientMock(...args),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountNotificationFeedClient: (...args: any[]) =>
    createInterBayAccountNotificationFeedClientMock(...args),
}));

jest.mock(
  "@cocalc/database/postgres/account-notification-index-projector",
  () => ({
    applyNotificationTargetOutboxRowToAccountNotificationIndex: (
      ...args: any[]
    ) =>
      applyNotificationTargetOutboxRowToAccountNotificationIndexMock(...args),
  }),
);

jest.mock("./feed", () => ({
  publishProjectedNotificationFeedUpdatesBestEffort: (...args: any[]) =>
    publishProjectedNotificationFeedUpdatesBestEffortMock(...args),
}));

describe("remote notification feed forwarding", () => {
  beforeEach(() => {
    queryMock = jest.fn();
    isMultiBayClusterMock = jest.fn(() => true);
    getInterBayFabricClientMock = jest.fn(() => ({ fabric: true }));
    createInterBayAccountNotificationFeedClientMock = jest.fn();
    applyNotificationTargetOutboxRowToAccountNotificationIndexMock = jest.fn();
    publishProjectedNotificationFeedUpdatesBestEffortMock = jest.fn();
  });

  it("forwards unpublished remote outbox rows and marks them published", async () => {
    const remoteUpsert = jest.fn(async () => undefined);
    createInterBayAccountNotificationFeedClientMock.mockReturnValue({
      upsert: remoteUpsert,
    });
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            outbox_id: "11111111-1111-4111-8111-111111111111",
            target_home_bay_id: "bay-1",
            target_account_id: "22222222-2222-4222-8222-222222222222",
            notification_id: "33333333-3333-4333-8333-333333333333",
            kind: "mention",
            event_type: "notification.upserted",
            payload_json: {
              source_project_id: "44444444-4444-4444-8444-444444444444",
              summary: { path: "/home/user/b.chat" },
            },
            created_at: new Date("2026-06-26T20:26:06.487Z"),
            published_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { forwardRemoteNotificationTargetsBestEffort } =
      await import("./remote-feed");

    await expect(
      forwardRemoteNotificationTargetsBestEffort({
        bay_id: "bay-0",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      scanned_events: 1,
      applied_events: 1,
      affected_account_ids: ["22222222-2222-4222-8222-222222222222"],
      affected_notifications: [
        {
          account_id: "22222222-2222-4222-8222-222222222222",
          notification_id: "33333333-3333-4333-8333-333333333333",
        },
      ],
    });
    expect(
      createInterBayAccountNotificationFeedClientMock,
    ).toHaveBeenCalledWith({
      client: { fabric: true },
      dest_bay: "bay-1",
    });
    expect(remoteUpsert).toHaveBeenCalledWith({
      target_account_id: "22222222-2222-4222-8222-222222222222",
      target_home_bay_id: "bay-1",
      notification_id: "33333333-3333-4333-8333-333333333333",
      kind: "mention",
      event_type: "notification.upserted",
      payload_json: {
        source_project_id: "44444444-4444-4444-8444-444444444444",
        summary: { path: "/home/user/b.chat" },
      },
      created_at: "2026-06-26T20:26:06.487Z",
    });
    expect(queryMock).toHaveBeenLastCalledWith(
      expect.stringContaining("SET published_at = NOW()"),
      ["11111111-1111-4111-8111-111111111111"],
    );
  });

  it("applies a remote notification target on the home bay and publishes feed", async () => {
    applyNotificationTargetOutboxRowToAccountNotificationIndexMock.mockResolvedValue(
      {
        inserted_rows: 1,
        deleted_rows: 0,
        affected_account_id: "22222222-2222-4222-8222-222222222222",
        affected_notification_id: "33333333-3333-4333-8333-333333333333",
      },
    );

    const { applyRemoteNotificationTargetOnHomeBay } =
      await import("./remote-feed");

    await applyRemoteNotificationTargetOnHomeBay({
      bay_id: "bay-1",
      target_account_id: "22222222-2222-4222-8222-222222222222",
      target_home_bay_id: "bay-1",
      notification_id: "33333333-3333-4333-8333-333333333333",
      kind: "mention",
      event_type: "notification.upserted",
      payload_json: { summary: { path: "/home/user/b.chat" } },
      created_at: "2026-06-26T20:26:06.487Z",
    });

    expect(
      applyNotificationTargetOutboxRowToAccountNotificationIndexMock,
    ).toHaveBeenCalledWith({
      bay_id: "bay-1",
      event: expect.objectContaining({
        target_account_id: "22222222-2222-4222-8222-222222222222",
        notification_id: "33333333-3333-4333-8333-333333333333",
        target_home_bay_id: "bay-1",
        kind: "mention",
        event_type: "notification.upserted",
      }),
      require_local_account: true,
    });
    expect(
      publishProjectedNotificationFeedUpdatesBestEffortMock,
    ).toHaveBeenCalledWith({
      account_id: "22222222-2222-4222-8222-222222222222",
      reason: "projected_upsert",
      notification_ids: ["33333333-3333-4333-8333-333333333333"],
    });
  });
});
