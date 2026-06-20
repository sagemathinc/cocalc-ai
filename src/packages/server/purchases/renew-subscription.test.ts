/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// test renew-subscriptions

import { test } from "./renew-subscription";
import { uuid } from "@cocalc/util/misc";
import renewSubscription, { getSubscription } from "./renew-subscription";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "./test-data";
import createCredit from "./create-credit";
import dayjs from "dayjs";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("adding and subtracting month and year to a date", () => {
  it("adds a month to Feb 2 and gets March 2", () => {
    expect(
      test
        .addInterval(new Date("2023-02-02T00:00:00.000Z"), "month")
        .toISOString(),
    ).toBe("2023-03-02T00:00:00.000Z");
  });

  it("adds a year to Feb 2 and gets Feb 2 a year later", () => {
    expect(
      test
        .addInterval(new Date("2023-02-02T00:00:00.000Z"), "year")
        .toISOString(),
    ).toBe("2024-02-02T00:00:00.000Z");
  });

  it("subtracts a month from March 2 and gets Feb 2", () => {
    expect(
      test
        .subtractInterval(new Date("2023-03-02T00:00:00.000Z"), "month")
        .toISOString(),
    ).toBe("2023-02-02T00:00:00.000Z");
  });
  it("subtracts a year to Feb 2 and gets Feb 2 a year earlier", () => {
    expect(
      test
        .subtractInterval(new Date("2023-02-02T00:00:00.000Z"), "year")
        .toISOString(),
    ).toBe("2022-02-02T00:00:00.000Z");
  });
});

describe("membership subscription renewal", () => {
  const account_id = uuid();
  let subscription_id = -1;
  let original_end: Date | undefined;
  let membershipClass = "member";
  let interval: "month" | "year" = "month";
  it("creates an account and membership subscription", async () => {
    await createTestAccount(account_id);
    const created = await createTestMembershipSubscription(account_id, {
      class: "member",
      status: "unpaid",
    });
    await createCredit({
      account_id,
      amount: created.cost,
      description: {
        description: "test renewal funding",
        purpose: "test",
      },
    });
    subscription_id = created.subscription_id;
    original_end = created.end;
    membershipClass = created.membershipClass;
    interval = created.interval;
  });

  it("renews membership subscription and records a membership purchase", async () => {
    const purchase_id = await renewSubscription({
      account_id,
      subscription_id,
    });
    const sub = await getSubscription(subscription_id);
    const expectedEnd =
      interval == "month"
        ? dayjs(original_end).add(1, "month").toDate()
        : dayjs(original_end).add(1, "year").toDate();
    expect(
      Math.abs(sub.current_period_end.valueOf() - expectedEnd.valueOf()),
    ).toBeLessThan(1000 * 60 * 10);
    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT service, description FROM purchases WHERE id=$1",
      [purchase_id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].service).toBe("membership");
    expect(rows[0].description?.type).toBe("membership");
    expect(rows[0].description?.class).toBe(membershipClass);
  });

  it("rejects renewal when the subscription is already active", async () => {
    const activeAccount = uuid();
    await createTestAccount(activeAccount);
    const { subscription_id, cost } = await createTestMembershipSubscription(
      activeAccount,
      {
        status: "active",
      },
    );
    await createCredit({
      account_id: activeAccount,
      amount: cost,
      description: {
        description: "test renewal funding",
        purpose: "test",
      },
    });

    await expect(
      renewSubscription({ account_id: activeAccount, subscription_id }),
    ).rejects.toThrow("subscription is already active");
  });

  it("rejects unpaid renewal without enough account balance", async () => {
    const unpaidAccount = uuid();
    await createTestAccount(unpaidAccount);
    const { subscription_id } = await createTestMembershipSubscription(
      unpaidAccount,
      {
        status: "unpaid",
      },
    );

    await expect(
      renewSubscription({ account_id: unpaidAccount, subscription_id }),
    ).rejects.toThrow(/Please pay/);
  });
});
