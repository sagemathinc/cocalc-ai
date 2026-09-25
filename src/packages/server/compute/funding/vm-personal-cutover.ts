/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import type { ComputeVmFundingBinding } from "@cocalc/util/compute-vm-funding";
import type { ComputeVmRow, ComputeVolumeRow } from "../types";
import { insertComputeInstance } from "../db";
import { applyPersonalVolumeBinding } from "./volume-personal";

/** The caller holds the VM row lock, including on retries of the same command. */
export async function enqueuePersonalTransition(
  db: PoolClient,
  vmId: string,
  action: "stop" | "start",
  epoch: string,
  operation: string,
): Promise<void> {
  await db.query(
    `UPDATE compute_vms SET desired_state=$2,state=CASE WHEN state='stopped' AND $2='stopped' THEN state ELSE $3 END,updated_at=clock_timestamp() WHERE id=$1 AND desired_state<>'deleted'`,
    [
      vmId,
      action === "stop" ? "stopped" : "running",
      action === "stop" ? "stopping" : "starting",
    ],
  );
  await db.query(
    `INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,attempt,not_before,created_at,updated_at)
     SELECT $1,'vm',$2,$3,$4,$5,'queued',0,NOW(),NOW(),NOW()
     WHERE NOT EXISTS (SELECT 1 FROM compute_resource_work WHERE resource_id=$2 AND idempotency_key=$4)`,
    [
      randomUUID(),
      vmId,
      action,
      `personal-${action}:${operation}`,
      { funding_epoch: epoch },
    ],
  );
}

/** Owning-bay atomic cutover, after funding authorization and stopped/egress
 * checks. VM and any switched disk share one cutover and commit transaction. */
export async function installPersonalVmFunding(
  db: PoolClient,
  vm: ComputeVmRow,
  binding: ComputeVmFundingBinding,
  operation: string,
  cutover: Date,
  home?: { volume: ComputeVolumeRow; binding: ComputeVmFundingBinding },
): Promise<void> {
  if (home)
    await applyPersonalVolumeBinding(db, home.volume, home.binding, cutover);
  const old = vm.metadata.billing.course_funding;
  const oldEgress = vm.metadata.billing.egress ?? {};
  const history = [
    ...(old.history ?? []),
    {
      binding: old.binding,
      running_until: vm.stopped_at!.toISOString(),
      transferred_at: cutover.toISOString(),
      successor_reservation_id: binding.reservation_id,
      successor_binding: binding,
      egress: oldEgress,
    },
  ];
  await db.query(
    `UPDATE compute_vms SET instance_generation=$2,stopped_at=NULL,accrued_cost=0,funding_mode=$3,
     metadata=jsonb_set(jsonb_set(jsonb_set(jsonb_set(metadata,'{billing,course_funding}',$4::jsonb),'{billing,egress}',$5::jsonb),'{billing,funding_mode}',to_jsonb($3::text)),'{provider_generation_provisioning}','true'::jsonb),updated_at=clock_timestamp()
     WHERE id=$1`,
    [
      vm.id,
      binding.resource_generation,
      binding.lane === "prepaid" ? "account-prepaid" : "account-postpaid",
      JSON.stringify({
        source: binding.source,
        funding_epoch: binding.funding_epoch,
        binding,
        history,
      }),
      JSON.stringify({
        total_bytes: 0,
        metered_through_at: cutover.toISOString(),
        finalized: false,
      }),
    ],
  );
  // GCP can restart a retained instance without provision(). Create the timing
  // row before provider work, so its new funded generation is actually metered.
  await insertComputeInstance(
    { ...vm, instance_generation: binding.resource_generation },
    db,
  );
  await enqueuePersonalTransition(
    db,
    vm.id,
    "start",
    binding.funding_epoch,
    operation,
  );
}
