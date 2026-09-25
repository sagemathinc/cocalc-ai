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
import {
  cancelOpenSubscriptionRenewalAttempts,
  claimDueSubscriptionRenewalAttempts,
  scheduleMissingSubscriptionRenewalAttempts,
  scheduleSubscriptionRenewalAttempt,
} from "./subscription-renewal-attempts";

beforeAll(async () => {
  await before({ noConat: true });
}, 15_000);
afterAll(after);

describe("durable subscription renewal attempts", () => {
  beforeEach(async () => {
    await getPool().query("DELETE FROM subscription_renewal_attempts");
    await getPool().query("DELETE FROM subscriptions");
    await getPool().query("DELETE FROM billing_authority_account_fences");
  });

  it("schedules exactly one attempt without making it claimable early", async () => {
    const account_id = uuid();
    const end = dayjs().add(20, "minute").toDate();
    await createTestAccount(account_id);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      { end },
    );

    const first = await scheduleSubscriptionRenewalAttempt({
      account_id,
      subscription_id,
    });
    const second = await scheduleSubscriptionRenewalAttempt({
      account_id,
      subscription_id,
    });
    const { rows } = await getPool().query(
      `SELECT *
         FROM subscription_renewal_attempts
        WHERE subscription_id=$1`,
      [subscription_id],
    );

    expect(first).toBe(rows[0].id);
    expect(second).toBe(first);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("scheduled");
    expect(new Date(rows[0].not_before).getTime()).toBe(end.getTime());
    expect(new Date(rows[0].target_period_end).getTime()).toBeGreaterThan(
      end.getTime(),
    );
    await expect(
      claimDueSubscriptionRenewalAttempts({ limit: 10 }),
    ).resolves.toEqual([]);
  });

  it("claims due attempts oldest first and only once per lease", async () => {
    const oldestAccount = uuid();
    const newestAccount = uuid();
    await createTestAccount(oldestAccount);
    await createTestAccount(newestAccount);
    const oldest = await createTestMembershipSubscription(oldestAccount, {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(2, "minute").toDate(),
    });
    const newest = await createTestMembershipSubscription(newestAccount, {
      start: dayjs().subtract(1, "month").toDate(),
      end: dayjs().subtract(1, "minute").toDate(),
    });

    const firstClaim = await claimDueSubscriptionRenewalAttempts({ limit: 1 });
    const secondClaim = await claimDueSubscriptionRenewalAttempts({
      limit: 10,
    });
    const thirdClaim = await claimDueSubscriptionRenewalAttempts({ limit: 10 });

    expect(firstClaim.map(({ subscription_id }) => subscription_id)).toEqual([
      oldest.subscription_id,
    ]);
    expect(secondClaim.map(({ subscription_id }) => subscription_id)).toEqual([
      newest.subscription_id,
    ]);
    expect(thirdClaim).toEqual([]);
    expect(firstClaim[0].state).toBe("processing");
    expect(firstClaim[0].attempt_count).toBe(1);
  });

  it("claims due attempts when centralized billing omits the legacy bay predicate", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        start: dayjs().subtract(1, "month").toDate(),
        end: dayjs().subtract(1, "minute").toDate(),
      },
    );
    const previous = process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
    try {
      const claimed = await claimDueSubscriptionRenewalAttempts({ limit: 10 });
      expect(claimed.map(({ subscription_id }) => subscription_id)).toContain(
        subscription_id,
      );
    } finally {
      if (previous == null) {
        delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
      } else {
        process.env.COCALC_BILLING_AUTHORITY_ENABLED = previous;
      }
    }
  });

  it("cancels only the specified subscription's open attempt", async () => {
    const firstAccount = uuid();
    const secondAccount = uuid();
    await createTestAccount(firstAccount);
    await createTestAccount(secondAccount);
    const first = await createTestMembershipSubscription(firstAccount);
    const second = await createTestMembershipSubscription(secondAccount);

    await cancelOpenSubscriptionRenewalAttempts({
      account_id: firstAccount,
      subscription_id: first.subscription_id,
      reason: "membership changed",
    });

    const { rows } = await getPool().query(
      `SELECT subscription_id, state
         FROM subscription_renewal_attempts
        WHERE subscription_id IN ($1,$2)
        ORDER BY subscription_id`,
      [first.subscription_id, second.subscription_id],
    );
    expect(rows).toEqual([
      { subscription_id: first.subscription_id, state: "canceled" },
      { subscription_id: second.subscription_id, state: "scheduled" },
    ]);
  });

  it("reschedules a canceled same-period attempt with current terms", async () => {
    const account_id = uuid();
    const end = dayjs().add(20, "minute").toDate();
    await createTestAccount(account_id);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      { cost: 10, end, interval: "month" },
    );
    const { rows: original } = await getPool().query(
      `SELECT id
         FROM subscription_renewal_attempts
        WHERE subscription_id=$1`,
      [subscription_id],
    );

    await cancelOpenSubscriptionRenewalAttempts({
      account_id,
      subscription_id,
      reason: "membership changed",
    });
    await getPool().query(
      `UPDATE subscriptions
          SET cost=120,
              interval='year',
              metadata=jsonb_set(metadata, '{renewal_interval}', '"year"')
        WHERE id=$1`,
      [subscription_id],
    );
    const rescheduled = await scheduleSubscriptionRenewalAttempt({
      account_id,
      subscription_id,
    });

    const { rows } = await getPool().query(
      `SELECT id, state, amount, attempt_count, last_error,
              target_period_end
         FROM subscription_renewal_attempts
        WHERE subscription_id=$1`,
      [subscription_id],
    );
    expect(rescheduled).toBe(original[0].id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: original[0].id,
      state: "scheduled",
      amount: "120.0000000000",
      attempt_count: 0,
      last_error: null,
    });
    expect(dayjs(rows[0].target_period_end).diff(dayjs(end), "month")).toBe(12);
  });

  it("cancels an attempt whose subscription period changed concurrently", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { subscription_id } =
      await createTestMembershipSubscription(account_id);
    await getPool().query(
      `UPDATE subscriptions
          SET current_period_end=current_period_end + INTERVAL '1 day'
        WHERE id=$1`,
      [subscription_id],
    );

    await scheduleMissingSubscriptionRenewalAttempts();

    const { rows } = await getPool().query(
      `SELECT state, last_error
         FROM subscription_renewal_attempts
        WHERE subscription_id=$1
        ORDER BY period_end`,
      [subscription_id],
    );
    expect(rows).toEqual([
      {
        last_error: "Subscription is no longer active for this period",
        state: "canceled",
      },
      { last_error: null, state: "scheduled" },
    ]);
  });

  it("cancels scheduled renewal work when account billing is frozen", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        start: dayjs().subtract(1, "month").toDate(),
        end: dayjs().subtract(1, "minute").toDate(),
      },
    );
    await getPool().query(
      `INSERT INTO billing_authority_account_fences
         (account_id, frozen, reason, generation)
       VALUES ($1, TRUE, 'test quarantine', 1)`,
      [account_id],
    );

    await scheduleMissingSubscriptionRenewalAttempts();

    await expect(
      claimDueSubscriptionRenewalAttempts({ limit: 10 }),
    ).resolves.toEqual([]);
    const { rows } = await getPool().query(
      `SELECT state FROM subscription_renewal_attempts
        WHERE subscription_id=$1`,
      [subscription_id],
    );
    expect(rows).toEqual([{ state: "canceled" }]);
  });

  it("enables split funding only for predeployment attempts never processed", async () => {
    const safeAccount = uuid();
    const attemptedAccount = uuid();
    await createTestAccount(safeAccount);
    await createTestAccount(attemptedAccount);
    const safe = await createTestMembershipSubscription(safeAccount);
    const attempted = await createTestMembershipSubscription(attemptedAccount);
    await getPool().query(
      `UPDATE subscription_renewal_attempts
          SET funding_version=NULL
        WHERE subscription_id IN ($1,$2)`,
      [safe.subscription_id, attempted.subscription_id],
    );
    await getPool().query(
      `UPDATE subscription_renewal_attempts
          SET attempt_count=1,
              last_attempt_at=NOW() - INTERVAL '5 minutes'
        WHERE subscription_id=$1`,
      [attempted.subscription_id],
    );

    await scheduleMissingSubscriptionRenewalAttempts();

    const { rows } = await getPool().query(
      `SELECT subscription_id, funding_version
         FROM subscription_renewal_attempts
        WHERE subscription_id IN ($1,$2)
        ORDER BY subscription_id`,
      [safe.subscription_id, attempted.subscription_id],
    );
    expect(
      Object.fromEntries(
        rows.map(({ subscription_id, funding_version }) => [
          subscription_id,
          funding_version,
        ]),
      ),
    ).toEqual({
      [safe.subscription_id]: 1,
      [attempted.subscription_id]: null,
    });
  });
});

describe("personal membership uniqueness", () => {
  it("rejects a second non-canceled membership at the database boundary", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { subscription_id } =
      await createTestMembershipSubscription(account_id);

    await expect(
      getPool().query(
        `INSERT INTO subscriptions
          (account_id, created, cost, interval, current_period_start,
           current_period_end, latest_purchase_id, status, metadata)
         SELECT account_id, NOW(), cost, interval, current_period_start,
                current_period_end, latest_purchase_id, 'active', metadata
           FROM subscriptions
          WHERE id=$1`,
        [subscription_id],
      ),
    ).rejects.toThrow(/duplicate key|subscriptions_one_renewable/i);
  });
});
