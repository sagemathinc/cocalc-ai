/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { byHostId, conditionAlert, conditionCleared } from "./condition-alert";

const adminAlert = jest.fn(async (_opts: any) => 1);
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (opts: any) => adminAlert(opts),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("condition alerts", () => {
  beforeAll(async () => {
    await syncSchema({ admin_alert_state: SCHEMA.admin_alert_state });
  });

  beforeEach(async () => {
    adminAlert.mockClear();
    await getPool().query("DELETE FROM admin_alert_state");
  });

  const alert = () =>
    conditionAlert({ subject: "Disk", body: "host-1", reminderMinutes: 360 });
  const dedup = () => adminAlert.mock.calls.at(-1)![0].dedupMinutes;

  test("an ongoing condition is deduplicated for the reminder interval", async () => {
    await alert();
    await alert();
    expect(adminAlert).toHaveBeenCalledTimes(2);
    expect(dedup()).toBe(360);
  });

  test("a recurrence after the condition cleared is not a duplicate", async () => {
    await alert();
    await conditionCleared("Disk");
    await alert();
    // Only alerts sent since the condition cleared count as duplicates.
    expect(dedup()).toBeGreaterThanOrEqual(0);
    expect(dedup()).toBeLessThan(1);
    // Backdate the clearance: the window grows, capped at the reminder.
    await getPool().query(
      "UPDATE admin_alert_state SET cleared_at=now()-interval '30 minutes'",
    );
    await alert();
    expect(dedup()).toBeGreaterThan(29);
    expect(dedup()).toBeLessThan(31);
    await getPool().query(
      "UPDATE admin_alert_state SET cleared_at=now()-interval '2 days'",
    );
    await alert();
    expect(dedup()).toBe(360);
  });

  test("clearing records the time only when the condition was active", async () => {
    await conditionCleared("Disk");
    expect(
      (await getPool().query("SELECT * FROM admin_alert_state")).rows,
    ).toEqual([]);
    await alert();
    await conditionCleared("Disk");
    const first = (
      await getPool().query("SELECT cleared_at FROM admin_alert_state")
    ).rows[0].cleared_at;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await conditionCleared("Disk");
    const second = (
      await getPool().query("SELECT cleared_at FROM admin_alert_state")
    ).rows[0].cleared_at;
    expect(second).toEqual(first);
  });
});

test("hosts are listed in a stable order", () => {
  expect(
    byHostId([{ id: "c" }, { id: "a" }, { id: "b" }]).map(({ id }) => id),
  ).toEqual(["a", "b", "c"]);
});
