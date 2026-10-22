/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { ensureProjectHostMetricsSamplesSchema } from "@cocalc/database/postgres/project-host-metrics";
import { uuid } from "@cocalc/util/misc";
import { hasUsageSubscription } from "./stripe-usage-based-subscription";
import {
  billingExposureHealthDetails,
  billingExposureHealthLevel,
  billingExposureHealthSummary,
  getBillingExposureHealth,
  type BillingExposureHealth,
} from "./billing-exposure-health";

const clean: BillingExposureHealth = {
  negative: { count: 0, total_usd: 0, worst: [] },
  postpaid_negative: { count: 0, total_usd: 0, worst: [] },
  open_metered: {
    count: 0,
    cost_per_hour_usd: 0,
    oldest_period_start: null,
    account_ids: [],
  },
  stuck_hosts: [],
  idle_hosts: [],
};

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe("billing exposure levels", () => {
  it("is healthy with no exposure", () => {
    expect(billingExposureHealthLevel(clean)).toBe("healthy");
    expect(billingExposureHealthSummary(clean)).toBe(
      "No unpaid balance, unfunded metered usage, stuck billing-blocked host or idle dedicated host.",
    );
    expect(billingExposureHealthDetails(clean)).toEqual([]);
  });

  it("warns on a negative account, open metered usage or an idle host", () => {
    const account = { account_id: "a", balance: -25 };
    expect(
      billingExposureHealthLevel({
        ...clean,
        negative: { count: 1, total_usd: 25, worst: [account] },
      }),
    ).toBe("warning");
    expect(
      billingExposureHealthLevel({
        ...clean,
        open_metered: { ...clean.open_metered, count: 1 },
      }),
    ).toBe("warning");
    expect(
      billingExposureHealthLevel({
        ...clean,
        idle_hosts: [
          { host_id: "h", name: null, owner: null, last_busy_at: null },
        ],
      }),
    ).toBe("warning");
  });

  it("is critical for a stuck host or a large total", () => {
    expect(
      billingExposureHealthLevel({
        ...clean,
        stuck_hosts: [
          {
            host_id: "h",
            name: "theta_congruent",
            owner: "o",
            deprovision_after: "2026-10-01T00:00:00.000Z",
            final_backup_status: "failed",
          },
        ],
      }),
    ).toBe("critical");
    expect(
      billingExposureHealthLevel({
        ...clean,
        negative: { count: 3, total_usd: 200.01, worst: [] },
      }),
    ).toBe("critical");
    expect(
      billingExposureHealthLevel({
        ...clean,
        negative: { count: 3, total_usd: 200, worst: [] },
      }),
    ).toBe("warning");
  });

  it("never raises the level for post-paid accounts alone", () => {
    const health = {
      ...clean,
      postpaid_negative: {
        count: 1,
        total_usd: 900,
        worst: [{ account_id: "p", balance: -900 }],
      },
    };
    expect(billingExposureHealthLevel(health)).toBe("healthy");
    expect(billingExposureHealthDetails(health)).toEqual([
      "Post-paid accounts (collected later) below -$20.00, expected between collections: 1 account, $900.00; p -$900.00",
    ]);
  });
});

describe("getBillingExposureHealth", () => {
  const prepaid = uuid();
  const small = uuid();
  const postpaid = uuid();
  const meteredOwner = uuid();
  const blocked = uuid();
  const legacy = uuid();
  const optedOut = uuid();
  const banned = uuid();
  const deleted = uuid();
  const fenced = uuid();
  const stuckHost = uuid();
  const backedUpHost = uuid();
  const notYetDueHost = uuid();
  const idleHost = uuid();
  const busyHost = uuid();
  const restartedHost = uuid();
  const pooledHost = uuid();
  const siteHost = uuid();
  let now: number;

  async function purchase(
    account_id: string,
    fields: {
      cost?: number;
      cost_per_hour?: number;
      period_start?: Date;
      period_end?: Date;
    },
  ) {
    await getPool().query(
      `INSERT INTO purchases
         (time,account_id,cost,cost_per_hour,period_start,period_end,service,description)
       VALUES (NOW(),$1,$2,$3,$4,$5,'dedicated-host','{}'::jsonb)`,
      [
        account_id,
        fields.cost ?? null,
        fields.cost_per_hour ?? null,
        fields.period_start ?? null,
        fields.period_end ?? null,
      ],
    );
  }

  async function host(
    id: string,
    name: string,
    {
      status = "running",
      tier = null,
      metadata = {},
    }: { status?: string; tier?: number | null; metadata?: any },
  ) {
    await getPool().query(
      `INSERT INTO project_hosts (id,name,status,tier,metadata,created,updated)
       VALUES ($1,$2,$3,$4,$5::jsonb,NOW(),NOW())`,
      [id, name, status, tier, JSON.stringify({ owner: prepaid, ...metadata })],
    );
  }

  async function samples(host_id: string, points: [number, number][]) {
    for (const [agoMs, running] of points) {
      await getPool().query(
        `INSERT INTO project_host_metrics_samples
           (host_id,collected_at,running_project_count) VALUES ($1,$2,$3)`,
        [host_id, new Date(now - agoMs), running],
      );
    }
  }

  function enforcement(
    deprovision_after: string,
    final_backup_status?: string,
  ) {
    return {
      billing: {
        funding_mode: "account-prepaid",
        enforcement: {
          state: "stopped_billing_blocked",
          deprovision_after,
          ...(final_backup_status ? { final_backup_status } : {}),
        },
      },
    };
  }

  beforeAll(async () => {
    await initEphemeralDatabase({ reset: true });
    await ensureProjectHostMetricsSamplesSchema();
    now = Date.now();
    for (const account_id of [
      prepaid,
      small,
      postpaid,
      meteredOwner,
      blocked,
      legacy,
      optedOut,
      banned,
      deleted,
      fenced,
    ]) {
      await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [
        account_id,
      ]);
    }
    const consent = '{"enabled":true,"terms_version":1}';
    for (const account_id of [postpaid, blocked, banned, deleted, fenced]) {
      await getPool().query(
        "UPDATE accounts SET monthly_collection=$2::jsonb WHERE account_id=$1",
        [account_id, consent],
      );
    }
    // Collection is blocked while a statement needs review: not post-paid.
    await getPool().query(
      `INSERT INTO statements(interval,time,account_id,balance,total_charges,num_charges,total_credits,num_credits,monthly_collection)
       VALUES('month',NOW(),$1,-40,40,1,0,0,'{"state":"requires_review"}'::jsonb)`,
      [blocked],
    );
    // Legacy usage subscription without explicit consent: post-paid.
    await getPool().query(
      "UPDATE accounts SET stripe_usage_subscription='sub_legacy' WHERE account_id=$1",
      [legacy],
    );
    // An explicit opt-out overrides the legacy subscription: not post-paid.
    await getPool().query(
      `UPDATE accounts SET stripe_usage_subscription='sub_legacy',
              monthly_collection='{"enabled":false,"terms_version":1}'::jsonb
        WHERE account_id=$1`,
      [optedOut],
    );
    // Consent does not make a banned or deleted account collectible: the
    // collection worker skips them.
    await getPool().query(
      "UPDATE accounts SET banned=TRUE WHERE account_id=$1",
      [banned],
    );
    await getPool().query(
      "UPDATE accounts SET deleted=TRUE WHERE account_id=$1",
      [deleted],
    );
    await getPool().query(
      "INSERT INTO billing_authority_account_fences (account_id, frozen) VALUES ($1, TRUE)",
      [fenced],
    );
    for (const account_id of [
      blocked,
      legacy,
      optedOut,
      banned,
      deleted,
      fenced,
    ]) {
      await purchase(account_id, { cost: 40 });
    }
    // A cached positive balance must not hide the live debt.
    await getPool().query(
      "UPDATE accounts SET balance=100 WHERE account_id=$1",
      [prepaid],
    );
    // -$60 live: $80 charge minus a $20 credit.
    await purchase(prepaid, { cost: 80 });
    await purchase(prepaid, { cost: -20 });
    // -$5: negative but above the threshold.
    await purchase(small, { cost: 5 });
    // -$500 post-paid: expected between collections.
    await purchase(postpaid, { cost: 500 });
    await purchase(postpaid, {
      cost_per_hour: 1,
      period_start: new Date(now - HOUR),
    });
    // Metered usage: $2/hour for 9 hours plus $0.50 closed = -$18.50 live,
    // negative but above the threshold.
    await purchase(meteredOwner, {
      cost_per_hour: 2,
      period_start: new Date(now - 9 * HOUR),
    });
    // A closed metered purchase is not open usage.
    await purchase(meteredOwner, {
      cost_per_hour: 0.5,
      period_start: new Date(now - 3 * HOUR),
      period_end: new Date(now - 2 * HOUR),
    });

    const past = new Date(now - DAY).toISOString();
    const future = new Date(now + DAY).toISOString();
    await host(stuckHost, "theta_congruent", {
      status: "off",
      metadata: enforcement(past, "failed"),
    });
    await host(backedUpHost, "backed-up", {
      status: "off",
      metadata: enforcement(past, "succeeded"),
    });
    await host(notYetDueHost, "grace", {
      status: "off",
      metadata: enforcement(future, "running"),
    });

    await host(idleHost, "test-host-1", {});
    await samples(idleHost, [
      [4 * DAY, 0],
      [3 * DAY - HOUR, 0],
      [HOUR, 0],
    ]);
    await host(busyHost, "busy", {});
    await samples(busyHost, [
      [4 * DAY, 0],
      [3 * DAY - HOUR, 0],
      [DAY, 2],
    ]);
    // Busy before a long stop, restarted yesterday: not idle for 3 days.
    await host(restartedHost, "restarted", {});
    await samples(restartedHost, [
      [7 * DAY, 4],
      [DAY, 0],
      [HOUR, 0],
    ]);
    await host(pooledHost, "pool", { tier: 1 });
    await samples(pooledHost, [[3 * DAY - HOUR, 0]]);
    await host(siteHost, "site", {
      metadata: { billing: { funding_mode: "site-funded" } },
    });
    await samples(siteHost, [[3 * DAY - HOUR, 0]]);
  }, 60_000);

  it("reports live balances, open metered usage and stuck or idle hosts", async () => {
    const health = await getBillingExposureHealth();
    expect(health.negative.count).toBe(6);
    expect(health.negative.total_usd).toBe(260);
    // The five most negative, worst first.
    expect(health.negative.worst).toHaveLength(5);
    expect(health.negative.worst[0]).toEqual({
      account_id: prepaid,
      balance: -60,
    });
    for (const { account_id, balance } of health.negative.worst.slice(1)) {
      expect([blocked, optedOut, banned, deleted, fenced]).toContain(
        account_id,
      );
      expect(balance).toBe(-40);
    }
    expect(health.postpaid_negative.count).toBe(2);
    expect(
      health.postpaid_negative.worst.map(({ account_id }) => account_id),
    ).toEqual([postpaid, legacy]);
    expect(health.postpaid_negative.total_usd).toBeGreaterThan(540);
    // Post-paid here means exactly what the collection path considers
    // collectible.
    for (const account_id of [prepaid, postpaid, blocked, legacy, optedOut]) {
      expect(await hasUsageSubscription(account_id)).toBe(
        account_id === postpaid || account_id === legacy,
      );
    }

    expect(health.open_metered.count).toBe(1);
    expect(health.open_metered.cost_per_hour_usd).toBe(2);
    expect(health.open_metered.account_ids).toEqual([meteredOwner]);
    expect(
      Math.abs(
        new Date(health.open_metered.oldest_period_start!).valueOf() -
          (now - 9 * HOUR),
      ),
    ).toBeLessThan(1000);

    expect(health.stuck_hosts).toEqual([
      {
        host_id: stuckHost,
        name: "theta_congruent",
        owner: prepaid,
        deprovision_after: new Date(now - DAY).toISOString(),
        final_backup_status: "failed",
      },
    ]);
    expect(health.idle_hosts.map(({ host_id }) => host_id)).toEqual([idleHost]);
    expect(health.idle_hosts[0].last_busy_at).toBeNull();

    expect(billingExposureHealthLevel(health)).toBe("critical");
    expect(billingExposureHealthSummary(health)).toBe(
      "6 accounts below -$20.00 ($260.00 owed); 1 open metered purchase with a negative owner balance ($2.00/hour); 1 billing-blocked host past deprovision without a successful final backup; 1 running dedicated host with no running project for 3 days.",
    );
    const details = billingExposureHealthDetails(health);
    expect(details[0]).toMatch(
      new RegExp(`^Most negative accounts: ${prepaid} -\\$60\\.00, `),
    );
    expect(details.join("\n")).toContain(stuckHost);
    expect(details.join("\n")).toContain(idleHost);
  });

  it("stops reporting once the debt is paid and the host is used", async () => {
    await purchase(prepaid, { cost: -60 });
    await purchase(blocked, { cost: -40 });
    await purchase(optedOut, { cost: -40 });
    await purchase(banned, { cost: -40 });
    await purchase(deleted, { cost: -40 });
    await purchase(fenced, { cost: -40 });
    await purchase(meteredOwner, { cost: -1000 });
    await getPool().query(
      `UPDATE project_hosts
          SET metadata = jsonb_set(metadata, '{billing,enforcement,final_backup_status}', '"succeeded"')
        WHERE id=$1`,
      [stuckHost],
    );
    await samples(idleHost, [[HOUR / 2, 1]]);
    const health = await getBillingExposureHealth();
    expect(health.negative.count).toBe(0);
    expect(health.open_metered.count).toBe(0);
    expect(health.stuck_hosts).toEqual([]);
    expect(health.idle_hosts).toEqual([]);
    expect(billingExposureHealthLevel(health)).toBe("healthy");
  });
});
