/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import type {
  SettleComputeVmFundingRequest,
  ComputeVmFundingSettlement,
} from "@cocalc/util/compute-vm-funding";
import { fundingDate } from "@cocalc/util/compute-funding";
import {
  moneyRoundToCents,
  moneyToDbString,
  toDecimal,
} from "@cocalc/util/money";
import {
  reduceAccountFundingBacking,
  withFundingAccountTransaction,
} from "./backing";
import {
  fundingConflict,
  fundingEvent,
  lockVmFundingReservation,
} from "./vm-reservations";
import { lockPersonalVmReservation } from "./vm-personal-reservations";

/** Exact cumulative metering, rounded only against the cumulative posted total.
 * The remainder survives polling ticks and duplicate observations.
 */
export function cumulativeVmCharge(
  rate: string,
  milliseconds: number,
  ceiling: string,
): { exact: string; charged: string } {
  const exact = toDecimal(rate).mul(Math.max(0, milliseconds)).div(3600_000);
  const bounded = exact.gt(ceiling) ? toDecimal(ceiling) : exact;
  return {
    exact: moneyToDbString(bounded),
    charged: moneyToDbString(moneyRoundToCents(bounded)),
  };
}

export async function settleComputeVmFundingLocal(
  opts: SettleComputeVmFundingRequest,
): Promise<ComputeVmFundingSettlement> {
  return withFundingAccountTransaction(opts.account_id, async (client) => {
    const source =
      opts.binding.source.kind === "personal"
        ? await lockPersonalVmReservation(client, opts)
        : await lockVmFundingReservation(client, opts);
    const { pool, grant, reservation: row, binding } = source;
    const {
      rows: [{ now }],
    } = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const runEnd = new Date(fundingDate(opts.running_until));
    const storageEnd =
      opts.stopped_until == null
        ? undefined
        : new Date(fundingDate(opts.stopped_until));
    if (
      runEnd > now ||
      (storageEnd && (storageEnd < runEnd || storageEnd > now))
    )
      fundingConflict("Invalid trusted VM metering interval.");
    const previous = row.pricing_snapshot.meter;
    const meterAsOf = new Date(
      fundingDate(opts.meter_as_of ?? opts.stopped_until ?? opts.running_until),
    );
    const runStart =
      opts.running_started_at == null
        ? undefined
        : new Date(fundingDate(opts.running_started_at));
    if (
      meterAsOf > now ||
      runEnd > meterAsOf ||
      (storageEnd && storageEnd > meterAsOf) ||
      (runStart &&
        (runStart > runEnd ||
          !row.dispatched_at ||
          runStart < row.dispatched_at))
    )
      fundingConflict("Invalid persisted VM running interval.");
    // Owning-bay reads can arrive out of order across RPC or sweep workers.
    // Older observations are no-ops, not permanent no-rewind settlement errors.
    if (previous?.meter_as_of && meterAsOf < new Date(previous.meter_as_of))
      return {
        charged_usd: row.spent_usd,
        authorized_usd: row.authorized_usd,
        overrun: toDecimal(previous.platform_overrun_usd ?? 0).gt(0),
      };
    if (
      previous?.running_started_at &&
      previous.running_started_at !== runStart?.toISOString()
    )
      fundingConflict(
        "VM running interval start changed within a funding epoch.",
      );
    const transferredAt = opts.transferred_at ?? previous?.transferred_at;
    const successorId =
      opts.successor_reservation_id ?? previous?.successor_reservation_id;
    if (transferredAt || successorId) {
      if (
        !transferredAt ||
        !successorId ||
        !storageEnd ||
        storageEnd.toISOString() !== fundingDate(transferredAt) ||
        (previous?.transferred_at && previous.transferred_at !== transferredAt)
      )
        fundingConflict("Invalid VM funding handoff interval.");
      const {
        rows: [successor],
      } = await client.query(
        `SELECT r.id FROM compute_funding_reservations r JOIN compute_vms v ON v.id=r.resource_id
        WHERE r.id=$1 AND r.resource_id=$2 AND r.id<>$3 AND r.state<>'settled'
          AND v.owner_account_id=$4 AND v.metadata#>>'{billing,course_funding,binding,reservation_id}'=r.id::text`,
        [successorId, binding.resource_id, row.id, binding.owner_account_id],
      );
      if (!successor && !previous?.transferred_at)
        fundingConflict("Successor VM funding has not committed.");
    }
    const egressBytes =
      opts.public_egress_bytes ?? previous?.public_egress_bytes ?? 0;
    if (
      !Number.isSafeInteger(egressBytes) ||
      egressBytes < (previous?.public_egress_bytes ?? 0)
    )
      fundingConflict("Egress meter must be a monotonic safe integer.");
    const completeThrough =
      opts.egress_complete_through ?? previous?.egress_complete_through;
    if (
      completeThrough &&
      (new Date(fundingDate(completeThrough)) > now ||
        (previous?.egress_complete_through &&
          new Date(completeThrough) <
            new Date(previous.egress_complete_through)))
    )
      fundingConflict(
        "Egress watermark cannot rewind or extend into the future.",
      );
    if (previous?.running_started_at) {
      if (
        runEnd < new Date(previous.running_until) ||
        (previous.stopped_until &&
          (runEnd.valueOf() !== new Date(previous.running_until).valueOf() ||
            !storageEnd ||
            storageEnd < new Date(previous.stopped_until)))
      )
        return {
          charged_usd: row.spent_usd,
          authorized_usd: row.authorized_usd,
          overrun: toDecimal(previous.platform_overrun_usd ?? 0).gt(0),
        };
    }
    if (row.state === "settled")
      return {
        charged_usd: row.spent_usd,
        authorized_usd: row.authorized_usd,
        overrun: false,
      };
    const request = row.pricing_snapshot.request;
    const runMs = runStart
      ? Math.max(
          0,
          Math.min(runEnd.valueOf(), row.authorized_until.valueOf()) -
            runStart.valueOf(),
        )
      : 0;
    const storageMs =
      runStart && storageEnd
        ? Math.max(
            0,
            Math.min(
              storageEnd.valueOf(),
              new Date(binding.storage_delete_at).valueOf(),
            ) - runEnd.valueOf(),
          )
        : 0;
    const running = cumulativeVmCharge(
      request.hourly_cost_usd,
      runMs,
      moneyToDbString(
        toDecimal(binding.authorized_usd)
          .minus(binding.protected_usd)
          .minus(binding.egress_usd),
      ),
    );
    const storage = cumulativeVmCharge(
      request.storage_hourly_cost_usd,
      storageMs,
      binding.protected_usd,
    );
    const egressExact =
      request.provider === "gcp"
        ? toDecimal(egressBytes).div(1_000_000_000).mul("0.1")
        : toDecimal(0);
    const egress = egressExact.gt(binding.egress_usd)
      ? toDecimal(binding.egress_usd)
      : egressExact;
    const exact = toDecimal(running.exact).plus(storage.exact).plus(egress);
    const charged = moneyRoundToCents(exact);
    const delta = charged.minus(row.spent_usd);
    if (delta.lt(0))
      fundingConflict("VM metering would reverse a posted charge.");
    const protectedRemaining = toDecimal(binding.protected_usd).minus(
      storage.charged,
    );
    const overrun =
      !!(runStart && runEnd > row.authorized_until) ||
      !!(
        runStart &&
        storageEnd &&
        storageEnd > new Date(binding.storage_delete_at)
      ) ||
      egressExact.gt(egress);
    const platformOverrun = toDecimal(request.hourly_cost_usd)
      .mul(
        runStart
          ? Math.max(0, runEnd.valueOf() - row.authorized_until.valueOf())
          : 0,
      )
      .div(3600_000)
      .plus(
        toDecimal(request.storage_hourly_cost_usd)
          .mul(
            runStart && storageEnd
              ? Math.max(
                  0,
                  storageEnd.valueOf() -
                    new Date(binding.storage_delete_at).valueOf(),
                )
              : 0,
          )
          .div(3600_000),
      )
      .plus(egressExact.minus(egress));
    if (delta.gt(0)) {
      // Each ledger segment is closed and has an explicit cost. In particular,
      // no cost_per_hour-only purchase can extrapolate beyond authorization.
      let start =
        previous?.stopped_until ??
        previous?.running_until ??
        runStart?.toISOString() ??
        completeThrough ??
        runEnd.toISOString();
      const end = storageEnd ?? runEnd;
      if (new Date(start) >= end)
        start =
          previous?.egress_complete_through ?? runStart?.toISOString() ?? start;
      const exactWithCarry = exact.minus(row.spent_usd);
      const operation = randomUUID();
      const purchaseId = await createPurchase({
        client,
        account_id: opts.account_id,
        service: "dedicated-host",
        cost: delta,
        unrounded_cost: exactWithCarry,
        time: end,
        period_start: new Date(start),
        period_end: end,
        tag: `course-compute:${binding.funding_epoch}`,
        description: {
          type: "dedicated-host",
          host_id: binding.resource_id,
          resource_kind: binding.resource_kind ?? "compute-vm",
          product_kind:
            binding.resource_kind === "compute-volume"
              ? undefined
              : "virtual-machine",
          provider: request.provider,
          funding_lane: binding.lane === "prepaid" ? "prepaid" : "credit",
          hourly_cost_usd: request.hourly_cost_usd,
        },
      });
      await client.query(
        `INSERT INTO compute_funding_purchase_attributions
        (purchase_id,payer_account_id,reservation_id,operation_id,request_hash,started_at,ended_at,exact_cost_usd,charged_usd)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          purchaseId,
          opts.account_id,
          row.id,
          operation,
          createHash("sha256").update(JSON.stringify(opts)).digest("hex"),
          start,
          end,
          moneyToDbString(exactWithCarry),
          moneyToDbString(delta),
        ],
      );
      await reduceAccountFundingBacking(client, {
        payer_account_id: opts.account_id,
        hold_id: pool ? pool.hold_id : source.hold_id!,
        amount_usd: moneyToDbString(delta),
      });
    }
    // A validated handoff ends network use at the confirmed stop, but bills
    // retained storage until cutover. Its frozen egress snapshot need not cover
    // that later storage-only interval. Deletion still requires its own watermark.
    const finalized =
      (opts.deleted === true || !!transferredAt) &&
      (request.provider === "nebius" ||
        binding.resource_kind === "compute-volume" ||
        (opts.egress_finalized === true &&
          completeThrough != null &&
          new Date(completeThrough) >=
            (transferredAt ? runEnd : (storageEnd ?? runEnd))));
    const release = finalized
      ? toDecimal(row.authorized_usd).minus(charged).minus(row.released_usd)
      : toDecimal(0);
    const reduction = moneyToDbString(delta.plus(release));
    if (pool && grant) {
      await client.query(
        "UPDATE compute_funding_pools SET spent_usd=spent_usd+$2,reserved_usd=reserved_usd-$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [pool.id, moneyToDbString(delta), reduction],
      );
      await client.query(
        "UPDATE compute_funding_grants SET spent_usd=spent_usd+$2,reserved_usd=reserved_usd-$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [grant.id, moneyToDbString(delta), reduction],
      );
    } else {
      await client.query(
        "UPDATE compute_vm_personal_consents SET spent_usd=spent_usd+$2,committed_usd=committed_usd-$3,updated_at=clock_timestamp() WHERE id=$1",
        [source.consent!.id, moneyToDbString(delta), reduction],
      );
      if (release.gt(0))
        await reduceAccountFundingBacking(client, {
          payer_account_id: opts.account_id,
          hold_id: source.hold_id!,
          amount_usd: moneyToDbString(release),
        });
    }
    const meter = {
      running_started_at: runStart?.toISOString() ?? null,
      meter_as_of: meterAsOf.toISOString(),
      running_until: runEnd.toISOString(),
      stopped_until: storageEnd?.toISOString(),
      public_egress_bytes: egressBytes,
      egress_complete_through: completeThrough,
      egress_finalized:
        opts.egress_finalized ?? previous?.egress_finalized ?? false,
      platform_overrun_usd: moneyToDbString(platformOverrun),
      transferred_at: transferredAt,
      successor_reservation_id: successorId,
    };
    await client.query(
      `UPDATE compute_funding_reservations SET spent_usd=$2,released_usd=released_usd+$3,
      protected_usd=$4,state=$5,pricing_snapshot=jsonb_set(pricing_snapshot,'{meter}',$6::jsonb),updated_at=clock_timestamp() WHERE id=$1`,
      [
        row.id,
        moneyToDbString(charged),
        moneyToDbString(release),
        finalized ? "0" : moneyToDbString(protectedRemaining),
        finalized
          ? "settled"
          : storageEnd || opts.deleted
            ? "settling"
            : runStart
              ? "consuming"
              : row.state,
        JSON.stringify(meter),
      ],
    );
    await fundingEvent(client, row, overrun ? "uncertain" : "charged", {
      ...meter,
      delta_usd: moneyToDbString(delta),
      released_usd: moneyToDbString(release),
      cumulative_exact_usd: moneyToDbString(exact),
      overrun,
      deleted: opts.deleted === true,
    });
    return {
      charged_usd: moneyToDbString(charged),
      authorized_usd: row.authorized_usd,
      overrun,
    };
  });
}
