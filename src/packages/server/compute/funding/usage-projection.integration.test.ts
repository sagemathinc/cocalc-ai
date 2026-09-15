import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import {
  reserveComputeVmFundingLocal,
  checkComputeVmFundingLocal,
} from "./vm-reservations";
import { settleComputeVmFundingLocal } from "./vm-settlement";
import { getCourseFundingUsageProjection } from "./usage-projection";
import { setPolicy } from "./__tests__/policy-source";
import { fundingResourceFixtures } from "./__tests__/resource-fixtures";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
beforeAll(async () => await before({ noConat: true }), 60_000);
const resources = fundingResourceFixtures();
afterAll(async () => {
  try {
    await resources.cleanup();
  } finally {
    await after();
  }
});

it.each(["nebius", "gcp"] as const)(
  "projects %s meters, bounded runtime backing and trusted terminal cleanup",
  async (provider) => {
    const payer = randomUUID(),
      first = randomUUID(),
      second = randomUUID();
    resources.add(payer);
    await getPool().query(
      "INSERT INTO accounts (account_id) VALUES ($1),($2),($3)",
      [payer, first, second],
    );
    await getPool().query(
      "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-100,'credit',now())",
      [payer],
    );
    const allocation = await withFundingAccountTransaction(payer, (db) =>
      createCourseFundingPoolInTransaction(db, {
        payer_account_id: payer,
        operation_id: randomUUID(),
        terms: {
          course_project_id: randomUUID(),
          course_instance_id: randomUUID(),
          currency: "USD",
          lane: "prepaid",
          amount_usd: "20",
          starts_at: new Date(Date.now() - 1000).toISOString(),
          ends_at: new Date(Date.now() + 86400000).toISOString(),
          allow_overcommit: false,
          recipients: [
            { beneficiary_account_id: first, amount_usd: "10" },
            { beneficiary_account_id: second, amount_usd: "10" },
          ],
        },
      }),
    );
    const grant = allocation.grants.find(
      (g) => g.beneficiary_account_id === first,
    )!;
    const binding = await reserveComputeVmFundingLocal({
      account_id: payer,
      source: {
        kind: "course",
        pool_id: allocation.pool.id,
        grant_id: grant.id,
        payer_account_id: payer,
      },
      resource_id: randomUUID(),
      resource_generation: 1,
      funding_epoch: randomUUID(),
      owner_account_id: first,
      owning_bay_id: getConfiguredBayId(),
      provider,
      hourly_cost_usd: "2",
      storage_hourly_cost_usd: "0.01",
      pricing_snapshot: { provider },
      requested_until: new Date(Date.now() + 25 * 60_000).toISOString(),
    });
    const read = () =>
      getCourseFundingUsageProjection(getPool(), {
        beneficiary_account_id: first,
        grant_ids: allocation.grants.map((g) => g.id),
      });
    const reserved = await read();
    expect(reserved.size).toBe(1);
    expect(reserved.get(grant.id)).toMatchObject({ active_reservations: 1 });
    expect(reserved.get(grant.id)?.running_vms).toBeUndefined();
    await checkComputeVmFundingLocal({
      account_id: payer,
      binding,
      dispatch: true,
    });
    const {
      rows: [dispatch],
    } = await getPool().query(
      "UPDATE compute_funding_reservations SET dispatched_at=now()-interval '1 minute' WHERE id=$1 RETURNING dispatched_at",
      [binding.reservation_id],
    );
    const running_until = new Date().toISOString();
    await settleComputeVmFundingLocal({
      account_id: payer,
      binding,
      running_started_at: dispatch.dispatched_at.toISOString(),
      running_until,
    });
    const metered = (await read()).get(grant.id)!;
    expect(metered).toMatchObject({
      active_reservations: 1,
      running_vms: 1,
      hourly_usd: "2.0000000000",
    });
    expect(Date.parse(metered.forecast_exhausts_at!)).toBeGreaterThan(
      Date.now() + 4 * 3600000,
    );
    expect(Date.parse(metered.forecast_exhausts_at!)).toBeLessThan(
      Date.now() + 6 * 3600000,
    );
    setPolicy(payer, {
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 3,
        prepaid_host_usage_limit_7d_usd: 10000,
        credit_spend_limit_5h_usd: 1000,
        credit_spend_limit_7d_usd: 10000,
      },
    });
    const limited = (await read()).get(grant.id)!;
    expect(Date.parse(limited.forecast_exhausts_at!)).toBeLessThan(
      Date.now() + 1.5 * 3600000,
    );
    await getPool().query(
      "UPDATE compute_funding_reservations SET pricing_snapshot=jsonb_set(pricing_snapshot,'{meter,running_until}',to_jsonb((now()-interval '5 minutes')::text)) WHERE id=$1",
      [binding.reservation_id],
    );
    expect((await read()).get(grant.id)?.running_vms).toBeUndefined();
    await settleComputeVmFundingLocal({
      account_id: payer,
      binding,
      running_started_at: dispatch.dispatched_at.toISOString(),
      running_until,
      stopped_until: new Date().toISOString(),
      deleted: true,
    });
    if (provider === "gcp") {
      const {
        rows: [pending],
      } = await getPool().query(
        "SELECT state,authorized_usd-spent_usd-released_usd AS remaining FROM compute_funding_reservations WHERE id=$1",
        [binding.reservation_id],
      );
      expect(pending.state).toBe("settling");
      expect(Number(pending.remaining)).toBeGreaterThan(0);
      await getPool().query(
        "UPDATE compute_funding_reservations SET pricing_snapshot=jsonb_set(pricing_snapshot,'{meter,stopped_until}',to_jsonb((now()-interval '5 minutes')::text)) WHERE id=$1",
        [binding.reservation_id],
      );
    }
    expect((await read()).get(grant.id)).toMatchObject({
      active_reservations: provider === "gcp" ? 1 : 0,
      running_vms: 0,
      hourly_usd: "0.0000000000",
    });
    expect((await read()).get(grant.id)?.forecast_exhausts_at).toBeUndefined();
  },
);
