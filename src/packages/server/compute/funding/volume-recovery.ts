/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { ComputeVolumeRow } from "../types";
import { getComputeVolumeById } from "../volume-db";
import { payerApi } from "./vm-funding";
import {
  hasCourseVolumeFunding,
  meterCourseVolume,
  volumeFunding,
} from "./volume-funding";
import { volumeGrowth } from "./volume-growth";

const logger = getLogger("compute:funding:volume-recovery");
let cursor = "00000000-0000-0000-0000-000000000000";

/** Lookup only; cancellation cannot create a replacement commitment. Payer
 * authority stays on its home bay, separate from resource-local binding CAS.
 */
export async function recoverCourseVolumeFunding(
  volume: ComputeVolumeRow,
): Promise<ComputeVolumeRow> {
  if (!hasCourseVolumeFunding(volume)) return volume;
  if (volume.owning_bay_id !== getConfiguredBayId())
    throw Error("Volume recovery requires its owning bay.");
  const data = volumeFunding(volume);
  const payer =
    data.binding?.payer_account_id ??
    data.source.payer_account_id ??
    (
      await getPool().query(
        "SELECT payer_account_id FROM compute_funding_pools WHERE id=$1",
        [data.source.pool_id],
      )
    ).rows[0]?.payer_account_id;
  if (!payer) return volume;
  const missing = [
    ...(!data.binding
      ? [
          {
            epoch: data.funding_epoch,
            path: ["billing", "course_funding", "binding"],
          },
        ]
      : []),
    ...volumeGrowth(volume).flatMap((s, i) =>
      s.binding
        ? []
        : [
            {
              epoch: s.request.funding_epoch,
              path: ["billing", "course_funding", "growth", `${i}`, "binding"],
            },
          ],
    ),
  ];
  for (const item of missing) {
    const binding = await (
      await payerApi(payer)
    ).lookupComputeVmFunding({
      account_id: payer,
      source: data.source,
      resource_kind: "compute-volume",
      resource_id: volume.id,
      resource_generation: 1,
      owner_account_id: volume.owner_account_id,
      owning_bay_id: volume.owning_bay_id,
      funding_epoch: item.epoch,
    });
    if (!binding) continue;
    await getPool().query(
      `UPDATE compute_volumes SET billing_state='pending',metadata=jsonb_set(metadata,$3::text[],$4::jsonb)
        WHERE id=$1 AND owning_bay_id=$5 AND owner_account_id=$6 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2
          AND metadata#>$3::text[] IS NULL`,
      [
        volume.id,
        data.funding_epoch,
        item.path,
        JSON.stringify(binding),
        getConfiguredBayId(),
        volume.owner_account_id,
      ],
    );
  }
  return (await getComputeVolumeById(volume.id))!;
}

export async function recoverTerminalCourseVolumeFunding(): Promise<void> {
  const { rows } = await getPool().query<ComputeVolumeRow>(
    `SELECT * FROM compute_volumes WHERE owning_bay_id=$1 AND id>$2
    AND metadata#>'{billing,course_funding}' IS NOT NULL AND (desired_state='deleted' OR deleted_at IS NOT NULL)
    AND (billing_state IS DISTINCT FROM 'closed'
      OR metadata#>>'{billing,course_funding,committed_usd}' IS DISTINCT FROM '0.0000000000'
      OR metadata#>'{billing,course_funding,binding}' IS NULL
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(metadata#>'{billing,course_funding,growth}','[]'::jsonb)) AS slice
        WHERE slice->'binding' IS NULL)) ORDER BY id LIMIT 20`,
    [getConfiguredBayId(), cursor],
  );
  cursor =
    rows.length === 20
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const row of rows) {
    try {
      await meterCourseVolume(await recoverCourseVolumeFunding(row));
    } catch (err) {
      logger.warn("terminal volume funding remains pending", {
        volume_id: row.id,
        err,
      });
    }
  }
}
