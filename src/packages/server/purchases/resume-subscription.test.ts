/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockSend = jest.fn();
const mockAdminAlert = jest.fn();

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  name: jest.fn().mockResolvedValue("User"),
  support: jest.fn().mockResolvedValue("Support"),
  url: jest.fn(async (path) => path),
}));

jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAdminAlert(...args),
}));

import dayjs from "dayjs";

import { uuid } from "@cocalc/util/misc";
import { before, after } from "@cocalc/server/test";
import createCredit from "./create-credit";
import resumeSubscription from "./resume-subscription";
import { getSubscription } from "./renew-subscription";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "./test-data";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("membership subscription resume", () => {
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue(undefined);
    mockAdminAlert.mockReset().mockResolvedValue(undefined);
  });

  it("rejects expired resume without enough account balance", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        start: dayjs().subtract(2, "months").toDate(),
        end: dayjs().subtract(1, "day").toDate(),
        status: "canceled",
      },
    );

    await expect(
      resumeSubscription({ account_id, subscription_id }),
    ).rejects.toThrow(/Please pay/);
  });

  it("resumes an expired subscription when account balance covers the cost", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { cost, subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        start: dayjs().subtract(2, "months").toDate(),
        end: dayjs().subtract(1, "day").toDate(),
        status: "canceled",
      },
    );
    await createCredit({
      account_id,
      amount: cost,
      description: {
        description: "test resume funding",
        purpose: "test",
      },
    });

    const purchase_id = await resumeSubscription({
      account_id,
      subscription_id,
    });

    expect(purchase_id).toBeGreaterThan(0);
    const subscription = await getSubscription(subscription_id);
    expect(subscription.status).toBe("active");
    expect(subscription.current_period_end.valueOf()).toBeGreaterThan(
      Date.now(),
    );
  });
});
