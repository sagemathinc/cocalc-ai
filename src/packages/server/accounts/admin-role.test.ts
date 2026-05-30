/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const withAccountRehomeWriteFenceMock = jest.fn();
const publishAccountRowFeedEventsBestEffortMock = jest.fn();
const recordAccountAdminAuditEventMock = jest.fn();

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  __esModule: true,
  withAccountRehomeWriteFence: (...args: any[]) =>
    withAccountRehomeWriteFenceMock(...args),
}));

jest.mock("@cocalc/server/account/account-row-feed", () => ({
  __esModule: true,
  publishAccountRowFeedEventsBestEffort: (...args: any[]) =>
    publishAccountRowFeedEventsBestEffortMock(...args),
}));

jest.mock("@cocalc/server/accounts/admin-audit", () => ({
  __esModule: true,
  recordAccountAdminAuditEvent: (...args: any[]) =>
    recordAccountAdminAuditEventMock(...args),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

describe("grantAdminRole", () => {
  beforeEach(() => {
    jest.resetModules();
    withAccountRehomeWriteFenceMock.mockReset();
    publishAccountRowFeedEventsBestEffortMock.mockReset();
    recordAccountAdminAuditEventMock.mockReset();
  });

  it("adds admin without replacing existing groups and audits the change", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ groups: ["analytics"] }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    withAccountRehomeWriteFenceMock.mockImplementation(async ({ fn }) => {
      return await fn({ query });
    });

    const { grantAdminRole } = await import("./admin-role");
    const result = await grantAdminRole({
      account_id: ACCOUNT_ID,
      actor_account_id: ACTOR_ACCOUNT_ID,
      reason: "promote support lead",
    });

    expect(result).toEqual({
      account_id: ACCOUNT_ID,
      already_admin: false,
      groups: ["analytics", "admin"],
    });
    expect(query).toHaveBeenNthCalledWith(
      2,
      "UPDATE accounts SET groups=$1::TEXT[] WHERE account_id=$2",
      [["analytics", "admin"], ACCOUNT_ID],
    );
    expect(publishAccountRowFeedEventsBestEffortMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      patch: { groups: ["analytics", "admin"] },
    });
    expect(recordAccountAdminAuditEventMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      action: "grant-admin",
      actor_account_id: ACTOR_ACCOUNT_ID,
      reason: "promote support lead",
      metadata: {
        already_admin: false,
        old_groups: ["analytics"],
        new_groups: ["analytics", "admin"],
      },
    });
  });

  it("does not rewrite or publish when the account is already an admin", async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [{ groups: ["admin", "analytics"] }],
    });
    withAccountRehomeWriteFenceMock.mockImplementation(async ({ fn }) => {
      return await fn({ query });
    });

    const { grantAdminRole } = await import("./admin-role");
    const result = await grantAdminRole({
      account_id: ACCOUNT_ID,
      actor_account_id: ACTOR_ACCOUNT_ID,
    });

    expect(result).toEqual({
      account_id: ACCOUNT_ID,
      already_admin: true,
      groups: ["admin", "analytics"],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(publishAccountRowFeedEventsBestEffortMock).not.toHaveBeenCalled();
    expect(recordAccountAdminAuditEventMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      action: "grant-admin",
      actor_account_id: ACTOR_ACCOUNT_ID,
      reason: undefined,
      metadata: {
        already_admin: true,
        old_groups: ["admin", "analytics"],
        new_groups: ["admin", "analytics"],
      },
    });
  });
});
