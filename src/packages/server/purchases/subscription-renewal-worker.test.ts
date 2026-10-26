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

const mockCreateSubscriptionPayment = jest.fn();
const mockSend = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({
    site_name: "CoCalc",
    subscription_maintenance: { renewal_mode: "active" },
  }),
}));
jest.mock("./stripe/create-subscription-payment", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreateSubscriptionPayment(...args),
  processSubscriptionRenewalFailure: jest.fn(),
}));
jest.mock("@cocalc/server/purchases/billing-authority/context", () => ({
  registerBillingAuthorityAccount: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  support: async () => "",
  url: async (path: string) => path,
}));

import maintainSubscriptionRenewals from "./subscription-renewal-worker";
import {
  RENEWAL_ATTEMPT_RETRY_MS,
  RENEWAL_CUSTOMER_ACTION_RECHECK_MS,
} from "./subscription-renewal-attempts";

beforeAll(async () => {
  await before({ noConat: true });
}, 15_000);
afterAll(after);

async function dueRenewal() {
  const account_id = uuid();
  await createTestAccount(account_id);
  const { subscription_id } = await createTestMembershipSubscription(
    account_id,
    {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(1, "hour").toDate(),
    },
  );
  return { account_id, subscription_id };
}

async function attemptOf(subscription_id: number) {
  const { rows } = await getPool().query(
    `SELECT *, EXTRACT(EPOCH FROM (next_attempt_at - NOW())) * 1000 AS wait_ms
       FROM subscription_renewal_attempts WHERE subscription_id=$1`,
    [subscription_id],
  );
  return rows[0];
}

describe("subscription renewal worker", () => {
  beforeEach(async () => {
    await getPool().query("DELETE FROM subscription_renewal_attempts");
    await getPool().query("DELETE FROM subscriptions");
    mockCreateSubscriptionPayment.mockReset();
    mockSend.mockReset();
  });

  it("waits for the customer when the business tax ID check refuses a renewal", async () => {
    const { subscription_id } = await dueRenewal();
    mockCreateSubscriptionPayment.mockRejectedValue(
      Object.assign(new Error("a VAT ID is required"), {
        code: "business_tax_id_required",
      }),
    );

    await maintainSubscriptionRenewals({ max_attempts: 1 });

    const attempt = await attemptOf(subscription_id);
    expect(mockCreateSubscriptionPayment).toHaveBeenCalledTimes(1);
    // deferred like a declined card, rechecked hours later, not every minute
    expect(attempt.state).toBe("scheduled");
    expect(attempt.customer_action_required_at).not.toBeNull();
    expect(Number(attempt.wait_ms)).toBeGreaterThan(
      RENEWAL_CUSTOMER_ACTION_RECHECK_MS - 60_000,
    );
    // the check already sent its own (weekly) notice: no second notice
    expect(attempt.customer_action_notified_at).not.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("retries other failures with backoff", async () => {
    const { subscription_id } = await dueRenewal();
    mockCreateSubscriptionPayment.mockRejectedValue(new Error("stripe down"));

    await maintainSubscriptionRenewals({ max_attempts: 1 });

    const attempt = await attemptOf(subscription_id);
    expect(attempt.state).toBe("processing");
    expect(attempt.customer_action_required_at).toBeNull();
    expect(Number(attempt.wait_ms)).toBeGreaterThan(
      RENEWAL_ATTEMPT_RETRY_MS - 10_000,
    );
    expect(Number(attempt.wait_ms)).toBeLessThanOrEqual(
      RENEWAL_ATTEMPT_RETRY_MS,
    );
  });
});
