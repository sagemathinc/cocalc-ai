/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { ReserveComputeVmFundingRequest } from "@cocalc/util/compute-vm-funding";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import {
  checkComputeVmFundingLocal,
  reserveComputeVmFundingLocal,
  quoteVmFunding,
  quoteVmFundingAdmission,
} from "./vm-reservations";
import {
  cumulativeVmCharge,
  settleComputeVmFundingLocal,
} from "./vm-settlement";
import { setPolicy } from "./__tests__/policy-source";
import {
  meterCourseVm,
  meterCourseVmEgress,
  reserveCourseVmLaunch,
  requireCourseVmService,
} from "./vm-funding";
import { getComputeVmById } from "../db";
import { fundingResourceFixtures } from "./__tests__/resource-fixtures";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import { getComputeFundingPolicyInTransaction } from "./policy";
import { enableTestSponsorshipRollout } from "./__tests__/rollout-fixture";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({
    home_bay_id: require("@cocalc/server/bay-config").getConfiguredBayId(),
  }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ compute_vm_course_funding_enabled: true }),
}));

const resources = fundingResourceFixtures();
let stopRollout: (() => void) | undefined;
beforeAll(async () => {
  await before({ noConat: true });
  stopRollout = await enableTestSponsorshipRollout();
}, 60_000);
afterAll(async () => {
  try {
    await resources.cleanup();
  } finally {
    stopRollout?.();
    await after();
  }
});

async function fixture(provider: "gcp" | "nebius" = "gcp") {
  const payer = randomUUID();
  const student = randomUUID();
  resources.add(payer, student);
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1),($2)", [
    payer,
    student,
  ]);
  await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-100,'credit',NOW())",
    [payer],
  );
  setPolicy(student, {
    has_active_second_factor: false,
    has_payment_method: false,
    can_create_hosts: false,
  });
  const allocation = await withFundingAccountTransaction(payer, (client) =>
    createCourseFundingPoolInTransaction(client, {
      payer_account_id: payer,
      operation_id: randomUUID(),
      terms: {
        course_project_id: randomUUID(),
        course_instance_id: randomUUID(),
        currency: "USD",
        lane: "prepaid",
        amount_usd: "50",
        allow_overcommit: false,
        starts_at: new Date(Date.now() - 1000).toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        recipients: [{ beneficiary_account_id: student, amount_usd: "50" }],
      },
    }),
  );
  const request: ReserveComputeVmFundingRequest = {
    account_id: payer,
    source: {
      kind: "course",
      pool_id: allocation.pool.id,
      grant_id: allocation.grants[0].id,
      payer_account_id: payer,
    },
    resource_id: randomUUID(),
    resource_generation: 1,
    funding_epoch: randomUUID(),
    owner_account_id: student,
    owning_bay_id: getConfiguredBayId(),
    provider,
    hourly_cost_usd: "6",
    storage_hourly_cost_usd: "0.01",
    pricing_snapshot: { provider },
    requested_until: new Date(Date.now() + 25 * 60_000).toISOString(),
  };
  return { payer, student, request };
}

describe("actual sponsored VM reservation and settlement", () => {
  it.each(["5h", "7d"] as const)(
    "renews funded service across a %s reset without stopping",
    async (window) => {
      const { payer, request } = await fixture("nebius");
      const policy = await withFundingAccountTransaction(payer, (db) =>
        getComputeFundingPolicyInTransaction(db, {
          payer_account_id: payer,
          lane: "prepaid",
          for_service: true,
        }),
      );
      const reset = new Date(Date.now() + 10 * 60_000);
      await getPool().query(
        "UPDATE account_usage_windows SET resets_at=$2 WHERE id=$1",
        [policy.windows[window].window!.id, reset],
      );
      const binding = await reserveComputeVmFundingLocal(request);
      const opts = {
        account_id: payer,
        binding,
        renew_until: new Date(Date.now() + 18 * 60_000).toISOString(),
      };
      const renewed = await checkComputeVmFundingLocal(opts);
      expect(Date.parse(renewed.stop_at)).toBeGreaterThan(reset.valueOf());
      expect(Number(renewed.authorized_usd)).toBeGreaterThan(
        Number(binding.authorized_usd),
      );
      expect(
        await checkComputeVmFundingLocal({
          account_id: payer,
          binding: renewed,
        }),
      ).toEqual(renewed);
      const {
        rows: [grant],
      } = await getPool().query(
        "SELECT reserved_usd FROM compute_funding_grants WHERE id=$1",
        [request.source.grant_id],
      );
      expect(grant.reserved_usd).toBe(renewed.authorized_usd);
      // The new window still counts the full outstanding commitment.
      await getPool().query(
        "UPDATE account_usage_windows SET resets_at=NOW()-interval '1 second' WHERE id=$1",
        [policy.windows[window].window!.id],
      );
      expect(
        await checkComputeVmFundingLocal({
          account_id: payer,
          binding: renewed,
        }),
      ).toEqual(renewed);
      setPolicy(payer, {
        effective_limits: {
          prepaid_host_usage_limit_5h_usd: 0.01,
          prepaid_host_usage_limit_7d_usd: 0.01,
        },
      });
      await expect(
        checkComputeVmFundingLocal({ ...opts, binding: renewed }),
      ).rejects.toThrow();
    },
  );
  it.each(["5h", "7d"] as const)(
    "bounds new service at a nearby %s reset without dropping protected backing",
    async (window) => {
      const { payer, request } = await fixture("nebius");
      const policy = await withFundingAccountTransaction(payer, (db) =>
        getComputeFundingPolicyInTransaction(db, {
          payer_account_id: payer,
          lane: "prepaid",
          for_service: true,
        }),
      );
      const reset = new Date(Date.now() + 10 * 60_000);
      await getPool().query(
        "UPDATE account_usage_windows SET resets_at=$2 WHERE id=$1",
        [policy.windows[window].window!.id, reset],
      );
      const binding = await reserveComputeVmFundingLocal(request);
      expect(Date.parse(binding.authorized_until)).toBe(reset.valueOf());
      expect(Date.parse(binding.stop_at)).toBe(reset.valueOf() - 5 * 60_000);
      expect(Number(binding.protected_usd)).toBeGreaterThan(0);
      expect(await reserveComputeVmFundingLocal(request)).toEqual(binding);
    },
  );
  it("serializes two payers competing for the last site exposure allocation", async () => {
    const first = await fixture();
    const second = await fixture();
    const {
      rows: [existing],
    } = await getPool().query(`SELECT COALESCE(SUM(
      authorized_usd-spent_usd-released_usd + COALESCE((pricing_snapshot#>>'{meter,platform_overrun_usd}')::numeric,0)),0)::text AS amount
      FROM compute_funding_reservations`);
    const quote = quoteVmFundingAdmission(first.request, new Date());
    const limit = toDecimal(existing.amount)
      .plus(quote.authorized_usd)
      .plus("1.00");
    const previous = process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD;
    process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD = moneyToDbString(limit);
    try {
      const outcomes = await Promise.allSettled([
        reserveComputeVmFundingLocal(first.request),
        reserveComputeVmFundingLocal(second.request),
      ]);
      expect(
        outcomes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = outcomes.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      expect(rejected.reason.code).toBe("funding_unavailable");
      expect(rejected.reason.message).toMatch(/exposure (limit|quota)/);
      const {
        rows: [current],
      } = await getPool().query(`SELECT COALESCE(SUM(
        authorized_usd-spent_usd-released_usd + COALESCE((pricing_snapshot#>>'{meter,platform_overrun_usd}')::numeric,0)),0)::text AS amount
        FROM compute_funding_reservations`);
      expect(toDecimal(current.amount).lte(limit)).toBe(true);
    } finally {
      if (previous == null)
        delete process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD;
      else process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD = previous;
    }
  });
  it.each([1, 5])(
    "reserves through the launch caller for a %i-minute stop and ten-minute deletion without extending either timer",
    async (minutes) => {
      const deployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
      process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "short-create-test";
      try {
        const { request } = await fixture();
        const stop = new Date(Date.now() + minutes * 60_000),
          deletion = new Date(Date.now() + 10 * 60_000);
        const rate = {
          hourly_cost_usd: request.hourly_cost_usd,
          pricing_snapshot: request.pricing_snapshot,
        };
        await getPool().query(
          `INSERT INTO compute_vms
        (id,owner_account_id,owning_bay_id,provider,instance_generation,state,desired_state,stop_at,expires_at,metadata,effective_pricing_model,created_at)
        VALUES ($1,$2,$3,'gcp',1,'requested','running',$4,$5,$6,'spot',NOW())`,
          [
            request.resource_id,
            request.owner_account_id,
            request.owning_bay_id,
            stop,
            deletion,
            {
              billing: {
                course_funding: {
                  source: request.source,
                  funding_epoch: request.funding_epoch,
                },
                running_rates: { spot: rate },
                stopped_rate: {
                  hourly_cost_usd: request.storage_hourly_cost_usd,
                },
              },
            },
          ],
        );
        const vm = (await getComputeVmById(request.resource_id))!;
        const reserved = await reserveCourseVmLaunch(vm);
        const binding = reserved.metadata.billing.course_funding.binding;
        expect(reserved.stop_at).toEqual(stop);
        expect(reserved.expires_at).toEqual(deletion);
        expect(binding.stop_at).toBe(stop.toISOString());
        expect(binding.storage_delete_at).toBe(deletion.toISOString());
        expect(
          new Date(binding.authorized_until).valueOf(),
        ).toBeLessThanOrEqual(deletion.valueOf());
        expect(Number(binding.authorized_usd)).toBeGreaterThan(3.7);
        expect(
          (await reserveCourseVmLaunch(vm)).metadata.billing.course_funding
            .binding,
        ).toEqual(binding);
        await requireCourseVmService(reserved, true);
        const {
          rows: [row],
        } = await getPool().query(
          "SELECT state FROM compute_funding_reservations WHERE id=$1",
          [binding.reservation_id],
        );
        expect(row.state).toBe("dispatched");
      } finally {
        if (deployment == null) delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
        else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = deployment;
      }
    },
  );

  it("makes a definite expired-timer denial non-running without masking an unknown reservation outcome", async () => {
    const deployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
    process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "short-denial-test";
    try {
      const { request } = await fixture();
      await getPool().query(
        `INSERT INTO compute_vms
        (id,owner_account_id,owning_bay_id,provider,instance_generation,state,desired_state,stop_at,metadata,effective_pricing_model,created_at)
        VALUES ($1,$2,$3,'gcp',1,'requested','running',NOW()-interval '1 second',$4,'spot',NOW())`,
        [
          request.resource_id,
          request.owner_account_id,
          request.owning_bay_id,
          {
            billing: {
              course_funding: {
                source: request.source,
                funding_epoch: request.funding_epoch,
              },
              running_rates: { spot: { hourly_cost_usd: "6" } },
              stopped_rate: { hourly_cost_usd: "0.01" },
            },
          },
        ],
      );
      await expect(
        reserveCourseVmLaunch((await getComputeVmById(request.resource_id))!),
      ).rejects.toThrow(/deadline has already passed/);
      const vm = (await getComputeVmById(request.resource_id))!;
      expect(vm.desired_state).toBe("stopped");
      expect(vm.billing_state).toBe("admission-rejected");
      expect(
        (
          await getPool().query(
            "SELECT id FROM compute_funding_reservations WHERE resource_id=$1",
            [vm.id],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      if (deployment == null) delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
      else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = deployment;
    }
  });
  it("renews atomically, replays a lost renewal reply, and preserves protected storage", async () => {
    const { request, payer } = await fixture("nebius");
    const binding = await reserveComputeVmFundingLocal(request);
    binding.authorized_until = new Date(Date.now() + 10 * 60_000).toISOString();
    binding.stop_at = new Date(Date.now() + 5 * 60_000).toISOString();
    await getPool().query(
      "UPDATE compute_funding_reservations SET authorized_until=$2,pricing_snapshot=jsonb_set(pricing_snapshot,'{binding}',$3::jsonb) WHERE id=$1",
      [
        binding.reservation_id,
        binding.authorized_until,
        JSON.stringify(binding),
      ],
    );
    const opts = {
      account_id: payer,
      binding,
      renew_until: new Date(Date.now() + 20 * 60_000).toISOString(),
    };
    const renewed = await checkComputeVmFundingLocal(opts);
    expect(new Date(renewed.authorized_until).valueOf()).toBeGreaterThan(
      new Date(binding.authorized_until).valueOf(),
    );
    expect(Number(renewed.authorized_usd)).toBeGreaterThan(
      Number(binding.authorized_usd),
    );
    expect(Number(renewed.protected_usd)).toBeGreaterThan(
      Number(binding.protected_usd),
    );
    expect(await checkComputeVmFundingLocal(opts)).toEqual(renewed);
    const {
      rows: [budget],
    } = await getPool().query(
      "SELECT reserved_usd FROM compute_funding_grants WHERE id=$1",
      [binding.source.grant_id],
    );
    expect(budget.reserved_usd).toBe(renewed.authorized_usd);
  });

  it("reserves compute, protected storage and bounded GCP egress without student funds or student payment prerequisites", async () => {
    const { request, student } = await fixture();
    const binding = await reserveComputeVmFundingLocal(request);
    expect(binding.owner_account_id).toBe(student);
    expect(binding.egress_usd).toBe("1.0000000000");
    expect(Number(binding.protected_usd)).toBeGreaterThan(0.72);
    expect(await reserveComputeVmFundingLocal(request)).toEqual(binding);
    const { rows } = await getPool().query(
      "SELECT * FROM purchases WHERE account_id=$1",
      [student],
    );
    expect(rows).toHaveLength(0);
    await expect(
      reserveComputeVmFundingLocal({ ...request, hourly_cost_usd: "100" }),
    ).rejects.toThrow(/different terms/);
  });

  it("rejects a grant for someone other than the authoritative VM owner", async () => {
    const { request } = await fixture();
    await expect(
      reserveComputeVmFundingLocal({
        ...request,
        owner_account_id: randomUUID(),
      }),
    ).rejects.toThrow(/beneficiary/);
  });

  it("keeps owner access separate, caps customer egress, stops on exhaustion and settles idempotently after revocation", async () => {
    const { request, payer, student } = await fixture();
    const binding = await reserveComputeVmFundingLocal(request);
    await checkComputeVmFundingLocal({
      account_id: payer,
      binding,
      dispatch: true,
    });
    const runStart = new Date(Date.now() - 60_000);
    await getPool().query(
      "UPDATE compute_funding_reservations SET dispatched_at=$2 WHERE id=$1",
      [binding.reservation_id, runStart],
    );
    const end = new Date();
    const usage = {
      account_id: payer,
      binding,
      running_started_at: runStart.toISOString(),
      running_until: end.toISOString(),
      public_egress_bytes: 20_000_000_000,
      egress_complete_through: end.toISOString(),
    };
    const result = await settleComputeVmFundingLocal(usage);
    expect(result.overrun).toBe(true);
    expect(Number(result.charged_usd)).toBeCloseTo(1.1, 2);
    expect(await settleComputeVmFundingLocal(usage)).toEqual(result);
    await expect(
      checkComputeVmFundingLocal({ account_id: payer, binding }),
    ).rejects.toThrow(/egress authorization/);
    await getPool().query(
      "UPDATE compute_funding_grants SET state='revoked' WHERE id=$1",
      [binding.source.grant_id],
    );
    await settleComputeVmFundingLocal({
      ...usage,
      stopped_until: end.toISOString(),
      deleted: true,
      egress_finalized: false,
    });
    const {
      rows: [pending],
    } = await getPool().query(
      "SELECT state,released_usd FROM compute_funding_reservations WHERE id=$1",
      [binding.reservation_id],
    );
    expect(pending.state).toBe("settling");
    expect(Number(pending.released_usd)).toBe(0);
    await settleComputeVmFundingLocal({
      ...usage,
      stopped_until: end.toISOString(),
      deleted: true,
      egress_finalized: true,
    });
    const {
      rows: [settled],
    } = await getPool().query(
      "SELECT state,authorized_usd,spent_usd,released_usd FROM compute_funding_reservations WHERE id=$1",
      [binding.reservation_id],
    );
    expect(settled.state).toBe("settled");
    expect(
      Number(settled.spent_usd) + Number(settled.released_usd),
    ).toBeCloseTo(Number(settled.authorized_usd), 8);
    const { rows: purchases } = await getPool().query(
      "SELECT account_id,cost FROM purchases WHERE tag=$1",
      [`course-compute:${binding.funding_epoch}`],
    );
    expect(purchases).toHaveLength(1);
    expect(purchases[0].account_id).toBe(payer);
    expect(purchases[0].account_id).not.toBe(student);
    expect(purchases[0].cost).not.toBeNull();
  });

  it("does not convert an expired service reservation into student debt", async () => {
    const { request, payer } = await fixture("nebius");
    const binding = await reserveComputeVmFundingLocal(request);
    await getPool().query(
      "UPDATE compute_funding_grants SET ends_at=NOW()-interval '1 second' WHERE id=$1",
      [binding.source.grant_id],
    );
    await expect(
      checkComputeVmFundingLocal({
        account_id: payer,
        binding,
        dispatch: true,
      }),
    ).rejects.toThrow(/expired/);
    const {
      rows: [row],
    } = await getPool().query(
      "SELECT released_usd,dispatched_at FROM compute_funding_reservations WHERE id=$1",
      [binding.reservation_id],
    );
    expect(Number(row.released_usd)).toBe(0);
    expect(row.dispatched_at).toBeNull();
  });
});

describe("VM quote and precise cumulative metering", () => {
  it("retains the full runway quote while honoring a one-minute stop and ten-minute deletion", () => {
    const now = new Date("2026-09-12T00:00:00Z");
    const request = {
      hourly_cost_usd: "6",
      storage_hourly_cost_usd: "0.01",
      requested_until: new Date(now.valueOf() + 25 * 60_000).toISOString(),
    };
    const full = quoteVmFundingAdmission(request, now);
    const short = quoteVmFundingAdmission(
      {
        ...request,
        requested_stop_at: new Date(now.valueOf() + 60_000).toISOString(),
        requested_delete_at: new Date(
          now.valueOf() + 10 * 60_000,
        ).toISOString(),
      },
      now,
    );
    expect(short.authorized_usd).toBe(full.authorized_usd);
    expect(short.protected_usd).toBe(full.protected_usd);
    expect(short.stop_at).toBe("2026-09-12T00:01:00.000Z");
    expect(short.authorized_until).toBe("2026-09-12T00:06:00.000Z");
    expect(short.storage_delete_at).toBe("2026-09-12T00:10:00.000Z");
  });
  it("reserves useful service and 72-hour storage before admitting a costly VM", () => {
    const now = new Date("2026-09-12T00:00:00Z");
    const quote = quoteVmFunding({
      hourly_cost_usd: "100",
      storage_hourly_cost_usd: "1",
      now,
      until: new Date(now.valueOf() + 20 * 60_000),
    });
    expect(Number(quote.authorized_usd)).toBeGreaterThan(105);
    expect(() =>
      quoteVmFunding({
        hourly_cost_usd: "100",
        storage_hourly_cost_usd: "1",
        now,
        until: new Date(now.valueOf() + 60_000),
      }),
    ).toThrow(/fifteen/);
  });
  it("carries micro-cost through ticks instead of rounding each tick to zero", () => {
    expect(cumulativeVmCharge("0.01", 60_000, "1").charged).toBe(
      "0.0000000000",
    );
    expect(cumulativeVmCharge("0.01", 3600_000, "1").charged).toBe(
      "0.0100000000",
    );
    expect(cumulativeVmCharge("100", 3600_000, "0.01").charged).toBe(
      "0.0100000000",
    );
  });
});

describe("persisted provider running intervals", () => {
  async function vmFixture(provider: "gcp" | "nebius" = "nebius") {
    const f = await fixture(provider);
    const binding = await reserveComputeVmFundingLocal(f.request);
    const start = new Date(Date.now() - 120_000);
    const observed = new Date(start.valueOf() + 60_000);
    await getPool().query(
      `INSERT INTO compute_vms
      (id,owner_account_id,owning_bay_id,provider,instance_generation,state,desired_state,metadata)
      VALUES ($1,$2,$3,$5,1,'starting','running',$4)`,
      [
        binding.resource_id,
        f.student,
        getConfiguredBayId(),
        {
          billing: {
            course_funding: {
              source: binding.source,
              funding_epoch: binding.funding_epoch,
              binding,
            },
          },
          provider_observation: {
            state: "running",
            observed_at: observed.toISOString(),
          },
        },
        provider,
      ],
    );
    const vm = (await getComputeVmById(binding.resource_id))!;
    const dispatch = async () => {
      await checkComputeVmFundingLocal({
        account_id: f.payer,
        binding,
        dispatch: true,
      });
      await getPool().query(
        "UPDATE compute_funding_reservations SET dispatched_at=$2 WHERE id=$1",
        [binding.reservation_id, new Date(start.valueOf() - 300_000)],
      );
    };
    const running = async () => {
      await dispatch();
      await getPool().query(
        "INSERT INTO compute_vm_instances (id,vm_id,generation,running_at) VALUES ($1,$2,1,$3)",
        [randomUUID(), vm.id, start],
      );
    };
    return { ...f, binding, vm, start, observed, dispatch, running };
  }

  it("advances GCP egress from a microsecond creation timestamp and releases the deleted reservation once", async () => {
    const f = await vmFixture("gcp");
    await f.running();
    await getPool().query(
      "UPDATE compute_vms SET created_at=$2::timestamptz + interval '5 microseconds',metadata=jsonb_set(metadata,'{billing,egress}','{\"error\":\"previous provider error\"}') WHERE id=$1",
      [f.vm.id, new Date(f.start.valueOf() - 1000)],
    );
    const initial = (await getComputeVmById(f.vm.id))!;
    await meterCourseVmEgress(initial, {
      bytes: 1000,
      start: initial.created_at,
      end: f.observed,
      finalize: false,
    });
    const metered = (await getComputeVmById(f.vm.id))!;
    expect(metered.metadata.billing.egress.metered_through_at).toBe(
      f.observed.toISOString(),
    );
    expect(metered.metadata.billing.egress.total_bytes).toBe(1000);
    expect(metered.metadata.billing.egress.error).toBeNull();
    const stop = new Date(f.observed.valueOf() + 30_000);
    await getPool().query(
      "UPDATE compute_vms SET stopped_at=$2,deleted_at=$2,state='deleted' WHERE id=$1",
      [f.vm.id, stop],
    );
    const final = { bytes: 2000, start: f.observed, end: stop, finalize: true };
    await meterCourseVmEgress(metered, final);
    await meterCourseVmEgress(metered, final);
    const closed = (await getComputeVmById(f.vm.id))!;
    expect(closed.metadata.billing.egress.total_bytes).toBe(3000);
    expect(closed.metadata.billing.egress.finalized).toBe(true);
    const {
      rows: [reservation],
    } = await getPool().query(
      "SELECT state,spent_usd,released_usd,authorized_usd FROM compute_funding_reservations WHERE id=$1",
      [f.binding.reservation_id],
    );
    expect(reservation.state).toBe("settled");
    expect(
      Number(reservation.spent_usd) + Number(reservation.released_usd),
    ).toBe(Number(reservation.authorized_usd));
  });

  it("does not charge a reservation or dispatch, including failed create and cleanup", async () => {
    const f = await vmFixture();
    expect(Number((await meterCourseVm(f.vm))!.charged_usd)).toBe(0);
    await f.dispatch();
    expect(Number((await meterCourseVm(f.vm, true))!.charged_usd)).toBe(0);
    const {
      rows: [pending],
    } = await getPool().query(
      "SELECT state,released_usd FROM compute_funding_reservations WHERE id=$1",
      [f.binding.reservation_id],
    );
    expect(pending.state).toBe("dispatched");
    expect(Number(pending.released_usd)).toBe(0);
    await getPool().query(
      "UPDATE compute_vms SET deleted_at=NOW(),state='deleted' WHERE id=$1",
      [f.vm.id],
    );
    expect(Number((await meterCourseVm(f.vm))!.charged_usd)).toBe(0);
    const {
      rows: [closed],
    } = await getPool().query(
      "SELECT state,released_usd FROM compute_funding_reservations WHERE id=$1",
      [f.binding.reservation_id],
    );
    expect(closed.state).toBe("settled");
    expect(closed.released_usd).toBe(f.binding.authorized_usd);
  });

  it("charges only persisted running observations, not dispatch latency or polling time", async () => {
    const f = await vmFixture();
    await f.running();
    expect(Number((await meterCourseVm(f.vm))!.charged_usd)).toBe(0.1);
    expect(Number((await meterCourseVm(f.vm))!.charged_usd)).toBe(0.1);
    const {
      rows: [row],
    } = await getPool().query(
      "SELECT pricing_snapshot->'meter' AS meter FROM compute_funding_reservations WHERE id=$1",
      [f.binding.reservation_id],
    );
    expect(row.meter.running_started_at).toBe(f.start.toISOString());
    expect(row.meter.running_until).toBe(f.observed.toISOString());
  });

  it("reloads actual stop boundaries despite a stale running VM and accepts late RPCs without a rewind failure", async () => {
    const f = await vmFixture();
    await f.running();
    await meterCourseVm(f.vm);
    const stop = new Date(f.start.valueOf() + 90_000);
    await getPool().query(
      "UPDATE compute_vms SET stopped_at=$2,deleted_at=$2,state='deleted' WHERE id=$1",
      [f.vm.id, stop],
    );
    await getPool().query(
      "UPDATE compute_vm_instances SET stopped_at=$2,deleted_at=$2 WHERE vm_id=$1",
      [f.vm.id, stop],
    );
    expect(Number((await meterCourseVm(f.vm))!.charged_usd)).toBe(0.15);
    const late = await settleComputeVmFundingLocal({
      account_id: f.payer,
      binding: f.binding,
      running_started_at: f.start.toISOString(),
      running_until: f.observed.toISOString(),
      meter_as_of: f.observed.toISOString(),
    });
    expect(Number(late.charged_usd)).toBe(0.15);
    expect(Number((await meterCourseVm(f.vm))!.charged_usd)).toBe(0.15);
  });

  it("does not use an old funding epoch or another generation's running start", async () => {
    const f = await vmFixture();
    await f.dispatch();
    await getPool().query(
      "INSERT INTO compute_vm_instances (id,vm_id,generation,running_at) VALUES ($1,$2,0,$3)",
      [randomUUID(), f.vm.id, f.start],
    );
    expect(Number((await meterCourseVm(f.vm))!.charged_usd)).toBe(0);
    await getPool().query(
      "UPDATE compute_vms SET metadata=jsonb_set(metadata,'{billing,course_funding,funding_epoch}',to_jsonb($2::text)) WHERE id=$1",
      [f.vm.id, randomUUID()],
    );
    expect(await meterCourseVm(f.vm)).toBeUndefined();
  });
});
