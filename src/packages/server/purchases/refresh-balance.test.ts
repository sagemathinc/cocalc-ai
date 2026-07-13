/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getBalanceMock: jest.Mock;
let publishAccountRowFeedEventsBestEffortMock: jest.Mock;
let warnMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => () => ({
  warn: (...args: any[]) => warnMock(...args),
}));

jest.mock("@cocalc/server/account/account-row-feed", () => ({
  publishAccountRowFeedEventsBestEffort: (...args: any[]) =>
    publishAccountRowFeedEventsBestEffortMock(...args),
}));

jest.mock("./get-balance", () => ({
  __esModule: true,
  default: (...args: any[]) => getBalanceMock(...args),
}));

describe("refreshAccountBalanceAndPublishBestEffort", () => {
  beforeEach(() => {
    getBalanceMock = jest.fn(async () => "12.3400000000");
    publishAccountRowFeedEventsBestEffortMock = jest.fn(async () => undefined);
    warnMock = jest.fn();
  });

  it("refreshes the cached balance and publishes an account-feed patch", async () => {
    const { refreshAccountBalanceAndPublishBestEffort } =
      await import("./refresh-balance");

    await refreshAccountBalanceAndPublishBestEffort({
      account_id: "acct-1",
    });

    expect(getBalanceMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      forceSave: true,
    });
    expect(publishAccountRowFeedEventsBestEffortMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      patch: { balance: 12.34 },
      reason: "balance_updated",
    });
  });

  it("does not fail the caller when publishing fails", async () => {
    publishAccountRowFeedEventsBestEffortMock.mockRejectedValueOnce(
      new Error("offline"),
    );
    const { refreshAccountBalanceAndPublishBestEffort } =
      await import("./refresh-balance");

    await expect(
      refreshAccountBalanceAndPublishBestEffort({
        account_id: "acct-1",
      }),
    ).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalled();
  });
});
