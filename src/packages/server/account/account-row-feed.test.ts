/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let publishAccountFeedEventBestEffortMock: jest.Mock;
let dbMock: { publishAccountRowFeedEventsBestEffort?: any };

jest.mock("@cocalc/database", () => ({
  db: () => dbMock,
}));

jest.mock("./feed", () => ({
  publishAccountFeedEventBestEffort: (...args: any[]) =>
    publishAccountFeedEventBestEffortMock(...args),
}));

describe("publishAccountRowFeedEventsBestEffort", () => {
  beforeEach(() => {
    publishAccountFeedEventBestEffortMock = jest.fn();
    dbMock = {};
  });

  it("publishes account.upsert events with the provided patch", async () => {
    const { publishAccountRowFeedEventsBestEffort } =
      await import("./account-row-feed");

    await publishAccountRowFeedEventsBestEffort({
      account_id: "acct-1",
      patch: { unread_message_count: 3 },
      reason: "messages_unread_count_updated",
    });

    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      event: expect.objectContaining({
        type: "account.upsert",
        account_id: "acct-1",
        account: { unread_message_count: 3 },
        reason: "messages_unread_count_updated",
      }),
    });
  });

  it("registers the db publisher hook", async () => {
    const {
      enableDbAccountRowFeedPublishing,
      publishAccountRowFeedEventsBestEffort,
    } = await import("./account-row-feed");

    enableDbAccountRowFeedPublishing();

    expect(dbMock.publishAccountRowFeedEventsBestEffort).toBe(
      publishAccountRowFeedEventsBestEffort,
    );
  });
});
