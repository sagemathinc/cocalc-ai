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
          SET customer_action_required_at=NOW()
        WHERE subscription_id = ANY($1)`,
      [[waiting.subscription_id, expired.subscription_id]],
    );

    // Still open after the grace period is an operational problem.
    await expect(alertDelayedSubscriptionRenewals()).resolves.toBe(1);
    const body = mockAdminAlert.mock.calls[0][0].body;
    expect(body).toContain(expiredAccount);
    expect(body).not.toContain(waitingAccount);
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
});
