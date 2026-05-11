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
import { setClosingDay } from "@cocalc/server/purchases/closing-date";
import {
  closeDedicatedHostPurchaseSessionLocal,
  estimateDedicatedHostRateUsdPerHour,
  getDedicatedHostPostpaidUnbilledExposureLocal,
  getDedicatedHostWindowUsageLocal,
  getDedicatedHostWindowUsageForHostLocal,
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

  it("computes rolling spend windows for a specific host", async () => {
    const account_id = uuid();
    const host_id = uuid();
    const other_host_id = uuid();
    await createPurchase({
      account_id,
      service: "dedicated-host",
      description: {
        type: "dedicated-host",
        host_id,
        provider: "gcp",
        funding_lane: "prepaid",
        hourly_cost_usd: "10",
      } as any,
      client: null,
      cost_per_hour: "10",
      period_start: dayjs().subtract(3, "hour").toDate(),
      tag: `dedicated-host:${host_id}`,
    });
    await createPurchase({
      account_id,
      service: "dedicated-host",
      description: {
        type: "dedicated-host",
        host_id: other_host_id,
        provider: "gcp",
        funding_lane: "prepaid",
        hourly_cost_usd: "50",
      } as any,
      client: null,
      cost_per_hour: "50",
      period_start: dayjs().subtract(3, "hour").toDate(),
      tag: `dedicated-host:${other_host_id}`,
    });

    const usage = await getDedicatedHostWindowUsageForHostLocal({
      account_id,
      host_id,
    });
    expect(toDecimal(usage.spend_5h_usd).toNumber()).toBeCloseTo(30, 1);
    expect(toDecimal(usage.spend_7d_usd).toNumber()).toBeCloseTo(30, 1);
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

    const { rows: finalRows } = await getPool().query(
      `
        SELECT cost
        FROM purchases
        WHERE account_id=$1
          AND service=$2
          AND tag=$3
        ORDER BY id ASC
      `,
      [account_id, "dedicated-host", `dedicated-host:${host_id}`],
    );
    expect(finalRows.every((row) => row.cost != null)).toBe(true);
  });

  it("computes postpaid unbilled exposure from credit-funded host segments", async () => {
    const account_id = uuid();
    await createPurchase({
      account_id,
      service: "dedicated-host",
      description: {
        type: "dedicated-host",
        host_id: uuid(),
        provider: "gcp",
        funding_lane: "credit",
        hourly_cost_usd: "10",
      } as any,
      client: null,
      cost_per_hour: "10",
      period_start: dayjs().subtract(2, "hour").toDate(),
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
      cost: "7.5",
      cost_per_hour: "5",
      period_start: dayjs().subtract(3, "hour").toDate(),
      period_end: dayjs().subtract(90, "minute").toDate(),
      tag: `dedicated-host:${uuid()}`,
    });

    const exposure =
      await getDedicatedHostPostpaidUnbilledExposureLocal(account_id);
    expect(toDecimal(exposure).toNumber()).toBeCloseTo(27.5, 1);
  });

  it("estimates Nebius spot rates from the catalog cache using fetched_at ordering", async () => {
    const instanceTypesId = `nebius/instance_types/global-${uuid()}`;
    const oldPricesId = `nebius/prices/old-${uuid()}`;
    const newPricesId = `nebius/prices/global-${uuid()}`;

    try {
      await getPool("medium").query(
        `
          INSERT INTO cloud_catalog_cache
            (id, provider, kind, scope, payload, fetched_at, ttl_seconds, etag)
          VALUES
            ($1, 'nebius', 'instance_types', 'global', $2::jsonb, NOW(), 3600, NULL),
            ($3, 'nebius', 'prices', 'old', $4::jsonb, NOW() - INTERVAL '2 hour', 3600, NULL),
            ($5, 'nebius', 'prices', 'global', $6::jsonb, NOW(), 3600, NULL)
        `,
        [
          instanceTypesId,
          JSON.stringify([
            {
              name: "gpu-h100-80gb-1",
              platform: "gpu-h100-sxm",
              platform_label: "H100 NVLink",
              vcpus: 16,
              memory_gib: 200,
              gpus: 1,
              gpu_label: "NVIDIA H100",
            },
          ]),
          oldPricesId,
          JSON.stringify([
            {
              product:
                "Preemptible NVIDIA® H100 NVLink with Intel Sapphire Rapids. CPU",
              region: "eu-north1",
              price_usd: "999",
              unit: "vCPU hour",
            },
          ]),
          newPricesId,
          JSON.stringify([
            {
              product:
                "Preemptible NVIDIA® H100 NVLink with Intel Sapphire Rapids. CPU",
              region: "eu-north1",
              price_usd: "0.018",
              unit: "vCPU hour",
            },
            {
              product:
                "Preemptible NVIDIA® H100 NVLink with Intel Sapphire Rapids. RAM",
              region: "eu-north1",
              price_usd: "0.0045",
              unit: "GiB hour",
            },
            {
              product:
                "Preemptible NVIDIA® H100 NVLink with Intel Sapphire Rapids. GPU",
              region: "eu-north1",
              price_usd: "0.834",
              unit: "GPU hour",
            },
            {
              product: "Network SSD IO M3 disk",
              region: "eu-north1",
              price_usd: "0.000161111",
              unit: "GiB hour",
            },
          ]),
        ],
      );

      const rate = await estimateDedicatedHostRateUsdPerHour({
        provider: "nebius",
        region: "eu-north1",
        machine_type: "gpu-h100-80gb-1",
        pricing_model: "spot",
        disk_type: "ssd_io_m3",
        disk_gb: 93,
        storage_mode: "persistent",
      });

      expect(toDecimal(rate ?? 0).toNumber()).toBeCloseTo(2.036983323, 9);
    } finally {
      await getPool("medium").query(
        `
          DELETE FROM cloud_catalog_cache
          WHERE id = ANY($1::text[])
        `,
        [[instanceTypesId, oldPricesId, newPricesId]],
      );
    }
  });

  it("rotates open postpaid host segments at the account closing boundary", async () => {
    const account_id = uuid();
    const host_id = uuid();
    await getPool().query(
      "INSERT INTO accounts (account_id, email_address) VALUES ($1, $2)",
      [account_id, `${account_id}@example.com`],
    );
    await setClosingDay(account_id, 5);
    const started_at = new Date(Date.UTC(2026, 4, 4, 23, 0, 0));

    await reconcileDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      host_name: "GPU Host",
      host_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      machine_type: "n1-standard-4",
      pricing_model: "on_demand",
      funding_lane: "credit",
      hourly_cost_usd: "12",
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
      funding_lane: "credit",
      hourly_cost_usd: "12",
      started_at: new Date(Date.UTC(2026, 4, 5, 1, 0, 0)),
    });

    const { rows } = await getPool().query(
      `
        SELECT period_start, period_end, cost
        FROM purchases
        WHERE account_id=$1
          AND service=$2
          AND tag=$3
        ORDER BY id ASC
      `,
      [account_id, "dedicated-host", `dedicated-host:${host_id}`],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].period_end).not.toBeNull();
    expect(rows[0].cost).not.toBeNull();
    expect(rows[1].period_end).toBeNull();
  });
});
