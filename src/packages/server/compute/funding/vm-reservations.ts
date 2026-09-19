/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import {
  assertFundingExposureAvailable,
  loadFundingExposureBudget,
} from "./exposure";
import type { PoolClient } from "@cocalc/database/pool";
import {
  ComputeFundingError,
  fundingAmount,
  fundingBudgetSummary,
  fundingDate,
  fundingId,
} from "@cocalc/util/compute-funding";
import type {
  CheckComputeVmFundingRequest,
  ComputeVmFundingBinding,
  ReserveComputeVmFundingRequest,
  ComputeVmFundingSource,
} from "@cocalc/util/compute-vm-funding";
import { moneyRound2Up, moneyToDbString, toDecimal } from "@cocalc/util/money";
import {
  fundingAuthorityEpoch,
  withFundingAccountTransaction,
} from "./backing";
import type { CourseFundingPoolRow, CourseFundingGrantRow } from "./pools";
import {
  assertComputeFundingServicePolicy,
  getComputeFundingPolicyInTransaction,
} from "./policy";

export const VM_FUNDING_RUN_MS = 15 * 60_000;
export const VM_FUNDING_MARGIN_MS = 5 * 60_000;
export const VM_FUNDING_STORAGE_MS = 72 * 3600_000;

export interface VmFundingReservation {
  id: string;
  payer_account_id: string;
  pool_id: string;
  grant_id: string;
  resource_id: string;
  resource_generation: number;
  funding_epoch: string;
  authorized_usd: string;
  spent_usd: string;
  released_usd: string;
  protected_usd: string;
  authorized_until: Date;
  dispatched_at: Date | null;
  state: string;
  request_hash: string;
  pricing_snapshot: {
    request: Omit<ReserveComputeVmFundingRequest, "source"> & {
      source: ComputeVmFundingSource;
    };
    binding: ComputeVmFundingBinding;
    meter?: {
      running_started_at?: string | null;
      meter_as_of?: string;
      running_until: string;
      stopped_until?: string;
      public_egress_bytes?: number;
      egress_complete_through?: string;
      egress_finalized?: boolean;
      platform_overrun_usd?: string;
      transferred_at?: string;
      successor_reservation_id?: string;
    };
  };
}

export function fundingConflict(message: string): never {
  throw new ComputeFundingError("funding_unavailable", message);
}

export function quoteVmFunding(opts: {
  hourly_cost_usd: string;
  storage_hourly_cost_usd: string;
  now: Date;
  until: Date;
}) {
  const runRate = fundingAmount(opts.hourly_cost_usd, { positive: true });
  const storageRate = fundingAmount(opts.storage_hourly_cost_usd, {
    positive: true,
  });
  const duration = opts.until.valueOf() - opts.now.valueOf();
  if (
    !Number.isFinite(duration) ||
    duration < VM_FUNDING_RUN_MS + VM_FUNDING_MARGIN_MS
  )
    fundingConflict(
      "Funding must cover fifteen useful minutes plus the shutdown margin.",
    );
  const protectedUsd = moneyRound2Up(
    toDecimal(storageRate)
      .mul(VM_FUNDING_STORAGE_MS + duration + VM_FUNDING_MARGIN_MS)
      .div(3600_000),
  );
  const service = moneyRound2Up(toDecimal(runRate).mul(duration).div(3600_000));
  return {
    authorized_usd: moneyToDbString(service.plus(protectedUsd)),
    protected_usd: moneyToDbString(protectedUsd),
    stop_at: new Date(
      opts.until.valueOf() - VM_FUNDING_MARGIN_MS,
    ).toISOString(),
    storage_delete_at: new Date(
      opts.until.valueOf() + VM_FUNDING_STORAGE_MS,
    ).toISOString(),
  };
}

export async function lockVmFundingSource(
  client: PoolClient,
  payer: string,
  poolId: string,
  grantId: string,
) {
  const {
    rows: [pool],
  } = await client.query<CourseFundingPoolRow>(
    "SELECT * FROM compute_funding_pools WHERE id=$1 AND payer_account_id=$2 FOR UPDATE",
    [poolId, payer],
  );
  const {
    rows: [grant],
  } = await client.query<CourseFundingGrantRow>(
    "SELECT * FROM compute_funding_grants WHERE id=$1 AND pool_id=$2 FOR UPDATE",
    [grantId, poolId],
  );
  if (!pool || !grant)
    fundingConflict(
      "Course funding source was not found at the payer's home bay.",
    );
  return { pool, grant };
}

/** Timers limit service; the minimum useful-runway quote remains fully backed.
 * A short disposable VM can stop/delete early without forcing a longer run.
 */
export function quoteVmFundingAdmission(
  request: Pick<
    ReserveComputeVmFundingRequest,
    | "hourly_cost_usd"
    | "storage_hourly_cost_usd"
    | "requested_until"
    | "requested_stop_at"
    | "requested_delete_at"
  >,
  now: Date,
) {
  const budgetUntil = new Date(fundingDate(request.requested_until));
  const quote = quoteVmFunding({ ...request, now, until: budgetUntil });
  const stop =
    request.requested_stop_at == null
      ? Infinity
      : new Date(fundingDate(request.requested_stop_at)).valueOf();
  const deletion =
    request.requested_delete_at == null
      ? Infinity
      : new Date(fundingDate(request.requested_delete_at)).valueOf();
  const stopAt = Math.min(new Date(quote.stop_at).valueOf(), stop, deletion);
  const until = new Date(
    Math.min(budgetUntil.valueOf(), stopAt + VM_FUNDING_MARGIN_MS, deletion),
  );
  if (stopAt <= now.valueOf() || until <= now)
    fundingConflict("The VM stop or deletion deadline has already passed.");
  return {
    ...quote,
    stop_at: new Date(stopAt).toISOString(),
    storage_delete_at: new Date(
      Math.min(new Date(quote.storage_delete_at).valueOf(), deletion),
    ).toISOString(),
    authorized_until: until.toISOString(),
  };
}

function requireSourceService(
  pool: CourseFundingPoolRow,
  grant: CourseFundingGrantRow,
  owner: string,
  now: Date,
  until: Date,
) {
  if (grant.beneficiary_account_id !== owner)
    fundingConflict("The allowance beneficiary must be the VM owner.");
  for (const source of [pool, grant]) {
    if (
      !["active", "scheduled"].includes(source.state) ||
      source.starts_at > now ||
      source.ends_at <= now ||
      source.ends_at < until
    )
      fundingConflict(
        "Course funding has expired, is revoked, or does not cover this interval.",
      );
  }
}

export async function fundingEvent(
  client: PoolClient,
  row: VmFundingReservation,
  kind: string,
  details: object,
) {
  const operation = randomUUID();
  await client.query(
    `INSERT INTO compute_funding_events
    (id,payer_account_id,reservation_id,operation_id,request_hash,kind,details)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      row.payer_account_id,
      row.id,
      operation,
      createHash("sha256").update(JSON.stringify(details)).digest("hex"),
      kind,
      details,
    ],
  );
}

/** Internal authenticated owning-bay caller only; account_id routes, never
 * establishes pool ownership. No provider operation occurs in this transaction.
 */
export async function reserveComputeVmFundingLocal(
  request: ReserveComputeVmFundingRequest,
): Promise<ComputeVmFundingBinding> {
  const payer = fundingId(request.account_id, "Payer route");
  for (const id of [
    request.resource_id,
    request.owner_account_id,
    request.funding_epoch,
    request.source.pool_id,
    request.source.grant_id,
  ])
    fundingId(id, "Funding identity");
  if (
    request.source.kind !== "course" ||
    !request.owning_bay_id ||
    !Number.isSafeInteger(request.resource_generation) ||
    request.resource_generation < 1
  )
    fundingConflict("Unsupported sponsored VM source or generation.");
  if (!["gcp", "nebius"].includes(request.provider))
    fundingConflict("Unsupported sponsored provider.");
  if (
    request.resource_kind != null &&
    !["compute-vm", "compute-volume"].includes(request.resource_kind)
  )
    fundingConflict("Unsupported resource kind.");
  const requestHash = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  const exposureBudget = await loadFundingExposureBudget(
    request.owning_bay_id,
    { require_sponsorship_admission: true },
  );
  return withFundingAccountTransaction(payer, async (client) => {
    const { pool, grant } = await lockVmFundingSource(
      client,
      payer,
      request.source.pool_id,
      request.source.grant_id,
    );
    const {
      rows: [existing],
    } = await client.query<VmFundingReservation>(
      "SELECT * FROM compute_funding_reservations WHERE payer_account_id=$1 AND operation_id=$2 FOR UPDATE",
      [payer, request.funding_epoch],
    );
    if (existing) {
      if (existing.request_hash !== requestHash)
        fundingConflict("VM funding retry has different terms.");
      return existing.pricing_snapshot.binding;
    }
    if (request.resource_generation > 1) {
      const predecessorId = fundingId(
        request.previous_reservation_id ?? "",
        "Previous reservation",
      );
      const {
        rows: [previous],
      } = await client.query<VmFundingReservation>(
        "SELECT * FROM compute_funding_reservations WHERE id=$1 AND payer_account_id=$2 FOR UPDATE",
        [predecessorId, payer],
      );
      if (
        !previous ||
        previous.resource_id !== request.resource_id ||
        previous.resource_generation !== request.resource_generation - 1 ||
        previous.pool_id !== pool.id ||
        previous.grant_id !== grant.id ||
        previous.pricing_snapshot.binding.owner_account_id !==
          request.owner_account_id ||
        !previous.pricing_snapshot.meter?.stopped_until ||
        previous.state !== "settling"
      )
        fundingConflict(
          "Sponsored restart requires the preceding stopped reservation.",
        );
    }
    const {
      rows: [{ now }],
    } = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const budgetUntil = new Date(fundingDate(request.requested_until));
    if (
      budgetUntil.valueOf() - now.valueOf() >
      VM_FUNDING_RUN_MS + 2 * VM_FUNDING_MARGIN_MS
    )
      fundingConflict(
        "A sponsored VM authorization must use a bounded service horizon.",
      );
    const policy = await getComputeFundingPolicyInTransaction(client, {
      payer_account_id: payer,
      lane: pool.lane,
      for_service: true,
    });
    // Keep the minimum-runway backing, but do not promise service across a
    // payer window or allowance boundary. Renewals recheck the next window.
    const boundary = Math.min(
      pool.ends_at.valueOf(),
      grant.ends_at.valueOf(),
      ...Object.values(policy.windows).map(({ window }) =>
        window ? window.resets_at.valueOf() : now.valueOf(),
      ),
    );
    const baseQuote = quoteVmFundingAdmission(
      {
        ...request,
        requested_stop_at: new Date(
          Math.min(
            request.requested_stop_at == null
              ? Infinity
              : Date.parse(request.requested_stop_at),
            boundary - VM_FUNDING_MARGIN_MS,
          ),
        ).toISOString(),
      },
      now,
    );
    const until = new Date(baseQuote.authorized_until);
    requireSourceService(pool, grant, request.owner_account_id, now, until);
    const egressUsd =
      request.provider === "gcp" && request.resource_kind !== "compute-volume"
        ? fundingAmount(
            process.env.COCALC_COURSE_VM_EGRESS_RESERVE_USD ?? "1.00",
            { positive: true },
          )
        : "0";
    const quote = {
      ...baseQuote,
      egress_usd: egressUsd,
      authorized_usd: moneyToDbString(
        toDecimal(baseQuote.authorized_usd).plus(egressUsd),
      ),
    };
    await assertFundingExposureAvailable(
      client,
      exposureBudget,
      quote.authorized_usd,
    );
    assertComputeFundingServicePolicy(policy, {
      ...quote,
      authorized_until: until.toISOString(),
    });
    for (const budget of [pool, grant]) {
      if (
        toDecimal(quote.authorized_usd).gt(
          fundingBudgetSummary(budget).available_usd,
        )
      )
        fundingConflict(
          "Insufficient unreserved allowance for quoted compute and protected storage.",
        );
    }
    const binding: ComputeVmFundingBinding = {
      resource_kind: request.resource_kind ?? "compute-vm",
      source: { ...request.source, payer_account_id: payer },
      payer_account_id: payer,
      payer_authority_epoch: fundingAuthorityEpoch(client, payer),
      reservation_id: randomUUID(),
      funding_epoch: request.funding_epoch,
      resource_id: request.resource_id,
      resource_generation: request.resource_generation,
      owner_account_id: request.owner_account_id,
      owning_bay_id: request.owning_bay_id,
      lane: pool.lane,
      ...quote,
      authorized_until: until.toISOString(),
    };
    await client.query(
      "UPDATE compute_funding_pools SET reserved_usd=reserved_usd+$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
      [pool.id, quote.authorized_usd],
    );
    await client.query(
      "UPDATE compute_funding_grants SET reserved_usd=reserved_usd+$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
      [grant.id, quote.authorized_usd],
    );
    const {
      rows: [row],
    } = await client.query<VmFundingReservation>(
      `INSERT INTO compute_funding_reservations
      (id,payer_account_id,pool_id,grant_id,resource_id,resource_generation,resource_kind,funding_epoch,
       operation_id,request_hash,pricing_snapshot,authorized_usd,protected_usd,authorized_until,
       usage_window_5h_id,usage_window_7d_id,state)
      VALUES ($1,$2,$3,$4,$5,$6,$15,$7,$7,$8,$9,$10,$11,$12,$13,$14,'reserved') RETURNING *`,
      [
        binding.reservation_id,
        payer,
        pool.id,
        grant.id,
        request.resource_id,
        request.resource_generation,
        request.funding_epoch,
        requestHash,
        { request, binding },
        quote.authorized_usd,
        quote.protected_usd,
        until,
        policy.windows["5h"].window!.id,
        policy.windows["7d"].window!.id,
        binding.resource_kind,
      ],
    );
    // Durable authorization intent; owning-bay reconciliation can retry dispatch.
    await fundingEvent(client, row, "reserved", binding);
    return binding;
  });
}

export async function lockVmFundingReservation(
  client: PoolClient,
  opts: CheckComputeVmFundingRequest,
) {
  const payer = fundingId(opts.account_id, "Payer");
  const binding = opts.binding;
  if (binding.source.kind !== "course")
    fundingConflict("Expected a course reservation.");
  await (
    await import("./authority")
  ).assertFundingReservationAuthority(
    client,
    payer,
    fundingAuthorityEpoch(client, payer),
    binding,
  );
  const source = await lockVmFundingSource(
    client,
    payer,
    binding.source.pool_id,
    binding.source.grant_id,
  );
  const {
    rows: [reservation],
  } = await client.query<VmFundingReservation>(
    "SELECT * FROM compute_funding_reservations WHERE id=$1 AND payer_account_id=$2 FOR UPDATE",
    [binding.reservation_id, payer],
  );
  if (!reservation?.pricing_snapshot?.binding)
    fundingConflict("Missing VM reservation.");
  const canonical = reservation.pricing_snapshot.binding;
  if (
    reservation.pool_id !== source.pool.id ||
    reservation.grant_id !== source.grant.id ||
    canonical.payer_account_id !== payer
  )
    fundingConflict("Reservation funding source mismatch.");
  for (const key of [
    "resource_id",
    "resource_generation",
    "funding_epoch",
    "owner_account_id",
    "owning_bay_id",
    "resource_kind",
  ] as const)
    if (canonical[key] !== binding[key])
      fundingConflict("VM binding does not match its reservation.");
  if (source.grant.beneficiary_account_id !== canonical.owner_account_id)
    fundingConflict("VM beneficiary binding has changed.");
  return { ...source, reservation, binding: canonical };
}

export async function checkComputeVmFundingLocal(
  opts: CheckComputeVmFundingRequest,
): Promise<ComputeVmFundingBinding> {
  if (opts.binding.source.kind === "personal")
    return (await import("./vm-personal-reservations")).checkPersonalVmFunding(
      opts,
    );
  const exposureBudget = opts.renew_until
    ? await loadFundingExposureBudget(opts.binding.owning_bay_id, {
        require_sponsorship_admission: true,
      })
    : undefined;
  return withFundingAccountTransaction(opts.account_id, async (client) => {
    const { pool, grant, reservation, binding } =
      await lockVmFundingReservation(client, opts);
    const {
      rows: [{ now }],
    } = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    if (
      ["settled", "settling"].includes(reservation.state) ||
      now >= new Date(binding.stop_at)
    )
      fundingConflict("VM service authorization has ended.");
    if (
      reservation.pricing_snapshot.request.provider === "gcp" &&
      binding.resource_kind !== "compute-volume"
    ) {
      const meter = reservation.pricing_snapshot.meter;
      const bytes = meter?.public_egress_bytes ?? 0;
      if (
        toDecimal(bytes).div(1_000_000_000).mul("0.1").gte(binding.egress_usd)
      )
        fundingConflict("Sponsored VM egress authorization is exhausted.");
      if (
        reservation.dispatched_at &&
        now.valueOf() -
          new Date(
            meter?.egress_complete_through ?? reservation.dispatched_at,
          ).valueOf() >
          15 * 60_000
      )
        fundingConflict("Sponsored VM egress observations are stale.");
    }
    requireSourceService(
      pool,
      grant,
      binding.owner_account_id,
      now,
      reservation.authorized_until,
    );
    const policy = await getComputeFundingPolicyInTransaction(client, {
      payer_account_id: opts.account_id,
      lane: pool.lane,
      for_service: true,
    });
    assertComputeFundingServicePolicy(policy, {
      authorized_usd: reservation.authorized_usd,
      authorized_until: binding.authorized_until,
      already_reserved: true,
    });
    if (opts.renew_until) {
      await assertFundingExposureAvailable(client, exposureBudget!, "0");
      const original = reservation.pricing_snapshot.request;
      const until = new Date(
        Math.min(
          new Date(fundingDate(opts.renew_until)).valueOf(),
          pool.ends_at.valueOf(),
          grant.ends_at.valueOf(),
          policy.windows["5h"].window!.resets_at.valueOf(),
          policy.windows["7d"].window!.resets_at.valueOf(),
          now.valueOf() + VM_FUNDING_RUN_MS + VM_FUNDING_MARGIN_MS,
          original.requested_stop_at
            ? new Date(original.requested_stop_at).valueOf() +
                VM_FUNDING_MARGIN_MS
            : Infinity,
          original.requested_delete_at
            ? new Date(original.requested_delete_at).valueOf()
            : Infinity,
        ),
      );
      if (until > reservation.authorized_until) {
        const deltaMs =
          until.valueOf() - reservation.authorized_until.valueOf();
        const request = reservation.pricing_snapshot.request;
        const service = moneyRound2Up(
          toDecimal(request.hourly_cost_usd).mul(deltaMs).div(3600_000),
        );
        const storage = moneyRound2Up(
          toDecimal(request.storage_hourly_cost_usd).mul(deltaMs).div(3600_000),
        );
        const additional = moneyToDbString(service.plus(storage));
        assertComputeFundingServicePolicy(policy, {
          authorized_usd: additional,
          authorized_until: until.toISOString(),
        });
        for (const budget of [pool, grant])
          if (
            toDecimal(additional).gt(fundingBudgetSummary(budget).available_usd)
          )
            fundingConflict(
              "Course funding cannot cover the next service interval.",
            );
        await assertFundingExposureAvailable(
          client,
          exposureBudget!,
          additional,
        );
        binding.authorized_until = until.toISOString();
        binding.stop_at = new Date(
          until.valueOf() - VM_FUNDING_MARGIN_MS,
        ).toISOString();
        binding.storage_delete_at = new Date(
          Math.min(
            until.valueOf() + VM_FUNDING_STORAGE_MS,
            original.requested_delete_at
              ? new Date(original.requested_delete_at).valueOf()
              : Infinity,
          ),
        ).toISOString();
        binding.authorized_usd = moneyToDbString(
          toDecimal(binding.authorized_usd).plus(additional),
        );
        binding.protected_usd = moneyToDbString(
          toDecimal(binding.protected_usd).plus(storage),
        );
        await client.query(
          "UPDATE compute_funding_pools SET reserved_usd=reserved_usd+$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
          [pool.id, additional],
        );
        await client.query(
          "UPDATE compute_funding_grants SET reserved_usd=reserved_usd+$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
          [grant.id, additional],
        );
        await client.query(
          `UPDATE compute_funding_reservations SET authorized_usd=authorized_usd+$2,protected_usd=protected_usd+$3,
          authorized_until=$4,pricing_snapshot=jsonb_set(pricing_snapshot,'{binding}',$5::jsonb),updated_at=clock_timestamp() WHERE id=$1`,
          [
            reservation.id,
            additional,
            moneyToDbString(storage),
            until,
            JSON.stringify(binding),
          ],
        );
        await fundingEvent(client, reservation, "renewed", binding);
      }
    }
    if (opts.dispatch && !reservation.dispatched_at) {
      await client.query(
        "UPDATE compute_funding_reservations SET dispatched_at=clock_timestamp(),state='dispatched',updated_at=clock_timestamp() WHERE id=$1",
        [reservation.id],
      );
      await fundingEvent(client, reservation, "dispatched", binding);
    }
    return binding;
  });
}
