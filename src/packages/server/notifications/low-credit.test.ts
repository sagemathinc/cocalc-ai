import { randomUUID } from "node:crypto";
import { before, after, getPool } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import getSpendableBalance from "@cocalc/server/purchases/get-spendable-balance";
import { lowCreditThreshold } from "@cocalc/util/compute-notifications";
import { notifyLowCredit } from "./low-credit";

jest.mock("@cocalc/server/purchases/get-spendable-balance", () => ({
  __esModule: true,
  default: jest.fn(),
}));
const balance = getSpendableBalance as jest.Mock;
beforeAll(async () => {
  await before({ noConat: true });
}, 30000);
afterAll(after);
beforeEach(() => balance.mockReset().mockResolvedValue("5.00"));
async function account(
  settings: object = { low_credit_notifications: true },
  bay = getConfiguredBayId(),
) {
  const id = randomUUID();
  await getPool().query(
    "INSERT INTO accounts (account_id,home_bay_id,other_settings) VALUES ($1,$2,$3)",
    [id, bay, settings],
  );
  return id;
}
it("requires opt-in and a bounded numeric threshold", () => {
  expect(lowCreditThreshold({})).toBeUndefined();
  expect(lowCreditThreshold({ low_credit_notifications: true })).toBe(10);
  for (const value of [0, -1, 1001, "10", NaN, Infinity]) {
    expect(
      lowCreditThreshold({
        low_credit_notifications: true,
        low_credit_threshold_usd: value,
      }),
    ).toBeUndefined();
  }
});
it("emits a durable personal-credit notice at most once per day", async () => {
  const id = await account();
  expect(await notifyLowCredit(id)).toBe(true);
  expect(await notifyLowCredit(id)).toBe(false);
  expect(balance).toHaveBeenCalledTimes(1);
  expect(balance).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id: id,
      client: expect.anything(),
      noSave: true,
    }),
  );
  const { rows } = await getPool().query(
    "SELECT e.payload_json AS summary_json FROM notification_events e JOIN notification_targets t USING(event_id) WHERE t.target_account_id=$1",
    [id],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].summary_json).toMatchObject({
    title: "Personal credit is low",
    action_link: "/hosts?tab=vms",
    notice_type: "low_personal_credit",
  });
  expect(rows[0].summary_json.body_markdown).toContain("$5.00 USD");
  await getPool().query(
    "UPDATE notification_targets SET created_at=NOW()-interval '25 hours' WHERE target_account_id=$1",
    [id],
  );
  expect(await notifyLowCredit(id)).toBe(true);
});
it("does not inspect opted-out or remote-home accounts and does not alert above threshold", async () => {
  expect(await notifyLowCredit(await account({}))).toBe(false);
  expect(
    await notifyLowCredit(
      await account({ low_credit_notifications: true }, "other-bay"),
    ),
  ).toBe(false);
  expect(balance).not.toHaveBeenCalled();
  balance.mockResolvedValue("10");
  expect(await notifyLowCredit(await account())).toBe(false);
});
it.each([NaN, Infinity, "NaN", "Infinity"])(
  "rejects an unknown balance %s without consuming the next notification",
  async (value) => {
    const id = await account();
    balance.mockResolvedValueOnce(value);
    await expect(notifyLowCredit(id)).rejects.toThrow();
    expect(await notifyLowCredit(id)).toBe(true);
  },
);
it("retries a failed spendable-balance read without fabricating zero credit", async () => {
  const id = await account();
  balance.mockRejectedValueOnce(new Error("balance unavailable"));
  await expect(notifyLowCredit(id)).rejects.toThrow("balance unavailable");
  expect(await notifyLowCredit(id)).toBe(true);
});

(process.env.COCALC_TEST_USE_PGLITE ? it.skip : it)(
  "deduplicates simultaneous notification workers",
  async () => {
    const id = await account();
    const results = await Promise.all([
      notifyLowCredit(id),
      notifyLowCredit(id),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(balance).toHaveBeenCalledTimes(1);
  },
);
