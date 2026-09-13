import { randomUUID } from "node:crypto";
import { before, after, getPool } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { listSources } from "@cocalc/server/conat/api/compute-funding";
import { notifyLowCourseCredit } from "./course-credit";
import { runLowCreditNotificationPass } from "./low-credit";
import { lowCreditThreshold } from "@cocalc/util/compute-notifications";

jest.mock("@cocalc/server/conat/api/compute-funding", () => ({
  listSources: jest.fn(),
}));
const discover = listSources as jest.Mock;
let source: any;
let clock: number;
beforeAll(async () => {
  await before({ noConat: true });
}, 30000);
afterAll(after);
beforeEach(() => {
  clock = Date.now() - 60_000;
  source = {
    pool_id: randomUUID(),
    grant_id: randomUUID(),
    label: "Maths",
    state: "active",
    pool_state: "active",
    available_usd: "5.00",
    starts_at: new Date(Date.now() - 3600000).toISOString(),
    ends_at: new Date(Date.now() + 3600000).toISOString(),
  };
  discover.mockReset().mockImplementation(async () => ({
    as_of: new Date((clock += 10)).toISOString(),
    sources: [{ ...source }],
  }));
});
async function account(
  settings: object = { low_course_credit_notifications: true },
  bay = getConfiguredBayId(),
) {
  const id = randomUUID();
  await getPool().query(
    "INSERT INTO accounts (account_id,home_bay_id,other_settings) VALUES ($1,$2,$3)",
    [id, bay, settings],
  );
  return id;
}
async function notices(id: string) {
  return (
    await getPool().query(
      `SELECT e.payload_json FROM notification_events e
    JOIN notification_targets t USING(event_id) WHERE t.target_account_id=$1`,
      [id],
    )
  ).rows;
}
it("uses a separate bounded opt-in for course credit", () => {
  expect(
    lowCreditThreshold({ low_credit_notifications: true }, "course"),
  ).toBeUndefined();
  expect(
    lowCreditThreshold({ low_course_credit_notifications: true }, "course"),
  ).toBe(10);
  expect(
    lowCreditThreshold(
      {
        low_course_credit_notifications: true,
        low_course_credit_threshold_usd: -1,
      },
      "course",
    ),
  ).toBeUndefined();
});
it("notifies once per downward crossing, not once per poll or day", async () => {
  const id = await account();
  expect(await notifyLowCourseCredit(id)).toBe(1);
  expect(await notifyLowCourseCredit(id)).toBe(0);
  source.available_usd = "10";
  expect(await notifyLowCourseCredit(id)).toBe(0);
  source.available_usd = "2";
  expect(await notifyLowCourseCredit(id)).toBe(1);
  const rows = await notices(id);
  expect(rows).toHaveLength(2);
  expect(rows[1].payload_json).toMatchObject({
    notice_type: "low_course_credit",
    grant_id: source.grant_id,
  });
  expect(
    rows.some((row) => row.payload_json.body_markdown.includes("$2.00 USD")),
  ).toBe(true);
  const { rows: deliveries } = await getPool().query(
    "SELECT * FROM notification_target_outbox WHERE target_account_id=$1",
    [id],
  );
  expect(deliveries).toHaveLength(2);
});
it("rechecks opt-in after discovery and never queries foreign-home accounts", async () => {
  expect(await notifyLowCourseCredit(await account({}))).toBe(0);
  expect(
    await notifyLowCourseCredit(await account(undefined, "other-bay")),
  ).toBe(0);
  expect(discover).not.toHaveBeenCalled();
  const id = await account();
  const original = discover.getMockImplementation()!;
  discover.mockImplementationOnce(async () => {
    await getPool().query(
      "UPDATE accounts SET other_settings='{}' WHERE account_id=$1",
      [id],
    );
    return await original();
  });
  expect(await notifyLowCourseCredit(id)).toBe(0);
  expect(await notices(id)).toHaveLength(0);
});
it("does not consume an alert on unknown or stale snapshots", async () => {
  const id = await account();
  discover.mockRejectedValueOnce(Error("payer unavailable"));
  await expect(notifyLowCourseCredit(id)).rejects.toThrow("payer unavailable");
  discover.mockResolvedValueOnce({
    as_of: new Date(0).toISOString(),
    sources: [source],
  });
  await expect(notifyLowCourseCredit(id)).rejects.toThrow("stale");
  source.available_usd = "NaN";
  await expect(notifyLowCourseCredit(id)).rejects.toThrow();
  source.available_usd = "1";
  expect(await notifyLowCourseCredit(id)).toBe(1);
});
it("ignores out-of-order observations and does not turn an expired grant into a credit warning", async () => {
  const id = await account();
  expect(await notifyLowCourseCredit(id)).toBe(1);
  const current = clock;
  clock -= 1000;
  source.available_usd = "100";
  expect(await notifyLowCourseCredit(id)).toBe(0);
  clock = current;
  source.available_usd = "1";
  expect(await notifyLowCourseCredit(id)).toBe(0);
  source.grant_id = randomUUID();
  source.ends_at = new Date(0).toISOString();
  expect(await notifyLowCourseCredit(id)).toBe(0);
});
it("is connected to the existing notification maintenance pass", async () => {
  const id = await account();
  await runLowCreditNotificationPass();
  expect(await notices(id)).toHaveLength(1);
});
(process.env.COCALC_TEST_USE_PGLITE ? it.skip : it)(
  "deduplicates simultaneous workers using the account rehome fence",
  async () => {
    const id = await account();
    const results = await Promise.all([
      notifyLowCourseCredit(id),
      notifyLowCourseCredit(id),
    ]);
    expect(results.sort()).toEqual([0, 1]);
    expect(await notices(id)).toHaveLength(1);
  },
);
