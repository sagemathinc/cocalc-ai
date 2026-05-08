/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import dayjs from "dayjs";
import getPool from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import { toDecimal } from "@cocalc/util/money";
import { after, before } from "@cocalc/server/test";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import {
  closeDedicatedHostPurchaseSessionLocal,
  getDedicatedHostWindowUsageLocal,
  reconcileDedicatedHostPurchaseSessionLocal,
} from "./spend";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("dedicated host spend accounting", () => {
  it("computes rolling prepaid and credit windows from metered host purchases", async () => {
    const account_id = uuid();
    await createPurchase({
      account_id,
      service: "dedicated-host",
      description: {
        type: "dedicated-host",
        host_id: uuid(),
        provider: "gcp",
        funding_lane: "prepaid",
        hourly_cost_usd: "10",
      } as any,
      client: null,
      cost_per_hour: "10",
      period_start: dayjs().subtract(3, "hour").toDate(),
      tag: `dedicated-host:${uuid()}`,
    });
    await createPurchase({
      account_id,
      service: "dedicated-host",
      description: {
        type: "dedicated-host",
        host_id: uuid(),
        provider: "gcp",
        funding_lane: "credit",
        hourly_cost_usd: "5",
      } as any,
      client: null,
      cost_per_hour: "5",
      period_start: dayjs().subtract(10, "hour").toDate(),
      period_end: dayjs().subtract(1, "hour").toDate(),
      tag: `dedicated-host:${uuid()}`,
    });

    const usage = await getDedicatedHostWindowUsageLocal(account_id);
    expect(toDecimal(usage.prepaid_5h_usd).toNumber()).toBeCloseTo(30, 1);
    expect(toDecimal(usage.prepaid_7d_usd).toNumber()).toBeCloseTo(30, 1);
    expect(toDecimal(usage.credit_5h_usd).toNumber()).toBeCloseTo(20, 1);
    expect(toDecimal(usage.credit_7d_usd).toNumber()).toBeCloseTo(45, 1);
  });

  it("reconciles one open purchase session per host and closes the old one on rate change", async () => {
    const account_id = uuid();
    const host_id = uuid();
    const started_at = dayjs().subtract(20, "minute").toDate();

    await reconcileDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      host_name: "GPU Host",
      host_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      machine_type: "n1-standard-4",
      pricing_model: "on_demand",
      funding_lane: "prepaid",
      hourly_cost_usd: "12.5",
      started_at,
    });
    await reconcileDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      host_name: "GPU Host",
      host_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      machine_type: "n1-standard-4",
      pricing_model: "on_demand",
      funding_lane: "prepaid",
      hourly_cost_usd: "12.5",
      started_at,
    });

    let { rows } = await getPool().query(
      `
        SELECT id, period_end, cost_per_hour
        FROM purchases
        WHERE account_id=$1
          AND service=$2
          AND tag=$3
        ORDER BY id ASC
      `,
      [account_id, "dedicated-host", `dedicated-host:${host_id}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].period_end).toBeNull();

    await reconcileDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      host_name: "GPU Host",
      host_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      machine_type: "n1-standard-4",
      pricing_model: "spot",
      funding_lane: "credit",
      hourly_cost_usd: "8",
      started_at: dayjs().subtract(5, "minute").toDate(),
    });

    ({ rows } = await getPool().query(
      `
        SELECT id, period_end, cost_per_hour, description->>'funding_lane' AS funding_lane
        FROM purchases
        WHERE account_id=$1
          AND service=$2
          AND tag=$3
        ORDER BY id ASC
      `,
      [account_id, "dedicated-host", `dedicated-host:${host_id}`],
    ));
    expect(rows).toHaveLength(2);
    expect(rows[0].period_end).not.toBeNull();
    expect(rows[1].period_end).toBeNull();
    expect(toDecimal(rows[1].cost_per_hour).toNumber()).toBe(8);
    expect(rows[1].funding_lane).toBe("credit");

    await closeDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      ended_at: new Date(),
    });
    const { rows: openRows } = await getPool().query(
      `
        SELECT id
        FROM purchases
        WHERE account_id=$1
          AND service=$2
          AND tag=$3
          AND period_end IS NULL
      `,
      [account_id, "dedicated-host", `dedicated-host:${host_id}`],
    );
    expect(openRows).toHaveLength(0);
  });
});
