/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import type {
  ComputeVmFundingBinding,
  CheckComputeVmFundingRequest,
  VmPersonalFundingTerms,
} from "@cocalc/util/compute-vm-funding";
import type { ComputeVmRow, ComputeVolumeRow } from "../types";
import { fundingAmount, fundingDate } from "@cocalc/util/compute-funding";
import { moneyRound2Up, moneyToDbString, toDecimal } from "@cocalc/util/money";
import {
  fundingAuthorityEpoch,
  reserveAccountFundingBacking,
  withFundingAccountTransaction,
} from "./backing";
import {
  assertComputeFundingServicePolicy,
  getComputeFundingPolicyInTransaction,
} from "./policy";
import {
  fundingConflict,
  fundingEvent,
  quoteVmFundingAdmission,
  VM_FUNDING_MARGIN_MS,
  VM_FUNDING_STORAGE_MS,
} from "./vm-reservations";
import type { VmFundingReservation } from "./vm-reservations";
import {
  assertFundingExposureAvailable,
  loadFundingExposureBudget,
} from "./exposure";
import type { FundingExposureBudget } from "./exposure";

interface PersonalConsent {
  id: string;
  payer_account_id: string;
  vm_id: string;
  terms: VmPersonalFundingTerms;
  state: string;
  version: number;
  committed_usd: string;
  spent_usd: string;
}

export async function reservePersonalVmInTransaction(
  client: PoolClient,
  vm: ComputeVmRow,
  consentId: string,
  until: Date,
  exposureBudget: FundingExposureBudget,
): Promise<ComputeVmFundingBinding> {
  return reservePersonalResourceInTransaction(
    client,
    vm,
    consentId,
    until,
    exposureBudget,
  );
}

export async function reservePersonalVolumeInTransaction(
  client: PoolClient,
  vm: ComputeVmRow,
  volume: ComputeVolumeRow,
  consentId: string,
  reservationId: string,
  until: Date,
  exposureBudget: FundingExposureBudget,
  cutover: Date,
): Promise<ComputeVmFundingBinding> {
  const binding = await reservePersonalResourceInTransaction(
    client,
    vm,
    consentId,
    until,
    exposureBudget,
    {
      volume,
      reservationId,
    },
  );
  // The retained disk already exists. Its new funded interval begins at the
  // same atomic cutover as the old interval ends, not at the next worker poll.
  const {
    rows: [row],
  } = await client.query<VmFundingReservation>(
    "UPDATE compute_funding_reservations SET dispatched_at=$2,state='dispatched' WHERE id=$1 AND dispatched_at IS NULL RETURNING *",
    [binding.reservation_id, cutover],
  );
  if (row) await fundingEvent(client, row, "dispatched", binding);
  return binding;
}

async function reservePersonalResourceInTransaction(
  client: PoolClient,
  vm: ComputeVmRow,
  consentId: string,
  until: Date,
  exposureBudget: FundingExposureBudget,
  home?: { volume: ComputeVolumeRow; reservationId: string },
): Promise<ComputeVmFundingBinding> {
  const payer = vm.owner_account_id;
  const resource = home?.volume ?? vm;
  const reservationId = home?.reservationId ?? consentId;
  const resourceKind = home ? "compute-volume" : "compute-vm";
  const {
    rows: [consent],
  } = await client.query<PersonalConsent>(
    "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 AND vm_id=$3 FOR UPDATE",
    [consentId, payer, vm.id],
  );
  if (
    !consent ||
    consent.state !== "preparing" ||
    new Date(consent.terms.ends_at) < until ||
    (home &&
      (!consent.terms.home_volume_ids.includes(resource.id) ||
        resource.owner_account_id !== payer ||
        resource.owning_bay_id !== vm.owning_bay_id))
  )
    fundingConflict("Personal consent no longer authorizes this handoff.");
  const {
    rows: [existing],
  } = await client.query<VmFundingReservation>(
    "SELECT * FROM compute_funding_reservations WHERE id=$1 AND payer_account_id=$2 FOR UPDATE",
    [reservationId, payer],
  );
  if (existing) {
    const binding = existing.pricing_snapshot.binding;
    if (
      binding.resource_id !== resource.id ||
      binding.source.kind !== "personal" ||
      binding.source.consent_id !== consentId ||
      (binding.resource_kind ?? "compute-vm") !== resourceKind
    )
      fundingConflict("Personal reservation retry changed its resource.");
    return binding;
  }
  const now = new Date();
  const rate =
    home?.volume.metadata.billing.rate ??
    vm.metadata.billing.running_rates[vm.effective_pricing_model];
  const storage = home ? rate : vm.metadata.billing.stopped_rate;
  const quote = quoteVmFundingAdmission(
    {
      requested_until: new Date(now.valueOf() + 25 * 60_000).toISOString(),
      requested_stop_at: new Date(
        Math.min(
          until.valueOf() - VM_FUNDING_MARGIN_MS,
          home ? Infinity : (vm.stop_at?.valueOf() ?? Infinity),
        ),
      ).toISOString(),
      requested_delete_at: new Date(
        Math.min(
          new Date(consent.terms.ends_at).valueOf() + VM_FUNDING_STORAGE_MS,
          home ? Infinity : (vm.expires_at?.valueOf() ?? Infinity),
        ),
      ).toISOString(),
      hourly_cost_usd: rate.hourly_cost_usd,
      storage_hourly_cost_usd: storage.hourly_cost_usd,
    },
    now,
  );
  const egress =
    !home && vm.provider === "gcp"
      ? fundingAmount(process.env.COCALC_COURSE_VM_EGRESS_RESERVE_USD ?? "1", {
          positive: true,
        })
      : "0";
  const amount = moneyToDbString(toDecimal(quote.authorized_usd).plus(egress));
  if (
    toDecimal(amount)
      .plus(consent.spent_usd)
      .plus(consent.committed_usd)
      .gt(consent.terms.cap_usd)
  )
    fundingConflict("Personal spending cap cannot cover this reservation.");
  const policy = await getComputeFundingPolicyInTransaction(client, {
    payer_account_id: payer,
    lane: consent.terms.lane,
    for_service: true,
  });
  assertComputeFundingServicePolicy(policy, {
    authorized_usd: amount,
    authorized_until: until.toISOString(),
  });
  await assertFundingExposureAvailable(client, exposureBudget, amount);
  const hold = await reserveAccountFundingBacking(client, {
    payer_account_id: payer,
    source_kind: "resource",
    source_id: reservationId,
    lane: consent.terms.lane,
    authorized_usd: amount,
    capacity_usd: policy.backing_capacity_usd,
  });
  const binding: ComputeVmFundingBinding = {
    source: { kind: "personal", consent_id: consentId },
    payer_account_id: payer,
    payer_authority_epoch: fundingAuthorityEpoch(client, payer),
    reservation_id: reservationId,
    funding_epoch: reservationId,
    resource_kind: resourceKind,
    resource_id: resource.id,
    resource_generation: home
      ? home.volume.metadata.billing.course_funding.binding
          .resource_generation + 1
      : vm.instance_generation + 1,
    owner_account_id: payer,
    owning_bay_id: vm.owning_bay_id,
    lane: consent.terms.lane,
    ...quote,
    authorized_usd: amount,
    egress_usd: egress,
    authorized_until: until.toISOString(),
  };
  const request = {
    account_id: payer,
    source: binding.source,
    resource_id: resource.id,
    resource_kind: resourceKind,
    resource_generation: binding.resource_generation,
    owner_account_id: payer,
    owning_bay_id: vm.owning_bay_id,
    funding_epoch: reservationId,
    provider: resource.provider,
    hourly_cost_usd: rate.hourly_cost_usd,
    storage_hourly_cost_usd: storage.hourly_cost_usd,
    pricing_snapshot: rate.pricing_snapshot,
    requested_until: until.toISOString(),
  };
  const {
    rows: [row],
  } = await client.query<VmFundingReservation>(
    `INSERT INTO compute_funding_reservations
    (id,payer_account_id,personal_hold_id,personal_lane,resource_id,resource_generation,resource_kind,funding_epoch,operation_id,
    request_hash,pricing_snapshot,authorized_usd,protected_usd,authorized_until,usage_window_5h_id,usage_window_7d_id,state)
    VALUES ($1,$2,$3,$4,$5,$6,$14,$1,$1,$7,$8,$9,$10,$11,$12,$13,'reserved') RETURNING *`,
    [
      reservationId,
      payer,
      hold.id,
      consent.terms.lane,
      resource.id,
      binding.resource_generation,
      createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      { request, binding },
      amount,
      binding.protected_usd,
      until,
      policy.windows["5h"].window!.id,
      policy.windows["7d"].window!.id,
      resourceKind,
    ],
  );
  await client.query(
    "UPDATE compute_vm_personal_consents SET committed_usd=committed_usd+$2,updated_at=clock_timestamp() WHERE id=$1",
    [consentId, amount],
  );
  await fundingEvent(client, row, "reserved", binding);
  return binding;
}

export async function lockPersonalVmReservation(
  client: PoolClient,
  opts: CheckComputeVmFundingRequest,
) {
  const supplied = opts.binding;
  if (
    supplied.source.kind !== "personal" ||
    opts.account_id !== supplied.owner_account_id ||
    opts.account_id !== supplied.payer_account_id
  )
    fundingConflict("Stale personal VM authority.");
  await (
    await import("./authority")
  ).assertFundingReservationAuthority(
    client,
    opts.account_id,
    fundingAuthorityEpoch(client, opts.account_id),
    supplied,
  );
  const {
    rows: [consent],
  } = await client.query<PersonalConsent>(
    "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 FOR UPDATE",
    [supplied.source.consent_id, opts.account_id],
  );
  const {
    rows: [hold],
  } = await client.query<{ id: string }>(
    "SELECT id FROM account_funding_holds WHERE payer_account_id=$1 AND source_kind='resource' AND source_id=$2 FOR UPDATE",
    [opts.account_id, supplied.reservation_id],
  );
  const {
    rows: [reservation],
  } = await client.query<VmFundingReservation & { personal_hold_id: string }>(
    "SELECT * FROM compute_funding_reservations WHERE id=$1 AND payer_account_id=$2 FOR UPDATE",
    [supplied.reservation_id, opts.account_id],
  );
  const binding = reservation?.pricing_snapshot?.binding;
  if (
    !consent ||
    !hold ||
    !binding ||
    reservation.personal_hold_id !== hold.id ||
    binding.source.kind !== "personal" ||
    binding.source.consent_id !== consent.id ||
    ((binding.resource_kind ?? "compute-vm") === "compute-volume"
      ? !consent.terms.home_volume_ids.includes(supplied.resource_id)
      : consent.vm_id !== supplied.resource_id) ||
    (binding.resource_kind ?? "compute-vm") !==
      (supplied.resource_kind ?? "compute-vm")
  )
    fundingConflict("Missing personal VM reservation or consent.");
  for (const key of [
    "resource_id",
    "resource_generation",
    "funding_epoch",
    "owner_account_id",
    "owning_bay_id",
    "payer_account_id",
  ] as const)
    if (binding[key] !== supplied[key])
      fundingConflict("Personal VM binding changed.");
  return {
    reservation,
    binding,
    consent,
    hold_id: hold.id,
    pool: null,
    grant: null,
  };
}

export async function checkPersonalVmFunding(
  opts: CheckComputeVmFundingRequest,
): Promise<ComputeVmFundingBinding> {
  const exposureBudget = opts.renew_until
    ? await loadFundingExposureBudget(opts.binding.owning_bay_id)
    : undefined;
  return withFundingAccountTransaction(opts.account_id, async (client) => {
    const { reservation, binding, consent, hold_id } =
      await lockPersonalVmReservation(client, opts);
    const now = new Date();
    if (
      consent.state !== "active" ||
      new Date(consent.terms.ends_at) <= now ||
      new Date(binding.stop_at) <= now ||
      ["settled", "settling"].includes(reservation.state)
    )
      fundingConflict("Personal VM funding authorization ended.");
    const meter = reservation.pricing_snapshot.meter;
    if (
      binding.resource_kind !== "compute-volume" &&
      reservation.pricing_snapshot.request.provider === "gcp"
    ) {
      if (
        toDecimal(meter?.public_egress_bytes ?? 0)
          .div(1e9)
          .mul("0.1")
          .gte(binding.egress_usd)
      )
        fundingConflict("Personal VM egress cap exhausted.");
      if (
        reservation.dispatched_at &&
        now.valueOf() -
          new Date(
            meter?.egress_complete_through ?? reservation.dispatched_at,
          ).valueOf() >
          15 * 60_000
      )
        fundingConflict("Personal VM egress observation is stale.");
    }
    const policy = await getComputeFundingPolicyInTransaction(client, {
      payer_account_id: opts.account_id,
      lane: binding.lane,
      for_service: true,
    });
    assertComputeFundingServicePolicy(policy, {
      authorized_usd: reservation.authorized_usd,
      authorized_until: binding.authorized_until,
      already_reserved: true,
    });
    if (opts.renew_until) {
      const until = new Date(
        Math.min(
          new Date(fundingDate(opts.renew_until)).valueOf(),
          new Date(consent.terms.ends_at).valueOf(),
          now.valueOf() + 20 * 60_000,
          policy.windows["5h"].window!.resets_at.valueOf(),
          policy.windows["7d"].window!.resets_at.valueOf(),
        ),
      );
      if (until > reservation.authorized_until) {
        const duration =
          until.valueOf() - reservation.authorized_until.valueOf();
        const request = reservation.pricing_snapshot.request;
        const compute = moneyRound2Up(
          toDecimal(request.hourly_cost_usd).mul(duration).div(3600_000),
        );
        const storage = moneyRound2Up(
          toDecimal(request.storage_hourly_cost_usd)
            .mul(duration)
            .div(3600_000),
        );
        const additional = moneyToDbString(compute.plus(storage));
        if (
          toDecimal(consent.spent_usd)
            .plus(consent.committed_usd)
            .plus(additional)
            .gt(consent.terms.cap_usd) ||
          toDecimal(additional).gt(policy.available_backing_usd)
        )
          fundingConflict("Personal VM renewal exceeds its cap or backing.");
        assertComputeFundingServicePolicy(policy, {
          authorized_usd: additional,
          authorized_until: until.toISOString(),
        });
        await assertFundingExposureAvailable(
          client,
          exposureBudget!,
          additional,
        );
        await client.query(
          "UPDATE account_funding_holds SET authorized_usd=authorized_usd+$2,remaining_usd=remaining_usd+$2,updated_at=clock_timestamp() WHERE id=$1",
          [hold_id, additional],
        );
        binding.authorized_usd = moneyToDbString(
          toDecimal(binding.authorized_usd).plus(additional),
        );
        binding.protected_usd = moneyToDbString(
          toDecimal(binding.protected_usd).plus(storage),
        );
        binding.authorized_until = until.toISOString();
        binding.stop_at = new Date(
          until.valueOf() - VM_FUNDING_MARGIN_MS,
        ).toISOString();
        binding.storage_delete_at = new Date(
          until.valueOf() + VM_FUNDING_STORAGE_MS,
        ).toISOString();
        await client.query(
          "UPDATE compute_funding_reservations SET authorized_usd=authorized_usd+$2,protected_usd=protected_usd+$3,authorized_until=$4,pricing_snapshot=jsonb_set(pricing_snapshot,'{binding}',$5::jsonb),updated_at=clock_timestamp() WHERE id=$1",
          [
            reservation.id,
            additional,
            moneyToDbString(storage),
            until,
            JSON.stringify(binding),
          ],
        );
        await client.query(
          "UPDATE compute_vm_personal_consents SET committed_usd=committed_usd+$2,updated_at=clock_timestamp() WHERE id=$1",
          [consent.id, additional],
        );
        await fundingEvent(client, reservation, "renewed", binding);
      }
    }
    if (opts.dispatch && !reservation.dispatched_at) {
      await client.query(
        "UPDATE compute_funding_reservations SET dispatched_at=clock_timestamp(),state='dispatched' WHERE id=$1",
        [reservation.id],
      );
      await fundingEvent(client, reservation, "dispatched", binding);
    }
    return binding;
  });
}
