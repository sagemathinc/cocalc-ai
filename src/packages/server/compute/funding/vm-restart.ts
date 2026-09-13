/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type {
  ComputeVmFundingBinding,
  ReserveComputeVmFundingRequest,
} from "@cocalc/util/compute-vm-funding";
import type { ComputeVmRow } from "../types";
import { insertComputeInstance } from "../db";
import { fundingConflict } from "./vm-reservations";
import {
  courseVmBinding,
  payerApi,
  meterCourseVm,
  requireSponsoredVmAdmission,
} from "./vm-funding";

export interface PreparedCourseRestart {
  binding: ComputeVmFundingBinding;
  operation_id: string;
  previous_epoch: string;
}

export async function prepareCourseVmRestart(
  vm: ComputeVmRow,
  operation: string,
  stopAt: Date | null,
): Promise<PreparedCourseRestart | undefined> {
  await requireSponsoredVmAdmission();
  const { rows: replay } = await getPool().query(
    "SELECT 1 FROM compute_resource_events WHERE resource_id=$1 AND action='start' AND idempotency_key=$2 AND status='requested' LIMIT 1",
    [vm.id, operation],
  );
  if (replay.length) return;
  const previous = courseVmBinding(vm);
  if (
    previous.source.kind !== "course" ||
    !vm.stopped_at ||
    vm.state !== "stopped" ||
    vm.desired_state !== "stopped"
  )
    fundingConflict("Restart requires a stopped sponsored VM.");
  if (vm.home_volume_id || vm.allow_on_demand_fallback)
    fundingConflict(
      "Restart requires separately authorized storage and pricing.",
    );
  const egress = vm.metadata.billing.egress;
  if (
    vm.provider === "gcp" &&
    (!egress?.metered_through_at ||
      new Date(egress.metered_through_at) < vm.stopped_at)
  )
    fundingConflict(
      "Restart is waiting for the stopped run's measured GCP egress.",
    );
  await meterCourseVm(vm);
  const until = new Date(
    Math.min(
      Date.now() + 25 * 60_000,
      vm.expires_at?.valueOf() ?? Infinity,
      stopAt ? stopAt.valueOf() + 5 * 60_000 : Infinity,
    ),
  );
  const rate = vm.metadata.billing.running_rates?.[vm.effective_pricing_model];
  const request: ReserveComputeVmFundingRequest = {
    account_id: previous.payer_account_id,
    source: previous.source,
    resource_id: vm.id,
    resource_generation: vm.instance_generation + 1,
    owner_account_id: vm.owner_account_id,
    owning_bay_id: vm.owning_bay_id,
    funding_epoch: randomUUID(),
    provider: vm.provider,
    hourly_cost_usd: rate?.hourly_cost_usd,
    storage_hourly_cost_usd: vm.metadata.billing.stopped_rate?.hourly_cost_usd,
    pricing_snapshot: rate?.pricing_snapshot,
    requested_until: until.toISOString(),
    previous_reservation_id: previous.reservation_id,
  };
  const candidate = { operation_id: operation, request };
  const {
    rows: [current],
  } = await getPool().query<ComputeVmRow>(
    `UPDATE compute_vms SET metadata=jsonb_set(metadata,'{billing,course_funding,restart}',COALESCE(metadata#>'{billing,course_funding,restart}',$4::jsonb)),updated_at=clock_timestamp()
    WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2 AND instance_generation=$3 AND state='stopped' AND desired_state='stopped' AND deleted_at IS NULL RETURNING *`,
    [
      vm.id,
      previous.funding_epoch,
      vm.instance_generation,
      JSON.stringify(candidate),
    ],
  );
  if (!current)
    fundingConflict("VM changed while preparing its sponsored restart.");
  const pending = current.metadata.billing.course_funding.restart;
  if (pending.operation_id !== operation)
    fundingConflict("Another sponsored restart is pending.");
  const binding = await (
    await payerApi(previous.payer_account_id)
  ).reserveComputeVmFunding(pending.request);
  if (new Date(binding.stop_at).valueOf() <= Date.now())
    fundingConflict("The prepared restart authorization expired.");
  return {
    binding,
    operation_id: operation,
    previous_epoch: previous.funding_epoch,
  };
}

/** Runs inside the scheduled-start transaction after it locks the current VM. */
export async function applyPreparedCourseRestart(
  db: PoolClient,
  vm: ComputeVmRow,
  prepared: PreparedCourseRestart,
): Promise<ComputeVmRow> {
  const current = vm.metadata.billing.course_funding;
  const pending = current.restart;
  if (
    current.funding_epoch !== prepared.previous_epoch ||
    pending?.operation_id !== prepared.operation_id ||
    pending.request.funding_epoch !== prepared.binding.funding_epoch ||
    vm.state !== "stopped" ||
    vm.desired_state !== "stopped" ||
    !vm.stopped_at ||
    vm.instance_generation + 1 !== prepared.binding.resource_generation
  )
    fundingConflict("Sponsored restart resource generation changed.");
  const cutover = new Date();
  const binding = prepared.binding;
  if (new Date(binding.stop_at) <= cutover)
    fundingConflict("Sponsored restart authority expired before dispatch.");
  const history = [
    ...(current.history ?? []),
    {
      binding: current.binding,
      running_until: vm.stopped_at.toISOString(),
      transferred_at: cutover.toISOString(),
      successor_reservation_id: binding.reservation_id,
      egress: vm.metadata.billing.egress ?? {},
    },
  ];
  const {
    rows: [updated],
  } = await db.query<ComputeVmRow>(
    `UPDATE compute_vms SET instance_generation=$2,stopped_at=NULL,accrued_cost=0,
    metadata=jsonb_set(jsonb_set(jsonb_set(metadata,'{billing,course_funding}',$3::jsonb),'{billing,egress}',$4::jsonb),'{provider_generation_provisioning}','true'::jsonb),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
    [
      vm.id,
      binding.resource_generation,
      JSON.stringify({
        source: binding.source,
        binding,
        funding_epoch: binding.funding_epoch,
        history,
      }),
      JSON.stringify({
        total_bytes: 0,
        metered_through_at: cutover.toISOString(),
        finalized: false,
      }),
    ],
  );
  await insertComputeInstance(updated, db);
  return updated;
}
