/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getTransactionClient,
  initEphemeralDatabase,
  type PoolClient,
} from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import {
  projectMembershipAllocationFact,
  recordMembershipAllocationFact,
  recordMembershipAllocationRefund,
} from "./allocation-analytics";
import { getMembershipAllocationSeriesLocal } from "./allocation-analytics-series";

describe("membership allocation analytics series", () => {
  let client: PoolClient;

  beforeAll(async () => {
    await initEphemeralDatabase({});
    client = await getTransactionClient();
  }, 30_000);

  afterAll(async () => {
    await client.query("ROLLBACK");
    client.release();
  }, 30_000);

  it("returns filtered net daily allocations without PII", async () => {
    const accountId = uuid();
    const purchaseId = -Math.floor(Math.random() * 1_000_000_000) - 1;
    const refundPurchaseId = purchaseId - 1;
    const standardFact = `test:series:${uuid()}:standard`;
    const proFact = `test:series:${uuid()}:pro`;

    await recordMembershipAllocationFact({
      fact_key: standardFact,
      account_id: accountId,
      channel: "personal",
      source_kind: "purchase",
      membership_class: "standard",
      billing_interval: "month",
      lifecycle: "first_paid",
      allocation_start: "2026-08-01",
      allocation_end: "2026-08-03",
      active_memberships: 1,
      revenue: 1.01,
      purchase_id: purchaseId,
      client,
    });
    await recordMembershipAllocationFact({
      fact_key: proFact,
      account_id: accountId,
      channel: "personal",
      source_kind: "purchase",
      membership_class: "pro",
      billing_interval: "year",
      lifecycle: "renewal",
      allocation_start: "2026-08-01",
      allocation_end: "2026-08-03",
      active_memberships: 1,
      revenue: 2,
      purchase_id: purchaseId - 2,
      client,
    });
    expect(
      await recordMembershipAllocationRefund({
        original_purchase_id: purchaseId,
        refund_purchase_id: refundPurchaseId,
        client,
      }),
    ).toBe(1);

    const { rows: refundRows } = await client.query<{ fact_key: string }>(
      `SELECT fact_key
         FROM membership_allocation_facts
        WHERE purchase_id=$1`,
      [refundPurchaseId],
    );
    for (const fact_key of [
      standardFact,
      proFact,
      ...refundRows.map(({ fact_key }) => fact_key),
    ]) {
      await projectMembershipAllocationFact({ fact_key, client });
    }

    const result = await getMembershipAllocationSeriesLocal({
      query: {
        start: "2026-08-01",
        end: "2026-08-03",
        membership_classes: ["standard", "pro"],
        billing_intervals: ["year"],
      },
      client,
    });
    expect(result.rows).toEqual([
      {
        day: "2026-08-01",
        channel: "personal",
        membership_class: "pro",
        billing_interval: "year",
        lifecycle: "renewal",
        previous_membership_class: null,
        previous_billing_interval: null,
        tier_change: "none",
        active_memberships: 1,
        purchased_capacity: 0,
        revenue_cents: 100,
        fact_count: 1,
      },
      {
        day: "2026-08-02",
        channel: "personal",
        membership_class: "pro",
        billing_interval: "year",
        lifecycle: "renewal",
        previous_membership_class: null,
        previous_billing_interval: null,
        tier_change: "none",
        active_memberships: 1,
        purchased_capacity: 0,
        revenue_cents: 100,
        fact_count: 1,
      },
    ]);
    expect(JSON.stringify(result.rows)).not.toContain(accountId);
  }, 30_000);
});
