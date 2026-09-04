/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool, {
  getClient,
  initEphemeralDatabase,
  isPgliteEnabled,
  type Client,
} from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  ensureSubscriptionStatusSchema,
  SUBSCRIPTION_STATUS_CONSTRAINT,
  SUBSCRIPTION_STATUS_SCHEMA_LOCK,
  subscriptionStatusSchemaNeedsSync,
} from "./subscription-status";

const realPostgresIt = isPgliteEnabled() ? it.skip : it;

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 15_000);

afterAll(async () => {
  await testCleanup();
});

describe("personal subscription statuses", () => {
  it("normalizes historical nonrenewing states before enforcing the constraint", async () => {
    const pool = getPool();
    const client = await pool.connect();
    const accountIds = [uuid(), uuid(), uuid(), uuid(), uuid()];
    const activeAccountId = accountIds[3];
    const canceledAccountId = accountIds[4];
    try {
      await client.query(
        `ALTER TABLE subscriptions DROP CONSTRAINT ${SUBSCRIPTION_STATUS_CONSTRAINT}`,
      );
      await expect(subscriptionStatusSchemaNeedsSync(client)).resolves.toBe(
        true,
      );
      await client.query(
        `INSERT INTO subscriptions
           (account_id, status, canceled_reason, payment)
         VALUES
           ($1, 'unpaid', NULL, '{"status":"active"}'::jsonb),
           ($2, 'past_due', 'Existing audit reason', NULL),
           ($3, NULL, NULL, NULL),
           ($4, 'active', NULL, '{"status":"paid"}'::jsonb),
           ($5, 'canceled', 'User selected Free', NULL)`,
        accountIds,
      );
      await client.query(
        `UPDATE subscriptions
            SET metadata=jsonb_build_object(
              'type', 'membership',
              'class', 'basic',
              'pending_plan_change', jsonb_build_object(
                'kind', 'downgrade',
                'previous_class', 'standard',
                'previous_interval', 'year',
                'scheduled_at', '2026-09-01T00:00:00.000Z'
              )
            )
          WHERE account_id=$1`,
        [activeAccountId],
      );

      await ensureSubscriptionStatusSchema(client);
      await expect(subscriptionStatusSchemaNeedsSync(client)).resolves.toBe(
        false,
      );

      const { rows } = await client.query(
        `SELECT status, canceled_at, canceled_reason, payment
           FROM subscriptions
          WHERE account_id=ANY($1::uuid[])
          ORDER BY account_id`,
        [accountIds],
      );
      expect(rows).toHaveLength(5);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "canceled",
            canceled_at: expect.any(Date),
            canceled_reason: "Legacy unpaid subscription state retired",
            payment: { status: "canceled" },
          }),
          expect.objectContaining({
            status: "canceled",
            canceled_at: expect.any(Date),
            canceled_reason: "Existing audit reason",
          }),
          expect.objectContaining({
            status: "canceled",
            canceled_at: expect.any(Date),
            canceled_reason: "Legacy subscription without status retired",
          }),
          expect.objectContaining({
            status: "active",
            canceled_at: null,
            canceled_reason: null,
            payment: { status: "paid" },
          }),
          expect.objectContaining({
            status: "canceled",
            canceled_at: null,
            canceled_reason: "User selected Free",
          }),
        ]),
      );

      const { rows: activeRows } = await client.query(
        `SELECT metadata
           FROM subscriptions
          WHERE account_id=$1`,
        [activeAccountId],
      );
      expect(activeRows[0]?.metadata?.pending_plan_change).toMatchObject({
        kind: "downgrade",
        previous_class: "standard",
      });

      const { rows: canceledRows } = await client.query(
        `SELECT status
           FROM subscriptions
          WHERE account_id=$1`,
        [canceledAccountId],
      );
      expect(canceledRows).toEqual([{ status: "canceled" }]);
    } finally {
      await client.query(
        "DELETE FROM subscriptions WHERE account_id=ANY($1::uuid[])",
        [accountIds],
      );
      client.release();
    }
  });

  it("rejects subscription states outside active and canceled", async () => {
    await expect(
      getPool().query(
        "INSERT INTO subscriptions (account_id, status) VALUES ($1, 'unpaid')",
        [uuid()],
      ),
    ).rejects.toThrow();
  });

  it("rechecks the constraint after acquiring the migration lock", async () => {
    let stateReads = 0;
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT EXISTS")) {
        stateReads += 1;
        return {
          rows: [
            stateReads === 1
              ? { exists: false, validated: false }
              : { exists: true, validated: true },
          ],
        };
      }
      return { rows: [] };
    });

    await ensureSubscriptionStatusSchema({
      query,
    } as unknown as Pick<Client, "query">);

    const statements = query.mock.calls.map(([sql]) => sql);
    const stateChecks = statements
      .map((sql, index) => (sql.includes("SELECT EXISTS") ? index : -1))
      .filter((index) => index >= 0);
    const lockIndex = statements.findIndex((sql) =>
      sql.includes("pg_advisory_xact_lock"),
    );
    expect(stateChecks).toHaveLength(2);
    expect(lockIndex).toBeGreaterThan(stateChecks[0]);
    expect(lockIndex).toBeLessThan(stateChecks[1]);
    expect(statements.some((sql) => sql.includes("UPDATE subscriptions"))).toBe(
      false,
    );
    expect(statements.some((sql) => sql.includes("ADD CONSTRAINT"))).toBe(
      false,
    );
    expect(statements.at(-1)).toBe("COMMIT");
  });

  realPostgresIt("serializes concurrent constraint creation", async () => {
    const blocker = getClient();
    const firstClient = getClient();
    const secondClient = getClient();
    await Promise.all([
      blocker.connect(),
      firstClient.connect(),
      secondClient.connect(),
    ]);
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    let lockHeld = false;
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtext($1))", [
        SUBSCRIPTION_STATUS_SCHEMA_LOCK,
      ]);
      lockHeld = true;
      await blocker.query(
        `ALTER TABLE subscriptions
           DROP CONSTRAINT ${SUBSCRIPTION_STATUS_CONSTRAINT}`,
      );

      const firstPid = (
        await firstClient.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        )
      ).rows[0].pid;
      const secondPid = (
        await secondClient.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        )
      ).rows[0].pid;
      first = ensureSubscriptionStatusSchema(firstClient);
      second = ensureSubscriptionStatusSchema(secondClient);

      for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await blocker.query<{ waiting: number }>(
          `SELECT COUNT(*)::int AS waiting
             FROM pg_locks
            WHERE locktype='advisory'
              AND NOT granted
              AND pid=ANY($1::int[])`,
          [[firstPid, secondPid]],
        );
        if (rows[0]?.waiting === 2) break;
        if (attempt === 99) {
          throw new Error("concurrent schema synchronizers did not queue");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [
        SUBSCRIPTION_STATUS_SCHEMA_LOCK,
      ]);
      lockHeld = false;
      await Promise.all([first, second]);

      const { rows } = await blocker.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM pg_constraint
          WHERE conname=$1
            AND conrelid='subscriptions'::regclass
            AND convalidated`,
        [SUBSCRIPTION_STATUS_CONSTRAINT],
      );
      expect(rows).toEqual([{ count: 1 }]);
    } finally {
      if (lockHeld) {
        await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [
          SUBSCRIPTION_STATUS_SCHEMA_LOCK,
        ]);
      }
      await Promise.allSettled([first, second].filter(Boolean));
      if (await subscriptionStatusSchemaNeedsSync(blocker)) {
        await ensureSubscriptionStatusSchema(blocker);
      }
      await Promise.allSettled([
        blocker.end(),
        firstClient.end(),
        secondClient.end(),
      ]);
    }
  });
});
