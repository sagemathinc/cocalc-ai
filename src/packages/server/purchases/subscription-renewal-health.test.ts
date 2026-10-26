/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import dayjs from "dayjs";

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "./test-data";

const mockAdminAlert = jest.fn();
const mockGetServerSettings = jest.fn();

jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAdminAlert(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => mockGetServerSettings(...args),
}));

import { alertDelayedSubscriptionRenewals } from "./subscription-renewal-health";

beforeAll(async () => {
  await before({ noConat: true });
}, 15_000);
afterAll(after);

describe("subscription renewal health alert", () => {
  beforeEach(async () => {
    await getPool().query("DELETE FROM subscription_renewal_attempts");
    await getPool().query("DELETE FROM subscriptions");
    mockAdminAlert.mockReset().mockResolvedValue(undefined);
    mockGetServerSettings.mockReset().mockResolvedValue({
      subscription_maintenance: {
        renewal_warning_minutes: 10,
        renewal_critical_minutes: 24 * 60,
      },
    });
  });

  it("sends one aggregate alert containing every delayed renewal", async () => {
    const warningAccount = uuid();
    const criticalAccount = uuid();
    await createTestAccount(warningAccount);
    await createTestAccount(criticalAccount);
    const warning = await createTestMembershipSubscription(warningAccount, {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(20, "minute").toDate(),
    });
    const critical = await createTestMembershipSubscription(criticalAccount, {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(2, "day").toDate(),
    });

    await expect(alertDelayedSubscriptionRenewals()).resolves.toBe(2);

    expect(mockAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(warningAccount),
        dedupBySubject: true,
        dedupMinutes: 24 * 60,
        subject: "CRITICAL: Personal membership renewal processing is delayed",
      }),
    );
    const body = mockAdminAlert.mock.calls[0][0].body;
    expect(body).toContain(criticalAccount);
    expect(body).toContain(`${warning.subscription_id}`);
    expect(body).toContain(`${critical.subscription_id}`);
    expect(body).toContain("Affected renewals: 2");
  });

  it("does not count payments waiting for the customer during the grace period", async () => {
    const waitingAccount = uuid();
    const expiredAccount = uuid();
    await createTestAccount(waitingAccount);
    await createTestAccount(expiredAccount);
    const waiting = await createTestMembershipSubscription(waitingAccount, {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(2, "day").toDate(),
    });
    const expired = await createTestMembershipSubscription(expiredAccount, {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(8, "day").toDate(),
    });
    await getPool().query(
      `UPDATE subscription_renewal_attempts
          SET customer_action_required_at=NOW(),
              customer_action_notified_at=NOW(),
              next_attempt_at=NOW() + INTERVAL '6 hours'
        WHERE subscription_id = ANY($1)`,
      [[waiting.subscription_id, expired.subscription_id]],
    );

    // Still open after the grace period is an operational problem.
    await expect(alertDelayedSubscriptionRenewals()).resolves.toBe(1);
    const body = mockAdminAlert.mock.calls[0][0].body;
    expect(body).toContain(expiredAccount);
    expect(body).not.toContain(waitingAccount);
  });

  it.each([
    [
      "the recheck is overdue",
      "customer_action_notified_at=NOW(), next_attempt_at=NOW() - INTERVAL '1 hour'",
    ],
    [
      "the customer was never notified",
      "next_attempt_at=NOW() + INTERVAL '6 hours'",
    ],
  ])("alerts on a waiting payment when %s", async (_label, set) => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        start: dayjs().subtract(1, "month").toDate(),
        end: dayjs().subtract(2, "day").toDate(),
      },
    );
    await getPool().query(
      `UPDATE subscription_renewal_attempts
          SET customer_action_required_at=NOW(), ${set}
        WHERE subscription_id=$1`,
      [subscription_id],
    );

    await expect(alertDelayedSubscriptionRenewals()).resolves.toBe(1);
    expect(mockAdminAlert.mock.calls[0][0].body).toContain(account_id);
  });

  it("does not alert when no attempt has crossed the warning threshold", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, {
      end: dayjs().add(1, "minute").toDate(),
    });

    await expect(alertDelayedSubscriptionRenewals()).resolves.toBe(0);
    expect(mockAdminAlert).not.toHaveBeenCalled();
  });

  it("points out overdue renewals that were never tried", async () => {
    const neverTried = uuid();
    const retried = uuid();
    await createTestAccount(neverTried);
    await createTestAccount(retried);
    await createTestMembershipSubscription(neverTried, {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(2, "hour").toDate(),
    });
    const r = await createTestMembershipSubscription(retried, {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(3, "hour").toDate(),
    });
    await getPool().query(
      `UPDATE subscription_renewal_attempts
          SET attempt_count=40, last_attempt_at=NOW()
        WHERE subscription_id=$1`,
      [r.subscription_id],
    );

    await expect(alertDelayedSubscriptionRenewals()).resolves.toBe(2);
    const body = mockAdminAlert.mock.calls[0][0].body;
    expect(body).toContain("Never tried yet: 1.");
    expect(body).toContain("head-of-line");
  });

  it("does not count renewals no pass may claim as never tried", async () => {
    const banned = uuid();
    await createTestAccount(banned);
    await createTestMembershipSubscription(banned, {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(2, "hour").toDate(),
    });
    await getPool().query(
      "UPDATE accounts SET banned=true WHERE account_id=$1",
      [banned],
    );

    await expect(alertDelayedSubscriptionRenewals()).resolves.toBe(1);
    const body = mockAdminAlert.mock.calls[0][0].body;
    expect(body).not.toContain("Never tried");
    expect(body).toContain("Not claimable: 1");
  });

  it("does not report starvation when every overdue renewal was tried", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        start: dayjs().subtract(1, "month").toDate(),
        end: dayjs().subtract(2, "hour").toDate(),
      },
    );
    await getPool().query(
      `UPDATE subscription_renewal_attempts SET attempt_count=3
        WHERE subscription_id=$1`,
      [subscription_id],
    );
    await expect(alertDelayedSubscriptionRenewals()).resolves.toBe(1);
    expect(mockAdminAlert.mock.calls[0][0].body).not.toContain("Never tried");
  });

  it.each([
    [true, 0],
    [false, 1],
  ])(
    "treats a renewal waiting for a VAT ID as expected only if the customer was told (notice recorded: %s)",
    async (noticed, alerted) => {
      const account_id = uuid();
      await createTestAccount(account_id);
      const { subscription_id } = await createTestMembershipSubscription(
        account_id,
        {
          start: dayjs().subtract(1, "month").toDate(),
          end: dayjs().subtract(2, "day").toDate(),
        },
      );
      await getPool().query("DELETE FROM business_tax_id_notices");
      if (noticed) {
        await getPool().query(
          `INSERT INTO business_tax_id_notices (account_id, notified_at)
           VALUES ($1, NOW())`,
          [account_id],
        );
      }
      await getPool().query(
        `UPDATE subscription_renewal_attempts
            SET attempt_count=3,
                last_error='business_tax_id_required: a VAT ID is required',
                next_attempt_at=NOW() + INTERVAL '6 hours'
          WHERE subscription_id=$1`,
        [subscription_id],
      );
      await expect(alertDelayedSubscriptionRenewals()).resolves.toBe(alerted);
    },
  );
});
