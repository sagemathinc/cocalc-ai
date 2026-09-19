import { randomUUID } from "node:crypto";
import { before, after, getPool } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getOwnedPools } from "@cocalc/server/conat/api/compute-funding";
import { notifyLowSponsoredCompute } from "./sponsored-compute";
import { lowCreditThreshold } from "@cocalc/util/compute-notifications";

jest.mock("@cocalc/server/conat/api/compute-funding", () => ({
  getOwnedPools: jest.fn(),
}));

const discover = getOwnedPools as jest.Mock;
let pool: any;
let clock: number;
beforeAll(async () => await before({ noConat: true }), 30_000);
afterAll(after);
beforeEach(() => {
  clock = Date.now() - 60_000;
  pool = {
    id: randomUUID(),
    course_project_id: randomUUID(),
    state: "active",
    authorized_usd: "100",
    released_usd: "0",
    spent_usd: "86",
    reserved_usd: "5",
  };
  discover.mockReset().mockImplementation(async () => ({
    as_of: new Date((clock += 10)).toISOString(),
    pools: [{ ...pool }],
  }));
});

async function account(
  settings: object = {
    low_sponsored_compute_notifications: true,
    low_sponsored_compute_threshold_usd: 10,
  },
) {
  const id = randomUUID();
  await getPool().query(
    "INSERT INTO accounts (account_id,home_bay_id,other_settings) VALUES ($1,$2,$3)",
    [id, getConfiguredBayId(), settings],
  );
  return id;
}

async function notices(id: string) {
  return (
    await getPool().query(
      `SELECT e.payload_json FROM notification_events e
       JOIN notification_targets t USING(event_id)
       WHERE t.target_account_id=$1 ORDER BY e.created_at`,
      [id],
    )
  ).rows;
}

it("uses a separate bounded sponsored-compute opt-in", () => {
  expect(
    lowCreditThreshold({ low_course_credit_notifications: true }, "sponsored"),
  ).toBeUndefined();
  expect(
    lowCreditThreshold(
      { low_sponsored_compute_notifications: true },
      "sponsored",
    ),
  ).toBe(10);
  expect(
    lowCreditThreshold(
      {
        low_sponsored_compute_notifications: true,
        low_sponsored_compute_threshold_usd: 1_000_001,
      },
      "sponsored",
    ),
  ).toBeUndefined();
});

it("notifies once per pool threshold crossing and rearms above the threshold", async () => {
  const id = await account();
  expect(await notifyLowSponsoredCompute(id)).toBe(1);
  expect(await notifyLowSponsoredCompute(id)).toBe(0);
  pool.spent_usd = "80";
  pool.reserved_usd = "0";
  expect(await notifyLowSponsoredCompute(id)).toBe(0);
  pool.spent_usd = "91";
  expect(await notifyLowSponsoredCompute(id)).toBe(1);
  const rows = await notices(id);
  expect(rows).toHaveLength(2);
  expect(rows[1].payload_json).toMatchObject({
    notice_type: "low_sponsored_compute",
    pool_id: pool.id,
    course_project_id: pool.course_project_id,
  });
});

it("fails closed on stale snapshots and rechecks opt-in after discovery", async () => {
  const id = await account();
  discover.mockResolvedValueOnce({
    as_of: new Date(0).toISOString(),
    pools: [pool],
  });
  await expect(notifyLowSponsoredCompute(id)).rejects.toThrow("stale");
  const original = discover.getMockImplementation()!;
  discover.mockImplementationOnce(async () => {
    await getPool().query(
      "UPDATE accounts SET other_settings='{}' WHERE account_id=$1",
      [id],
    );
    return await original();
  });
  expect(await notifyLowSponsoredCompute(id)).toBe(0);
  expect(await notices(id)).toHaveLength(0);
});

(process.env.COCALC_TEST_USE_PGLITE ? it.skip : it)(
  "deduplicates simultaneous account-home workers",
  async () => {
    const id = await account();
    const results = await Promise.all([
      notifyLowSponsoredCompute(id),
      notifyLowSponsoredCompute(id),
    ]);
    expect(results.sort()).toEqual([0, 1]);
    expect(await notices(id)).toHaveLength(1);
  },
);
