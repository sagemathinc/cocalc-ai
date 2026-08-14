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
  dedicatedHostRateFromPricingSnapshot,
  estimateDedicatedHostRate,
  estimateDedicatedHostRateUsdPerHour,
  getDedicatedHostPostpaidUnbilledExposureLocal,
  getDedicatedHostWindowUsageLocal,
  getDedicatedHostWindowUsageForHostLocal,
  recordDedicatedHostMeteredUsageLocal,
  reconcileDedicatedHostPurchaseSessionLocal,
} from "./spend";
import { ensureAccountUsageWindowsForEvent } from "@cocalc/server/membership/usage-windows";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

function pricingSnapshot(
  hourly_cost_usd: string,
  billing_state: "running" | "stopped" = "running",
) {
  return {
    version: 1 as const,
    billing_state,
    hourly_cost_usd,
    components: [
      {
        key: billing_state === "running" ? ("vm" as const) : ("disk" as const),
        label: billing_state === "running" ? "VM" : "Persistent disk",
        hourly_cost_usd,
        billing_states:
          billing_state === "running"
            ? (["running"] as const)
            : (["running", "stopped"] as const),
      },
    ],
    configuration: {},
  };
}

describe("dedicated host spend accounting", () => {
  it.each([
    { minutes: 10, expected: "0.0000000000" },
    { minutes: 20, expected: "0.0100000000" },
  ])(
    "rounds an independent $minutes-minute host transaction once when finalized",
    async ({ minutes, expected }) => {
      const account_id = uuid();
      const host_id = uuid();
      const ended_at = new Date();
      const started_at = new Date(ended_at.valueOf() - minutes * 60_000);
      await reconcileDedicatedHostPurchaseSessionLocal({
        account_id,
        host_id,
        host_name: "Small Host",
        host_bay_id: "bay-0",
        provider: "gcp",
        region: "us-central1",
        billing_state: "running",
        machine_type: "small",
        pricing_model: "on_demand",
        funding_lane: "prepaid",
        hourly_cost_usd: "0.02",
        pricing_snapshot: pricingSnapshot("0.02"),
        started_at,
      });
      await closeDedicatedHostPurchaseSessionLocal({
        account_id,
        host_id,
        ended_at,
      });

      const { rows } = await getPool().query(
        `SELECT cost, cost_per_hour
           FROM purchases
          WHERE account_id=$1 AND tag=$2`,
        [account_id, `dedicated-host:${host_id}`],
      );
      expect(rows).toEqual([
        {
          cost: expected,
          cost_per_hour: "0.0200000000",
        },
      ]);
    },
  );

  it("accumulates idempotent VM egress intervals into one purchase", async () => {
    const account_id = uuid();
    const resource_id = uuid();
    const project_id = uuid();
    await getPool().query(
      "INSERT INTO accounts (account_id, email_address) VALUES ($1, $2)",
      [account_id, `${account_id}@example.com`],
    );
    const firstStart = dayjs().subtract(10, "minute").toDate();
    const firstEnd = dayjs().subtract(5, "minute").toDate();
    const secondEnd = new Date(firstEnd.valueOf() + 5 * 60_000);
    const base = {
      account_id,
      resource_id,
      resource_name: "VM egress: research-vm",
      resource_bay_id: "bay-0",
      project_id,
      provider: "gcp",
      region: "us-central1",
      funding_lane: "prepaid" as const,
      unit_cost_usd_per_gb: "0.10",
    };

    const first = await recordDedicatedHostMeteredUsageLocal({
      ...base,
      bytes: 1_000_000_000,
      cost_usd: "0.10",
      interval_start: firstStart,
      interval_end: firstEnd,
    });
    expect(first).toMatchObject({
      accepted: true,
      finalized: false,
      total_bytes: 1_000_000_000,
      total_cost_usd: "0.1000000000",
    });

    const retry = await recordDedicatedHostMeteredUsageLocal({
      ...base,
      bytes: 1_000_000_000,
      cost_usd: "0.10",
      interval_start: firstStart,
      interval_end: firstEnd,
    });
    expect(retry).toMatchObject({
      accepted: false,
      total_bytes: 1_000_000_000,
    });

    const overlap = await recordDedicatedHostMeteredUsageLocal({
      ...base,
      bytes: 3_000_000_000,
      cost_usd: "0.30",
      interval_start: firstStart,
      interval_end: secondEnd,
    });
    expect(overlap).toMatchObject({
      accepted: false,
      metered_through_at: firstEnd.toISOString(),
      total_bytes: 1_000_000_000,
    });

    const second = await recordDedicatedHostMeteredUsageLocal({
      ...base,
      bytes: 2_000_000_000,
      cost_usd: "0.20",
      interval_start: firstEnd,
      interval_end: secondEnd,
    });
    expect(second).toMatchObject({
      accepted: true,
      total_bytes: 3_000_000_000,
      total_cost_usd: "0.3000000000",
    });

    const finalized = await recordDedicatedHostMeteredUsageLocal({
      ...base,
      bytes: 0,
      cost_usd: "0",
      interval_start: secondEnd,
      interval_end: secondEnd,
      finalize: true,
    });
    expect(finalized).toMatchObject({
      accepted: false,
      finalized: true,
      total_bytes: 3_000_000_000,
    });

    const { rows: purchases } = await getPool().query(
      `SELECT cost, cost_so_far, period_end, description
         FROM purchases
        WHERE account_id=$1 AND tag LIKE $2`,
      [account_id, `dedicated-host-metered:${resource_id}:%`],
    );
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      cost: "0.3000000000",
      cost_so_far: null,
    });
    expect(purchases[0].period_end.toISOString()).toBe(secondEnd.toISOString());
    expect(purchases[0].description).toMatchObject({
      resource_kind: "compute-egress",
      usage_bytes: 3_000_000_000,
    });

    const usage = await getDedicatedHostWindowUsageLocal(account_id);
    expect(toDecimal(usage.prepaid_5h_usd).toNumber()).toBeCloseTo(0.3, 8);
    expect(toDecimal(usage.prepaid_7d_usd).toNumber()).toBeCloseTo(0.3, 8);
  });

  it("keeps egress metering precise and rounds only its finalized purchase", async () => {
    const account_id = uuid();
    const resource_id = uuid();
    const interval_start = dayjs().subtract(5, "minute").toDate();
    const interval_end = new Date(interval_start.valueOf() + 5 * 60_000);
    const request = {
      account_id,
      resource_id,
      resource_name: "VM egress: small transfer",
      resource_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      funding_lane: "prepaid" as const,
      unit_cost_usd_per_gb: "0.10",
    };
    await recordDedicatedHostMeteredUsageLocal({
      ...request,
      bytes: 60_000_000,
      cost_usd: "0.006",
      interval_start,
      interval_end,
    });
    await recordDedicatedHostMeteredUsageLocal({
      ...request,
      bytes: 0,
      cost_usd: "0",
      interval_start: interval_end,
      interval_end,
      finalize: true,
    });

    const { rows: intervals } = await getPool().query(
      `SELECT amount_usd
         FROM compute_egress_meter_intervals
        WHERE owner_account_id=$1 AND resource_id=$2`,
      [account_id, resource_id],
    );
    expect(intervals).toEqual([{ amount_usd: "0.0060000000" }]);
    const { rows: purchases } = await getPool().query(
      `SELECT cost, cost_so_far
         FROM purchases
        WHERE account_id=$1 AND tag LIKE $2`,
      [account_id, `dedicated-host-metered:${resource_id}:%`],
    );
    expect(purchases).toEqual([{ cost: "0.0100000000", cost_so_far: null }]);
  });

  it("rotates one VM egress purchase per calendar billing month", async () => {
    const account_id = uuid();
    const resource_id = uuid();
    await getPool().query(
      "INSERT INTO accounts (account_id, email_address) VALUES ($1, $2)",
      [account_id, `${account_id}@example.com`],
    );
    const firstStart = new Date("2026-05-31T23:55:00.000Z");
    const boundary = new Date("2026-06-01T00:00:00.000Z");
    const secondEnd = new Date("2026-06-01T00:05:00.000Z");
    const base = {
      account_id,
      resource_id,
      resource_name: "VM egress: month-boundary",
      resource_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      funding_lane: "credit" as const,
      unit_cost_usd_per_gb: "0.10",
    };
    await recordDedicatedHostMeteredUsageLocal({
      ...base,
      bytes: 1_000_000_000,
      cost_usd: "0.10",
      interval_start: firstStart,
      interval_end: boundary,
    });
    const second = await recordDedicatedHostMeteredUsageLocal({
      ...base,
      bytes: 2_000_000_000,
      cost_usd: "0.20",
      interval_start: boundary,
      interval_end: secondEnd,
    });
    expect(second).toMatchObject({
      total_bytes: 3_000_000_000,
      total_cost_usd: "0.3000000000",
    });

    const { rows } = await getPool().query(
      `SELECT tag, cost, cost_so_far, period_end
         FROM purchases
        WHERE account_id=$1 AND tag LIKE $2
        ORDER BY id`,
      [account_id, `dedicated-host-metered:${resource_id}:%`],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      tag: `dedicated-host-metered:${resource_id}:2026-05`,
      cost: "0.1000000000",
      cost_so_far: null,
    });
    expect(rows[0].period_end.toISOString()).toBe(boundary.toISOString());
    expect(rows[1]).toMatchObject({
      tag: `dedicated-host-metered:${resource_id}:2026-06`,
      cost: null,
      cost_so_far: "0.2000000000",
    });
  });

  it("derives stopped disk pricing from a running immutable snapshot", () => {
    const rate = dedicatedHostRateFromPricingSnapshot({
      billing_state: "stopped",
      pricing_snapshot: {
        version: 1,
        billing_state: "running",
        hourly_cost_usd: "10.5",
        components: [
          {
            key: "vm",
            label: "VM",
            hourly_cost_usd: "10",
            billing_states: ["running"],
          },
          {
            key: "disk",
            label: "Persistent disk",
            hourly_cost_usd: "0.5",
            billing_states: ["running", "stopped"],
          },
        ],
        configuration: {
          machine_type: "n2d-standard-4",
          pricing_model: "on_demand",
          disk_gb: 100,
          disk_type: "balanced",
        },
      },
    });

    expect(rate).toEqual({
      hourly_cost_usd: "0.5000000000",
      pricing_snapshot: {
        version: 1,
        billing_state: "stopped",
        hourly_cost_usd: "0.5000000000",
        components: [
          {
            key: "disk",
            label: "Persistent disk",
            hourly_cost_usd: "0.5",
            billing_states: ["running", "stopped"],
          },
        ],
        configuration: {
          disk_gb: 100,
          disk_type: "balanced",
        },
      },
    });
  });

  it("computes prepaid and credit spend from shared fixed account windows", async () => {
    const account_id = uuid();
    const windowStart = dayjs().subtract(3, "hour").toDate();
    await ensureAccountUsageWindowsForEvent({
      account_id,
      occurred_at: windowStart,
    });
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
      period_start: dayjs(windowStart).add(1, "hour").toDate(),
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
      period_start: dayjs(windowStart).add(30, "minute").toDate(),
      period_end: dayjs(windowStart).add(150, "minute").toDate(),
      tag: `dedicated-host:${uuid()}`,
    });

    const usage = await getDedicatedHostWindowUsageLocal(account_id);
    expect(toDecimal(usage.prepaid_5h_usd).toNumber()).toBeCloseTo(20, 1);
    expect(toDecimal(usage.prepaid_7d_usd).toNumber()).toBeCloseTo(20, 1);
    expect(toDecimal(usage.credit_5h_usd).toNumber()).toBeCloseTo(10, 1);
    expect(toDecimal(usage.credit_7d_usd).toNumber()).toBeCloseTo(10, 1);
  });

  it("computes fixed-window spend for a specific host", async () => {
    const account_id = uuid();
    const host_id = uuid();
    const other_host_id = uuid();
    const windowStart = dayjs().subtract(3, "hour").toDate();
    await ensureAccountUsageWindowsForEvent({
      account_id,
      occurred_at: windowStart,
    });
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
      period_start: dayjs(windowStart).add(1, "hour").toDate(),
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
      period_start: dayjs(windowStart).add(1, "hour").toDate(),
      tag: `dedicated-host:${other_host_id}`,
    });

    const usage = await getDedicatedHostWindowUsageForHostLocal({
      account_id,
      host_id,
    });
    expect(toDecimal(usage.spend_5h_usd).toNumber()).toBeCloseTo(20, 1);
    expect(toDecimal(usage.spend_7d_usd).toNumber()).toBeCloseTo(20, 1);
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
      billing_state: "running",
      machine_type: "n1-standard-4",
      pricing_model: "on_demand",
      funding_lane: "prepaid",
      hourly_cost_usd: "12.5",
      pricing_snapshot: pricingSnapshot("12.5"),
      started_at,
    });
    await reconcileDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      host_name: "GPU Host",
      host_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      billing_state: "running",
      machine_type: "n1-standard-4",
      pricing_model: "on_demand",
      funding_lane: "prepaid",
      hourly_cost_usd: "12.5",
      pricing_snapshot: pricingSnapshot("12.5"),
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
      billing_state: "running",
      machine_type: "n1-standard-4",
      pricing_model: "spot",
      funding_lane: "credit",
      hourly_cost_usd: "8",
      pricing_snapshot: pricingSnapshot("8"),
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

  it("serializes concurrent purchase reconciliation per account and host", async () => {
    const account_id = uuid();
    const host_id = uuid();
    const started_at = dayjs().subtract(1, "minute").toDate();
    const reconcile = () =>
      reconcileDedicatedHostPurchaseSessionLocal({
        account_id,
        host_id,
        host_name: "Concurrent Host",
        host_bay_id: "bay-0",
        provider: "gcp",
        region: "us-central1",
        billing_state: "running",
        machine_type: "n2d-standard-4",
        pricing_model: "on_demand",
        funding_lane: "prepaid",
        hourly_cost_usd: "2",
        pricing_snapshot: pricingSnapshot("2"),
        started_at,
      });

    await Promise.all([reconcile(), reconcile(), reconcile()]);

    const { rows } = await getPool().query<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM purchases
        WHERE account_id=$1
          AND service='dedicated-host'
          AND tag=$2
          AND period_end IS NULL
      `,
      [account_id, `dedicated-host:${host_id}`],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it("rotates an unchanged running host exactly once when only its price changes", async () => {
    const account_id = uuid();
    const host_id = uuid();
    const initialStart = dayjs().subtract(20, "minute").toDate();
    const priceChange = dayjs().subtract(5, "minute").toDate();
    const reconcile = async ({
      hourly_cost_usd,
      started_at,
    }: {
      hourly_cost_usd: string;
      started_at: Date;
    }) => {
      await reconcileDedicatedHostPurchaseSessionLocal({
        account_id,
        host_id,
        host_name: "GPU Host",
        host_bay_id: "bay-0",
        provider: "gcp",
        region: "us-central1",
        billing_state: "running",
        machine_type: "n1-standard-4",
        pricing_model: "on_demand",
        funding_lane: "prepaid",
        hourly_cost_usd,
        pricing_snapshot: pricingSnapshot(hourly_cost_usd),
        started_at,
      });
    };

    await reconcile({
      hourly_cost_usd: "12.5",
      started_at: initialStart,
    });
    await reconcile({
      hourly_cost_usd: "13",
      started_at: priceChange,
    });
    await reconcile({
      hourly_cost_usd: "13",
      started_at: new Date(),
    });

    const { rows } = await getPool().query(
      `
        SELECT period_start, period_end, cost_per_hour, description
        FROM purchases
        WHERE account_id=$1
          AND service=$2
          AND tag=$3
        ORDER BY id ASC
      `,
      [account_id, "dedicated-host", `dedicated-host:${host_id}`],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      description: {
        billing_state: "running",
        funding_lane: "prepaid",
        pricing_model: "on_demand",
        pricing_snapshot: {
          hourly_cost_usd: "12.5",
        },
      },
    });
    expect(toDecimal(rows[0].cost_per_hour).eq("12.5")).toBe(true);
    expect(rows[0].period_end).toEqual(priceChange);
    expect(rows[1]).toMatchObject({
      description: {
        billing_state: "running",
        funding_lane: "prepaid",
        pricing_model: "on_demand",
        pricing_snapshot: {
          hourly_cost_usd: "13",
        },
      },
    });
    expect(toDecimal(rows[1].cost_per_hour).eq("13")).toBe(true);
    expect(rows[1].period_start).toEqual(priceChange);
    expect(rows[1].period_end).toBeNull();
  });

  it("rotates from running to stopped with an auditable pricing snapshot", async () => {
    const account_id = uuid();
    const host_id = uuid();
    await reconcileDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      host_name: "Research GPU Host",
      host_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      billing_state: "running",
      machine_type: "n2d-standard-4",
      pricing_model: "spot",
      funding_lane: "prepaid",
      hourly_cost_usd: "2",
      pricing_snapshot: pricingSnapshot("2"),
      started_at: dayjs().subtract(10, "minute").toDate(),
    });
    await reconcileDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      host_name: "Research GPU Host",
      host_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      billing_state: "stopped",
      funding_lane: "prepaid",
      hourly_cost_usd: "0.25",
      pricing_snapshot: pricingSnapshot("0.25", "stopped"),
    });

    const { rows } = await getPool().query(
      `
        SELECT period_end, description, notes
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
    expect(rows[0].description.billing_state).toBe("running");
    expect(rows[1].period_end).toBeNull();
    expect(rows[1].description).toMatchObject({
      billing_state: "stopped",
      machine_type: null,
      pricing_model: null,
      pricing_snapshot: {
        billing_state: "stopped",
        components: [
          expect.objectContaining({
            key: "disk",
            billing_states: ["running", "stopped"],
          }),
        ],
      },
    });
    expect(rows[1].notes).toBeNull();
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
            {
              product: "Network SSD disk",
              region: "us-central1",
              price_usd: "0.00009726027397260273",
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

      const volumeRate = await estimateDedicatedHostRate({
        provider: "nebius",
        region: "us-central1",
        pricing_model: "on_demand",
        disk_type: "ssd",
        disk_gb: 93,
        storage_mode: "persistent",
        billing_state: "stopped",
      });
      expect(Number(volumeRate?.hourly_cost_usd)).toBeGreaterThan(0);
      expect(
        volumeRate?.pricing_snapshot.components.map(({ key }) => key),
      ).toEqual(["disk"]);
      expect(volumeRate?.pricing_snapshot.configuration).toMatchObject({
        disk_type: "ssd",
        disk_gb: 93,
      });
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

  it("rotates open postpaid host segments at the calendar-month boundary", async () => {
    const account_id = uuid();
    const host_id = uuid();
    await getPool().query(
      "INSERT INTO accounts (account_id, email_address) VALUES ($1, $2)",
      [account_id, `${account_id}@example.com`],
    );
    const started_at = new Date(Date.UTC(2026, 4, 31, 23, 0, 0));

    await reconcileDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      host_name: "GPU Host",
      host_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      billing_state: "running",
      machine_type: "n1-standard-4",
      pricing_model: "on_demand",
      funding_lane: "credit",
      hourly_cost_usd: "12",
      pricing_snapshot: pricingSnapshot("12"),
      started_at,
    });

    await reconcileDedicatedHostPurchaseSessionLocal({
      account_id,
      host_id,
      host_name: "GPU Host",
      host_bay_id: "bay-0",
      provider: "gcp",
      region: "us-central1",
      billing_state: "running",
      machine_type: "n1-standard-4",
      pricing_model: "on_demand",
      funding_lane: "credit",
      hourly_cost_usd: "12",
      pricing_snapshot: pricingSnapshot("12"),
      started_at: new Date(Date.UTC(2026, 5, 1, 1, 0, 0)),
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
    expect(rows[0].period_end.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(rows[0].cost).not.toBeNull();
    expect(rows[1].period_start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(rows[1].period_end).toBeNull();
  });
});
