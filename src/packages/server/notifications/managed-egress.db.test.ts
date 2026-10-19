/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { before, after, getPool } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import { notifyManagedEgressLimit } from "./managed-egress";

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: jest.fn(),
}));
const directory = getClusterAccountsByIds as jest.Mock;

beforeAll(async () => {
  await before({ noConat: true });
}, 30000);
afterAll(after);

async function account(home_bay_id: string) {
  const account_id = randomUUID();
  await getPool().query(
    "INSERT INTO accounts (account_id,home_bay_id) VALUES ($1,$2)",
    [account_id, home_bay_id],
  );
  directory.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ account_id: id, home_bay_id })),
  );
  return account_id;
}

const blocked = (account_id: string) => ({
  account_id,
  pool: "shared" as const,
  window: "7d" as const,
  used: 2100,
  limit: 2000,
  blocked: true,
});

it("addresses the notice to the account's home bay when another bay evaluates the policy", async () => {
  // the project's host is owned by this bay; the account lives on another
  const account_id = await account("other-home-bay");
  expect(getConfiguredBayId()).not.toBe("other-home-bay");
  expect(await notifyManagedEgressLimit(blocked(account_id))).toBe(true);
  const { rows } = await getPool().query(
    `SELECT t.target_home_bay_id, o.target_home_bay_id AS outbox_home,
            e.source_bay_id, e.payload_json
       FROM notification_targets t
       JOIN notification_events e USING(event_id)
       JOIN notification_target_outbox o
         ON o.target_account_id=t.target_account_id
      WHERE t.target_account_id=$1`,
    [account_id],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    target_home_bay_id: "other-home-bay",
    outbox_home: "other-home-bay",
    source_bay_id: getConfiguredBayId(),
  });
  expect(rows[0].payload_json).toMatchObject({
    notice_type: "managed_egress_blocked",
    title: "Managed network traffic limit reached",
  });
  // deduplicated on the evaluating bay for a day
  expect(await notifyManagedEgressLimit(blocked(account_id))).toBe(false);
  await getPool().query(
    "UPDATE notification_targets SET created_at=NOW()-interval '25 hours' WHERE target_account_id=$1",
    [account_id],
  );
  expect(await notifyManagedEgressLimit(blocked(account_id))).toBe(true);
});

it("delivers locally for accounts homed on this bay, and skips unknown accounts", async () => {
  const account_id = await account(getConfiguredBayId());
  expect(await notifyManagedEgressLimit(blocked(account_id))).toBe(true);
  const { rows } = await getPool().query(
    "SELECT target_home_bay_id FROM notification_targets WHERE target_account_id=$1",
    [account_id],
  );
  expect(rows).toEqual([{ target_home_bay_id: getConfiguredBayId() }]);
  directory.mockResolvedValue([]);
  expect(await notifyManagedEgressLimit(blocked(randomUUID()))).toBe(false);
});
