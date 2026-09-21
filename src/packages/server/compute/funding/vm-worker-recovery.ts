/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { ComputeVmRow } from "../types";
import { COMPUTE_VM_V2_SQL } from "../contract";
import { meterCourseVm, payerApi } from "./vm-funding";

const logger = getLogger("compute:funding:worker-recovery");
const BATCH_SIZE = 20;
let cursor = "00000000-0000-0000-0000-000000000000";

/** Lookup only: cancellation must not create a replacement commitment. The
 * payer-home RPC validates canonical funding; only the resource bay binds it.
 */
export async function recoverExistingCourseVmFunding(
  vm: ComputeVmRow,
): Promise<ComputeVmRow | undefined> {
  const course = vm.metadata?.billing?.course_funding;
  if (course?.binding) return vm;
  if (
    vm.owning_bay_id !== getConfiguredBayId() ||
    !course?.funding_epoch ||
    course.source?.kind !== "course"
  )
    return;
  const source = course.source;
  const payer =
    source.payer_account_id ??
    (
      await getPool().query<{ payer_account_id: string }>(
        "SELECT payer_account_id FROM compute_funding_pools WHERE id=$1",
        [source.pool_id],
      )
    ).rows[0]?.payer_account_id;
  if (!payer) return;
  const binding = await (
    await payerApi(payer)
  ).lookupComputeVmFunding({
    account_id: payer,
    source,
    resource_kind: "compute-vm",
    resource_id: vm.id,
    resource_generation: vm.instance_generation,
    owner_account_id: vm.owner_account_id,
    owning_bay_id: vm.owning_bay_id,
    funding_epoch: course.funding_epoch,
  });
  if (!binding) return;
  const {
    rows: [updated],
  } = await getPool().query<ComputeVmRow>(
    `UPDATE compute_vms SET
         funding_mode=$4,
         metadata=jsonb_set(jsonb_set(metadata,'{billing,course_funding,binding}',$3::jsonb),'{billing,funding_mode}',to_jsonb($4::text)),
         updated_at=NOW()
       WHERE id=$1 AND owning_bay_id=$5 AND instance_generation=$6
         AND owner_account_id=$7
         AND metadata#>>'{billing,course_funding,funding_epoch}'=$2
         AND metadata#>>'{billing,course_funding,source,pool_id}'=$8
         AND metadata#>>'{billing,course_funding,source,grant_id}'=$9
         AND metadata#>'{billing,course_funding,binding}' IS NULL
       RETURNING *`,
    [
      vm.id,
      course.funding_epoch,
      JSON.stringify(binding),
      binding.lane === "prepaid" ? "account-prepaid" : "account-postpaid",
      vm.owning_bay_id,
      vm.instance_generation,
      vm.owner_account_id,
      source.pool_id,
      source.grant_id,
    ],
  );
  return updated;
}

/** Retried after restart even when resource cleanup already marked deletion.
 * No missing reply, expired deadline, or absent reservation releases backing.
 */
export async function recoverTerminalCourseVmFunding(): Promise<void> {
  const { rows } = await getPool().query<ComputeVmRow>(
    `SELECT * FROM compute_vms WHERE owning_bay_id=$1 AND id>$2
       AND ${COMPUTE_VM_V2_SQL}
       AND metadata#>'{billing,course_funding}' IS NOT NULL
       AND ((deleted_at IS NOT NULL AND
         (billing_state IS DISTINCT FROM 'closed' OR metadata#>'{billing,course_funding,binding}' IS NULL
          OR metadata#>>'{billing,course_funding,committed_usd}' IS DISTINCT FROM '0.0000000000'))
         OR (desired_state IN ('stopped','deleted') AND metadata#>'{billing,course_funding,binding}' IS NULL))
     ORDER BY id LIMIT $3`,
    [getConfiguredBayId(), cursor, BATCH_SIZE],
  );
  cursor =
    rows.length === BATCH_SIZE
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const row of rows) {
    try {
      const vm = await recoverExistingCourseVmFunding(row);
      if (vm?.deleted_at) await meterCourseVm(vm, true);
    } catch (err) {
      logger.warn("terminal VM funding remains pending", {
        vm_id: row.id,
        err,
      });
    }
  }
}
